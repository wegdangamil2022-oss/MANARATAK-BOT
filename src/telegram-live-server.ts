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
import {TelegramBotApiMembershipGateway} from './telegram-membership.js';
import {SubscriptionGate} from './subscription.js';
import {ModerationService,FakeModerationGateway} from './moderation.js';

export interface LiveTelegramConfig{
 ownerId:string;botId:string;botUsername:string;stateFile:string;
 token:string;webhookSecret:string;listenPort:number;publicWebhookUrl:string;
}
/** An advisory URL syntax and topology gate, NOT DNS/TLS or proxy verification.
 * Reject deceptive/non-HTTPS local endpoints and alternate routing before the
 * live runtime is even constructed. Does not make HTTP or DNS requests.
 */
function validPublicTelegramWebhookUrl(raw:unknown):raw is string{
 if(typeof raw!=='string'||raw.length<20||raw.length>512||
  /[\s\u0000-\u001f\u007f]/u.test(raw))return false;
 try{
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username!==''||u.password!==''||
    u.port!==''||u.search!==''||u.hash!==''||
    u.pathname!=='/telegram/webhook'||u.href!==raw)return false;
  const host=u.hostname;
  // DNS name only: IP-literal hosts, trailing dots, intranet aliases,
  // reserved testing/private TLDs and single-label hosts are not acceptable.
  if(host.length>253||host.endsWith('.')||host.includes(':'))return false;
  const labels=host.split('.');
  if(labels.length<2||labels.some(label=>label.length<1||label.length>63||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))return false;
  const tld=labels.at(-1)!;
  if(!/^[a-z]{2,24}$/.test(tld)||
    new Set(['local','localhost','localdomain','internal','test','invalid','example',
      'onion','lan','home','arpa']).has(tld))return false;
  return true;
 }catch{return false;}
}
const validOwner=(owner:unknown):owner is string=>
 typeof owner==='string'&&/^[1-9]\d{0,15}$/.test(owner)&&
 Number.isSafeInteger(Number(owner));

/** Explicit opt-in only. No token default, no secret file read, no auto bootstrap,
 * no automatic group authorization or subscription bypass.
 */
export function loadLiveTelegramConfig(env:Readonly<Record<string,string|undefined>>):LiveTelegramConfig{
 const ownerId=env.BOT_OWNER_ID,botId=env.BOT_ID,botUsername=env.BOT_USERNAME;
 const stateFile=env.BOT_STATE_FILE,token=env.TELEGRAM_BOT_TOKEN;
 const webhookSecret=env.TELEGRAM_WEBHOOK_SECRET,port=Number(env.TELEGRAM_LISTEN_PORT);
 const publicWebhookUrl=env.TELEGRAM_WEBHOOK_PUBLIC_URL;
 if(env.BOT_ENV!=='production'||env.TELEGRAM_ENABLED!=='true'||
    env.TELEGRAM_REPLY_DELIVERY_ENABLED!=='true'||
    !validOwner(ownerId)||
    !botId||!/^[A-Za-z0-9_-]{1,80}$/.test(botId)||
    !botUsername||!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(botUsername)||
    !stateFile||!isAbsolute(stateFile)||stateFile!==resolve(stateFile)||
    /[\u0000-\u001f\u007f]/u.test(stateFile)||
    !token||!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/.test(token)||
    !webhookSecret||!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)||
    !env.TELEGRAM_LISTEN_PORT||!/^[0-9]{4,5}$/.test(env.TELEGRAM_LISTEN_PORT)||
    !Number.isSafeInteger(port)||port<1024||port>65535||
    !validPublicTelegramWebhookUrl(publicWebhookUrl))
   throw new Error('LIVE_TELEGRAM_CONFIG_INVALID');
 return {ownerId,botId,botUsername,stateFile,token,webhookSecret,listenPort:port,publicWebhookUrl};
}
/** Independently checks a pre-existing local state; never initializes databases.
 * Common verification for both the read-only preflight command and real runtime.
 */
async function assertPrivateStateReady(file:string):Promise<void>{
 try{
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||
     await realpath(file)!==file||
     !(await BotStore.verifySqliteBackupReadOnly(file)))
    throw new Error('LIVE_TELEGRAM_STATE_INVALID');
 }catch{throw new Error('LIVE_TELEGRAM_STATE_INVALID');}
}
/** Offline readiness report: no state creation, HTTP listener, bot request,
 * secret echo or implied remote HTTPS/TLS verification.
 */
export async function preflightLiveTelegram(
 env:Readonly<Record<string,string|undefined>>):Promise<{
 readonly ready:true;readonly httpsWebhook:true;readonly privateSqlite:true;
 readonly listener:'LOOPBACK_ONLY';readonly telegramNetworkCalls:0;
}>{
 const config=loadLiveTelegramConfig(env);
 await assertPrivateStateReady(config.stateFile);
 return {ready:true,httpsWebhook:true,privateSqlite:true,
  listener:'LOOPBACK_ONLY',telegramNetworkCalls:0};
}
/** Builds (does not start) a real local HTTP listener, suitable for a trusted
 * HTTPS reverse proxy that preserves Telegram's webhook secret header.
 * No runtime is created if the persistent SQLite state is missing/untrusted.
 */
export async function createLiveTelegramServer(config:LiveTelegramConfig,
 request:typeof fetch=fetch):Promise<Server>{
 // Reject stale/malformed or manually constructed configuration as well.
 const check=loadLiveTelegramConfig({
  BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
  BOT_OWNER_ID:config.ownerId,BOT_ID:config.botId,BOT_USERNAME:config.botUsername,
  BOT_STATE_FILE:config.stateFile,TELEGRAM_BOT_TOKEN:config.token,
  TELEGRAM_WEBHOOK_SECRET:config.webhookSecret,TELEGRAM_LISTEN_PORT:String(config.listenPort),
  TELEGRAM_WEBHOOK_PUBLIC_URL:config.publicWebhookUrl
 });
 await assertPrivateStateReady(check.stateFile);
 const store=new BotStore(check.stateFile,{engine:'sqlite'});
 const policy=new Policy(store,check.ownerId),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 // Telegram membership is an external privileged read: require the bot to be
 // admin in the requested approved group before consulting a student's status.
 const membership=new TelegramBotApiMembershipGateway(check.token,request);
 // SubscriptionGate.verify uses only read-only membership checks. The existing
 // moderation gateway stays mock-only: no live ban/mute is activated here.
 const subscription=new SubscriptionGate(store,policy,membership,
  new ModerationService(store,policy,new FakeModerationGateway()));
 const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:check.botId,botUsername:check.botUsername,
  membership:(chatId,actorId)=>membership.verifyMembership(chatId,actorId),subscription});
 const dispatcher=new TelegramReplyDispatcher(store,policy,
  new TelegramBotApiTextSender(check.token,request));
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
