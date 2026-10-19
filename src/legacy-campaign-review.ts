import { randomUUID } from 'node:crypto';
import { BotStore, type BotState, type HistoricalPublicationRecord, type PublicationPreview } from './store.js';
import { Policy } from './policy.js';
import { validResource } from './publishing.js';
import { reconcileLegacyCatalog, type LegacyEvidence, type LegacyManualSkip,
  type LegacyMigrationPlan, type LegacyRecord, type VerifyLegacyEvidence } from './legacy-publication-migration.js';

/**
 * B4 S121-09: a historical review is a reservation *guard*, not a second sender or delivery ledger.
 * No outbound gateway is exposed and no historic evidence is fabricated.
 */
export interface HistoricalPublicationBatch {
  sourceScope: string;
  destination: string;
  resourceIds: string[];
  evidence: LegacyEvidence[];
  manualSkips?: LegacyManualSkip[];
  lastSeenOrdinal?: number;
}
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  value.trim() === value && !/[\u0000-\u001F\u007F]/u.test(value);

export class HistoricalPublicationReviewService {
  constructor(private readonly store: BotStore, private readonly policy: Policy,
    private readonly verify: VerifyLegacyEvidence, private readonly clock: () => number = Date.now) {}

  private allowed(s: BotState, actor: string, source: string, destination: string): boolean {
    return this.policy.canUseChat(s, source, 'navigation') &&
      this.policy.canUseChat(s, destination, 'publishing') &&
      this.policy.has(s, actor, 'content.publish', source, this.clock()) &&
      this.policy.has(s, actor, 'content.publish', destination, this.clock());
  }

  /** All calls are fail-closed, even when an external verifier is pending. */
  private preflight(s: BotState, actor: string, batch: HistoricalPublicationBatch): PublicationPreview[] {
    if (!this.allowed(s,actor,batch.sourceScope,batch.destination)) throw new Error('PUBLISH_DENIED');
    const previews = batch.resourceIds.map(id => validResource(s,id,batch.sourceScope));
    if (previews.some(x=>!x)) throw new Error('RESOURCE_NOT_PUBLISHED_OR_DISABLED');
    for (const p of previews as PublicationPreview[]) {
      if (s.historicalPublications.some(x=>x.destination===batch.destination&&x.resourceId===p.resourceId&&x.revision===p.revision))
        throw new Error('REVIEW_ALREADY_REGISTERED');
      if (s.deliveries.some(x=>x.destination===batch.destination&&x.resourceId===p.resourceId&&x.revision===p.revision))
        throw new Error('DELIVERY_ALREADY_RESERVED');
    }
    return previews as PublicationPreview[];
  }

  async review(actor: string, batch: HistoricalPublicationBatch): Promise<LegacyMigrationPlan> {
    if (!batch || !isId(actor) || !isId(batch.sourceScope) || !isId(batch.destination) ||
      !Array.isArray(batch.resourceIds) || batch.resourceIds.length === 0 || batch.resourceIds.length > 200 ||
      batch.resourceIds.some(x=>!isId(x)) || new Set(batch.resourceIds).size !== batch.resourceIds.length ||
      !Array.isArray(batch.evidence) || batch.evidence.length > 4000 ||
      (batch.manualSkips !== undefined && (!Array.isArray(batch.manualSkips) || batch.manualSkips.length > 200)))
      throw new Error('INVALID_REVIEW_BATCH');

    const before = await this.store.snapshot();
    const previews = this.preflight(before,actor,batch);
    const items=previews.map(p=>({id:p.resourceId,revision:p.revision,destination:batch.destination}));
    const plan=await reconcileLegacyCatalog({
      items,evidence:batch.evidence,...(batch.manualSkips===undefined?{}:{manualSkips:batch.manualSkips}),
      ...(batch.lastSeenOrdinal===undefined?{}:{lastSeenOrdinal:batch.lastSeenOrdinal})
    },this.verify,async (skipActor)=>skipActor===actor && this.allowed(before,actor,batch.sourceScope,batch.destination));

    return this.store.transaction(s=>{
      const latest=this.preflight(s,actor,batch);
      if(this.policy.chatRevision(s,batch.sourceScope)!==this.policy.chatRevision(before,batch.sourceScope) ||
         this.policy.chatRevision(s,batch.destination)!==this.policy.chatRevision(before,batch.destination) ||
         latest.some((p,i)=>p.revision!==previews[i]!.revision || p.text!==previews[i]!.text))
        throw new Error('REVIEW_STALE');
      const records:LegacyRecord[]=plan.records.map(item=>{
        if (item.status!=='PUBLISHED_VERIFIED'||!item.proof)return item;
        const duplicateMessage = s.deliveries.some(d=>d.destination===item.destination &&
          (d.messageId===item.proof!.messageId ||
           d.multipart?.parts.some(part=>part.messageId===item.proof!.messageId)));
        const duplicateHistoric = s.historicalPublications.some(h=>
          (h.destination===item.destination&&h.proof?.messageId===item.proof!.messageId) ||
          h.proof?.evidenceId===item.proof!.evidenceId);
        if (duplicateMessage||duplicateHistoric) return {
          itemId:item.itemId,revision:item.revision,destination:item.destination,
          status:'REVIEW_REQUIRED' as const,diagnostic:'RECEIPT_CONFLICT_WITH_EXISTING_HISTORY'
        };
        return item;
      });
      const results:LegacyMigrationPlan={
        records,totals:{PUBLISHED_VERIFIED:0,MANUALLY_SKIPPED:0,UNVERIFIED:0,REVIEW_REQUIRED:0},hasUnresolved:false
      };
      for(const rec of records) {
        results.totals[rec.status]++;
        const stored:HistoricalPublicationRecord={
          id:randomUUID(),sourceScope:batch.sourceScope,resourceId:rec.itemId,
          revision:rec.revision,destination:rec.destination,status:rec.status,
          diagnostic:rec.diagnostic,reviewedBy:actor,reviewedAt:this.clock(),
          ...(rec.proof ? {proof:structuredClone(rec.proof)} : {}),
          ...(rec.skip ? {skip:structuredClone(rec.skip)} : {})
        };
        s.historicalPublications.push(stored);
        s.audit.push({updateKey:`b4:historic:${stored.id}`,decision:rec.status==='PUBLISHED_VERIFIED'?'ALLOW':'NOOP',
          reason:`HISTORIC_${rec.status}`,policyVersion:this.policy.chatRevision(s,batch.destination),at:this.clock()});
      }
      results.hasUnresolved=results.totals.UNVERIFIED+results.totals.REVIEW_REQUIRED>0;
      return structuredClone(results);
    });
  }
}
