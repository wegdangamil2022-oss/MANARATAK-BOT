import {lstat} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {inspectOfflineModerationTrialScope,
 type OfflineModerationTrialOptions,type ModerationTrialBlocker} from './moderation-trial-scope.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

type Rights='GRANTED'|'DENIED'|'UNKNOWN';
type Probe=Pick<TelegramBotApiModerationGateway,'inspectBotModerationRights'>;
export interface ReadOnlyModerationRightsReport{
 readonly stage:'READ_ONLY_MODERATION_RIGHTS';
 readonly status:'PASS'|'BLOCKED';
 readonly safety:'STOP'|'RUN';
 readonly rollback:'MATCH'|'MISMATCH';
 readonly botRights:Rights|'NOT_CHECKED'|'CHANGED';
 readonly reasons:readonly (ModerationTrialBlocker|
  'BOT_MODERATION_RIGHTS_DENIED'|'BOT_MODERATION_RIGHTS_UNKNOWN'|
  'BOT_MODERATION_RIGHTS_CHANGED'|'BOT_MODERATION_GATEWAY_UNTRUSTED'|
  'TRIAL_CHECKPOINT_CHANGED')[];
}
/** Capture the SAME local filesystem evidence across multiple remote Telegram
 * rights observations. Re-running acceptance alone is not enough: a STOP
 * inode or an exactly-matching rollback backup could be replaced between
 * separate acceptance passes without changing either report.
 *
 * This is an advisory filesystem epoch, not a trusted lock or a proof of
 * remote rights permanence. The operator must still stop other writers.
 */
type Checkpoint={state:BigIntStats;backup:BigIntStats;safety:BigIntStats};
const sameFileEpoch=(a:BigIntStats,b:BigIntStats):boolean=>
 a.isFile()&&b.isFile()&&a.dev===b.dev&&a.ino===b.ino&&
 a.mode===b.mode&&a.nlink===b.nlink&&a.size===b.size&&
 a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
export async function checkpoint(o:OfflineModerationTrialOptions):Promise<Checkpoint|null>{
 try{
  const [state,backup,safety]=await Promise.all([
   lstat(o.stateFile,{bigint:true}),
   lstat(o.backupFile,{bigint:true}),
   lstat(o.safetyFile,{bigint:true})
  ]);
  return state.isFile()&&backup.isFile()&&safety.isFile()?
   {state,backup,safety}:null;
 }catch{return null;}
}
export const sameCheckpoint=(a:Checkpoint,b:Checkpoint):boolean=>
 sameFileEpoch(a.state,b.state)&&sameFileEpoch(a.backup,b.backup)&&
 sameFileEpoch(a.safety,b.safety);

/** Two read-only Telegram bot-rights observations, surrounded by the existing
 * STOP, approved one-group, independent backup, and local policy gate.
 * A PASS is an advisory moment-in-time result, NOT permission to arm a sanction.
 * This function never calls setRestriction, contacts members, or writes state.
 * A concrete trusted TelegramBotApiModerationGateway supplies getChatMember.
 */
export async function inspectIsolatedModerationRightsReadOnly(
 options:OfflineModerationTrialOptions,
 gateway:Probe):Promise<ReadOnlyModerationRightsReport>{
 const initial=await inspectOfflineModerationTrialScope(options);
 const base=(current:typeof initial,botRights:ReadOnlyModerationRightsReport['botRights'],
  reasons:ReadOnlyModerationRightsReport['reasons']):ReadOnlyModerationRightsReport=>({
   stage:'READ_ONLY_MODERATION_RIGHTS',status:reasons.length?'BLOCKED':'PASS',
   safety:current.safety,rollback:current.rollback,botRights,reasons
  });
 if(initial.status!=='PASS')return base(initial,'NOT_CHECKED',initial.reasons);
 const originalCheckpoint=await checkpoint(options);
 const checkpointChanged=async():Promise<boolean>=>{
  const current=await checkpoint(options);
  return !originalCheckpoint||!current||
   !sameCheckpoint(originalCheckpoint,current);
 };
 const stale=(current:typeof initial)=>
  base(current,'NOT_CHECKED',['TRIAL_CHECKPOINT_CHANGED']);
 // A missing or vanishing STOP/SQLite inode cannot grant even a first
 // remote rights read. Status-only report; never expose filesystem metadata.
 if(await checkpointChanged())return stale(initial);
 // No structural mock or overridden adapter may claim verified bot rights.
 // This never arms the separately disabled live moderation dispatch path.
 const authentic=()=>TelegramBotApiModerationGateway.usesOfficialRightsRead(gateway);
 const untrusted=(current:typeof initial)=>
  base(current,'NOT_CHECKED',['BOT_MODERATION_GATEWAY_UNTRUSTED']);
 if(!authentic())return untrusted(initial);
 const read=async():Promise<Rights>=>{
  try{
   const v=await gateway.inspectBotModerationRights(options.trialChatId);
   return v==='GRANTED'||v==='DENIED'?v:'UNKNOWN';
  }catch{return 'UNKNOWN';}
 };
 const first=await read();
 // The Telegram read may await network while the local operator revokes
 // approval or changes STOP. No second provider read if it is now unsafe.
 const midpoint=await inspectOfflineModerationTrialScope(options);
 if(midpoint.status!=='PASS')return base(midpoint,first,midpoint.reasons);
 // The same STOP contents and logically matching backup are not enough if
 // either file was replaced during the network lookup.
 if(await checkpointChanged())return stale(midpoint);
 // The adapter may itself be replaced while getChatMember awaited network.
 if(!authentic())return untrusted(midpoint);
 const second=await read();
 // Rights may change during a second network lookup; also recheck local
 // evidence at the end. Still cannot make the check+remote mutation atomic.
 const final=await inspectOfflineModerationTrialScope(options);
 if(final.status!=='PASS')return base(final,second,final.reasons);
 if(await checkpointChanged())return stale(final);
 if(!authentic())return untrusted(final);
 if(first!==second)return base(final,'CHANGED',['BOT_MODERATION_RIGHTS_CHANGED']);
 if(second==='DENIED')return base(final,'DENIED',['BOT_MODERATION_RIGHTS_DENIED']);
 if(second==='UNKNOWN')return base(final,'UNKNOWN',['BOT_MODERATION_RIGHTS_UNKNOWN']);
 return base(final,'GRANTED',[]);
}
