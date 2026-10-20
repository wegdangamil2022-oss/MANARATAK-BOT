import { BotStore, type Wizard } from './store.js';
export interface WizardScope { userId: string; chatId: string; topicId?: string; flow: string; }
export class WizardSessionStore {
  constructor(private readonly store: BotStore, private readonly clock: () => number = Date.now) {}
  private key(scope: WizardScope): string {
    if (!scope.userId || !scope.chatId || !scope.flow) throw new Error('Incomplete wizard scope');
    return JSON.stringify([scope.userId, scope.chatId, scope.topicId ?? '', scope.flow]);
  }
  async begin(scope: WizardScope, expiresAt: number, policyVersion: number): Promise<Wizard> {
    const key = this.key(scope);
    return this.store.transaction(s => {
      const old = s.wizards.find(w => w.key === key && w.status === 'ACTIVE' && w.expiresAt > this.clock());
      if (old) throw new Error('Wizard already active');
      const w: Wizard = { key, userId: scope.userId, chatId: scope.chatId, topicId: scope.topicId ?? '', flow: scope.flow, step: 0, version: 1, expiresAt, policyVersion, status: 'ACTIVE' };
      s.wizards.push(w);
      return structuredClone(w);
    });
  }
  async get(scope: WizardScope): Promise<Wizard | null> {
    const s = await this.store.snapshot();
    const w = [...s.wizards].reverse().find(x => x.key === this.key(scope) && x.status === 'ACTIVE' && x.expiresAt > this.clock());
    return w ?? null;
  }
  async move(scope: WizardScope, expectedVersion: number, action: 'NEXT' | 'BACK' | 'CANCEL', policyVersion: number, authorized: () => boolean): Promise<boolean> {
    const key = this.key(scope);
    return this.store.transaction(s => {
      const w = [...s.wizards].reverse().find(x => x.key === key && x.status === 'ACTIVE');
      if (!w || w.expiresAt <= this.clock() || w.version !== expectedVersion || w.policyVersion !== policyVersion || !authorized()) return false;
      if (action === 'BACK' && w.step <= 0) return false;
      if (action === 'NEXT') w.step++;
      if (action === 'BACK') w.step--;
      if (action === 'CANCEL') w.status = 'CANCELLED';
      w.version++;
      return true;
    });
  }
}
