import { randomUUID } from 'node:crypto';
import { BotStore, type BotState, type ModerationReason, type ModerationOperation, type RestrictionKind } from './store.js';
import { Policy } from './policy.js';

export type RestrictionOutcome = 'CONFIRMED' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME';
export type ModerationResult = { status: 'APPLIED' | 'NO_CHANGE' | 'DENIED' | 'BLOCKED_PENDING' | 'BLOCKED_UNKNOWN' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME'; reason: string };
export interface ModerationGateway {
  canRestrict(chatId: string, memberId: string): Promise<boolean>;
  isProtected(chatId: string, memberId: string): Promise<boolean>;
  setRestriction(chatId: string, memberId: string, kind: RestrictionKind): Promise<RestrictionOutcome>;
}
export class FakeModerationGateway implements ModerationGateway {
  rights = true;
  protectedMembers = new Set<string>();
  calls: { chatId: string; memberId: string; kind: RestrictionKind }[] = [];
  throwAfterSend = false;
  outcome: RestrictionOutcome = 'CONFIRMED';
  async canRestrict(_chatId: string, _memberId: string): Promise<boolean> { return this.rights; }
  async isProtected(chatId: string, memberId: string): Promise<boolean> { return this.protectedMembers.has(chatId + ':' + memberId); }
  async setRestriction(chatId: string, memberId: string, kind: RestrictionKind): Promise<RestrictionOutcome> {
    this.calls.push({ chatId, memberId, kind });
    if (this.throwAfterSend) throw new Error('network timeout with ambiguous delivery');
    return this.outcome;
  }
}
const byTarget = (r: {chatId: string; memberId: string}, chatId: string, memberId: string): boolean => r.chatId === chatId && r.memberId === memberId;
const fingerprint = (s: BotState, chatId: string, memberId: string): string =>
  JSON.stringify(s.moderationReasons.filter(x => byTarget(x, chatId, memberId) && x.active)
    .map(x => [x.source, x.reference, x.kind]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

/** B2-Core simulation: no automatic Telegram mutations outside a fake gateway. */
export class ModerationService {
  /** Test-only hook models policy revocation after an intent has been written. */
  beforeDispatch: (() => Promise<void>) | undefined;
  constructor(private readonly store: BotStore, private readonly policy: Policy, private readonly gateway: ModerationGateway, private readonly clock: () => number = Date.now) {}
  effective(s: BotState, chatId: string, memberId: string): RestrictionKind {
    const reasons = s.moderationReasons.filter(r => byTarget(r, chatId, memberId) && r.active);
    return reasons.some(r => r.kind === 'BAN') ? 'BAN' : reasons.some(r => r.kind === 'MUTE') ? 'MUTE' : 'NONE';
  }
  private authorized(s: BotState, actorId: string, chatId: string, memberId: string): boolean {
    return actorId !== memberId && memberId !== this.policy.ownerId && /^\d+$/.test(memberId) && memberId !== '0' &&
      this.policy.canUseChat(s, chatId, 'moderation') && this.policy.has(s, actorId, 'chat.manage', chatId, this.clock());
  }
  private async check(actorId: string, chatId: string, memberId: string): Promise<boolean> {
    return this.authorized(await this.store.snapshot(), actorId, chatId, memberId) &&
      await this.gateway.canRestrict(chatId, memberId) && !await this.gateway.isProtected(chatId, memberId);
  }
  async addManualReason(actorId: string, chatId: string, memberId: string, reference: string, kind: 'MUTE' | 'BAN'): Promise<ModerationResult> {
    if (!reference || reference.length > 80 || !['MUTE', 'BAN'].includes(kind)) throw new Error('Invalid reason');
    if (!await this.check(actorId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const added = await this.store.transaction(s => {
      if (!this.authorized(s, actorId, chatId, memberId)) return false;
      const existing = s.moderationReasons.find(x => byTarget(x, chatId, memberId) && x.source === 'MANUAL' && x.reference === reference);
      if (existing?.active) { if (existing.kind !== kind) throw new Error('REASON_CONFLICT'); return false; }
      if (existing) { existing.kind = kind; existing.active = true; existing.createdBy = actorId; }
      else s.moderationReasons.push({ chatId, memberId, source: 'MANUAL', reference, kind, createdBy: actorId, active: true });
      return true;
    });
    if (!added) return { status: 'NO_CHANGE', reason: 'DUPLICATE_OR_REVOKED' };
    return this.reconcile(actorId, chatId, memberId);
  }
  async removeManualReason(actorId: string, chatId: string, memberId: string, reference: string): Promise<ModerationResult> {
    if (!await this.check(actorId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const changed = await this.store.transaction(s => {
      if (!this.authorized(s, actorId, chatId, memberId)) return false;
      const found = s.moderationReasons.find(x => byTarget(x, chatId, memberId) && x.source === 'MANUAL' && x.reference === reference && x.active);
      if (!found) return false;
      found.active = false; return true;
    });
    return changed ? this.reconcile(actorId, chatId, memberId) : { status: 'NO_CHANGE', reason: 'NOT_ACTIVE' };
  }
  /** Invoked only by SubscriptionGate's trusted membership reconciliation; never expose as a user command. */
  async setSubscriptionReason(chatId: string, memberId: string, reference: string, active: boolean): Promise<ModerationResult> {
    if (!reference || reference.length > 80 || !await this.check(this.policy.ownerId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const changed = await this.store.transaction(s => {
      if (!this.authorized(s, this.policy.ownerId, chatId, memberId)) return false;
      const found = s.moderationReasons.find(x => byTarget(x, chatId, memberId) && x.source === 'SUBSCRIPTION' && x.reference === reference);
      if (Boolean(found?.active) === active) return false;
      if (found) found.active = active;
      else if (active) s.moderationReasons.push({ chatId, memberId, source: 'SUBSCRIPTION', reference, kind: 'MUTE', createdBy: 'SYSTEM_SUBSCRIPTION', active: true });
      return true;
    });
    return changed ? this.reconcile(this.policy.ownerId, chatId, memberId) : { status: 'NO_CHANGE', reason: 'REASON_UNCHANGED' };
  }
  async issueWarning(actorId: string, chatId: string, memberId: string, reference: string): Promise<{ status: 'ADDED' | 'NO_CHANGE' | 'DENIED'; count: number }> {
    if (!reference || reference.length > 80) throw new Error('Invalid warning reference');
    return this.store.transaction(s => {
      const count = () => s.warnings.filter(w => byTarget(w, chatId, memberId) && w.active).length;
      if (!this.authorized(s, actorId, chatId, memberId)) return { status: 'DENIED' as const, count: count() };
      const existing = s.warnings.find(w => byTarget(w, chatId, memberId) && w.reference === reference);
      if (existing) return { status: 'NO_CHANGE' as const, count: count() }; // immutable reference; cannot replay revoked warning
      s.warnings.push({ actorId, chatId, memberId, reference, at: this.clock(), active: true });
      return { status: 'ADDED' as const, count: count() };
    });
  }
  async removeWarning(actorId: string, chatId: string, memberId: string, reference: string): Promise<{ status: 'REVOKED' | 'NO_CHANGE' | 'DENIED'; count: number }> {
    return this.store.transaction(s => {
      const count = () => s.warnings.filter(w => byTarget(w, chatId, memberId) && w.active).length;
      if (!this.authorized(s, actorId, chatId, memberId)) return { status: 'DENIED' as const, count: count() };
      const existing = s.warnings.find(w => byTarget(w, chatId, memberId) && w.reference === reference && w.active);
      if (!existing) return { status: 'NO_CHANGE' as const, count: count() };
      existing.active = false;
      return { status: 'REVOKED' as const, count: count() };
    });
  }
  async reconcile(actorId: string, chatId: string, memberId: string): Promise<ModerationResult> {
    if (!await this.check(actorId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const candidate = await this.store.transaction(s => {
      if (!this.authorized(s, actorId, chatId, memberId)) return { status: 'DENIED' as const };
      const operations = s.moderationOperations.filter(x => byTarget(x, chatId, memberId));
      if (operations.some(x => x.status === 'UNKNOWN_OUTCOME')) return { status: 'BLOCKED_UNKNOWN' as const };
      if (operations.some(x => ['STARTED', 'INTENT'].includes(x.status))) return { status: 'BLOCKED_PENDING' as const };
      const desired = this.effective(s, chatId, memberId);
      const confirmed = operations.filter(x => x.status === 'CONFIRMED').at(-1)?.kind ?? 'NONE';
      if (desired === confirmed) return { status: 'NO_CHANGE' as const };
      const op: ModerationOperation = { id: randomUUID(), chatId, memberId, actorId, kind: desired, reasonFingerprint: fingerprint(s, chatId, memberId), policyVersion: this.policy.chatRevision(s, chatId), status: 'INTENT', createdAt: this.clock() };
      s.moderationOperations.push(op);
      return { status: 'READY' as const, id: op.id };
    });
    if (candidate.status !== 'READY') return { status: candidate.status, reason: 'NO_SAFE_DISPATCH' };
    if (this.beforeDispatch) await this.beforeDispatch();
    // Don't pre-mark effects. Verify both external rights and internal policy immediately before STARTED.
    const rights = await this.gateway.canRestrict(chatId, memberId) && !await this.gateway.isProtected(chatId, memberId);
    const started = await this.store.transaction(s => {
      const op = s.moderationOperations.find(x => x.id === candidate.id)!;
      const valid = rights && this.authorized(s, actorId, chatId, memberId) &&
        this.policy.chatRevision(s, chatId) === op.policyVersion && fingerprint(s, chatId, memberId) === op.reasonFingerprint;
      if (!valid) { op.status = 'CANCELLED'; return false; }
      op.status = 'STARTED'; return true;
    });
    if (!started) return { status: 'DENIED', reason: 'REVOKED_BEFORE_DISPATCH' };
    let outcome: RestrictionOutcome;
    try { outcome = await this.gateway.setRestriction(chatId, memberId, (await this.store.snapshot()).moderationOperations.find(x => x.id === candidate.id)!.kind); }
    catch { outcome = 'UNKNOWN_OUTCOME'; }
    await this.store.transaction(s => {
      const op = s.moderationOperations.find(x => x.id === candidate.id)!;
      if (op.status !== 'STARTED') throw new Error('Invalid moderation operation');
      op.status = outcome;
    });
    return { status: outcome === 'CONFIRMED' ? 'APPLIED' : outcome, reason: outcome };
  }
}