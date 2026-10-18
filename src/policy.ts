import { BotStore, type BotState, type Capability, type GroupAIMode, type PrivateAIMode } from './store.js';

export class Policy {
  constructor(private readonly store: BotStore, readonly ownerId: string, private readonly clock: () => number = Date.now) {
    if (!/^\d+$/.test(ownerId) || ownerId === '0') throw new Error('Owner ID must come from trusted configuration');
  }
  isOwner(actor: string | undefined): boolean { return actor === this.ownerId; }
  has(s: BotState, actor: string | undefined, capability: Capability, chatId: string, now = this.clock()): boolean {
    if (!actor) return false;
    if (this.isOwner(actor)) return true;
    return s.grants.some(g => g.actor === actor && g.capability === capability && g.chatId === chatId && !g.revoked && g.expiresAt > now);
  }
  private requireOwner(actor: string): void { if (!this.isOwner(actor)) throw new Error('OWNER_ONLY'); }
  async approveChat(actor: string, chatId: string, scopes: string[]): Promise<void> {
    this.requireOwner(actor);
    if (!/^-[0-9]+$/.test(chatId)) throw new Error('Only explicit Telegram group/channel IDs can be approved');
    if (!scopes.length || scopes.some(x => !['navigation', 'assistant', 'moderation', 'verification'].includes(x))) throw new Error('Invalid scopes');
    await this.store.transaction(s => {
      const c = s.chats.find(c => c.id === chatId);
      if (c) { c.approved = true; c.scopes = [...new Set(scopes)]; c.version++; }
      else s.chats.push({ id: chatId, approved: true, present: false, scopes: [...new Set(scopes)], version: 1, groupAI: 'OFF' });
    });
  }
  async revokeChat(actor: string, chatId: string): Promise<void> {
    this.requireOwner(actor);
    await this.store.transaction(s => { const c = s.chats.find(x => x.id === chatId); if (c) { c.approved = false; c.version++; } });
  }
  async setPresence(chatId: string, present: boolean): Promise<void> {
    await this.store.transaction(s => { const c = s.chats.find(x => x.id === chatId); if (c) c.present = present; });
  }
  canUseChat(s: BotState, chatId: string | undefined, scope: string): boolean {
    const c = s.chats.find(x => x.id === chatId);
    return Boolean(c?.approved && c.scopes.includes(scope)); // presence alone is NEVER authorization
  }
  chatRevision(s: BotState, chatId: string): number { return s.chats.find(x => x.id === chatId)?.version ?? 0; }
  async configureGroupAI(actor: string, chatId: string, mode: GroupAIMode): Promise<void> {
    this.requireOwner(actor);
    await this.store.transaction(s => { const c = s.chats.find(c => c.id === chatId); if (!c?.approved) throw new Error('Chat not approved'); c.groupAI = mode; c.version++; });
  }
  mayAskGroup(s: BotState, chatId: string, actor: string | undefined, explicitlyMentioned: boolean): boolean {
    if (!explicitlyMentioned || !this.canUseChat(s, chatId, 'assistant') || !actor) return false;
    const mode = s.chats.find(c => c.id === chatId)?.groupAI ?? 'OFF';
    if (mode === 'OFF') return false;
    if (mode === 'OWNER_MENTION') return this.isOwner(actor);
    if (mode === 'STAFF_MENTION') return this.has(s, actor, 'ai.ask', chatId);
    return mode === 'ALL_MENTION';
  }
  async configurePrivateAI(actor: string, mode: PrivateAIMode): Promise<void> {
    this.requireOwner(actor);
    await this.store.transaction(s => { s.privateAI = mode; });
  }
  mayAskPrivate(s: BotState, actor: string | undefined, optedIn: boolean): boolean {
    if (!actor || s.privateAI === 'OFF') return false;
    if (s.privateAI === 'ALL_OPT_IN') return optedIn;
    return this.has(s, actor, 'ai.ask', actor);
  }
  privateFeature(s: BotState, feature: string, actor: string | undefined): boolean {
    if (s.privateFeatures[feature] !== true) return false;
    if (feature === 'owner.dashboard') return this.isOwner(actor);
    if (feature === 'content.upload') return this.has(s, actor, 'content.upload', actor ?? '');
    return Boolean(actor);
  }
  async grant(by: string, actor: string, capability: Capability, chatId: string, expiresAt: number): Promise<void> {
    if (by === actor) throw new Error('Cannot self-grant');
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock()) throw new Error('Invalid expiry');
    if (this.isOwner(actor)) throw new Error('Owner is immutable');
    await this.store.transaction(s => {
      // Delegation is OFF in B1: no recursive grants, even if staff has this capability.
      if (!this.isOwner(by)) throw new Error('Grant requires owner');
      const existing = s.grants.find(g => g.actor === actor && g.capability === capability && g.chatId === chatId && !g.revoked);
      if (existing) throw new Error('Grant already exists');
      s.grants.push({ actor, capability, chatId, expiresAt, grantedBy: by, revoked: false });
    });
  }
  async revokeGrant(by: string, actor: string, capability: Capability, chatId: string): Promise<void> {
    this.requireOwner(by);
    await this.store.transaction(s => { for (const g of s.grants) if (g.actor === actor && g.capability === capability && g.chatId === chatId) g.revoked = true; });
  }
}
