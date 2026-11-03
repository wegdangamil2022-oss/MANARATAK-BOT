import type {BotState,BotStore} from './store.js';
import {Policy} from './policy.js';
import type {TelegramReplyPlan} from './telegram-transport.js';
import type {TelegramReplySender,TelegramSendResult} from './telegram-replies.js';
import {decideGreeting,validateGreetingSettings,type GreetingSettings,
 type InteractionEvent,type InteractionReceipt,type InteractionDecisionCode} from './phase4-welcome-engine.js';

/** Additive, explicitly disabled-by-default phase-four state. JSON and SQLite both
 * use BotStore's existing transactional state row and no new database.
 */
interface GreetingJob {
 id:string;chatId:string;actorId:string;updateKey:string;settingsRevision:number;
 queuedAt:number;status:'QUEUED'|'SENDING'|'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED';
 html:string;topicId?:number;messageId?:number;
}
type GreetingState=BotState & {phase4GreetingSettings?:GreetingSettings[];
 phase4GreetingReceipts?:InteractionReceipt[];phase4GreetingJobs?:GreetingJob[]};
const allowedStatuses=new Set(['QUEUED','SENDING','SENT','FAILED_CONFIRMED','UNKNOWN_OUTCOME','CANCELLED']);
const MAX_JOBS=2500,MAX_RECEIPTS=5000,MAX_SETTINGS=500;
const keyPattern=/^p4:[A-Za-z0-9_-]{1,90}$/u;
const idPattern=/^-[1-9]\d{0,15}$/u;
function checked(s:GreetingState):void{
 const configs=s.phase4GreetingSettings??[],receipts=s.phase4GreetingReceipts??[],jobs=s.phase4GreetingJobs??[];
 if(!Array.isArray(configs)||configs.length>MAX_SETTINGS||
  !configs.every(validateGreetingSettings)||
  new Set(configs.map(c=>c.chatId)).size!==configs.length||
  !Array.isArray(receipts)||receipts.length>MAX_RECEIPTS||
  !Array.isArray(jobs)||jobs.length>MAX_JOBS||
  new Set(jobs.map(j=>j.id)).size!==jobs.length||
  new Set(receipts.map(r=>r.updateKey)).size!==receipts.length)throw Error('PHASE4_CORRUPT_STATE');
 for(const r of receipts){
  if(!r||typeof r!=='object'||!keyPattern.test(r.updateKey)||!idPattern.test(r.chatId)||
   !Number.isSafeInteger(r.at)||r.at<0||!['SENT_PLANNED','SUPPRESSED'].includes(r.result)||
   !['READY','DISABLED','UNAPPROVED','UNTRUSTED','BOT_EVENT','UNSUPPORTED','REPLAY','QUIET',
    'LECTURE','RATE_LIMIT','NO_MATCH','ONBOARDING_REQUIRED','INVALID_CONFIG'].includes(r.reason))
   throw Error('PHASE4_CORRUPT_STATE');
 }
 for(const j of jobs){
  if(!j||typeof j!=='object'||!keyPattern.test(j.id)||!keyPattern.test(j.updateKey)||
   !idPattern.test(j.chatId)||!allowedStatuses.has(j.status)||!Number.isSafeInteger(j.queuedAt)||
   j.queuedAt<0||typeof j.html!=='string'||Buffer.byteLength(j.html,'utf8')>4096||
   j.html.length===0||!Number.isSafeInteger(j.settingsRevision)||j.settingsRevision<1||
   (j.topicId!==undefined&&(!Number.isSafeInteger(j.topicId)||j.topicId<1))||
   (j.messageId!==undefined&&(!Number.isSafeInteger(j.messageId)||j.messageId<1)))
   throw Error('PHASE4_CORRUPT_STATE');
 }
}
function active(s:GreetingState,policy:Policy,chatId:string):boolean{
 return policy.canUseChat(s,chatId,'navigation');
}
export interface GreetingQueueResult {
 readonly status:'QUEUED'|InteractionDecisionCode|'UNCONFIGURED'|'QUEUE_FULL'|'INVALID_UPDATE';
 readonly jobId?:string;readonly templateHtml?:string;
}
export interface GreetingDeliveryResult {
 readonly status:'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED'|'NOT_FOUND'|'PAUSED'|'NOT_READY';
 readonly messageId?:number;
}
export class Phase4GreetingService {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly options:{readonly clock?:()=>number;readonly allowSending?:()=>boolean}={}){}
 private now(){return this.options.clock?.()??Date.now();}
 /** No write, no Telegram side effect. Confirms owner and CURRENT approved group. */
 async preview(actorId:string,proposed:GreetingSettings):Promise<GreetingSettings>{
  if(!this.policy.isOwner(actorId))throw Error('OWNER_ONLY');
  if(!validateGreetingSettings(proposed))throw Error('INVALID_GREETING_SETTINGS');
  const s=await this.store.snapshot() as GreetingState;
  checked(s);
  if(!active(s,this.policy,proposed.chatId))throw Error('GROUP_NOT_APPROVED');
  const old=s.phase4GreetingSettings?.find(x=>x.chatId===proposed.chatId);
  if(proposed.revision!==(old?.revision??0)+1)throw Error('STALE_GREETING_REVISION');
  return structuredClone(proposed);
 }
 /** Revision-bound, owner-only local confirmation; no sending is enabled by saving a policy. */
 async confirm(actorId:string,proposed:GreetingSettings):Promise<void>{
  if(!this.policy.isOwner(actorId))throw Error('OWNER_ONLY');
  if(!validateGreetingSettings(proposed))throw Error('INVALID_GREETING_SETTINGS');
  await this.store.transaction(s=>{
   const state=s as GreetingState;checked(state);
   if(!active(state,this.policy,proposed.chatId))throw Error('GROUP_NOT_APPROVED');
   state.phase4GreetingSettings??=[];
   const old=state.phase4GreetingSettings.findIndex(c=>c.chatId===proposed.chatId);
   const rev=old<0?0:state.phase4GreetingSettings[old]!.revision;
   if(proposed.revision!==rev+1)throw Error('STALE_GREETING_REVISION');
   if(old<0){if(state.phase4GreetingSettings.length>=MAX_SETTINGS)throw Error('GREETING_SETTINGS_LIMIT');
    state.phase4GreetingSettings.push(structuredClone(proposed));}
   else state.phase4GreetingSettings[old]=structuredClone(proposed);
   // Obsolete queued intents are cancelled atomically; in-flight requests cannot be recalled.
   for(const j of state.phase4GreetingJobs??[])
    if(j.chatId===proposed.chatId&&j.status==='QUEUED')j.status='CANCELLED';
  });
 }
 /** Reserve a single reply and its idempotency receipt in one BotStore transaction. */
 async evaluate(e:InteractionEvent):Promise<GreetingQueueResult>{
  if(!keyPattern.test(e.updateKey))return {status:'INVALID_UPDATE'};
  return this.store.transaction(s=>{
   const state=s as GreetingState;checked(state);
   const settings=state.phase4GreetingSettings?.find(c=>c.chatId===e.chatId);
   if(!settings)return {status:'UNCONFIGURED'};
   const current={...e,chatApproved:e.chatApproved&&active(state,this.policy,e.chatId)};
   const existing=state.phase4GreetingReceipts??[];
   if(existing.some(x=>x.updateKey===e.updateKey))return {status:'REPLAY'};
   const decision=decideGreeting(settings,current,existing);
   if(decision.status!=='READY')return {status:decision.status};
   if(!decision.rendered)return {status:'INVALID_CONFIG'};
   // Bounded ledgers fail closed: pruning is a separate reviewed maintenance task.
   if((state.phase4GreetingJobs?.length??0)>=MAX_JOBS||
    existing.length>=MAX_RECEIPTS)return {status:'QUEUE_FULL'};
   const job:GreetingJob={id:e.updateKey,updateKey:e.updateKey,chatId:e.chatId,actorId:e.actorId,
    settingsRevision:settings.revision,queuedAt:e.at,status:'QUEUED',html:decision.rendered.html,
    ...(e.topicId!==undefined?{topicId:e.topicId}:{})};
   state.phase4GreetingJobs??=[];state.phase4GreetingReceipts??=[];
   if(state.phase4GreetingJobs.some(j=>j.id===job.id))return {status:'REPLAY'};
   state.phase4GreetingJobs.push(job);state.phase4GreetingReceipts.push(decision.receipt);
   return {status:'QUEUED',jobId:job.id,templateHtml:job.html};
  });
 }
 /** One-shot dispatch. Unknown results and crashed SENDING jobs are NEVER retried. */
 async deliver(jobId:string,sender:TelegramReplySender):Promise<GreetingDeliveryResult>{
  if(!keyPattern.test(jobId))return {status:'NOT_FOUND'};
  if(this.options.allowSending?.()!==true)return {status:'PAUSED'};
  const reserved=await this.store.transaction(s=>{
   const state=s as GreetingState;checked(state);
   const j=state.phase4GreetingJobs?.find(x=>x.id===jobId);
   if(!j)return null;
   if(j.status!=='QUEUED')return {done:j.status} as const;
   const setting=state.phase4GreetingSettings?.find(x=>x.chatId===j.chatId);
   if(!setting||!setting.enabled||setting.revision!==j.settingsRevision||
      !active(state,this.policy,j.chatId)){
    j.status='CANCELLED';return {done:'CANCELLED'} as const;
   }
   if(this.options.allowSending?.()!==true)return {done:'PAUSED'} as const;
   j.status='SENDING';
   return {job:{...j}} as const;
  });
  if(!reserved)return {status:'NOT_FOUND'};
  if('done' in reserved){
   if(reserved.done==='QUEUED'||reserved.done==='SENDING')return {status:'NOT_READY'};
   return {status:reserved.done==='SENT'?'SENT':reserved.done==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':
    reserved.done==='CANCELLED'?'CANCELLED':reserved.done==='PAUSED'?'PAUSED':'UNKNOWN_OUTCOME'};
  }
  const j=reserved.job;
  const plan:TelegramReplyPlan={chatId:j.chatId,parseMode:'HTML',text:j.html,
   ...(j.topicId!==undefined?{messageThreadId:j.topicId}:{})};
  let result:TelegramSendResult;
  try{result=await sender.send(plan);}catch{result={status:'UNKNOWN_OUTCOME'};}
  return this.store.transaction(s=>{
   const state=s as GreetingState;checked(state);
   const row=state.phase4GreetingJobs?.find(x=>x.id===jobId);
   if(!row||row.status!=='SENDING')return {status:'UNKNOWN_OUTCOME'};
   if(result.status==='CONFIRMED'){
    row.status='SENT';row.messageId=result.messageId;
    return {status:'SENT',messageId:result.messageId};
   }
   row.status=result.status;
   return {status:result.status};
  });
 }
 /** Operator-only reconciliation: a crash while SENDING is uncertain, not a retry. */
 async quarantineInterrupted(actorId:string):Promise<number>{
  if(!this.policy.isOwner(actorId))throw Error('OWNER_ONLY');
  return this.store.transaction(s=>{
   const state=s as GreetingState;checked(state);let count=0;
   for(const j of state.phase4GreetingJobs??[])if(j.status==='SENDING'){
    j.status='UNKNOWN_OUTCOME';count++;
   }
   return count;
  });
 }
 async status(actorId:string,chatId:string):Promise<{settings:GreetingSettings|null;
  counts:Readonly<Record<GreetingJob['status'],number>>}>{
  if(!this.policy.isOwner(actorId))throw Error('OWNER_ONLY');
  const state=await this.store.snapshot() as GreetingState;checked(state);
  if(!active(state,this.policy,chatId))throw Error('GROUP_NOT_APPROVED');
  const counts:{[K in GreetingJob['status']]:number}={
   QUEUED:0,SENDING:0,SENT:0,FAILED_CONFIRMED:0,UNKNOWN_OUTCOME:0,CANCELLED:0};
  for(const j of state.phase4GreetingJobs??[])if(j.chatId===chatId)counts[j.status]++;
  return {settings:state.phase4GreetingSettings?.find(c=>c.chatId===chatId)??null,counts};
 }
}