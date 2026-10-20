import { BotStore, type BotState } from './store.js';
import { Policy } from './policy.js';
import { ModerationService, type ModerationResult } from './moderation.js';

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
    for (const id of channelIds) {
      if (!/^-[0-9]+$/.test(id) || !this.policy.canUseChat(state, id, 'verification')) throw new Error('CHANNEL_NOT_APPROVED');
      if (!await this.membership.canVerifyChannel(id)) throw new Error('CHANNEL_UNVERIFIABLE');
    }
    await this.store.transaction(s => {
      if (!this.policy.canUseChat(s, chatId, 'verification') || channelIds.some(id => !this.policy.canUseChat(s, id, 'verification'))) throw new Error('APPROVAL_REVOKED');
      const old = s.subscriptionRequirements.find(x => x.chatId === chatId);
      if (old) { old.channelIds = channelIds; old.mode = mode; old.version++; }
      else s.subscriptionRequirements.push({ chatId, channelIds, mode, version: 1 });
    });
  }
  /**
   * Strictly reductive owner operation: remove one existing mandatory channel.
   * No external provider check can be needed to *remove* a requirement.
   * Both the group policy version and subscription rule version must match in
   * the same transaction, rejecting stale view or one-click resurrection.
   * This never automatically lifts an existing moderation restriction.
   */
  async removeRequiredChannelAtRevision(actorId:string,chatId:string,channelId:string,
    expectedChatRevision:number,expectedRequirementRevision:number):Promise<void>{
    if(!this.policy.isOwner(actorId))throw Error('OWNER_ONLY');
    if(!/^-[1-9][0-9]{0,18}$/.test(chatId)||!/^-[1-9][0-9]{0,18}$/.test(channelId))
      throw Error('INVALID_CHANNEL_ID');
    await this.store.transaction(s=>{
      const chat=s.chats.find(c=>c.id===chatId);
      if(!chat?.approved||!chat.scopes.includes('verification'))throw Error('GROUP_NOT_APPROVED');
      const config=s.subscriptionRequirements.find(c=>c.chatId===chatId);
      if(!config?.channelIds.includes(channelId))throw Error('CHANNEL_NOT_REQUIRED');
      if(!Number.isSafeInteger(expectedChatRevision)||!Number.isSafeInteger(expectedRequirementRevision)||
         expectedChatRevision<=0||expectedRequirementRevision<=0||
         chat.version!==expectedChatRevision||config.version!==expectedRequirementRevision)
        throw Error('SUBSCRIPTION_POLICY_STALE');
      config.channelIds=config.channelIds.filter(id=>id!==channelId);
      config.version++;chat.version++;
      s.audit.push({updateKey:'owner:subscription:remove-channel:'+chatId+':'+config.version,
        decision:'ALLOW',reason:'SUBSCRIPTION_REQUIRED_CHANNEL_REMOVED_LOCALLY',
        policyVersion:chat.version,at:this.clock()});
    });
  }
  async verify(chatId: string, userId: string): Promise<SubscriptionDecision> {
    const s = await this.store.snapshot();
    if (!userId || !this.policy.canUseChat(s, chatId, 'verification')) return { status: 'DENIED', channels: [] };
    const config = s.subscriptionRequirements.find(x => x.chatId === chatId);
    if (!config?.channelIds.length || this.policy.isOwner(userId)) return { status: 'NOT_REQUIRED', channels: [] };
    const responses: Membership[] = [];
    for (const channel of config.channelIds) {
      if (!this.policy.canUseChat(s, channel, 'verification') || !await this.membership.canVerifyChannel(channel)) return { status: 'UNAVAILABLE', channels: [] };
      let response: Membership;
      try { response = await this.membership.getMember(channel, userId); } catch { response = 'UNKNOWN'; }
      responses.push(response);
    }
    // Revalidation protects changes made while external checks were in flight.
    const latest = await this.store.snapshot();
    const current = latest.subscriptionRequirements.find(x => x.chatId === chatId);
    if (!this.policy.canUseChat(latest, chatId, 'verification') || !current || current.version !== config.version ||
        config.channelIds.some(id => !this.policy.canUseChat(latest, id, 'verification'))) return { status: 'UNAVAILABLE', channels: [] };
    const passing = config.mode === 'ALL' ? responses.every(x => x === 'MEMBER') : responses.some(x => x === 'MEMBER');
    const failing = config.mode === 'ALL' ? responses.some(x => x === 'NOT_MEMBER') : responses.every(x => x === 'NOT_MEMBER');
    return { status: passing ? 'MEMBER' : failing ? 'NOT_MEMBER' : 'UNAVAILABLE', channels: [...config.channelIds] };
  }
  async syncSubscriptionRestriction(chatId: string, memberId: string): Promise<ModerationResult | SubscriptionDecision> {
    const result = await this.verify(chatId, memberId);
    if (result.status === 'MEMBER' || result.status === 'NOT_REQUIRED') return this.moderation.setSubscriptionReason(chatId, memberId, 'subscription-gate', false);
    if (result.status === 'NOT_MEMBER') return this.moderation.setSubscriptionReason(chatId, memberId, 'subscription-gate', true);
    return result; // Unavailable is NOT a confirmed violation or punishment.
  }
}