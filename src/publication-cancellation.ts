import type { PublicationDelivery } from './store.js';

/**
 * Cancelling never manufactures receipts or erases a send that may already be in flight.
 * QUEUED and confirmed-failed parts have no possible successful remote effect.
 * In-flight or unknown parts stay quarantined until the gateway result or evidence arrives.
 */
export function cancelQueuedMultipartParts(d: PublicationDelivery): void {
  if (d.status !== 'MULTIPART' || !d.multipart) return;
  for (const p of d.multipart.parts) {
    if (p.status === 'QUEUED' || p.status === 'FAILED_CONFIRMED') {
      p.status = 'CANCELLED';
      delete p.leaseUntil;
      delete p.attemptId;
    }
  }
  settleCancelledMultipart(d);
}

/**
 * Keep UNKNOWN and SENDING parts in the original ledger, not terminal delivery status.
 * Partial confirmed receipts stay as SENT; the unsent tail is explicitly CANCELLED.
 */
export function settleCancelledMultipart(d: PublicationDelivery): void {
  if (d.status === 'MULTIPART' && d.multipart &&
      d.multipart.parts.every(p => p.status === 'SENT' || p.status === 'CANCELLED')) {
    d.status = 'CANCELLED';
  }
}
