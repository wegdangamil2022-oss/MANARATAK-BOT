import {moderationEvidenceMatches,validReasonRetirement,retirementOperationDigest,REASON_RETIREMENT} from './moderation-reason-retirement.js';
import {exemptFromRule} from './group-rule-exemption-model.js';
import {warningActive,ruleWarningPolicy,paragraphWarningCount} from './group-rule-warning-policy.js';
import {enqueueAdminRoomWarningNotice,enqueueAdminRoomOperationNotice,enqueueAdminRoomRightsFailure} from './admin-room-notices.js';
import {groupRuleDescription} from './telegram-group-rules.js';
import {subscriptionEnforcementConsent} from './subscription-enforcement-policy.js';
import { randomUUID,randomBytes } from 'node:crypto';
import {enqueueReportNotices} from './moderation-report-notices.js';
import {enqueueAdminRoomReportNotice} from './admin-room-notices.js';
import {ruleReviewReports} from './moderation-report-model.js';
import {RULE_NOTICE,ruleNotices} from './group-rule-notices.js';
import {ruleActionAllowed} from './group-rule-warning-policy.js';
import { BotStore, type BotState, type ModerationReason, type ModerationOperation, type RestrictionKind, type ModerationDispatchGateway } from './store.js';
import { Policy } from './policy.js';
import {moderationRateFuse,moderationRateDenial} from './moderation-rate-fuse.js';
import {moderationLedgerSafeForDispatch,ambiguousModerationChatIds} from './moderation-review-integrity.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

export type RestrictionOutcome = 'CONFIRMED' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME';
export type ModerationResult = { status: 'APPLIED' | 'NO_CHANGE' | 'DENIED' | 'BLOCKED_PENDING' | 'BLOCKED_UNKNOWN' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME'; reason: string };
type ReviewedReleaseContext={original:ModerationOperation;reference:string;reviewedAt:number;expiresAt:number;source?:'SUBSCRIPTION'};
type KickContext={reference:string;initialReview:(s:BotState)=>boolean};
export interface ModerationGateway {
  /** Local adapter identifier only: never a Telegram enforcement receipt. */
  readonly attemptGateway?:ModerationDispatchGateway;
  canRestrict(chatId: string, memberId: string): Promise<boolean>;
  isProtected(chatId: string, memberId: string): Promise<boolean>;
  setRestriction(chatId: string, memberId: string, kind: RestrictionKind,
    verifyCurrentAuthority?:()=>Promise<boolean>,untilDate?:number): Promise<RestrictionOutcome>;
  kickMember?(chatId:string,memberId:string,verifyCurrentAuthority:()=>Promise<boolean>):Promise<RestrictionOutcome>;
}
export class FakeModerationGateway implements ModerationGateway {
  readonly attemptGateway='SIMULATION' as const;
  rights = true;
  protectedMembers = new Set<string>();
  calls: { chatId: string; memberId: string; kind: RestrictionKind; action?:'KICK' }[] = [];
  throwAfterSend = false;
  outcome: RestrictionOutcome = 'CONFIRMED';
  async canRestrict(_chatId: string, _memberId: string): Promise<boolean> { return this.rights; }
  async isProtected(chatId: string, memberId: string): Promise<boolean> { return this.protectedMembers.has(chatId + ':' + memberId); }
  async setRestriction(chatId: string, memberId: string, kind: RestrictionKind): Promise<RestrictionOutcome> {
    this.calls.push({ chatId, memberId, kind });
    if (this.throwAfterSend) throw new Error('network timeout with ambiguous delivery');
    return this.outcome;
  }
  async kickMember(chatId:string,memberId:string,verifyCurrentAuthority:()=>Promise<boolean>):Promise<RestrictionOutcome>{
    if(!await verifyCurrentAuthority())return 'FAILED_CONFIRMED';
    this.calls.push({chatId,memberId,kind:'NONE',action:'KICK'});
    if(this.throwAfterSend)throw Error('Ambiguous kick delivery');return this.outcome;
  }
}
const byTarget = (r: {chatId: string; memberId: string}, chatId: string, memberId: string): boolean => r.chatId === chatId && r.memberId === memberId;
export function authorizedModerationTarget(s:BotState,policy:Policy,actorId:string,chatId:string,memberId:string,now:number):boolean{
 return !ambiguousModerationChatIds(s).has(chatId)&&actorId!==memberId&&memberId!==policy.ownerId&&/^\d+$/.test(memberId)&&memberId!=='0'&&!policy.has(s,memberId,'chat.manage',chatId,now)&&policy.canUseChat(s,chatId,'moderation')&&policy.has(s,actorId,'chat.manage',chatId,now);
}
export const moderationReasonFingerprint = (s: BotState, chatId: string, memberId: string): string =>
  JSON.stringify(s.moderationReasons.filter(x => byTarget(x, chatId, memberId) && x.active)
    .map(x => [x.source, x.reference, x.kind,...(x.expiresAt===undefined?[]:[{expiresAt:x.expiresAt}])]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

const fingerprint=moderationReasonFingerprint;

/** Match a durable operation's immutable dispatch identity. Terminal status
 * or owner review metadata is not evidence that a different payload may be
 * sent. Never take the outbound kind from a mutable post-INTENT snapshot.
 */
function sameModerationAttempt(a:ModerationOperation,b:ModerationOperation):boolean{
 return a.id===b.id&&a.chatId===b.chatId&&a.memberId===b.memberId&&
  a.actorId===b.actorId&&a.kind===b.kind&&
  a.reasonFingerprint===b.reasonFingerprint&&
  a.policyVersion===b.policyVersion&&a.createdAt===b.createdAt&&
  a.attemptGateway===b.attemptGateway&&a.untilDate===b.untilDate&&a.baselineMode===b.baselineMode&&a.reverses===b.reverses&&a.action===b.action&&a.caseReference===b.caseReference;
}
/** Snapshot only the original target's OTHER durable operations.
 * This prevents an in-flight sanction from ignoring a different writer's
 * completed/cancelled attempt for the same member while Telegram reads wait.
 * The candidate INTENT itself is tracked separately by sameModerationAttempt.
 * Rows from other members must not spuriously invalidate this operation.
 * This string never enters Telegram or public audit/owner output.
 */
function targetOperationHistory(s:BotState,chatId:string,memberId:string,
 candidateId:string):string{
 return JSON.stringify(s.moderationOperations.filter(o=>
  byTarget(o,chatId,memberId)&&o.id!==candidateId));
}

/** Restored array position does NOT prove dispatch chronology. An equal
 * latest timestamp among confirmed sanctions is ambiguous even if kinds
 * match: never select an arbitrary tail and dispatch on that basis.
 */
function latestConfirmedKind(operations:ModerationOperation[]):
 {status:'CLEAR';kind:RestrictionKind;untilDate?:number}|{status:'AMBIGUOUS'}{
 const confirmed=operations.filter(o=>o.status==='CONFIRMED');
 if(!confirmed.length)return {status:'CLEAR',kind:'NONE'};
 // Avoid Math.max(...largeArray) argument overflow for restored histories
 // with many confirmed entries. Keep the ledger untouched and count ties.
 const lastTime=confirmed.reduce((time,o)=>Math.max(time,o.createdAt),0);
 const latest=confirmed.filter(o=>o.createdAt===lastTime);
 return latest.length===1?
  {status:'CLEAR',kind:latest[0]!.kind,...(latest[0]!.untilDate===undefined?{}:{untilDate:latest[0]!.untilDate})}:{status:'AMBIGUOUS'};
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
  private reasonsCurrent(s:BotState,chatId:string,memberId:string):boolean{
    const now=this.clock();return Number.isSafeInteger(now)&&now>=0&&s.moderationReasons.filter(r=>byTarget(r,chatId,memberId)&&r.active).every(r=>r.expiresAt===undefined||(this.gateway instanceof FakeModerationGateway||TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway))&&r.expiresAt>now);
  }
  private untilDate(s:BotState,chatId:string,memberId:string,kind:RestrictionKind):number|undefined{
    const reasons=s.moderationReasons.filter(r=>byTarget(r,chatId,memberId)&&r.active&&r.kind===kind);
    if(!reasons.length||reasons.some(r=>r.expiresAt===undefined))return undefined;
    return Math.ceil(Math.max(...reasons.map(r=>r.expiresAt!))/1000);
  }
  private authorized(s: BotState, actorId: string, chatId: string, memberId: string): boolean {
    // Locally delegated chat managers are protected targets even if Telegram
    // currently reports them as ordinary members. Expired/revoked grants do
    // not shield members, and every dispatch phase reuses this same check.
    // Duplicated restored approval rows cannot authorize an operation.
    // This guard is reused at the initial gate, each atomic mutation,
    // and the awaited gateway's last-mile authority callback.
    return authorizedModerationTarget(s,this.policy,actorId,chatId,memberId,this.clock());
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
    if(!this.authorized(await this.store.snapshot(),actorId,chatId,memberId))return false;
    if(!await this.gateway.canRestrict(chatId,memberId)){if(TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway))await this.store.transaction(s=>{if(this.authorized(s,actorId,chatId,memberId))enqueueAdminRoomRightsFailure(s,this.policy,chatId,this.clock());});return false;}
    return !await this.gateway.isProtected(chatId, memberId);
  }
  private releaseSource(s:BotState,actor:string,chat:string,member:string,reference:string,kind:'BAN'|'MUTE',reasonSource:'MANUAL'|'SUBSCRIPTION'='MANUAL'):ModerationOperation|null{
    if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor)||!TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)||!this.authorized(s,actor,chat,member)||this.unresolved(s,chat,member))return null;
    const reasons=s.moderationReasons.filter(r=>byTarget(r,chat,member)&&r.active);
    if(reasonSource==='SUBSCRIPTION'&&!subscriptionEnforcementConsent(s,this.policy,chat,this.clock()))return null;
    if(reasons.length!==1||reasons[0]!.source!==reasonSource||reasons[0]!.reference!==reference||reasons[0]!.kind!==kind)return null;
    const ops=s.moderationOperations.filter(o=>byTarget(o,chat,member)&&o.status==='CONFIRMED');
    const at=ops.reduce((n,o)=>Math.max(n,o.createdAt),0),latest=ops.filter(o=>o.createdAt===at),op=latest[0];
    return latest.length===1&&op?.kind===kind&&op.attemptGateway==='TELEGRAM_API'&&op.baselineMode==='INHERIT_GROUP_DEFAULTS'&&op.policyVersion===this.policy.chatRevision(s,chat)&&moderationEvidenceMatches(s,op,fingerprint(s,chat,member),this.policy.ownerId,this.clock())?structuredClone(op):null;
  }
  private releaseCurrent(s:BotState,actor:string,chat:string,member:string,context:ReviewedReleaseContext):boolean{
    const now=this.clock(),original=s.moderationOperations.filter(o=>o.id===context.original.id),confirmed=s.moderationOperations.filter(o=>byTarget(o,chat,member)&&o.status==='CONFIRMED');
    const at=confirmed.reduce((n,o)=>Math.max(n,o.createdAt),0),latest=confirmed.filter(o=>o.createdAt===at);
    const reasons=s.moderationReasons.filter(r=>byTarget(r,chat,member)&&r.active);
    return Number.isSafeInteger(now)&&now>=context.reviewedAt&&now<context.expiresAt&&this.policy.isOwner(actor)&&this.policy.privateFeature(s,'owner.dashboard',actor)&&TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)&&
      this.authorized(s,actor,chat,member)&&reasons.length===1&&reasons[0]!.source===(context.source??'MANUAL')&&(context.source!=='SUBSCRIPTION'||subscriptionEnforcementConsent(s,this.policy,chat)!==null)&&reasons[0]!.reference===context.reference&&reasons[0]!.kind===context.original.kind&&moderationEvidenceMatches(s,context.original,fingerprint(s,chat,member),this.policy.ownerId,now)&&original.length===1&&original[0]!.status==='CONFIRMED'&&sameModerationAttempt(original[0]!,context.original)&&
      original[0]!.baselineMode==='INHERIT_GROUP_DEFAULTS'&&original[0]!.attemptGateway==='TELEGRAM_API'&&original[0]!.policyVersion===this.policy.chatRevision(s,chat)&&latest.length===1&&latest[0]!.id===context.original.id;
  }
  supportsSubscriptionEnforcement():boolean{return TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway);}
  async canReviewCommand(actorId:string,chatId:string,memberId:string,release?:{reference:string;kind:'BAN'|'MUTE'}):Promise<boolean>{
    if(await this.priorPending(actorId,chatId,memberId))return false;
    if(await this.check(actorId,chatId,memberId))return true;
    const source=release?this.releaseSource(await this.store.snapshot(),actorId,chatId,memberId,release.reference,release.kind):null;
    return source!==null&&await (this.gateway as TelegramBotApiModerationGateway).canRestoreReviewed(chatId,memberId,{kind:source.kind as 'BAN'|'MUTE',...(source.untilDate===undefined?{}:{untilDate:source.untilDate})});
  }
  async canReviewKick(actor:string,chat:string,member:string):Promise<boolean>{
    return !!this.gateway.kickMember&&(this.gateway instanceof FakeModerationGateway||TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway))&&await this.canReviewCommand(actor,chat,member)&&this.effective(await this.store.snapshot(),chat,member)==='NONE';
  }
  async kickMember(actor:string,chat:string,member:string,reference:string,initialReview?: (s:BotState)=>boolean,expiresAt?:number):Promise<ModerationResult>{
    const now=this.clock();if(!Number.isSafeInteger(now)||now<0||!initialReview||expiresAt===undefined||!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+120000||expiresAt>8640000000000000||/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.exec(reference)?.[0]!==reference||!this.gateway.kickMember||!(this.gateway instanceof FakeModerationGateway||TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)))return {status:'DENIED',reason:'KICK_REQUIRES_REVIEW'};
    const before=await this.store.snapshot();if(!initialReview(before)||!this.authorized(before,actor,chat,member)||this.effective(before,chat,member)!=='NONE')return {status:'DENIED',reason:'KICK_SOURCE_STALE'};
    const source=(s:BotState)=>JSON.stringify([s.chats.filter(c=>c.id===chat),s.grants,s.privateFeatures,s.privateSettingsRevision,s.warnings.filter(w=>byTarget(w,chat,member)),s.moderationReasons.filter(r=>byTarget(r,chat,member))]),epoch=source(before);
    const current=(s:BotState)=>{const at=this.clock();return Number.isSafeInteger(at)&&at>=now&&at<expiresAt&&source(s)===epoch&&this.effective(s,chat,member)==='NONE'&&(!this.policy.isOwner(actor)||this.policy.privateFeature(s,'owner.dashboard',actor));};
    return this.reconcileInternal(actor,chat,member,current,undefined,{reference,initialReview});
  }
  async addManualReason(actorId: string, chatId: string, memberId: string, reference: string, kind: 'MUTE' | 'BAN',stillCurrent?:(s:BotState)=>boolean,durationSeconds?:number,dispatchCurrent?:(s:BotState)=>boolean,reviewedUntil?:number): Promise<ModerationResult> {
    if (!reference || reference.length > 80 || !['MUTE', 'BAN'].includes(kind)) throw new Error('Invalid reason');
    if(reviewedUntil!==undefined){
      const started=this.clock(),prior=stillCurrent,dispatch=dispatchCurrent;
      if(!Number.isSafeInteger(started)||started<0||!Number.isSafeInteger(reviewedUntil)||reviewedUntil<=started||reviewedUntil>8640000000000000)return {status:'DENIED',reason:'MODERATION_REVIEW_EXPIRED'};
      const timely=()=>{const at=this.clock();return Number.isSafeInteger(at)&&at>=started&&at<reviewedUntil;};
      stillCurrent=s=>(!prior||prior(s))&&timely();dispatchCurrent=s=>(!dispatch||dispatch(s))&&timely();
    }
    if(reference.startsWith('law_')){
      if(kind!=='MUTE'||durationSeconds===undefined||durationSeconds>86400)return {status:'DENIED',reason:'RULE_RESTRICTION_REQUIRES_TIMED_MUTE'};
      const prior=stillCurrent,dispatch=dispatchCurrent;
      const lawCurrent=(s:BotState)=>{const at=this.clock();return Number.isSafeInteger(at)&&at>=0&&at<=8640000000000000&&ruleActionAllowed(s,chatId,reference,'mute',at,durationSeconds)&&!!groupRuleDescription(s,chatId,reference,true)&&!exemptFromRule(s,chatId,memberId,reference,at);};
      stillCurrent=s=>(!prior||prior(s))&&lawCurrent(s);dispatchCurrent=s=>(!dispatch||dispatch(s))&&lawCurrent(s);
    }
    if(durationSeconds!==undefined&&(!Number.isSafeInteger(durationSeconds)||durationSeconds<60||durationSeconds>2592000))return {status:'DENIED',reason:'INVALID_DURATION'};
    // An unbranded custom adapter might ignore the optional deadline argument.
    // Never silently turn a timed request into a permanent Telegram sanction.
    if(durationSeconds!==undefined&&!(this.gateway instanceof FakeModerationGateway)&&!TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway))return {status:'DENIED',reason:'DURATION_PROVIDER_UNSUPPORTED'};
    const preflight=await this.priorPending(actorId,chatId,memberId);
    if(preflight)return preflight;
    if (!await this.check(actorId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const added = await this.store.transaction(s => {
      if(stillCurrent&&!stillCurrent(s))return 'DENIED' as const;
      const deadline=durationSeconds===undefined?undefined:this.clock()+durationSeconds*1000;
      if(deadline!==undefined&&(!Number.isSafeInteger(this.clock())||this.clock()<0||!Number.isSafeInteger(deadline)||deadline>8640000000000000))return 'DENIED' as const;
      if (!this.authorized(s, actorId, chatId, memberId))
        return ambiguousModerationChatIds(s).has(chatId)?'DENIED' as const:false;
      const pending=this.unresolved(s,chatId,memberId);
      if(pending)return pending.status;
      const existing = s.moderationReasons.find(x => byTarget(x, chatId, memberId) && x.source === 'MANUAL' && x.reference === reference);
      if(existing&&reference.startsWith('law_'))return false;
      if (existing?.active) { if (existing.kind !== kind) throw new Error('REASON_CONFLICT'); return false; }
      const limit=moderationRateFuse(s,actorId,chatId,this.clock());
      if(limit)return limit;
      if (existing) { existing.kind = kind; existing.active = true; existing.createdBy = actorId;delete existing.expiresAt;if(deadline!==undefined)existing.expiresAt=deadline; }
      else s.moderationReasons.push({ chatId, memberId, source: 'MANUAL', reference, kind, createdBy: actorId, active: true,...(deadline===undefined?{}:{expiresAt:deadline}) });
      return true;
    });
    if(added==='BLOCKED_UNKNOWN'||added==='BLOCKED_PENDING')
      return {status:added,reason:'NO_SAFE_DISPATCH'};
    if(added==='DENIED')return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    if(typeof added==='string')return {status:'DENIED',reason:moderationRateDenial(added)};
    if (!added) return { status: 'NO_CHANGE', reason: 'DUPLICATE_OR_REVOKED' };
    return this.reconcile(actorId, chatId, memberId,dispatchCurrent);
  }
  async removeManualReason(actorId: string, chatId: string, memberId: string, reference: string,expectedKind?:'BAN'|'MUTE',stillCurrent?:(s:BotState)=>boolean,reviewedUntil?:number): Promise<ModerationResult> {
    if(expectedKind!==undefined&&expectedKind!=='BAN'&&expectedKind!=='MUTE')return {status:'DENIED',reason:'INVALID_REASON_KIND'};
    const preflight=await this.priorPending(actorId,chatId,memberId);
    if(preflight)return preflight;
    if (!await this.check(actorId, chatId, memberId)) return expectedKind&&stillCurrent&&reviewedUntil!==undefined?
      this.releaseReviewed(actorId,chatId,memberId,reference,expectedKind,stillCurrent,reviewedUntil):{ status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const changed = await this.store.transaction(s => {
      if(stillCurrent&&!stillCurrent(s))return 'DENIED' as const;
      if (!this.authorized(s, actorId, chatId, memberId))
        return ambiguousModerationChatIds(s).has(chatId)?'DENIED' as const:false;
      const pending=this.unresolved(s,chatId,memberId);
      if(pending)return pending.status;
      const found = s.moderationReasons.find(x => byTarget(x, chatId, memberId) && x.source === 'MANUAL' && x.reference === reference && x.active);
      if (!found) return false;
      // Check the requested release kind in the same transaction as removal.
      // An unmute must never deactivate a ban that happens to share its case ID.
      if(expectedKind!==undefined&&found.kind!==expectedKind)return 'KIND_MISMATCH' as const;
      found.active = false; return true;
    });
    if(changed==='BLOCKED_UNKNOWN'||changed==='BLOCKED_PENDING')
      return {status:changed,reason:'NO_SAFE_DISPATCH'};
    if(changed==='DENIED')return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    if(changed==='KIND_MISMATCH')return {status:'DENIED',reason:'REASON_KIND_MISMATCH'};
    return changed ? this.reconcile(actorId, chatId, memberId) : { status: 'NO_CHANGE', reason: 'NOT_ACTIVE' };
  }
  /** Retire a satisfied MANUAL reason only when another reason keeps precisely
   * the same remote restriction. No remote mutation or CONFIRMED op is added. */
  async retireManualReasonPreservingRestriction(actor:string,chat:string,member:string,reference:string,kind:'MUTE'|'BAN',stillCurrent:(s:BotState)=>boolean,expiresAt:number):Promise<ModerationResult>{
    const started=this.clock();if(typeof stillCurrent!=='function'||!Number.isSafeInteger(started)||started<0||!Number.isSafeInteger(expiresAt)||expiresAt<=started||expiresAt>started+120000||!reference||reference.length>80||!['MUTE','BAN'].includes(kind)||!TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway))return {status:'DENIED',reason:'RETIREMENT_REQUIRES_CURRENT_REVIEW'};
    const prior=await this.priorPending(actor,chat,member);if(prior)return prior;
    const source=(s:BotState)=>{
      const now=this.clock();if(!Number.isSafeInteger(now)||now<started||now>=expiresAt||!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor)||!this.authorized(s,actor,chat,member)||this.unresolved(s,chat,member)||!stillCurrent(s))return null;
      const reasons=s.moderationReasons.filter(r=>byTarget(r,chat,member)&&r.active),found=reasons.filter(r=>r.source==='MANUAL'&&r.reference===reference&&r.kind===kind);
      if(reasons.length<2||found.length!==1)return null;
      const confirmed=s.moderationOperations.filter(o=>byTarget(o,chat,member)&&o.status==='CONFIRMED'),latestAt=confirmed.reduce((at,o)=>Math.max(at,o.createdAt),0),latest=confirmed.filter(o=>o.createdAt===latestAt),op=latest[0];
      if(latest.length!==1||!op||op.kind==='NONE'||op.attemptGateway!=='TELEGRAM_API'||op.baselineMode!=='INHERIT_GROUP_DEFAULTS'||op.policyVersion!==this.policy.chatRevision(s,chat))return null;
      const before=fingerprint(s,chat,member),after=fingerprint({...s,moderationReasons:s.moderationReasons.map(r=>r===found[0]?{...r,active:false}:r)},chat,member);
      if(!moderationEvidenceMatches(s,op,before,this.policy.ownerId,now)||!validReasonRetirement(before,after,op))return null;
      return {op:structuredClone(op),before,after,reasons:JSON.stringify(s.moderationReasons.filter(r=>byTarget(r,chat,member))),operations:targetOperationHistory(s,chat,member,'')};
    };
    const original=source(await this.store.snapshot());if(!original)return {status:'DENIED',reason:'RETIREMENT_SOURCE_UNAVAILABLE'};
    const current=(s:BotState)=>{const fresh=source(s);return fresh!==null&&JSON.stringify(fresh)===JSON.stringify(original);};
    const matched=await (this.gateway as TelegramBotApiModerationGateway).confirmPreservedRestriction(chat,member,{kind:original.op.kind as 'MUTE'|'BAN',...(original.op.untilDate===undefined?{}:{untilDate:original.op.untilDate})},async()=>current(await this.store.snapshot()));
    if(!matched)return {status:'DENIED',reason:'RETIREMENT_REMOTE_NOT_MATCHED'};
    return this.store.transaction(s=>{if(!current(s))return {status:'DENIED' as const,reason:'RETIREMENT_EVIDENCE_CHANGED'};const found=s.moderationReasons.find(r=>byTarget(r,chat,member)&&r.active&&r.source==='MANUAL'&&r.reference===reference&&r.kind===kind)!;
      found.active=false;s.audit.push({actorId:actor,updateKey:REASON_RETIREMENT+randomUUID(),decision:'ALLOW',reason:JSON.stringify({operationId:original.op.id,digest:retirementOperationDigest(original.op),before:original.before,after:original.after}),policyVersion:original.op.policyVersion,at:this.clock()});
      return {status:'APPLIED' as const,reason:'LOCAL_REASON_RETIRED_RESTRICTION_PRESERVED'};
    });
  }
  private async releaseReviewed(actor:string,chat:string,member:string,reference:string,kind:'BAN'|'MUTE',stillCurrent:(s:BotState)=>boolean,expiresAt:number,reasonSource:'MANUAL'|'SUBSCRIPTION'='MANUAL'):Promise<ModerationResult>{
    const now=this.clock();if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+120000)return {status:'DENIED',reason:'RELEASE_REVIEW_EXPIRED'};
    const original=this.releaseSource(await this.store.snapshot(),actor,chat,member,reference,kind,reasonSource);
    if(!original||!await (this.gateway as TelegramBotApiModerationGateway).canRestoreReviewed(chat,member,{kind,...(original.untilDate===undefined?{}:{untilDate:original.untilDate})}))return {status:'DENIED',reason:'RELEASE_SOURCE_UNAVAILABLE'};
    const context=await this.store.transaction(s=>{
      const at=this.clock(),fresh=this.releaseSource(s,actor,chat,member,reference,kind,reasonSource);
      if(at<now||at>=expiresAt||!stillCurrent(s)||!fresh||!sameModerationAttempt(fresh,original))return null;
      // Keep the local reason active until the remote release and its readback
      // are confirmed. A denial must not erase the operator's recovery path.
      return {original,reference,reviewedAt:at,expiresAt,...(reasonSource==='SUBSCRIPTION'?{source:'SUBSCRIPTION' as const}:{})};
    });
    if(!context)return {status:'DENIED',reason:'RELEASE_REVIEW_STALE'};
    return this.reconcileInternal(actor,chat,member,s=>this.releaseCurrent(s,actor,chat,member,context),context);
  }
  async expireManualReasons(actorId:string,chatId:string,memberId:string):Promise<ModerationResult>{
    const pending=await this.priorPending(actorId,chatId,memberId);if(pending)return pending;
    if(TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)){
      const initial=await this.store.snapshot(),now=this.clock(),reasons=initial.moderationReasons.filter(r=>byTarget(r,chatId,memberId)&&r.active),r=reasons[0];
      if(reasons.length&&r&&reasons.every(r=>r.source==='MANUAL'&&r.expiresAt!==undefined&&r.expiresAt<=now)){
        const source=(s:BotState)=>{if(!this.policy.isOwner(actorId)||!TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)||!this.authorized(s,actorId,chatId,memberId)||this.unresolved(s,chatId,memberId))return null;const ops=s.moderationOperations.filter(o=>byTarget(o,chatId,memberId)&&o.status==='CONFIRMED'),at=ops.reduce((n,o)=>Math.max(n,o.createdAt),0),latest=ops.filter(o=>o.createdAt===at),o=latest[0];return latest.length===1&&o&&o.kind!=='NONE'&&o.attemptGateway==='TELEGRAM_API'&&o.baselineMode==='INHERIT_GROUP_DEFAULTS'&&o.policyVersion===this.policy.chatRevision(s,chatId)&&moderationEvidenceMatches(s,o,fingerprint(s,chatId,memberId),this.policy.ownerId,this.clock())?o:null;};
        const original=source(initial),deadline=now+120000;
        if(original?.untilDate!==undefined&&original.untilDate*1000<=now){
          const current=(s:BotState)=>{const at=this.clock(),fresh=source(s);return Number.isSafeInteger(at)&&at>=now&&at<deadline&&!!fresh&&sameModerationAttempt(fresh,original)&&JSON.stringify(s.moderationReasons.filter(x=>byTarget(x,chatId,memberId)&&x.active))===JSON.stringify(reasons);};
          const clear=await (this.gateway as TelegramBotApiModerationGateway).confirmExpiredRestriction(chatId,memberId,{kind:original.kind as 'BAN'|'MUTE',untilDate:original.untilDate},async()=>current(await this.store.snapshot()));
          if(!clear)return {status:'DENIED',reason:'EXPIRY_REMOTE_NOT_CLEAR'};
          return this.store.transaction(s=>{if(!current(s))return {status:'DENIED' as const,reason:'EXPIRY_EVIDENCE_CHANGED'};for(const reason of s.moderationReasons)if(byTarget(reason,chatId,memberId)&&reason.active)reason.active=false;
            const op:ModerationOperation={id:randomUUID(),chatId,memberId,actorId,kind:'NONE',reasonFingerprint:fingerprint(s,chatId,memberId),policyVersion:this.policy.chatRevision(s,chatId),status:'CONFIRMED',createdAt:this.clock(),attemptGateway:'TELEGRAM_API',reverses:original.id};s.moderationOperations.push(op);
            s.audit.push({actorId,updateKey:'moderation-expiry:'+op.id,decision:'ALLOW',reason:'MODERATION_EXPIRY_OBSERVED_CLEAR',policyVersion:op.policyVersion,at:op.createdAt});enqueueAdminRoomOperationNotice(s,this.policy,op,op.createdAt);return {status:'APPLIED' as const,reason:'EXPIRY_OBSERVED_CLEAR'};});
        }
      }
    }
    if(!await this.check(actorId,chatId,memberId))return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    const changed=await this.store.transaction(s=>{
      const now=this.clock();if(!Number.isSafeInteger(now)||now<0||!this.authorized(s,actorId,chatId,memberId))return 'DENIED' as const;
      const blocked=this.unresolved(s,chatId,memberId);if(blocked)return blocked.status;
      const expired=s.moderationReasons.filter(r=>byTarget(r,chatId,memberId)&&r.source==='MANUAL'&&r.active&&r.expiresAt!==undefined&&r.expiresAt<=now);
      if(!expired.length)return false;for(const r of expired)r.active=false;
      s.audit.push({actorId,updateKey:'moderation-expiry:'+randomUUID(),decision:'ALLOW',reason:'MODERATION_REASONS_EXPIRED',policyVersion:this.policy.chatRevision(s,chatId),at:now});return true;
    });
    if(changed==='DENIED')return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    if(changed==='BLOCKED_UNKNOWN'||changed==='BLOCKED_PENDING')return {status:changed,reason:'NO_SAFE_DISPATCH'};
    return changed?this.reconcile(actorId,chatId,memberId):{status:'NO_CHANGE',reason:'NO_EXPIRED_REASON'};
  }
  /** Invoked only by SubscriptionGate's trusted membership reconciliation; never expose as a user command. */
  async setSubscriptionReason(chatId: string, memberId: string, reference: string, active: boolean,
    stillCurrent?: (state:BotState)=>boolean): Promise<ModerationResult> {
    if (!reference || reference.length > 80)return {status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
    if(TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)){const consent=subscriptionEnforcementConsent(await this.store.snapshot(),this.policy,chatId,this.clock());if(!consent||active&&!consent.enabled||!stillCurrent)return {status:'DENIED',reason:'SUBSCRIPTION_ENFORCEMENT_NOT_APPROVED'};const upstream=stillCurrent;stillCurrent=s=>JSON.stringify(subscriptionEnforcementConsent(s,this.policy,chatId,this.clock()))===JSON.stringify(consent)&&upstream(s);}
    const uniqueReason=(s:BotState)=>s.moderationReasons.filter(x=>byTarget(x,chatId,memberId)&&x.source==='SUBSCRIPTION'&&x.reference===reference).length<=1;
    if(!uniqueReason(await this.store.snapshot()))return {status:'DENIED',reason:'SUBSCRIPTION_REASON_AMBIGUOUS'};
    const upstream=stillCurrent;stillCurrent=s=>uniqueReason(s)&&(!upstream||upstream(s));
    const preflight=await this.priorPending(this.policy.ownerId,chatId,memberId);
    if(preflight)return preflight;
    if(!await this.check(this.policy.ownerId, chatId, memberId))
      return !active&&TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)?this.releaseReviewed(this.policy.ownerId,chatId,memberId,reference,'MUTE',stillCurrent,this.clock()+5000,'SUBSCRIPTION'):{status:'DENIED',reason:'NOT_AUTHORIZED_OR_BOT_RIGHTS'};
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
  async issueRuleNotice(actor:string,chat:string,member:string,reference:string,stillCurrent?:(s:BotState)=>boolean):Promise<'ADDED'|'NO_CHANGE'|'DENIED'>{
    if(!await this.check(actor,chat,member))return 'DENIED';
    return this.store.transaction(s=>{
      const now=this.clock(),settings=ruleWarningPolicy(s,chat,reference,now),seconds=settings.status==='CONFIGURED'?settings.policy.seconds:86400;
      if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-seconds*1000||!this.authorized(s,actor,chat,member)||stillCurrent&&!stillCurrent(s)||!groupRuleDescription(s,chat,reference,true)||exemptFromRule(s,chat,member,reference,now)||!ruleActionAllowed(s,chat,reference,'notice',now))return 'DENIED';
      const all=ruleNotices(s,now),candidates=s.audit.filter(a=>/^moderation:rule-notice:[A-Za-z0-9_-]{24}$/u.test(a.updateKey));if(all.length!==candidates.length)return 'DENIED';
      const ref=reference.match(/^law_v([0-9]+)_p([0-9]+)_/u)![0],own=all.filter(n=>n.chat===chat&&n.member===member);
      if(own.some(n=>n.reference===reference||n.reference.startsWith(ref)&&n.expiresAt>now&&['PENDING','CONFIRMED','UNKNOWN_OUTCOME'].includes(n.delivery)))return 'NO_CHANGE';
      if(all.filter(n=>n.delivery==='PENDING').length>=1000)return 'DENIED';
      s.audit.push({actorId:actor,updateKey:RULE_NOTICE+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:'RULE_NOTICE:'+JSON.stringify({chat,member,reference,expiresAt:now+seconds*1000,policyRevision:settings.status==='CONFIGURED'?settings.policy.revision:0}),policyVersion:this.policy.chatRevision(s,chat),at:now});return 'ADDED';
    });
  }
  async requestRuleReview(actor:string,chat:string,member:string,reference:string,stillCurrent?:(s:BotState)=>boolean):Promise<'RECORDED'|'DUPLICATE'|'DENIED'>{
    if(!await this.check(actor,chat,member))return 'DENIED';
    return this.store.transaction(s=>{
      const now=this.clock(),message=Number(/_m([1-9][0-9]{0,15})$/u.exec(reference)?.[1]);
      if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!Number.isSafeInteger(message)||!this.policy.privateFeature(s,'support.use',actor)||!this.authorized(s,actor,chat,member)||stillCurrent&&!stillCurrent(s)||!groupRuleDescription(s,chat,reference,true)||exemptFromRule(s,chat,member,reference,now))return 'DENIED';
      if(!ruleActionAllowed(s,chat,reference,'review',now))return 'DENIED';
      const existing=ruleReviewReports(s,now).filter(r=>r.chat===chat);
      if(existing.some(r=>r.member===member&&r.reference===reference))return 'DUPLICATE';
      // A corrupt candidate must not disappear from the duplicate/cap checks.
      const candidates=s.audit.filter(a=>a.updateKey.startsWith('moderation:report:')&&a.reason.startsWith('MODERATION_REPORT:'));
      for(const a of candidates){try{const r=JSON.parse(Buffer.from(a.reason.slice('MODERATION_REPORT:'.length),'base64url').toString('utf8'));if(r?.chat===chat&&Object.hasOwn(r,'reference')&&!existing.some(e=>'moderation:report:'+e.id===a.updateKey))return 'DENIED';}catch{return 'DENIED';}}
      if(existing.some(r=>r.at>now)||existing.filter(r=>!r.closed).length>=200)return 'DENIED';
      const id=randomBytes(18).toString('base64url');s.audit.push({actorId:actor,updateKey:'moderation:report:'+id,decision:'ALLOW',reason:'MODERATION_REPORT:'+Buffer.from(JSON.stringify({chat,member,message,reference})).toString('base64url'),policyVersion:this.policy.chatRevision(s,chat),at:now});
      enqueueReportNotices(s,this.policy,chat,id,now);enqueueAdminRoomReportNotice(s,this.policy,chat,id,now);return 'RECORDED';
    });
  }
  async issueWarning(actorId: string, chatId: string, memberId: string, reference: string,stillCurrent?:(s:BotState)=>boolean): Promise<{ status: 'ADDED' | 'NO_CHANGE'; count: number } | { status: 'DENIED'; count: null }> {
    if (!reference || reference.length > 80) throw new Error('Invalid warning reference');
    // A local warning must not target a Telegram administrator or bypass
    // missing bot authority. Recheck internal authorization in the transaction
    // after these awaited external reads, just as sanction reason writes do.
    if (!await this.check(actorId,chatId,memberId))return {status:'DENIED',count:null};
    return this.store.transaction(s => {
      if(stillCurrent&&!stillCurrent(s))return {status:'DENIED' as const,count:null};
      const count = () => s.warnings.filter(w => byTarget(w, chatId, memberId) && warningActive(w,this.clock())).length;
      if (!this.authorized(s, actorId, chatId, memberId)) return { status: 'DENIED' as const, count: null };
      if(reference.startsWith('law_')){const at=this.clock();if(!Number.isSafeInteger(at)||at<0||at>8640000000000000||!groupRuleDescription(s,chatId,reference,true)||exemptFromRule(s,chatId,memberId,reference,at))return {status:'DENIED' as const,count:null};}
      if(reference.startsWith('law_')&&!ruleActionAllowed(s,chatId,reference,'warn',this.clock()))return {status:'DENIED' as const,count:null};
      const existing = s.warnings.find(w => byTarget(w, chatId, memberId) && w.reference === reference);
      if (existing) return { status: 'NO_CHANGE' as const, count: count() }; // immutable reference; cannot replay revoked warning
      const at=this.clock(),settings=reference.startsWith('law_')?ruleWarningPolicy(s,chatId,reference,at):{status:'NONE' as const};
      if(settings.status==='INVALID'||settings.status==='CONFIGURED'&&(paragraphWarningCount(s,chatId,memberId,reference,at)>=settings.policy.cap||at>8640000000000000-settings.policy.seconds*1000))return {status:'DENIED' as const,count:null};
      const warning={actorId,chatId,memberId,reference,at,active:true,...(settings.status==='CONFIGURED'?{expiresAt:at+settings.policy.seconds*1000}:{})};s.warnings.push(warning);enqueueAdminRoomWarningNotice(s,this.policy,warning,warning.at);
      return { status: 'ADDED' as const, count: count() };
    });
  }
  async removeWarning(actorId: string, chatId: string, memberId: string, reference: string,stillCurrent?:(s:BotState)=>boolean): Promise<{ status: 'REVOKED' | 'NO_CHANGE'; count: number } | { status: 'DENIED'; count: null }> {
    return this.store.transaction(s => {
      if(stillCurrent&&!stillCurrent(s))return {status:'DENIED' as const,count:null};
      const count = () => s.warnings.filter(w => byTarget(w, chatId, memberId) && warningActive(w,this.clock())).length;
      if (!this.authorized(s, actorId, chatId, memberId)) return { status: 'DENIED' as const, count: null };
      const existing = s.warnings.find(w => byTarget(w, chatId, memberId) && w.reference === reference && w.active);
      if (!existing) return { status: 'NO_CHANGE' as const, count: count() };
      existing.active = false;
      return { status: 'REVOKED' as const, count: count() };
    });
  }
  async reconcile(actorId: string, chatId: string, memberId: string,
    stillCurrent?: (state:BotState)=>boolean): Promise<ModerationResult> {
    return this.reconcileInternal(actorId,chatId,memberId,stillCurrent);
  }
  private async reconcileInternal(actorId:string,chatId:string,memberId:string,stillCurrent?: (state:BotState)=>boolean,release?:ReviewedReleaseContext,kick?:KickContext):Promise<ModerationResult>{
    const dispatchFingerprint=(s:BotState)=>fingerprint(release?{...s,moderationReasons:s.moderationReasons.map(r=>byTarget(r,chatId,memberId)&&r.source===(release.source??'MANUAL')&&r.reference===release.reference?{...r,active:false}:r)}:s,chatId,memberId);
    const preflight=await this.priorPending(actorId,chatId,memberId);
    if(preflight)return preflight;
    const releaseSource=release?{kind:release.original.kind as 'BAN'|'MUTE',...(release.original.untilDate===undefined?{}:{untilDate:release.original.untilDate})}:undefined;
    if (releaseSource?!await (this.gateway as TelegramBotApiModerationGateway).canRestoreReviewed(chatId,memberId,releaseSource):!await this.check(actorId, chatId, memberId)) return { status: 'DENIED', reason: 'NOT_AUTHORIZED_OR_BOT_RIGHTS' };
    const candidate = await this.store.transaction(s => {
      if (!this.authorized(s, actorId, chatId, memberId) ||
          (stillCurrent && !stillCurrent(s)))return {status:'DENIED' as const};
      if(!this.reasonsCurrent(s,chatId,memberId))return {status:'DENIED' as const};
      if(kick&&(!kick.initialReview(s)||this.effective(s,chatId,memberId)!=='NONE'))return {status:'DENIED' as const};
      const pending=this.unresolved(s,chatId,memberId);
      if(pending)return {status:pending.status};
      const operations = s.moderationOperations.filter(x => byTarget(x, chatId, memberId));
      if(kick){const used=operations.find(o=>o.action==='KICK'&&o.caseReference===kick.reference&&o.status!=='CANCELLED');if(used)return {status:used.status==='CONFIRMED'?'NO_CHANGE' as const:'DENIED' as const};}
      const desired = release?'NONE':this.effective(s, chatId, memberId);
      const confirmed=latestConfirmedKind(operations);
      if(confirmed.status==='AMBIGUOUS')
       return {status:'BLOCKED_UNKNOWN' as const};
      const untilDate=this.untilDate(s,chatId,memberId,desired);
      if(!kick&&desired===confirmed.kind&&untilDate===confirmed.untilDate)return {status:'NO_CHANGE' as const};
      if(desired!=='NONE'||kick){
       const limit=moderationRateFuse(s,actorId,chatId,this.clock());
       if(limit)return {status:'RATE_LIMIT' as const,reason:moderationRateDenial(limit)};
      }
      const op: ModerationOperation = { id: randomUUID(), chatId, memberId, actorId, kind: desired, reasonFingerprint: dispatchFingerprint(s), policyVersion: this.policy.chatRevision(s, chatId), status: 'INTENT', createdAt: this.clock(),...(untilDate===undefined?{}:{untilDate}),...(desired!=='NONE'&&TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)?{baselineMode:'INHERIT_GROUP_DEFAULTS' as const}:{}),...(release?{reverses:release.original.id}:{}),...(kick?{action:'KICK' as const,caseReference:kick.reference}:{}) };
      s.moderationOperations.push(op);
      return {status:'READY' as const,id:op.id,intent:{...op},
       targetHistory:targetOperationHistory(s,chatId,memberId,op.id)};
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
      rights=releaseSource?await (this.gateway as TelegramBotApiModerationGateway).canRestoreReviewed(chatId,memberId,releaseSource):await this.gateway.canRestrict(chatId,memberId)&&
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
      // A different worker may have inserted/changed a confirmed or failed
      // attempt for this same target while we awaited remote bot rights.
      // Even with our INTENT intact, the original dispatch decision is stale.
      if(targetOperationHistory(s,chatId,memberId,candidate.id)!==
          candidate.targetHistory){
        quarantineModerationAttempt(s,candidate.intent);
        return {status:'BLOCKED_UNKNOWN' as const};
      }
      if(!sameModerationAttempt(op,candidate.intent)){
        // The original INTENT identity was rewritten during awaited reads.
        // No request is sent, but do not erase that contradictory row.
        quarantineModerationAttempt(s,candidate.intent);
        return {status:'BLOCKED_UNKNOWN' as const};
      }
      const valid = rights && this.reasonsCurrent(s,chatId,memberId) && this.authorized(s, actorId, chatId, memberId) &&
        (!stillCurrent||stillCurrent(s)) &&
        this.policy.chatRevision(s, chatId) === op.policyVersion &&
        dispatchFingerprint(s) === op.reasonFingerprint;
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
          targetOperationHistory(s,chatId,memberId,candidate.id)===
            candidate.targetHistory&&
          op?.status==='STARTED'&&sameModerationAttempt(op,started.receipt)&&
          this.reasonsCurrent(s,chatId,memberId)&&this.authorized(s,actorId,chatId,memberId)&&
          (!stillCurrent||stillCurrent(s))&&
          this.policy.chatRevision(s,chatId)===op.policyVersion&&
          dispatchFingerprint(s)===op.reasonFingerprint;
      }catch{return false;}
    };
    let outcome: RestrictionOutcome;
    try{
      outcome=kick?await this.gateway.kickMember!(started.receipt.chatId,started.receipt.memberId,verifyCurrentAuthority):releaseSource?await (this.gateway as TelegramBotApiModerationGateway).restoreFromReviewedDecision(started.receipt.chatId,started.receipt.memberId,releaseSource,verifyCurrentAuthority):started.receipt.kind==='NONE'&&TelegramBotApiModerationGateway.usesOfficialDispatch(this.gateway)?await (this.gateway as TelegramBotApiModerationGateway).confirmUnrestricted(started.receipt.chatId,started.receipt.memberId,verifyCurrentAuthority):await this.gateway.setRestriction(
        started.receipt.chatId,started.receipt.memberId,
        started.receipt.kind,verifyCurrentAuthority,started.receipt.untilDate);
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
         !sameModerationAttempt(op,started.receipt)||
         targetOperationHistory(s,chatId,memberId,candidate.id)!==
           candidate.targetHistory){
        quarantineModerationAttempt(s,started.receipt);
        return 'BLOCKED_UNKNOWN' as const;
      }
      // The provider response can arrive AFTER the actor grant, target
      // protection, approved group, subscription witness or reason set
      // changed. Its HTTP acknowledgement alone cannot certify that the
      // original local authority remained valid throughout the attempt.
      // Preserve the potentially sent effect as UNKNOWN_OUTCOME instead of
      // publishing APPLIED against revoked authorization. A confirmed 4xx
      // provider refusal is still an explicit no-effect result.
      if(outcome!=='FAILED_CONFIRMED'){
        let stillAuthorized=false;
        try{
          stillAuthorized=this.reasonsCurrent(s,chatId,memberId)&&this.authorized(s,actorId,chatId,memberId)&&
            (!stillCurrent||stillCurrent(s))&&
            this.policy.chatRevision(s,chatId)===started.receipt.policyVersion&&
            dispatchFingerprint(s)===started.receipt.reasonFingerprint;
        }catch{/* Unreliable witness/clock/policy fails closed. */}
        if(!stillAuthorized){
          quarantineModerationAttempt(s,started.receipt);
          return 'BLOCKED_UNKNOWN' as const;
        }
      }
      if(outcome==='CONFIRMED'&&release){
        const reason=s.moderationReasons.find(r=>byTarget(r,chatId,memberId)&&r.active&&r.source===(release.source??'MANUAL')&&r.reference===release.reference);
        if(!reason){quarantineModerationAttempt(s,started.receipt);return 'BLOCKED_UNKNOWN' as const;}
        reason.active=false;
      }
      op.status=outcome;
      s.audit.push({updateKey:'moderation-outcome:'+op.id,actorId,decision:outcome==='CONFIRMED'?'ALLOW':'NOOP',reason:'MODERATION_OUTCOME:'+outcome,policyVersion:op.policyVersion,at:this.clock()});
      enqueueAdminRoomOperationNotice(s,this.policy,op,this.clock());
      return outcome;
    });
    if(final==='BLOCKED_UNKNOWN')
      return {status:'BLOCKED_UNKNOWN',reason:'LEDGER_CHANGED_DURING_DISPATCH'};
    return { status: final === 'CONFIRMED' ? 'APPLIED' : final, reason: final };
  }
}
