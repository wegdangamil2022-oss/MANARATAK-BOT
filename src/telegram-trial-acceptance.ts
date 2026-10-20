import {isAbsolute,resolve} from 'node:path';
import {BotStore,type BotState} from './store.js';
import {readTelegramSafetySwitch} from './telegram-safety-switch.js';

/** Offline-only advisory review. PASS is NOT permission to start Telegram,
 * does NOT authorize changing STOP to RUN and does NOT prove TLS or delivery.
 */
export interface TelegramTrialAcceptanceReport{
 stage:'OFFLINE_ONLY';status:'PASS'|'BLOCKED';safety:'STOP'|'RUN';
 rollback:'MATCH'|'MISMATCH';
 reasons:readonly (
  'SAFETY_NOT_STOP'|'BACKUP_STATE_MISMATCH'|'PENDING_REPLIES'|
  'UNRESOLVED_REPLIES'|'UNRESOLVED_UPDATES'|'UNRESOLVED_OPERATIONS'|
  'UNRESOLVED_PUBLICATIONS'|'ACTIVE_PURGE'
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
 let safety:'RUN'|'STOP';
 try{safety=await readTelegramSafetySwitch(options.safetyFile);}
 catch{throw Error('TRIAL_ACCEPTANCE_INVALID_SAFETY');}
 // The gate does not manufacture an empty state or allow a backup from an
 // arbitrary different dataset to count as a verified rollback anchor.
 const same=JSON.stringify(live)===JSON.stringify(backup);
 const reasons:TelegramTrialAcceptanceReport['reasons'][number][]=[];
 if(safety!=='STOP')reasons.push('SAFETY_NOT_STOP');
 if(!same)reasons.push('BACKUP_STATE_MISMATCH');
 if(pendingReply(live))reasons.push('PENDING_REPLIES');
 if(uncertainReply(live))reasons.push('UNRESOLVED_REPLIES');
 if(live.updates.some(u=>u.status!=='DONE'))reasons.push('UNRESOLVED_UPDATES');
 if(live.operations.some(o=>unresolvedOps.has(o.status))||
   live.moderationOperations.some(o=>unresolvedOps.has(o.status)))
  reasons.push('UNRESOLVED_OPERATIONS');
 if(live.deliveries.some(d=>unresolvedDelivery.has(d.status)||
   d.multipart?.parts.some(p=>unresolvedDelivery.has(p.status))))
  reasons.push('UNRESOLVED_PUBLICATIONS');
 if(live.purgeJobs.some(j=>j.status==='READY'||
   j.items.some(item=>uncertainPurgeItem.has(item.status))))
  reasons.push('ACTIVE_PURGE');

 // Race-aware advisory check: a state mutation or switch change observed
 // during inspection fails CLOSED, never reports a clean release rehearsal.
 let latest:BotState,latestSwitch:'RUN'|'STOP';
 try{
  latest=await BotStore.snapshotSqliteReadOnly(options.stateFile);
  latestSwitch=await readTelegramSafetySwitch(options.safetyFile);
 }catch{throw Error('TRIAL_ACCEPTANCE_STATE_CHANGED');}
 if(JSON.stringify(latest)!==JSON.stringify(live)||latestSwitch!==safety)
  throw Error('TRIAL_ACCEPTANCE_STATE_CHANGED');
 return {stage:'OFFLINE_ONLY',status:reasons.length?'BLOCKED':'PASS',
  safety,rollback:same?'MATCH':'MISMATCH',reasons};
}
