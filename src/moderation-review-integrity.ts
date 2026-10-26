import type {BotState} from './store.js';

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
      (typeof op.createdAt==='number'&&review.reviewedAt<op.createdAt)){
    malformedRows++;
   }
  }
 }
 return {valid:malformedRows===0,malformedRows};
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
 state:Pick<BotState,'moderationOperations'>):boolean{
 return inspectModerationLedgerIntegrity(state).valid&&
  ambiguousModerationOperationIds(state).size===0;
}
