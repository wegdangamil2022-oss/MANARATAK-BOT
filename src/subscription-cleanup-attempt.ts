import {createHash} from 'node:crypto';
import {type BotState,type TelegramReplyJob} from './store.js';
import {subscriptionFallbackReceiptDigest,subscriptionFallbackReceiptEvidence,validSubscriptionFallbackCleanup,type SubscriptionFallbackCleanup} from './subscription-fallback-receipt.js';

export const CLEANUP_ATTEMPT_TIMEOUT_MS=30000;
type Outcome='ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT'|'EXPIRED_UNSENT';
const digest=(receipt:SubscriptionFallbackCleanup)=>createHash('sha256').update(JSON.stringify([subscriptionFallbackReceiptDigest(receipt),receipt.attemptId])).digest('hex');
const key=(job:TelegramReplyJob,receipt:SubscriptionFallbackCleanup)=>job.updateKey+':cleanup:'+receipt.attemptId;
/** Local audit only: never stores notice text, provider descriptions or tokens. */
export function recordCleanupAttempt(s:BotState,job:TelegramReplyJob,receipt:SubscriptionFallbackCleanup,at:number,outcome?:Outcome):boolean{
 if(job.status!=='SENT'||!validSubscriptionFallbackCleanup(receipt)||receipt.status==='WAITING'||!subscriptionFallbackReceiptEvidence(s,job,receipt)||!Number.isSafeInteger(at)||at<receipt.createdAt||at>8640000000000000)return false;
 const updateKey=key(job,receipt)+(outcome?':result':':started');
 if(s.audit.some(a=>a.updateKey===updateKey))return false;
 s.audit.push({updateKey,actorId:receipt.chatId,decision:outcome&&outcome!=='ACKNOWLEDGED'?'NOOP':'ALLOW',reason:'SUBSCRIPTION_CLEANUP_'+(outcome??'STARTED')+':'+digest(receipt),policyVersion:0,at});return true;
}
export function cleanupAttemptStartedAt(s:BotState,job:TelegramReplyJob,receipt:SubscriptionFallbackCleanup):number|null{
 const rows=s.audit.filter(a=>a.updateKey===key(job,receipt)+':started'),row=rows[0];
 return rows.length===1&&row?.actorId===receipt.chatId&&row.decision==='ALLOW'&&row.reason==='SUBSCRIPTION_CLEANUP_STARTED:'+digest(receipt)&&Number.isSafeInteger(row.at)&&row.at>=receipt.createdAt&&row.at<=8640000000000000?row.at:null;
}
/** An interrupted delete is uncertain, never a queued retry. Legacy attempts
 * without a matching start witness stay quarantined for manual investigation. */
export function reconcileInterruptedCleanup(s:BotState,now:number,limit:number):number{
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000||!Number.isSafeInteger(limit)||limit<1||limit>10)return 0;
 const jobs=s.telegramReplyJobs??[];let recovered=0;
 for(const job of jobs){
  const receipt=job.verificationCleanup;
  if(recovered>=limit)break;
  if(job.status!=='SENT'||!validSubscriptionFallbackCleanup(receipt)||receipt.status!=='DELETING'||!subscriptionFallbackReceiptEvidence(s,job,receipt)||jobs.filter(j=>j.updateKey===job.updateKey).length!==1||jobs.filter(j=>j.verificationCleanup?.chatId===receipt.chatId&&j.verificationCleanup?.messageId===receipt.messageId).length!==1)continue;
  const started=cleanupAttemptStartedAt(s,job,receipt);
  if(started===null||now<started+CLEANUP_ATTEMPT_TIMEOUT_MS||s.audit.some(a=>a.updateKey===key(job,receipt)+':result'))continue;
  if(!recordCleanupAttempt(s,job,receipt,now,'UNKNOWN_OUTCOME'))continue;
  receipt.status='UNKNOWN_OUTCOME';recovered++;
 }
 return recovered;
}
