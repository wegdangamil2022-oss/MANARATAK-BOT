import {createHash,randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {defaultCommunityConfig,emptyCommunityState,validCommunityConfig,
 matchCommunityRule,renderCommunityTemplate,selectCommunityRule,normalizeCommunityMatch,
 type CommunityConfig,type CommunityInput,type CommunityDraft,type CommunityDraftKind,
 type ReplyMatch,type CommunityAutomationState,type CommunityEventKind} from './phase4-community-model.js';

export type DraftRequest={kind:CommunityDraftKind;text?:string;trigger?:string;match?:ReplyMatch;ruleId?:string;topicId?:number};
export interface CommunitySendProposal{
 readonly text:string;readonly chatId:string;readonly actorId:string;
 readonly kind:CommunityEventKind;readonly policyVersion:number;readonly topicId?:number;
}
/** Read-only administrative explanation, never stored with student text. */
export type CommunityDiagnostic={status:'REPLIES_DISABLED'|'NO_MATCH'}|
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
   if((kind==='WELCOME_TEXT'||kind==='FAREWELL_TEXT'||kind==='REPLY_ADD')&&
      (typeof request.text!=='string'||request.text.trim().length===0))
    throw Error('COMMUNITY_TEMPLATE_REQUIRED');
   if(kind==='REPLY_ADD'&&(typeof request.trigger!=='string'||!request.trigger.trim()||
       !['EXACT','WORD','CONTAINS','COMMAND'].includes(request.match??'')))throw Error('COMMUNITY_TRIGGER_REQUIRED');
   if(kind==='REPLY_ADD'&&current.rules.length>=30)throw Error('COMMUNITY_RULE_CAPACITY');
   if(kind==='REPLY_REMOVE'&&(!request.ruleId||!current.rules.some(r=>r.id===request.ruleId)))
    throw Error('COMMUNITY_RULE_MISSING');
   const id=randomBytes(12).toString('hex');
   const draft:CommunityDraft={id,actorId,chatId,chatVersion,configVersion:current.version,kind,
    createdAt:now,expiresAt:now+120000,
    ...(request.text!==undefined?{text:request.text}:{}),
    ...(request.trigger!==undefined?{trigger:request.trigger}:{}),
    ...(request.match!==undefined?{match:request.match}:{}),
    ...(request.ruleId!==undefined?{ruleId:request.ruleId}:{}),
    ...(request.topicId!==undefined?{topicId:request.topicId}:{})};
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
   // A stale/expired/unauthorized draft never changes a running policy.
   if(now<draft.createdAt||now>=draft.expiresAt||
      groupAvailable(s,this.policy,actorId,draft.chatId)!==draft.chatVersion)
    throw Error('COMMUNITY_DRAFT_EXPIRED');
   const config=configured(s,draft.chatId);
   if(config.version!==draft.configVersion)throw Error('COMMUNITY_DRAFT_STALE');
   switch(draft.kind){
    case 'WELCOME_TEXT':config.welcome.text=draft.text!;break;
    case 'FAREWELL_TEXT':config.farewell.text=draft.text!;break;
    case 'WELCOME_ON':config.welcome.enabled=true;break;
    case 'WELCOME_OFF':config.welcome.enabled=false;break;
    case 'FAREWELL_ON':config.farewell.enabled=true;break;
    case 'FAREWELL_OFF':config.farewell.enabled=false;break;
    case 'REPLIES_ON':config.repliesEnabled=true;break;
    case 'REPLIES_OFF':config.repliesEnabled=false;break;
    case 'REPLY_REMOVE':config.rules=config.rules.filter(r=>r.id!==draft.ruleId);break;
    case 'REPLY_ADD':{
     const same=config.rules.some(r=>r.match===draft.match&&r.topicId===draft.topicId&&
       normalizeCommunityMatch(r.trigger)===normalizeCommunityMatch(draft.trigger!));
     if(same)throw Error('COMMUNITY_RULE_DUPLICATE');
     config.rules.push({id:randomBytes(6).toString('hex'),trigger:draft.trigger!,
      response:draft.text!,match:draft.match!,enabled:true,cooldownMs:60000,
      ...(draft.topicId!==undefined?{topicId:draft.topicId}:{})});
     break;
    }
   }
   config.version++;
   if(!validCommunityConfig(config))throw Error('COMMUNITY_CONFIG_INVALID');
   st!.configs=st!.configs.filter(c=>c.chatId!==config.chatId);
   st!.configs.push(config);
   st!.drafts=st!.drafts.filter(d=>d.actorId!==actorId);
   s.audit.push({updateKey:'p4-community:'+draft.id,actorId,decision:'ALLOW',
    reason:'COMMUNITY_'+draft.kind,policyVersion:config.version,at:now});
   return structuredClone(config);
  });
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
  if(!config.repliesEnabled)return {status:'REPLIES_DISABLED'};
  const rule=selectCommunityRule(config,sample,topicId);
  if(!rule)return {status:'NO_MATCH'};
  const now=this.clock();
  if(!validNow(now))throw Error('COMMUNITY_CLOCK_INVALID');
  const input:CommunityInput={kind:'TEXT',chatId,actorId:'1',
   memberName:'الطالب التجريبي',groupName:'مجموعة منارتك التجريبية',
   messageText:sample,...(topicId!==undefined?{topicId}:{})};
  return {status:'MATCH',ruleId:rule.id,
   preview:renderCommunityTemplate(rule.response,input,now+config.utcOffsetMinutes*60000)};
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
   input.edited||input.forwarded||input.fromBot)return null;
  if(input.kind==='TEXT'&&(!input.messageText||input.messageText.length>4096))return null;
  const key=hex('P4:EVENT:'+updateKey);
  return this.store.transaction(s=>{
   const config=activeConfig(s,input.chatId);
   if(!config||!validCommunityConfig(config)||
      !this.policy.canUseChat(s,input.chatId,'navigation')||
      s.chats.filter(c=>c.id===input.chatId&&c.approved).length!==1)return null;
   let template:string,ruleId:string|undefined;
   if(input.kind==='JOIN'){if(!config.welcome.enabled)return null;template=config.welcome.text;}
   else if(input.kind==='LEAVE'){if(!config.farewell.enabled)return null;template=config.farewell.text;}
   else{
    const rule=selectCommunityRule(config,input.messageText!,input.topicId);
    if(!rule)return null;
    template=rule.response;ruleId=rule.id;
   }
   const actorDigest=hex('P4:ACTOR:'+input.chatId+':'+input.actorId);
   const existing=stateOf(s).receipts;
   if(existing.some(x=>x.key===key)||existing.some(x=>x.chatId===input.chatId&&x.at>now))return null;
   const active=existing.filter(x=>x.at>now-86400000);
   const inGroup=active.filter(x=>x.chatId===input.chatId);
   if(inGroup.filter(x=>x.at>now-60000).length>=8||
      inGroup.some(x=>now-x.at<config.groupCooldownMs))return null;
   const actorPeriod=ruleId?config.rules.find(x=>x.id===ruleId)!.cooldownMs:600000;
   if(inGroup.some(x=>x.actorDigest===actorDigest&&x.kind===input.kind&&
       x.ruleId===ruleId&&now-x.at<actorPeriod))return null;
   let text:string;
   try{text=renderCommunityTemplate(template,input,
     now+config.utcOffsetMinutes*60000);}
   catch{return null;}
   const receipt={key,chatId:input.chatId,at:now,kind:input.kind,actorDigest,
    ...(ruleId?{ruleId}:{})};
   s.phase4Community??=emptyCommunityState();
   s.phase4Community.receipts=[...active.slice(-2499),receipt];
   return {text,chatId:input.chatId,actorId:input.actorId,kind:input.kind,
    policyVersion:config.version,...(input.topicId!==undefined?{topicId:input.topicId}:{})};
  });
 }
 /** Preview never calls the Telegram gateway, writes a send or records a vote. */
 preview(draft:CommunityDraft):string{
  const clean=(x:string)=>safe(x.slice(0,250));
  if(draft.kind==='REPLY_ADD')
   return '<b>معاينة رد تلقائي</b>\nالكلمة: '+clean(draft.trigger??'')+
    '\nالمطابقة: '+draft.match+'\nالرد: '+clean(draft.text??'');
  if(draft.kind==='WELCOME_TEXT'||draft.kind==='FAREWELL_TEXT')
   return '<b>معاينة قالب '+(draft.kind==='WELCOME_TEXT'?'الترحيب':'الوداع')+
    '</b>\n'+clean(draft.text??'');
  if(draft.kind==='REPLY_REMOVE')return 'مراجعة حذف القاعدة: '+clean(draft.ruleId??'');
  return 'معاينة التغيير: '+draft.kind;
 }
}
