import {randomBytes} from 'node:crypto';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import type {CommunityCleanupJob,CommunityCleanupStatus} from './phase4-community-model.js';

export type CommunityDeleteResult='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
export interface Phase4ServiceDeletionGateway{
 canDelete(chatId:string):Promise<boolean>;
 deleteMessage(chatId:string,messageId:number):Promise<CommunityDeleteResult>;
}
export type CommunityCleanupDispatchResult=CommunityCleanupStatus|'NOT_FOUND'|'NOT_DUE'|'PAUSED';
const keyValid=(s:string)=>/^[a-f0-9]{64}$/u.test(s);
const groupValid=(s:string)=>/^-[1-9]\d{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));

/** The Bot API is allowed to delete ONLY messages previously accepted as Telegram
 * service events. Bot admin rights are checked by a fresh server-to-server
 * getChatMember call, never inferred from an owner menu toggle.
 */
export class TelegramBotApiServiceCleanupGateway implements Phase4ServiceDeletionGateway{
 private readonly botId:number;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))
   throw Error('COMMUNITY_TELEGRAM_TOKEN_INVALID');
  this.botId=Number(token.split(':',1)[0]);
  if(!Number.isSafeInteger(this.botId))throw Error('COMMUNITY_TELEGRAM_BOT_INVALID');
 }
 private async call(method:'getChat'|'getChatMember'|'deleteMessage',body:Record<string,string|number>):
  Promise<{status:number;ok:boolean;result:unknown}|null>{
  let result:Response;
  try{
   result=await this.request('https://api.telegram.org/bot'+this.token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{return null;}
  let value:unknown;
  try{
   const raw=await result.text();
   if(raw.length>8192)return null;
   value=JSON.parse(raw);
  }catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const response=value as Record<string,unknown>;
  if(typeof response.ok!=='boolean')return null;
  return {status:result.status,ok:result.ok&&response.ok===true,result:response.result};
 }
 async canDelete(chatId:string):Promise<boolean>{
  if(!groupValid(chatId))return false;
  // A numeric negative id alone cannot prove the remote chat is still a group.
  const chat=await this.call('getChat',{chat_id:chatId});
  if(!chat?.ok||!chat.result||typeof chat.result!=='object'||
     Array.isArray(chat.result))return false;
  const details=chat.result as Record<string,unknown>;
  if(details.id!==Number(chatId)||!['group','supergroup'].includes(String(details.type)))
   return false;
  const data=await this.call('getChatMember',{chat_id:chatId,user_id:this.botId});
  if(!data?.ok||!data.result||typeof data.result!=='object'||Array.isArray(data.result))
   return false;
  const member=data.result as Record<string,unknown>,user=member.user;
  if(!user||typeof user!=='object'||Array.isArray(user)||
     (user as Record<string,unknown>).id!==this.botId)return false;
  return member.status==='creator'||member.status==='administrator'&&member.can_delete_messages===true;
 }
 async deleteMessage(chatId:string,messageId:number):Promise<CommunityDeleteResult>{
  if(!groupValid(chatId)||!Number.isSafeInteger(messageId)||messageId<1||messageId>2147483647)
   return 'FAILED_CONFIRMED';
  const result=await this.call('deleteMessage',{chat_id:chatId,message_id:messageId});
  if(!result)return 'UNKNOWN_OUTCOME';
  if(result.ok&&result.result===true)return 'CONFIRMED';
  // Permanent provider denials are terminal. Ambiguous 5xx/network responses
  // must NEVER automatically retry; an earlier deletion might have succeeded.
  if(result.status>=400&&result.status<500)return 'FAILED_CONFIRMED';
  return 'UNKNOWN_OUTCOME';
 }
}
/** Durable at-most-once service-message deletion with dispatch-time policy and
 * bot-rights checks. A crashed SENDING attempt is NEVER treated as queued.
 */
export class Phase4ServiceCleanupDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:Phase4ServiceDeletionGateway,
  private readonly clock:()=>number=Date.now,
  private readonly safetyGate?:()=>Promise<boolean>){}
 private async allowedBySafety():Promise<boolean>{
  if(!this.safetyGate)return false; // irreversible Telegram deletions require an explicit RUN gate
  try{return (await this.safetyGate())===true;}catch{return false;}
 }
 async dispatch(key:string):Promise<CommunityCleanupDispatchResult>{
  if(!keyValid(key))throw Error('COMMUNITY_CLEANUP_KEY_INVALID');
  const snap=await this.store.snapshot();
  const matches=snap.phase4Community?.cleanupJobs?.filter(x=>x.key===key)??[];
  if(matches.length!==1)return 'NOT_FOUND';
  const job=matches[0]!;
  if(job.status!=='QUEUED')return job.status==='SENDING'?'UNKNOWN_OUTCOME':job.status;
  const now=this.clock();
  if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)return 'PAUSED';
  if(now<job.observedAt)return 'PAUSED';
  // Expired service messages are *never* worth a remote getChatMember call.
  // Record a local skip, without attempting to delete anything.
  if(now-job.observedAt>2*3600000){
   return this.store.transaction(state=>{
    const found=state.phase4Community?.cleanupJobs?.filter(j=>j.key===key)??[];
    if(found.length!==1)throw Error('COMMUNITY_CLEANUP_AMBIGUOUS_KEY');
    if(found[0]!.status==='QUEUED'){
     const current=this.clock();
     if(current>=found[0]!.observedAt&&current-found[0]!.observedAt>2*3600000)
      found[0]!.status='SKIPPED';
    }
    return found[0]!.status==='SENDING'?'UNKNOWN_OUTCOME':found[0]!.status;
   });
  }
  if(now<job.dueAt)return 'NOT_DUE';
  if(!await this.allowedBySafety())return 'PAUSED';
  let canDelete=false;
  try{canDelete=await this.gateway.canDelete(job.chatId);}catch{/* never treat rights lookup failures as approval */}
  const claim=await this.store.transaction(async state=>{
   const found=state.phase4Community?.cleanupJobs?.filter(x=>x.key===key)??[];
   if(found.length!==1)throw Error('COMMUNITY_CLEANUP_AMBIGUOUS_KEY');
   const current=found[0]!;
   if(current.status!=='QUEUED')
    return {status:current.status==='SENDING'?'UNKNOWN_OUTCOME' as const:current.status};
   const liveNow=this.clock();
   if(!Number.isSafeInteger(liveNow)||liveNow<current.dueAt||
     !await this.allowedBySafety())return {status:'PAUSED' as const};
   const config=state.phase4Community?.configs.find(x=>x.chatId===current.chatId);
   const chat=state.chats.filter(x=>x.id===current.chatId);
   // Never delete old service messages, messages from a revoked group,
   // or messages under a policy that changed after the event was admitted.
   const cleanupEnabled=current.kind==='AUTOMATIC_REPLY'?
     config?.replyCleanup?.enabled:
     config?.serviceCleanup?.enabled===true&&
     (current.kind==='JOIN'?config.serviceCleanup.joinEnabled!==false:
      current.kind==='LEAVE'?config.serviceCleanup.leaveEnabled!==false:
      config.serviceCleanup.profileEnabled!==false);
   if(liveNow<current.observedAt||liveNow-current.observedAt>2*3600000||
     cleanupEnabled!==true||!config||config.version!==current.policyVersion||
     chat.length!==1||!chat[0]!.approved||!chat[0]!.present||
     !chat[0]!.scopes.includes('navigation')||
     chat[0]!.version!==current.chatVersion||
     !this.policy.canUseChat(state,current.chatId,'navigation')){
    current.status='SKIPPED';
    return {status:'SKIPPED' as const};
   }
   if(!canDelete){
    current.status='FAILED_CONFIRMED';
    return {status:'FAILED_CONFIRMED' as const};
   }
   current.attemptId=randomBytes(12).toString('hex');
   current.status='SENDING';
   return {status:'SEND' as const,chatId:current.chatId,messageId:current.messageId,
    attemptId:current.attemptId};
  });
  if(claim.status!=='SEND')return claim.status;
  let result:CommunityDeleteResult='UNKNOWN_OUTCOME';
  try{result=await this.gateway.deleteMessage(claim.chatId,claim.messageId);}
  catch{/* ambiguous remote outcome remains quarantined */}
  await this.store.transaction(state=>{
   const jobs=state.phase4Community?.cleanupJobs?.filter(x=>x.key===key)??[];
   if(jobs.length!==1||jobs[0]!.status!=='SENDING'||jobs[0]!.attemptId!==claim.attemptId)
    throw Error('COMMUNITY_CLEANUP_ATTEMPT_FENCED');
   jobs[0]!.status=result;
  });
  return result;
 }
 async runDue(limit=8):Promise<{attempted:number;results:CommunityCleanupDispatchResult[]}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('COMMUNITY_CLEANUP_LIMIT_INVALID');
  const initial=await this.store.snapshot(),now=this.clock();
  if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)
   return {attempted:0,results:[]};
  // Expired queued deletions cannot be executed by dispatch() (two-hour
  // safety window). Mark them SKIPPED even while the safety gate is STOP,
  // so old work never blocks capacity or appears permanently pending.
  // A bounded pass keeps this privacy maintenance cheap for SQLite.
  const expired=(initial.phase4Community?.cleanupJobs??[])
   .filter(j=>j.status==='QUEUED'&&j.observedAt<=now&&
     now-j.observedAt>2*3600000).slice(0,40).map(j=>j.key);
  const oldFinal=(initial.phase4Community?.cleanupJobs??[])
   .filter(j=>j.status!=='QUEUED'&&
     j.observedAt<=now&&now-j.observedAt>=7*86400000)
   .slice(0,40).map(j=>j.key);
  if(expired.length||oldFinal.length){
   await this.store.transaction(state=>{
    const current=this.clock();
    if(!Number.isSafeInteger(current)||current<now)return;
    const jobs=state.phase4Community?.cleanupJobs;
    if(!jobs)return;
    const expire=new Set(expired),prune=new Set(oldFinal);
    for(const job of jobs)if(expire.has(job.key)&&job.status==='QUEUED'&&
      job.observedAt<=current&&current-job.observedAt>2*3600000)
     job.status='SKIPPED';
    state.phase4Community!.cleanupJobs=jobs.filter(j=>
      !prune.has(j.key)||j.status==='QUEUED'||
      j.observedAt>current||current-j.observedAt<7*86400000);
   });
  }
  const snap=expired.length||oldFinal.length?await this.store.snapshot():initial;
  // Prevent one noisy group from starving other approved groups. Old work is
  // inspected by dispatch() but never blindly retried after a remote ambiguity.
  const due=(snap.phase4Community?.cleanupJobs??[])
   .filter(j=>j.status==='QUEUED'&&j.dueAt<=now)
   .sort((a,b)=>a.dueAt-b.dueAt||a.key.localeCompare(b.key));
  const chosen:typeof due=[];
  const seen=new Set<string>();
  for(const job of due){
   if(seen.has(job.chatId))continue;
   seen.add(job.chatId);chosen.push(job);
   if(chosen.length>=limit)break;
  }
  if(chosen.length<limit){
   const selected=new Set(chosen.map(j=>j.key));
   for(const job of due){
    if(selected.has(job.key))continue;
    chosen.push(job);
    if(chosen.length>=limit)break;
   }
  }
  const results:CommunityCleanupDispatchResult[]=[];
  for(const job of chosen)results.push(await this.dispatch(job.key));
  return {attempted:results.length,results};
 }
}
