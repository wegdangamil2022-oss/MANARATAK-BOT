import {randomBytes} from 'node:crypto';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import type {WhisperAnnouncement} from './phase4-whisper-model.js';

export type WhisperPostResult=WhisperAnnouncement['status']|'NOT_FOUND'|'PAUSED';
const idOk=(s:string)=>/^[a-f0-9]{24}$/u.test(s);
const groupOk=(s:string)=>/^-[1-9]\d{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const clockOk=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<8_640_000_000_000_000-600000;
const label=(kind:string,seats:number,expiresAt:number):string=>
 '<b>💌 همسة خاصة في مجموعة منارتك</b>\n'+
 (kind==='DIRECT'?'📩 لمستلم محدد':'🎟️ أول '+seats+' أعضاء مؤهلين')+
 '\n🕘 تنتهي: '+new Date(expiresAt).toISOString().slice(0,16).replace('T',' ')+' UTC'+
 '\n🔒 النص لا يظهر في المجموعة؛ يلزم فتح الخاص والتحقق من العضوية والموافقة.'+
 '\nلا تعدّ المقاعد دليلًا على قراءة أو تسليم، ولا يضمن النظام منع لقطات الشاشة.';

export interface WhisperAnnouncementGateway{
 canPost(chatId:string):Promise<boolean>;
 post(chatId:string,body:string,whisperId:string):Promise<
  {status:'CONFIRMED';messageId:number}|{status:'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'}>;
}
/** Explicit Telegram gateway: HTTPS Bot API, group type/identity check and
 * safe URL-button deep-link. The link is NOT a bearer capability or grant.
 * This gateway never receives the private whisper text.
 */
export class TelegramBotApiWhisperAnnouncementGateway implements WhisperAnnouncementGateway{
 private readonly botId:number;
 constructor(private readonly token:string,private readonly username:string,
  private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token)||
     !/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(username))
   throw Error('WHISPER_GATEWAY_INVALID');
  this.botId=Number(token.split(':')[0]);
  if(!Number.isSafeInteger(this.botId))throw Error('WHISPER_BOT_ID_INVALID');
 }
 private async call(method:'getChat'|'getChatMember'|'sendMessage',
  data:Record<string,unknown>):Promise<{ok:boolean;http:number;data:unknown}|null>{
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/bot'+this.token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(8000)});
  }catch{return null;}
  let parsed:unknown;
  try{
   const raw=await response.text();
   if(raw.length>8192)return null;
   parsed=JSON.parse(raw);
  }catch{return null;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
     typeof (parsed as Record<string,unknown>).ok!=='boolean')return null;
  return {ok:response.ok&&(parsed as Record<string,unknown>).ok===true,
   http:response.status,data:(parsed as Record<string,unknown>).result};
 }
 async canPost(chatId:string):Promise<boolean>{
  if(!groupOk(chatId))return false;
  const group=await this.call('getChat',{chat_id:chatId});
  if(!group?.ok||!group.data||typeof group.data!=='object'||
     Array.isArray(group.data))return false;
  const details=group.data as Record<string,unknown>;
  if(details.id!==Number(chatId)||!['group','supergroup'].includes(String(details.type)))
   return false;
  const member=await this.call('getChatMember',{chat_id:chatId,user_id:this.botId});
  if(!member?.ok||!member.data||typeof member.data!=='object'||
     Array.isArray(member.data))return false;
  const data=member.data as Record<string,unknown>,user=data.user;
  return !!user&&typeof user==='object'&&!Array.isArray(user)&&
   (user as Record<string,unknown>).id===this.botId&&
   (data.status==='creator'||data.status==='administrator');
 }
 async post(chatId:string,body:string,whisperId:string):Promise<
  {status:'CONFIRMED';messageId:number}|{status:'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'}>{
  if(!groupOk(chatId)||!idOk(whisperId)||!body||
     Buffer.byteLength(body,'utf8')>1200)return {status:'FAILED_CONFIRMED'};
  const url='https://t.me/'+this.username+'?start=wh_'+whisperId;
  const response=await this.call('sendMessage',{
   chat_id:chatId,text:body,parse_mode:'HTML',protect_content:true,
   link_preview_options:{is_disabled:true},
   reply_markup:{inline_keyboard:[[{text:'💌 افتح الهمسة في الخاص',url}]]}
  });
  if(!response)return {status:'UNKNOWN_OUTCOME'};
  const result=response.data;
  if(response.ok&&result&&typeof result==='object'&&!Array.isArray(result)){
   const messageId=(result as Record<string,unknown>).message_id,
    chat=(result as Record<string,unknown>).chat;
   if(Number.isSafeInteger(messageId)&&typeof messageId==='number'&&
      messageId>0&&messageId<=2147483647&&chat&&typeof chat==='object'&&
      !Array.isArray(chat)&&(chat as Record<string,unknown>).id===Number(chatId))
    return {status:'CONFIRMED',messageId};
  }
  if(response.http>=400&&response.http<500)return {status:'FAILED_CONFIRMED'};
  return {status:'UNKNOWN_OUTCOME'};
 }
}
/** No payload leakage: QUEUED stores only metadata; a fresh public teaser is
 * generated from immutable type/time fields at the one-shot claim. Every
 * indeterminate provider outcome remains un-retryable until human review.
 */
export class Phase4WhisperAnnouncementDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:WhisperAnnouncementGateway,
  private readonly clock:()=>number=Date.now,
  private readonly safetyGate?:()=>Promise<boolean>){}
 private async safe():Promise<boolean>{
  if(!this.safetyGate)return false;
  try{return (await this.safetyGate())===true;}catch{return false;}
 }
 async dispatch(id:string):Promise<WhisperPostResult>{
  if(!idOk(id))throw Error('WHISPER_ANNOUNCEMENT_ID_INVALID');
  const snap=await this.store.snapshot();
  const rows=snap.phase4Whispers?.announcements?.filter(a=>a.id===id)??[];
  if(rows.length!==1)return 'NOT_FOUND';
  if(rows[0]!.status!=='QUEUED')
   return rows[0]!.status==='SENDING'?'UNKNOWN_OUTCOME':rows[0]!.status;
  if(!clockOk(this.clock())||!await this.safe())return 'PAUSED';
  let rights=false;
  try{rights=await this.gateway.canPost(rows[0]!.chatId);}catch{/* fail closed */}
  const claim=await this.store.transaction(async s=>{
   const matches=s.phase4Whispers?.announcements?.filter(a=>a.id===id)??[];
   if(matches.length!==1)throw Error('WHISPER_ANNOUNCEMENT_AMBIGUOUS');
   const item=matches[0]!;
   if(item.status!=='QUEUED')return {status:item.status==='SENDING'?
    'UNKNOWN_OUTCOME' as const:item.status};
   if(!await this.safe())return {status:'PAUSED' as const};
   const now=this.clock(),messages=s.phase4Whispers?.messages.filter(m=>m.id===item.messageId)??[],
    m=messages[0],chat=s.chats.filter(c=>c.id===item.chatId&&
     c.approved&&c.present&&c.scopes.includes('navigation'));
   const authorized=clockOk(now)&&now>=item.createdAt&&
    now-item.createdAt<=180000&&m&&messages.length===1&&
    m.status==='OPEN'&&m.text!==undefined&&m.approvedAt!==undefined&&
    now<m.expiresAt&&m.creatorId===item.ownerId&&
    m.chatId===item.chatId&&m.chatVersion===item.chatVersion&&
    this.policy.isOwner(item.ownerId)&&
    this.policy.has(s,item.ownerId,'chat.manage',item.chatId,now)&&
    this.policy.privateFeature(s,'owner.dashboard',item.ownerId)&&
    this.policy.canUseChat(s,item.chatId,'navigation')&&
    chat.length===1&&chat[0]!.version===item.chatVersion;
   if(!authorized){item.status='SKIPPED';return {status:'SKIPPED' as const};}
   if(!rights){item.status='FAILED_CONFIRMED';return {status:'FAILED_CONFIRMED' as const};}
   item.status='SENDING';item.attemptId=randomBytes(12).toString('hex');
   return {status:'SEND' as const,chatId:item.chatId,messageId:item.messageId,
    body:label(m!.kind,m!.seats,m!.expiresAt),attemptId:item.attemptId};
  });
  if(claim.status!=='SEND')return claim.status;
  let response:Awaited<ReturnType<WhisperAnnouncementGateway['post']>>=
   {status:'UNKNOWN_OUTCOME'};
  try{response=await this.gateway.post(claim.chatId,claim.body,claim.messageId);}
  catch{/* do not retry a potentially accepted Telegram post */}
  await this.store.transaction(s=>{
   const records=s.phase4Whispers?.announcements?.filter(x=>x.id===id)??[];
   if(records.length!==1||records[0]!.status!=='SENDING'||
      records[0]!.attemptId!==claim.attemptId)
    throw Error('WHISPER_POST_OUTCOME_AMBIGUOUS');
   const row=records[0]!;
   row.status=response.status;
   if(response.status==='CONFIRMED')row.telegramMessageId=response.messageId;
  });
  return response.status;
 }
 async runDue(limit=2):Promise<WhisperPostResult[]>{
  if(!Number.isInteger(limit)||limit<1||limit>5)
   throw Error('WHISPER_POST_LIMIT_INVALID');
  const s=await this.store.snapshot(),now=this.clock();
  if(!clockOk(now))return [];
  const jobs=(s.phase4Whispers?.announcements??[])
   .filter(a=>a.status==='QUEUED')
   .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))
   .slice(0,limit);
  const out:WhisperPostResult[]=[];
  for(const a of jobs)out.push(await this.dispatch(a.id));
  return out;
 }
}
