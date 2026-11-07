import {GroupProtectionPolicyService} from './group-protection-policy.js';
import {Phase4CommunityService} from './phase4-community.js';
import {Phase4WhisperService} from './phase4-whispers.js';
import {Phase4WhisperAnnouncementDispatcher,
 TelegramBotApiWhisperAnnouncementGateway} from './phase4-whisper-publication.js';
import {startPhase4WhisperPrivacyMaintenance} from './phase4-whisper-maintenance.js';
import {Phase4DiscussionService} from './phase4-discussions.js';
import {startPhase4DiscussionPrivacyMaintenance} from './phase4-discussion-maintenance.js';
import {Phase4PollService} from './phase4-polls.js';
import {startPhase4PollPrivacyMaintenance} from './phase4-poll-maintenance.js';
import {Phase4EventService} from './phase4-events.js';
import {startPhase4EventPrivacyMaintenance} from './phase4-event-maintenance.js';
import {Phase4ExpertService} from './phase4-experts.js';
import {startPhase4ExpertPrivacyMaintenance} from './phase4-expert-maintenance.js';
import {Phase4StudyPeersService} from './phase4-study-peers.js';
import {startPhase4StudyPeerMaintenance} from './phase4-study-peer-maintenance.js';
import {Phase4BadgesService} from './phase4-badges.js';
import {startPhase4BadgeMaintenance} from './phase4-badge-maintenance.js';
import {Phase4ReactionsService} from './phase4-reactions.js';
import {startPhase4ReactionMaintenance} from './phase4-reaction-maintenance.js';
import {Phase4LectureService} from './phase4-lectures.js';
import {startPhase4LectureMaintenance} from './phase4-lecture-maintenance.js';
import {Phase4QuizService} from './phase4-quizzes.js';
import {startPhase4QuizMaintenance} from './phase4-quiz-maintenance.js';
import {Phase4ContestService} from './phase4-contests.js';
import {startPhase4ContestMaintenance} from './phase4-contest-maintenance.js';
import {Phase4ServiceCleanupDispatcher,TelegramBotApiServiceCleanupGateway} from './phase4-service-cleanup.js';
import {Phase4GroupProfileDispatcher,TelegramBotApiGroupProfileGateway} from './phase4-group-profile.js';
import {Phase4GuidePublicationDispatcher,TelegramBotApiGuidePostGateway} from './phase4-guide-publication.js';
import {Phase4FixedPublicationDispatcher,TelegramBotApiFixedGateway} from './phase4-fixed-dispatcher.js';
import {startProtectionMaintenance} from './protection-maintenance.js';
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
import {TelegramReplyDispatcher,TelegramBotApiTextSender,TelegramBotApiCallbackAcker} from './telegram-replies.js';
import {TelegramBotApiMembershipGateway} from './telegram-membership.js';
import {TelegramBotApiDocumentDownloader} from './telegram-document-download.js';
import {SubscriptionGate} from './subscription.js';
import {ModerationService,FakeModerationGateway} from './moderation.js';
import {readTelegramSafetySwitch,createTelegramSafetyGate} from './telegram-safety-switch.js';

export interface LiveTelegramConfig{
 ownerId:string;botId:string;botUsername:string;stateFile:string;
 token:string;webhookSecret:string;listenPort:number;publicWebhookUrl:string;safetySwitchFile:string;
 /** High-impact group-profile writes require a second, explicit env opt-in. */
 profileEditsEnabled?:boolean;
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
 const safetySwitchFile=env.TELEGRAM_SAFETY_FILE;
 if(env.BOT_ENV!=='production'||env.TELEGRAM_ENABLED!=='true'||
    (env.TELEGRAM_GROUP_PROFILE_EDITS_ENABLED!==undefined&&
     !['true','false'].includes(env.TELEGRAM_GROUP_PROFILE_EDITS_ENABLED))||
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
    !validPublicTelegramWebhookUrl(publicWebhookUrl)||
    !safetySwitchFile||!isAbsolute(safetySwitchFile)||
    safetySwitchFile!==resolve(safetySwitchFile)||
    /[\u0000-\u001f\u007f]/u.test(safetySwitchFile)||
    safetySwitchFile===stateFile)
   throw new Error('LIVE_TELEGRAM_CONFIG_INVALID');
 return {ownerId,botId,botUsername,stateFile,token,webhookSecret,listenPort:port,publicWebhookUrl,safetySwitchFile,
  ...(env.TELEGRAM_GROUP_PROFILE_EDITS_ENABLED==='true'?{profileEditsEnabled:true}:{})};
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
 readonly safetySwitch:'RUN'|'STOP';
}>{
 const config=loadLiveTelegramConfig(env);
 await assertPrivateStateReady(config.stateFile);
 const safetySwitch=await readTelegramSafetySwitch(config.safetySwitchFile);
 return {ready:true,httpsWebhook:true,privateSqlite:true,
  listener:'LOOPBACK_ONLY',telegramNetworkCalls:0,safetySwitch};
}
/** Drain all existing accepted requests before stopping. Timeout is a status,
 * not authorization to abort a possibly committed Telegram send. A DRAINING
 * return means the server is still closing in the same process.
 */
const protectionMaintenanceStops=new WeakMap<Server,()=>Promise<void>>();
const drainPromises=new WeakMap<Server,Promise<void>>();
export async function stopLiveTelegramServer(server:Server,graceMs=15_000):
 Promise<'STOPPED'|'DRAINING'>{
 if(!Number.isSafeInteger(graceMs)||graceMs<100||graceMs>60_000)
  throw Error('INVALID_DRAIN_TIMEOUT');
 let drained=drainPromises.get(server);
 if(!drained){
  if(!server.listening&&!protectionMaintenanceStops.has(server))return 'STOPPED';
  drained=!server.listening?protectionMaintenanceStops.get(server)!():new Promise<void>((resolve,reject)=>{
   // Closing idle connections once is insufficient when a pending request
   // completes later and its keep-alive socket becomes idle after that call.
   // Repeat idle-only closing during the drain, never close active requests.
   const reapIdle=setInterval(()=>server.closeIdleConnections(),250);
   reapIdle.unref();
   server.close(error=>{
    clearInterval(reapIdle);
    if(error)reject(Error('LIVE_TELEGRAM_DRAIN_FAILED'));
    else void (protectionMaintenanceStops.get(server)?.()??Promise.resolve()).then(resolve,()=>reject(Error('LIVE_TELEGRAM_DRAIN_FAILED')));
   });
   server.closeIdleConnections();
  });
  drainPromises.set(server,drained);
 }
 let timeout:ReturnType<typeof setTimeout>|undefined;
 try{
  const done=await Promise.race([drained.then(()=>true),
   new Promise<false>(resolve=>{timeout=setTimeout(()=>resolve(false),graceMs);})]);
  return done?'STOPPED':'DRAINING';
 }finally{if(timeout!==undefined)clearTimeout(timeout);}
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
  TELEGRAM_WEBHOOK_PUBLIC_URL:config.publicWebhookUrl,
  TELEGRAM_SAFETY_FILE:config.safetySwitchFile,
  TELEGRAM_GROUP_PROFILE_EDITS_ENABLED:config.profileEditsEnabled===true?'true':'false'
 });
 await assertPrivateStateReady(check.stateFile);
 // Both RUN and STOP are valid *protected* states; STOP starts only the local
 // listener but all authenticated inbound/update and outbound attempts are paused.
 await readTelegramSafetySwitch(check.safetySwitchFile);
 const safetyGate=createTelegramSafetyGate(check.safetySwitchFile);
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
  membership:(chatId,actorId)=>membership.verifyMembership(chatId,actorId),
  adminMembership:(chatId,actorId)=>membership.verifyAdminMembership(chatId,actorId),subscription,
  documentDownload:new TelegramBotApiDocumentDownloader(check.token,request,safetyGate),
  moderationSafetyFile:check.safetySwitchFile,ownerMenuMode:'inline',studentMenuMode:'inline',
  community:new Phase4CommunityService(store,policy)});
 const dispatcher=new TelegramReplyDispatcher(store,policy,
  new TelegramBotApiTextSender(check.token,request),Date.now,safetyGate,subscription,
  (chatId,actorId)=>membership.verifyMembership(chatId,actorId),
  (chatId,actorId)=>membership.verifyAdminMembership(chatId,actorId));
 const server=createServer(telegramWebhookListener(app,check.webhookSecret,dispatcher,{},safetyGate,
  new TelegramBotApiCallbackAcker(check.token,request)));
 server.once('listening',()=>{
  // This privacy timer is independent of protection/Telegram cleanup.
  // Expired private content is scrubbed without opening an owner menu.
  const whisperPrivacy=startPhase4WhisperPrivacyMaintenance(
   new Phase4WhisperService(store,policy),undefined,
   ()=>process.stderr.write('WHISPER_PRIVACY_MAINTENANCE_FAILED\n'));
  const discussionPrivacy=startPhase4DiscussionPrivacyMaintenance(
   new Phase4DiscussionService(store,policy),undefined,
   ()=>process.stderr.write('DISCUSSION_PRIVACY_MAINTENANCE_FAILED\n'));
  const pollPrivacy=startPhase4PollPrivacyMaintenance(
   new Phase4PollService(store,policy),undefined,
   ()=>process.stderr.write('POLL_PRIVACY_MAINTENANCE_FAILED\n'));
  const eventPrivacy=startPhase4EventPrivacyMaintenance(
   new Phase4EventService(store,policy),undefined,
   ()=>process.stderr.write('EVENT_PRIVACY_MAINTENANCE_FAILED\n'));
  const expertPrivacy=startPhase4ExpertPrivacyMaintenance(
   new Phase4ExpertService(store,policy),undefined,
   ()=>process.stderr.write('EXPERT_PRIVACY_MAINTENANCE_FAILED\n'));
  const studyPrivacy=startPhase4StudyPeerMaintenance(
   new Phase4StudyPeersService(store,policy),undefined,
   ()=>process.stderr.write('STUDY_PRIVACY_MAINTENANCE_FAILED\n'));
  const badgePrivacy=startPhase4BadgeMaintenance(
   new Phase4BadgesService(store,policy),undefined,
   ()=>process.stderr.write('BADGE_PRIVACY_MAINTENANCE_FAILED\n'));
  const reactionPrivacy=startPhase4ReactionMaintenance(
   new Phase4ReactionsService(store,policy),undefined,
   ()=>process.stderr.write('REACTION_PRIVACY_MAINTENANCE_FAILED\n'));
  const lecturePrivacy=startPhase4LectureMaintenance(
   new Phase4LectureService(store,policy),undefined,
   ()=>process.stderr.write('LECTURE_MAINTENANCE_FAILED\n'));
  const quizPrivacy=startPhase4QuizMaintenance(
   new Phase4QuizService(store,policy),undefined,
   ()=>process.stderr.write('QUIZ_PRIVACY_MAINTENANCE_FAILED\n'));
  const contestPrivacy=startPhase4ContestMaintenance(
   new Phase4ContestService(store,policy),undefined,
   ()=>process.stderr.write('CONTEST_PRIVACY_MAINTENANCE_FAILED\n'));
  const protection=new GroupProtectionPolicyService(store,policy);
  const serviceCleaner=new Phase4ServiceCleanupDispatcher(store,policy,
   new TelegramBotApiServiceCleanupGateway(check.token,request),Date.now,safetyGate);
  // 09:02 is one-shot, only after a separate owner preview and approval.
  // Disabled by default because the group has no approved jobs until then.
  const whisperPublisher=new Phase4WhisperAnnouncementDispatcher(store,policy,
   new TelegramBotApiWhisperAnnouncementGateway(check.token,check.botUsername,request),
   Date.now,safetyGate);
  const guidePublisher=new Phase4GuidePublicationDispatcher(store,policy,
   new TelegramBotApiGuidePostGateway(check.token,request),Date.now,safetyGate);
  // 09:03: no Telegram publication/pinning without independent owner approval.
  // Both operations are durable, sequential and use separate permission checks.
  const fixedPublisher=new Phase4FixedPublicationDispatcher(store,policy,
   new TelegramBotApiFixedGateway(check.token,request),Date.now,safetyGate);
  const profileEditor=check.profileEditsEnabled===true?
   new Phase4GroupProfileDispatcher(store,policy,
    new TelegramBotApiGroupProfileGateway(check.token,request),Date.now,safetyGate):null;
  const cleanup=startProtectionMaintenance(async()=>{
   const result=await protection.cleanupFloodWindows();
   if(result.status==='CLOCK_UNTRUSTED')throw Error('PROTECTION_CLOCK_UNTRUSTED');
   // Explicitly enabled group service deletions only; no retries of unknown API outcomes.
   await serviceCleaner.runDue(4);
   await guidePublisher.runDue(2);
   await whisperPublisher.runDue(2);
   await fixedPublisher.runDue(2);
   // Do not create this dispatcher without explicit runtime opt-in.
   // Every individual job still requires owner approval and current bot rights.
   if(profileEditor)await profileEditor.runDue(2);
  },undefined,()=>process.stderr.write('PROTECTION_OR_SERVICE_MAINTENANCE_FAILED\n'));
  protectionMaintenanceStops.set(server,async()=>{
   await Promise.all([whisperPrivacy.stop(),discussionPrivacy.stop(),pollPrivacy.stop(),eventPrivacy.stop(),expertPrivacy.stop(),studyPrivacy.stop(),badgePrivacy.stop(),reactionPrivacy.stop(),lecturePrivacy.stop(),quizPrivacy.stop(),contestPrivacy.stop(),cleanup.stop()]);
  });
  server.once('close',()=>{void protectionMaintenanceStops.get(server)?.();});
 });
 // Local-only listener. These are resource budgets, not a substitute for the
 // trusted HTTPS proxy, ingress anti-abuse controls, TLS or real load testing.
 server.requestTimeout=15_000;
 server.headersTimeout=10_000;
 server.timeout=15_000;
 server.keepAliveTimeout=2_000;
 server.maxHeadersCount=32;
 server.maxRequestsPerSocket=50;
 server.maxConnections=128;
 return server;
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
  let stopping=false;
  const beginDrain=()=>{
   if(stopping)return;
   stopping=true;
   process.stdout.write('MANARATAK_TELEGRAM_DRAINING\n');
   void stopLiveTelegramServer(server).then(status=>{
    if(status==='STOPPED')process.stdout.write('MANARATAK_TELEGRAM_STOPPED\n');
    else{
     // Do not force-close an in-flight Telegram send or claim a safe stop.
     process.stderr.write('LIVE_TELEGRAM_DRAIN_PENDING\n');
     process.exitCode=1;
    }
   }).catch(()=>{process.stderr.write('LIVE_TELEGRAM_DRAIN_FAILED\n');process.exitCode=1;});
  };
  process.once('SIGTERM',beginDrain);
  process.once('SIGINT',beginDrain);
 })().catch(()=>{process.stderr.write('LIVE_TELEGRAM_START_FAILED\n');process.exitCode=1;});
}
