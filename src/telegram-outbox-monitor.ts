import {BotStore} from './store.js';
import {reviewTelegramReplyOutbox} from './telegram-reply-maintenance.js';

/** Safe aggregate for a trusted local service account. Never returns a reply
 * body, chat/update key, attempt ID, reviewer ID, token, or state pathname.
 */
export interface TelegramOutboxHealth {
 state:'OK'|'ATTENTION_REQUIRED';
 total:number;queued:number;sending:number;sent:number;
 failedConfirmed:number;unknownOutcome:number;
 staleQueued:number;staleSending:number;
 manualReviewRequired:number;awaitingFirstReview:number;reviewedUnresolved:number;
}
export async function inspectTelegramOutboxReadOnly(
 stateFile:string, options:{now:number;staleAfterMs:number}):Promise<TelegramOutboxHealth>{
 if(options===null||typeof options!=='object'||Array.isArray(options)||
   Object.keys(options).length!==2||
   Object.keys(options).some(k=>!['now','staleAfterMs'].includes(k))||
   !Number.isSafeInteger(options.now)||options.now<0||
   !Number.isSafeInteger(options.staleAfterMs)||
   options.staleAfterMs<60_000||options.staleAfterMs>30*24*3600_000)
  throw Error('TELEGRAM_OUTBOX_OPTIONS_INVALID');
 const state=await BotStore.snapshotSqliteReadOnly(stateFile);
 // State remains in memory. No BotStore opened with read/write pragmas.
 const review=await reviewTelegramReplyOutbox({snapshot:async()=>state},options);
 const atRisk=review.manualReviewRequired>0||review.staleQueued>0;
 return {
  state:atRisk?'ATTENTION_REQUIRED':'OK',
  total:review.total,queued:review.queued,sending:review.sending,
  sent:review.sent,failedConfirmed:review.failedConfirmed,
  unknownOutcome:review.unknownOutcome,staleQueued:review.staleQueued,
  staleSending:review.staleSending,manualReviewRequired:review.manualReviewRequired,
  awaitingFirstReview:review.awaitingFirstReview,reviewedUnresolved:review.reviewedUnresolved
 };
}
