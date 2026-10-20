import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
import {runSqliteRestoreDrill} from './backup-restore-drill.js';
import {inspectTelegramTrialAcceptanceReadOnly,
 type TelegramTrialAcceptanceOptions,type TelegramTrialAcceptanceReport} from './telegram-trial-acceptance.js';

export interface TelegramTrialRehearsalOptions extends TelegramTrialAcceptanceOptions{
 sandboxDir:string;
}
export interface TelegramTrialRehearsalReport{
 stage:'ISOLATED_RESTORE_REHEARSAL';
 status:'PASS'|'BLOCKED';
 rollback:'VERIFIED'|'NOT_ATTEMPTED';
 safety:'STOP'|'RUN';
 reasons:TelegramTrialAcceptanceReport['reasons'];
}
const FILES=['stateFile','backupFile','safetyFile','sandboxDir','now','staleAfterMs'];
const within=(parent:string,child:string):boolean=>{
 const sub=relative(parent,child);
 return sub===''||(!sub.startsWith('..')&&!isAbsolute(sub));
};
/** Mandatory live STOP, matched independently owned snapshot and isolated
 * private sandbox. The actual SQLite backup copy is created ONLY inside that
 * pre-existing sandbox using the project's earlier verified restore drill;
 * its scratch files are removed. NEVER replaces a production database.
 */
export async function rehearseTelegramTrialRollback(
 opts:TelegramTrialRehearsalOptions):Promise<TelegramTrialRehearsalReport>{
 if(!opts||typeof opts!=='object'||Array.isArray(opts)||
   Object.keys(opts).length!==6||
   Object.keys(opts).some(k=>!FILES.includes(k)))
  throw Error('TRIAL_REHEARSAL_INVALID_OPTIONS');
 const {sandboxDir,...acceptanceOpts}=opts;
 if(typeof sandboxDir!=='string'||!isAbsolute(sandboxDir)||
    sandboxDir!==resolve(sandboxDir)||
    /[\u0000-\u001f\u007f]/u.test(sandboxDir)||
    sandboxDir===dirname(opts.stateFile)||
    sandboxDir===dirname(opts.backupFile)||
    within(sandboxDir,opts.stateFile)||
    within(sandboxDir,opts.backupFile)||
    within(sandboxDir,opts.safetyFile))
  throw Error('TRIAL_REHEARSAL_UNSAFE_SANDBOX');
 try{
  const meta=await lstat(sandboxDir);
  if(!meta.isDirectory()||meta.isSymbolicLink()||
   (meta.mode&0o077)!==0||await realpath(sandboxDir)!==sandboxDir)
   throw Error('TRIAL_REHEARSAL_UNSAFE_SANDBOX');
 }catch{throw Error('TRIAL_REHEARSAL_UNSAFE_SANDBOX');}
 const review=await inspectTelegramTrialAcceptanceReadOnly(acceptanceOpts);
 if(review.status!=='PASS'){
  return {stage:'ISOLATED_RESTORE_REHEARSAL',status:'BLOCKED',
   rollback:'NOT_ATTEMPTED',safety:review.safety,reasons:review.reasons};
 }
 try{
  const result=await runSqliteRestoreDrill({backupFile:opts.backupFile,sandboxDir});
  if(result.status!=='VERIFIED')throw Error('RESTORE_NOT_VERIFIED');
 }catch{throw Error('TRIAL_REHEARSAL_RESTORE_FAILED');}
 // The file and switch may have changed while the sandbox was copying.
 // Report neither PASS nor "not attempted" if this advisory final check fails.
 try{
  const after=await inspectTelegramTrialAcceptanceReadOnly(acceptanceOpts);
  if(after.status!=='PASS')throw Error('TRIAL_REHEARSAL_STATE_CHANGED');
 }catch{throw Error('TRIAL_REHEARSAL_STATE_CHANGED');}
 return {stage:'ISOLATED_RESTORE_REHEARSAL',status:'PASS',
  rollback:'VERIFIED',safety:'STOP',reasons:[]};
}
