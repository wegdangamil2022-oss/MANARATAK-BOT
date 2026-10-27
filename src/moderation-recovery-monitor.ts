import {BotStore,type BotState,type ModerationOperation} from './store.js';
import {moderationLedgerSafeForDispatch} from './moderation-review-integrity.js';

/**
 * A strictly local, aggregate-only report for a trusted host operator.
 * It does not require a Telegram token, touch an outbound gateway or write
 * any state. A status of INTENT is not a proof of safe cancellation: after
 * a crash, externally changed ledger evidence may be incomplete.
 * Even a fresh INTENT or STARTED may be orphaned by a restart. A detached
 * one-shot monitor has no trusted process-liveness proof, so ALL unresolved
 * attempts require operator attention; none authorize retry or auto-review.
 */
export interface ModerationRecoveryReport{
 readonly stage:'OFFLINE_MODERATION_RECOVERY';
 readonly state:'OK'|'ATTENTION_REQUIRED';
 readonly totalOperations:number;
 readonly intent:number;
 readonly started:number;
 readonly unknownOutcome:number;
 readonly staleIntent:number;
 readonly staleStarted:number;
 readonly clockAnomaly:number;
 readonly awaitingFirstReview:number;
 readonly reviewedUnresolved:number;
 readonly distinctBlockedTargets:number;
 readonly manualAttention:number;
}
export interface ModerationRecoveryOptions{
 readonly now:number;
 readonly staleAfterMs:number;
}
const knownStatuses=new Set<ModerationOperation['status']>([
 'INTENT','STARTED','CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','CANCELLED'
]);
const DAY_MS=86_400_000;
function validOptions(v:unknown):v is ModerationRecoveryOptions{
 if(v===null||typeof v!=='object'||Array.isArray(v))return false;
 const m=v as Record<string,unknown>;
 return Object.keys(m).length===2&&
  Object.keys(m).every(k=>k==='now'||k==='staleAfterMs')&&
  Number.isSafeInteger(m.now)&&typeof m.now==='number'&&m.now>=0&&
  m.now<=8_640_000_000_000_000&&
  Number.isSafeInteger(m.staleAfterMs)&&typeof m.staleAfterMs==='number'&&
  m.staleAfterMs>=60_000&&m.staleAfterMs<=30*DAY_MS;
}
const validOp=(v:ModerationOperation):boolean=>
 v!==null&&typeof v==='object'&&
 typeof v.id==='string'&&typeof v.chatId==='string'&&
 typeof v.memberId==='string'&&
 typeof v.status==='string'&&knownStatuses.has(v.status) &&
 typeof v.createdAt==='number';

/** Pure projection for JSON/SQLite snapshots, no side effects.
 * Ages are measured from original INTENT creation, not dispatch time:
 * a stale STARTED entry is an investigation signal, not a measured
 * Telegram request duration or evidence of provider delivery.
 */
export function summarizeModerationRecovery(
 s:Pick<BotState,'moderationOperations'>,
 options:ModerationRecoveryOptions):ModerationRecoveryReport{
 if(!validOptions(options))throw Error('MODERATION_RECOVERY_OPTIONS_INVALID');
 if(!s||!Array.isArray(s.moderationOperations)||
  !s.moderationOperations.every(validOp)||
  !moderationLedgerSafeForDispatch(s))
  throw Error('MODERATION_RECOVERY_INVALID_LEDGER');
 let intent=0,started=0,unknownOutcome=0,staleIntent=0,staleStarted=0,
  clockAnomaly=0,awaitingFirstReview=0,reviewedUnresolved=0,manualAttention=0;
 const blockedTargets=new Set<string>();
 for(const o of s.moderationOperations){
  const pending=o.status==='INTENT'||o.status==='STARTED'||
   o.status==='UNKNOWN_OUTCOME';
  if(!pending)continue;
  blockedTargets.add(JSON.stringify([o.chatId,o.memberId]));
  const invalidTime=!Number.isSafeInteger(o.createdAt)||
   o.createdAt<0||o.createdAt>options.now;
  if(invalidTime)clockAnomaly++;
  const stale=!invalidTime&&options.now-o.createdAt>=options.staleAfterMs;
  if(o.status==='INTENT'){
   intent++;
   if(stale)staleIntent++;
  }else if(o.status==='STARTED'){
   started++;
   if(stale)staleStarted++;
  }else{
   unknownOutcome++;
   if(o.review)reviewedUnresolved++;
   else awaitingFirstReview++;
  }
  // A fresh timestamp does not prove the process that reserved INTENT or
  // STARTED is still alive. Reporting OK could hide a crash or power loss.
  // Every unresolved receipt needs a human decision, never an auto-retry.
  manualAttention++;
 }
 return {
  stage:'OFFLINE_MODERATION_RECOVERY',
  state:manualAttention?'ATTENTION_REQUIRED':'OK',
  totalOperations:s.moderationOperations.length,
  intent,started,unknownOutcome,staleIntent,staleStarted,
  clockAnomaly,awaitingFirstReview,reviewedUnresolved,
  distinctBlockedTargets:blockedTargets.size,manualAttention
 };
}
/** Read-only SQLite snapshot with the existing path, mode, symlink and DB
 * integrity rules. No BotStore write connection, network or state transition.
 */
export async function inspectModerationRecoveryReadOnly(
 stateFile:string,options:ModerationRecoveryOptions):Promise<ModerationRecoveryReport>{
 if(!validOptions(options))throw Error('MODERATION_RECOVERY_OPTIONS_INVALID');
 const s=await BotStore.snapshotSqliteReadOnly(stateFile);
 return summarizeModerationRecovery(s,options);
}
