import {subscriptionEnforcementConsent,subscriptionEnforcementStamp} from './subscription-enforcement-policy.js';
import {CaptchaService} from './captcha.js';
import {CaptchaRuleGate} from './captcha-rules.js';
import {CaptchaEnforcement} from './captcha-enforcement.js';
import { BotStore, type BotState } from './store.js';
import { Policy } from './policy.js';
import { ModerationService, type ModerationResult } from './moderation.js';
import {isCanonicalSubscriptionRule,subscriptionRequirementMode} from './subscription-integrity.js';
import {subscriptionConfigEpoch} from './subscription-config-epoch.js';
import {subscriptionGracePolicy,subscriptionGraceStamp} from './subscription-leave-grace.js';
import {observedSubscriptionDue,observedSubscriptionStamp} from './subscription-observed-members.js';
import {recordSubscriptionChannelChange} from './subscription-change-alert.js';
import {recordChannelUnavailability} from './subscription-channel-unavailable.js';

export type Membership = 'MEMBER' | 'NOT_MEMBER' | 'UNKNOWN';
export type ChannelRights = 'ADMIN' | 'NOT_ADMIN' | 'UNKNOWN';
export type SubscriptionDecision = { status: 'MEMBER' | 'NOT_MEMBER' | 'UNAVAILABLE' | 'NOT_REQUIRED' | 'DENIED'; channels: string[] };
export interface MembershipGateway {
  canVerifyChannel(channelId: string): Promise<boolean>;
  inspectChannelRights?(channelId:string):Promise<ChannelRights>;
  getMember(channelId: string, userId: string): Promise<Membership>;
  joinURL?(channelId:string):Promise<string|null>;
}
export class FakeMembershipGateway implements MembershipGateway {
  verifiable = true;
  private statuses = new Map<string, Membership>();
  set(channel: string, member: string, result: Membership): void { this.statuses.set(channel + ':' + member, result); }
  async canVerifyChannel(_channel: string): Promise<boolean> { return this.verifiable; }
  async getMember(channel: string, member: string): Promise<Membership> { return this.statuses.get(channel + ':' + member) ?? 'UNKNOWN'; }
}
export class SubscriptionGate {
  constructor(private readonly store: BotStore, private readonly policy: Policy, private readonly membership: MembershipGateway, private readonly moderation: ModerationService, private readonly clock: () => number = Date.now) {}
  /** Private owner-initiated read; the saved rule and permissions must remain
   * unchanged across every provider call. Unknown never means lost rights. */
  async channelRightsHealth(actor:string,chat:string,expectedEpoch:string):Promise<{id:string;status:ChannelRights}[]|null>{
    const before=await this.store.snapshot(),started=this.clock();
    if(!this.policy.isOwner(actor)||!this.policy.privateFeature(before,'owner.dashboard',actor)||!this.policy.canUseChat(before,chat,'verification')||subscriptionConfigEpoch(before)!==expectedEpoch||!Number.isSafeInteger(started)||started<0||started>8640000000000000-120000)return null;
    const rows=before.subscriptionRequirements.filter(r=>r.chatId===chat),rule=rows[0];if(rows.length!==1||!rule||!isCanonicalSubscriptionRule(rule)||!rule.channelIds.length)return null;
    const checks=await Promise.all(rule.channelIds.map(async id=>{let status:ChannelRights='UNKNOWN',attempted=false;try{if(this.policy.canUseChat(before,id,'verification')&&this.membership.inspectChannelRights){attempted=true;const received=await this.membership.inspectChannelRights(id);if(received==='ADMIN'||received==='NOT_ADMIN')status=received;}}catch{/* unavailable is not a rights loss */}return {id,status,attempted};}));
    const unknown=checks.filter(x=>x.attempted&&x.status==='UNKNOWN').length;
    if(unknown)try{await this.store.transaction(s=>{const at=this.clock();if(!Number.isSafeInteger(at)||at<started||at>=started+120000||!this.policy.privateFeature(s,'owner.dashboard',actor)||!this.policy.canUseChat(s,chat,'verification')||subscriptionConfigEpoch(s)!==expectedEpoch)return;for(let i=0;i<unknown;i++)if(!recordChannelUnavailability(s,at,'MANUAL'))break;});}catch{/* telemetry never prevents a health result */}
    const after=await this.store.snapshot(),now=this.clock();return Number.isSafeInteger(now)&&now>=started&&now<started+120000&&this.policy.privateFeature(after,'owner.dashboard',actor)&&this.policy.canUseChat(after,chat,'verification')&&subscriptionConfigEpoch(after)===expectedEpoch?checks.map(({id,status})=>({id,status})):null;
  }
  async configure(actorId: string, chatId: string, channelIds: string[], mode: 'ALL' | 'ANY' | 'AT_LEAST',expectedEpoch?:string,minimumCount?:number): Promise<void> {
    if (!this.policy.isOwner(actorId)) throw new Error('OWNER_ONLY');
    if (!isCanonicalSubscriptionRule({chatId,channelIds,mode,version:1,...(minimumCount!==undefined?{minimumCount}:{})})) throw new Error('INVALID_SUBSCRIPTION_CONFIG');
    const state = await this.store.snapshot();
    if(expectedEpoch!==undefined&&(!this.policy.privateFeature(state,'owner.dashboard',actorId)||subscriptionConfigEpoch(state)!==expectedEpoch))throw Error('SUBSCRIPTION_CONFIG_STALE');
    if (!this.policy.canUseChat(state, chatId, 'verification')) throw new Error('GROUP_NOT_APPROVED');
    // Capture current authorization epochs *before* external checks. A
    // revoke + reapprove could restore the same scopes with a newer version;
    // rereading only 'approved' would let a stale verification win.
    const groupEpoch=state.chats.find(c=>c.id===chatId)?.version;
    const channelEpochs=new Map(channelIds.map(id=>
      [id,state.chats.find(c=>c.id===id)?.version] as const));
    const priorRuleVersion=state.subscriptionRequirements.find(x=>x.chatId===chatId)?.version;
    for (const id of channelIds) {
      if (!/^-[0-9]+$/.test(id) || !this.policy.canUseChat(state, id, 'verification')) throw new Error('CHANNEL_NOT_APPROVED');
    }
    // At most ten independent read-only checks. Do not multiply the provider's
    // timeout by the channel count while an inline callback is waiting.
    await Promise.all(channelIds.map(async id=>{
      // The provider may reject or time out even while a saved local channel
      // grant remains valid. Never leak provider errors through an owner API.
      let permitted=false;
      try{permitted=await this.membership.canVerifyChannel(id);}
      catch{throw new Error('CHANNEL_UNVERIFIABLE');}
      if(!permitted)throw new Error('CHANNEL_UNVERIFIABLE');
    }));
    await this.store.transaction(s => {
      if(expectedEpoch!==undefined&&(!this.policy.privateFeature(s,'owner.dashboard',actorId)||subscriptionConfigEpoch(s)!==expectedEpoch))throw Error('SUBSCRIPTION_CONFIG_STALE');
      if (!this.policy.canUseChat(s, chatId, 'verification') ||
          s.chats.find(c=>c.id===chatId)?.version!==groupEpoch ||
          channelIds.some(id => !this.policy.canUseChat(s, id, 'verification') ||
            s.chats.find(c=>c.id===id)?.version!==channelEpochs.get(id)))
        throw new Error('APPROVAL_REVOKED');
      const old = s.subscriptionRequirements.find(x => x.chatId === chatId);
      if(old?.version!==priorRuleVersion)throw new Error('SUBSCRIPTION_CONFIG_STALE');
      const previousChannels=old&&Array.isArray(old.channelIds)?[...old.channelIds]:undefined;
      if (old) { old.channelIds = channelIds; old.mode = mode; old.version++; }
      else s.subscriptionRequirements.push({ chatId, channelIds, mode, version: 1 });
      const saved=s.subscriptionRequirements.find(r=>r.chatId===chatId)!;
      if(mode==='AT_LEAST')saved.minimumCount=minimumCount!;else delete saved.minimumCount;
      if(previousChannels)recordSubscriptionChannelChange(s,actorId,chatId,previousChannels,saved.channelIds,saved.version,groupEpoch??0,this.clock());
      if(expectedEpoch!==undefined)s.audit.push({actorId,updateKey:'subscription-editor:'+chatId+':'+(old?.version??1),decision:'ALLOW',reason:'SUBSCRIPTION_CONFIG_CONFIRMED',policyVersion:groupEpoch??0,at:this.clock()});
    });
  }
  /** A thin existing gate facade over the same owner-only atomic policy
   * operation used by Telegram's verified private owner buttons.
   */
  async removeRequiredChannelAtRevision(actorId:string,chatId:string,channelId:string,
    expectedChatRevision:number,expectedRequirementRevision:number):Promise<void>{
    return this.policy.removeSubscriptionChannelAtRevision(actorId,chatId,channelId,
     expectedChatRevision,expectedRequirementRevision);
  }
  async verify(chatId: string, userId: string,capture?:(responses:Membership[])=>void): Promise<SubscriptionDecision> {
    const s = await this.store.snapshot();
    if (!userId || !this.policy.canUseChat(s, chatId, 'verification')) return { status: 'DENIED', channels: [] };
    const mode=subscriptionRequirementMode(s,chatId);
    if(mode==='NONE')return {status:'NOT_REQUIRED',channels:[]};
    if(mode==='INVALID')return {status:'UNAVAILABLE',channels:[]};
    const config = s.subscriptionRequirements.find(x => x.chatId === chatId)!;
    // Never interpret malformed saved rules as ALL or ANY, nor silently
    // classify a corrupt paused rule as NOT_REQUIRED. The operator health
    // audit flags the same broken state; runtime must fail closed as well.
    if(!isCanonicalSubscriptionRule(config))return {status:'UNAVAILABLE',channels:[]};
    if (!config.channelIds.length || this.policy.isOwner(userId)) return { status: 'NOT_REQUIRED', channels: [] };
    // Membership proofs are scoped to the authorization epoch from which they
    // were requested. Re-approval under the same IDs does not retain evidence.
    const groupEpoch=s.chats.find(c=>c.id===chatId)?.version;
    const channelEpochs=new Map(config.channelIds.map(id=>
      [id,s.chats.find(c=>c.id===id)?.version] as const));
    if(config.channelIds.some(channel=>!this.policy.canUseChat(s,channel,'verification')))return {status:'UNAVAILABLE',channels:[]};
    const verifiable=await Promise.all(config.channelIds.map(async channel=>{try{return await this.membership.canVerifyChannel(channel)===true;}catch{return false;}}));
    if(!verifiable.every(Boolean))return {status:'UNAVAILABLE',channels:[]};
    const responses:Membership[]=await Promise.all(config.channelIds.map(async channel=>{try{const received=await this.membership.getMember(channel,userId);return received==='MEMBER'||received==='NOT_MEMBER'?received:'UNKNOWN';}catch{return 'UNKNOWN' as const;}}));
    // Revalidation protects changes made while external checks were in flight.
    const latest = await this.store.snapshot();
    const current = latest.subscriptionRequirements.find(x => x.chatId === chatId);
    if (!this.policy.canUseChat(latest, chatId, 'verification') ||
        latest.chats.find(c=>c.id===chatId)?.version!==groupEpoch ||
        subscriptionRequirementMode(latest,chatId)==='INVALID' ||
        !current || current.version !== config.version ||
        current.mode!==config.mode ||
        current.minimumCount!==config.minimumCount ||
        current.channelIds.length!==config.channelIds.length ||
        current.channelIds.some((id,i)=>id!==config.channelIds[i]) ||
        config.channelIds.some(id => !this.policy.canUseChat(latest, id, 'verification') ||
          latest.chats.find(c=>c.id===id)?.version!==channelEpochs.get(id)))
      return { status: 'UNAVAILABLE', channels: [] };
    // An unknown result from the provider must not be used to punish a
    // student. For ALL, even a known negative alongside an unavailable
    // channel is treated as UNAVAILABLE until all evidence is known.
    // For ANY, one verified MEMBER suffices independently of other unknowns.
    const required=config.mode==='ALL'?responses.length:config.mode==='ANY'?1:config.minimumCount!;
    const members=responses.filter(x=>x==='MEMBER').length;
    const passing=members>=required;
    const complete=responses.every(x=>x!=='UNKNOWN');
    const failing=complete&&members<required;
    capture?.([...responses]);
    return {status:passing?'MEMBER':failing?'NOT_MEMBER':'UNAVAILABLE',
     channels:[...config.channelIds]};
  }
  async verifyWithProgress(chat:string,member:string):Promise<{decision:SubscriptionDecision;verified:number;unknown:number;total:number}>{let responses:Membership[]=[];const decision=await this.verify(chat,member,r=>{responses=r;});return {decision,verified:responses.filter(r=>r==='MEMBER').length,unknown:responses.filter(r=>r==='UNKNOWN').length,total:decision.channels.length};}
  async joinTargets(chat:string):Promise<{id:string;url:string|null}[]>{
    const before=await this.store.snapshot(),rows=before.subscriptionRequirements.filter(r=>r.chatId===chat),rule=rows[0];if(rows.length!==1||!rule||!isCanonicalSubscriptionRule(rule)||!this.policy.canUseChat(before,chat,'verification')||rule.channelIds.some(id=>!this.policy.canUseChat(before,id,'verification')))return [];
    const epoch=subscriptionConfigEpoch(before),values=await Promise.all(rule.channelIds.map(async id=>{let url:string|null=null;try{url=await this.membership.joinURL?.(id)??null;}catch{/* unavailable links are never guessed */}if(url!==null&&(typeof url!=='string'||/^https:\/\/t\.me\/(?:[A-Za-z][A-Za-z0-9_]{4,31}|\+[A-Za-z0-9_-]{10,128}|joinchat\/[A-Za-z0-9_-]{10,128})$/u.exec(url)?.[0]!==url))url=null;return {id,url};}));
    return subscriptionConfigEpoch(await this.store.snapshot())===epoch?values:[];
  }
  supportsAutomaticEnforcement():boolean{return this.moderation.supportsSubscriptionEnforcement();}
  /** Only validated incoming human group events enroll members. No member-list
   * scraping, fabricated successful membership or eviction of active records. */
  async observeMember(chat:string,member:string,sentAt:number):Promise<'OBSERVED'|'IGNORED'|'FULL'>{
    return this.store.transaction(s=>{
      const now=this.clock(),stamp=observedSubscriptionStamp(s,this.policy,chat,now);
      if(!this.supportsAutomaticEnforcement()||!stamp||!Number.isSafeInteger(now)||now<0||now>8640000000000000-1800000||!Number.isSafeInteger(sentAt)||sentAt>now||sentAt<now-30000||!/^[1-9][0-9]{0,15}$/u.test(member)||!Number.isSafeInteger(Number(member))||this.policy.isOwner(member)||this.policy.has(s,member,'chat.manage',chat,now))return 'IGNORED';
      s.subscriptionObservedMembers=(s.subscriptionObservedMembers??[]).filter(r=>r.observedAt>now-30*86400000);
      const rows=s.subscriptionObservedMembers.filter(r=>r.chatId===chat&&r.memberId===member),row=rows[0];
      if(rows.length>1||row&&row.observedAt>now)return 'IGNORED';
      if(row){row.observedAt=now;if(row.stamp!==stamp){row.stamp=stamp;row.nextCheckAt=now+1800000;}else row.nextCheckAt=Math.max(now,row.nextCheckAt);}
      else {if(s.subscriptionObservedMembers.length>=1000)return 'FULL';s.subscriptionObservedMembers.push({chatId:chat,memberId:member,stamp,observedAt:now,nextCheckAt:now+1800000});}
      return 'OBSERVED';
    });
  }
  async automaticMode(chat:string):Promise<'ON'|'OFF'|'UNAVAILABLE'>{if(!this.supportsAutomaticEnforcement())return 'UNAVAILABLE';const c=subscriptionEnforcementConsent(await this.store.snapshot(),this.policy,chat,this.clock());return c?c.enabled?'ON':'OFF':'UNAVAILABLE';}
  async validateEnforcementConfiguration(actor:string,chat:string,expectedEpoch:string):Promise<boolean>{
    const s=await this.store.snapshot(),rule=s.subscriptionRequirements.find(r=>r.chatId===chat);if(!this.policy.isOwner(actor)||!this.supportsAutomaticEnforcement()||subscriptionConfigEpoch(s)!==expectedEpoch||!subscriptionEnforcementStamp(s,this.policy,chat)||!rule||!rule.channelIds.length)return false;
    try{if(!(await Promise.all(rule.channelIds.map(id=>this.membership.canVerifyChannel(id)))).every(Boolean))return false;}catch{return false;}
    return subscriptionConfigEpoch(await this.store.snapshot())===expectedEpoch;
  }
  async synchronizeAutomatic(chat:string,member:string,guard?:(s:BotState)=>boolean):Promise<{decision:SubscriptionDecision;effect?:ModerationResult|SubscriptionDecision;verified?:number;unknown?:number;total?:number}>{
    if(await this.automaticMode(chat)==='UNAVAILABLE')return {decision:{status:'DENIED',channels:[]}};
    let decision:SubscriptionDecision={status:'UNAVAILABLE',channels:[]},responses:Membership[]=[];const effect=await this.syncSubscriptionRestriction(chat,member,(d,r)=>{decision=structuredClone(d);responses=r;},guard);return {decision,effect,verified:responses.filter(r=>r==='MEMBER').length,unknown:responses.filter(r=>r==='UNKNOWN').length,total:decision.channels.length};
  }
  async tickAutomatic(enabled=false,safetyGate:()=>Promise<boolean>=async()=>false,limit=5):Promise<{status:'DISABLED'|'INVALID'|'STOPPED'|'RAN';checked:number;changed:number;unresolved:number}>{
    const result={checked:0,changed:0,unresolved:0};if(enabled!==true||!this.supportsAutomaticEnforcement())return {status:'DISABLED',...result};
    const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-5000||!Number.isSafeInteger(limit)||limit<1||limit>10)return {status:'INVALID',...result};
    const permitted=async()=>{try{return await safetyGate()===true;}catch{return false;}};if(!await permitted())return {status:'STOPPED',...result};
    const state=await this.store.snapshot(),seen=new Set<string>();
    const validCursor=(v:unknown):v is {chatId:string;memberId:string}=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='chatId,memberId'&&typeof (v as {chatId?:unknown}).chatId==='string'&&/^-[1-9][0-9]{0,15}$/u.exec((v as {chatId:string}).chatId)?.[0]===(v as {chatId:string}).chatId&&Number.isSafeInteger(Number((v as {chatId:string}).chatId))&&typeof (v as {memberId?:unknown}).memberId==='string'&&/^[1-9][0-9]{0,15}$/u.exec((v as {memberId:string}).memberId)?.[0]===(v as {memberId:string}).memberId&&Number.isSafeInteger(Number((v as {memberId:string}).memberId));
    if(state.subscriptionSweepCursor!==undefined&&!validCursor(state.subscriptionSweepCursor))return {status:'INVALID',...result};
    const gracePending=(s:BotState,chat:string,member:string,at:number)=>{const consent=subscriptionEnforcementConsent(s,this.policy,chat,at),grace=subscriptionGracePolicy(s,this.policy,chat,at),record=s.subscriptionGraceMembers?.find(r=>r.chatId===chat&&r.memberId===member);if(!consent?.enabled||!grace||grace.seconds<=0||!record||record.stamp!==subscriptionGraceStamp(grace,consent)||record.verifiedAt>at||record.verifiedAt<=at-30*86400000)return false;const due=record.missingSince===undefined?record.verifiedAt+6*3600000:record.missingSince+grace.seconds*1000;return at>=Math.max(due,record.nextCheckAt??due);};
    const pending=(s:BotState,chat:string,member:string,at:number)=>gracePending(s,chat,member,at)||observedSubscriptionDue(s,this.policy,chat,member,at);
    const targets=state.moderationReasons.filter(r=>{const key=r.chatId+':'+r.memberId;if(r.source!=='SUBSCRIPTION'||r.active!==true||r.reference!=='subscription-gate'||!validCursor({chatId:r.chatId,memberId:r.memberId})||seen.has(key)||!subscriptionEnforcementConsent(state,this.policy,r.chatId,now))return false;seen.add(key);if(state.moderationOperations.some(o=>o.chatId===r.chatId&&o.memberId===r.memberId&&['INTENT','STARTED','UNKNOWN_OUTCOME'].includes(o.status))){result.unresolved++;return false;}return true;}).map(r=>({chatId:r.chatId,memberId:r.memberId}));
    for(const member of [...(state.subscriptionGraceMembers??[]),...(state.subscriptionObservedMembers??[])]){const key=member.chatId+':'+member.memberId;if(!seen.has(key)&&pending(state,member.chatId,member.memberId,now)&&!state.moderationOperations.some(o=>o.chatId===member.chatId&&o.memberId===member.memberId&&['INTENT','STARTED','UNKNOWN_OUTCOME'].includes(o.status))){seen.add(key);targets.push({chatId:member.chatId,memberId:member.memberId});}}
    targets.sort((a,b)=>a.chatId.localeCompare(b.chatId)||a.memberId.localeCompare(b.memberId));
    const selected=new Set<string>();
    for(let i=0;i<Math.min(limit,targets.length);i++){
      if(!await permitted())return {status:'STOPPED',...result};
      const r=await this.store.transaction(s=>{
       if(s.subscriptionSweepCursor!==undefined&&!validCursor(s.subscriptionSweepCursor))return 'INVALID' as const;
       const remaining=targets.filter(t=>!selected.has(JSON.stringify([t.chatId,t.memberId]))&&(s.moderationReasons.some(x=>x.chatId===t.chatId&&x.memberId===t.memberId&&x.source==='SUBSCRIPTION'&&x.reference==='subscription-gate'&&x.active)&&!!subscriptionEnforcementConsent(s,this.policy,t.chatId,this.clock())||pending(s,t.chatId,t.memberId,this.clock()))&&!s.moderationOperations.some(o=>o.chatId===t.chatId&&o.memberId===t.memberId&&['INTENT','STARTED','UNKNOWN_OUTCOME'].includes(o.status)));
       const cursor=s.subscriptionSweepCursor,compare=(t:{chatId:string;memberId:string})=>cursor?t.chatId.localeCompare(cursor.chatId)||t.memberId.localeCompare(cursor.memberId):1;
       const next=remaining.find(t=>compare(t)>0)??remaining[0];if(!next)return null;s.subscriptionSweepCursor={chatId:next.chatId,memberId:next.memberId};const active=s.moderationReasons.some(x=>x.chatId===next.chatId&&x.memberId===next.memberId&&x.source==='SUBSCRIPTION'&&x.reference==='subscription-gate'&&x.active);return {chatId:next.chatId,memberId:next.memberId,tracking:!active};
      });
      if(r==='INVALID')return {status:'INVALID',...result};if(!r)break;selected.add(JSON.stringify([r.chatId,r.memberId]));
      let guard:((s:BotState)=>boolean)|undefined,baseline:string|undefined,source:string|undefined,observedBaseline:string|undefined;
      if(r.tracking){
       const before=await this.store.snapshot(),started=this.clock();if(!pending(before,r.chatId,r.memberId,started))continue;source=subscriptionConfigEpoch(before);baseline=JSON.stringify(before.subscriptionGraceMembers?.find(x=>x.chatId===r.chatId&&x.memberId===r.memberId)??null);observedBaseline=JSON.stringify(before.subscriptionObservedMembers?.find(x=>x.chatId===r.chatId&&x.memberId===r.memberId)??null);
       guard=s=>{const at=this.clock();return Number.isSafeInteger(at)&&at>=started&&at<started+5000&&subscriptionConfigEpoch(s)===source&&JSON.stringify(s.subscriptionObservedMembers?.find(x=>x.chatId===r.chatId&&x.memberId===r.memberId)??null)===observedBaseline;};
       let groupMember:Membership='UNKNOWN',canVerify=false;try{canVerify=await this.membership.canVerifyChannel(r.chatId)===true;}catch{canVerify=false;}
       if(!await permitted())return {status:'STOPPED',...result};
       if(canVerify&&guard(await this.store.snapshot()))try{groupMember=await this.membership.getMember(r.chatId,r.memberId);}catch{groupMember='UNKNOWN';}
       if(!await permitted())return {status:'STOPPED',...result};
       if(groupMember!=='MEMBER'||!guard(await this.store.snapshot())){
        await this.store.transaction(s=>{const at=this.clock(),row=s.subscriptionObservedMembers?.find(x=>x.chatId===r.chatId&&x.memberId===r.memberId);if(row&&JSON.stringify(row)===observedBaseline&&subscriptionConfigEpoch(s)===source&&Number.isSafeInteger(at)&&at>=started&&at<=8640000000000000){if(groupMember==='NOT_MEMBER'&&at<started+5000)s.subscriptionObservedMembers=s.subscriptionObservedMembers!.filter(x=>x!==row);else row.nextCheckAt=Math.min(8640000000000000,at+1800000);}});
        await this.store.transaction(s=>{const at=this.clock(),row=s.subscriptionGraceMembers?.find(x=>x.chatId===r.chatId&&x.memberId===r.memberId);if(row&&JSON.stringify(row)===baseline&&subscriptionConfigEpoch(s)===source&&Number.isSafeInteger(at)&&at>=started&&at<=8640000000000000){if(groupMember==='NOT_MEMBER'&&at<started+5000)s.subscriptionGraceMembers=s.subscriptionGraceMembers!.filter(x=>x!==row);else row.nextCheckAt=Math.min(8640000000000000,at+1800000);}});result.checked++;continue;
       }
      }
      const outcome=await this.synchronizeAutomatic(r.chatId,r.memberId,guard);result.checked++;
      if(r.tracking)await this.store.transaction(s=>{const at=this.clock(),row=s.subscriptionObservedMembers?.find(x=>x.chatId===r.chatId&&x.memberId===r.memberId);if(row&&JSON.stringify(row)===observedBaseline&&subscriptionConfigEpoch(s)===source&&Number.isSafeInteger(at)&&at>=row.observedAt&&at<=8640000000000000)row.nextCheckAt=Math.min(8640000000000000,at+(outcome.decision.status==='MEMBER'?6*3600000:1800000));});
      if(r.tracking&&(outcome.decision.status==='UNAVAILABLE'||outcome.decision.status==='DENIED'||outcome.effect!==undefined&&['DENIED','UNKNOWN_OUTCOME','BLOCKED_UNKNOWN','BLOCKED_PENDING'].includes(outcome.effect.status)))await this.store.transaction(s=>{const at=this.clock(),row=s.subscriptionGraceMembers?.find(x=>x.chatId===r.chatId&&x.memberId===r.memberId);if(row&&JSON.stringify(row)===baseline&&subscriptionConfigEpoch(s)===source&&Number.isSafeInteger(at)&&at>=row.verifiedAt&&at<=8640000000000000)row.nextCheckAt=Math.min(8640000000000000,at+1800000);});
      if(outcome.effect?.status==='APPLIED')result.changed++;if(outcome.effect?.status==='UNKNOWN_OUTCOME'||outcome.effect?.status==='BLOCKED_UNKNOWN')result.unresolved++;
    }
    return {status:'RAN',...result};
  }
  async syncSubscriptionRestriction(chatId: string, memberId: string,capture?:(decision:SubscriptionDecision,responses:Membership[])=>void,guard?:(s:BotState)=>boolean): Promise<ModerationResult | SubscriptionDecision> {
    // The public verify() response contains no durable proof. Keep a private
    // pre-check epoch and require the SAME saved rule/group/channel epochs in
    // ModerationService's atomic reason-write and immediately before dispatch.
    // This closes the window *after* verify() revalidation but *before*
    // moderation's external rights check and Telegram-effect intent.
    const before=await this.store.snapshot(),verifiedAt=this.clock(),official=this.supportsAutomaticEnforcement(),consent=subscriptionEnforcementConsent(before,this.policy,chatId,verifiedAt),grace=official?subscriptionGracePolicy(before,this.policy,chatId,verifiedAt):null;
    if(guard&&!guard(before))return {status:'DENIED',reason:'SUBSCRIPTION_EVIDENCE_STALE'};
    if(official&&consent?.enabled&&!grace)return {status:'DENIED',reason:'SUBSCRIPTION_GRACE_POLICY_UNAVAILABLE'};
    const groupEpoch=this.policy.chatRevision(before,chatId);
    const rule=before.subscriptionRequirements.find(x=>x.chatId===chatId);
    const channelEpochs=new Map((rule?.channelIds??[]).map(id=>
      [id,this.policy.chatRevision(before,id)] as const));
    let stillCurrent=(s:BotState):boolean=>{
      const now=this.clock();if(guard&&!guard(s))return false;if(official&&(!Number.isSafeInteger(now)||now<verifiedAt||now>=verifiedAt+5000||JSON.stringify(subscriptionEnforcementConsent(s,this.policy,chatId,now))!==JSON.stringify(consent)||JSON.stringify(subscriptionGracePolicy(s,this.policy,chatId,now))!==JSON.stringify(grace)))return false;
      if(!this.policy.canUseChat(s,chatId,'verification')||
        this.policy.chatRevision(s,chatId)!==groupEpoch)return false;
      const current=s.subscriptionRequirements.find(x=>x.chatId===chatId);
      if(!rule)return !current;
      if(!current||!isCanonicalSubscriptionRule(rule)||
        !isCanonicalSubscriptionRule(current)||current.version!==rule.version||
        current.mode!==rule.mode||current.minimumCount!==rule.minimumCount||current.channelIds.length!==rule.channelIds.length||
        current.channelIds.some((id,i)=>id!==rule.channelIds[i]))return false;
      return rule.channelIds.every(id=>
        this.policy.canUseChat(s,id,'verification')&&
        this.policy.chatRevision(s,id)===channelEpochs.get(id));
    };
    let responses:Membership[]=[];const result:SubscriptionDecision=official&&consent&&!consent.enabled?{status:'NOT_REQUIRED',channels:[]}:await this.verify(chatId,memberId,r=>{responses=r;});capture?.(result,responses);
    if(official&&consent?.enabled&&grace&&grace.seconds>0&&(result.status==='MEMBER'||result.status==='NOT_MEMBER')){
      if(/^[1-9][0-9]{0,15}$/u.exec(memberId)?.[0]!==memberId||!Number.isSafeInteger(Number(memberId)))return {status:'DENIED',reason:'SUBSCRIPTION_EVIDENCE_STALE'};
      const graceResult=await this.store.transaction(s=>{const now=this.clock();if(!stillCurrent(s))return {status:'STALE' as const};
       const prior=s.subscriptionGraceMembers?.find(r=>r.chatId===chatId&&r.memberId===memberId);if(prior&&(prior.verifiedAt>now||prior.missingSince!==undefined&&prior.missingSince>now))return {status:'STALE' as const};
       const stamp=subscriptionGraceStamp(grace,consent);s.subscriptionGraceMembers=(s.subscriptionGraceMembers??[]).filter(r=>r.verifiedAt>now-30*86400000);
       const row=s.subscriptionGraceMembers.find(r=>r.chatId===chatId&&r.memberId===memberId);
       const witness=()=>JSON.stringify(s.subscriptionGraceMembers!.filter(r=>r.chatId===chatId&&r.memberId===memberId));
       if(result.status==='MEMBER'){const nextCheckAt=Math.min(8640000000000000,now+6*3600000);if(row){row.stamp=stamp;row.verifiedAt=now;row.nextCheckAt=nextCheckAt;delete row.missingSince;}else if(s.subscriptionGraceMembers.length<1000)s.subscriptionGraceMembers.push({chatId,memberId,stamp,verifiedAt:now,nextCheckAt});return {status:'CONTINUE' as const,witness:witness()};}
       if(!row)return s.subscriptionGraceMembers.length>=1000?{status:'FULL' as const}:{status:'CONTINUE' as const,witness:witness()};
       if(row.stamp!==stamp||row.verifiedAt>now)return {status:'CONTINUE' as const,witness:witness()};
       if(row.missingSince===undefined){row.missingSince=now;row.nextCheckAt=Math.min(8640000000000000,now+grace.seconds*1000);}return {status:now<row.missingSince+grace.seconds*1000?'WAIT' as const:'CONTINUE' as const,witness:witness()};
      });
      if(graceResult.status==='STALE')return {status:'DENIED',reason:'SUBSCRIPTION_EVIDENCE_STALE'};
      if(graceResult.status==='FULL')return {status:'DENIED',reason:'SUBSCRIPTION_GRACE_CAPACITY'};
      if(graceResult.status==='WAIT')return {status:'NO_CHANGE',reason:'SUBSCRIPTION_LEAVE_GRACE'};
      const priorCheck=stillCurrent,expected=graceResult.witness;stillCurrent=s=>priorCheck(s)&&JSON.stringify((s.subscriptionGraceMembers??[]).filter(r=>r.chatId===chatId&&r.memberId===memberId))===expected;
    }
    if(result.status==='MEMBER'||result.status==='NOT_REQUIRED'){
      // For a newly admitted member under BOTH independently approved gates,
      // a channel success alone must not lift a subscription-owned restriction
      // before CAPTCHA and the published rules have been accepted. No new
      // restriction is created merely because verification is pending.
      const captcha=new CaptchaService(this.store,this.policy,async()=> 'UNKNOWN',this.clock);
      const enforcement=new CaptchaEnforcement(this.store,this.policy,captcha,undefined,undefined,this.clock);
      const joined=enforcement.consent(before,chatId)?.enabled===true&&
        subscriptionRequirementMode(before,chatId)==='ACTIVE'&&
        captcha.challenge(before,chatId,memberId)!==null;
      if(joined){
        const rules=new CaptchaRuleGate(this.store,this.policy,captcha,async()=> 'UNKNOWN',this.clock);
        const complete=(s:BotState)=>enforcement.consent(s,chatId)?.enabled===true&&
         captcha.status(s,chatId,memberId)==='PASSED'&&
         ['ACCEPTED','NOT_REQUIRED'].includes(rules.status(s,chatId,memberId));
        if(!complete(before))return {status:'NO_CHANGE',reason:'ONBOARDING_PREREQUISITE_PENDING'};
        const prior=stillCurrent,challenge=captcha.challenge(before,chatId,memberId),
         rulesEpoch=rules.epoch(before,chatId),enforcementEpoch=enforcement.epoch(before,chatId);
        stillCurrent=s=>prior(s)&&complete(s)&&captcha.challenge(s,chatId,memberId)?.epoch===challenge?.epoch&&
         rules.epoch(s,chatId)===rulesEpoch&&enforcement.epoch(s,chatId)===enforcementEpoch;
      }
      return this.moderation.setSubscriptionReason(chatId,memberId,'subscription-gate',false,stillCurrent);
    }
    if(result.status==='NOT_MEMBER')
      return this.moderation.setSubscriptionReason(chatId,memberId,'subscription-gate',true,stillCurrent);
    return result; // Unavailable is NOT a confirmed violation or punishment.
  }
}
