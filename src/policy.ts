import {randomUUID} from 'node:crypto';
import { BotStore, type BotState, type Chat, type Grant, type Capability, type GroupAIMode, type PrivateAIMode } from './store.js';

export class Policy {
  constructor(private readonly store: BotStore, readonly ownerId: string, private readonly clock: () => number = Date.now) {
    if (!/^\d+$/.test(ownerId) || ownerId === '0') throw new Error('Owner ID must come from trusted configuration');
  }
  isOwner(actor: string | undefined): boolean { return actor === this.ownerId; }
  has(s: BotState, actor: string | undefined, capability: Capability, chatId: string, now = this.clock()): boolean {
    if (!actor) return false;
    // A group-scoped owner or delegated capability cannot turn a restored
    // duplicate approval into authorization, including after reapproval.
    if(chatId.startsWith('-')&&!this.uniqueChat(s,chatId)&&
       s.chats.some(c=>c.id===chatId))return false;
    if (this.isOwner(actor)) return true;
    const chatIsGroup=chatId.startsWith('-');
    const chat=chatIsGroup?this.uniqueChat(s,chatId):undefined;
    // A prior grant is not a durable right to regain authority after
    // group revocation, reapproval, scope mutation or a restored cleanup.
    // Legacy group grants without an issuing approval revision fail closed.
    if(chatIsGroup&&(!chat?.approved||!Number.isSafeInteger(chat.version)||
      chat.version<1))return false;
    if(!chatIsGroup)return s.grants.some(g=>g.actor===actor&&
      g.capability===capability&&g.chatId===chatId&&!g.revoked&&g.expiresAt>now);
    const ledger=this.groupGrantLedger(s,actor,capability,chatId,chat!.version,now);
    return ledger.safe&&ledger.active.length===1;
  }
  private requireOwner(actor: string): void { if (!this.isOwner(actor)) throw new Error('OWNER_ONLY'); }
  /** Group-grant evidence validator for restored JSON/SQLite databases.
   * Revoke/regrant and expiry/renewal are legitimate distinct grant events.
   * A copied grantId, duplicated legacy record, malformed row or multiple
   * simultaneously active grants in ONE policy epoch is not a valid authority.
   * Nothing in this check edits, repairs or removes the historical records.
   */
  private groupGrantLedger(
    s:BotState,actor:string,capability:Capability,chatId:string,
    epoch:number,now:number
  ):{safe:boolean;active:Grant[]}{
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(epoch)||epoch<1)
      return {safe:false,active:[]};
    // A restored row with a malformed approval epoch is a collision in
    // THIS actor+capability+group ledger, even if an unrelated valid row
    // happens to match the current revision. A previous-epoch grant with
    // valid metadata is historical evidence and does not confer access.
    const history=s.grants.filter(g=>g.actor===actor&&
      g.capability===capability&&g.chatId===chatId);
    const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
    const malformed=history.some(g=>
      (g.chatPolicyVersion!==undefined&&
        (typeof g.chatPolicyVersion!=='number'||
         !Number.isSafeInteger(g.chatPolicyVersion)||g.chatPolicyVersion<1))||
      (g.grantId!==undefined&&g.chatPolicyVersion===undefined)||
      typeof g.revoked!=='boolean'||
      typeof g.expiresAt!=='number'||!Number.isSafeInteger(g.expiresAt)||
      g.expiresAt<0||g.expiresAt>8_640_000_000_000_000||
      typeof g.grantedBy!=='string'||!/^\\d+$/u.test(g.grantedBy)||
      (g.grantId!==undefined&&
        (typeof g.grantId!=='string'||!uuid.test(g.grantId))));
    const relevant=history.filter(g=>g.chatPolicyVersion===epoch);
    if(malformed)return {safe:false,active:[]};
    const legacy=relevant.filter(g=>g.grantId===undefined);
    if(legacy.length>1)return {safe:false,active:[]};
    // IDs are globally unique, not just within a single actor or chat:
    // a restored copy given a different owner/target must not be usable.
    if(relevant.some(g=>g.grantId!==undefined&&
      s.grants.filter(other=>other.grantId===g.grantId).length!==1))
      return {safe:false,active:[]};
    const active=relevant.filter(g=>!g.revoked&&g.expiresAt>now);
    if(active.length>1)return {safe:false,active:[]};
    return {safe:true,active};
  }
  /** Restore-safe unique group record lookup. Never select the first, last
   * or most permissive approval from multiple rows with the same ID.
   * This is a read-only check; ambiguous evidence is preserved as-is.
   */
  private uniqueChat(s:BotState,chatId:string|undefined):Chat|undefined{
    if(!chatId)return undefined;
    const matches=s.chats.filter(c=>c.id===chatId);
    return matches.length===1?matches[0]:undefined;
  }
  private assertUniqueChatRecord(s:BotState,chatId:string):Chat|undefined{
    const chat=this.uniqueChat(s,chatId);
    if(!chat&&s.chats.some(c=>c.id===chatId))
      throw new Error('CHAT_APPROVAL_AMBIGUOUS');
    return chat;
  }
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
  /** Owner-only reduction of one mandatory subscription channel, without a
   * live external check, privilege grant, or automatic moderation release.
   * Current chat and rule revisions are checked atomically against the store.
   */
  async removeSubscriptionChannelAtRevision(owner:string,chatId:string,channelId:string,
    expectedChatRevision:number,expectedRequirementRevision:number):Promise<void>{
    this.requireOwner(owner);
    if(!/^-[1-9][0-9]{0,18}$/.test(chatId)||!/^-[1-9][0-9]{0,18}$/.test(channelId))
      throw Error('INVALID_CHANNEL_ID');
    await this.store.transaction(s=>{
      const chat=this.uniqueChat(s,chatId);
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
  async pauseSubscriptionAtRevision(owner:string,chatId:string,
    expectedChatVersion:number,expectedRequirementVersion:number):Promise<void>{
    this.requireOwner(owner);
    await this.store.transaction(s=>{
      const chat=this.uniqueChat(s,chatId);
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
      const c = this.assertUniqueChatRecord(s,chatId);
      if (c) { c.approved = true; c.scopes = [...new Set(scopes)]; c.version++; }
      else s.chats.push({ id: chatId, approved: true, present: false, scopes: [...new Set(scopes)], version: 1, groupAI: 'OFF' });
    });
  }
  async revokeChat(actor: string, chatId: string): Promise<void> {
    this.requireOwner(actor);
    await this.store.transaction(s => { const c = this.assertUniqueChatRecord(s,chatId); if (c) {
      c.approved = false; c.version++;
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
      const c=this.uniqueChat(s,chatId);
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
      const c=this.uniqueChat(s,chatId);
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
      const c=this.uniqueChat(s,chatId);
      if(!c?.approved)throw Error('CHAT_NOT_APPROVED');
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion<=0||c.version!==expectedVersion)
       throw Error('CHAT_POLICY_STALE');
      if(c.groupAI==='OFF')throw Error('CHAT_AI_ALREADY_OFF');
      c.groupAI='OFF';c.version++;
      s.audit.push({updateKey:'owner:chat:ai-off:'+chatId+':'+c.version,
       decision:'ALLOW',reason:'CHAT_OWNER_AI_DISABLED',policyVersion:c.version,at:this.clock()});
    });
  }

  /**
   * One durable transaction owns BOTH one-shot token consumption AND the
   * restrictive local policy mutation. Never acknowledge an operation as
   * applied between independent transactions. No Telegram network calls.
   * Invalid, expired, stale or cross-owner actions have zero state effects.
   */
  async applyOwnerInlineConfirmation(actor:string,ref:string,at=this.clock()):Promise<{
    action:'owner.chat.ai_off'|'owner.chat.restrict.assistant'|'owner.chat.restrict.publishing'|
      'owner.chat.revoke'|'owner.subscription.pause';chatId:string
  }|null>{
    if(!this.isOwner(actor)||!/^c_[A-Za-z0-9_-]{24}$/u.test(ref))return null;
    if(!Number.isSafeInteger(at)||at<0||at>8_640_000_000_000_000)return null;
    const known=[
      'owner.chat.ai_off','owner.chat.restrict.assistant',
      'owner.chat.restrict.publishing','owner.chat.revoke','owner.subscription.pause'
    ] as const;
    return this.store.transaction(s=>{
      const cb=s.callbacks.find(c=>c.ref===ref);
      if(!cb||cb.used||cb.revoked||!cb.oneShot||cb.actorId!==actor||
        cb.expiresAt<=at||cb.policyVersion<1||
        !known.some(action=>action===cb.action)||
        !/^-[1-9][0-9]{0,18}$/u.test(cb.chatId))return null;
      const chat=this.uniqueChat(s,cb.chatId);
      if(!chat?.approved||chat.version!==cb.policyVersion)return null;
      const action=cb.action as typeof known[number];
      const requirement=s.subscriptionRequirements.filter(r=>r.chatId===chat.id);
      if(action==='owner.chat.ai_off'&&chat.groupAI==='OFF')return null;
      if(action==='owner.chat.restrict.assistant'&&!chat.scopes.includes('assistant'))return null;
      if(action==='owner.chat.restrict.publishing'&&!chat.scopes.includes('publishing'))return null;
      if(action==='owner.subscription.pause'&&(
        !chat.scopes.includes('verification')||requirement.length!==1||
        !requirement[0]!.channelIds.length||
        requirement[0]!.version!==cb.requirementVersion))return null;
      // The rule version is mandatory *only* on subscription pauses, to avoid
      // old/cross-policy tokens masquerading as a new suspension.
      if(action!=='owner.subscription.pause'&&cb.requirementVersion!==undefined)return null;
      // Everything below is atomic, including used=true. A transaction failure
      // rolls back token usage and the change together.
      cb.used=true;
      let reason:string,updateKey:string;
      if(action==='owner.chat.ai_off'){
        chat.groupAI='OFF';chat.version++;
        reason='CHAT_OWNER_AI_DISABLED';updateKey='owner:chat:ai-off:'+chat.id+':'+chat.version;
      }else if(action==='owner.chat.restrict.assistant'||action==='owner.chat.restrict.publishing'){
        const scope=action==='owner.chat.restrict.assistant'?'assistant':'publishing';
        chat.scopes=chat.scopes.filter(s=>s!==scope);
        if(scope==='assistant')chat.groupAI='OFF';
        chat.version++;
        reason='CHAT_OWNER_SCOPE_RESTRICTED';
        updateKey='owner:chat:restrict:'+chat.id+':'+scope+':'+chat.version;
      }else if(action==='owner.chat.revoke'){
        chat.approved=false;chat.groupAI='OFF';chat.version++;
        this.clearSubscriptionDependencies(s,chat.id);
        reason='CHAT_OWNER_REVOKED_LOCALLY';
        updateKey='owner:chat:revoke:'+chat.id+':'+chat.version;
      }else{
        const rule=requirement[0]!;
        rule.channelIds=[];rule.version++;chat.version++;
        reason='SUBSCRIPTION_REQUIREMENT_PAUSED_LOCALLY';
        updateKey='owner:subscription:pause:'+chat.id+':'+rule.version;
      }
      s.audit.push({updateKey,decision:'ALLOW',reason,
        policyVersion:chat.version,at});
      return {action,chatId:chat.id};
    });
  }
  async setPresence(chatId: string, present: boolean): Promise<void> {
    await this.store.transaction(s => {
      const c=this.assertUniqueChatRecord(s,chatId);
      if(c)c.present=present;
    });
  }
  canUseChat(s: BotState, chatId: string | undefined, scope: string): boolean {
    const c = this.uniqueChat(s,chatId);
    return Boolean(c?.approved && c.scopes.includes(scope)); // presence alone is NEVER authorization
  }
  chatRevision(s: BotState, chatId: string): number { return this.uniqueChat(s,chatId)?.version ?? 0; }
  async configureGroupAI(actor: string, chatId: string, mode: GroupAIMode): Promise<void> {
    this.requireOwner(actor);
    await this.store.transaction(s => { const c = this.uniqueChat(s,chatId); if (!c?.approved) throw new Error('Chat not approved'); c.groupAI = mode; c.version++; });
  }
  mayAskGroup(s: BotState, chatId: string, actor: string | undefined, explicitlyMentioned: boolean): boolean {
    if (!explicitlyMentioned || !this.canUseChat(s, chatId, 'assistant') || !actor) return false;
    const mode = this.uniqueChat(s,chatId)?.groupAI ?? 'OFF';
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
    if (!Number.isSafeInteger(expiresAt)||expiresAt<0||
        expiresAt>8_640_000_000_000_000||expiresAt<=this.clock())
      throw new Error('Invalid expiry');
    if (this.isOwner(actor)) throw new Error('Owner is immutable');
    await this.store.transaction(s => {
      // Delegation is OFF in B1: no recursive grants, even if staff has this capability.
      if (!this.isOwner(by)) throw new Error('Grant requires owner');
      const groupScope=chatId.startsWith('-');
      const chat=groupScope?this.assertUniqueChatRecord(s,chatId):undefined;
      if(groupScope&&(!chat?.approved||!Number.isSafeInteger(chat.version)||
        chat.version<1))throw Error('GROUP_NOT_APPROVED');
      // Only one active grant can exist in a group approval epoch, but
      // explicitly revoking or expiring the prior grant permits reissuance
      // with a NEW ID. Historical records are never rewritten or deleted.
      const now=this.clock();
      const ledger=groupScope?
        this.groupGrantLedger(s,actor,capability,chatId,chat!.version,now):
        null;
      if(ledger&&!ledger.safe)throw Error('GRANT_LEDGER_AMBIGUOUS');
      const existing=groupScope?ledger!.active.length>0:
        s.grants.some(g=>g.actor===actor&&g.capability===capability&&
          g.chatId===chatId&&!g.revoked);
      if(existing)throw new Error('Grant already exists');
      let grantId:string|undefined;
      if(groupScope){
        // A random collision is extraordinarily unlikely. Preserve and
        // refuse rather than overwriting a restored row if it occurs.
        grantId=randomUUID();
        if(s.grants.some(g=>g.grantId===grantId))
          throw Error('GRANT_ID_COLLISION');
      }
      s.grants.push({actor,capability,chatId,expiresAt,grantedBy:by,
        revoked:false,...(groupScope?
          {chatPolicyVersion:chat!.version,grantId:grantId!}:{})});
    });
  }
  async revokeGrant(by: string, actor: string, capability: Capability, chatId: string): Promise<void> {
    this.requireOwner(by);
    await this.store.transaction(s => {
      if(chatId.startsWith('-')){
        // Restrictive operations may NOT silently overwrite a corrupt
        // restored history. They must be investigated through an explicit
        // maintenance/recovery workflow, rather than normal owner buttons.
        const chat=this.assertUniqueChatRecord(s,chatId);
        if(chat){
          const ledger=this.groupGrantLedger(s,actor,capability,chatId,
            chat.version,this.clock());
          if(!ledger.safe)throw Error('GRANT_LEDGER_AMBIGUOUS');
        }
      }
      for(const g of s.grants){
        if(g.actor===actor&&g.capability===capability&&g.chatId===chatId)
          g.revoked=true;
      }
    });
  }
}
