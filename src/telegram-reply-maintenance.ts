import {BotStore,type TelegramReplyJob} from './store.js';
import {validTelegramReplyJob} from './telegram-replies.js';

const LIMIT=500;
const VALID_AGE_MAX=30*24*60*60*1000;
export interface TelegramReplyOutboxReviewOptions{now:number;staleAfterMs:number}
export interface TelegramReplyOutboxReview{
 asOf:number;total:number;queued:number;sending:number;sent:number;
 failedConfirmed:number;unknownOutcome:number;bodiesStored:number;
 staleQueued:number;staleSending:number;manualReviewRequired:number;
 reviewedUnresolved:number;awaitingFirstReview:number;
}
export interface TelegramReplyRedactOptions{now:number;maxEntries?:number;startAt?:number}
export interface TelegramReplyRedactResult{
 scanned:number;redacted:number;skippedQueued:number;alreadyRedacted:number;remaining:number;
}
const safeNonNegative=(n:unknown):n is number=>
 typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const props=(value:unknown,keys:string[]):boolean=>
 value!==null&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).every(k=>keys.includes(k));
const validReview=(v:TelegramReplyOutboxReviewOptions):boolean=>
 props(v,['now','staleAfterMs'])&&safeNonNegative(v.now)&&
 safeNonNegative(v.staleAfterMs)&&v.staleAfterMs>=60_000&&v.staleAfterMs<=VALID_AGE_MAX;
const validRedaction=(v:TelegramReplyRedactOptions):boolean=>
 props(v,['now','maxEntries','startAt'])&&safeNonNegative(v.now)&&
 (v.startAt===undefined||safeNonNegative(v.startAt))&&
 (v.maxEntries===undefined||
 (typeof v.maxEntries==='number'&&Number.isSafeInteger(v.maxEntries)&&v.maxEntries>=1&&v.maxEntries<=LIMIT));
const safeJobs=(value:TelegramReplyJob[]|undefined):TelegramReplyJob[]=>{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.some(j=>!validTelegramReplyJob(j)))
  throw Error('REPLY_MAINTENANCE_INVALID_JOB');
 return value;
};
/** Read-only operational snapshot. Never exposes chat IDs, update IDs, message
 * content, file paths or evidence identifiers, and never authorizes a retry.
 */
export async function reviewTelegramReplyOutbox(store:BotStore,options:TelegramReplyOutboxReviewOptions)
 :Promise<TelegramReplyOutboxReview>{
 if(!validReview(options))throw Error('REPLY_MAINTENANCE_INVALID_OPTIONS');
 const jobs=safeJobs((await store.snapshot()).telegramReplyJobs);
 const report:TelegramReplyOutboxReview={asOf:options.now,total:jobs.length,queued:0,
  sending:0,sent:0,failedConfirmed:0,unknownOutcome:0,bodiesStored:0,
  staleQueued:0,staleSending:0,manualReviewRequired:0,
  reviewedUnresolved:0,awaitingFirstReview:0};
 for(const job of jobs){
  if(job.plan!==undefined)report.bodiesStored++;
  if(job.status==='QUEUED'){
   report.queued++;
   if(job.queuedAt!==undefined&&options.now>=job.queuedAt&&
     options.now-job.queuedAt>=options.staleAfterMs)report.staleQueued++;
  }else if(job.status==='SENDING'){
   report.sending++;
   if(job.startedAt!==undefined&&options.now>=job.startedAt&&
     options.now-job.startedAt>=options.staleAfterMs)report.staleSending++;
  }else if(job.status==='SENT')report.sent++;
  else if(job.status==='FAILED_CONFIRMED')report.failedConfirmed++;
  else if(job.status==='UNKNOWN_OUTCOME')report.unknownOutcome++;
 }
 // Started sends lack Telegram idempotency keys; old unresolved attempts must
 // never be recovered by automatically submitting another sendMessage.
 report.manualReviewRequired=report.unknownOutcome+report.staleSending;
 // Acknowledged does not mean delivered or resolved. Maintain both counts.
 report.reviewedUnresolved=jobs.filter(j=>j.manualReview!==undefined&&
  (j.status==='UNKNOWN_OUTCOME'||(j.status==='SENDING'&&j.startedAt!==undefined&&
   options.now>=j.startedAt&&options.now-j.startedAt>=options.staleAfterMs))).length;
 report.awaitingFirstReview=report.manualReviewRequired-report.reviewedUnresolved;
 return report;
}
/** An explicit opt-in privacy operation. Never discards a queued message,
 * changes the durable delivery decision, deletes receipt IDs, or contacts Telegram.
 * Scrubbing JSON does NOT securely erase older SQLite WAL pages or backups;
 * secure physical lifecycle is a separate deployment concern.
 */
export async function redactFinishedTelegramReplies(store:BotStore,options:TelegramReplyRedactOptions)
 :Promise<TelegramReplyRedactResult>{
 if(!validRedaction(options))throw Error('REPLY_MAINTENANCE_INVALID_OPTIONS');
 return store.transaction(state=>{
  // Validate the ENTIRE ledger first so an invalid tail cannot cause a
  // partial loss of earlier replies.
  const jobs=safeJobs(state.telegramReplyJobs);
  const max=options.maxEntries??LIMIT,start=Math.min(options.startAt??0,jobs.length);
  const scanned=Math.min(max,jobs.length-start);
  const result:TelegramReplyRedactResult={
   scanned,redacted:0,skippedQueued:0,alreadyRedacted:0,remaining:jobs.length-start-scanned
  };
  for(const job of jobs.slice(start,start+scanned)){
   if(job.status==='QUEUED'){result.skippedQueued++;continue;}
   if(job.plan===undefined){result.alreadyRedacted++;continue;}
   delete job.plan;
   job.redactedAt=options.now;
   result.redacted++;
  }
  return result;
 });
}


/** Internal operator-only audit action. Caller must supply an actor ID obtained
 * from trusted authentication, NOT from arbitrary user text or HTTP query data.
 * The persisted acknowledgement is not proof of send success/failure. No Bot API
 * calls, retries, changing receipt status or customer content are performed.
 */
export interface TelegramReplyManualReviewOptions{
 actorId:string;updateKey:string;attemptId:string;
 decision:'ACKNOWLEDGED_UNRESOLVED'|'ESCALATED';
 now:number;staleAfterMs:number;
}
export type TelegramReplyManualReviewResult={result:'RECORDED'|'ALREADY_RECORDED'};
const validManualOptions=(o:TelegramReplyManualReviewOptions):boolean=>
 props(o,['actorId','updateKey','attemptId','decision','now','staleAfterMs'])&&
 typeof o.actorId==='string'&&/^[1-9]\d{0,19}$/.test(o.actorId)&&
 typeof o.updateKey==='string'&&/^b3-webhook:[a-zA-Z0-9_-]{1,80}:\d+$/.test(o.updateKey)&&
 typeof o.attemptId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(o.attemptId)&&
 (o.decision==='ACKNOWLEDGED_UNRESOLVED'||o.decision==='ESCALATED')&&
 safeNonNegative(o.now)&&safeNonNegative(o.staleAfterMs)&&
 o.staleAfterMs>=60_000&&o.staleAfterMs<=VALID_AGE_MAX;

/** A durable and fenced one-shot human acknowledgement. Deliberately refuses
 * to convert SENDING/UNKNOWN_OUTCOME to SENT/FAILED or reset the send queue.
 * No public HTTP route or CLI is exposed; a trusted operator UI will require
 * separate authentication and independent evidence verification later.
 */
export async function recordTelegramReplyManualReview(
 store:BotStore,policy:import('./policy.js').Policy,options:TelegramReplyManualReviewOptions
):Promise<TelegramReplyManualReviewResult>{
 if(!validManualOptions(options))throw Error('REPLY_REVIEW_INVALID_OPTIONS');
 if(!policy.isOwner(options.actorId))throw Error('OWNER_ONLY');
 return store.transaction(state=>{
  const jobs=safeJobs(state.telegramReplyJobs);
  // Duplicate update keys are corrupt/ambiguous; never choose the first one.
  const matches=jobs.filter(j=>j.updateKey===options.updateKey);
  if(matches.length>1)throw Error('REPLY_REVIEW_INVALID_JOB');
  const job=matches[0];
  if(!job)throw Error('REPLY_REVIEW_NOT_FOUND');
  if(job.status!=='SENDING'&&job.status!=='UNKNOWN_OUTCOME')
   throw Error('REPLY_REVIEW_NOT_REVIEWABLE');
  if(!job.attemptId||job.attemptId!==options.attemptId)
   throw Error('REPLY_REVIEW_ATTEMPT_MISMATCH');
  if(job.status==='SENDING'&&
     (job.startedAt===undefined||options.now<job.startedAt||
      options.now-job.startedAt<options.staleAfterMs))
   throw Error('REPLY_REVIEW_NOT_STALE');
  if(job.manualReview){
   if(job.manualReview.attemptId===options.attemptId&&
      job.manualReview.decision===options.decision&&
      job.manualReview.reviewedBy===options.actorId)
    return {result:'ALREADY_RECORDED' as const};
   throw Error('REPLY_REVIEW_ALREADY_RECORDED');
  }
  job.manualReview={decision:options.decision,attemptId:options.attemptId,
   reviewedBy:options.actorId,reviewedAt:options.now};
  return {result:'RECORDED' as const};
 });
}
