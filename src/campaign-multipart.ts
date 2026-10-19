import { createHash, randomUUID } from 'node:crypto';
import { BotStore, type BotState } from './store.js';
import { Policy } from './policy.js';
import { planPublicationPreview, type PublicationRenderPart, type PublicationRenderPlan } from './publication-preview-plan.js';
import { nextDispatchLease, leaseExpired } from './publication-worker-lease.js';
import { settleCancelledMultipart } from './publication-cancellation.js';

/** B4 offline contract: the parts live INSIDE the original BotStore delivery, not a second ledger. */
type PartStatus = 'QUEUED'|'SENDING'|'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED';
export interface CampaignPart { index:number; payload:PublicationRenderPart; status:PartStatus; attemptId?:string; leaseUntil?:number; messageId?:string; }
export interface AttachedParts { fingerprint:string; parts:CampaignPart[]; }
type Campaign = {
 id:string; sourceScope:string; destination:string; approvedBy?:string; createdBy:string;
 status:'DRAFT'|'APPROVED'|'PAUSED'|'CANCELLED'|'COMPLETED'; scheduledAt:number;
 sourcePolicyVersion:number; destinationPolicyVersion:number;
 previews:{resourceId:string;revision:string;text:string;renderPlan?:PublicationRenderPlan}[];
};
type Delivery = {
 id:string; campaignId:string; resourceId:string; revision:string; destination:string;
 status:'QUEUED'|'MULTIPART'|'SENDING'|'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED'|'SKIPPED';
 messageId?:string; multipart?:AttachedParts;
};
type State = Omit<BotState, 'campaigns' | 'deliveries'> & {campaigns:Campaign[];deliveries:Delivery[]};
export type CampaignPartOutcome = {status:'SENT';messageId:string}|{status:'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'};
export interface CampaignPartReceipt {attemptId:string;destination:string;messageId:string;}
export interface CampaignPartGateway {
 canPost(destination:string):Promise<boolean>;
 sendPart(request:{destination:string;index:number;attemptId:string;part:PublicationRenderPart}):Promise<CampaignPartOutcome>;
 verifyReceipt(receipt:CampaignPartReceipt):Promise<boolean>;
}
export type CampaignPartResult={status:'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'BLOCKED'|'EMPTY'|'CANCELLED'|'NOT_DUE';index?:number;messageId?:string};
const clone=<T>(x:T):T=>structuredClone(x);
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const isSafeId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001F\u007F]/u.test(v);
const state=(s:BotState):State=>s as unknown as State;

/** Does not trust preview IDs: each dispatch recomputes the resource revision and category visibility. */
function resourceVisible(s:BotState,c:Campaign,p:Campaign['previews'][number]):boolean {
 const r=s.educationResources.find(x=>x.id===p.resourceId&&x.scope===c.sourceScope&&x.status==='PUBLISHED');
 if(!r)return false;
 const seen=new Set<string>();let category=s.educationCategories.find(x=>x.id===r.categoryId&&x.scope===c.sourceScope&&x.enabled);
 if(!category)return false;
 while(category.parentId){if(seen.has(category.id))return false;seen.add(category.id);
  const parent=s.educationCategories.find(x=>x.id===category!.parentId&&x.scope===c.sourceScope&&x.enabled);
  if(!parent)return false;category=parent;
 }
 const revision=digest({id:r.id,title:r.title,university:r.university,cycle:r.cycle,degree:r.degree,seats:r.seats,categoryId:r.categoryId,scope:r.scope,status:r.status,
   ...(r.publicationText===undefined?{}:{publicationText:r.publicationText,publicationTextReviewedBy:r.publicationTextReviewedBy})});
 const text=r.publicationText??[r.title,`الجامعة: ${r.university}`,r.cycle?`الدورة: ${r.cycle}`:'',r.degree?`الدرجة: ${r.degree}`:'',r.seats!==null?`المقاعد المذكورة في المصدر: ${r.seats}`:''].filter(Boolean).join('\n');
 return p.revision===revision&&p.text===text;
}

/**
 * B4 single-ledger multipart dispatcher. This test-only bridge recognizes approved B4 campaigns,
 * and atomically changes a QUEUED delivery to MULTIPART with its immutable parts. The original
 * PublicationService only claims QUEUED deliveries, so the same item cannot use both gateways.
 * Production needs a genuinely multi-worker transactional datastore and a real Telegram adapter.
 */
export class CampaignMultipartService {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
             private readonly gateway:CampaignPartGateway,private readonly clock:()=>number=Date.now){}
 private get(s:BotState,campaignId:string,resourceId:string):{campaign:Campaign;delivery:Delivery;preview:Campaign['previews'][number]} {
  const b=state(s);const campaign=b.campaigns?.find(c=>c.id===campaignId);
  if(!campaign)throw new Error('CAMPAIGN_NOT_FOUND');
  const preview=campaign.previews.find(p=>p.resourceId===resourceId);
  const delivery=b.deliveries?.find(d=>d.campaignId===campaignId&&d.resourceId===resourceId);
  if(!preview||!delivery||delivery.revision!==preview.revision||delivery.destination!==campaign.destination)throw new Error('DELIVERY_NOT_FOUND');
  return {campaign,delivery,preview};
 }
 private authorized(s:BotState,c:Campaign):boolean {
  const actor=c.approvedBy;
  return !!actor&&this.policy.canUseChat(s,c.sourceScope,'navigation')&&
    this.policy.canUseChat(s,c.destination,'publishing')&&
    this.policy.has(s,actor,'content.publish',c.sourceScope,this.clock())&&
    this.policy.has(s,actor,'content.publish',c.destination,this.clock())&&
    this.policy.chatRevision(s,c.sourceScope)===c.sourcePolicyVersion&&
    this.policy.chatRevision(s,c.destination)===c.destinationPolicyVersion&&
    c.previews.every(p=>resourceVisible(s,c,p));
 }
 async stage(actor:string,campaignId:string,resourceId:string,plan:PublicationRenderPlan):Promise<{status:string;parts:CampaignPart[]}> {
  if(!plan||plan.kind!=='TEXT'||plan.linkPreview||!Array.isArray(plan.parts)||plan.parts.length<1||plan.parts.length>10||
    plan.parts.some(p=>p.kind!=='TEXT'||!p.text||p.text.length>4096))throw new Error('PREVIEW_MISMATCH');
  return this.store.transaction(s=>{
    const {campaign:c,delivery:d,preview:p}=this.get(s,campaignId,resourceId);
    if(c.status!=='APPROVED')throw new Error('CAMPAIGN_NOT_APPROVED');
    if(!this.authorized(s,c)||!this.policy.has(s,actor,'content.publish',c.destination,this.clock())||
       !this.policy.has(s,actor,'content.publish',c.sourceScope,this.clock()))throw new Error('PUBLISH_DENIED');
    if(d.status!=='QUEUED')throw new Error('ALREADY_STAGED');
    // A re-render is not consent to change what was approved. No photo/inline URL without an approved plan.
    const canonical=planPublicationPreview({text:p.text});
    if(canonical.fingerprint!==plan.fingerprint||JSON.stringify(canonical.parts)!==JSON.stringify(plan.parts))throw new Error('PREVIEW_MISMATCH');
    d.status='MULTIPART'; d.multipart={fingerprint:canonical.fingerprint,
      parts:canonical.parts.map((payload,index)=>({index,payload:clone(payload),status:'QUEUED'}))};
    s.audit.push({updateKey:`b4:multipart:stage:${d.id}`,decision:'ALLOW',reason:'PARTS_RESERVED_FROM_APPROVED_PREVIEW',policyVersion:c.destinationPolicyVersion,at:this.clock()});
    return {status:d.status,parts:clone(d.multipart.parts)};
  });
 }
 async recoverPending():Promise<number> {
  return this.store.transaction(s=>{
   let count=0;
   for(const d of state(s).deliveries??[])if(d.status==='MULTIPART'&&d.multipart)for(const part of d.multipart.parts)
     if(part.status==='SENDING' && leaseExpired(part.leaseUntil,this.clock())){part.status='UNKNOWN_OUTCOME';count++;}
   return count;
  });
 }
 private markComplete(s:BotState,c:Campaign,d:Delivery):void {
  if(d.multipart?.parts.every(p=>p.status==='SENT')){
    d.status='SENT';if(d.multipart.parts[0]?.messageId)d.messageId=d.multipart.parts[0].messageId;
    s.audit.push({updateKey:`b4:multipart:complete:${d.id}`,decision:'ALLOW',reason:'ALL_PART_RECEIPTS_CONFIRMED',policyVersion:c.destinationPolicyVersion,at:this.clock()});
    if(c.status==='APPROVED'){
      const all=state(s).deliveries.filter(x=>x.campaignId===c.id);
      if(all.length===c.previews.length&&all.every(x=>['SENT','CANCELLED','SKIPPED'].includes(x.status)))c.status='COMPLETED';
    }
  }
  if(c.status==='CANCELLED')settleCancelledMultipart(d);
 }
 async dispatchNext(campaignId:string,resourceId:string):Promise<CampaignPartResult> {
  const claim=await this.store.transaction(s=>{
    const {campaign:c,delivery:d}=this.get(s,campaignId,resourceId);
    if(c.status==='CANCELLED')return {kind:'CANCELLED' as const};
    if(d.status==='SENT')return {kind:'EMPTY' as const};
    if(c.status!=='APPROVED'||d.status!=='MULTIPART'||!d.multipart||!this.authorized(s,c))return {kind:'BLOCKED' as const};
    const reviewed=c.previews.find(x=>x.resourceId===resourceId)?.renderPlan;
    if(reviewed && (reviewed.fingerprint!==d.multipart.fingerprint ||
      JSON.stringify(reviewed.parts)!==JSON.stringify(d.multipart.parts.map(x=>x.payload))))return {kind:'BLOCKED' as const};
    const firstPending=c.previews.find(x=> {
      const delivery=state(s).deliveries.find(d=>d.campaignId===c.id&&d.resourceId===x.resourceId);
      return !delivery||!['SENT','CANCELLED','SKIPPED'].includes(delivery.status);
    });
    if(firstPending?.resourceId!==resourceId)return {kind:'BLOCKED' as const};
    if(c.scheduledAt>this.clock())return {kind:'NOT_DUE' as const};
    const p=d.multipart.parts.find(x=>x.status!=='SENT');
    if(!p)return {kind:'EMPTY' as const};
    if(p.status!=='QUEUED')return {kind:'BLOCKED' as const};
    p.status='SENDING';p.attemptId=randomUUID();p.leaseUntil=nextDispatchLease(this.clock());
    s.audit.push({updateKey:`b4:part:attempt:${d.id}:${p.index}:${p.attemptId}`,decision:'ALLOW',
      reason:'PART_ATTEMPT_RECORDED_BEFORE_SEND',policyVersion:c.destinationPolicyVersion,at:this.clock()});
    return {kind:'SEND' as const,index:p.index,attemptId:p.attemptId,destination:c.destination,payload:clone(p.payload),deliveryId:d.id};
  });
  if(claim.kind!=='SEND')return {status:claim.kind};
  let allowed=false;
  try{allowed=(await this.gateway.canPost(claim.destination))===true;}catch{/* fail closed */}
  const current=await this.store.transaction(s=>{
    const {campaign:c,delivery:d}=this.get(s,campaignId,resourceId);
    const p=d.multipart?.parts[claim.index];
    if(!p||p.attemptId!==claim.attemptId||p.status!=='SENDING')return false;
    if(leaseExpired(p.leaseUntil,this.clock())) {
      p.status='UNKNOWN_OUTCOME';
      return false; // old worker must never reach the gateway after its lease expires
    }
    if(allowed&&d.id===claim.deliveryId&&d.status==='MULTIPART'&&c.status==='APPROVED'&&this.authorized(s,c))return true;
    if(c.status==='CANCELLED'){
      p.status='CANCELLED';
      settleCancelledMultipart(d);
      return false;
    }
    p.status='QUEUED';delete p.attemptId;delete p.leaseUntil;return false;
  });
  if(!current)return {status:'BLOCKED'};
  let outcome:CampaignPartOutcome;
  try{outcome=await this.gateway.sendPart({destination:claim.destination,index:claim.index,attemptId:claim.attemptId,part:claim.payload});}
  catch{outcome={status:'UNKNOWN_OUTCOME'};}
  return this.store.transaction(s=>{
    const {campaign:c,delivery:d}=this.get(s,campaignId,resourceId);
    const part=d.multipart?.parts[claim.index];
    if(!part||part.status!=='SENDING'||part.attemptId!==claim.attemptId)return {status:'BLOCKED' as const};
    if(outcome.status==='SENT'&&isSafeId(outcome.messageId)&&
      !state(s).deliveries.some(x=>x.destination===claim.destination &&
       (x.messageId===outcome.messageId||x.multipart?.parts.some(y=>y!==part&&y.messageId===outcome.messageId))) &&
       !s.historicalPublications.some(h=>h.destination===claim.destination&&h.proof?.messageId===outcome.messageId)){
      part.status='SENT';part.messageId=outcome.messageId;
      this.markComplete(s,c,d);
      return {status:'SENT' as const,index:part.index,messageId:outcome.messageId};
    }
    part.status=outcome.status==='FAILED_CONFIRMED'
      ? (c.status==='CANCELLED'?'CANCELLED':'FAILED_CONFIRMED')
      : 'UNKNOWN_OUTCOME';
    if(c.status==='CANCELLED')settleCancelledMultipart(d);
    return {status:part.status,index:part.index};
  });
 }
 async retryFailed(actor:string,campaignId:string,resourceId:string,index:number):Promise<void> {
  await this.store.transaction(s=>{
    const {campaign:c,delivery:d}=this.get(s,campaignId,resourceId);
    if(!this.authorized(s,c)||!this.policy.has(s,actor,'content.publish',c.destination,this.clock())||
       !this.policy.has(s,actor,'content.publish',c.sourceScope,this.clock()))throw new Error('PUBLISH_DENIED');
    const p=d.multipart?.parts[index];
    if(c.status!=='APPROVED'||d.status!=='MULTIPART'||p?.status!=='FAILED_CONFIRMED')throw new Error('NOT_CONFIRMED_FAILED');
    p.status='QUEUED';delete p.attemptId;
  });
 }
 async reconcileUnknown(actor:string,campaignId:string,resourceId:string,index:number,receipt:CampaignPartReceipt):Promise<CampaignPart> {
  const before=await this.store.snapshot();
  const {campaign:c,delivery:d}=this.get(before,campaignId,resourceId);
  const p=d.multipart?.parts[index];
  if(!this.authorized(before,c)||!this.policy.has(before,actor,'content.publish',c.destination,this.clock())||
     !this.policy.has(before,actor,'content.publish',c.sourceScope,this.clock()))throw new Error('PUBLISH_DENIED');
  if(p?.status!=='UNKNOWN_OUTCOME'||!isSafeId(receipt.messageId)||p.attemptId!==receipt.attemptId||d.destination!==receipt.destination)throw new Error('RECEIPT_INVALID');
  if(!await this.gateway.verifyReceipt(receipt))throw new Error('RECEIPT_INVALID');
  return this.store.transaction(s=>{
    const {campaign:currentC,delivery:currentD}=this.get(s,campaignId,resourceId);
    const current=currentD.multipart?.parts[index];
    if(!this.authorized(s,currentC)||!this.policy.has(s,actor,'content.publish',currentC.destination,this.clock())||
       !this.policy.has(s,actor,'content.publish',currentC.sourceScope,this.clock()))throw new Error('PUBLISH_DENIED');
    if(!current||current.status!=='UNKNOWN_OUTCOME'||current.attemptId!==receipt.attemptId||currentD.destination!==receipt.destination||
      (state(s).deliveries.some(x=>x.destination===receipt.destination&&(x.messageId===receipt.messageId||x.multipart?.parts.some(y=>y.messageId===receipt.messageId))) ||
      s.historicalPublications.some(h=>h.destination===receipt.destination&&h.proof?.messageId===receipt.messageId)))throw new Error('RECEIPT_INVALID');
    current.status='SENT';current.messageId=receipt.messageId;this.markComplete(s,currentC,currentD);return clone(current);
  });
 }
}
