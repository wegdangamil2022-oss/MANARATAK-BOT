import {isAbsolute,resolve} from 'node:path';
import {lstat} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {BotStore,type BotState} from './store.js';
import {readTelegramSafetySwitch} from './telegram-safety-switch.js';
import {summarizeSubscriptionIntegrity} from './subscription-integrity.js';
import {telegramReplyLedgerSafeForTrial} from './telegram-replies.js';
import {orphanModerationReviewAuditReceipts,moderationLedgerSafeForDispatch} from './moderation-review-integrity.js';

/** Offline-only advisory review. PASS is NOT permission to start Telegram,
 * does NOT authorize changing STOP to RUN and does NOT prove TLS or delivery.
 */
export interface TelegramTrialAcceptanceReport{
 stage:'OFFLINE_ONLY';status:'PASS'|'BLOCKED';safety:'STOP'|'RUN';
 rollback:'MATCH'|'MISMATCH';
 reasons:readonly (
  'SAFETY_NOT_STOP'|'BACKUP_STATE_MISMATCH'|'PENDING_REPLIES'|
  'UNRESOLVED_REPLIES'|'UNRESOLVED_UPDATES'|'UNRESOLVED_OPERATIONS'|
  'UNRESOLVED_PUBLICATIONS'|'ACTIVE_PURGE'|'INVALID_SUBSCRIPTION_REQUIREMENTS'|
  'BACKUP_TOO_OLD'|'BACKUP_TIMESTAMP_IN_FUTURE'|
  'ORPHAN_MODERATION_REVIEW_AUDIT'|'UNSAFE_MODERATION_LEDGER'|
  'UNSAFE_REPLY_LEDGER'
 )[];
}
export interface TelegramTrialAcceptanceOptions{
 stateFile:string;backupFile:string;safetyFile:string;now:number;staleAfterMs:number;
}
const FILES=['stateFile','backupFile','safetyFile','now','staleAfterMs'];
const absPath=(p:unknown):p is string=>typeof p==='string'&&p.length>0&&
 !/[\u0000-\u001f\u007f]/u.test(p)&&isAbsolute(p)&&resolve(p)===p;
const valid=(v:unknown):v is TelegramTrialAcceptanceOptions=>{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const m=v as Record<string,unknown>;
 return Object.keys(m).length===5&&
  Object.keys(m).every(k=>FILES.includes(k))&&
  absPath(m.stateFile)&&absPath(m.backupFile)&&absPath(m.safetyFile)&&
  m.stateFile!==m.backupFile&&m.stateFile!==m.safetyFile&&
  m.backupFile!==m.safetyFile&&
  Number.isSafeInteger(m.now)&&Number(m.now)>=0&&
  Number.isSafeInteger(m.staleAfterMs)&&
  Number(m.staleAfterMs)>=60_000&&Number(m.staleAfterMs)<=30*24*60*60_000;
};
const pendingReply=(s:BotState)=>s.telegramReplyJobs?.some(j=>j.status==='QUEUED')??false;
const uncertainReply=(s:BotState)=>s.telegramReplyJobs?.some(
 j=>j.status==='SENDING'||j.status==='UNKNOWN_OUTCOME')??false;
const unresolvedOps=new Set(['INTENT','STARTED','UNKNOWN_OUTCOME']);
const unresolvedDelivery=new Set(['QUEUED','MULTIPART','SENDING','UNKNOWN_OUTCOME']);
const uncertainPurgeItem=new Set(['QUEUED','SENDING','UNKNOWN_OUTCOME']);
/** Requires a protected STOP file, independently verifiable local SQLite
 * backup and source *logical* snapshot match. No file writes, HTTP calls,
 * Telegram tokens, network requests, restores, actor choices or retry paths.
 * The source and backup must be stable/offline: concurrent mutations can make
 * this advisory snapshot inconsistent; the host must stop every writer.
 */
export async function inspectTelegramTrialAcceptanceReadOnly(
 options:TelegramTrialAcceptanceOptions):Promise<TelegramTrialAcceptanceReport>{
 if(!valid(options))throw Error('TRIAL_ACCEPTANCE_INVALID_INPUT');
 let live:BotState;
 try{live=await BotStore.snapshotSqliteReadOnly(options.stateFile);}
 catch{throw Error('TRIAL_ACCEPTANCE_INVALID_STATE');}
 let backup:BotState;
 try{backup=await BotStore.snapshotSqliteReadOnly(options.backupFile);}
 catch{throw Error('TRIAL_ACCEPTANCE_INVALID_BACKUP');}
 // A filesystem hard link to the primary database is NOT an independent
 // backup. Compare device/inode after read-only validation; never trust a
 // distinct pathname alone as evidence of rollback protection.
 let sourceMeta:Awaited<ReturnType<typeof lstat>>;
 let backupMeta:Awaited<ReturnType<typeof lstat>>;
 try{
  [sourceMeta,backupMeta]=await Promise.all([
   lstat(options.stateFile),lstat(options.backupFile)]);
  if(sourceMeta.dev===backupMeta.dev&&sourceMeta.ino===backupMeta.ino)
   throw Error('TRIAL_ACCEPTANCE_INVALID_BACKUP');
 }catch{throw Error('TRIAL_ACCEPTANCE_INVALID_BACKUP');}
 let safety:'RUN'|'STOP';
 let safetyMeta:BigIntStats;
 try{
  safety=await readTelegramSafetySwitch(options.safetyFile);
  // Remember the exact STOP file epoch, not just its bytes. A later
  // replacement with another valid STOP must invalidate this checkpoint.
  safetyMeta=await lstat(options.safetyFile,{bigint:true});
 }catch{throw Error('TRIAL_ACCEPTANCE_INVALID_SAFETY');}
 // The gate does not manufacture an empty state or allow a backup from an
 // arbitrary different dataset to count as a verified rollback anchor.
 const same=JSON.stringify(live)===JSON.stringify(backup);
 const reasons:TelegramTrialAcceptanceReport['reasons'][number][]=[];
 // An exact logical match is necessary but not sufficient: a rollback anchor
 // older than the caller's maximum age is not a fresh trial checkpoint.
 // Also distrust far-future filesystem timestamps (clock skew / tampering).
 // A one-minute tolerance handles coarse-grained filesystem clock skew.
 const futureSkewMs=60_000;
 if(!Number.isFinite(backupMeta.mtimeMs)||
    backupMeta.mtimeMs>options.now+futureSkewMs)
  reasons.push('BACKUP_TIMESTAMP_IN_FUTURE');
 else if(options.now-backupMeta.mtimeMs>options.staleAfterMs)
  reasons.push('BACKUP_TOO_OLD');
 if(safety!=='STOP')reasons.push('SAFETY_NOT_STOP');
 if(!same)reasons.push('BACKUP_STATE_MISMATCH');
 if(pendingReply(live))reasons.push('PENDING_REPLIES');
 if(uncertainReply(live))reasons.push('UNRESOLVED_REPLIES');
 // Completed local reply receipts are not automatically trustworthy. A
 // duplicate update key or malformed historical row must not turn a copied
 // rollback snapshot into a false PASS. Use the same structural validator as
 // the live reply dispatcher and keep the public reason constant/redacted.
 if(!telegramReplyLedgerSafeForTrial(live.telegramReplyJobs))
  reasons.push('UNSAFE_REPLY_LEDGER');
 if(live.updates.some(u=>u.status!=='DONE'))reasons.push('UNRESOLVED_UPDATES');
 if(live.operations.some(o=>unresolvedOps.has(o.status))||
   live.moderationOperations.some(o=>unresolvedOps.has(o.status)))
  reasons.push('UNRESOLVED_OPERATIONS');
 // A fully matching, recent backup can preserve the SAME partially restored
 // evidence gap: owner-review audit exists but its original UNKNOWN_OUTCOME
 // operation vanished. Even without any remaining sanction rows this is NOT
 // a clean trial state; the live moderation ledger would refuse dispatch.
 // Report only one static reason; never expose counts or correlation keys.
 const orphanReviews=orphanModerationReviewAuditReceipts(live);
 if(orphanReviews>0)reasons.push('ORPHAN_MODERATION_REVIEW_AUDIT');
 // Readiness must not say PASS when the shared dispatch guard rejects
 // a restored terminal ledger: invalid rows, duplicate IDs, future-dated
 // operations or contradictory owner-review evidence. Pending work is
 // checked separately. Keep the orphan-specific reason nonredundant.
 if(orphanReviews===0&&!moderationLedgerSafeForDispatch(live,options.now))
  reasons.push('UNSAFE_MODERATION_LEDGER');
 if(live.deliveries.some(d=>unresolvedDelivery.has(d.status)||
   d.multipart?.parts.some(p=>unresolvedDelivery.has(p.status))))
  reasons.push('UNRESOLVED_PUBLICATIONS');
 if(live.purgeJobs.some(j=>j.status==='READY'||
   j.items.some(item=>uncertainPurgeItem.has(item.status))))
  reasons.push('ACTIVE_PURGE');
 // The standalone local subscription audit is also a mandatory offline
 // acceptance invariant. A matched backup is not proof that an orphaned or
 // malformed verification rule is safe; include a static, redacted blocker.
 // This reads only the existing in-memory snapshot, without provider calls.
 if(summarizeSubscriptionIntegrity(live).status==='BLOCKED')
  reasons.push('INVALID_SUBSCRIPTION_REQUIREMENTS');

 // Race-aware advisory check: a state mutation or switch change observed
 // during inspection fails CLOSED, never reports a clean release rehearsal.
 let latest:BotState,latestBackup:BotState,latestSwitch:'RUN'|'STOP';
 try{
  latest=await BotStore.snapshotSqliteReadOnly(options.stateFile);
  // Inode, size and mtime alone cannot certify the original logical backup:
  // an in-place rewrite can restore both size and modification timestamp.
  latestBackup=await BotStore.snapshotSqliteReadOnly(options.backupFile);
  latestSwitch=await readTelegramSafetySwitch(options.safetyFile);
 }catch{throw Error('TRIAL_ACCEPTANCE_STATE_CHANGED');}
 // A backup replaced/re-timestamped while the asynchronous checks were
 // running must not inherit the earlier age/independence decision.
 let currentState:Awaited<ReturnType<typeof lstat>>;
 let currentBackup:Awaited<ReturnType<typeof lstat>>;
 let currentSafety:BigIntStats;
 try{
  [currentState,currentBackup,currentSafety]=await Promise.all([
   lstat(options.stateFile),lstat(options.backupFile),
   lstat(options.safetyFile,{bigint:true})]);
 }catch{throw Error('TRIAL_ACCEPTANCE_STATE_CHANGED');}
 if(JSON.stringify(latest)!==JSON.stringify(live)||
    JSON.stringify(latestBackup)!==JSON.stringify(backup)||
    latestSwitch!==safety||
    currentState.dev!==sourceMeta.dev||currentState.ino!==sourceMeta.ino||
    currentState.size!==sourceMeta.size||
    currentState.mtimeMs!==sourceMeta.mtimeMs||
    currentState.ctimeMs!==sourceMeta.ctimeMs||
    currentBackup.dev!==backupMeta.dev||currentBackup.ino!==backupMeta.ino||
    currentBackup.size!==backupMeta.size||
    currentBackup.mtimeMs!==backupMeta.mtimeMs||
    currentBackup.ctimeMs!==backupMeta.ctimeMs||
    currentSafety.dev!==safetyMeta.dev||currentSafety.ino!==safetyMeta.ino||
    currentSafety.size!==safetyMeta.size||
    currentSafety.mode!==safetyMeta.mode||
    currentSafety.nlink!==safetyMeta.nlink||
    currentSafety.mtimeNs!==safetyMeta.mtimeNs||
    currentSafety.ctimeNs!==safetyMeta.ctimeNs)
  throw Error('TRIAL_ACCEPTANCE_STATE_CHANGED');
 return {stage:'OFFLINE_ONLY',status:reasons.length?'BLOCKED':'PASS',
  safety,rollback:same?'MATCH':'MISMATCH',reasons};
}
