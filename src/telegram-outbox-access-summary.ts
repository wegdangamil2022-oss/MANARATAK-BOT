import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import {validTelegramReplyJob} from './telegram-replies.js';

/** Owner-only aggregate view. Intentionally excludes free text, IDs, times,
 * source references, chat/member breakdown and provider error details.
 */
export interface OutboxAccessDenialSummary{
 totalFailed:number;
 legacyUnverifiable:number;
 accessRecheckFailed:number;
 groupUnavailable:number;
 otherConfirmedFailures:number;
}
/** This is a read-only snapshot, never a Telegram retry or an ACL override.
 * Reasons describe ONLY local evidence; do not infer actual external member
 * revocation vs. provider unknown, expired proof, or operator action.
 */
export async function summarizeOutboxAccessDenials(
 store:Pick<BotStore,'snapshot'>,policy:Policy,actorId:string
):Promise<OutboxAccessDenialSummary>{
 if(!policy.isOwner(actorId))throw Error('OWNER_ONLY');
 const state=await store.snapshot();
 if(!policy.privateFeature(state,'owner.dashboard',actorId))
  throw Error('OWNER_DASHBOARD_DISABLED');
 const jobs=state.telegramReplyJobs??[];
 if(!Array.isArray(jobs)||jobs.some(j=>!validTelegramReplyJob(j)))
  throw Error('INVALID_REPLY_JOB');
 const report:OutboxAccessDenialSummary={
  totalFailed:0,legacyUnverifiable:0,accessRecheckFailed:0,
  groupUnavailable:0,otherConfirmedFailures:0
 };
 for(const job of jobs){
  if(job.status!=='FAILED_CONFIRMED')continue;
  report.totalFailed++;
  switch(job.accessDenialCode){
   case 'LEGACY_UNVERIFIABLE':report.legacyUnverifiable++;break;
   case 'ACCESS_RECHECK_FAILED':report.accessRecheckFailed++;break;
   case 'GROUP_UNAVAILABLE':report.groupUnavailable++;break;
   default:report.otherConfirmedFailures++;break;
  }
 }
 return report;
}
