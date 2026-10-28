import {inspectIsolatedModerationTargetReadOnly} from './moderation-trial-target.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

/** One-shot, explicitly selected READ-ONLY operator trial. The token is
 * accepted ONLY from the process environment, never a command-line arg.
 * Every provider request is getChatMember. No Telegram mutations, no writes
 * to SQLite or the STOP flag, no automatic trial authorization.
 */
const args=process.argv.slice(2);
void (async()=>{
 const validChat=(value:string|undefined)=>
  typeof value==='string'&&/^-[1-9][0-9]{0,15}$/u.test(value)&&
  Number.isSafeInteger(Number(value));
 const validMember=(value:string|undefined)=>
  typeof value==='string'&&/^[1-9][0-9]{0,15}$/u.test(value)&&
  Number.isSafeInteger(Number(value));
 if(args.length!==13||args[0]!=='--offline-only'||
   args[1]!=='--state'||args[3]!=='--backup'||
   args[5]!=='--safety'||args[7]!=='--stale-ms'||
   args[9]!=='--trial-chat'||args[11]!=='--trial-target'||
   !args[2]||!args[4]||!args[6]||
   !/^[1-9][0-9]{4,9}$/u.test(args[8]??'')||
   !validChat(args[10])||!validMember(args[12])||
   !process.env.TELEGRAM_BOT_TOKEN||!validMember(process.env.BOT_OWNER_ID)){
  process.stderr.write('MANARATAK_MODERATION_TARGET_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 const staleAfterMs=Number(args[8]);
 if(!Number.isSafeInteger(staleAfterMs)||staleAfterMs<60_000||
    staleAfterMs>30*24*60*60_000){
  process.stderr.write('MANARATAK_MODERATION_TARGET_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 try{
  // Constructor validates token format and bot identity. No network call
  // precedes the existing STOP/isolated-group/offline backup preflight.
  const gateway=new TelegramBotApiModerationGateway(process.env.TELEGRAM_BOT_TOKEN);
  const report=await inspectIsolatedModerationTargetReadOnly({
   stateFile:args[2]!,backupFile:args[4]!,safetyFile:args[6]!,
   now:Date.now(),staleAfterMs,trialChatId:args[10]!
  },args[12]!,gateway,process.env.BOT_OWNER_ID!);
  process.stdout.write(JSON.stringify(report)+'\n');
  process.exitCode=report.status==='PASS'?0:2;
 }catch{
  // Fail with one static error without exposing token, paths, chat/member
  // IDs, network error messages, or provider response bodies.
  process.stderr.write('MANARATAK_MODERATION_TARGET_CHECK_FAILED\n');
  process.exitCode=1;
 }
})();
