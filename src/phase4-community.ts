import {createHash,randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {reviewedGroupFAQAnswer,resolvedCommunityReply} from './phase4-community-sources.js';
import {groupMenuEpochDigest} from './telegram-group-access.js';
import {Policy} from './policy.js';
import {lectureBlocksAutomation} from './phase4-lectures.js';
import {validCommunityPhotoId,validCommunityLinkButtons,communityLinkKeyboard,
 type CommunityLinkKeyboard} from './phase4-community-rich.js';
import {defaultCommunityConfig,emptyCommunityState,validCommunityConfig,
 matchCommunityRule,validCommunityGuideText,renderCommunityTemplate,selectCommunityRule,selectCommunityGreeting,normalizeCommunityMatch,validCommunityRulesUrl,inCommunityQuietHours,validCommunityTimeZone,validCommunityJoinKind,validCommunityLeaveKind,validCommunityFAQId,validCommunityProfileTitle,
 type CommunityConfig,type CommunityInput,type CommunityDraft,type CommunityDraftKind,
 type ReplyMatch,type CommunityReplySource,type CommunityAutomationState,type CommunityEventKind,type CommunityServiceKind,
 type CommunityServiceChange,type CommunityLanguage,type CommunityCalendar,type CommunityClockFormat,type CommunityJoinKind,type CommunityLeaveKind,
 type CommunityDecision,type CommunityDecisionReason} from './phase4-community-model.js';

export type DraftRequest={kind:CommunityDraftKind;text?:string;trigger?:string;match?:ReplyMatch;source?:CommunityReplySource;sourceFaqId?:string;ruleId?:string;topicId?:number;cooldownMs?:number;delayMs?:number;autoMessagesPerMinute?:number;startMinute?:number;endMinute?:number;
 language?:CommunityLanguage;calendar?:CommunityCalendar;clockFormat?:CommunityClockFormat;utcOffsetMinutes?:number;timeZone?:string;
 photoFileId?:string;buttonText?:string;buttonUrl?:string;joinKind?:CommunityJoinKind;leaveKind?:CommunityLeaveKind;};
export interface CommunitySendProposal{
 readonly text:string;readonly chatId:string;readonly actorId:string;
 readonly kind:CommunityEventKind;readonly policyVersion:number;readonly topicId?:number;
 /** Exactly the content/authorization epoch under which the source was read. */
 readonly sourceEpoch:string;
 readonly photoFileId?:string;readonly communityLinks?:CommunityLinkKeyboard;
}
/** Read-only administrative explanation, never stored with student text. */
export type CommunityDiagnostic={status:'REPLIES_DISABLED'|'NO_MATCH'|'QUIET_HOURS'|'SOURCE_UNAVAILABLE'|'LECTURE_MODE'}|
 {status:'RULE_DISABLED'|'TOPIC_MISMATCH';ruleId:string}|
 {status:'MATCH';ruleId:string;preview:string};
const isGroup=(s:string):boolean=>/^-[1-9]\d{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const validNow=(n:number):boolean=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000-120000;
const hex=(s:string):string=>createHash('sha256').update(s,'utf8').digest('hex');
const safe=(t:string):string=>t.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const groupAvailable=(s:BotState,policy:Policy,actorId:string,chatId:string):number=>{
 if(!isGroup(chatId)||!policy.has(s,actorId,'chat.manage',chatId))throw Error('COMMUNITY_OWNER_DENIED');
 const chat=s.chats.filter(c=>c.id===chatId);
 // Remote presence is advisory, not an authorization source. Explicit group
 // owner approval and current scoped grants govern pre-configuration.
 if(chat.length!==1||!chat[0]!.approved||
    !chat[0]!.scopes.includes('navigation')||chat[0]!.version<1)
  throw Error('COMMUNITY_GROUP_UNAVAILABLE');
 return chat[0]!.version;
};
const stateOf=(s:BotState):CommunityAutomationState=>s.phase4Community??emptyCommunityState();
const activeConfig=(s:BotState,chatId:string):CommunityConfig|undefined=>
 stateOf(s).configs.find(c=>c.chatId===chatId);
const configured=(s:BotState,chatId:string):CommunityConfig=>activeConfig(s,chatId)??defaultCommunityConfig(chatId);

export class Phase4CommunityService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}

 async listGroups(actorId:string):Promise<{chatId:string;version:number;configured:boolean}[]>{
  const s=await this.store.snapshot();
  return s.chats.filter(c=>c.approved&&c.id.startsWith('-')&&
    c.scopes.includes('navigation')&&
    s.chats.filter(other=>other.id===c.id).length===1&&
    this.policy.has(s,actorId,'chat.manage',c.id))
   .map(c=>({chatId:c.id,version:c.version,configured:!!activeConfig(s,c.id)}))
   .sort((a,b)=>a.chatId.localeCompare(b.chatId));
 }
 /** The owner can bind only currently approved, visible same-group FAQ entries.
  * Answers and unpublished sources are not displayed or copied into rules. */
 async listReviewedFAQs(actorId:string,chatId:string):Promise<{id:string;question:string}[]>{
  const s=await this.store.snapshot();groupAvailable(s,this.policy,actorId,chatId);
  return s.faqEntries.filter(q=>q.scope===chatId&&q.status==='APPROVED'&&
    reviewedGroupFAQAnswer(s,chatId,q.id)!==null)
   .sort((a,b)=>a.question.localeCompare(b.question)||a.id.localeCompare(b.id))
   .slice(0,200).map(q=>({id:q.id,question:q.question.slice(0,240)}));
 }
 async view(actorId:string,chatId:string):Promise<CommunityConfig>{
  const s=await this.store.snapshot();groupAvailable(s,this.policy,actorId,chatId);
  return structuredClone(configured(s,chatId));
 }
 async pending(actorId:string,request:DraftRequest,chatId:string):Promise<CommunityDraft>{
  const now=this.clock();if(!validNow(now))throw Error('COMMUNITY_CLOCK_INVALID');
  return this.store.transaction(s=>{
   const chatVersion=groupAvailable(s,this.policy,actorId,chatId);
   const current=configured(s,chatId);
   const kind=request.kind;
   // High-impact group profile changes are owner-only, even if a delegated
   // moderator has general chat.manage permission for templates and replies.
   if(['GROUP_PROFILE_ON','GROUP_PROFILE_OFF','GROUP_TITLE_SET','GROUP_PHOTO_SET','GROUP_PHOTO_REMOVE',
     'GUIDE_INTRO_SET','GUIDE_INTRO_CLEAR','GUIDE_TOPICS_SET','GUIDE_TOPICS_CLEAR',
     'GUIDE_SERVICES_SET','GUIDE_SERVICES_CLEAR'].includes(kind)&&
      !this.policy.isOwner(actorId))throw Error('COMMUNITY_OWNER_DENIED');
   if(kind==='GROUP_TITLE_SET'||kind==='GROUP_PHOTO_SET'||kind==='GROUP_PHOTO_REMOVE'){
    if(current.profileEditingEnabled!==true)throw Error('COMMUNITY_PROFILE_DISABLED');
    if(kind==='GROUP_TITLE_SET'&&!validCommunityProfileTitle(request.text))
     throw Error('COMMUNITY_PROFILE_TITLE_INVALID');
    if(kind==='GROUP_PHOTO_SET'&&(!validCommunityPhotoId(request.photoFileId)||request.text!==undefined))
     throw Error('COMMUNITY_PROFILE_PHOTO_INVALID');
    if(kind==='GROUP_PHOTO_REMOVE'&&(request.text!==undefined||request.photoFileId!==undefined))
     throw Error('COMMUNITY_PROFILE_PAYLOAD_INVALID');
    if((s.phase4Community?.profileJobs??[]).some(job=>job.chatId===chatId&&
       (job.status==='SENDING'||job.status==='QUEUED'&&now-job.createdAt<600000)))
     throw Error('COMMUNITY_PROFILE_OPERATION_PENDING');
   }
   if((kind==='WELCOME_TEXT'||kind==='FAREWELL_TEXT'||kind==='REPLY_ADD'&&
     (request.source===undefined||request.source==='NOTE'))&&
      (typeof request.text!=='string'||request.text.trim().length===0))
    throw Error('COMMUNITY_TEMPLATE_REQUIRED');
   if(request.source!==undefined&&kind!=='REPLY_ADD')
    throw Error('COMMUNITY_REPLY_SOURCE_INVALID');
   if(kind==='REPLY_ADD'){
    if(request.source!==undefined&&!['NOTE','RULES','FAQ'].includes(request.source))
     throw Error('COMMUNITY_REPLY_SOURCE_INVALID');
    if(request.source==='FAQ'){
     if(!validCommunityFAQId(request.sourceFaqId)||request.text!==undefined||
      reviewedGroupFAQAnswer(s,chatId,request.sourceFaqId,request.topicId)===null)
      throw Error('COMMUNITY_FAQ_SOURCE_UNAVAILABLE');
    }else if(request.sourceFaqId!==undefined)throw Error('COMMUNITY_REPLY_SOURCE_INVALID');
    if(request.source==='RULES'&&(!validCommunityRulesUrl(current.rulesUrl)||request.text!==undefined))
     throw Error('COMMUNITY_RULES_SOURCE_UNAVAILABLE');
   }
   if(kind==='REPLY_ADD'&&(typeof request.trigger!=='string'||!request.trigger.trim()||
       !['EXACT','WORD','CONTAINS','COMMAND'].includes(request.match??'')))throw Error('COMMUNITY_TRIGGER_REQUIRED');
   if(kind==='WELCOME_VARIANT_SET'||kind==='WELCOME_VARIANT_CLEAR'){
    if(!validCommunityJoinKind(request.joinKind))throw Error('COMMUNITY_JOIN_KIND_INVALID');
    if(kind==='WELCOME_VARIANT_SET'&&(!request.text||!request.text.trim()))
     throw Error('COMMUNITY_TEMPLATE_REQUIRED');
    if(kind==='WELCOME_VARIANT_CLEAR'&&!current.welcomeByJoin?.[request.joinKind])
     throw Error('COMMUNITY_WELCOME_VARIANT_MISSING');
   }
   if(kind==='FAREWELL_VARIANT_SET'||kind==='FAREWELL_VARIANT_CLEAR'){
    if(!validCommunityLeaveKind(request.leaveKind))throw Error('COMMUNITY_LEAVE_KIND_INVALID');
    if(kind==='FAREWELL_VARIANT_SET'&&(!request.text||!request.text.trim()))
     throw Error('COMMUNITY_TEMPLATE_REQUIRED');
    if(kind==='FAREWELL_VARIANT_CLEAR'&&!current.farewellByLeave?.[request.leaveKind])
     throw Error('COMMUNITY_FAREWELL_VARIANT_MISSING');
   }
   if(kind==='REPLY_ADD'&&current.rules.length>=30)throw Error('COMMUNITY_RULE_CAPACITY');
   if(['REPLY_REMOVE','REPLY_ENABLE','REPLY_DISABLE','REPLY_COOLDOWN'].includes(kind)&&
      (!request.ruleId||!current.rules.some(r=>r.id===request.ruleId)))
    throw Error('COMMUNITY_RULE_MISSING');
   if(kind==='AUTO_LIMIT_SET'&&(!Number.isInteger(request.autoMessagesPerMinute)||
      request.autoMessagesPerMinute===undefined||request.autoMessagesPerMinute<1||
      request.autoMessagesPerMinute>8))throw Error('COMMUNITY_AUTO_LIMIT_INVALID');
   if(kind==='REPLY_COOLDOWN'&&(!Number.isInteger(request.cooldownMs)||
      request.cooldownMs===undefined||request.cooldownMs<1000||request.cooldownMs>86400000))
    throw Error('COMMUNITY_COOLDOWN_INVALID');
   if(kind==='QUIET_HOURS_SET'&&(!Number.isInteger(request.startMinute)||
     !Number.isInteger(request.endMinute)||request.startMinute===undefined||request.endMinute===undefined||
     request.startMinute<0||request.endMinute<0||request.startMinute>=1440||
     request.endMinute>=1440||request.startMinute===request.endMinute))
    throw Error('COMMUNITY_QUIET_HOURS_INVALID');
   if(kind==='TOPIC_COOLDOWN_SET'||kind==='TOPIC_COOLDOWN_CLEAR'){
    if(!Number.isSafeInteger(request.topicId)||request.topicId===undefined||
      request.topicId<1||request.topicId>2147483647)
     throw Error('COMMUNITY_TOPIC_INVALID');
    if(kind==='TOPIC_COOLDOWN_SET'&&(!Number.isInteger(request.cooldownMs)||
      request.cooldownMs===undefined||request.cooldownMs<1000||request.cooldownMs>600000))
     throw Error('COMMUNITY_TOPIC_RATE_INVALID');
    if(kind==='TOPIC_COOLDOWN_SET'&&
      !current.topicCooldowns?.some(x=>x.topicId===request.topicId)&&
      (current.topicCooldowns?.length??0)>=30)
     throw Error('COMMUNITY_TOPIC_CAPACITY');
    if(kind==='TOPIC_COOLDOWN_CLEAR'&&
      !current.topicCooldowns?.some(x=>x.topicId===request.topicId))
     throw Error('COMMUNITY_TOPIC_NOT_CONFIGURED');
   }
   if((kind==='SERVICE_CLEANUP_DELAY'||kind==='REPLY_CLEANUP_DELAY')&&(!Number.isInteger(request.delayMs)||
      request.delayMs===undefined||request.delayMs<30000||request.delayMs>3600000))
    throw Error('COMMUNITY_SERVICE_DELAY_INVALID');
   if((kind==='GUIDE_INTRO_SET'||kind==='GUIDE_TOPICS_SET'||kind==='GUIDE_SERVICES_SET')&&
      !validCommunityGuideText(request.text,kind==='GUIDE_INTRO_SET'?320:240))
    throw Error('COMMUNITY_GUIDE_TEXT_INVALID');
   if((kind==='GUIDE_INTRO_CLEAR'||kind==='GUIDE_TOPICS_CLEAR'||
      kind==='GUIDE_SERVICES_CLEAR')&&
      (request.text!==undefined||
       (kind==='GUIDE_INTRO_CLEAR'?current.guideIntro:
        kind==='GUIDE_TOPICS_CLEAR'?current.guideTopics:current.guideServices)===undefined))
    throw Error('COMMUNITY_GUIDE_CLEAR_INVALID');
   if(kind==='RULES_LINK_SET'&&!validCommunityRulesUrl(request.text))
    throw Error('COMMUNITY_RULES_URL_INVALID');
   if((kind==='WELCOME_LOCALIZED'||kind==='FAREWELL_LOCALIZED'||
       kind==='WELCOME_LOCALIZED_CLEAR'||kind==='FAREWELL_LOCALIZED_CLEAR'||
       kind==='GROUP_LANGUAGE')&&
     !['ar','en'].includes(request.language??''))
    throw Error('COMMUNITY_LANGUAGE_INVALID');
   if((kind==='WELCOME_LOCALIZED'||kind==='FAREWELL_LOCALIZED')&&
     (typeof request.text!=='string'||request.text.trim().length===0))
    throw Error('COMMUNITY_LOCALIZED_TEMPLATE_REQUIRED');
   if((kind==='WELCOME_LOCALIZED_CLEAR'||kind==='FAREWELL_LOCALIZED_CLEAR')&&
     (request.text!==undefined||
      !(kind==='WELCOME_LOCALIZED_CLEAR'?current.welcome.localized:
        current.farewell.localized)?.[request.language!]))
    throw Error('COMMUNITY_LOCALIZED_TEMPLATE_MISSING');
   if(kind==='GROUP_CLOCK'&&(!Number.isInteger(request.utcOffsetMinutes)||
     request.utcOffsetMinutes===undefined||request.utcOffsetMinutes< -720||request.utcOffsetMinutes>840||
     !['12','24'].includes(request.clockFormat??'')||
     !['gregorian','hijri'].includes(request.calendar??'')))
    throw Error('COMMUNITY_CLOCK_SETTINGS_INVALID');
   if(kind==='GROUP_TIMEZONE'&&!validCommunityTimeZone(request.timeZone))
     throw Error('COMMUNITY_TIMEZONE_INVALID');
    if(kind==='REPLY_ADD'&&request.match==='COMMAND'&&!/^m_[a-z][a-z0-9_]{0,23}$/u.test(request.trigger??''))
    throw Error('COMMUNITY_COMMAND_INVALID');
   if((kind==='WELCOME_PHOTO_SET'||kind==='FAREWELL_PHOTO_SET')&&
     !validCommunityPhotoId(request.photoFileId))throw Error('COMMUNITY_PHOTO_ID_INVALID');
   if(kind==='WELCOME_BUTTON_ADD'||kind==='FAREWELL_BUTTON_ADD'){
    const target=kind==='WELCOME_BUTTON_ADD'?current.welcome:current.farewell;
    if(!validCommunityLinkButtons([{text:request.buttonText??'',url:request.buttonUrl??''}]))
     throw Error('COMMUNITY_BUTTON_INVALID');
    if((target.buttons?.length??0)>=3)throw Error('COMMUNITY_BUTTON_CAPACITY');
    if(target.buttons?.some(b=>b.url===request.buttonUrl||
      b.text.normalize('NFKC').trim()===request.buttonText?.normalize('NFKC').trim()))
     throw Error('COMMUNITY_BUTTON_DUPLICATE');
   }
   const id=randomBytes(12).toString('hex');
   const draft:CommunityDraft={id,actorId,chatId,chatVersion,configVersion:current.version,kind,
    createdAt:now,expiresAt:now+120000,
    ...(request.text!==undefined?{text:request.text}:{}),
    ...(request.joinKind!==undefined?{joinKind:request.joinKind}:{}),
    ...(request.leaveKind!==undefined?{leaveKind:request.leaveKind}:{}),
    ...(request.trigger!==undefined?{trigger:request.trigger}:{}),
    ...(request.match!==undefined?{match:request.match}:{}),
    ...(request.source!==undefined?{source:request.source}:{}),
    ...(request.sourceFaqId!==undefined?{sourceFaqId:request.sourceFaqId}:{}),
    ...(request.ruleId!==undefined?{ruleId:request.ruleId}:{}),
    ...(request.topicId!==undefined?{topicId:request.topicId}:{}),
    ...(request.cooldownMs!==undefined?{cooldownMs:request.cooldownMs}:{}),
    ...(request.autoMessagesPerMinute!==undefined?{autoMessagesPerMinute:request.autoMessagesPerMinute}:{}),
    ...(request.delayMs!==undefined?{delayMs:request.delayMs}:{}),
    ...(request.startMinute!==undefined?{startMinute:request.startMinute}:{}),
    ...(request.endMinute!==undefined?{endMinute:request.endMinute}:{}),
    ...(request.language!==undefined?{language:request.language}:{}),
    ...(request.clockFormat!==undefined?{clockFormat:request.clockFormat}:{}),
    ...(request.calendar!==undefined?{calendar:request.calendar}:{}),
    ...(request.utcOffsetMinutes!==undefined?{utcOffsetMinutes:request.utcOffsetMinutes}:{}),
     ...(request.timeZone!==undefined?{timeZone:request.timeZone}:{}),
    ...(request.photoFileId!==undefined?{photoFileId:request.photoFileId}:{}),
    ...(request.buttonText!==undefined?{buttonText:request.buttonText}:{}),
    ...(request.buttonUrl!==undefined?{buttonUrl:request.buttonUrl}:{}),
    ...(['GROUP_TITLE_SET','GROUP_PHOTO_SET','GROUP_PHOTO_REMOVE'].includes(kind)?
     {profileEpoch:s.phase4Community?.profileRevisions?.find(x=>x.chatId===chatId)?.revision??0}:{})};
   s.phase4Community??=emptyCommunityState();
   const st=s.phase4Community;
   st.drafts=st.drafts.filter(d=>d.actorId!==actorId&&d.expiresAt>now).slice(-90);
   st.drafts.push(draft);
   return structuredClone(draft);
  });
 }
 async cancel(actorId:string,id:string):Promise<boolean>{
  return this.store.transaction(s=>{
   const st=s.phase4Community;if(!st)return false;
   const draft=st.drafts.find(d=>d.id===id&&d.actorId===actorId);
   if(!draft)return false;
   st.drafts=st.drafts.filter(d=>d!==draft);
   return true;
  });
 }
 async approve(actorId:string,id:string):Promise<CommunityConfig>{
  const now=this.clock();if(!validNow(now))throw Error('COMMUNITY_CLOCK_INVALID');
  return this.store.transaction(s=>{
   const st=s.phase4Community;
   const drafts=st?.drafts.filter(d=>d.id===id)??[];
   if(drafts.length!==1||drafts[0]!.actorId!==actorId)
    throw Error('COMMUNITY_DRAFT_NOT_FOUND');
   const draft=drafts[0]!;
   if(['GROUP_PROFILE_ON','GROUP_PROFILE_OFF','GROUP_TITLE_SET','GROUP_PHOTO_SET','GROUP_PHOTO_REMOVE',
     'GUIDE_INTRO_SET','GUIDE_INTRO_CLEAR','GUIDE_TOPICS_SET','GUIDE_TOPICS_CLEAR',
     'GUIDE_SERVICES_SET','GUIDE_SERVICES_CLEAR'].includes(draft.kind)&&
      !this.policy.isOwner(actorId))throw Error('COMMUNITY_OWNER_DENIED');
   // A stale/expired/unauthorized draft never changes a running policy.
   if(now<draft.createdAt||now>=draft.expiresAt||
      groupAvailable(s,this.policy,actorId,draft.chatId)!==draft.chatVersion)
    throw Error('COMMUNITY_DRAFT_EXPIRED');
   const config=configured(s,draft.chatId);
   if(config.version!==draft.configVersion)throw Error('COMMUNITY_DRAFT_STALE');
   if((draft.kind==='GROUP_TITLE_SET'||draft.kind==='GROUP_PHOTO_SET'||draft.kind==='GROUP_PHOTO_REMOVE')&&
     draft.profileEpoch!==(st?.profileRevisions??[]).find(x=>x.chatId===draft.chatId)?.revision&&
     !(draft.profileEpoch===0&&!(st?.profileRevisions??[]).some(x=>x.chatId===draft.chatId)))
    throw Error('COMMUNITY_PROFILE_DRAFT_STALE');
   switch(draft.kind){
    case 'WELCOME_PHOTO_SET':config.welcome.photoFileId=draft.photoFileId!;break;
    case 'WELCOME_PHOTO_CLEAR':delete config.welcome.photoFileId;break;
    case 'FAREWELL_PHOTO_SET':config.farewell.photoFileId=draft.photoFileId!;break;
    case 'FAREWELL_PHOTO_CLEAR':delete config.farewell.photoFileId;break;
    case 'WELCOME_BUTTON_ADD':
    case 'FAREWELL_BUTTON_ADD':{
     const target=draft.kind==='WELCOME_BUTTON_ADD'?config.welcome:config.farewell;
     const newButton={text:draft.buttonText!,url:draft.buttonUrl!};
     if((target.buttons?.length??0)>=3||
       target.buttons?.some(b=>b.url===newButton.url||
         b.text.normalize('NFKC').trim()===newButton.text.normalize('NFKC').trim()))
      throw Error('COMMUNITY_BUTTON_DUPLICATE');
     target.buttons=[...target.buttons??[],newButton];
     break;
    }
    case 'WELCOME_BUTTONS_CLEAR':delete config.welcome.buttons;break;
    case 'FAREWELL_BUTTONS_CLEAR':delete config.farewell.buttons;break;
    case 'WELCOME_LOCALIZED':
     config.welcome.localized={...config.welcome.localized,[draft.language!]:draft.text!};break;
    case 'FAREWELL_LOCALIZED':
     config.farewell.localized={...config.farewell.localized,[draft.language!]:draft.text!};break;
    case 'WELCOME_LOCALIZED_CLEAR':{
     const keep={...config.welcome.localized};delete keep[draft.language!];
     if(Object.keys(keep).length)config.welcome.localized=keep;
     else delete config.welcome.localized;
     break;
    }
    case 'FAREWELL_LOCALIZED_CLEAR':{
     const keep={...config.farewell.localized};delete keep[draft.language!];
     if(Object.keys(keep).length)config.farewell.localized=keep;
     else delete config.farewell.localized;
     break;
    }
    case 'GROUP_LANGUAGE':config.language=draft.language!;break;
     case 'GROUP_TIMEZONE':config.timeZone=draft.timeZone!;break;
     case 'GROUP_TIMEZONE_CLEAR':delete config.timeZone;break;
    case 'GROUP_CLOCK':
     config.utcOffsetMinutes=draft.utcOffsetMinutes!;
     config.clockFormat=draft.clockFormat!;
     config.calendar=draft.calendar!;break;
    case 'GUIDE_INTRO_SET':config.guideIntro=draft.text!;break;
    case 'GUIDE_INTRO_CLEAR':delete config.guideIntro;break;
    case 'GUIDE_TOPICS_SET':config.guideTopics=draft.text!;break;
    case 'GUIDE_TOPICS_CLEAR':delete config.guideTopics;break;
    case 'GUIDE_SERVICES_SET':config.guideServices=draft.text!;break;
    case 'GUIDE_SERVICES_CLEAR':delete config.guideServices;break;
    case 'RULES_LINK_SET':config.rulesUrl=draft.text!;break;
    case 'RULES_LINK_CLEAR':delete config.rulesUrl;break;
    case 'WELCOME_TEXT':config.welcome.text=draft.text!;break;
    case 'WELCOME_VARIANT_SET':
     config.welcomeByJoin={...config.welcomeByJoin,[draft.joinKind!]:draft.text!};break;
    case 'WELCOME_VARIANT_CLEAR':{
     const kept={...config.welcomeByJoin};delete kept[draft.joinKind!];
     if(Object.keys(kept).length)config.welcomeByJoin=kept;
     else delete config.welcomeByJoin;
     break;
    }
    case 'FAREWELL_TEXT':config.farewell.text=draft.text!;break;
    case 'FAREWELL_VARIANT_SET':
     config.farewellByLeave={...config.farewellByLeave,[draft.leaveKind!]:draft.text!};break;
    case 'FAREWELL_VARIANT_CLEAR':{
     const kept={...config.farewellByLeave};delete kept[draft.leaveKind!];
     if(Object.keys(kept).length)config.farewellByLeave=kept;
     else delete config.farewellByLeave;
     break;
    }
    case 'FAREWELL_REMOVED_ON':config.farewellOnRemoval=true;break;
    case 'FAREWELL_REMOVED_OFF':config.farewellOnRemoval=false;break;
    case 'WELCOME_ON':config.welcome.enabled=true;break;
    case 'PRIVATE_WELCOME_ON':config.privateWelcomeEnabled=true;break;
    case 'PRIVATE_WELCOME_OFF':config.privateWelcomeEnabled=false;break;
    case 'WELCOME_MEMBER_LANG_ON':config.welcomeMemberLanguageEnabled=true;break;
    case 'WELCOME_MEMBER_LANG_OFF':config.welcomeMemberLanguageEnabled=false;break;
    case 'WELCOME_OFF':config.welcome.enabled=false;break;
    case 'FAREWELL_ON':config.farewell.enabled=true;break;
    case 'FAREWELL_OFF':config.farewell.enabled=false;break;
    case 'REPLIES_ON':config.repliesEnabled=true;break;
    case 'REPLIES_OFF':config.repliesEnabled=false;break;
    case 'GROUP_PROFILE_ON':config.profileEditingEnabled=true;break;
    case 'GROUP_PROFILE_OFF':config.profileEditingEnabled=false;break;
    case 'GROUP_TITLE_SET':case 'GROUP_PHOTO_SET':case 'GROUP_PHOTO_REMOVE':{
     if(config.profileEditingEnabled!==true)throw Error('COMMUNITY_PROFILE_DISABLED');
     if(draft.kind==='GROUP_TITLE_SET'&&!validCommunityProfileTitle(draft.text))
      throw Error('COMMUNITY_PROFILE_TITLE_INVALID');
     if(draft.kind==='GROUP_PHOTO_SET'&&!validCommunityPhotoId(draft.photoFileId))
      throw Error('COMMUNITY_PROFILE_PHOTO_INVALID');
     if((st?.profileJobs??[]).some(j=>j.chatId===draft.chatId&&
       (j.status==='SENDING'||j.status==='QUEUED'&&now-j.createdAt<600000)))
      throw Error('COMMUNITY_PROFILE_OPERATION_PENDING');
     break;
    }
    case 'CHANGE_LOG_ON':config.changeLogEnabled=true;break;
    case 'CHANGE_LOG_OFF':
     config.changeLogEnabled=false;
     // Disabling the opt-in audit also erases the group's stored history.
     // Internal edit-fencing observations remain opaque and independent.
     st!.serviceChanges=(st!.serviceChanges??[]).filter(x=>x.chatId!==config.chatId);
     break;
    case 'DECISION_LOG_ON':config.decisionLogEnabled=true;break;
    case 'DECISION_LOG_OFF':
     config.decisionLogEnabled=false;
     st!.decisionLog=(st!.decisionLog??[]).filter(x=>x.chatId!==config.chatId);
     break;
    case 'SERVICE_CLEANUP_ON':config.serviceCleanup={...config.serviceCleanup??{delayMs:120000},enabled:true};break;
    case 'SERVICE_CLEANUP_OFF':config.serviceCleanup={...config.serviceCleanup??{delayMs:120000},enabled:false};break;
    case 'SERVICE_CLEANUP_DELAY':config.serviceCleanup={...config.serviceCleanup??{enabled:false},delayMs:draft.delayMs!};break;
    case 'SERVICE_JOIN_ON':case 'SERVICE_JOIN_OFF':
     config.serviceCleanup={...config.serviceCleanup??{enabled:false,delayMs:120000},
      joinEnabled:draft.kind==='SERVICE_JOIN_ON'};break;
    case 'SERVICE_LEAVE_ON':case 'SERVICE_LEAVE_OFF':
     config.serviceCleanup={...config.serviceCleanup??{enabled:false,delayMs:120000},
      leaveEnabled:draft.kind==='SERVICE_LEAVE_ON'};break;
    case 'SERVICE_PROFILE_ON':case 'SERVICE_PROFILE_OFF':
     config.serviceCleanup={...config.serviceCleanup??{enabled:false,delayMs:120000},
      profileEnabled:draft.kind==='SERVICE_PROFILE_ON'};break;
    case 'AUTO_LIMIT_SET':config.autoMessagesPerMinute=draft.autoMessagesPerMinute!;break;
    case 'REPLY_CLEANUP_ON':config.replyCleanup={...config.replyCleanup??{delayMs:120000},enabled:true};break;
    case 'REPLY_CLEANUP_OFF':config.replyCleanup={...config.replyCleanup??{delayMs:120000},enabled:false};break;
    case 'REPLY_CLEANUP_DELAY':config.replyCleanup={...config.replyCleanup??{enabled:false},delayMs:draft.delayMs!};break;
    case 'REPLY_REMOVE':config.rules=config.rules.filter(r=>r.id!==draft.ruleId);break;
    case 'REPLY_ENABLE':config.rules.find(r=>r.id===draft.ruleId)!.enabled=true;break;
    case 'REPLY_DISABLE':config.rules.find(r=>r.id===draft.ruleId)!.enabled=false;break;
    case 'REPLY_COOLDOWN':config.rules.find(r=>r.id===draft.ruleId)!.cooldownMs=draft.cooldownMs!;break;
    case 'QUIET_HOURS_SET':config.quietHours={startMinute:draft.startMinute!,endMinute:draft.endMinute!};break;
    case 'QUIET_HOURS_CLEAR':delete config.quietHours;break;
    case 'TOPIC_COOLDOWN_SET':{
     const kept=(config.topicCooldowns??[]).filter(r=>r.topicId!==draft.topicId);
     config.topicCooldowns=[...kept,{topicId:draft.topicId!,cooldownMs:draft.cooldownMs!}]
      .sort((a,b)=>a.topicId-b.topicId);
     break;
    }
    case 'TOPIC_COOLDOWN_CLEAR':{
     config.topicCooldowns=(config.topicCooldowns??[]).filter(r=>r.topicId!==draft.topicId);
     if(!config.topicCooldowns.length)delete config.topicCooldowns;
     break;
    }
    case 'REPLY_ADD':{
     if(draft.source==='FAQ'&&reviewedGroupFAQAnswer(s,draft.chatId,draft.sourceFaqId!,draft.topicId)===null)
      throw Error('COMMUNITY_FAQ_SOURCE_UNAVAILABLE');
     if(draft.source==='RULES'&&!validCommunityRulesUrl(config.rulesUrl))
      throw Error('COMMUNITY_RULES_SOURCE_UNAVAILABLE');
     const same=config.rules.some(r=>r.match===draft.match&&r.topicId===draft.topicId&&
       normalizeCommunityMatch(r.trigger)===normalizeCommunityMatch(draft.trigger!));
     if(same)throw Error('COMMUNITY_RULE_DUPLICATE');
     config.rules.push({id:randomBytes(6).toString('hex'),trigger:draft.trigger!,
      response:draft.source==='FAQ'?'إجابة معتمدة من الأسئلة الشائعة':
       draft.source==='RULES'?'قوانين المجموعة: {رابط_القوانين}':draft.text!,
      match:draft.match!,enabled:true,cooldownMs:60000,
      ...(draft.source?{source:draft.source}:{}),
      ...(draft.sourceFaqId?{sourceFaqId:draft.sourceFaqId}:{}),
      ...(draft.topicId!==undefined?{topicId:draft.topicId}:{})});
     break;
    }
   }
   config.version++;
   if(!validCommunityConfig(config))throw Error('COMMUNITY_CONFIG_INVALID');
   if(draft.kind==='GROUP_TITLE_SET'||draft.kind==='GROUP_PHOTO_SET'||draft.kind==='GROUP_PHOTO_REMOVE'){
    st!.profileJobs=(st!.profileJobs??[]).filter(j=>
      j.status==='QUEUED'||j.status==='SENDING'||now-j.createdAt<7*86400000).slice(-499);
    st!.profileJobs.push({key:randomBytes(12).toString('hex'),chatId:draft.chatId,
     chatVersion:draft.chatVersion,policyVersion:config.version,
     profileEpoch:st!.profileRevisions?.find(x=>x.chatId===draft.chatId)?.revision??0,
     kind:draft.kind==='GROUP_TITLE_SET'?'TITLE_SET':draft.kind==='GROUP_PHOTO_SET'?'PHOTO_SET':'PHOTO_REMOVE',
     status:'QUEUED',createdAt:now,
     ...(draft.kind==='GROUP_TITLE_SET'?{title:draft.text!}:{}),
     ...(draft.kind==='GROUP_PHOTO_SET'?{photoFileId:draft.photoFileId!}:{})});
   }
   st!.configs=st!.configs.filter(c=>c.chatId!==config.chatId);
   st!.configs.push(config);
   st!.drafts=st!.drafts.filter(d=>d.actorId!==actorId);
   s.audit.push({updateKey:'p4-community:'+draft.id,actorId,decision:'ALLOW',
    reason:'COMMUNITY_'+draft.kind,policyVersion:config.version,at:now});
   return structuredClone(config);
  });
 }
 /** A trusted Telegram service event, never an input command.
  * Keep only event kind, irreversible hash of opaque update/actor keys and a
  * bounded one-shot deletion intent, never names, titles or photo file ids.
  */
 async recordServiceEvent(input:{
   chatId:string;actorId:string;messageId:number;kind:CommunityServiceKind;
   updateKey:string;sentAtMs?:number;
 }):Promise<boolean>{
  const now=this.clock();
  if(!validNow(now)||!isGroup(input.chatId)||
     !/^[1-9]\d{0,15}$/u.test(input.actorId)||
     !Number.isSafeInteger(input.messageId)||input.messageId<1||input.messageId>2147483647||
     !/^b3-webhook:[A-Za-z0-9_-]{1,80}:\d+$/u.test(input.updateKey)||
     !['JOIN','LEAVE','TITLE_CHANGED','PHOTO_CHANGED','PHOTO_REMOVED'].includes(input.kind))
   return false;
  // Never delete old messages from replayed or delayed updates. Legitimate
  // Telegram date is validated by the event parser, but may be absent in tests.
  if(input.sentAtMs!==undefined&&(!Number.isSafeInteger(input.sentAtMs)||
    input.sentAtMs>now+60000||now-input.sentAtMs>900000))return false;
  return this.store.transaction(s=>{
   if(!this.policy.canUseChat(s,input.chatId,'navigation')||
      s.chats.filter(x=>x.id===input.chatId&&x.approved).length!==1)return false;
   const config=activeConfig(s,input.chatId);
   if(!config||!validCommunityConfig(config))return false;
   const isChange=input.kind!=='JOIN'&&input.kind!=='LEAVE';
   const shouldLog=isChange&&config.changeLogEnabled===true;
   const shouldObserve=isChange&&config.profileEditingEnabled===true;
   const shouldClean=config.serviceCleanup?.enabled===true&&
    (input.kind==='JOIN'?config.serviceCleanup.joinEnabled!==false:
     input.kind==='LEAVE'?config.serviceCleanup.leaveEnabled!==false:
      config.serviceCleanup.profileEnabled!==false);
   if(!shouldLog&&!shouldClean&&!shouldObserve)return false;
   const chat=s.chats.find(x=>x.id===input.chatId)!;
   const key=hex('P4:SERVICE:'+input.updateKey),actorDigest=hex('P4:SERVICE:ACTOR:'+input.chatId+':'+input.actorId);
   const messageDigest=hex('P4:SERVICE:MESSAGE:'+input.chatId+':'+input.messageId);
   s.phase4Community??=emptyCommunityState();
   const state=s.phase4Community;
   let recorded=false;
   if(shouldObserve){
    state.profileObservations=(state.profileObservations??[]).filter(x=>
      x.at<=now&&now-x.at<7*86400000);
    if(!state.profileObservations.some(x=>x.key===key||x.messageDigest===messageDigest)){
     state.profileObservations=[...state.profileObservations.slice(-999),
      {key,chatId:input.chatId,at:now,messageDigest}];
     state.profileRevisions??=[];
     const rev=state.profileRevisions.find(x=>x.chatId===input.chatId);
     if(rev){
      if(rev.revision<2_000_000_000)rev.revision++;
      else throw Error('COMMUNITY_PROFILE_REVISION_EXHAUSTED');
      rev.lastKey=key;
     }else state.profileRevisions.push({chatId:input.chatId,revision:1,lastKey:key});
     recorded=true;
    }
   }
   if(shouldLog){
    state.serviceChanges=(state.serviceChanges??[]).filter(x=>now-x.at<7*86400000);
    if(!state.serviceChanges.some(x=>x.key===key||x.messageDigest===messageDigest)){
     const kind=input.kind as CommunityServiceChange['kind'];
     state.serviceChanges=[...state.serviceChanges.slice(-999),
      {key,chatId:input.chatId,kind,actorDigest,at:now,messageDigest}];
     recorded=true;
    }
   }
   if(shouldClean){
    state.cleanupJobs=(state.cleanupJobs??[]).filter(x=>
      x.status==='QUEUED'||x.status==='SENDING'||now-x.observedAt<7*86400000);
    if(state.cleanupJobs.length>=1000)return recorded;
    if(!state.cleanupJobs.some(x=>x.key===key||
      x.chatId===input.chatId&&x.messageId===input.messageId)){
     state.cleanupJobs.push({key,chatId:input.chatId,messageId:input.messageId,kind:input.kind,
       chatVersion:chat.version,policyVersion:config.version,observedAt:now,
       dueAt:now+config.serviceCleanup!.delayMs,status:'QUEUED'});
     recorded=true;
    }
   }
   return recorded;
  });
 }
 /** Owner-only, bounded seven-day history without raw student content. */
 /** A member explicitly opens the bot's private chat, after a fresh external
  * membership check. Local join proof is short-lived; never send unsolicited DMs.
  * The opaque receipt claim is consumed at most once even on an unknown send.
  */
 async claimPrivateWelcome(actorId:string,chatId:string,memberName:string):Promise<string|null>{
  const now=this.clock();
  if(!validNow(now)||!isGroup(chatId)||!/^[1-9]\d{0,15}$/u.test(actorId)||
      !Number.isSafeInteger(Number(actorId))||typeof memberName!=='string'||
      memberName.length>200)return null;
  return this.store.transaction(s=>{
   const config=activeConfig(s,chatId),st=s.phase4Community;
   if(!config||!validCommunityConfig(config)||!config.welcome.enabled||
      config.privateWelcomeEnabled!==true||!st||
      !this.policy.canUseChat(s,chatId,'navigation')||
      s.chats.filter(c=>c.id===chatId&&c.approved).length!==1)return null;
   const actorDigest=hex('P4:ACTOR:'+chatId+':'+actorId);
   const join=st.receipts.filter(x=>x.kind==='JOIN'&&x.chatId===chatId&&
      x.actorDigest===actorDigest&&x.at<=now&&now-x.at<=900000)
      .sort((a,b)=>b.at-a.at)[0];
   if(!join)return null;
   const claims=st.privateWelcomes??[];
   if(claims.some(x=>x.chatId===chatId&&x.joinKey===join.key&&
      x.actorDigest===actorDigest))return null;
   const input:CommunityInput={kind:'JOIN',chatId,actorId,memberName,
      groupName:'مجموعة منارتك',...(join.joinKind?{joinKind:join.joinKind}:{})};
   let text:string;
   try{text=renderCommunityTemplate(selectCommunityGreeting(config,'welcome',join.joinKind),
     input,now+(config.timeZone?0:config.utcOffsetMinutes*60000),config.rulesUrl??'',
     {language:config.language??'ar',clockFormat:config.clockFormat??'24',
      calendar:config.calendar??'gregorian',...(config.timeZone?{timeZone:config.timeZone}:{})});}
   catch{return null;}
   if(Buffer.byteLength(text,'utf8')>4096)return null;
   st.privateWelcomes=[...claims.filter(x=>x.at<=now&&now-x.at<86400000)
     .slice(-2499),{joinKey:join.key,chatId,actorDigest,at:now}];
   return text;
  });
 }
 async recentDecisions(actorId:string,chatId:string):Promise<CommunityDecision[]>{
  const s=await this.store.snapshot();groupAvailable(s,this.policy,actorId,chatId);
  const config=configured(s,chatId),now=this.clock();
  if(!validNow(now))throw Error('COMMUNITY_CLOCK_INVALID');
  if(!validCommunityConfig(config)||config.decisionLogEnabled!==true)return [];
  return structuredClone((s.phase4Community?.decisionLog??[]).filter(x=>x.chatId===chatId&&
   x.at<=now&&now-x.at<7*86400000).slice(-20).reverse());
 }
 /** Never show a title payload in operation history, even to the owner. */
 async recentProfileOperations(actorId:string,chatId:string):Promise<
  {kind:'TITLE_SET'|'PHOTO_SET'|'PHOTO_REMOVE';status:string;createdAt:number}[]>{
  const s=await this.store.snapshot();groupAvailable(s,this.policy,actorId,chatId);
  const now=this.clock();
  return (s.phase4Community?.profileJobs??[]).filter(x=>x.chatId===chatId&&
    x.createdAt<=now&&now-x.createdAt<7*86400000).slice(-10).reverse()
   .map(x=>({kind:x.kind,status:x.status,createdAt:x.createdAt}));
 }
 async recentChanges(actorId:string,chatId:string):Promise<CommunityServiceChange[]>{
  const state=await this.store.snapshot();
  groupAvailable(state,this.policy,actorId,chatId);
  const now=this.clock();
  return structuredClone((state.phase4Community?.serviceChanges??[]).filter(x=>x.chatId===chatId&&
    x.at<=now&&now-x.at<7*86400000).slice(-20).reverse());
 }
 /** Owner-only, side-effect-free dry run for a supplied sample message.
  * Never persists the query, consumes quotas or asks Telegram for a member.
  */
 async diagnose(actorId:string,chatId:string,sample:string,topicId?:number):Promise<CommunityDiagnostic>{
  const state=await this.store.snapshot();
  groupAvailable(state,this.policy,actorId,chatId);
  if(typeof sample!=='string'||sample.length===0||sample.length>4096||
    (topicId!==undefined&&(!Number.isSafeInteger(topicId)||topicId<1||topicId>2147483647)))
   throw Error('COMMUNITY_SAMPLE_INVALID');
  const config=configured(state,chatId);
  if(!validCommunityConfig(config))throw Error('COMMUNITY_CONFIG_INVALID');
  if(lectureBlocksAutomation(state,chatId,this.clock()))return {status:'LECTURE_MODE'};
  if(!config.repliesEnabled)return {status:'REPLIES_DISABLED'};
  if(config.quietHours&&inCommunityQuietHours(config.quietHours,this.clock(),config.utcOffsetMinutes,config.timeZone))
   return {status:'QUIET_HOURS'};
  const rule=selectCommunityRule(config,sample,topicId);
  if(!rule){
   // Diagnose disabled and topic-scoped matches without consuming quota.
   if(!/^@\w+/u.test(sample.trimStart())){
    const isCommand=sample.trimStart().startsWith('/');
    const candidates=config.rules.filter(r=>
     (isCommand?r.match==='COMMAND':r.match!=='COMMAND')&&matchCommunityRule(r,sample));
    const disabled=candidates.find(r=>!r.enabled&&(r.topicId===undefined||r.topicId===topicId));
    if(disabled)return {status:'RULE_DISABLED',ruleId:disabled.id};
    const wrongTopic=candidates.find(r=>r.enabled&&r.topicId!==undefined&&r.topicId!==topicId);
    if(wrongTopic)return {status:'TOPIC_MISMATCH',ruleId:wrongTopic.id};
   }
   return {status:'NO_MATCH'};
  }
  const now=this.clock();
  if(!validNow(now))throw Error('COMMUNITY_CLOCK_INVALID');
  const input:CommunityInput={kind:'TEXT',chatId,actorId:'1',
   memberName:'الطالب التجريبي',groupName:'مجموعة منارتك التجريبية',
   messageText:sample,...(topicId!==undefined?{topicId}:{})};
  const resolved=resolvedCommunityReply(state,config,rule,topicId);
  if(!resolved)return {status:'SOURCE_UNAVAILABLE'};
  return {status:'MATCH',ruleId:rule.id,
   preview:resolved.escaped?resolved.template:
    renderCommunityTemplate(resolved.template,input,
     now+(config.timeZone?0:config.utcOffsetMinutes*60000),config.rulesUrl??'',
     {language:config.language??'ar',clockFormat:config.clockFormat??'24',
      calendar:config.calendar??'gregorian',...(config.timeZone?{timeZone:config.timeZone}:{})})};
 }
 /** Atomically applies quotas and reserves an outbound event exactly once.
  * A reservation is at-most-once: its provider outcome is managed separately
  * by the existing Telegram reply ledger, never retried blindly.
  */
 async propose(input:CommunityInput,updateKey:string):Promise<CommunitySendProposal|null>{
  const now=this.clock();
  if(!validNow(now)||!isGroup(input.chatId)||
   !/^[1-9]\d{0,15}$/u.test(input.actorId)||
   !/^b3-webhook:[A-Za-z0-9_-]{1,80}:\d+$/u.test(updateKey)||
   input.edited||input.forwarded||input.fromBot||
   (input.joinKind!==undefined&&(input.kind!=='JOIN'||!validCommunityJoinKind(input.joinKind)))||
   (input.memberLanguage!==undefined&&
     (input.kind!=='JOIN'||!['ar','en'].includes(input.memberLanguage)))||
   (input.leaveKind!==undefined&&(input.kind!=='LEAVE'||!validCommunityLeaveKind(input.leaveKind))))return null;
  if(input.kind==='TEXT'&&(!input.messageText||input.messageText.length>4096))return null;
  const key=hex('P4:EVENT:'+updateKey);
  return this.store.transaction(s=>{
   const config=activeConfig(s,input.chatId);
   if(!config||!validCommunityConfig(config)||
      !this.policy.canUseChat(s,input.chatId,'navigation')||
      s.chats.filter(c=>c.id===input.chatId&&c.approved).length!==1)return null;
   const record=(reason:CommunityDecisionReason,ruleId?:string):void=>{
    if(config.decisionLogEnabled!==true)return;
    s.phase4Community??=emptyCommunityState();
    const previous=(s.phase4Community.decisionLog??[]).filter(x=>
     x.at<=now&&now-x.at<7*86400000);
    if(previous.some(x=>x.key===key))return;
    // The decision code and revision are enough to explain a decision;
    // never persist the student's ID, name, message or group title.
    s.phase4Community.decisionLog=[...previous.slice(-999),
     {key,chatId:input.chatId,at:now,kind:input.kind,configVersion:config.version,
      reason,...(ruleId?{ruleId}:{})}];
   };
   // A denied update must not generate repeat log entries on webhook replay.
   if(config.decisionLogEnabled&&stateOf(s).decisionLog?.some(x=>x.key===key))return null;
   // The pause is read at the proposal's atomic reservation boundary.
   // No protection/verification settings or welcome templates are changed.
   if(lectureBlocksAutomation(s,input.chatId,now)){
    record('LECTURE_MODE');return null;
   }
   let template:string,ruleId:string|undefined,preEscaped=false;
   let photoFileId:string|undefined,communityLinks:CommunityLinkKeyboard|undefined;
   if(input.kind==='JOIN'||input.kind==='LEAVE'){
    const target=input.kind==='JOIN'?config.welcome:config.farewell;
    if(!target.enabled){
     record(input.kind==='JOIN'?'WELCOME_DISABLED':'FAREWELL_DISABLED');return null;
    }
    if(input.kind==='LEAVE'&&input.leaveKind==='REMOVED'&&config.farewellOnRemoval!==true){
     record('REMOVAL_SUPPRESSED');return null;
    }
    template=selectCommunityGreeting(config,input.kind==='JOIN'?'welcome':'farewell',
     input.kind==='JOIN'?input.joinKind:undefined,
     input.kind==='LEAVE'?input.leaveKind:undefined,
     input.kind==='JOIN'?input.memberLanguage:undefined);
    photoFileId=target.photoFileId;
    communityLinks=communityLinkKeyboard(target.buttons);
   }else{
    if(!config.repliesEnabled){record('REPLIES_DISABLED');return null;}
    if(config.quietHours&&inCommunityQuietHours(config.quietHours,now,config.utcOffsetMinutes,config.timeZone)){
     record('QUIET_HOURS');return null;
    }
    const rule=selectCommunityRule(config,input.messageText!,input.topicId);
    if(!rule){record('NO_MATCH');return null;}
    const resolved=resolvedCommunityReply(s,config,rule,input.topicId);
    if(!resolved){record('SOURCE_UNAVAILABLE',rule.id);return null;}
    template=resolved.template;preEscaped=resolved.escaped===true;ruleId=rule.id;
   }
   const actorDigest=hex('P4:ACTOR:'+input.chatId+':'+input.actorId);
   const existing=stateOf(s).receipts;
   if(existing.some(x=>x.key===key))return null;
   if(existing.some(x=>x.chatId===input.chatId&&x.at>now)){
    record('CLOCK_SKEW');return null;
   }
   const active=existing.filter(x=>x.at>now-86400000);
   const inGroup=active.filter(x=>x.chatId===input.chatId);
   if(inGroup.filter(x=>x.at>now-60000).length>=(config.autoMessagesPerMinute??8)){
    record('GROUP_LIMIT',ruleId);return null;
   }
   const topicRate=input.kind==='TEXT'&&input.topicId!==undefined?
    config.topicCooldowns?.find(x=>x.topicId===input.topicId)?.cooldownMs:undefined;
   // Per-topic overrides do not bypass the global 8/minute cap.
   if(topicRate!==undefined?
     inGroup.some(x=>x.kind==='TEXT'&&x.topicId===input.topicId&&now-x.at<topicRate):
     inGroup.some(x=>now-x.at<config.groupCooldownMs)){
    record(topicRate===undefined?'GROUP_COOLDOWN':'TOPIC_COOLDOWN',ruleId);return null;
   }
   const actorPeriod=ruleId?config.rules.find(x=>x.id===ruleId)!.cooldownMs:600000;
   if(inGroup.some(x=>x.actorDigest===actorDigest&&x.kind===input.kind&&
       x.ruleId===ruleId&&now-x.at<actorPeriod)){
    record('ACTOR_COOLDOWN',ruleId);return null;
   }
   let text:string;
   try{text=preEscaped?template:renderCommunityTemplate(template,input,
     now+(config.timeZone?0:config.utcOffsetMinutes*60000),config.rulesUrl??'',
     {language:input.kind==='JOIN'&&config.welcomeMemberLanguageEnabled===true&&
       input.memberLanguage?input.memberLanguage:config.language??'ar',
      clockFormat:config.clockFormat??'24',
      calendar:config.calendar??'gregorian',...(config.timeZone?{timeZone:config.timeZone}:{})});}
   catch{record('TEMPLATE_INVALID',ruleId);return null;}
   if(photoFileId&&Buffer.byteLength(text,'utf8')>1024){
    record('CAPTION_LIMIT',ruleId);return null;
   }
   const receipt={key,chatId:input.chatId,at:now,kind:input.kind,actorDigest,
    ...(ruleId?{ruleId}:{}),...(input.topicId!==undefined?{topicId:input.topicId}:{}),
    ...(input.kind==='JOIN'&&input.joinKind?{joinKind:input.joinKind}:{}),
    ...(input.kind==='LEAVE'&&input.leaveKind?{leaveKind:input.leaveKind}:{})};
   s.phase4Community??=emptyCommunityState();
   s.phase4Community.receipts=[...active.slice(-2499),receipt];
   // Reserved means local intent only; the Telegram send may subsequently fail.
   record('RESERVED',ruleId);
   return {text,chatId:input.chatId,actorId:input.actorId,kind:input.kind,
    policyVersion:config.version,sourceEpoch:groupMenuEpochDigest(s,input.chatId,input.topicId),...(input.topicId!==undefined?{topicId:input.topicId}:{}),
    ...(photoFileId?{photoFileId}:{}),
    ...(communityLinks?{communityLinks}:{})};
  });
 }
 /** Preview never calls the Telegram gateway, writes a send or records a vote. */
 preview(draft:CommunityDraft):string{
  const clean=(x:string)=>safe(x.slice(0,250));
  if(draft.kind==='GUIDE_INTRO_SET'||draft.kind==='GUIDE_TOPICS_SET'||draft.kind==='GUIDE_SERVICES_SET')
   return '<b>معاينة '+(draft.kind==='GUIDE_INTRO_SET'?'تعريف المجموعة':
    draft.kind==='GUIDE_TOPICS_SET'?'مجالات الدراسة':'خدمات المجموعة')+
    ' — دليل العضو الجديد</b>\n'+safe(draft.text??'')+
    '\n\nهذا النص لن يظهر للطلاب حتى اعتماد المالك. لا ينشر تلقائيًا.';
  if(draft.kind==='GUIDE_INTRO_CLEAR'||draft.kind==='GUIDE_TOPICS_CLEAR'||draft.kind==='GUIDE_SERVICES_CLEAR')
   return '<b>مسح '+(draft.kind==='GUIDE_INTRO_CLEAR'?'تعريف المجموعة':
    draft.kind==='GUIDE_TOPICS_CLEAR'?'مجالات الدراسة':'خدمات المجموعة')+
    '</b>\nسيعود الدليل إلى محتواه الافتراضي بعد الاعتماد.';
  if(draft.kind==='WELCOME_PHOTO_SET'||draft.kind==='FAREWELL_PHOTO_SET')
   return '<b>معاينة صورة '+(draft.kind==='WELCOME_PHOTO_SET'?'الترحيب':'الوداع')+
    '</b>\nمعرّف صورة تيليجرام محفوظ بصورة خاصة بالمالك؛ لن تُرسل قبل التفعيل.'+
    '\nالتحقق من وجود الملف يتم بواسطة Telegram عند إرسال الرسالة.';
  if(draft.kind==='WELCOME_PHOTO_CLEAR'||draft.kind==='FAREWELL_PHOTO_CLEAR')
   return '<b>حذف صورة '+(draft.kind==='WELCOME_PHOTO_CLEAR'?'الترحيب':'الوداع')+
    '</b>\nسيعود البوت لإرسال قالب نصي.';
  if(draft.kind==='WELCOME_BUTTON_ADD'||draft.kind==='FAREWELL_BUTTON_ADD')
   return '<b>معاينة زر رابط '+(draft.kind==='WELCOME_BUTTON_ADD'?'الترحيب':'الوداع')+
    '</b>\nالاسم: '+clean(draft.buttonText??'')+
    '\nالوجهة: '+clean(draft.buttonUrl??'')+'\nزر رابط فقط؛ لا يستدعي أمرًا داخل البوت.';
  if(draft.kind==='WELCOME_BUTTONS_CLEAR'||draft.kind==='FAREWELL_BUTTONS_CLEAR')
   return '<b>حذف جميع أزرار الرابط</b> من '+(draft.kind==='WELCOME_BUTTONS_CLEAR'?'الترحيب':'الوداع');
  if(draft.kind==='PRIVATE_WELCOME_ON')return 'تفعيل رابط ترحيب خاص اختياري بعد الانضمام.\nلا يرسل البوت رسالة للعضو دون فتحه الخاص بنفسه؛ يتطلب عضوية حقيقية وانضمامًا حديثًا.\nالرسالة العامة ما تزال ظاهرة لأعضاء المجموعة.';
  if(draft.kind==='PRIVATE_WELCOME_OFF')return 'إيقاف رابط الترحيب الخاص وإبطال رسائل الخاص المعلقة ذات الإعداد القديم.\nلا يعطل الترحيب العام.';
  if(draft.kind==='WELCOME_MEMBER_LANG_ON')return 'تفعيل لغة ترحيب العضو عند توفر لغة عربية أو إنجليزية موثوقة من Telegram.\nعند عدم توفرها تُستخدم لغة المجموعة، وتبقى قوالب أنواع الدخول أعلى أولوية.';
  if(draft.kind==='WELCOME_MEMBER_LANG_OFF')return 'إيقاف اختيار لغة الترحيب حسب العضو والعودة إلى لغة المجموعة المعتمدة.';
  if(draft.kind==='FAREWELL_VARIANT_SET')return '<b>معاينة وداع حسب المغادرة: '+
   safe(draft.leaveKind??'')+'</b>\n'+safe(draft.text??'')+'\nلن يُرسل حتى تفعيل الوداع.';
  if(draft.kind==='FAREWELL_VARIANT_CLEAR')return '<b>مسح وداع نوع المغادرة: '+
   safe(draft.leaveKind??'')+'</b>\nبعد الاعتماد يعود إلى قالب الوداع العام أو المترجم.';
  if(draft.kind==='FAREWELL_REMOVED_ON')return 'تفعيل إعلان وداع العضو الذي أُزيل أو حُظر بواسطة الإدارة.\nقد يظهر ذلك لبقية أعضاء المجموعة.\nيجب تأكيده صراحةً.';
  if(draft.kind==='FAREWELL_REMOVED_OFF')return 'إيقاف وداع الإزالة أو الحظر.\nلن يوقف الوداع الطوعي، وسيبطل الرسائل القديمة المعلقة.';
  if(draft.kind==='WELCOME_VARIANT_SET')return '<b>معاينة ترحيب حسب نوع الدخول: '+
   safe(draft.joinKind??'')+'</b>\n'+safe(draft.text??'')+'\nلن يُرسل حتى تفعيل الترحيب.';
  if(draft.kind==='WELCOME_VARIANT_CLEAR')return '<b>مسح ترحيب نوع الدخول: '+
   safe(draft.joinKind??'')+'</b>\nبعد الاعتماد يعود هذا النوع إلى قالب الترحيب العام أو المترجم.';
  if(draft.kind==='WELCOME_LOCALIZED'||draft.kind==='FAREWELL_LOCALIZED')
   return '<b>معاينة قالب '+(draft.kind==='WELCOME_LOCALIZED'?'الترحيب':'الوداع')+
    ' بلغة '+draft.language+'</b>\n'+clean(draft.text??'');
  if(draft.kind==='WELCOME_LOCALIZED_CLEAR'||draft.kind==='FAREWELL_LOCALIZED_CLEAR')
   return '<b>إزالة ترجمة '+(draft.kind==='WELCOME_LOCALIZED_CLEAR'?'الترحيب':'الوداع')+
    ' بلغة '+safe(draft.language??'')+'</b>\nبعد الاعتماد سيعود النص إلى القالب الأساسي أو النوع المخصص.\nلا يفعّل الإرسال تلقائيًا.';
  if(draft.kind==='GROUP_LANGUAGE')
   return '<b>لغة رسائل المجموعة</b>\n'+draft.language+
    '\nإذا لم يوجد قالب مترجم، يُستخدم القالب الأساسي للمجموعة.';
  if(draft.kind==='GROUP_TIMEZONE')
   return '<b>معاينة المنطقة الزمنية (IANA)</b>\n'+safe(draft.timeZone!)+
    '\nسيُحدّث الوقت تلقائيًا عند تغيّر التوقيت الصيفي. التوقيت اليدوي يبقى احتياطيًا.';
  if(draft.kind==='GROUP_TIMEZONE_CLEAR')
   return '<b>إلغاء المنطقة الزمنية</b>\nسيعود البوت إلى إزاحة UTC اليدوية المعتمدة.';
  if(draft.kind==='GROUP_CLOCK')
   return '<b>معاينة التوقيت والتقويم</b>\nUTC'+
    (draft.utcOffsetMinutes!>=0?'+':'')+draft.utcOffsetMinutes!+' دقيقة'+
    '\nالساعة: '+draft.clockFormat+'\nالتقويم: '+draft.calendar;
  if(draft.kind==='GROUP_PROFILE_ON')return '<b>تفعيل صلاحية اقتراح تعديل اسم/صورة المجموعة</b>\n'+
   'لا تغيير فور التفعيل؛ كل عملية تحتاج اعتمادًا مستقلاً وحقوق Telegram صريحة. مفتاح التشغيل الخارجي منفصل.';
  if(draft.kind==='GROUP_PROFILE_OFF')return '<b>إيقاف تعديل اسم/صورة المجموعة</b>\n'+
   'طلبات التعديل التي لم تُرسل ستُلغى عند محاولة التنفيذ.';
  if(draft.kind==='GROUP_TITLE_SET')return '<b>اعتماد تغيير اسم المجموعة</b>\n'+safe(draft.text??'')+
   '\nعند الاعتماد يُنشأ طلب واحد، ولا يُرسل حتى فحص حقوق can_change_info ومفتاح التشغيل.';
  if(draft.kind==='GROUP_PHOTO_SET')return '<b>اعتماد رفع صورة جديدة للمجموعة</b>\n'+
   'الملف مستمد من معرّف صورة Telegram الذي قدمه المالك؛ لن يُعرض رقم الملف أو رابط التنزيل. '+
   'بعد اعتماد الطلب يفحص البوت حق can_change_info والملف وحجمه ونوعه، ثم يعيد رفعه بـ multipart مرة واحدة فقط.';
  if(draft.kind==='GROUP_PHOTO_REMOVE')return '<b>تأكيد حذف الصورة الحالية للمجموعة</b>\n'+
   'سيُطلب deleteChatPhoto مرة واحدة فقط، بعد فحص حقوق Telegram. لا يتضمن هذا الأمر رفع صورة جديدة.';
  if(draft.kind==='RULES_LINK_SET')return '<b>اعتماد رابط القوانين</b>\n'+clean(draft.text??'')+
    '\nهذا الرابط سيظهر في القوالب التي تستخدم متغير {رابط_القوانين}.';
  if(draft.kind==='RULES_LINK_CLEAR')return 'اعتماد مسح رابط القوانين: سيختفي من الرسائل التالية.';
  if(draft.kind==='REPLY_ADD')
   return '<b>معاينة رد تلقائي</b>\nالكلمة: '+clean(draft.trigger??'')+
    '\nالمطابقة: '+draft.match+'\nالمصدر: '+(draft.source??'نص ثابت معتمد')+
    (draft.source==='FAQ'?'\nمعرف FAQ: <code>'+clean(draft.sourceFaqId??'')+'</code>'+
     '\nلا يتم نسخ نص الإجابة إلى القاعدة؛ يُجلب من النسخة المعتمدة وقت التشغيل.':
     draft.source==='RULES'?'\nسيُستخدم رابط القوانين المعتمد للمجموعة وقت التشغيل.':
     '\nالرد: '+clean(draft.text??''));
  if(draft.kind==='WELCOME_TEXT'||draft.kind==='FAREWELL_TEXT')
   return '<b>معاينة قالب '+(draft.kind==='WELCOME_TEXT'?'الترحيب':'الوداع')+
    '</b>\n'+clean(draft.text??'');
  if(draft.kind==='REPLY_REMOVE')return 'مراجعة حذف القاعدة: '+clean(draft.ruleId??'');
  if(draft.kind==='REPLY_ENABLE'||draft.kind==='REPLY_DISABLE')
   return 'مراجعة '+(draft.kind==='REPLY_ENABLE'?'تفعيل':'إيقاف')+' القاعدة: '+clean(draft.ruleId??'');
  if(draft.kind==='REPLY_COOLDOWN')return 'مراجعة فاصل الرد للقاعدة '+clean(draft.ruleId??'')+
    ': '+(draft.cooldownMs!/1000)+' ثانية';
  if(draft.kind==='QUIET_HOURS_SET')return 'ساعات الهدوء للردود التلقائية: '+
   String(Math.floor(draft.startMinute!/60)).padStart(2,'0')+':'+String(draft.startMinute!%60).padStart(2,'0')+
   ' إلى '+String(Math.floor(draft.endMinute!/60)).padStart(2,'0')+':'+String(draft.endMinute!%60).padStart(2,'0')+
   ' حسب إزاحة UTC المعتمدة. الترحيب والوداع لا يتوقفان.';
  if(draft.kind==='QUIET_HOURS_CLEAR')return 'مراجعة إلغاء ساعات الهدوء للردود التلقائية.';
  if(draft.kind==='TOPIC_COOLDOWN_SET')return 'مراجعة فاصل ردود موضوع '+draft.topicId+
   ': '+(draft.cooldownMs!/1000)+' ثانية. سقف المجموعة العام المعتمد يبقى.';
  if(draft.kind==='TOPIC_COOLDOWN_CLEAR')return 'مراجعة إزالة تخصيص حد موضوع '+draft.topicId+
   ' والعودة إلى فاصل المجموعة الافتراضي.';
  if(draft.kind==='DECISION_LOG_ON')return 'تفعيل سجل قرارات الردود المنقح لهذه المجموعة فقط.\nيُحفظ سبب القرار وإصدار الإعدادات دون رسالة الطالب أو هويته. لا يثبت حجز الإرسال التسليم عبر Telegram.';
  if(draft.kind==='DECISION_LOG_OFF')return 'إيقاف سجل قرارات الردود وحذف تاريخه فور اعتماد الإلغاء.';
  if(draft.kind==='REPLY_CLEANUP_DELAY')return 'تحديد مدة حذف ردود البوت المؤقتة بعد إثبات الإرسال: '+
   (draft.delayMs!/1000)+' ثانية. الحذف يتطلب صلاحية حديثة.';
  if(draft.kind==='REPLY_CLEANUP_ON')return 'تفعيل تنظيف ردود منارتك المؤكدة فقط بعد المهلة. لا يُحذف محتوى الأعضاء.';
  if(draft.kind==='REPLY_CLEANUP_OFF')return 'إيقاف حذف ردود منارتك المؤقتة؛ المهام القديمة تُلغى عند الإرسال.';
  if(draft.kind==='AUTO_LIMIT_SET')return '<b>اعتماد ميزانية الإعلانات الآلية</b>\n'+
   'السقف: '+draft.autoMessagesPerMinute+' رسائل خلال أي 60 ثانية في المجموعة، بما فيها الترحيب والوداع والردود الآلية. '+
   'فترات الحماية الحالية للمجموعة والعضو والموضوع لا تتغير، والسقف الأقصى 8.';
  if(draft.kind==='SERVICE_PROFILE_ON'||draft.kind==='SERVICE_PROFILE_OFF')return    '<b>تغيير تنظيف رسائل تغيير اسم/صورة المجموعة</b>\n'+
   (draft.kind==='SERVICE_PROFILE_ON'?'السماح بحذفها بعد المهلة':'استبعادها من التنظيف')+
   '. الرسائل المسجلة سابقًا لا تُحذف عند الإيقاف بسبب تغير إصدار السياسة. '+
   'يتطلب التنظيف العام وصلاحيات Telegram السارية.';
  if(draft.kind==='SERVICE_JOIN_ON'||draft.kind==='SERVICE_JOIN_OFF')return 'تنظيف رسالة خدمة الدخول: '+(draft.kind==='SERVICE_JOIN_ON'?'مسموح':'متوقف')+
   '. تنظيف رسائل المغادرة مستقل ولا يتأثر بهذا الخيار.';
  if(draft.kind==='SERVICE_LEAVE_ON'||draft.kind==='SERVICE_LEAVE_OFF')return 'تنظيف رسالة خدمة المغادرة: '+(draft.kind==='SERVICE_LEAVE_ON'?'مسموح':'متوقف')+
   '. تنظيف رسائل الدخول مستقل ولا يتأثر بهذا الخيار.';
  if(draft.kind==='SERVICE_CLEANUP_DELAY')return 'تحديد تأخير تنظيف الرسائل الخدمية: '+
   (draft.delayMs!/1000)+' ثانية';
  return 'معاينة التغيير: '+draft.kind;
 }
}
