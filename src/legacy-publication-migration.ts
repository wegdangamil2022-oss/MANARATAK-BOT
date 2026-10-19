/**
 * B4 S121-09 offline reconciliation PREVIEW for historic publications.
 * It never changes a delivery ledger and never presumes that a last forwarded post proves earlier items.
 * Only a trusted, caller-supplied verifier can certify evidence, and ambiguous matches fail closed.
 */
export interface LegacyItem { id: string; revision: string; destination: string; }
export interface LegacyEvidence {
  itemId: string; revision: string; destination: string; messageId: string; evidenceId: string;
  source: 'TRUSTED_RECEIPT' | 'FORWARDED_POST';
}
export interface LegacyManualSkip { itemId: string; actor: string; reason: string; }
export interface LegacyMigrationInput {
  items: LegacyItem[];
  evidence: LegacyEvidence[];
  manualSkips?: LegacyManualSkip[];
  /** Only a UI hint; never authorizes matching or skipping a range. */
  lastSeenOrdinal?: number;
}
export type LegacyReviewStatus = 'PUBLISHED_VERIFIED' | 'MANUALLY_SKIPPED' | 'UNVERIFIED' | 'REVIEW_REQUIRED';
export interface LegacyRecord {
  itemId: string; revision: string; destination: string; status: LegacyReviewStatus;
  diagnostic: string;
  proof?: { evidenceId: string; messageId: string; source: LegacyEvidence['source'] };
  skip?: { actor: string; reason: string };
}
export interface LegacyMigrationPlan {
  records: LegacyRecord[];
  totals: Record<LegacyReviewStatus, number>;
  hasUnresolved: boolean;
}
export type VerifyLegacyEvidence = (evidence: LegacyEvidence) => Promise<boolean>;
export type AuthorizeLegacyReviewer = (actor: string, item: LegacyItem) => Promise<boolean>;
const nonblank = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\u0000-\u001F\u007F]/u.test(s) && s.trim() === s;
const keyFor = (id: string, destination: string) => JSON.stringify([id,destination]);

export async function reconcileLegacyCatalog(
  input: LegacyMigrationInput,
  verify: VerifyLegacyEvidence,
  authorizeReviewer: AuthorizeLegacyReviewer,
): Promise<LegacyMigrationPlan> {
  if (!Array.isArray(input.items) || !Array.isArray(input.evidence) || !Array.isArray(input.manualSkips ?? []) ||
      input.items.length > 2000 || input.evidence.length > 4000 || (input.manualSkips?.length ?? 0) > 2000) throw new Error('INVALID_MIGRATION_SIZE');
  if (input.lastSeenOrdinal !== undefined && (!Number.isSafeInteger(input.lastSeenOrdinal) || input.lastSeenOrdinal < 0))
    throw new Error('INVALID_ORDINAL');
  const index = new Set<string>();
  for (const item of input.items) {
    if (![item.id,item.revision,item.destination].every(nonblank)) throw new Error('INVALID_ITEM');
    const key = item.id; // itemId is a globally unique catalogue identifier, not a per-channel ordinal.
    if (index.has(key)) throw new Error('DUPLICATE_ITEM');
    index.add(key);
  }
  const linkedEvidence = new Map<string,LegacyEvidence[]>();
  const occupiedMessages = new Map<string,Set<string>>();
  const occupiedEvidenceIds = new Map<string,Set<string>>();
  for (const e of input.evidence) {
    if (![e.itemId,e.revision,e.destination,e.messageId,e.evidenceId].every(nonblank) ||
      !['TRUSTED_RECEIPT','FORWARDED_POST'].includes(e.source)) throw new Error('INVALID_EVIDENCE');
    if (!input.items.some(i=>i.id===e.itemId)) throw new Error('UNMATCHED_EVIDENCE_ITEM');
    linkedEvidence.set(e.itemId,[...(linkedEvidence.get(e.itemId)??[]),e]);
    const msgKey = keyFor(e.messageId,e.destination);
    occupiedMessages.set(msgKey,new Set([...(occupiedMessages.get(msgKey)??[]),e.itemId]));
    occupiedEvidenceIds.set(e.evidenceId,new Set([...(occupiedEvidenceIds.get(e.evidenceId)??[]),e.itemId]));
  }
  const skips = new Map<string, LegacyManualSkip[]>();
  for (const skip of input.manualSkips ?? []) {
    if (!nonblank(skip.itemId) || !nonblank(skip.actor) || typeof skip.reason !== 'string' ||
        !skip.reason.trim() || skip.reason.length>200 || !input.items.some(i=>i.id===skip.itemId)) throw new Error('INVALID_SKIP');
    skips.set(skip.itemId,[...(skips.get(skip.itemId)??[]),skip]);
  }
  const records: LegacyRecord[] = [];
  for (const i of input.items) {
    const e = linkedEvidence.get(i.id) ?? [];
    const manual = skips.get(i.id) ?? [];
    const base = {itemId:i.id,revision:i.revision,destination:i.destination};
    const make = (status:LegacyReviewStatus, diagnostic:string, extra:Partial<LegacyRecord>={}) => records.push({...base,status,diagnostic,...extra});
    if (e.length>1 || manual.length>1 || (e.length && manual.length)) {
      make('REVIEW_REQUIRED','CONFLICTING_EVIDENCE_OR_SKIP');continue;
    }
    if (e.length === 1) {
      const v=e[0]!;
      if (v.revision!==i.revision || v.destination!==i.destination ||
        (occupiedMessages.get(keyFor(v.messageId,v.destination))?.size??0)>1 ||
        (occupiedEvidenceIds.get(v.evidenceId)?.size??0)>1) {
        make('REVIEW_REQUIRED','AMBIGUOUS_OR_MISMATCHED_RECEIPT');continue;
      }
      let verified = false;
      try { verified = await verify(v); } catch { /* An outage is not evidence of success or failure. */ }
      if (verified) make('PUBLISHED_VERIFIED','UNIQUE_TRUSTED_EVIDENCE',{
        proof:{messageId:v.messageId,evidenceId:v.evidenceId,source:v.source},
      });
      else make('UNVERIFIED','NO_VERIFIED_RECEIPT');
      continue;
    }
    if (manual.length) {
      let authorized = false;
      try {authorized=await authorizeReviewer(manual[0]!.actor,i);} catch {/* default deny */}
      if(authorized) make('MANUALLY_SKIPPED','EXPLICIT_REVIEWED_SKIP',{
        skip:{actor:manual[0]!.actor,reason:manual[0]!.reason.trim()},
      });
      else make('REVIEW_REQUIRED','SKIP_NOT_AUTHORIZED');
      continue;
    }
    make('UNVERIFIED','NO_ITEM_SPECIFIC_EVIDENCE');
  }
  const totals:Record<LegacyReviewStatus,number> = {PUBLISHED_VERIFIED:0,MANUALLY_SKIPPED:0,UNVERIFIED:0,REVIEW_REQUIRED:0};
  for(const rec of records) totals[rec.status]++;
  return {records,totals,hasUnresolved:totals.UNVERIFIED+totals.REVIEW_REQUIRED>0};
}
