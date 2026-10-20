import {inspectTelegramOutboxReadOnly} from './telegram-outbox-monitor.js';

// Explicit local, one-shot monitoring only. No token, network request, state
// mutation, auto-review, deletion, or Telegram message retransmission.
const args=process.argv.slice(2);
void (async()=>{
 if(args.length!==5||args[0]!=='--once'||args[1]!=='--state'||
   args[3]!=='--stale-ms'||!args[2]||!args[4]||
   !/^[1-9]\d{4,9}$/.test(args[4])){
  process.stderr.write('MANARATAK_OUTBOX_INVALID_REQUEST\n');
  process.exitCode=1;
  return;
 }
 const staleAfterMs=Number(args[4]);
 if(!Number.isSafeInteger(staleAfterMs)||staleAfterMs<60_000||
   staleAfterMs>30*24*3600_000){
  process.stderr.write('MANARATAK_OUTBOX_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 try{
  const status=await inspectTelegramOutboxReadOnly(args[2],{now:Date.now(),staleAfterMs});
  process.stdout.write(JSON.stringify(status)+'\n');
  if(status.state==='ATTENTION_REQUIRED')process.exitCode=2;
 }catch{
  // Do not serialize exceptions containing file paths or database content.
  process.stderr.write('MANARATAK_OUTBOX_INVALID_STATE\n');
  process.exitCode=1;
 }
})();
