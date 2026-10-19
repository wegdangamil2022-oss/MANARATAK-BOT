import { randomUUID, createHash } from 'node:crypto';
import { BotStore, type BotState, type PublicationCampaign, type PublicationPreview, type PublicationDelivery } from './store.js';
import { Policy } from './policy.js';
import { planPublicationPreview } from './publication-preview-plan.js';
import { CampaignMultipartService } from './campaign-multipart.js';
import { nextDispatchLease, leaseExpired } from './publication-worker-lease.js';
import { cancelQueuedMultipartParts } from './publication-cancellation.js';

export interface PublicationReceipt { destination: string; attemptId: string; messageId: string; }
export type PublicationOutcome = { status: 'SENT'; messageId: string } | { status: 'FAILED_CONFIRMED' } | { status: 'UNKNOWN_OUTCOME' };
export interface PublicationGateway {
  canPost(destination: string): Promise<boolean>;
  send(destination: string, text: string, attemptId: string): Promise<PublicationOutcome>;
  verifyReceipt(receipt: PublicationReceipt): Promise<boolean>;
}

/** Only used by offline tests: it records whether an ambiguous attempt actually reached the mock network. */
export class FakePublicationGateway implements PublicationGateway {
  canPostHere = true;
  throwAfterSend = false;
  outcome: PublicationOutcome['status'] = 'SENT';
  calls: { destination: string; text: string; attemptId: string }[] = [];
  private receipts = new Map<string, PublicationReceipt>();
  async canPost(_destination: string): Promise<boolean> { return this.canPostHere; }
  async send(destination: string, text: string, attemptId: string): Promise<PublicationOutcome> {
    this.calls.push({ destination, text, attemptId });
    if (this.outcome === 'SENT' || this.throwAfterSend) {
      const receipt = { destination, attemptId, messageId: `mock-message-${this.calls.length}` };
      this.receipts.set(attemptId, receipt);
      if (this.throwAfterSend) throw new Error('Ambiguous network timeout after mock post');
      return { status: 'SENT', messageId: receipt.messageId };
    }
    return { status: this.outcome };
  }
  getReceipt(attemptId: string): PublicationReceipt | undefined { return this.receipts.get(attemptId); }
  async verifyReceipt(receipt: PublicationReceipt): Promise<boolean> {
    const expected = this.receipts.get(receipt.attemptId);
    return Boolean(expected && expected.destination === receipt.destination && expected.messageId === receipt.messageId);
  }
}
export type DispatchResult = {
  status: 'SENT' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME' | 'EMPTY' | 'PAUSED' | 'CANCELLED' | 'NOT_DUE' | 'BLOCKED';
  messageId?: string;
};
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const validResource = (s: BotState, id: string, sourceScope: string): PublicationPreview | undefined => {
  const r = s.educationResources.find(x => x.id === id && x.scope === sourceScope && x.status === 'PUBLISHED');
  if (!r) return undefined;
  const category = s.educationCategories.find(x => x.id === r.categoryId && x.scope === sourceScope && x.enabled);
  if (!category) return undefined;
  let parent = category;
  const seen = new Set<string>();
  while (parent.parentId) {
    if (seen.has(parent.id)) return undefined;
    seen.add(parent.id);
    const next = s.educationCategories.find(x => x.id === parent.parentId && x.scope === sourceScope && x.enabled);
    if (!next) return undefined;
    parent = next;
  }
  // The preview is plain text, not Telegram HTML/Markdown, so imported data cannot inject entities.
  const lines = [r.title, `الجامعة: ${r.university}`, r.cycle ? `الدورة: ${r.cycle}` : '',
    r.degree ? `الدرجة: ${r.degree}` : '', r.seats !== null ? `المقاعد المذكورة في المصدر: ${r.seats}` : ''].filter(Boolean);
  const text = r.publicationText ?? lines.join('\n');
  const renderPlan = planPublicationPreview({text});
  return { resourceId: r.id, revision: sha({id:r.id,title:r.title,university:r.university,cycle:r.cycle,degree:r.degree,seats:r.seats,categoryId:r.categoryId,scope:r.scope,status:r.status,
    ...(r.publicationText === undefined ? {} : {publicationText:r.publicationText,publicationTextReviewedBy:r.publicationTextReviewedBy})}),text,renderPlan };
};

/** B4 mock-only ledger; a transaction persists SENDING *before* any gateway call. */
export class PublicationService {
  /** Test-only hook models rights revocation between intent and dispatch. */
  beforeSend: (() => Promise<void>) | undefined;
  constructor(private readonly store: BotStore, private readonly policy: Policy,
    private readonly gateway: PublicationGateway, private readonly clock: () => number = Date.now) {}

  private allowed(s: BotState, actor: string, source: string, destination: string): boolean {
    return this.policy.canUseChat(s,source,'navigation') && this.policy.has(s,actor,'content.publish',source,this.clock())
      && this.policy.canUseChat(s,destination,'publishing') && this.policy.has(s,actor,'content.publish',destination,this.clock());
  }
  private validate(s: BotState,c: PublicationCampaign,actingApprover = c.approvedBy ?? c.createdBy): boolean {
    if (!this.allowed(s,actingApprover,c.sourceScope,c.destination)) return false;
    if (this.policy.chatRevision(s,c.sourceScope)!==c.sourcePolicyVersion ||
      this.policy.chatRevision(s,c.destination)!==c.destinationPolicyVersion) return false;
    return c.previews.every(p=>{
      try {
        const current = validResource(s,p.resourceId,c.sourceScope);
        return current?.revision===p.revision && current.text===p.text &&
          (!p.renderPlan || (current.renderPlan?.fingerprint===p.renderPlan.fingerprint &&
            JSON.stringify(current.renderPlan?.parts)===JSON.stringify(p.renderPlan.parts)));
      } catch { return false; }
    });
  }
  async draft(actor: string,sourceScope: string,destination: string,resourceIds: string[],scheduledAt=this.clock()): Promise<PublicationCampaign> {
    if (!Array.isArray(resourceIds) || resourceIds.length===0 || resourceIds.length>20 || resourceIds.some(x=>typeof x!=='string')) throw new Error('INVALID_ITEMS');
    if (new Set(resourceIds).size!==resourceIds.length) throw new Error('DUPLICATE_ITEM');
    if (!Number.isFinite(scheduledAt) || scheduledAt < 0) throw new Error('INVALID_SCHEDULE');
    return this.store.transaction(s=>{
      if (!this.policy.canUseChat(s,destination,'publishing')) throw new Error('DESTINATION_DENIED');
      if (!this.allowed(s,actor,sourceScope,destination)) throw new Error('PUBLISH_DENIED');
      const previews=resourceIds.map(id=>validResource(s,id,sourceScope));
      if (previews.some(x=>!x)) throw new Error('RESOURCE_NOT_PUBLISHED_OR_DISABLED');
      const c:PublicationCampaign={id:randomUUID(),sourceScope,destination,createdBy:actor,
        status:'DRAFT',scheduledAt,createdAt:this.clock(),sourcePolicyVersion:this.policy.chatRevision(s,sourceScope),
        destinationPolicyVersion:this.policy.chatRevision(s,destination),previews:previews as PublicationPreview[]};
      s.campaigns.push(c);
      return structuredClone(c);
    });
  }
  async approve(actor: string,id: string): Promise<PublicationCampaign> {
    return this.store.transaction(s=>{
      const c=s.campaigns.find(x=>x.id===id);if (!c) throw new Error('CAMPAIGN_NOT_FOUND');
      if (!this.allowed(s,actor,c.sourceScope,c.destination)) throw new Error('PUBLISH_DENIED');
      if(c.status==='APPROVED') return structuredClone(c);
      if(c.status!=='DRAFT') throw new Error('NOT_DRAFT');
      if(!this.validate(s,c,actor)) throw new Error('PREVIEW_STALE');
      for(const p of c.previews) {
        // Durable identity: same approved content version cannot be sent twice to one chat across campaigns.
        if(s.deliveries.some(d=>d.destination===c.destination&&d.resourceId===p.resourceId&&d.revision===p.revision))
          throw new Error('DELIVERY_ALREADY_RESERVED');
        if(s.historicalPublications.some(h=>h.destination===c.destination&&h.resourceId===p.resourceId&&h.revision===p.revision))
          throw new Error('HISTORICAL_REVIEW_BLOCKS_REPUBLICATION');
      }
      c.approvedBy=actor;c.status='APPROVED';
      for(const p of c.previews) {
        const plan=p.renderPlan ?? planPublicationPreview({text:p.text});
        // Approval binds the immutable reviewed split to the SAME B4 delivery reservation.
        // The normal dispatcher can never claim this multipart delivery as a single message.
        const multipart=plan.parts.length>1 ? {fingerprint:plan.fingerprint,
          parts:plan.parts.map((payload,index)=>({index,payload:structuredClone(payload),status:'QUEUED' as const}))} : undefined;
        s.deliveries.push({id:randomUUID(),campaignId:id,resourceId:p.resourceId,
          destination:c.destination,revision:p.revision,status:multipart?'MULTIPART':'QUEUED',
          ...(multipart?{multipart}:{})});
      }
      s.audit.push({updateKey:`b4:approve:${id}`,decision:'ALLOW',reason:'CAMPAIGN_PREVIEW_APPROVED',policyVersion:c.destinationPolicyVersion,at:this.clock()});
      return structuredClone(c);
    });
  }
  private multipart():CampaignMultipartService {
    return new CampaignMultipartService(this.store,this.policy,{
      canPost: destination=>this.gateway.canPost(destination),
      sendPart: request=>{
        if(request.part.kind!=='TEXT')throw new Error('UNAPPROVED_MEDIA');
        return this.gateway.send(request.destination,request.part.text,request.attemptId);
      },
      verifyReceipt: receipt=>this.gateway.verifyReceipt(receipt)
    },this.clock);
  }
  private finalize(s: BotState,c: PublicationCampaign): void {
    if (c.status!=='APPROVED') return;
    const statuses=s.deliveries.filter(x=>x.campaignId===c.id).map(x=>x.status);
    if (statuses.length===c.previews.length && statuses.every(x=>x==='SENT'||x==='CANCELLED'||x==='SKIPPED')) c.status='COMPLETED';
  }
  async dispatchNext(campaignId: string): Promise<DispatchResult> {
    const claim=await this.store.transaction(s=>{
      const c=s.campaigns.find(x=>x.id===campaignId);if(!c) throw new Error('CAMPAIGN_NOT_FOUND');
      if(c.status==='PAUSED') return { kind:'PAUSED' as const };
      if(c.status==='CANCELLED') return { kind:'CANCELLED' as const };
      if(c.status!=='APPROVED') return { kind:'EMPTY' as const };
      if(c.scheduledAt>this.clock()) return { kind:'NOT_DUE' as const };
      const d=s.deliveries.find(x=>x.campaignId===c.id && !['SENT','SKIPPED','CANCELLED'].includes(x.status));
      // An uncertain/failed/in-flight earlier item blocks later campaign items until human review.
      if(d?.status==='MULTIPART') return {kind:'MULTIPART' as const,resourceId:d.resourceId};
      if(!d || d.status!=='QUEUED') return {kind:'EMPTY' as const};
      if(!this.validate(s,c)) {c.status='PAUSED';return {kind:'BLOCKED' as const};}
      d.status='SENDING';d.attemptId=randomUUID();d.startedAt=this.clock();d.leaseUntil=nextDispatchLease(this.clock());
      return {kind:'SEND' as const,id:d.id,attemptId:d.attemptId,text:c.previews.find(x=>x.resourceId===d.resourceId)!.text,destination:c.destination};
    });
    if(claim.kind==='MULTIPART') {
      const result=await this.multipart().dispatchNext(campaignId,claim.resourceId);
      return result.messageId===undefined ? {status:result.status} : {status:result.status,messageId:result.messageId};
    }
    if(claim.kind!=='SEND') return {status:claim.kind};
    if(this.beforeSend) await this.beforeSend();
    let canPost=false;
    try {canPost=await this.gateway.canPost(claim.destination);} catch {canPost=false;}
    // Re-check AFTER the await. If authorization is lost, never reach the external gateway.
    const eligible=await this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.id===claim.id);
      const c=s.campaigns.find(x=>x.id===campaignId);
      if(!d||!c||d.status!=='SENDING'||d.attemptId!==claim.attemptId) return false;
      if(leaseExpired(d.leaseUntil,this.clock())) {
        // An expired, durable attempt must be fenced even when the gateway has not been called.
        d.status='UNKNOWN_OUTCOME';
        return false;
      }
      if(canPost&&c.status==='APPROVED'&&this.validate(s,c)) return true;
      if(c.status==='CANCELLED') d.status='CANCELLED';
      else {
        d.status='QUEUED';
        if(c.status==='APPROVED') c.status='PAUSED';
      }
      delete d.leaseUntil; delete d.attemptId; delete d.startedAt;
      return false;
    });
    if(!eligible) return {status:'BLOCKED'};
    let result:PublicationOutcome;
    try {result=await this.gateway.send(claim.destination,claim.text,claim.attemptId);} catch {result={status:'UNKNOWN_OUTCOME'};}
    return this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.id===claim.id)!;
      const c=s.campaigns.find(x=>x.id===campaignId)!;
      if(d.status!=='SENDING'||d.attemptId!==claim.attemptId) return {status:'UNKNOWN_OUTCOME' as const};
      if(result.status==='SENT' && typeof result.messageId==='string' && result.messageId.length>0 &&
        !s.deliveries.some(x=>x.destination===claim.destination &&
          (x.messageId===result.messageId || x.multipart?.parts.some(y=>y.messageId===result.messageId))) &&
        !s.historicalPublications.some(h=>h.destination===claim.destination&&h.proof?.messageId===result.messageId)) {
        d.status='SENT'; d.messageId=result.messageId;
        s.audit.push({updateKey:`b4:delivery:${d.id}`,decision:'ALLOW',reason:'DELIVERY_CONFIRMED',policyVersion:c.destinationPolicyVersion,at:this.clock()});
        this.finalize(s,c);
        return {status:'SENT' as const,messageId:result.messageId};
      }
      d.status=result.status==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
      s.audit.push({updateKey:`b4:delivery:${d.id}`,decision:'NOOP',reason:d.status,policyVersion:c.destinationPolicyVersion,at:this.clock()});
      return {status:d.status};
    });
  }
  async recoverPending():Promise<number> {
    return this.store.transaction(s=>{
      let count=0;
      for(const d of s.deliveries) {
        if(d.status==='SENDING' && leaseExpired(d.leaseUntil,this.clock())) {d.status='UNKNOWN_OUTCOME';count++;}
        if(d.status==='MULTIPART' && d.multipart) for(const part of d.multipart.parts)
          if(part.status==='SENDING' && leaseExpired(part.leaseUntil,this.clock())) {part.status='UNKNOWN_OUTCOME';count++;}
      }
      return count;
    });
  }
  private async mutateCampaign(actor:string,id:string,change:'PAUSED'|'APPROVED'|'CANCELLED'):Promise<void> {
    await this.store.transaction(s=>{
      const c=s.campaigns.find(x=>x.id===id);if(!c)throw new Error('CAMPAIGN_NOT_FOUND');
      if(!this.allowed(s,actor,c.sourceScope,c.destination))throw new Error('PUBLISH_DENIED');
      if(change==='PAUSED'&&c.status!=='APPROVED')throw new Error('NOT_ACTIVE');
      if(change==='APPROVED'&&(c.status!=='PAUSED'||!this.validate(s,c)))throw new Error('PREVIEW_STALE_OR_NOT_PAUSED');
      if(change==='CANCELLED'&&c.status==='COMPLETED')throw new Error('ALREADY_COMPLETED');
      if(change==='CANCELLED' && c.status==='CANCELLED') return;
      c.status=change;
      if(change==='CANCELLED'){
        for(const d of s.deliveries) {
          if(d.campaignId!==id) continue;
          if(d.status==='QUEUED'||d.status==='FAILED_CONFIRMED') d.status='CANCELLED';
          else cancelQueuedMultipartParts(d);
        }
        s.audit.push({updateKey:`b4:cancel:${id}`,actorId:actor,decision:'ALLOW',
          reason:'CAMPAIGN_CANCELLED',policyVersion:c.destinationPolicyVersion,at:this.clock()});
      }
    });
  }
  async pause(actor:string,id:string):Promise<void>{return this.mutateCampaign(actor,id,'PAUSED');}
  async resume(actor:string,id:string):Promise<void>{return this.mutateCampaign(actor,id,'APPROVED');}
  async cancel(actor:string,id:string):Promise<void>{return this.mutateCampaign(actor,id,'CANCELLED');}
  async retryConfirmedFailure(actor:string,campaignId:string,resourceId:string):Promise<void>{
    await this.store.transaction(s=>{
      const c=s.campaigns.find(x=>x.id===campaignId);if(!c)throw new Error('CAMPAIGN_NOT_FOUND');
      if(!this.allowed(s,actor,c.sourceScope,c.destination))throw new Error('PUBLISH_DENIED');
      if(!this.validate(s,c)||c.status!=='APPROVED')throw new Error('PREVIEW_STALE');
      const d=s.deliveries.find(x=>x.campaignId===c.id&&x.resourceId===resourceId);
      if(d?.status!=='FAILED_CONFIRMED')throw new Error('NOT_CONFIRMED_FAILED');
      d.status='QUEUED'; delete d.attemptId;delete d.startedAt;delete d.leaseUntil;
    });
  }
  async reconcileUnknown(actor:string,deliveryId:string,receipt:PublicationReceipt):Promise<PublicationDelivery>{
    const pre=await this.store.snapshot();const d=pre.deliveries.find(x=>x.id===deliveryId);
    if(!d)throw new Error('DELIVERY_NOT_FOUND');
    const c=pre.campaigns.find(x=>x.id===d.campaignId)!;
    if(!this.allowed(pre,actor,c.sourceScope,c.destination))throw new Error('PUBLISH_DENIED');
    if(d.status!=='UNKNOWN_OUTCOME'||d.attemptId!==receipt.attemptId||d.destination!==receipt.destination||!receipt.messageId)
      throw new Error('UNVERIFIED_EVIDENCE');
    if(!await this.gateway.verifyReceipt(receipt))throw new Error('UNVERIFIED_EVIDENCE');
    return this.store.transaction(s=>{
      const current=s.deliveries.find(x=>x.id===deliveryId)!;
      const currentC=s.campaigns.find(x=>x.id===current.campaignId)!;
      if(!this.allowed(s,actor,currentC.sourceScope,currentC.destination))throw new Error('PUBLISH_DENIED');
      if(current.status!=='UNKNOWN_OUTCOME'||current.attemptId!==receipt.attemptId||current.destination!==receipt.destination||
         s.deliveries.some(x=>x.destination===receipt.destination&&
           ((x.id!==current.id&&x.messageId===receipt.messageId)||x.multipart?.parts.some(y=>y.messageId===receipt.messageId))) ||
         s.historicalPublications.some(h=>h.destination===receipt.destination&&h.proof?.messageId===receipt.messageId)) throw new Error('UNVERIFIED_EVIDENCE');
      current.status='SENT';current.messageId=receipt.messageId;
      s.audit.push({updateKey:`b4:reconcile:${current.id}`,decision:'ALLOW',reason:'PROVIDER_RECEIPT_VERIFIED',policyVersion:currentC.destinationPolicyVersion,at:this.clock()});
      this.finalize(s,currentC);
      return structuredClone(current);
    });
  }
  async markManuallySkipped(actor:string,deliveryId:string,reason:string):Promise<void>{
    if(!reason.trim()||reason.length>200)throw new Error('REASON_REQUIRED');
    await this.store.transaction(s=>{
      const d=s.deliveries.find(x=>x.id===deliveryId);if(!d)throw new Error('DELIVERY_NOT_FOUND');
      const c=s.campaigns.find(x=>x.id===d.campaignId)!;
      if(!this.allowed(s,actor,c.sourceScope,c.destination))throw new Error('PUBLISH_DENIED');
      if(d.status==='CANCELLED'||d.status==='SKIPPED')throw new Error('NOT_REVIEWABLE');
      if(d.status==='SENDING'||d.status==='MULTIPART'||d.status==='UNKNOWN_OUTCOME'||d.status==='SENT')throw new Error('REVIEW_REQUIRED');
      d.status='SKIPPED';d.reviewReason=reason.trim();
      s.audit.push({updateKey:`b4:skip:${d.id}`,actorId:actor,decision:'ALLOW',
        reason:'MANUALLY_SKIPPED_UNVERIFIED',policyVersion:c.destinationPolicyVersion,at:this.clock()});
      this.finalize(s,c);
    });
  }
}
