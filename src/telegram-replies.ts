import {randomUUID} from 'node:crypto';
import {BotStore,type TelegramReplyJob} from './store.js';
import {Policy} from './policy.js';
import type {TelegramReplyPlan} from './telegram-transport.js';

export type TelegramSendResult={status:'CONFIRMED';messageId:number}|
 {status:'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'};
export interface TelegramReplySender {
 send(plan:TelegramReplyPlan):Promise<TelegramSendResult>;
}
const validChat=(chat:string)=>/^(?:[1-9]\d{0,15}|-[1-9]\d{0,15})$/.test(chat)&&
 Number.isSafeInteger(Number(chat));
const validPlan=(p:unknown):p is TelegramReplyPlan=>{
 if(!p||typeof p!=='object'||Array.isArray(p))return false;
 const v=p as Record<string,unknown>;
 return Object.keys(v).length===3&&v.parseMode==='HTML'&&typeof v.chatId==='string'&&
  validChat(v.chatId)&&typeof v.text==='string'&&v.text.length>0&&
  Buffer.byteLength(v.text,'utf8')<=4096&& !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v.text);
};
/**
 * Real Telegram Bot API boundary, but construction alone performs no network
 * calls. Does not retry ambiguous requests, never returns provider descriptions
 * or the token, and sends only fixed-format HTML text plans.
 */
export class TelegramBotApiTextSender implements TelegramReplySender {
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/.test(token))
   throw new Error('INVALID_TELEGRAM_TOKEN');
 }
 async send(plan:TelegramReplyPlan):Promise<TelegramSendResult>{
  if(!validPlan(plan))return {status:'FAILED_CONFIRMED'};
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/bot'+this.token+'/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:plan.chatId,text:plan.text,parse_mode:'HTML',
     link_preview_options:{is_disabled:true},protect_content:true}),
    redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{return {status:'UNKNOWN_OUTCOME'};}
  let value:unknown;
  try{
   // Do not keep or log Telegram's response descriptions, tokens or identifiers.
   const raw=await response.text();
   if(raw.length>16_384)return {status:'UNKNOWN_OUTCOME'};
   value=JSON.parse(raw);
  }catch{return {status:'UNKNOWN_OUTCOME'};}
  if(!value||typeof value!=='object'||Array.isArray(value))
   return {status:'UNKNOWN_OUTCOME'};
  const v=value as Record<string,unknown>;
  if(response.ok&&v.ok===true&&v.result&&typeof v.result==='object'&&!Array.isArray(v.result)){
   const msg=v.result as Record<string,unknown>,chat=msg.chat;
   if(Number.isSafeInteger(msg.message_id)&&typeof msg.message_id==='number'&&msg.message_id>0&&
      chat&&typeof chat==='object'&&!Array.isArray(chat)&&
      (chat as Record<string,unknown>).id===Number(plan.chatId))
    return {status:'CONFIRMED',messageId:msg.message_id};
   return {status:'UNKNOWN_OUTCOME'};
  }
  if(response.status>=400&&response.status<500&&v.ok===false)
   return {status:'FAILED_CONFIRMED'};
  return {status:'UNKNOWN_OUTCOME'};
 }
}

export type ReplyDispatchResult={status:'NO_REPLY'|'CONFIRMED'|'SENT'|'SENDING'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'};
const knownStatus=(x:unknown):x is TelegramReplyJob['status']=>[
 'QUEUED','SENDING','SENT','FAILED_CONFIRMED','UNKNOWN_OUTCOME'
].includes(x as string);
const validManualReview=(v:unknown):boolean=>{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const r=v as Record<string,unknown>;
 return Object.keys(r).length===4 &&
  Object.keys(r).every(k=>['decision','reviewedBy','reviewedAt','attemptId'].includes(k))&&
  (r.decision==='ACKNOWLEDGED_UNRESOLVED'||r.decision==='ESCALATED')&&
  typeof r.reviewedBy==='string'&&/^[1-9]\d{0,19}$/.test(r.reviewedBy)&&
  typeof r.attemptId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(r.attemptId)&&
  typeof r.reviewedAt==='number'&&Number.isSafeInteger(r.reviewedAt)&&r.reviewedAt>=0;
};

export function validTelegramReplyJob(v:unknown):v is TelegramReplyJob{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const j=v as Record<string,unknown>;
 return typeof j.updateKey==='string'&&/^b3-webhook:[a-zA-Z0-9_-]{1,80}:\d+$/.test(j.updateKey)&&
  knownStatus(j.status)&&
  (j.status==='QUEUED'?validPlan(j.plan):(j.plan===undefined||validPlan(j.plan)))&&
  (j.queuedAt===undefined||(typeof j.queuedAt==='number'&&Number.isSafeInteger(j.queuedAt)&&j.queuedAt>=0))&&
  (j.startedAt===undefined||(typeof j.startedAt==='number'&&Number.isSafeInteger(j.startedAt)&&j.startedAt>=0))&&
  (j.redactedAt===undefined||(typeof j.redactedAt==='number'&&Number.isSafeInteger(j.redactedAt)&&j.redactedAt>=0))&&
  (j.manualReview===undefined||(
   validManualReview(j.manualReview)&&
   (j.status==='SENDING'||j.status==='UNKNOWN_OUTCOME')&&
   typeof j.attemptId==='string'&&
   (j.manualReview as Record<string,unknown>).attemptId===j.attemptId
  ));
}
/**
 * Durable, one-shot outbound dispatch. Claim is committed before the external
 * call. If an API response is ambiguous or the process crashes in SENDING,
 * never automatically retry and risk duplicate Telegram messages.
 */
export class TelegramReplyDispatcher {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly sender:TelegramReplySender,private readonly clock:()=>number=Date.now){}
 async dispatch(updateKey:string):Promise<ReplyDispatchResult>{
  if(!/^b3-webhook:[a-zA-Z0-9_-]{1,80}:\d+$/.test(updateKey))
   throw new Error('INVALID_REPLY_KEY');
  const claim=await this.store.transaction(s=>{
   const job=s.telegramReplyJobs?.find(j=>j.updateKey===updateKey);
   if(!job)return {status:'NO_REPLY' as const};
   if(!validTelegramReplyJob(job))throw new Error('INVALID_REPLY_JOB');
   if(job.status==='SENDING')return {status:'UNKNOWN_OUTCOME' as const};
   if(job.status!=='QUEUED')return {status:job.status as 'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'};
   const plan=structuredClone(job.plan!);
   if(plan.chatId.startsWith('-')&&!this.policy.canUseChat(s,plan.chatId,'navigation')){
    job.status='FAILED_CONFIRMED';
    // No send will occur. The stored private content no longer serves a purpose.
    delete job.plan;job.redactedAt=this.clock();
    return {status:'FAILED_CONFIRMED' as const};
   }
   const attemptId=randomUUID();
   const at=this.clock();
   job.status='SENDING';job.attemptId=attemptId;job.startedAt=at;
   // Remove the durable body *before* the external call. The immediate local
   // copy goes to the sender, but a crash leaves no replayable payload.
   delete job.plan;job.redactedAt=at;
   return {status:'SEND' as const,attemptId,plan};
  });
  if(claim.status!=='SEND')return {status:claim.status};
  let result:TelegramSendResult;
  try{result=await this.sender.send(claim.plan);}catch{result={status:'UNKNOWN_OUTCOME'};}
  const terminal=result.status==='CONFIRMED'?'SENT':result.status;
  await this.store.transaction(s=>{
   const job=s.telegramReplyJobs?.find(j=>j.updateKey===updateKey);
   if(!job||job.status!=='SENDING'||job.attemptId!==claim.attemptId)
    throw new Error('REPLY_ATTEMPT_FENCED');
   job.status=terminal;
   if(result.status==='CONFIRMED')job.messageId=result.messageId;
  });
  return {status:result.status};
 }
}
