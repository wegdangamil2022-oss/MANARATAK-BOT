import {inspectIsolatedModerationGroupReadOnly} from './moderation-trial-group.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

// One-shot operator-only inspection. All network reads are getChatMember and
// getChat; no real moderation, state changes or safety switch changes.
// Secrets are supplied solely by environment and never printed.
const args=process.argv.slice(2);
void (async()=>{
 const chatId=args[10];
 if(args.length!==11||args[0]!=='--offline-only'||
   args[1]!=='--state'||args[3]!=='--backup'||
   args[5]!=='--safety'||args[7]!=='--stale-ms'||
   args[9]!=='--trial-chat'||!args[2]||!args[4]||!args[6]||
   !/^[1-9][0-9]{4,9}$/u.test(args[8]??'')||
   typeof chatId!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(chatId)||
   !Number.isSafeInteger(Number(chatId))||
   !process.env.TELEGRAM_BOT_TOKEN){
  process.stderr.write('MANARATAK_MODERATION_GROUP_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 const staleAfterMs=Number(args[8]);
 if(!Number.isSafeInteger(staleAfterMs)||staleAfterMs<60_000||
    staleAfterMs>30*24*60*60_000){
  process.stderr.write('MANARATAK_MODERATION_GROUP_INVALID_REQUEST\n');
  process.exitCode=1;return;
 }
 try{
  const gateway=new TelegramBotApiModerationGateway(process.env.TELEGRAM_BOT_TOKEN);
  const report=await inspectIsolatedModerationGroupReadOnly({
   stateFile:args[2]!,backupFile:args[4]!,safetyFile:args[6]!,
   staleAfterMs,trialChatId:chatId,now:Date.now()
  },gateway);
  process.stdout.write(JSON.stringify(report)+'\n');
  process.exitCode=report.status==='PASS'?0:2;
 }catch{
  // No paths, chat IDs, token, or remote Telegram error messages in stderr.
  process.stderr.write('MANARATAK_MODERATION_GROUP_CHECK_FAILED\n');
  process.exitCode=1;
 }
})();
