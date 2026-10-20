import {BotStore,type TelegramReplyJob} from './store.js';
import {validTelegramReplyJob} from './telegram-replies.js';

const LIMIT=500;
const VALID_AGE_MAX=30*24*60*60*1000;
export interface TelegramReplyOutboxReviewOptions{now:number;staleAfterMs:number}
export interface TelegramReplyOutboxReview{
 asOf:number;total:number;queued:number;sending:number;sent:number;
 failedConfirmed:number;unknownOutcome:number;bodiesStored:number;
 staleQueued:number;staleSending:number;manualReviewRequired:number;
}
export interface TelegramReplyRedactOptions{now:number;maxEntries?:number}
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
 props(v,['now','maxEntries'])&&safeNonNegative(v.now)&&
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
  staleQueued:0,staleSending:0,manualReviewRequired:0};
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
  const max=options.maxEntries??LIMIT,scanned=Math.min(max,jobs.length);
  const result:TelegramReplyRedactResult={
   scanned,redacted:0,skippedQueued:0,alreadyRedacted:0,remaining:jobs.length-scanned
  };
  for(const job of jobs.slice(0,scanned)){
   if(job.status==='QUEUED'){result.skippedQueued++;continue;}
   if(job.plan===undefined){result.alreadyRedacted++;continue;}
   delete job.plan;
   job.redactedAt=options.now;
   result.redacted++;
  }
  return result;
 });
}
