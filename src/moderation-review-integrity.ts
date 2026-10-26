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
