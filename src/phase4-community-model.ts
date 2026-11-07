import {validCommunityPhotoId,validCommunityLinkButtons,type CommunityLinkButton} from './phase4-community-rich.js';
/** Phase 4 community interaction model.
 * Telegram identity and group approval must come from the authenticated transport,
 * never from a student-supplied message or a callback parameter.
 */
export type CommunityEventKind='JOIN'|'LEAVE'|'TEXT';
/** Classified only from verified Telegram service messages; not user-supplied text. */
export type CommunityJoinKind='SELF'|'ADDED'|'BATCH'|'INVITE';
/** Exit source derived only from a trusted Telegram membership or service event. */
export type CommunityLeaveKind='SELF'|'REMOVED';
export type CommunityServiceKind='JOIN'|'LEAVE'|'TITLE_CHANGED'|'PHOTO_CHANGED'|'PHOTO_REMOVED';
export type ReplyMatch='EXACT'|'WORD'|'CONTAINS'|'COMMAND';
/** A rule may reference only an owner-approved fixed note, a reviewed group
 * rules URL, or an already published FAQ with an approved source. Missing
 * source is a legacy, owner-reviewed fixed reply. */
export type CommunityReplySource='NOTE'|'RULES'|'FAQ';
export const validCommunityFAQId=(value:unknown):value is string=>
 typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
export type CommunityLanguage='ar'|'en';
export type CommunityClockFormat='12'|'24';
export type CommunityCalendar='gregorian'|'hijri';
export interface CommunityReplyRule{
 id:string;trigger:string;response:string;match:ReplyMatch;
 enabled:boolean;cooldownMs:number;topicId?:number;
 source?:CommunityReplySource;sourceFaqId?:string;
}
export interface CommunityGreeting{
 enabled:boolean;text:string;
 /** Group language is owner-selected. Telegram service join updates do not
  * reliably contain the joining user's language. */
 localized?:Partial<Record<CommunityLanguage,string>>;
 /** Telegram file_id saved by owner approval; never an image URL. */
 photoFileId?:string;
 /** External HTTPS links only, no callback handlers or hidden actor IDs. */
 buttons?:CommunityLinkButton[];
}
export interface CommunityQuietHours { startMinute:number;endMinute:number; }
export interface CommunityTopicCooldown { topicId:number;cooldownMs:number; }
export interface CommunityConfig{
 chatId:string;version:number;welcome:CommunityGreeting;farewell:CommunityGreeting;
 /** Optional templates per trusted join source; fallback to localized welcome. */
 welcomeByJoin?:Partial<Record<CommunityJoinKind,string>>;
 /** Disabled by default: use Telegram User.language_code only when confidently ar/en. */
 welcomeMemberLanguageEnabled?:boolean;
 /** Optional farewell variants; never inferred from students' text. */
 farewellByLeave?:Partial<Record<CommunityLeaveKind,string>>;
 /** Removal/ban notices are off by default to avoid unwanted disclosures. */
 farewellOnRemoval?:boolean;
 /** User-initiated private welcome only, never an unsolicited Telegram DM. */
 privateWelcomeEnabled?:boolean;
 repliesEnabled:boolean;rules:CommunityReplyRule[];
 /** Minutes from UTC. Display-only, never a claim about a real Telegram time zone. */
 utcOffsetMinutes:number;
 /** Optional canonical IANA time zone, with automatic DST offset at event time. */
 timeZone?:string;
 /** A group-wide minimum gap between any two automatic group replies. */
 groupCooldownMs:number;
 /** Group-wide rolling 60-second cap, 1 to 8. Missing on old snapshots means 8. */
 autoMessagesPerMinute?:number;
 /** Absent means no scheduled quiet period; configured local clock offset applies. */
 quietHours?:CommunityQuietHours;
 /** Topic-local reply gaps override the group gap only for those topics. */
 topicCooldowns?:CommunityTopicCooldown[];
 /** Optional for backward compatibility with pre-localization snapshots. */
 language?:CommunityLanguage;
 clockFormat?:CommunityClockFormat;
 calendar?:CommunityCalendar;
 /** Group-specific approved guide paragraphs; independent of welcome automation. */
 guideIntro?:string;guideTopics?:string;
 /** Explicitly owner-approved Telegram rules page, never inferred from names. */
 rulesUrl?:string;
 /** Missing in old snapshots means disabled. */
 changeLogEnabled?:boolean;
 /** Separately opt-in, owner-reviewed group title/photo removal edits. */
 profileEditingEnabled?:boolean;
 /** Opt-in, privacy-limited decisions ledger; disabled by default. */
 decisionLogEnabled?:boolean;
 /** Missing per-kind flags preserve legacy behavior (both true). */
 serviceCleanup?:{enabled:boolean;delayMs:number;joinEnabled?:boolean;leaveEnabled?:boolean;
  /** Absent preserves legacy cleanup of title/photo change service messages. */
  profileEnabled?:boolean;};
 /** Optional expiry of confirmed bot-authored community responses. Disabled by default. */
 replyCleanup?:{enabled:boolean;delayMs:number};
}
export type CommunityDraftKind='WELCOME_TEXT'|'FAREWELL_TEXT'|'REPLY_ADD'|'REPLY_REMOVE'|
 'WELCOME_ON'|'WELCOME_OFF'|'FAREWELL_ON'|'FAREWELL_OFF'|'REPLIES_ON'|'REPLIES_OFF'|
 'PRIVATE_WELCOME_ON'|'PRIVATE_WELCOME_OFF'|'WELCOME_MEMBER_LANG_ON'|'WELCOME_MEMBER_LANG_OFF'|
 'GROUP_PROFILE_ON'|'GROUP_PROFILE_OFF'|'GROUP_TITLE_SET'|'GROUP_PHOTO_SET'|'GROUP_PHOTO_REMOVE'|
 'REPLY_ENABLE'|'REPLY_DISABLE'|'REPLY_COOLDOWN'|'AUTO_LIMIT_SET'|
 'QUIET_HOURS_SET'|'QUIET_HOURS_CLEAR'|'TOPIC_COOLDOWN_SET'|'TOPIC_COOLDOWN_CLEAR'|
 'CHANGE_LOG_ON'|'CHANGE_LOG_OFF'|'DECISION_LOG_ON'|'DECISION_LOG_OFF'|'SERVICE_CLEANUP_ON'|'SERVICE_CLEANUP_OFF'|'SERVICE_CLEANUP_DELAY'|
 'SERVICE_JOIN_ON'|'SERVICE_JOIN_OFF'|'SERVICE_LEAVE_ON'|'SERVICE_LEAVE_OFF'|
 'SERVICE_PROFILE_ON'|'SERVICE_PROFILE_OFF'|
 'REPLY_CLEANUP_ON'|'REPLY_CLEANUP_OFF'|'REPLY_CLEANUP_DELAY'|
 'RULES_LINK_SET'|'RULES_LINK_CLEAR'|
 'GUIDE_INTRO_SET'|'GUIDE_INTRO_CLEAR'|'GUIDE_TOPICS_SET'|'GUIDE_TOPICS_CLEAR'|
 'WELCOME_VARIANT_SET'|'WELCOME_VARIANT_CLEAR'|
 'FAREWELL_VARIANT_SET'|'FAREWELL_VARIANT_CLEAR'|'FAREWELL_REMOVED_ON'|'FAREWELL_REMOVED_OFF'|
 'WELCOME_LOCALIZED'|'FAREWELL_LOCALIZED'|'WELCOME_LOCALIZED_CLEAR'|'FAREWELL_LOCALIZED_CLEAR'|'GROUP_LANGUAGE'|'GROUP_CLOCK'|'GROUP_TIMEZONE'|'GROUP_TIMEZONE_CLEAR'|
 'WELCOME_PHOTO_SET'|'WELCOME_PHOTO_CLEAR'|'FAREWELL_PHOTO_SET'|'FAREWELL_PHOTO_CLEAR'|
 'WELCOME_BUTTON_ADD'|'WELCOME_BUTTONS_CLEAR'|'FAREWELL_BUTTON_ADD'|'FAREWELL_BUTTONS_CLEAR';
export interface CommunityDraft{
 id:string;actorId:string;chatId:string;chatVersion:number;configVersion:number;
 kind:CommunityDraftKind;createdAt:number;expiresAt:number;
 text?:string;trigger?:string;match?:ReplyMatch;source?:CommunityReplySource;sourceFaqId?:string;ruleId?:string;topicId?:number;cooldownMs?:number;delayMs?:number;autoMessagesPerMinute?:number;
 language?:CommunityLanguage;clockFormat?:CommunityClockFormat;calendar?:CommunityCalendar;utcOffsetMinutes?:number;timeZone?:string;
 joinKind?:CommunityJoinKind;leaveKind?:CommunityLeaveKind;
 photoFileId?:string;buttonText?:string;buttonUrl?:string;
 startMinute?:number;endMinute?:number;
 /** Binds owner review to the last observed group profile event. */
 profileEpoch?:number;
}
export interface CommunityReceipt{
 /** An opaque hash of the inbound Telegram update and bot identifier. */
 key:string;chatId:string;at:number;kind:CommunityEventKind;
 /** A short-lived digest, not a raw student message or display name. */
 actorDigest:string;ruleId?:string;topicId?:number;joinKind?:CommunityJoinKind;leaveKind?:CommunityLeaveKind;
}
/** A bounded, opt-in decision record. No message, display name or actor identifier. */
export type CommunityDecisionReason=
 'RESERVED'|'WELCOME_DISABLED'|'FAREWELL_DISABLED'|'REPLIES_DISABLED'|'QUIET_HOURS'|
 'NO_MATCH'|'CLOCK_SKEW'|'GROUP_LIMIT'|'TOPIC_COOLDOWN'|'GROUP_COOLDOWN'|'REMOVAL_SUPPRESSED'|
 'ACTOR_COOLDOWN'|'TEMPLATE_INVALID'|'CAPTION_LIMIT'|'SOURCE_UNAVAILABLE'|'LECTURE_MODE';
export interface CommunityDecision {
 key:string;chatId:string;at:number;kind:CommunityEventKind;configVersion:number;
 reason:CommunityDecisionReason;ruleId?:string;
}
/** At-most-once claim for a user-initiated DM, without user IDs or text. */
export interface CommunityPrivateWelcome{
 joinKey:string;chatId:string;actorDigest:string;at:number;
}
export interface CommunityServiceChange{
 key:string;chatId:string;kind:'TITLE_CHANGED'|'PHOTO_CHANGED'|'PHOTO_REMOVED';
 actorDigest:string;at:number;
 /** Hash of chat and Telegram service message id, prevents duplicate updates. */
 messageDigest?:string;
}
export type CommunityCleanupStatus='QUEUED'|'SENDING'|'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'SKIPPED';
export interface CommunityCleanupJob{
 key:string;chatId:string;chatVersion:number;policyVersion:number;
 messageId:number;kind:CommunityServiceKind|'AUTOMATIC_REPLY';observedAt:number;dueAt:number;
 status:CommunityCleanupStatus;attemptId?:string;
}
export type CommunityProfileStatus='QUEUED'|'SENDING'|'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'SKIPPED';
/** Never copy a Telegram group title into the public change-audit record. A
 * confirmed/attempted job discards the title before contacting the provider. */
export interface CommunityProfileJob{
 key:string;chatId:string;chatVersion:number;policyVersion:number;
 kind:'TITLE_SET'|'PHOTO_SET'|'PHOTO_REMOVE';status:CommunityProfileStatus;
 createdAt:number;profileEpoch:number;title?:string;photoFileId?:string;attemptId?:string;
}
export interface CommunityProfileObservation{key:string;chatId:string;at:number;messageDigest?:string;}
export interface CommunityProfileRevision{chatId:string;revision:number;lastKey:string;}
export function validCommunityProfileTitle(value:unknown):value is string{
 return typeof value==='string'&&value.trim()===value&&
  Array.from(value).length>=1&&Array.from(value).length<=128&&
  !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
}
export interface CommunityAutomationState{
 configs:CommunityConfig[];drafts:CommunityDraft[];receipts:CommunityReceipt[];
 /** Owner approved edits, at most once; raw title is only kept while QUEUED. */
 profileJobs?:CommunityProfileJob[];
 /** Opaque arrival witnesses when editing is enabled, not visible in audit UI. */
 profileObservations?:CommunityProfileObservation[];
 /** Monotonic per-group revision; never inferred from truncated observation list length. */
 profileRevisions?:CommunityProfileRevision[];
 /** Event audit contains kind and opaque digests only, never titles or images. */
 serviceChanges?:CommunityServiceChange[];
 cleanupJobs?:CommunityCleanupJob[];
 decisionLog?:CommunityDecision[];
 privateWelcomes?:CommunityPrivateWelcome[];
}
export interface CommunityInput{
 kind:CommunityEventKind;chatId:string;actorId:string;
 memberName:string;groupName:string;messageText?:string;joinKind?:CommunityJoinKind;leaveKind?:CommunityLeaveKind;
 /** Transient trusted Telegram language hint; not kept in receipts. */
 memberLanguage?:CommunityLanguage;
 topicId?:number;edited?:boolean;forwarded?:boolean;fromBot?:boolean;
}
const validGroup=(s:unknown):s is string=>typeof s==='string'&&/^-[1-9]\d{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const validActor=(s:unknown):s is string=>typeof s==='string'&&/^[1-9]\d{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const validClock=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000;
const validText=(s:unknown,max:number):s is string=>typeof s==='string'&&
 s.trim().length>0&&Array.from(s).length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(s);
/** Single-line, reviewed guide content: no implicit template interpolation. */
export const validCommunityGuideText=(s:unknown,max=320):s is string=>
 validText(s,max)&&s.trim()===s&&!/[\r\n{}]/u.test(s)&&
 Buffer.byteLength(s,'utf8')<=900;
const validTemplate=(t:unknown):t is string=>validText(t,800)&&
 !/\{(?!العضو\}|اسم_المجموعة\}|التاريخ\}|الوقت\}|رابط_القوانين\})[^{}]*\}/u.test(t);
/** No redirects, credentials, fragments, queries or look-alike domains.
 * Explicit owner approval does not mean the linked contents were audited.
 */
export function validCommunityRulesUrl(value:unknown):value is string{
 if(typeof value!=='string'||value.length<14||value.length>256||
  /[\s\u0000-\u001f\u007f\\]/u.test(value))return false;
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&url.hostname==='t.me'&&url.port===''&&
   url.username===''&&url.password===''&&url.search===''&&url.hash===''&&
   url.href===value&&/^\/(?:[A-Za-z0-9_+\-]{3,64})(?:\/[A-Za-z0-9_+\-]{1,64}){0,3}\/?$/u.test(url.pathname);
 }catch{return false;}
}
const validTopic=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const validMinute=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<1440;
export const validCommunityJoinKind=(value:unknown):value is CommunityJoinKind=>
 value==='SELF'||value==='ADDED'||value==='BATCH'||value==='INVITE';
export const validCommunityLeaveKind=(value:unknown):value is CommunityLeaveKind=>
 value==='SELF'||value==='REMOVED';
/** A supported, canonical IANA zone. All zone names are owner-supplied only. */
export function validCommunityTimeZone(value:unknown):value is string{
 if(typeof value!=='string'||value.length>64||
   !/^(?:UTC|[A-Za-z_-]+(?:\/[A-Za-z_-]+){1,2})$/u.test(value))return false;
 try{return new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone===value;}
 catch{return false;}
}
export function inCommunityQuietHours(hours:CommunityQuietHours,now:number,utcOffsetMinutes:number,
 timeZone?:string):boolean{
 if(!validClock(now)||!Number.isInteger(utcOffsetMinutes)||utcOffsetMinutes< -720||utcOffsetMinutes>840||
    !validMinute(hours.startMinute)||!validMinute(hours.endMinute)||hours.startMinute===hours.endMinute||
    (timeZone!==undefined&&!validCommunityTimeZone(timeZone)))
  throw Error('COMMUNITY_QUIET_HOURS_INVALID');
 let minute=((Math.floor(now/60000)+utcOffsetMinutes)%1440+1440)%1440;
 if(timeZone!==undefined){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,hour:'2-digit',minute:'2-digit',
   hourCycle:'h23',numberingSystem:'latn'}).formatToParts(new Date(now));
  const value=(key:string)=>Number(parts.find(p=>p.type===key)?.value);
  const hour=value('hour'),minutes=value('minute');
  if(!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minutes)||minutes<0||minutes>59)
   throw Error('COMMUNITY_QUIET_HOURS_INVALID');
  minute=hour*60+minutes;
 }
 return hours.startMinute<hours.endMinute?
  minute>=hours.startMinute&&minute<hours.endMinute:
  minute>=hours.startMinute||minute<hours.endMinute;
}
const kinds=new Set<CommunityDraftKind>(['WELCOME_TEXT','FAREWELL_TEXT','REPLY_ADD','REPLY_REMOVE',
 'WELCOME_ON','WELCOME_OFF','PRIVATE_WELCOME_ON','PRIVATE_WELCOME_OFF','WELCOME_MEMBER_LANG_ON','WELCOME_MEMBER_LANG_OFF',
 'GROUP_PROFILE_ON','GROUP_PROFILE_OFF','GROUP_TITLE_SET','GROUP_PHOTO_SET','GROUP_PHOTO_REMOVE','FAREWELL_ON','FAREWELL_OFF','REPLIES_ON','REPLIES_OFF',
 'REPLY_ENABLE','REPLY_DISABLE','REPLY_COOLDOWN','AUTO_LIMIT_SET',
 'QUIET_HOURS_SET','QUIET_HOURS_CLEAR','TOPIC_COOLDOWN_SET','TOPIC_COOLDOWN_CLEAR',
 'CHANGE_LOG_ON','CHANGE_LOG_OFF','DECISION_LOG_ON','DECISION_LOG_OFF','SERVICE_CLEANUP_ON','SERVICE_CLEANUP_OFF','SERVICE_CLEANUP_DELAY',
 'SERVICE_JOIN_ON','SERVICE_JOIN_OFF','SERVICE_LEAVE_ON','SERVICE_LEAVE_OFF',
 'SERVICE_PROFILE_ON','SERVICE_PROFILE_OFF',
 'REPLY_CLEANUP_ON','REPLY_CLEANUP_OFF','REPLY_CLEANUP_DELAY',
 'RULES_LINK_SET','RULES_LINK_CLEAR',
 'GUIDE_INTRO_SET','GUIDE_INTRO_CLEAR','GUIDE_TOPICS_SET','GUIDE_TOPICS_CLEAR',
 'WELCOME_VARIANT_SET','WELCOME_VARIANT_CLEAR',
 'FAREWELL_VARIANT_SET','FAREWELL_VARIANT_CLEAR','FAREWELL_REMOVED_ON','FAREWELL_REMOVED_OFF',
 'WELCOME_LOCALIZED','FAREWELL_LOCALIZED','WELCOME_LOCALIZED_CLEAR','FAREWELL_LOCALIZED_CLEAR','GROUP_LANGUAGE','GROUP_CLOCK','GROUP_TIMEZONE','GROUP_TIMEZONE_CLEAR',
 'WELCOME_PHOTO_SET','WELCOME_PHOTO_CLEAR','FAREWELL_PHOTO_SET','FAREWELL_PHOTO_CLEAR',
 'WELCOME_BUTTON_ADD','WELCOME_BUTTONS_CLEAR','FAREWELL_BUTTON_ADD','FAREWELL_BUTTONS_CLEAR']);
const matches=new Set<ReplyMatch>(['EXACT','WORD','CONTAINS','COMMAND']);
export function defaultCommunityConfig(chatId:string):CommunityConfig{
 if(!validGroup(chatId))throw Error('COMMUNITY_CHAT_INVALID');
 return {chatId,version:0,welcome:{enabled:false,text:'مرحبًا {العضو} في {اسم_المجموعة} 👋'},
  farewell:{enabled:false,text:'نتمنى لك التوفيق يا {العضو} 👋'},
  repliesEnabled:false,rules:[],utcOffsetMinutes:180,groupCooldownMs:8000,
  changeLogEnabled:false,serviceCleanup:{enabled:false,delayMs:120000}};
}
export function validCommunityConfig(value:unknown):value is CommunityConfig{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const x=value as CommunityConfig;
 if(!validGroup(x.chatId)||!Number.isSafeInteger(x.version)||x.version<0||x.version>2_000_000_000||
  !Number.isInteger(x.utcOffsetMinutes)||x.utcOffsetMinutes< -720||x.utcOffsetMinutes>840||
  !Number.isInteger(x.groupCooldownMs)||x.groupCooldownMs<1000||x.groupCooldownMs>600000||
  (x.autoMessagesPerMinute!==undefined&&(!Number.isInteger(x.autoMessagesPerMinute)||
    x.autoMessagesPerMinute<1||x.autoMessagesPerMinute>8))||
  !Array.isArray(x.rules)||x.rules.length>30||
  (x.quietHours!==undefined&&
    (!x.quietHours||!validMinute(x.quietHours.startMinute)||
     !validMinute(x.quietHours.endMinute)||x.quietHours.startMinute===x.quietHours.endMinute))||
  (x.topicCooldowns!==undefined&&
    (!Array.isArray(x.topicCooldowns)||x.topicCooldowns.length>30||
     x.topicCooldowns.some(row=>!row||!validTopic(row.topicId)||
       !Number.isInteger(row.cooldownMs)||row.cooldownMs<1000||row.cooldownMs>600000)||
     new Set(x.topicCooldowns.map(row=>row.topicId)).size!==x.topicCooldowns.length))||
  (x.privateWelcomeEnabled!==undefined&&typeof x.privateWelcomeEnabled!=='boolean')||
  (x.welcomeMemberLanguageEnabled!==undefined&&typeof x.welcomeMemberLanguageEnabled!=='boolean')||
  (x.farewellOnRemoval!==undefined&&typeof x.farewellOnRemoval!=='boolean')||
  (x.farewellByLeave!==undefined&&(!x.farewellByLeave||typeof x.farewellByLeave!=='object'||
    Array.isArray(x.farewellByLeave)||
    Object.keys(x.farewellByLeave).some(kind=>!validCommunityLeaveKind(kind))||
    Object.values(x.farewellByLeave).some(text=>!validTemplate(text))))||
  (x.welcomeByJoin!==undefined&&(!x.welcomeByJoin||typeof x.welcomeByJoin!=='object'||
    Array.isArray(x.welcomeByJoin)||
    Object.keys(x.welcomeByJoin).some(kind=>!validCommunityJoinKind(kind))||
    Object.values(x.welcomeByJoin).some(text=>!validTemplate(text))))||
  (x.rulesUrl!==undefined&&!validCommunityRulesUrl(x.rulesUrl))||
  (x.guideIntro!==undefined&&!validCommunityGuideText(x.guideIntro,320))||
  (x.guideTopics!==undefined&&!validCommunityGuideText(x.guideTopics,240))||
   (x.timeZone!==undefined&&!validCommunityTimeZone(x.timeZone))||
  (x.language!==undefined&&x.language!=='ar'&&x.language!=='en')||
  (x.clockFormat!==undefined&&x.clockFormat!=='12'&&x.clockFormat!=='24')||
  (x.calendar!==undefined&&x.calendar!=='gregorian'&&x.calendar!=='hijri')||
  (x.changeLogEnabled!==undefined&&typeof x.changeLogEnabled!=='boolean')||
  (x.profileEditingEnabled!==undefined&&typeof x.profileEditingEnabled!=='boolean')||
  (x.decisionLogEnabled!==undefined&&typeof x.decisionLogEnabled!=='boolean')||
  (x.serviceCleanup!==undefined&&(!x.serviceCleanup||typeof x.serviceCleanup!=='object'||
    typeof x.serviceCleanup.enabled!=='boolean'||!Number.isInteger(x.serviceCleanup.delayMs)||
    x.serviceCleanup.delayMs<30000||x.serviceCleanup.delayMs>3600000||
    (x.serviceCleanup.joinEnabled!==undefined&&typeof x.serviceCleanup.joinEnabled!=='boolean')||
    (x.serviceCleanup.leaveEnabled!==undefined&&typeof x.serviceCleanup.leaveEnabled!=='boolean')||
    (x.serviceCleanup.profileEnabled!==undefined&&typeof x.serviceCleanup.profileEnabled!=='boolean')))||
  (x.replyCleanup!==undefined&&(!x.replyCleanup||typeof x.replyCleanup!=='object'||
    typeof x.replyCleanup.enabled!=='boolean'||!Number.isInteger(x.replyCleanup.delayMs)||
    x.replyCleanup.delayMs<30000||x.replyCleanup.delayMs>3600000)))return false;
 for(const item of [x.welcome,x.farewell]){
  if(!item||typeof item!=='object'||typeof item.enabled!=='boolean'||!validTemplate(item.text))return false;
  if(item.photoFileId!==undefined&&!validCommunityPhotoId(item.photoFileId)||
     item.buttons!==undefined&&!validCommunityLinkButtons(item.buttons))return false;
  if(item.localized!==undefined){
   if(!item.localized||typeof item.localized!=='object'||Array.isArray(item.localized)||
      Object.keys(item.localized).some(k=>k!=='ar'&&k!=='en')||
      Object.values(item.localized).some(v=>!validTemplate(v)))return false;
  }
 }
 const ids=new Set<string>(),triggers=new Set<string>();
 for(const rule of x.rules){
  if(!rule||typeof rule!=='object'||typeof rule.id!=='string'||!/^[a-f0-9]{12}$/u.test(rule.id)||
   !validText(rule.trigger,80)||!validTemplate(rule.response)||!matches.has(rule.match)||
   (rule.match==='COMMAND'&&!/^m_[a-z][a-z0-9_]{0,23}$/u.test(rule.trigger))||
   typeof rule.enabled!=='boolean'||!Number.isInteger(rule.cooldownMs)||
   rule.cooldownMs<1000||rule.cooldownMs>86400000||
   (rule.topicId!==undefined&&!validTopic(rule.topicId))||
   (rule.source!==undefined&&!['NOTE','RULES','FAQ'].includes(rule.source))||
   (rule.source==='FAQ'?!validCommunityFAQId(rule.sourceFaqId):rule.sourceFaqId!==undefined))return false;
  const triggerKey=JSON.stringify([rule.topicId??0,normalizeCommunityMatch(rule.trigger),rule.match]);
  if(ids.has(rule.id)||triggers.has(triggerKey))return false;
  ids.add(rule.id);triggers.add(triggerKey);
 }
 return typeof x.repliesEnabled==='boolean';
}
export function validCommunityState(value:unknown):value is CommunityAutomationState{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as CommunityAutomationState;
 if(!Array.isArray(v.configs)||v.configs.length>500||!v.configs.every(validCommunityConfig)||
  new Set(v.configs.map(c=>c.chatId)).size!==v.configs.length||
  !Array.isArray(v.drafts)||v.drafts.length>100||
  !Array.isArray(v.receipts)||v.receipts.length>2500||
  (v.serviceChanges!==undefined&&(!Array.isArray(v.serviceChanges)||v.serviceChanges.length>1000))||
  (v.cleanupJobs!==undefined&&(!Array.isArray(v.cleanupJobs)||v.cleanupJobs.length>1000))||
  (v.decisionLog!==undefined&&(!Array.isArray(v.decisionLog)||v.decisionLog.length>1000))||
  (v.privateWelcomes!==undefined&&(!Array.isArray(v.privateWelcomes)||v.privateWelcomes.length>2500))||
  (v.profileJobs!==undefined&&(!Array.isArray(v.profileJobs)||v.profileJobs.length>500))||
  (v.profileObservations!==undefined&&(!Array.isArray(v.profileObservations)||v.profileObservations.length>1000))||
  (v.profileRevisions!==undefined&&(!Array.isArray(v.profileRevisions)||v.profileRevisions.length>500)))return false;
 if(v.profileRevisions){
  const ids=new Set<string>();
  for(const row of v.profileRevisions){
   if(!row||typeof row!=='object'||Array.isArray(row)||
     Object.keys(row).some(k=>!['chatId','revision','lastKey'].includes(k))||
     !validGroup(row.chatId)||ids.has(row.chatId)||
     !Number.isSafeInteger(row.revision)||row.revision<1||row.revision>2_000_000_000||
     typeof row.lastKey!=='string'||!/^[a-f0-9]{64}$/u.test(row.lastKey))return false;
   ids.add(row.chatId);
  }
 }

 if(v.profileObservations){
  const seen=new Set<string>();
  for(const o of v.profileObservations){
   if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!['key','chatId','at','messageDigest'].includes(k))||
     typeof o.key!=='string'||!/^[a-f0-9]{64}$/u.test(o.key)||seen.has(o.key)||
     !validGroup(o.chatId)||!validClock(o.at)||
     (o.messageDigest!==undefined&&(typeof o.messageDigest!=='string'||!/^[a-f0-9]{64}$/u.test(o.messageDigest))))return false;
   seen.add(o.key);
  }
 }
 if(v.profileJobs){
  const seen=new Set<string>();
  const states=new Set<CommunityProfileStatus>(['QUEUED','SENDING','CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','SKIPPED']);
  for(const job of v.profileJobs){
   if(!job||typeof job!=='object'||Array.isArray(job)||
     Object.keys(job).some(k=>!['key','chatId','chatVersion','policyVersion','kind','status','createdAt','profileEpoch','title','photoFileId','attemptId'].includes(k))||
     typeof job.key!=='string'||!/^[a-f0-9]{24}$/u.test(job.key)||seen.has(job.key)||
     !validGroup(job.chatId)||!Number.isSafeInteger(job.chatVersion)||job.chatVersion<1||
     !Number.isSafeInteger(job.policyVersion)||job.policyVersion<1||
     !['TITLE_SET','PHOTO_SET','PHOTO_REMOVE'].includes(job.kind)||!states.has(job.status)||
     !validClock(job.createdAt)||!Number.isSafeInteger(job.profileEpoch)||job.profileEpoch<0||job.profileEpoch>2000000000||
     (job.title!==undefined&&(job.kind!=='TITLE_SET'||job.status!=='QUEUED'||!validCommunityProfileTitle(job.title)))||
     (job.kind==='TITLE_SET'&&job.status==='QUEUED'&&!validCommunityProfileTitle(job.title))||
     (job.photoFileId!==undefined&&(job.kind!=='PHOTO_SET'||job.status!=='QUEUED'||!validCommunityPhotoId(job.photoFileId)))||
     (job.kind==='PHOTO_SET'&&job.status==='QUEUED'&&!validCommunityPhotoId(job.photoFileId))||
     (job.attemptId!==undefined&&(typeof job.attemptId!=='string'||!/^[a-f0-9]{24}$/u.test(job.attemptId)))||
     (job.status==='SENDING'&&!job.attemptId)||
     (job.status==='QUEUED'&&job.attemptId!==undefined))return false;
   seen.add(job.key);
  }
 }

 if(v.privateWelcomes){
  const unique=new Set<string>();
  for(const x of v.privateWelcomes){
   if(!x||typeof x!=='object'||Array.isArray(x)||
      Object.keys(x).length!==4||
      Object.keys(x).some(k=>!['joinKey','chatId','actorDigest','at'].includes(k))||
      typeof x.joinKey!=='string'||!/^[a-f0-9]{64}$/u.test(x.joinKey)||
      typeof x.actorDigest!=='string'||!/^[a-f0-9]{64}$/u.test(x.actorDigest)||
      !validGroup(x.chatId)||!validClock(x.at)||
      unique.has(x.joinKey+':'+x.actorDigest))return false;
   unique.add(x.joinKey+':'+x.actorDigest);
  }
 }
 const validReasons=new Set<CommunityDecisionReason>(['RESERVED','WELCOME_DISABLED','FAREWELL_DISABLED',
  'REPLIES_DISABLED','QUIET_HOURS','NO_MATCH','CLOCK_SKEW','GROUP_LIMIT','TOPIC_COOLDOWN',
  'GROUP_COOLDOWN','ACTOR_COOLDOWN','TEMPLATE_INVALID','CAPTION_LIMIT','REMOVAL_SUPPRESSED','SOURCE_UNAVAILABLE','LECTURE_MODE']);
 if(v.decisionLog){
  const keys=new Set<string>();
  for(const entry of v.decisionLog){
   if(!entry||typeof entry!=='object'||Array.isArray(entry)||
      Object.keys(entry).some(k=>!['key','chatId','at','kind','configVersion','reason','ruleId'].includes(k))||
      typeof entry.key!=='string'||!/^[a-f0-9]{64}$/u.test(entry.key)||keys.has(entry.key)||
      !validGroup(entry.chatId)||!validClock(entry.at)||
      !['JOIN','LEAVE','TEXT'].includes(entry.kind)||!validReasons.has(entry.reason)||
      !Number.isSafeInteger(entry.configVersion)||entry.configVersion<1||entry.configVersion>2_000_000_000||
      (entry.ruleId!==undefined&&(!/^[a-f0-9]{12}$/u.test(entry.ruleId)||
        !['RESERVED','GROUP_LIMIT','TOPIC_COOLDOWN','GROUP_COOLDOWN','ACTOR_COOLDOWN','TEMPLATE_INVALID','CAPTION_LIMIT','SOURCE_UNAVAILABLE'].includes(entry.reason))))return false;
   keys.add(entry.key);
  }
 }
 const serviceKinds=new Set<CommunityServiceKind>(['JOIN','LEAVE','TITLE_CHANGED','PHOTO_CHANGED','PHOTO_REMOVED']);
 if(v.serviceChanges){
  const keys=new Set<string>();
  for(const row of v.serviceChanges){
   if(!row||typeof row!=='object'||typeof row.key!=='string'||
    !/^[a-f0-9]{64}$/u.test(row.key)||keys.has(row.key)||!validGroup(row.chatId)||
    !['TITLE_CHANGED','PHOTO_CHANGED','PHOTO_REMOVED'].includes(row.kind)||
    typeof row.actorDigest!=='string'||!/^[a-f0-9]{64}$/u.test(row.actorDigest)||
    !validClock(row.at)||
    (row.messageDigest!==undefined&&(typeof row.messageDigest!=='string'||!/^[a-f0-9]{64}$/u.test(row.messageDigest))))return false;
   keys.add(row.key);
  }
 }
 if(v.cleanupJobs){
  const keys=new Set<string>();
  const statuses=new Set<CommunityCleanupStatus>(['QUEUED','SENDING','CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','SKIPPED']);
  for(const row of v.cleanupJobs){
   if(!row||typeof row!=='object'||typeof row.key!=='string'||
    !/^[a-f0-9]{64}$/u.test(row.key)||keys.has(row.key)||!validGroup(row.chatId)||
    !Number.isSafeInteger(row.messageId)||row.messageId<=0||row.messageId>2147483647||
    !Number.isSafeInteger(row.chatVersion)||row.chatVersion<1||
    !Number.isSafeInteger(row.policyVersion)||row.policyVersion<1||
    !(serviceKinds.has(row.kind as CommunityServiceKind)||row.kind==='AUTOMATIC_REPLY')||!validClock(row.observedAt)||!validClock(row.dueAt)||
    row.dueAt-row.observedAt<30000||row.dueAt-row.observedAt>3600000||
    !statuses.has(row.status)||
    (row.attemptId!==undefined&&(typeof row.attemptId!=='string'||!/^[a-f0-9]{24}$/u.test(row.attemptId)))||
    (row.status==='QUEUED'&&row.attemptId!==undefined)||
    (row.status==='SENDING'&&!row.attemptId))return false;
   keys.add(row.key);
  }
 }
 const draftIds=new Set<string>();
 for(const d of v.drafts){
  if(!d||typeof d!=='object'||typeof d.id!=='string'||!/^[a-f0-9]{24}$/u.test(d.id)||
   draftIds.has(d.id)||!validActor(d.actorId)||!validGroup(d.chatId)||
   !Number.isSafeInteger(d.chatVersion)||d.chatVersion<1||
   !Number.isSafeInteger(d.configVersion)||d.configVersion<0||
   !kinds.has(d.kind)||!validClock(d.createdAt)||!validClock(d.expiresAt)||
   d.expiresAt<=d.createdAt||d.expiresAt-d.createdAt>120000||
   (d.text!==undefined&&(
    d.kind==='GROUP_TITLE_SET'?!validCommunityProfileTitle(d.text):
    d.kind==='GUIDE_INTRO_SET'?!validCommunityGuideText(d.text,320):
    d.kind==='GUIDE_TOPICS_SET'?!validCommunityGuideText(d.text,240):
    !validTemplate(d.text)))||
   (d.profileEpoch!==undefined&&(!Number.isSafeInteger(d.profileEpoch)||d.profileEpoch<0||d.profileEpoch>2_000_000_000))||
   (d.trigger!==undefined&&!validText(d.trigger,80))||
   (d.match!==undefined&&!matches.has(d.match))||
   (d.source!==undefined&&!['NOTE','RULES','FAQ'].includes(d.source))||
   (d.source==='FAQ'?!validCommunityFAQId(d.sourceFaqId):d.sourceFaqId!==undefined)||
   (d.ruleId!==undefined&&!/^[a-f0-9]{12}$/u.test(d.ruleId))||
   (d.topicId!==undefined&&!validTopic(d.topicId))||
   (d.cooldownMs!==undefined&&(!Number.isInteger(d.cooldownMs)||d.cooldownMs<1000||d.cooldownMs>86400000))||
   (d.autoMessagesPerMinute!==undefined&&(!Number.isInteger(d.autoMessagesPerMinute)||
     d.autoMessagesPerMinute<1||d.autoMessagesPerMinute>8))||
   (d.startMinute!==undefined&&!validMinute(d.startMinute))||
   (d.endMinute!==undefined&&!validMinute(d.endMinute))||
   (d.delayMs!==undefined&&(!Number.isInteger(d.delayMs)||d.delayMs<30000||d.delayMs>3600000))||
   (d.language!==undefined&&d.language!=='ar'&&d.language!=='en')||
   (d.clockFormat!==undefined&&d.clockFormat!=='12'&&d.clockFormat!=='24')||
   (d.calendar!==undefined&&d.calendar!=='gregorian'&&d.calendar!=='hijri')||
   (d.utcOffsetMinutes!==undefined&&(!Number.isInteger(d.utcOffsetMinutes)||
       d.utcOffsetMinutes< -720||d.utcOffsetMinutes>840))||
    (d.timeZone!==undefined&&!validCommunityTimeZone(d.timeZone))||
   (d.joinKind!==undefined&&!validCommunityJoinKind(d.joinKind))||
   (d.leaveKind!==undefined&&!validCommunityLeaveKind(d.leaveKind))||
   (d.photoFileId!==undefined&&!validCommunityPhotoId(d.photoFileId))||
   (d.buttonText!==undefined&&
      (typeof d.buttonText!=='string'||!validCommunityLinkButtons([{text:d.buttonText,
        url:d.buttonUrl??''}])))||
   (d.buttonUrl!==undefined&&
      (typeof d.buttonUrl!=='string'||!validCommunityLinkButtons([{text:d.buttonText??'',
        url:d.buttonUrl}]))) )return false;
  if((d.kind==='WELCOME_TEXT'||d.kind==='FAREWELL_TEXT')&&!d.text||
   d.kind==='GROUP_TITLE_SET'&&!validCommunityProfileTitle(d.text)||
   (d.kind==='GROUP_TITLE_SET'||d.kind==='GROUP_PHOTO_SET'||d.kind==='GROUP_PHOTO_REMOVE')&&d.profileEpoch===undefined||
   d.kind==='GROUP_PHOTO_SET'&&!validCommunityPhotoId(d.photoFileId)||
   d.kind==='REPLY_ADD'&&(!d.trigger||!d.match||
      (d.source===undefined||d.source==='NOTE')&&!validTemplate(d.text))||
   (['REPLY_REMOVE','REPLY_ENABLE','REPLY_DISABLE','REPLY_COOLDOWN'] as string[]).includes(d.kind)&&!d.ruleId||
   d.kind==='REPLY_COOLDOWN'&&d.cooldownMs===undefined||
   d.kind==='AUTO_LIMIT_SET'&&d.autoMessagesPerMinute===undefined||
   d.kind==='QUIET_HOURS_SET'&&(!validMinute(d.startMinute)||!validMinute(d.endMinute)||d.startMinute===d.endMinute)||
   (d.kind==='TOPIC_COOLDOWN_SET'||d.kind==='TOPIC_COOLDOWN_CLEAR')&&!validTopic(d.topicId)||
   d.kind==='TOPIC_COOLDOWN_SET'&&(!Number.isInteger(d.cooldownMs)||d.cooldownMs===undefined||d.cooldownMs<1000||d.cooldownMs>600000)||
   (d.kind==='SERVICE_CLEANUP_DELAY'||d.kind==='REPLY_CLEANUP_DELAY')&&d.delayMs===undefined||
   d.kind==='RULES_LINK_SET'&&!validCommunityRulesUrl(d.text)||
   d.kind==='GUIDE_INTRO_SET'&&!validCommunityGuideText(d.text,320)||
   d.kind==='GUIDE_TOPICS_SET'&&!validCommunityGuideText(d.text,240)||
   (d.kind==='GUIDE_INTRO_CLEAR'||d.kind==='GUIDE_TOPICS_CLEAR')&&
    d.text!==undefined||
   (d.kind==='WELCOME_LOCALIZED'||d.kind==='FAREWELL_LOCALIZED')&&
      (!d.language||!validTemplate(d.text))||
   (d.kind==='WELCOME_LOCALIZED_CLEAR'||d.kind==='FAREWELL_LOCALIZED_CLEAR')&&
      (d.language===undefined||d.text!==undefined)||
   (d.kind==='WELCOME_VARIANT_SET'||d.kind==='WELCOME_VARIANT_CLEAR')&&
     !validCommunityJoinKind(d.joinKind)||
   d.kind==='WELCOME_VARIANT_SET'&&!validTemplate(d.text)||
   (d.kind==='FAREWELL_VARIANT_SET'||d.kind==='FAREWELL_VARIANT_CLEAR')&&
     !validCommunityLeaveKind(d.leaveKind)||
   d.kind==='FAREWELL_VARIANT_SET'&&!validTemplate(d.text)||
   d.kind==='GROUP_LANGUAGE'&&!d.language||
    d.kind==='GROUP_TIMEZONE'&&!validCommunityTimeZone(d.timeZone)||
   d.kind==='GROUP_CLOCK'&&(d.utcOffsetMinutes===undefined||
      !d.clockFormat||!d.calendar)||
   (d.kind==='WELCOME_PHOTO_SET'||d.kind==='FAREWELL_PHOTO_SET')&&
      !validCommunityPhotoId(d.photoFileId)||
   (d.kind==='WELCOME_BUTTON_ADD'||d.kind==='FAREWELL_BUTTON_ADD')&&
      !validCommunityLinkButtons([{text:d.buttonText??'',url:d.buttonUrl??''}]))return false;
  draftIds.add(d.id);
 }
 const receiptIds=new Set<string>();
 for(const x of v.receipts){
  if(!x||typeof x!=='object'||typeof x.key!=='string'||!/^[a-f0-9]{64}$/u.test(x.key)||
   receiptIds.has(x.key)||!validGroup(x.chatId)||!validClock(x.at)||
   !['JOIN','LEAVE','TEXT'].includes(x.kind)||typeof x.actorDigest!=='string'||
   !/^[a-f0-9]{64}$/u.test(x.actorDigest)||
   (x.ruleId!==undefined&&!/^[a-f0-9]{12}$/u.test(x.ruleId))||
   (x.topicId!==undefined&&!validTopic(x.topicId))||
   (x.joinKind!==undefined&&(x.kind!=='JOIN'||!validCommunityJoinKind(x.joinKind)))||
   (x.leaveKind!==undefined&&(x.kind!=='LEAVE'||!validCommunityLeaveKind(x.leaveKind))))return false;
  receiptIds.add(x.key);
 }
 return true;
}
export const emptyCommunityState=():CommunityAutomationState=>({configs:[],drafts:[],receipts:[]});
export function normalizeCommunityMatch(raw:string):string{
 return raw.normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640]/gu,'')
  .toLocaleLowerCase('ar').replace(/\s+/gu,' ').trim();
}
export function matchCommunityRule(rule:CommunityReplyRule,text:string):boolean{
 const value=normalizeCommunityMatch(text),trigger=normalizeCommunityMatch(rule.trigger);
 if(!value||!trigger)return false;
 // An isolated /m_ namespace cannot collide with Telegram moderation or
 // commands addressed to another bot; no callback or command is authorization.
 if(rule.match==='COMMAND'){
  if(!/^m_[a-z][a-z0-9_]{0,23}$/u.test(trigger))return false;
  const parsed=/^\/(m_[a-z][a-z0-9_]{0,23})(?:\s|$)/u.exec(value);
  return parsed?.[1]===trigger;
 }
 if(rule.match==='EXACT')return value===trigger;
 if(rule.match==='CONTAINS')return value.includes(trigger);
 let start=value.indexOf(trigger);
 while(start!==-1){
  const before=start===0?'':value[start-1]!,after=value[start+trigger.length]??'';
  if((!before||!(/[\p{L}\p{N}]/u.test(before)))&&
     (!after||!(/[\p{L}\p{N}]/u.test(after))))return true;
  start=value.indexOf(trigger,start+1);
 }
 return false;
}
/** A localized greeting overrides the legacy template only for the language
 * expressly chosen for this group; otherwise use the existing safe fallback. */
export function selectCommunityGreeting(config:CommunityConfig,kind:'welcome'|'farewell',
 joinKind?:CommunityJoinKind,leaveKind?:CommunityLeaveKind,
 memberLanguage?:CommunityLanguage):string{
 const entry=config[kind];
 const language=kind==='welcome'&&config.welcomeMemberLanguageEnabled===true&&
  (memberLanguage==='ar'||memberLanguage==='en')?memberLanguage:config.language??'ar';
 if(kind==='welcome'&&joinKind&&validCommunityJoinKind(joinKind)&&
   config.welcomeByJoin?.[joinKind])return config.welcomeByJoin[joinKind];
 if(kind==='farewell'&&leaveKind&&validCommunityLeaveKind(leaveKind)&&
   config.farewellByLeave?.[leaveKind])return config.farewellByLeave[leaveKind];
 return entry.localized?.[language]??entry.text;
}
export interface CommunityDateTimeOptions{
 language?:CommunityLanguage;clockFormat?:CommunityClockFormat;calendar?:CommunityCalendar;
 timeZone?:string;
}
export function formatCommunityDateTime(now:number,options:CommunityDateTimeOptions={}):
 {date:string;time:string}{
 if(!validClock(now)||options.language!==undefined&&!['ar','en'].includes(options.language)||
   options.clockFormat!==undefined&&!['12','24'].includes(options.clockFormat)||
   options.calendar!==undefined&&!['gregorian','hijri'].includes(options.calendar)||
   (options.timeZone!==undefined&&!validCommunityTimeZone(options.timeZone)))
  throw Error('COMMUNITY_DATE_FORMAT_INVALID');
 const dateObject=new Date(now);
 if(Number.isNaN(dateObject.getTime()))throw Error('COMMUNITY_DATE_FORMAT_INVALID');
 // The legacy caller passes an already-offset instant; a configured IANA zone
 // instead uses the original UTC event timestamp to resolve DST correctly.
 const local=options.timeZone?new Intl.DateTimeFormat('en-US',{
  timeZone:options.timeZone,year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23',numberingSystem:'latn',calendar:'gregory'
 }).formatToParts(dateObject):undefined;
 const localValue=(key:string)=>local?.find(p=>p.type===key)?.value??'';
 let day:string;
 if(options.calendar==='hijri'){
  const parts=new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura',{
   year:'numeric',month:'2-digit',day:'2-digit',
   timeZone:options.timeZone??'UTC',numberingSystem:'latn'
  }).formatToParts(dateObject);
  const part=(key:string):string=>parts.find(p=>p.type===key)?.value??'';
  if(!/^\d{3,4}$/u.test(part('year'))||!/^\d{1,2}$/u.test(part('month'))||
     !/^\d{1,2}$/u.test(part('day')))throw Error('COMMUNITY_HIJRI_CONVERSION_UNAVAILABLE');
  day=part('year')+'-'+part('month').padStart(2,'0')+'-'+part('day').padStart(2,'0')+' هـ';
 }else day=local?localValue('year')+'-'+localValue('month')+'-'+localValue('day'):
  dateObject.toISOString().slice(0,10);
 const hrs=local?Number(localValue('hour')):dateObject.getUTCHours();
 const minutes=local?localValue('minute'):String(dateObject.getUTCMinutes()).padStart(2,'0');
 if(!Number.isInteger(hrs)||hrs<0||hrs>23||!/^\d{2}$/u.test(minutes)||
    !/^\d{4}-\d{2}-\d{2}(?: هـ)?$/u.test(day))throw Error('COMMUNITY_DATE_FORMAT_INVALID');
 const time=options.clockFormat==='12'?
  String((hrs%12)||12).padStart(2,'0')+':'+minutes+' '+
  (options.language==='en'?(hrs<12?'AM':'PM'):(hrs<12?'ص':'م')):
  String(hrs).padStart(2,'0')+':'+minutes;
 return {date:day,time};
}
const escapeHtml=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const safeName=(name:string,max:number):string=>name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim().slice(0,max)||'عضو';
export function renderCommunityTemplate(template:string,input:CommunityInput,now:number,rulesUrl='',
 options:CommunityDateTimeOptions={}):string{
 if(!validTemplate(template)||!validClock(now))throw Error('COMMUNITY_TEMPLATE_INVALID');
 // 'now' is an offset-adjusted absolute instant supplied by the caller.
 // UTC formatters prevent server timezone and locale from changing the result.
 const {date,time}=formatCommunityDateTime(now,options);
 const vars:Record<string,string>={
  'العضو':safeName(input.memberName,80),'اسم_المجموعة':safeName(input.groupName,120),
  'التاريخ':date,'الوقت':time,'رابط_القوانين':rulesUrl
 };
 const rendered=template.replace(/\{(العضو|اسم_المجموعة|التاريخ|الوقت|رابط_القوانين)\}/gu,
  (_,key:string)=>vars[key]??'');
 const html=escapeHtml(rendered);
 if(Buffer.byteLength(html,'utf8')>4096)throw Error('COMMUNITY_MESSAGE_TOO_LONG');
 return html;
}
export function selectCommunityRule(config:CommunityConfig,text:string,topicId?:number):CommunityReplyRule|undefined{
 if(!config.repliesEnabled||!text.trim()||
   /^@\w+/u.test(text.trimStart()))return;
 const command=text.trimStart().startsWith('/');
 return config.rules.find(rule=>rule.enabled&&
  (command?rule.match==='COMMAND':rule.match!=='COMMAND')&&
  (rule.topicId===undefined||rule.topicId===topicId)&&matchCommunityRule(rule,text));
}
