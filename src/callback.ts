import { randomBytes } from 'node:crypto';
import { BotStore, type BotState } from './store.js';

export interface CallbackSpec {
  action: 'owner.dashboard' | 'education.navigate' | 'subscription.verify' | 'wizard.advance' |
   'owner.chat.ai_off' | 'owner.chat.restrict.assistant' | 'owner.chat.restrict.publishing' |
   'owner.chat.revoke' | 'owner.subscription.pause';
  chatId: string;
  actorId?: string;
  policyVersion: number;
  expiresAt: number;
  oneShot: boolean;
  requirementVersion?: number;
}
export class CallbackActionCodec {
  constructor(private readonly store: BotStore, private readonly clock: () => number = Date.now) {}
  async issue(spec: CallbackSpec): Promise<string> {
    if (!spec.chatId || spec.expiresAt <= this.clock() || !Number.isInteger(spec.policyVersion) ||
        (spec.requirementVersion!==undefined && (!Number.isSafeInteger(spec.requirementVersion) || spec.requirementVersion<1))) throw new Error('Invalid callback scope or expiry');
    const ref = 'c_' + randomBytes(18).toString('base64url'); // 26 ASCII bytes, unpredictable
    if (Buffer.byteLength(ref) > 64) throw new Error('Telegram callback limit');
    await this.store.transaction(s => { s.callbacks.push({ ...spec, ref, used: false, revoked: false }); });
    return ref;
  }
  async consume(ref: string, actorId: string, chatId: string, policyVersion: number, authorized: (action: string, state: BotState) => boolean): Promise<{ ok: boolean; action?: string; reason: string }> {
    if (!/^c_[A-Za-z0-9_-]{24}$/.test(ref)) return { ok: false, reason: 'INVALID_REF' };
    return this.store.transaction(s => {
      const c = s.callbacks.find(c => c.ref === ref);
      if (!c || c.revoked || c.used || c.expiresAt <= this.clock() || c.chatId !== chatId || c.policyVersion !== policyVersion || (c.actorId && c.actorId !== actorId)) return { ok: false, reason: 'STALE_OR_UNAUTHORIZED' };
      if (chatId.startsWith('-') && (s.chats.find(x => x.id === chatId)?.version ?? 0) !== policyVersion) return { ok: false, reason: 'REVOKED_POLICY' };
      if (!authorized(c.action, s)) return { ok: false, reason: 'ACTION_NOT_AUTHORIZED' };
      if (c.oneShot) c.used = true;
      return { ok: true, action: c.action, reason: 'VALID' };
    });
  }
  async revoke(ref: string): Promise<void> { await this.store.transaction(s => { const c = s.callbacks.find(x => x.ref === ref); if (c) c.revoked = true; }); }
}
