import {createServer,type Server} from 'node:http';
import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {EducationService} from './education.js';
import {EducationAdminFacade} from './education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from './education-interactions.js';
import {TelegramUpdateApplication,telegramWebhookListener} from './telegram-transport.js';
import {TelegramReplyDispatcher,TelegramBotApiTextSender} from './telegram-replies.js';

export interface LiveTelegramConfig{
 ownerId:string;botId:string;botUsername:string;stateFile:string;
 token:string;webhookSecret:string;listenPort:number;
}
/** Explicit opt-in only. No token default, no secret file read, no auto bootstrap,
 * no automatic group authorization or subscription bypass.
 */
export function loadLiveTelegramConfig(env:Readonly<Record<string,string|undefined>>):LiveTelegramConfig{
 const ownerId=env.BOT_OWNER_ID,botId=env.BOT_ID,botUsername=env.BOT_USERNAME;
 const stateFile=env.BOT_STATE_FILE,token=env.TELEGRAM_BOT_TOKEN;
 const webhookSecret=env.TELEGRAM_WEBHOOK_SECRET,port=Number(env.TELEGRAM_LISTEN_PORT);
 if(env.BOT_ENV!=='production'||env.TELEGRAM_ENABLED!=='true'||
    env.TELEGRAM_REPLY_DELIVERY_ENABLED!=='true'||
    !ownerId||!/^\d+$/.test(ownerId)||ownerId==='0'||
    !botId||!/^[A-Za-z0-9_-]{1,80}$/.test(botId)||
    !botUsername||!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(botUsername)||
    !stateFile||!isAbsolute(stateFile)||stateFile!==resolve(stateFile)||
    /[\u0000-\u001f\u007f]/u.test(stateFile)||
    !token||!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/.test(token)||
    !webhookSecret||!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)||
    !env.TELEGRAM_LISTEN_PORT||!/^[0-9]{4,5}$/.test(env.TELEGRAM_LISTEN_PORT)||
    !Number.isSafeInteger(port)||port<1024||port>65535)
   throw new Error('LIVE_TELEGRAM_CONFIG_INVALID');
 return {ownerId,botId,botUsername,stateFile,token,webhookSecret,listenPort:port};
}
/** Builds (does not start) a real local HTTP listener, suitable for a trusted
 * HTTPS reverse proxy that preserves Telegram's webhook secret header.
 * No runtime is created if the persistent SQLite state is missing/untrusted.
 */
export async function createLiveTelegramServer(config:LiveTelegramConfig):Promise<Server>{
 // Reject stale/malformed or manually constructed configuration as well.
 const check=loadLiveTelegramConfig({
  BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
  BOT_OWNER_ID:config.ownerId,BOT_ID:config.botId,BOT_USERNAME:config.botUsername,
  BOT_STATE_FILE:config.stateFile,TELEGRAM_BOT_TOKEN:config.token,
  TELEGRAM_WEBHOOK_SECRET:config.webhookSecret,TELEGRAM_LISTEN_PORT:String(config.listenPort)
 });
 try{
  const info=await lstat(check.stateFile);
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||
     await realpath(check.stateFile)!==check.stateFile||
     !(await BotStore.verifySqliteBackupReadOnly(check.stateFile)))
    throw new Error('LIVE_TELEGRAM_STATE_INVALID');
 }catch{throw new Error('LIVE_TELEGRAM_STATE_INVALID');}
 const store=new BotStore(check.stateFile,{engine:'sqlite'});
 const policy=new Policy(store,check.ownerId),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 // Fail closed: private access to *group-scoped* material is disabled until
 // a trusted live Telegram getChatMember provider is wired in and tested.
 const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:check.botId,botUsername:check.botUsername,membership:async()=> 'UNKNOWN' as const});
 const dispatcher=new TelegramReplyDispatcher(store,policy,new TelegramBotApiTextSender(check.token));
 return createServer(telegramWebhookListener(app,check.webhookSecret,dispatcher));
}
const direct=process.argv[1]!==undefined&&fileURLToPath(import.meta.url)===resolve(process.argv[1]);
if(direct){
 (async()=>{
  const config=loadLiveTelegramConfig(process.env);
  const server=await createLiveTelegramServer(config);
  server.listen(config.listenPort,'127.0.0.1',()=>{
   // Never log token, owner ID, webhook path secret or database pathname.
   process.stdout.write('MANARATAK_TELEGRAM_LOCAL_LISTENER_READY\n');
  });
  server.on('error',()=>{process.stderr.write('LIVE_TELEGRAM_LISTENER_FAILED\n');process.exitCode=1;});
 })().catch(()=>{process.stderr.write('LIVE_TELEGRAM_START_FAILED\n');process.exitCode=1;});
}
