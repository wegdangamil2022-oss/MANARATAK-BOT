import {subscriptionEnforcementConsent,subscriptionEnforcementStamp} from './subscription-enforcement-policy.js';
import { BotStore, type BotState } from './store.js';
import { Policy } from './policy.js';
import { ModerationService, type ModerationResult } from './moderation.js';
import {isCanonicalSubscriptionRule,subscriptionRequirementMode} from './subscription-integrity.js';
import {subscriptionConfigEpoch} from './subscription-config-epoch.js';

export type Membership = 'MEMBER' | 'NOT_MEMBER' | 'UNKNOWN';
export type SubscriptionDecision = { status: 'MEMBER' | 'NOT_MEMBER' | 'UNAVAILABLE' | 'NOT_REQUIRED' | 'DENIED'; channels: string[] };
export interface MembershipGateway {
  canVerifyChannel(channelId: string): Promise<boolean>;
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
      if (old) { old.channelIds = channelIds; old.mode = mode; old.version++; }
      else s.subscriptionRequirements.push({ chatId, channelIds, mode, version: 1 });
      const saved=s.subscriptionRequirements.find(r=>r.chatId===chatId)!;
      if(mode==='AT_LEAST')saved.minimumCount=minimumCount!;else delete saved.minimumCount;
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
    const responses: Membership[] = [];
    for (const channel of config.channelIds) {
      if (!this.policy.canUseChat(s, channel, 'verification'))
       return {status:'UNAVAILABLE',channels:[]};
      let verifiable=false;
      try{verifiable=await this.membership.canVerifyChannel(channel);}
      catch{return {status:'UNAVAILABLE',channels:[]};}
      if(!verifiable)return {status:'UNAVAILABLE',channels:[]};
      let response: Membership;
      try{
       const received=await this.membership.getMember(channel,userId);
       response=received==='MEMBER'||received==='NOT_MEMBER'?received:'UNKNOWN';
      }catch{response='UNKNOWN';}
      responses.push(response);
    }
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
  async automaticMode(chat:string):Promise<'ON'|'OFF'|'UNAVAILABLE'>{if(!this.supportsAutomaticEnforcement())return 'UNAVAILABLE';const c=subscriptionEnforcementConsent(await this.store.snapshot(),this.policy,chat,this.clock());return c?c.enabled?'ON':'OFF':'UNAVAILABLE';}
  async validateEnforcementConfiguration(actor:string,chat:string,expectedEpoch:string):Promise<boolean>{
    const s=await this.store.snapshot(),rule=s.subscriptionRequirements.find(r=>r.chatId===chat);if(!this.policy.isOwner(actor)||!this.supportsAutomaticEnforcement()||subscriptionConfigEpoch(s)!==expectedEpoch||!subscriptionEnforcementStamp(s,this.policy,chat)||!rule||!rule.channelIds.length)return false;
    try{if(!(await Promise.all(rule.channelIds.map(id=>this.membership.canVerifyChannel(id)))).every(Boolean))return false;}catch{return false;}
    return subscriptionConfigEpoch(await this.store.snapshot())===expectedEpoch;
  }
  async synchronizeAutomatic(chat:string,member:string):Promise<{decision:SubscriptionDecision;effect?:ModerationResult|SubscriptionDecision;verified?:number;unknown?:number;total?:number}>{
    if(await this.automaticMode(chat)==='UNAVAILABLE')return {decision:{status:'DENIED',channels:[]}};
    let decision:SubscriptionDecision={status:'UNAVAILABLE',channels:[]},responses:Membership[]=[];const effect=await this.syncSubscriptionRestriction(chat,member,(d,r)=>{decision=structuredClone(d);responses=r;});return {decision,effect,verified:responses.filter(r=>r==='MEMBER').length,unknown:responses.filter(r=>r==='UNKNOWN').length,total:decision.channels.length};
  }
  async syncSubscriptionRestriction(chatId: string, memberId: string,capture?:(decision:SubscriptionDecision,responses:Membership[])=>void): Promise<ModerationResult | SubscriptionDecision> {
    // The public verify() response contains no durable proof. Keep a private
    // pre-check epoch and require the SAME saved rule/group/channel epochs in
    // ModerationService's atomic reason-write and immediately before dispatch.
    // This closes the window *after* verify() revalidation but *before*
    // moderation's external rights check and Telegram-effect intent.
    const before=await this.store.snapshot(),verifiedAt=this.clock(),official=this.supportsAutomaticEnforcement(),consent=subscriptionEnforcementConsent(before,this.policy,chatId,verifiedAt);
    const groupEpoch=this.policy.chatRevision(before,chatId);
    const rule=before.subscriptionRequirements.find(x=>x.chatId===chatId);
    const channelEpochs=new Map((rule?.channelIds??[]).map(id=>
      [id,this.policy.chatRevision(before,id)] as const));
    const stillCurrent=(s:BotState):boolean=>{
      const now=this.clock();if(official&&(!Number.isSafeInteger(now)||now<verifiedAt||now>=verifiedAt+5000||JSON.stringify(subscriptionEnforcementConsent(s,this.policy,chatId,now))!==JSON.stringify(consent)))return false;
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
    if(result.status==='MEMBER'||result.status==='NOT_REQUIRED')
      return this.moderation.setSubscriptionReason(chatId,memberId,'subscription-gate',false,stillCurrent);
    if(result.status==='NOT_MEMBER')
      return this.moderation.setSubscriptionReason(chatId,memberId,'subscription-gate',true,stillCurrent);
    return result; // Unavailable is NOT a confirmed violation or punishment.
  }
}
