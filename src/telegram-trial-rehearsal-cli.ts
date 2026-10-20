import {rehearseTelegramTrialRollback} from './telegram-trial-rehearsal.js';

// One-shot offline restore rehearsal, NEVER on source/backup/production path.
// This command does not read Telegram tokens or activate the webhook.
const args=process.argv.slice(2);
void (async()=>{
 if(args.length!==11||args[0]!=='--offline-only'||
   args[1]!=='--state'||args[3]!=='--backup'||
   args[5]!=='--safety'||args[7]!=='--sandbox'||
   args[9]!=='--stale-ms'||!args[2]||!args[4]||!args[6]||!args[8]||
   !/^[1-9]\d{4,9}$/.test(args[10]??'')){
  process.stderr.write('MANARATAK_REHEARSAL_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 const staleAfterMs=Number(args[10]);
 if(!Number.isSafeInteger(staleAfterMs)||staleAfterMs<60_000||
    staleAfterMs>30*24*3600_000){
  process.stderr.write('MANARATAK_REHEARSAL_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 try{
  const r=await rehearseTelegramTrialRollback({
   stateFile:args[2]!,backupFile:args[4]!,safetyFile:args[6]!,
   sandboxDir:args[8]!,now:Date.now(),staleAfterMs
  });
  process.stdout.write(JSON.stringify(r)+'\n');
  process.exitCode=r.status==='PASS'?0:2;
 }catch(err){
  const msg=err instanceof Error?err.message:'';
  const reason=msg==='TRIAL_REHEARSAL_UNSAFE_SANDBOX'?'SANDBOX':
   msg==='TRIAL_ACCEPTANCE_INVALID_BACKUP'?'BACKUP':
   msg==='TRIAL_ACCEPTANCE_INVALID_SAFETY'?'SAFETY':
   msg==='TRIAL_ACCEPTANCE_INVALID_STATE'?'STATE':
   msg==='TRIAL_REHEARSAL_RESTORE_FAILED'?'RESTORE':'REQUEST';
  process.stderr.write('MANARATAK_REHEARSAL_INVALID_'+reason+'\n');
  process.exitCode=1;
 }
})();
