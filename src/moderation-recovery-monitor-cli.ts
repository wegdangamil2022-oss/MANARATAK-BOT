import {inspectModerationRecoveryReadOnly} from './moderation-recovery-monitor.js';

/** One-shot local/operator-only aggregate. No owner impersonation,
 * Telegram credentials, network access, state writes, retries or cleanup.
 * Status 2 requires human attention; it does not authorize any sanction.
 */
const args=process.argv.slice(2);
void (async()=>{
 if(args.length!==5||args[0]!=='--once'||args[1]!=='--state'||
  args[3]!=='--stale-ms'||!args[2]||
  !/^[1-9][0-9]{4,10}$/u.test(args[4]??'')){
  process.stderr.write('MANARATAK_MODERATION_RECOVERY_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 const staleAfterMs=Number(args[4]);
 if(!Number.isSafeInteger(staleAfterMs)||staleAfterMs<60_000||
    staleAfterMs>30*24*3600_000){
  process.stderr.write('MANARATAK_MODERATION_RECOVERY_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 try{
  const report=await inspectModerationRecoveryReadOnly(args[2]!,{
   now:Date.now(),staleAfterMs
  });
  process.stdout.write(JSON.stringify(report)+'\n');
  process.exitCode=report.state==='ATTENTION_REQUIRED'?2:0;
 }catch{
  // Never print paths, exception details, secrets or database payloads.
  process.stderr.write('MANARATAK_MODERATION_RECOVERY_INVALID_STATE\n');
  process.exitCode=1;
 }
})();
