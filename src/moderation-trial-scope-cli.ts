import {inspectOfflineModerationTrialScope} from './moderation-trial-scope.js';

// Operator-selected, one-shot OFFLINE inventory. This cannot activate bot
// moderation, set RUN, send to Telegram or certify real remote isolation.
const args=process.argv.slice(2);
void (async()=>{
 if(args.length!==11||args[0]!=='--offline-only'||
  args[1]!=='--state'||args[3]!=='--backup'||
  args[5]!=='--safety'||args[7]!=='--stale-ms'||
  args[9]!=='--trial-chat'||!args[2]||!args[4]||!args[6]||
  !/^[1-9][0-9]{4,9}$/u.test(args[8]??'')||
  !/^-[1-9][0-9]{0,15}$/u.test(args[10]??'')||
  !Number.isSafeInteger(Number(args[10]))){
  process.stderr.write('MANARATAK_MODERATION_TRIAL_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 const staleAfterMs=Number(args[8]);
 if(!Number.isSafeInteger(staleAfterMs)||staleAfterMs<60_000||
    staleAfterMs>30*24*60*60_000){
  process.stderr.write('MANARATAK_MODERATION_TRIAL_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 try{
  const report=await inspectOfflineModerationTrialScope({
   stateFile:args[2]!,backupFile:args[4]!,safetyFile:args[6]!,
   now:Date.now(),staleAfterMs,trialChatId:args[10]!
  });
  process.stdout.write(JSON.stringify(report)+'\n');
  process.exitCode=report.status==='PASS'?0:2;
 }catch(err){
  const code=err instanceof Error?err.message:'';
  const reason=code==='TRIAL_ACCEPTANCE_INVALID_BACKUP'?'BACKUP':
   code==='TRIAL_ACCEPTANCE_INVALID_STATE'?'STATE':
   code==='TRIAL_ACCEPTANCE_INVALID_SAFETY'?'SAFETY':
   code==='MODERATION_TRIAL_STATE_CHANGED'||
    code==='TRIAL_ACCEPTANCE_STATE_CHANGED'?'STATE_CHANGED':'REQUEST';
  // Never log input paths, the group ID, a member ID or provider content.
  process.stderr.write('MANARATAK_MODERATION_TRIAL_INVALID_'+reason+'\n');
  process.exitCode=1;
 }
})();
