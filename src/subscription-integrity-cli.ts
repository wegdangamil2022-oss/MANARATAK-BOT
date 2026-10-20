import {inspectSubscriptionIntegrityReadOnly} from './subscription-integrity.js';

/** One-shot local health query; never activates Telegram, calls providers,
 * modifies requirements or triggers a moderation transition.
 */
const args=process.argv.slice(2);
void (async()=>{
 if(args.length!==3||args[0]!=='--offline-only'||args[1]!=='--state'||!args[2]){
  process.stderr.write('MANARATAK_SUBSCRIPTION_AUDIT_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 try{
  const report=await inspectSubscriptionIntegrityReadOnly(args[2]);
  process.stdout.write(JSON.stringify(report)+'\n');
  if(report.status==='BLOCKED')process.exitCode=2;
 }catch{
  process.stderr.write('MANARATAK_SUBSCRIPTION_AUDIT_INVALID_STATE\n');
  process.exitCode=1;
 }
})();
