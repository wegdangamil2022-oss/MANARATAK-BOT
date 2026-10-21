import { BotStore, type BotState } from './store.js';
import { Policy } from './policy.js';
import { ModerationService, type ModerationResult } from './moderation.js';
import {isCanonicalSubscriptionRule} from './subscription-integrity.js';

export type Membership = 'MEMBER' | 'NOT_MEMBER' | 'UNKNOWN';
export type SubscriptionDecision = { status: 'MEMBER' | 'NOT_MEMBER' | 'UNAVAILABLE' | 'NOT_REQUIRED' | 'DENIED'; channels: string[] };
export interface MembershipGateway {
  canVerifyChannel(channelId: string): Promise<boolean>;
  getMember(channelId: string, userId: string): Promise<Membership>;
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
  async configure(actorId: string, chatId: string, channelIds: string[], mode: 'ALL' | 'ANY'): Promise<void> {
    if (!this.policy.isOwner(actorId)) throw new Error('OWNER_ONLY');
    if (!['ALL', 'ANY'].includes(mode) || channelIds.length > 10 || new Set(channelIds).size !== channelIds.length) throw new Error('INVALID_SUBSCRIPTION_CONFIG');
    const state = await this.store.snapshot();
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
      // The provider may reject or time out even while a saved local channel
      // grant remains valid. Never leak provider errors through an owner API.
      let permitted=false;
      try{permitted=await this.membership.canVerifyChannel(id);}
      catch{throw new Error('CHANNEL_UNVERIFIABLE');}
      if(!permitted)throw new Error('CHANNEL_UNVERIFIABLE');
    }
    await this.store.transaction(s => {
      if (!this.policy.canUseChat(s, chatId, 'verification') ||
          s.chats.find(c=>c.id===chatId)?.version!==groupEpoch ||
          channelIds.some(id => !this.policy.canUseChat(s, id, 'verification') ||
            s.chats.find(c=>c.id===id)?.version!==channelEpochs.get(id)))
        throw new Error('APPROVAL_REVOKED');
      const old = s.subscriptionRequirements.find(x => x.chatId === chatId);
      if(old?.version!==priorRuleVersion)throw new Error('SUBSCRIPTION_CONFIG_STALE');
      if (old) { old.channelIds = channelIds; old.mode = mode; old.version++; }
      else s.subscriptionRequirements.push({ chatId, channelIds, mode, version: 1 });
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
  async verify(chatId: string, userId: string): Promise<SubscriptionDecision> {
    const s = await this.store.snapshot();
    if (!userId || !this.policy.canUseChat(s, chatId, 'verification')) return { status: 'DENIED', channels: [] };
    const config = s.subscriptionRequirements.find(x => x.chatId === chatId);
    if(!config)return {status:'NOT_REQUIRED',channels:[]};
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
        !current || current.version !== config.version ||
        current.mode!==config.mode ||
        current.channelIds.length!==config.channelIds.length ||
        current.channelIds.some((id,i)=>id!==config.channelIds[i]) ||
        config.channelIds.some(id => !this.policy.canUseChat(latest, id, 'verification') ||
          latest.chats.find(c=>c.id===id)?.version!==channelEpochs.get(id)))
      return { status: 'UNAVAILABLE', channels: [] };
    // An unknown result from the provider must not be used to punish a
    // student. For ALL, even a known negative alongside an unavailable
    // channel is treated as UNAVAILABLE until all evidence is known.
    // For ANY, one verified MEMBER suffices independently of other unknowns.
    const passing=config.mode==='ALL'
     ?responses.every(x=>x==='MEMBER')
     :responses.some(x=>x==='MEMBER');
    const complete=responses.every(x=>x!=='UNKNOWN');
    const failing=complete&&(config.mode==='ALL'
     ?responses.some(x=>x==='NOT_MEMBER')
     :responses.every(x=>x==='NOT_MEMBER'));
    return {status:passing?'MEMBER':failing?'NOT_MEMBER':'UNAVAILABLE',
     channels:[...config.channelIds]};
  }
  async syncSubscriptionRestriction(chatId: string, memberId: string): Promise<ModerationResult | SubscriptionDecision> {
    // The public verify() response contains no durable proof. Keep a private
    // pre-check epoch and require the SAME saved rule/group/channel epochs in
    // ModerationService's atomic reason-write and immediately before dispatch.
    // This closes the window *after* verify() revalidation but *before*
    // moderation's external rights check and Telegram-effect intent.
    const before=await this.store.snapshot();
    const groupEpoch=this.policy.chatRevision(before,chatId);
    const rule=before.subscriptionRequirements.find(x=>x.chatId===chatId);
    const channelEpochs=new Map((rule?.channelIds??[]).map(id=>
      [id,this.policy.chatRevision(before,id)] as const));
    const stillCurrent=(s:BotState):boolean=>{
      if(!this.policy.canUseChat(s,chatId,'verification')||
        this.policy.chatRevision(s,chatId)!==groupEpoch)return false;
      const current=s.subscriptionRequirements.find(x=>x.chatId===chatId);
      if(!rule)return !current;
      if(!current||!isCanonicalSubscriptionRule(rule)||
        !isCanonicalSubscriptionRule(current)||current.version!==rule.version||
        current.mode!==rule.mode||current.channelIds.length!==rule.channelIds.length||
        current.channelIds.some((id,i)=>id!==rule.channelIds[i]))return false;
      return rule.channelIds.every(id=>
        this.policy.canUseChat(s,id,'verification')&&
        this.policy.chatRevision(s,id)===channelEpochs.get(id));
    };
    const result=await this.verify(chatId,memberId);
    if(result.status==='MEMBER'||result.status==='NOT_REQUIRED')
      return this.moderation.setSubscriptionReason(chatId,memberId,'subscription-gate',false,stillCurrent);
    if(result.status==='NOT_MEMBER')
      return this.moderation.setSubscriptionReason(chatId,memberId,'subscription-gate',true,stillCurrent);
    return result; // Unavailable is NOT a confirmed violation or punishment.
  }
}