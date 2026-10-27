import {createHash} from 'node:crypto';
import type {BotState,ModerationOperation} from './store.js';

/** Stable, versioned local evidence fingerprint for an UNKNOWN_OUTCOME
 * attempt's immutable identity. A comparison checksum, NOT an HMAC, digital
 * signature, remote Telegram receipt or authorization credential.
 *
 * Only bind fields from the operation itself: subsequent chat approval epochs,
 * callback expiries and owner annotations must not rewrite its original
 * dispatch identity or invalidate historical, correctly linked reviews.
 */
export function moderationReviewEvidenceDigest(op:ModerationOperation):string{
 return createHash('sha256')
  .update('MANARATAK:MODERATION:REVIEW:EVIDENCE:V1:')
  .update(JSON.stringify([
   op.id,op.chatId,op.memberId,op.actorId,op.kind,
   op.reasonFingerprint,op.policyVersion,op.createdAt,
   op.status,op.attemptGateway??null
  ]))
  .digest('hex');
}

/** Triage must not interpret an operation ID as unique merely because the
 * persisted schema permits an array. Restores, corrupted histories or multiple
 * writers may produce duplicate identities. Collision evidence from ANY
 * group/status invalidates a moderation-review selector for that identifier.
 * This file is strictly observational: it never rewrites the ledger.
 */
export function ambiguousModerationOperationIds(
 state:Pick<BotState,'moderationOperations'>):ReadonlySet<string>{
 const seen=new Set<string>(),ambiguous=new Set<string>();
 for(const op of state.moderationOperations){
  if(seen.has(op.id))ambiguous.add(op.id);
  seen.add(op.id);
 }
 return ambiguous;
}

/** Duplicate restored group approval records are not a source of
 * authority. Even two byte-identical Chat rows are ambiguous: a restore
 * cannot prove which permission epoch should govern this action.
 * Quarantine only the affected chat IDs; do not rewrite or collapse rows.
 */
export function ambiguousModerationChatIds(
 state:Pick<BotState,'chats'>):ReadonlySet<string>{
 const seen=new Set<string>(),ambiguous=new Set<string>();
 for(const chat of state.chats){
  if(seen.has(chat.id))ambiguous.add(chat.id);
  seen.add(chat.id);
 }
 return ambiguous;
}

/** A review confirmation nonce is actionable only if exactly one stored
 * callback has the reference. This is checked in the same transaction as
 * committing the owner annotation and consuming the nonce.
 */
export function uniqueModerationReviewNonce(
 state:Pick<BotState,'callbacks'>,ref:string):boolean{
 let count=0;
 for(const callback of state.callbacks){
  if(callback.ref===ref&&++count>1)return false;
 }
 return count===1;
}

/**
 * Version-compatible restored-ledger integrity check. The general BotStore
 * schema deliberately accepts legacy moderation records, so a syntactically
 * valid restored SQLite/JSON file may contain an invalid operation row.
 * Unknown statuses MUST NEVER be interpreted as a finished sanction and
 * thereby authorize another Telegram request. All moderation effects and
 * owner review decisions fail closed when any row is malformed.
 *
 * This validator never mutates entries or discloses their identifying data.
 * Identity collisions are handled separately by the owner-review quarantine:
 * historical duplicate IDs must not be silently repaired or discarded.
 */
export function inspectModerationLedgerIntegrity(
 state:Pick<BotState,'moderationOperations'>):
 {valid:boolean;malformedRows:number}{
 const values=state?.moderationOperations;
 if(!Array.isArray(values))return {valid:false,malformedRows:1};
 let malformedRows=0;
 const user=/^[1-9][0-9]*$/u;
 const group=/^-[1-9][0-9]*$/u;
 const maxTime=8_640_000_000_000_000;
 const statuses=new Set(['INTENT','STARTED','CONFIRMED',
  'FAILED_CONFIRMED','UNKNOWN_OUTCOME','CANCELLED']);
 const kinds=new Set(['NONE','MUTE','BAN']);
 const gateways=new Set(['SIMULATION','TELEGRAM_API','UNSPECIFIED']);
 for(const candidate of values){
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)){
   malformedRows++;continue;
  }
  const op=candidate as unknown as Record<string,unknown>;
  const isSafeTime=(v:unknown)=>typeof v==='number'&&
   Number.isSafeInteger(v)&&v>=0&&v<=maxTime;
  const invalid=typeof op.id!=='string'||op.id.trim()===''||
   typeof op.chatId!=='string'||!group.test(op.chatId)||
   typeof op.memberId!=='string'||!user.test(op.memberId)||
   typeof op.actorId!=='string'||!user.test(op.actorId)||
   typeof op.kind!=='string'||!kinds.has(op.kind)||
   typeof op.reasonFingerprint!=='string'||
   !Number.isSafeInteger(op.policyVersion)||typeof op.policyVersion!=='number'||
   op.policyVersion<1||
   typeof op.status!=='string'||!statuses.has(op.status)||
   !isSafeTime(op.createdAt)||
   // A newly reserved INTENT cannot carry a provider label: it has not
   // crossed the durable STARTED dispatch boundary.
   (op.status==='INTENT'&&op.attemptGateway!==undefined)||
   (op.attemptGateway!==undefined&&
    (typeof op.attemptGateway!=='string'||!gateways.has(op.attemptGateway)));
  if(invalid){malformedRows++;continue;}
  if(op.review!==undefined){
   if(!op.review||typeof op.review!=='object'||Array.isArray(op.review)){
    malformedRows++;continue;
   }
   const review=op.review as Record<string,unknown>;
   if(op.status!=='UNKNOWN_OUTCOME'||
      (review.decision!=='ACKNOWLEDGED_UNRESOLVED'&&review.decision!=='ESCALATED')||
      typeof review.reviewedBy!=='string'||!user.test(review.reviewedBy)||
      !isSafeTime(review.reviewedAt)||
      (review.evidenceDigest!==undefined&&
       (typeof review.evidenceDigest!=='string'||
        !/^[a-f0-9]{64}$/u.test(review.evidenceDigest)))||
      (review.policyVersion!==undefined&&
       (typeof review.policyVersion!=='number'||
        !Number.isSafeInteger(review.policyVersion)||review.policyVersion<(op.policyVersion as number)))||
      (typeof op.createdAt==='number'&&typeof review.reviewedAt==='number'&&
       review.reviewedAt<op.createdAt)){
    malformedRows++;
   }
  }
 }
 return {valid:malformedRows===0,malformedRows};
}

/** An owner review receipt survives as an audit row after its original
 * UNKNOWN_OUTCOME attempt has been lost in a restore. A missing original is
 * NOT proof of safe cancellation or a clean moderation history. Match only
 * the official, namespace-prefixed local correlation key; unrelated audit
 * domains must never trigger quarantine. Duplicate unmatched receipts count
 * individually. No identities, hashes or raw evidence leave this function.
 *
 * An optional absent audit collection keeps legacy pure projections usable.
 * A present but unreadable audit collection is anomalous and fails closed.
 */
export function orphanModerationReviewAuditReceipts(
 state:Pick<BotState,'moderationOperations'>&Partial<Pick<BotState,'audit'>>
):number{
 if(state.audit===undefined)return 0;
 if(!Array.isArray(state.audit))return 1;
 const prefix='owner:moderation:review:';
 const existing=new Set<string>();
 for(const op of state.moderationOperations){
  if(op?.status!=='UNKNOWN_OUTCOME'||typeof op.id!=='string')continue;
  existing.add(prefix+createHash('sha256')
   .update('MODERATION:REVIEW:'+op.id).digest('hex').slice(0,32));
 }
 let missing=0;
 for(const row of state.audit){
  if(row&&typeof row.updateKey==='string'&&
    row.updateKey.startsWith(prefix)&&!existing.has(row.updateKey))
    missing++;
 }
 return missing;
}

/** Count UNKNOWN_OUTCOME records whose owner-review annotation and
 * durable audit are contradictory, missing, duplicated, or one-sided.
 * Unlike legacy unbound (digest-free) records, INCONSISTENT evidence is a
 * global dispatch hazard even when the original operation still exists:
 * a partial restore cannot prove the unaffected groups have a sound ledger.
 *
 * A missing audit property is allowed for older pure projections; every
 * writable BotStore snapshot supplies an audit collection. This function
 * is observational and never edits evidence or discloses record identities.
 */
export function conflictingModerationReviewAuditOperations(
 state:Pick<BotState,'moderationOperations'>&Partial<Pick<BotState,'audit'>>,
 asOf?:number
):number{
 if(state.audit===undefined)return 0;
 if(!Array.isArray(state.audit))return 1;
 let count=0;
 for(const op of state.moderationOperations){
  if(op?.status==='UNKNOWN_OUTCOME'&&
   moderationOwnerReviewAuditConsistency({audit:state.audit},op,asOf)==='INCONSISTENT')
   count++;
 }
 return count;
}

/** A structurally valid restored ledger can still contain two individually
 * valid rows with the SAME durable operation ID. Dispatch and clean recovery
 * must fail closed globally: target-based filtering and find(id) can otherwise
 * select conflicting evidence. Owner review may continue isolating only the
 * colliding IDs via ambiguousModerationOperationIds.
 *
 * This check is read-only, has no identifier output and must be repeated at
 * each durable mutation and async authority-check boundary.
 */
export function moderationLedgerSafeForDispatch(
 state:Pick<BotState,'moderationOperations'>&Partial<Pick<BotState,'audit'>>,
 asOf?:number
):boolean{
 // An in-flight dispatch must not rely on an owner review that allegedly
 // happened in the future, including after a restored system clock rollback.
 // Callers may omit asOf only for legacy / purely structural projections;
 // every actual dispatch supplies its current trusted observation clock.
 if(asOf!==undefined&&(!Number.isSafeInteger(asOf)||asOf<0||
   asOf>8_640_000_000_000_000))return false;
 return inspectModerationLedgerIntegrity(state).valid&&
  ambiguousModerationOperationIds(state).size===0&&
  orphanModerationReviewAuditReceipts(state)===0&&
  conflictingModerationReviewAuditOperations(state,asOf)===0;
}

/** Strict LOCAL corroboration of a moderation owner review with its appended
 * audit receipt. The SHA-256 audit key is a correlation identifier, NOT a
 * cryptographic signature or proof of an external moderation outcome.
 *
 * Legacy review records have no stored review-time group epoch; their audit
 * policyVersion is checked for safe chronology only. Newly created records
 * pin that epoch for an exact audit comparison. Inconsistent rows are left
 * untouched and hidden from owner-action selectors, so independent cases
 * remain reviewable without trusting restored, partial evidence.
 */
export function moderationOwnerReviewAuditConsistency(
 state:Pick<BotState,'audit'>,op:ModerationOperation,asOf?:number
):'UNREVIEWED'|'REVIEWED'|'LEGACY_UNBOUND'|'INCONSISTENT'{
 if(!state||!Array.isArray(state.audit))return 'INCONSISTENT';
 const auditKey='owner:moderation:review:'+
  createHash('sha256').update('MODERATION:REVIEW:'+op.id).digest('hex').slice(0,32);
 const records=state.audit.filter(a=>a&&a.updateKey===auditKey);
 if(!op.review)return records.length===0?'UNREVIEWED':'INCONSISTENT';
 if(records.length!==1)return 'INCONSISTENT';
 const entry=records[0]!,review=op.review;
 // The checksum and audit row can match while their review timestamp is
 // still in the FUTURE after a clock rollback or database restore.
 // Callers with a trusted observation clock must not label such evidence as
 // REVIEWED or legacy corroborated until that time has actually arrived.
 // This is a local temporal consistency check, not proof of Telegram delivery.
 if(asOf!==undefined&&(!Number.isSafeInteger(asOf)||asOf<0||
    asOf>8_640_000_000_000_000||
    typeof review.reviewedAt!=='number'||!Number.isSafeInteger(review.reviewedAt)||
    review.reviewedAt>asOf))return 'INCONSISTENT';
 const expectedReason=review.decision==='ESCALATED'?
  'MODERATION_UNKNOWN_OWNER_ESCALATED':'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED';
 if(entry.decision!=='ALLOW'||entry.reason!==expectedReason||
    entry.actorId!==review.reviewedBy||entry.at!==review.reviewedAt||
    typeof entry.policyVersion!=='number'||
    !Number.isSafeInteger(entry.policyVersion)||
    entry.policyVersion<op.policyVersion||
    (review.policyVersion!==undefined&&review.policyVersion!==entry.policyVersion))
  return 'INCONSISTENT';
 // Old records lacking both evidence digests remain readable for human
 // investigation, but have no V1-bound local review confidence.
 // Removing BOTH digests from a new record must never preserve its trusted
 // REVIEWED badge: it becomes LEGACY_UNBOUND. A one-sided removal remains
 // inconsistent and is quarantined.
 const reviewEvidence=review.evidenceDigest;
 const auditEvidence=entry.moderationEvidenceDigest;
 if(reviewEvidence===undefined&&auditEvidence===undefined)
  return 'LEGACY_UNBOUND';
 if(reviewEvidence!==undefined||auditEvidence!==undefined){
  if(typeof reviewEvidence!=='string'||typeof auditEvidence!=='string'||
     !/^[a-f0-9]{64}$/u.test(reviewEvidence)||
     !/^[a-f0-9]{64}$/u.test(auditEvidence)||
     reviewEvidence!==auditEvidence||
     reviewEvidence!==moderationReviewEvidenceDigest(op))
    return 'INCONSISTENT';
 }
 return 'REVIEWED';
}
