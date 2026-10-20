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
  /** Loss of verification authorization must invalidate stored subscriptions.
   * They must never silently reactivate if the chat or channel is re-approved.
   * This deliberately does NOT release existing moderation reasons.
   */
  private clearSubscriptionDependencies(s:BotState,chatId:string):void{
    for(const config of s.subscriptionRequirements){
      if(config.chatId===chatId || config.channelIds.includes(chatId)){
        if(config.channelIds.length){config.channelIds=[];config.version++;}
      }
    }
  }
  /** Local pause only, not a Telegram unmute/leave. Both independent revisions
   * are verified atomically to reject stale, copied or replayed confirmations.
   */
  async pauseSubscriptionAtRevision(owner:string,chatId:string,
    expectedChatVersion:number,expectedRequirementVersion:number):Promise<void>{
    this.requireOwner(owner);
    await this.store.transaction(s=>{
      const chat=s.chats.find(c=>c.id===chatId);
      if(!chat?.approved || !chat.scopes.includes('verification'))
        throw Error('CHAT_NO_VERIFICATION');
      const config=s.subscriptionRequirements.find(c=>c.chatId===chatId);
      if(!config?.channelIds.length)throw Error('SUBSCRIPTION_NOT_ACTIVE');
      if(!Number.isSafeInteger(expectedChatVersion)||!Number.isSafeInteger(expectedRequirementVersion)||
        chat.version!==expectedChatVersion || config.version!==expectedRequirementVersion)
        throw Error('SUBSCRIPTION_POLICY_STALE');
      config.channelIds=[];config.version++;chat.version++;
      s.audit.push({updateKey:'owner:subscription:pause:'+chatId+':'+config.version,
        decision:'ALLOW',reason:'SUBSCRIPTION_REQUIREMENT_PAUSED_LOCALLY',
        policyVersion:chat.version,at:this.clock()});
    });
  }
  async approveChat(actor: string, chatId: string, scopes: string[]): Promise<void> {
    this.requireOwner(actor);
    if (!/^-[0-9]+$/.test(chatId)) throw new Error('Only explicit Telegram group/channel IDs can be approved');
    if (!scopes.length || scopes.some(x => !['navigation', 'assistant', 'moderation', 'verification', 'publishing'].includes(x))) throw new Error('Invalid scopes');
    await this.store.transaction(s => {
      const c = s.chats.find(c => c.id === chatId);
      if (c) { c.approved = true; c.scopes = [...new Set(scopes)]; c.version++; }
      else s.chats.push({ id: chatId, approved: true, present: false, scopes: [...new Set(scopes)], version: 1, groupAI: 'OFF' });
    });
  }
  async revokeChat(actor: string, chatId: string): Promise<void> {
    this.requireOwner(actor);
    await this.store.transaction(s => { const c = s.chats.find(x => x.id === chatId); if (c) {
      c.approved = false; c.groupAI='OFF'; c.version++;
      this.clearSubscriptionDependencies(s,chatId);
    } });
  }
  /** Owner-only restrictive mutations. Button text is never authorization:
   * expectedVersion is checked inside the same durable transaction as the
   * change, after current approval. No method can enable a disabled chat,
   * add a capability or turn group AI on.
   */
  async revokeChatAtRevision(actor:string,chatId:string,expectedVersion:number):Promise<void>{
    this.requireOwner(actor);
    await this.store.transaction(s=>{
      const c=s.chats.find(c=>c.id===chatId);
      if(!c?.approved)throw Error('CHAT_NOT_APPROVED');
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion<=0||c.version!==expectedVersion)
       throw Error('CHAT_POLICY_STALE');
      c.approved=false;c.groupAI='OFF';c.version++;
      this.clearSubscriptionDependencies(s,chatId);
      s.audit.push({updateKey:'owner:chat:revoke:'+chatId+':'+c.version,decision:'ALLOW',
       reason:'CHAT_OWNER_REVOKED_LOCALLY',policyVersion:c.version,at:this.clock()});
    });
  }
  async restrictChatScopeAtRevision(actor:string,chatId:string,scope:string,expectedVersion:number):Promise<void>{
    this.requireOwner(actor);
    if(!['navigation','assistant','moderation','verification','publishing'].includes(scope))
     throw Error('INVALID_CHAT_SCOPE');
    await this.store.transaction(s=>{
      const c=s.chats.find(c=>c.id===chatId);
      if(!c?.approved)throw Error('CHAT_NOT_APPROVED');
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion<=0||c.version!==expectedVersion)
       throw Error('CHAT_POLICY_STALE');
      if(!c.scopes.includes(scope))throw Error('CHAT_SCOPE_ALREADY_RESTRICTED');
      c.scopes=c.scopes.filter(x=>x!==scope);
      if(scope==='assistant')c.groupAI='OFF';
      if(scope==='verification')this.clearSubscriptionDependencies(s,chatId);
      c.version++;
      s.audit.push({updateKey:'owner:chat:restrict:'+chatId+':'+scope+':'+c.version,
       decision:'ALLOW',reason:'CHAT_OWNER_SCOPE_RESTRICTED',policyVersion:c.version,at:this.clock()});
    });
  }
  async disableGroupAIAtRevision(actor:string,chatId:string,expectedVersion:number):Promise<void>{
    this.requireOwner(actor);
    await this.store.transaction(s=>{
      const c=s.chats.find(c=>c.id===chatId);
      if(!c?.approved)throw Error('CHAT_NOT_APPROVED');
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion<=0||c.version!==expectedVersion)
       throw Error('CHAT_POLICY_STALE');
      if(c.groupAI==='OFF')throw Error('CHAT_AI_ALREADY_OFF');
      c.groupAI='OFF';c.version++;
      s.audit.push({updateKey:'owner:chat:ai-off:'+chatId+':'+c.version,
       decision:'ALLOW',reason:'CHAT_OWNER_AI_DISABLED',policyVersion:c.version,at:this.clock()});
    });
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
