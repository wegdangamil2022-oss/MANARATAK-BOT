import { randomUUID } from 'node:crypto';
import { BotStore, type BotState, type ModerationReason, type ModerationOperation, type RestrictionKind, type ModerationDispatchGateway } from './store.js';
import { Policy } from './policy.js';
import {moderationRateFuse,moderationRateDenial} from './moderation-rate-fuse.js';
import {moderationLedgerSafeForDispatch,ambiguousModerationChatIds} from './moderation-review-integrity.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

export type RestrictionOutcome = 'CONFIRMED' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME';
export type ModerationResult = { status: 'APPLIED' | 'NO_CHANGE' | 'DENIED' | 'BLOCKED_PENDING' | 'BLOCKED_UNKNOWN' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME'; reason: string };
export interface ModerationGateway {
  /** Local adapter identifier only: never a Telegram enforcement receipt. */
  readonly attemptGateway?:ModerationDispatchGateway;
  canRestrict(chatId: string, memberId: string): Promise<boolean>;
  isProtected(chatId: string, memberId: string): Promise<boolean>;
  setRestriction(chatId: string, memberId: string, kind: RestrictionKind,
    verifyCurrentAuthority?:()=>Promise<boolean>): Promise<RestrictionOutcome>;
}
export class FakeModerationGateway implements ModerationGateway {
  readonly attemptGateway='SIMULATION' as const;
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

/** Match a durable operation's immutable dispatch identity. Terminal status
 * or owner review metadata is not evidence that a different payload may be
 * sent. Never take the outbound kind from a mutable post-INTENT snapshot.
 */
function sameModerationAttempt(a:ModerationOperation,b:ModerationOperation):boolean{
 return a.id===b.id&&a.chatId===b.chatId&&a.memberId===b.memberId&&
  a.actorId===b.actorId&&a.kind===b.kind&&
  a.reasonFingerprint===b.reasonFingerprint&&
  a.policyVersion===b.policyVersion&&a.createdAt===b.createdAt&&
  a.attemptGateway===b.attemptGateway;
}
/** Preserve BOTH conflicting evidence and an unresolved lock for the
 * original target. A late provider result is not authority to overwrite
 * another writer's status, member or sanction kind. Never silently replace
 * a restored row merely because it happens to have the same operation ID.
 *
 * If the original, unique STARTED row is still intact, transitioning it to
 * UNKNOWN_OUTCOME is safe: no contradictory evidence is destroyed.
 * Otherwise append an independent recovery receipt with a fresh opaque ID;
 * any remaining historical row stays byte-for-byte untouched. Recovery is
 * deliberately permanent until manual investigation, not a retry ticket.
 */
function quarantineModerationAttempt(s:BotState,original:ModerationOperation):void{
 const matches=s.moderationOperations.filter(o=>o?.id===original.id);
 if(matches.length===1&&matches[0]!.status===original.status&&
    matches[0]!.review===undefined&&
    sameModerationAttempt(matches[0]!,original)){
   matches[0]!.status='UNKNOWN_OUTCOME';
   return;
 }
 let id=original.id;
 if(matches.length){
  do{id='recovery-'+randomUUID();}
  while(s.moderationOperations.some(o=>o?.id===id));
 }
 const recovered:ModerationOperation={...original,id,status:'UNKNOWN_OUTCOME'};
 // Review annotations on a conflicting source must never be inherited by
 // newly appended recovery evidence.
 delete recovered.review;
 s.moderationOperations.push(recovered);
}

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
    // Locally delegated chat managers are protected targets even if Telegram
    // currently reports them as ordinary members. Expired/revoked grants do
    // not shield members, and every dispatch phase reuses this same check.
    // Duplicated restored approval rows cannot authorize an operation.
    // This guard is reused at the initial gate, each atomic mutation,
    // and the awaited gateway's last-mile authority callback.
    return !ambiguousModerationChatIds(s).has(chatId) &&
      actorId !== memberId && memberId !== this.policy.ownerId && /^\d+$/.test(memberId) && memberId !== '0' &&
      !this.policy.has(s, memberId, 'chat.manage', chatId, this.clock()) &&
      this.policy.canUseChat(s, chatId, 'moderation') && this.policy.has(s, actorId, 'chat.manage', chatId, this.clock());
  }
  /** A pending/ambiguous sanction must be immutable until separately reviewed.
   * Never query Telegram or edit even local reason rows while another sanction
   * might already have reached the member. This test is repeated atomically
   * inside every subsequent reason mutation after any asynchronous reads.
   */
  private unresolved(s:BotState,chatId:string,memberId:string):
    {status:'BLOCKED_UNKNOWN'|'BLOCKED_PENDING';reason:'NO_SAFE_DISPATCH'}|null{
    // Corrupt/unsupported restored statuses must NEVER be interpreted as a
    // terminal successful or failed sanction. Quarantine dispatch globally,
    // including if corruption affects another member or group.
    if(!moderationLedgerSafeForDispatch(s,this.clock()))
      return {status:'BLOCKED_UNKNOWN',reason:'NO_SAFE_DISPATCH'};
    const ops=s.moderationOperations.filter(o=>byTarget(o,chatId,memberId));
    if(ops.some(o=>o.status==='UNKNOWN_OUTCOME'))
      return {status:'BLOCKED_UNKNOWN',reason:'NO_SAFE_DISPATCH'};
    if(ops.some(o=>o.status==='STARTED'||o.status==='INTENT'))
      return {status:'BLOCKED_PENDING',reason:'NO_SAFE_DISPATCH'};
    return null;
  }
  /** Authorization precedes any ledger-status disclosure to callers. */
  private async priorPending(actorId:string,chatId:string,memberId:string):Promise<ModerationResult|null>{
    const s=await this.store.snapshot();
    if(!this.authorized(s,actorId,chatId,memberId))
      return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    return this.unresolved(s,chatId,memberId);
  }
  /** No mutating provider dispatch is reachable before STARTED. A failed
   * read-only preflight or reservation transaction can cancel the ORIGINAL
   * intact INTENT. If another writer changed/deleted it, quarantine instead
   * of overwriting potentially meaningful concurrent operation evidence.
   */
  private async closePrestartedIntent(original:ModerationOperation):
    Promise<'CANCELLED'|'BLOCKED_UNKNOWN'>{
    return this.store.transaction(s=>{
      // A restored collision must not let closeout mutate whichever row
      // happens to be first in the array.
      if(!moderationLedgerSafeForDispatch(s,this.clock()))return 'BLOCKED_UNKNOWN' as const;
      const op=s.moderationOperations.find(x=>x.id===original.id);
      if(!op||op.status!=='INTENT'||!sameModerationAttempt(op,original)){
        quarantineModerationAttempt(s,original);
        return 'BLOCKED_UNKNOWN' as const;
      }
      op.status='CANCELLED';
      return 'CANCELLED' as const;
    });
  }
  private async check(actorId: string, chatId: string, memberId: string): Promise<boolean> {
    return this.authorized(await this.store.snapshot(), actorId, chatId, memberId) &&
      await this.gateway.canRestrict(chatId, memberId) && !await this.gateway.isProtected(chatId, memberId);
  }
  async addManualReason(actorId: string, chatId: string, memberId: string, reference: string, kind: 'MUTE' | 'BAN'): Promise<ModerationResult> {
    if (!reference || reference.length > 80 || !['MUTE', 'BAN'].includes(kind)) throw new Error('Invalid reason');
    const preflight=await this.priorPending(actorId,chatId,memberId);
    if(preflight)return preflight;
    if (!await this.check(actorId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const added = await this.store.transaction(s => {
      if (!this.authorized(s, actorId, chatId, memberId))
        return ambiguousModerationChatIds(s).has(chatId)?'DENIED' as const:false;
      const pending=this.unresolved(s,chatId,memberId);
      if(pending)return pending.status;
      const existing = s.moderationReasons.find(x => byTarget(x, chatId, memberId) && x.source === 'MANUAL' && x.reference === reference);
      if (existing?.active) { if (existing.kind !== kind) throw new Error('REASON_CONFLICT'); return false; }
      const limit=moderationRateFuse(s,actorId,chatId,this.clock());
      if(limit)return limit;
      if (existing) { existing.kind = kind; existing.active = true; existing.createdBy = actorId; }
      else s.moderationReasons.push({ chatId, memberId, source: 'MANUAL', reference, kind, createdBy: actorId, active: true });
      return true;
    });
    if(added==='BLOCKED_UNKNOWN'||added==='BLOCKED_PENDING')
      return {status:added,reason:'NO_SAFE_DISPATCH'};
    if(added==='DENIED')return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    if(typeof added==='string')return {status:'DENIED',reason:moderationRateDenial(added)};
    if (!added) return { status: 'NO_CHANGE', reason: 'DUPLICATE_OR_REVOKED' };
    return this.reconcile(actorId, chatId, memberId);
  }
  async removeManualReason(actorId: string, chatId: string, memberId: string, reference: string): Promise<ModerationResult> {
    const preflight=await this.priorPending(actorId,chatId,memberId);
    if(preflight)return preflight;
    if (!await this.check(actorId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const changed = await this.store.transaction(s => {
      if (!this.authorized(s, actorId, chatId, memberId))
        return ambiguousModerationChatIds(s).has(chatId)?'DENIED' as const:false;
      const pending=this.unresolved(s,chatId,memberId);
      if(pending)return pending.status;
      const found = s.moderationReasons.find(x => byTarget(x, chatId, memberId) && x.source === 'MANUAL' && x.reference === reference && x.active);
      if (!found) return false;
      found.active = false; return true;
    });
    if(changed==='BLOCKED_UNKNOWN'||changed==='BLOCKED_PENDING')
      return {status:changed,reason:'NO_SAFE_DISPATCH'};
    if(changed==='DENIED')return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    return changed ? this.reconcile(actorId, chatId, memberId) : { status: 'NO_CHANGE', reason: 'NOT_ACTIVE' };
  }
  /** Invoked only by SubscriptionGate's trusted membership reconciliation; never expose as a user command. */
  async setSubscriptionReason(chatId: string, memberId: string, reference: string, active: boolean,
    stillCurrent?: (state:BotState)=>boolean): Promise<ModerationResult> {
    if (!reference || reference.length > 80)return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    const preflight=await this.priorPending(this.policy.ownerId,chatId,memberId);
    if(preflight)return preflight;
    if(!await this.check(this.policy.ownerId, chatId, memberId))
      return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    const change = await this.store.transaction(s => {
      if (!this.authorized(s, this.policy.ownerId, chatId, memberId) ||
          (stillCurrent && !stillCurrent(s)))return 'STALE' as const;
      const pending=this.unresolved(s,chatId,memberId);
      if(pending)return pending.status;
      const found = s.moderationReasons.find(x => byTarget(x, chatId, memberId) && x.source === 'SUBSCRIPTION' && x.reference === reference);
      if (Boolean(found?.active) === active) return 'UNCHANGED' as const;
      if(active){const limit=moderationRateFuse(s,this.policy.ownerId,chatId,this.clock());
       if(limit)return 'RATE_LIMIT' as const;}
      if (found) found.active = active;
      else if (active) s.moderationReasons.push({ chatId, memberId, source: 'SUBSCRIPTION', reference, kind: 'MUTE', createdBy: 'SYSTEM_SUBSCRIPTION', active: true });
      return 'CHANGED' as const;
    });
    if(change==='BLOCKED_UNKNOWN'||change==='BLOCKED_PENDING')
      return {status:change,reason:'NO_SAFE_DISPATCH'};
    if(change==='STALE')return {status:'DENIED',reason:'SUBSCRIPTION_EVIDENCE_STALE'};
    if(change==='RATE_LIMIT')return {status:'DENIED',reason:'MODERATION_RATE_LIMIT_SUBSCRIPTION'};
    return change==='CHANGED'
      ?this.reconcile(this.policy.ownerId,chatId,memberId,stillCurrent)
      :{status:'NO_CHANGE',reason:'REASON_UNCHANGED'};
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
  async reconcile(actorId: string, chatId: string, memberId: string,
    stillCurrent?: (state:BotState)=>boolean): Promise<ModerationResult> {
    const preflight=await this.priorPending(actorId,chatId,memberId);
    if(preflight)return preflight;
    if (!await this.check(actorId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const candidate = await this.store.transaction(s => {
      if (!this.authorized(s, actorId, chatId, memberId) ||
          (stillCurrent && !stillCurrent(s)))return {status:'DENIED' as const};
      const pending=this.unresolved(s,chatId,memberId);
      if(pending)return {status:pending.status};
      const operations = s.moderationOperations.filter(x => byTarget(x, chatId, memberId));
      const desired = this.effective(s, chatId, memberId);
      const confirmed = operations.filter(x => x.status === 'CONFIRMED').at(-1)?.kind ?? 'NONE';
      if (desired === confirmed) return { status: 'NO_CHANGE' as const };
      if(desired!=='NONE'){
       const limit=moderationRateFuse(s,actorId,chatId,this.clock());
       if(limit)return {status:'RATE_LIMIT' as const,reason:moderationRateDenial(limit)};
      }
      const op: ModerationOperation = { id: randomUUID(), chatId, memberId, actorId, kind: desired, reasonFingerprint: fingerprint(s, chatId, memberId), policyVersion: this.policy.chatRevision(s, chatId), status: 'INTENT', createdAt: this.clock() };
      s.moderationOperations.push(op);
      return { status: 'READY' as const, id: op.id, intent:{...op} };
    });
    if(candidate.status==='RATE_LIMIT')return {status:'DENIED',reason:candidate.reason};
    if (candidate.status !== 'READY') return { status: candidate.status, reason: 'NO_SAFE_DISPATCH' };
    // Until STARTED has been durably reserved, setRestriction is unreachable.
    // Exceptions from the test-only hook or from read-only bot/target preflight
    // can therefore be classified as a confirmed local NO-SEND. We still
    // verify the original INTENT atomically: if another worker changed or
    // removed it, we cannot trust that worker's activity, so quarantine.
    let rights:boolean;
    try{
      if(this.beforeDispatch)await this.beforeDispatch();
      rights=await this.gateway.canRestrict(chatId,memberId)&&
        !await this.gateway.isProtected(chatId,memberId);
    }catch{
      const stopped=await this.closePrestartedIntent(candidate.intent);
      return stopped==='CANCELLED'?
        {status:'DENIED',reason:'PREFLIGHT_ABORTED_NO_SEND'}:
        {status:'BLOCKED_UNKNOWN',reason:'LEDGER_CHANGED_BEFORE_DISPATCH'};
    }
    // Don't pre-mark effects. Verify both external rights and internal policy immediately before STARTED.
    let started:{status:'STARTED';receipt:ModerationOperation}|
      {status:'DENIED'|'BLOCKED_UNKNOWN'};
    try{
      started=await this.store.transaction(s => {
      // A parallel restore can introduce invalid evidence after all earlier
      // checks. Reject even the STARTED reservation: no provider mutation.
      if(!moderationLedgerSafeForDispatch(s,this.clock()))
        return {status:'BLOCKED_UNKNOWN' as const};
      const op = s.moderationOperations.find(x => x.id === candidate.id);
      // A concurrent process may alter or replace the original intent while
      // remote reads are pending. Do not dispatch a forged/new sanction kind.
      if(!op||op.status!=='INTENT'){
        quarantineModerationAttempt(s,candidate.intent);
        return {status:'BLOCKED_UNKNOWN' as const};
      }
      if(!sameModerationAttempt(op,candidate.intent)){
        // The original INTENT identity was rewritten during awaited reads.
        // No request is sent, but do not erase that contradictory row.
        quarantineModerationAttempt(s,candidate.intent);
        return {status:'BLOCKED_UNKNOWN' as const};
      }
      const valid = rights && this.authorized(s, actorId, chatId, memberId) &&
        (!stillCurrent||stillCurrent(s)) &&
        this.policy.chatRevision(s, chatId) === op.policyVersion &&
        fingerprint(s, chatId, memberId) === op.reasonFingerprint;
      if (!valid) { op.status = 'CANCELLED'; return {status:'DENIED' as const}; }
      // The attempt label is a local provenance hint, not remote proof.
      op.attemptGateway=TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)?
        'TELEGRAM_API':this.gateway instanceof FakeModerationGateway&&
        this.gateway.setRestriction===FakeModerationGateway.prototype.setRestriction?
        'SIMULATION':'UNSPECIFIED';
      op.status='STARTED';
      return {status:'STARTED' as const, receipt:{...op}};
      });
    }catch{
      // Validation callbacks can throw inside the SQLite/JSON transaction.
      // It rolls back, leaving INTENT. Since setRestriction has not yet been
      // called, cancel only a still-identical INTENT, never a replaced row.
      const stopped=await this.closePrestartedIntent(candidate.intent);
      return stopped==='CANCELLED'?
        {status:'DENIED',reason:'PREFLIGHT_ABORTED_NO_SEND'}:
        {status:'BLOCKED_UNKNOWN',reason:'LEDGER_CHANGED_BEFORE_DISPATCH'};
    }
    if(started.status==='BLOCKED_UNKNOWN')
      return {status:'BLOCKED_UNKNOWN',reason:'LEDGER_CHANGED_BEFORE_DISPATCH'};
    if(started.status!=='STARTED')
      return {status:'DENIED',reason:'REVOKED_BEFORE_DISPATCH'};
    // Remote reads and the durable authority callback are asynchronous. An
    // external status/identity change during that wait invalidates the attempt
    // snapshot. The gateway must not treat it as continued authorization.
    const verifyCurrentAuthority=async():Promise<boolean>=>{
      try{
        const s=await this.store.snapshot();
        const op=s.moderationOperations.find(x=>x.id===candidate.id);
        return moderationLedgerSafeForDispatch(s,this.clock())&&
          op?.status==='STARTED'&&sameModerationAttempt(op,started.receipt)&&
          this.authorized(s,actorId,chatId,memberId)&&
          (!stillCurrent||stillCurrent(s))&&
          this.policy.chatRevision(s,chatId)===op.policyVersion&&
          fingerprint(s,chatId,memberId)===op.reasonFingerprint;
      }catch{return false;}
    };
    let outcome: RestrictionOutcome;
    try{
      outcome=await this.gateway.setRestriction(
        started.receipt.chatId,started.receipt.memberId,
        started.receipt.kind,verifyCurrentAuthority);
    }catch{outcome='UNKNOWN_OUTCOME';}
    // A structurally typed JavaScript gateway may return arbitrary strings
    // at runtime. Never write an unrecognized terminal state to the ledger.
    if(outcome!=='CONFIRMED'&&outcome!=='FAILED_CONFIRMED'&&
       outcome!=='UNKNOWN_OUTCOME')outcome='UNKNOWN_OUTCOME';
    const final=await this.store.transaction(s=>{
      const op=s.moderationOperations.find(x=>x.id===candidate.id);
      if(!moderationLedgerSafeForDispatch(s,this.clock())){
        // A restored/malformed/colliding row may have changed our original
        // receipt too. Always preserve independent UNKNOWN_OUTCOME evidence
        // for the intended target, without rewriting any conflicting row.
        quarantineModerationAttempt(s,started.receipt);
        return 'BLOCKED_UNKNOWN' as const;
      }
      // A group approval collision arising during an in-flight provider
      // request makes even apparent success insufficient evidence of a
      // safe terminal state. Preserve the original unresolved receipt.
      if(ambiguousModerationChatIds(s).has(chatId)){
        quarantineModerationAttempt(s,started.receipt);
        return 'BLOCKED_UNKNOWN' as const;
      }
      if(!op||op.status!=='STARTED'||
         !sameModerationAttempt(op,started.receipt)){
        quarantineModerationAttempt(s,started.receipt);
        return 'BLOCKED_UNKNOWN' as const;
      }
      op.status=outcome;
      return outcome;
    });
    if(final==='BLOCKED_UNKNOWN')
      return {status:'BLOCKED_UNKNOWN',reason:'LEDGER_CHANGED_DURING_DISPATCH'};
    return { status: final === 'CONFIRMED' ? 'APPLIED' : final, reason: final };
  }
}