import {inspectTelegramTrialAcceptanceReadOnly} from './telegram-trial-acceptance.js';

// This is an intentionally ONE-SHOT offline verification, not an activation,
// automatic restore, backup maker, health daemon, or Telegram sender.
// Input fields cannot express go-live or bypass the private STOP file.
const args=process.argv.slice(2);
void (async()=>{
 if(args.length!==9||args[0]!=='--offline-only'||
   args[1]!=='--state'||args[3]!=='--backup'||
   args[5]!=='--safety'||args[7]!=='--stale-ms'||
   !args[2]||!args[4]||!args[6]||!/^[1-9]\d{4,9}$/.test(args[8]??'')){
  process.stderr.write('MANARATAK_TRIAL_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 const staleAfterMs=Number(args[8]);
 if(!Number.isSafeInteger(staleAfterMs)||staleAfterMs<60_000||
    staleAfterMs>30*24*3600_000){
  process.stderr.write('MANARATAK_TRIAL_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 try{
  const report=await inspectTelegramTrialAcceptanceReadOnly({
   stateFile:args[2]!,backupFile:args[4]!,safetyFile:args[6]!,
   now:Date.now(),staleAfterMs
  });
  process.stdout.write(JSON.stringify(report)+'\n');
  process.exitCode=report.status==='PASS'?0:2;
 }catch(err){
  const message=err instanceof Error?err.message:'';
  const status=message==='TRIAL_ACCEPTANCE_INVALID_INPUT'?'REQUEST':
   message==='TRIAL_ACCEPTANCE_INVALID_STATE'?'STATE':
   message==='TRIAL_ACCEPTANCE_INVALID_BACKUP'?'BACKUP':
   message==='TRIAL_ACCEPTANCE_INVALID_SAFETY'?'SAFETY':'STATE_CHANGED';
  // Static error codes only. Do not print local paths, user IDs or provider info.
  process.stderr.write('MANARATAK_TRIAL_INVALID_'+status+'\n');
  process.exitCode=1;
 }
})();
