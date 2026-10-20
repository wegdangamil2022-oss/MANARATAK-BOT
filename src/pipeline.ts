import { BotStore, type AuditRecord, type BotState } from './store.js';
import { Policy } from './policy.js';
import { CallbackActionCodec } from './callback.js';
import type { SubscriptionGate } from './subscription.js';

export interface BotUpdate {
  botId: string; updateId: number;
  kind: 'message' | 'callback' | 'membership' | 'inline';
  chatKind?: 'private' | 'group' | 'channel'; chatId?: string;
  actorId?: string; mentionTarget?: string; callbackRef?: string;
  hasFile?: boolean; subscriptionVerified?: boolean; moderationAllowed?: boolean; // simulated legacy flags; membership claims are never trusted
  transportVerified?: boolean;
}
export type PipelineResult = { status: 'DENIED' | 'NOOP' | 'ALLOWED' | 'DUPLICATE' | 'UNKNOWN'; reason: string };
export interface TelegramGateway {
  leaveChat(chatId: string): Promise<'CONFIRMED' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME'>;
  botHasPermission(chatId: string): Promise<boolean>;
  acknowledgeCallback(updateId: number): Promise<void>;
}
export class FakeTelegramGateway implements TelegramGateway {
  leaves: string[] = []; callbackAcks: number[] = []; downloads = 0; aiCalls = 0;
  rights = true;
  async leaveChat(chatId: string): Promise<'CONFIRMED'> { this.leaves.push(chatId); return 'CONFIRMED'; }
  async botHasPermission(_chatId: string): Promise<boolean> { return this.rights; }
  async acknowledgeCallback(updateId: number): Promise<void> { this.callbackAcks.push(updateId); }
}

/** B1 simulation only. The live Telegram transport does not exist in this package. */
export class UpdatePipeline {
  constructor(private readonly store: BotStore, private readonly policy: Policy, private readonly gateway: TelegramGateway, private readonly callbacks: CallbackActionCodec, private readonly clock: () => number = Date.now, private readonly subscription?: SubscriptionGate) {}
  private invalid(u: BotUpdate): boolean {
    return u.transportVerified === false || !u.botId || !Number.isSafeInteger(u.updateId) || u.updateId < 0 ||
      !['message', 'callback', 'membership', 'inline'].includes(u.kind) ||
      (u.kind !== 'inline' && (!u.chatId || !u.chatKind)) ||
      (u.kind === 'callback' && !u.callbackRef);
  }
  private async finish(key: string, status: PipelineResult['status'], reason: string, version: number): Promise<PipelineResult> {
    const decision: AuditRecord = { updateKey: key, decision: status === 'DENIED' ? 'DENY' : status === 'ALLOWED' ? 'ALLOW' : 'NOOP', reason, policyVersion: version, at: this.clock() };
    await this.store.finish(key, decision);
    return { status, reason };
  }
  private isApproved(s: BotState, chatId: string): boolean { return s.chats.some(x => x.id === chatId && x.approved); }
  async handle(update: BotUpdate): Promise<PipelineResult> {
    if (this.invalid(update)) return { status: 'DENIED', reason: 'INVALID_ENVELOPE' };
    const key = update.botId + ':' + update.updateId;
    const claim = await this.store.claim(key, this.clock());
    if (claim !== 'CLAIMED') return { status: claim, reason: 'DEDUPLICATED_OR_UNRESOLVED' };
    const s = await this.store.snapshot();
    const chatId = update.chatId ?? '';
    const revision = this.policy.chatRevision(s, chatId);
    // Inline updates without a trustworthy chat context are disabled in B1.
    if (update.kind === 'inline') return this.finish(key, 'DENIED', 'INLINE_DISABLED', revision);
    if (update.chatKind !== 'private' && !this.isApproved(s, chatId)) {
      // Audit first; then persist intent before fake external effect.
      const reason = 'CHAT_NOT_APPROVED';
      await this.store.recordDecision({ updateKey: key, decision: 'DENY', reason, policyVersion: revision, at: this.clock() });
      const operationId = await this.store.addIntent(key, 'CHAT_LEAVE', chatId, revision);
      const latest = await this.store.snapshot();
      if (this.isApproved(latest, chatId)) {
        await this.store.cancelIntent(operationId); // Reactivation cancels unsent leave.
      } else {
        await this.store.markStarted(operationId, this.clock());
        let outcome: 'CONFIRMED' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME';
        try { outcome = await this.gateway.leaveChat(chatId); }
        catch { outcome = 'UNKNOWN_OUTCOME'; }
        await this.store.markOutcome(operationId, outcome);
      }
      return this.finish(key, 'DENIED', reason, revision);
    }
    if (update.kind === 'membership') return this.finish(key, 'NOOP', 'LIFECYCLE_OBSERVED', revision);
    if (update.chatKind !== 'private' && !await this.gateway.botHasPermission(chatId)) return this.finish(key, 'DENIED', 'BOT_RIGHTS_MISSING', revision);
    if (update.chatKind !== 'private' && !this.isApproved(s, chatId)) return this.finish(key, 'DENIED', 'CHAT_NOT_APPROVED', revision);
    if (update.kind === 'callback') {
      // Transport acknowledgement is not confirmation that the operation succeeded.
      try { await this.gateway.acknowledgeCallback(update.updateId); } catch { /* log through adapter in real transport */ }
      const current = await this.store.snapshot();
      const result = await this.callbacks.consume(update.callbackRef!, update.actorId ?? '', chatId, this.policy.chatRevision(current, chatId),  (action, live) => {
        if (update.chatKind !== 'private' && !this.isApproved(live, chatId)) return false;
        if (action === 'owner.dashboard') return update.chatKind === 'private' && this.policy.privateFeature(live, action, update.actorId);
        if (action === 'education.navigate') return update.chatKind === 'private' ? this.policy.privateFeature(live, action, update.actorId) : this.policy.canUseChat(live, chatId, 'navigation');
        if (action === 'subscription.verify') return this.policy.privateFeature(live, action, update.actorId) || this.policy.canUseChat(live, chatId, 'verification');
        return false; // Wizard action is a separate handler, not silently executed here.
      });
      return this.finish(key, result.ok ? 'ALLOWED' : 'DENIED', result.ok ? 'AUTHORIZED_CALLBACK_NO_EXTERNAL_ACTION' : result.reason, revision);
    }
    if (update.moderationAllowed === false) return this.finish(key, 'DENIED', 'MODERATION_DENIED', revision);
    if (update.chatKind === 'private') {
      if (!update.actorId) return this.finish(key, 'DENIED', 'MISSING_ACTOR', revision);
      if (this.policy.mayAskPrivate(s, update.actorId, update.mentionTarget === 'bot')) return this.finish(key, 'DENIED', 'AI_NOT_CONFIGURED', revision);
      return this.finish(key, 'NOOP', 'PRIVATE_AI_OFF_OR_NO_REQUEST', revision);
    }
    if (update.mentionTarget === 'bot') {
      if (!this.policy.canUseChat(s, chatId, 'assistant') || !this.policy.mayAskGroup(s, chatId, update.actorId, true)) return this.finish(key, 'DENIED', 'GROUP_AI_DENIED', revision);
      // Ignore user-supplied `subscriptionVerified`: membership must come from a trusted provider.
      const requirement = (await this.store.snapshot()).subscriptionRequirements.find(x => x.chatId === chatId && x.channelIds.length);
      if (requirement) {
        if (!this.subscription) return this.finish(key, 'DENIED', 'SUBSCRIPTION_UNAVAILABLE', revision);
        const checked = await this.subscription.verify(chatId, update.actorId ?? '');
        if (checked.status === 'NOT_MEMBER') return this.finish(key, 'DENIED', 'SUBSCRIPTION_REQUIRED', revision);
        if (!['MEMBER', 'NOT_REQUIRED'].includes(checked.status)) return this.finish(key, 'DENIED', 'SUBSCRIPTION_UNAVAILABLE', revision);
      }
      // Capability is allowed by policy, but no AI provider, downloads or generation exist in B2.
      return this.finish(key, 'DENIED', 'AI_NOT_CONFIGURED', revision);
    }
    return this.finish(key, 'NOOP', 'NO_ACTION_IN_B1', revision);
  }
}