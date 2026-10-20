import type { BotState } from './store.js';

/**
 * B4 fail-closed deduplication for legacy/corrupt/imported state.
 * This guards both the canonical outbound ledger and the historical review registry.
 * A review marked UNKNOWN or MANUALLY_SKIPPED is still a reservation guard; it
 * must never be silently re-published as a new "missing" item.
 */
export function hasExclusivePublicationReservation(
  state: BotState,
  identity: { destination:string; resourceId:string; revision:string }
): boolean {
  const matches = state.deliveries.filter(d =>
    d.destination===identity.destination && d.resourceId===identity.resourceId &&
    d.revision===identity.revision);
  return matches.length===1 && !state.historicalPublications.some(h =>
    h.destination===identity.destination && h.resourceId===identity.resourceId &&
    h.revision===identity.revision);
}
