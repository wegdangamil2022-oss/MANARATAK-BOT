import {createHash,randomBytes} from 'node:crypto';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {guidanceContext,renderGuidanceWelcome} from './phase4-guidance.js';
import {TelegramBotApiTextSender,type TelegramSendResult} from './telegram-replies.js';
import type {CommunityGuidePostStatus} from './phase4-community-model.js';

const guideId=(key:string)=>/^[a-f0-9]{24}$/u.test(key);
const validGroup=(chatId:string)=>/^-[1-9]\d{0,15}$/u.test(chatId)&&
 Number.isSafeInteger(Number(chatId));
const digest=(body:string)=>createHash('sha256').update(body,'utf8').digest('hex');
const validClock=(now:number)=>Number.isSafeInteger(now)&&now>=0&&
 now<=8_640_000_000_000_000-120000;
export interface GuidePostTelegramGateway{
 canPublish(chatId:string):Promise<boolean>;
 publish(chatId:string,text:string):Promise<TelegramSendResult>;
}
/** Read-only Telegram admin permissions plus one standard HTML sendMessage.
 * Unlike a channel publisher, this method only accepts group/supergroup IDs.
 * No retries, redirects, imported URLs or arbitrary endpoint destinations.
 */
export class TelegramBotApiGuidePostGateway implements GuidePostTelegramGateway{
 private readonly botId:number;
 private readonly sender:TelegramBotApiTextSender;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))
   throw Error('GUIDE_TELEGRAM_TOKEN_INVALID');
  this.botId=Number(token.split(':')[0]);
  if(!Number.isSafeInteger(this.botId))throw Error('GUIDE_TELEGRAM_BOT_INVALID');
  this.sender=new TelegramBotApiTextSender(token,request);
 }
 private async read(method:'getChat'|'getChatMember',body:Record<string,string|number>):
  Promise<Record<string,unknown>|null>{
  let result:Response;
  try{
   result=await this.request('https://api.telegram.org/bot'+this.token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{return null;}
  let parsed:unknown;
  try{
   const raw=await result.text();
   if(raw.length>8192)return null;
   parsed=JSON.parse(raw);
  }catch{return null;}
  if(!result.ok||!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
    (parsed as Record<string,unknown>).ok!==true)return null;
  const chat=(parsed as Record<string,unknown>).result;
  if(!chat||typeof chat!=='object'||Array.isArray(chat))return null;
  return chat as Record<string,unknown>;
 }
 async canPublish(chatId:string):Promise<boolean>{
  if(!validGroup(chatId))return false;
  const group=await this.read('getChat',{chat_id:chatId});
  if(!group||group.id!==Number(chatId)||
    (group.type!=='group'&&group.type!=='supergroup'))return false;
  const member=await this.read('getChatMember',{chat_id:chatId,user_id:this.botId});
  if(!member||!member.user||typeof member.user!=='object'||
    Array.isArray(member.user)||(member.user as Record<string,unknown>).id!==this.botId)
   return false;
  return member.status==='creator'||member.status==='administrator';
 }
 async publish(chatId:string,text:string):Promise<TelegramSendResult>{
  if(!validGroup(chatId)||!text||Buffer.byteLength(text,'utf8')>3400)
   return {status:'FAILED_CONFIRMED'};
  return this.sender.send({chatId,parseMode:'HTML',text});
 }
}
export type GuidePostDispatchResult=CommunityGuidePostStatus|'NOT_FOUND'|'PAUSED';
/** Durable at-most-once guide publisher. The reviewed text is recomputed from
 * currently approved sources inside the atomic claim and discarded from state
 * BEFORE any provider send. A crashed SENDING is never enqueued again.
 */
export class Phase4GuidePublicationDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:GuidePostTelegramGateway,
  private readonly clock:()=>number=Date.now,
  private readonly safetyGate?:()=>Promise<boolean>){}
 private async safe():Promise<boolean>{
  if(!this.safetyGate)return false;
  try{return await this.safetyGate()===true;}catch{return false;}
 }
 async dispatch(id:string):Promise<GuidePostDispatchResult>{
  if(!guideId(id))throw Error('GUIDE_POST_JOB_INVALID');
  const snap=await this.store.snapshot();
  const rows=snap.phase4Community?.guidePostJobs?.filter(j=>j.id===id)??[];
  if(rows.length!==1)return 'NOT_FOUND';
  const job=rows[0]!;
  if(job.status!=='QUEUED')return job.status==='SENDING'?'UNKNOWN_OUTCOME':job.status;
  if(!validClock(this.clock())||!await this.safe())return 'PAUSED';
  let rights=false;
  try{rights=await this.gateway.canPublish(job.chatId);}catch{/* deny on failed lookup */}
  const claim=await this.store.transaction(async s=>{
   const matches=s.phase4Community?.guidePostJobs?.filter(j=>j.id===id)??[];
   if(matches.length!==1)throw Error('GUIDE_POST_AMBIGUOUS');
   const current=matches[0]!;
   if(current.status!=='QUEUED')
    return {status:current.status==='SENDING'?'UNKNOWN_OUTCOME' as const:current.status};
   if(!await this.safe())return {status:'PAUSED' as const};
   const now=this.clock(),chat=s.chats.filter(c=>c.id===current.chatId&&
     c.approved&&c.present&&c.scopes.includes('navigation'));
   const configs=s.phase4Community?.configs.filter(c=>c.chatId===current.chatId)??[];
   const configVersion=configs.length===0?0:configs.length===1?configs[0]!.version:-1;
   const data=guidanceContext(s,this.policy,current.chatId);
   const body=data?renderGuidanceWelcome(data):'';
   const authorized=validClock(now)&&now>=current.approvedAt&&
     now-current.approvedAt<600000&&
     this.policy.isOwner(current.actorId)&&
     this.policy.has(s,current.actorId,'chat.manage',current.chatId)&&
     this.policy.canUseChat(s,current.chatId,'navigation')&&
     chat.length===1&&chat[0]!.version===current.chatVersion&&
     data!==null&&data.config.version===current.configVersion&&
     configVersion===current.configVersion&&
     body.length>0&&Buffer.byteLength(body,'utf8')<=3400&&
     digest(body)===current.contentDigest;
   if(!authorized){
    current.status='SKIPPED';
    return {status:'SKIPPED' as const};
   }
   if(!rights){
    current.status='FAILED_CONFIRMED';
    return {status:'FAILED_CONFIRMED' as const};
   }
   // SENDING and a unique attempt are durable BEFORE contacting Telegram.
   current.status='SENDING';current.attemptId=randomBytes(12).toString('hex');
   return {status:'SEND' as const,chatId:current.chatId,text:body,
    attemptId:current.attemptId};
  });
  if(claim.status!=='SEND')return claim.status;
  let result:TelegramSendResult={status:'UNKNOWN_OUTCOME'};
  try{result=await this.gateway.publish(claim.chatId,claim.text);}
  catch{/* ambiguous outcome remains quarantined */}
  await this.store.transaction(s=>{
   const rows=s.phase4Community?.guidePostJobs?.filter(j=>j.id===id)??[];
   if(rows.length!==1||rows[0]!.status!=='SENDING'||
     rows[0]!.attemptId!==claim.attemptId)
    throw Error('GUIDE_POST_ATTEMPT_FENCED');
   rows[0]!.status=result.status;
   if(result.status==='CONFIRMED')rows[0]!.messageId=result.messageId;
  });
  return result.status;
 }
 async runDue(limit=2):Promise<GuidePostDispatchResult[]>{
  if(!Number.isInteger(limit)||limit<1||limit>10)
   throw Error('GUIDE_POST_LIMIT_INVALID');
  const s=await this.store.snapshot(),now=this.clock();
  if(!validClock(now))return [];
  const jobs=(s.phase4Community?.guidePostJobs??[])
   .filter(j=>j.status==='QUEUED').sort((a,b)=>
    a.approvedAt-b.approvedAt||a.id.localeCompare(b.id)).slice(0,limit);
  const out:GuidePostDispatchResult[]=[];
  for(const job of jobs)out.push(await this.dispatch(job.id));
  return out;
 }
}