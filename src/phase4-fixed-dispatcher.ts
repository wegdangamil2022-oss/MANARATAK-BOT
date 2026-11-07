import {createHash,randomBytes} from 'node:crypto';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {validCommunityRulesUrl} from './phase4-community-model.js';
import {guidanceContext} from './phase4-guidance.js';
import {publicBody} from './phase4-fixed-publication.js';
import {communityLinkKeyboard} from './phase4-community-rich.js';
import {TelegramBotApiTextSender,type TelegramSendResult} from './telegram-replies.js';
import type {CommunityFixedPostStatus,CommunityFixedPinStatus} from './phase4-community-model.js';

export type FixedGatewayResult='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
export interface FixedPublicationGateway{
 canPublish(chatId:string):Promise<boolean>;
 publish(chatId:string,body:string,officialRulesUrl?:string):Promise<TelegramSendResult>;
 canPin(chatId:string):Promise<boolean>;
 pin(chatId:string,messageId:number):Promise<FixedGatewayResult>;
}
const validGroup=(s:string)=>/^-[1-9]\d{0,15}$/u.test(s)&&
 Number.isSafeInteger(Number(s));
const validMsg=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const validClock=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-600000;
const key=(v:string)=>/^[a-f0-9]{24}$/u.test(v);
const digest=(body:string)=>createHash('sha256')
 .update('MANARATAK:09:03:PUBLIC-FIXED:v1:\n').update(body,'utf8').digest('hex');

/** Real Telegram Bot API is invoked ONLY by the durable dispatcher.
 * No background retries, unsanctioned pinning or silent enablement. */
export class TelegramBotApiFixedGateway implements FixedPublicationGateway{
 private readonly botId:number;
 private readonly sender:TelegramBotApiTextSender;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))
   throw Error('FIXED_GATEWAY_TOKEN_INVALID');
  this.botId=Number(token.split(':')[0]);
  if(!Number.isSafeInteger(this.botId))throw Error('FIXED_GATEWAY_BOT_INVALID');
  this.sender=new TelegramBotApiTextSender(token,request);
 }
 private async call(method:'getChat'|'getChatMember'|'pinChatMessage',
  fields:Record<string,string|number|boolean>):Promise<
   {http:number;ok:boolean;result:unknown}|null>{
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/bot'+this.token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(fields),redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{return null;}
  let raw:unknown;
  try{
   const text=await response.text();
   if(text.length>8192)return null;
   raw=JSON.parse(text);
  }catch{return null;}
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||
    typeof (raw as Record<string,unknown>).ok!=='boolean')return null;
  const value=raw as Record<string,unknown>;
  return {http:response.status,ok:response.ok&&value.ok===true,result:value.result};
 }
 private async member(chatId:string):Promise<Record<string,unknown>|null>{
  if(!validGroup(chatId))return null;
  const group=await this.call('getChat',{chat_id:chatId});
  if(!group?.ok||!group.result||typeof group.result!=='object'||
    Array.isArray(group.result))return null;
  const details=group.result as Record<string,unknown>;
  if(details.id!==Number(chatId)||
    (details.type!=='group'&&details.type!=='supergroup'))return null;
  const response=await this.call('getChatMember',{
   chat_id:chatId,user_id:this.botId});
  if(!response?.ok||!response.result||
    typeof response.result!=='object'||Array.isArray(response.result))return null;
  const data=response.result as Record<string,unknown>;
  if(!data.user||typeof data.user!=='object'||Array.isArray(data.user)||
    (data.user as Record<string,unknown>).id!==this.botId)return null;
  return data;
 }
 async canPublish(chatId:string):Promise<boolean>{
  const member=await this.member(chatId);
  return member?.status==='creator'||member?.status==='administrator';
 }
 async publish(chatId:string,body:string,officialRulesUrl?:string):Promise<TelegramSendResult>{
  if(!validGroup(chatId)||!body||Buffer.byteLength(body,'utf8')>3400||
     officialRulesUrl!==undefined&&!validCommunityRulesUrl(officialRulesUrl))
   return {status:'FAILED_CONFIRMED'};
  return this.sender.send({chatId,parseMode:'HTML',text:body,
   ...(officialRulesUrl?{communityLinks:communityLinkKeyboard([
    {text:'📜 قوانين المجموعة',url:officialRulesUrl}])}:{})});
 }
 async canPin(chatId:string):Promise<boolean>{
  const m=await this.member(chatId);
  return m?.status==='creator'||m?.status==='administrator'&&
   m.can_pin_messages===true;
 }
 async pin(chatId:string,messageId:number):Promise<FixedGatewayResult>{
  if(!validGroup(chatId)||!validMsg(messageId))return 'FAILED_CONFIRMED';
  const reply=await this.call('pinChatMessage',{
   chat_id:chatId,message_id:messageId,disable_notification:true});
  if(!reply)return 'UNKNOWN_OUTCOME';
  if(reply.ok&&reply.result===true)return 'CONFIRMED';
  if(reply.http>=400&&reply.http<500)return 'FAILED_CONFIRMED';
  return 'UNKNOWN_OUTCOME';
 }
}
export type FixedDispatchResult=CommunityFixedPostStatus|
 CommunityFixedPinStatus|'NOT_FOUND'|'PAUSED'|'NOT_READY';
/** Independent at-most-once publication and pin claims. A pinned Telegram
 * message is never inferred from the request; only Bot API confirmation counts.
 */
export class Phase4FixedPublicationDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:FixedPublicationGateway,
  private readonly clock:()=>number=Date.now,
  private readonly safetyGate?:()=>Promise<boolean>){}
 private async safe():Promise<boolean>{
  if(!this.safetyGate)return false;
  try{return (await this.safetyGate())===true;}catch{return false;}
 }
 async publish(id:string):Promise<FixedDispatchResult>{
  if(!key(id))throw Error('FIXED_PUBLISH_KEY_INVALID');
  const state=await this.store.snapshot();
  const matches=state.phase4Community?.fixedPostJobs?.filter(j=>j.id===id)??[];
  if(matches.length!==1)return 'NOT_FOUND';
  if(matches[0]!.status!=='QUEUED')
   return matches[0]!.status==='SENDING'?'UNKNOWN_OUTCOME':matches[0]!.status;
  if(!validClock(this.clock())||!await this.safe())return 'PAUSED';
  let rights=false;
  try{rights=await this.gateway.canPublish(matches[0]!.chatId);}
  catch{/* Telegram inspection fails closed */}
  const claim=await this.store.transaction(async s=>{
   const jobs=s.phase4Community?.fixedPostJobs?.filter(x=>x.id===id)??[];
   if(jobs.length!==1)throw Error('FIXED_PUBLISH_AMBIGUOUS');
   const job=jobs[0]!;
   if(job.status!=='QUEUED')return {status:job.status==='SENDING'?
    'UNKNOWN_OUTCOME' as const:job.status};
   if(!await this.safe())return {status:'PAUSED' as const};
   const now=this.clock(),chat=s.chats.filter(x=>x.id===job.chatId&&
    x.approved&&x.present&&x.scopes.includes('navigation'));
   const data=guidanceContext(s,this.policy,job.chatId);
   const visible=publicBody(s,this.policy,job.chatId);
   const allowed=validClock(now)&&now>=job.approvedAt&&
    now-job.approvedAt<600000&&this.policy.isOwner(job.actorId)&&
    this.policy.has(s,job.actorId,'chat.manage',job.chatId)&&
    this.policy.canUseChat(s,job.chatId,'navigation')&&
    chat.length===1&&chat[0]!.version===job.chatVersion&&
    data!==null&&visible!==null&&visible.version===job.configVersion&&
    digest(visible.body)===job.contentDigest;
   if(!allowed){
    job.status='SKIPPED';
    if(job.pinRequested)job.pinStatus='SKIPPED';
    return {status:'SKIPPED' as const};
   }
   if(!rights){
    job.status='FAILED_CONFIRMED';
    if(job.pinRequested)job.pinStatus='SKIPPED';
    return {status:'FAILED_CONFIRMED' as const};
   }
   job.status='SENDING';job.attemptId=randomBytes(12).toString('hex');
   return {status:'SEND' as const,chatId:job.chatId,body:visible!.body,
    rulesUrl:validCommunityRulesUrl(data!.config.rulesUrl)?
     data!.config.rulesUrl:undefined,attemptId:job.attemptId};
  });
  if(claim.status!=='SEND')return claim.status;
  let result:TelegramSendResult={status:'UNKNOWN_OUTCOME'};
  try{result=await this.gateway.publish(claim.chatId,claim.body,claim.rulesUrl);}
  catch{/* ambiguous result is quarantined */}
  await this.store.transaction(s=>{
   const jobs=s.phase4Community?.fixedPostJobs?.filter(x=>x.id===id)??[];
   if(jobs.length!==1||jobs[0]!.status!=='SENDING'||
      jobs[0]!.attemptId!==claim.attemptId)
    throw Error('FIXED_PUBLISH_ATTEMPT_FENCED');
   const job=jobs[0]!;
   job.status=result.status;
   if(result.status==='CONFIRMED'){
    job.messageId=result.messageId;
    if(job.pinRequested)job.pinStatus='QUEUED';
   }else if(job.pinRequested)job.pinStatus='SKIPPED';
  });
  return result.status;
 }
 async pin(id:string):Promise<FixedDispatchResult>{
  if(!key(id))throw Error('FIXED_PIN_KEY_INVALID');
  const snap=await this.store.snapshot();
  const matches=snap.phase4Community?.fixedPostJobs?.filter(j=>j.id===id)??[];
  if(matches.length!==1)return 'NOT_FOUND';
  const job=matches[0]!;
  if(!job.pinRequested)return 'NOT_READY';
  if(job.pinStatus!=='QUEUED')return job.pinStatus==='SENDING'?
   'UNKNOWN_OUTCOME':job.pinStatus;
  if(!validClock(this.clock())||!await this.safe())return 'PAUSED';
  let rights=false;
  try{rights=await this.gateway.canPin(job.chatId);}
  catch{/* never infer can_pin_messages from a prior permission */}
  const claim=await this.store.transaction(async s=>{
   const rows=s.phase4Community?.fixedPostJobs?.filter(j=>j.id===id)??[];
   if(rows.length!==1)throw Error('FIXED_PIN_AMBIGUOUS');
   const current=rows[0]!;
   if(current.pinStatus!=='QUEUED')return {status:current.pinStatus==='SENDING'?
    'UNKNOWN_OUTCOME' as const:current.pinStatus};
   if(!await this.safe())return {status:'PAUSED' as const};
   const now=this.clock(),chats=s.chats.filter(c=>c.id===current.chatId&&
    c.approved&&c.present&&c.scopes.includes('navigation'));
   const visible=publicBody(s,this.policy,current.chatId);
   const valid=validClock(now)&&now>=current.approvedAt&&
    now-current.approvedAt<600000&&current.status==='CONFIRMED'&&
    current.pinRequested&&validMsg(current.messageId!)&&
    this.policy.isOwner(current.actorId)&&
    this.policy.has(s,current.actorId,'chat.manage',current.chatId)&&
    this.policy.canUseChat(s,current.chatId,'navigation')&&
    chats.length===1&&chats[0]!.version===current.chatVersion&&
    visible!==null&&visible.version===current.configVersion&&
    digest(visible.body)===current.contentDigest;
   if(!valid){
    current.pinStatus='SKIPPED';
    return {status:'SKIPPED' as const};
   }
   if(!rights){
    current.pinStatus='FAILED_CONFIRMED';
    return {status:'FAILED_CONFIRMED' as const};
   }
   current.pinStatus='SENDING';
   current.pinAttemptId=randomBytes(12).toString('hex');
   return {status:'PIN' as const,chatId:current.chatId,
    messageId:current.messageId!,attemptId:current.pinAttemptId};
  });
  if(claim.status!=='PIN')return claim.status;
  let outcome:FixedGatewayResult='UNKNOWN_OUTCOME';
  try{outcome=await this.gateway.pin(claim.chatId,claim.messageId);}
  catch{/* unknown outcome must not retry on restart */}
  await this.store.transaction(s=>{
   const matches=s.phase4Community?.fixedPostJobs?.filter(j=>j.id===id)??[];
   if(matches.length!==1||matches[0]!.pinStatus!=='SENDING'||
      matches[0]!.pinAttemptId!==claim.attemptId)
    throw Error('FIXED_PIN_ATTEMPT_FENCED');
   matches[0]!.pinStatus=outcome;
  });
  return outcome;
 }
 async runDue(limit=2):Promise<{posts:FixedDispatchResult[];pins:FixedDispatchResult[]}>{
  if(!Number.isInteger(limit)||limit<1||limit>10)
   throw Error('FIXED_DISPATCH_LIMIT_INVALID');
  const state=await this.store.snapshot(),now=this.clock();
  if(!validClock(now))return {posts:[],pins:[]};
  const queued=(state.phase4Community?.fixedPostJobs??[])
   .filter(j=>j.status==='QUEUED').sort((a,b)=>
    a.approvedAt-b.approvedAt||a.id.localeCompare(b.id)).slice(0,limit);
  const posts:FixedDispatchResult[]=[];
  for(const job of queued)posts.push(await this.publish(job.id));
  const fresh=await this.store.snapshot();
  const toPin=(fresh.phase4Community?.fixedPostJobs??[])
   .filter(j=>j.status==='CONFIRMED'&&j.pinStatus==='QUEUED')
   .sort((a,b)=>a.approvedAt-b.approvedAt||a.id.localeCompare(b.id)).slice(0,limit);
  const pins:FixedDispatchResult[]=[];
  for(const job of toPin)pins.push(await this.pin(job.id));
  return {posts,pins};
 }
}
