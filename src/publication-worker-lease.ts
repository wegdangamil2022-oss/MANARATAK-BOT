/**
 * B4 offline worker lease: a startup/recovery sweep must not quarantine another
 * worker's active intent. The lease NEVER authorizes replay or exactly-once delivery.
 * An expired attempt is quarantined UNKNOWN until independent receipt reconciliation.
 */
export const PUBLICATION_WORKER_LEASE_MS = 120_000;

export function nextDispatchLease(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(now + PUBLICATION_WORKER_LEASE_MS)) throw new Error('INVALID_DISPATCH_CLOCK');
  return now + PUBLICATION_WORKER_LEASE_MS;
}

/** Legacy SENDING intents without leases are conservatively treated as orphaned. */
export function leaseExpired(leaseUntil: number | undefined, now: number): boolean {
  return !Number.isSafeInteger(leaseUntil) || leaseUntil! <= now;
}
