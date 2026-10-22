import type {BotStore} from './store.js';
import type {Policy} from './policy.js';

/** Aggregate-only owner view; no update keys, member IDs or text. */
export interface OutboxAccessDenialSummary{
 totalFailed:number;
 legacyUnverifiable:number;
 accessRecheckFailed:number;
 groupUnavailable:number;
 otherConfirmedFailures:number;
}
/** TDD RED skeleton. */
export async function summarizeOutboxAccessDenials(
 _store:Pick<BotStore,'snapshot'>,_policy:Policy,_actorId:string
):Promise<OutboxAccessDenialSummary>{
 return {totalFailed:0,legacyUnverifiable:0,accessRecheckFailed:0,
  groupUnavailable:0,otherConfirmedFailures:0};
}
