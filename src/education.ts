import { randomUUID } from 'node:crypto';
import { BotStore, type BotState, type EducationCategory, type EducationResource, type ImportRun } from './store.js';
import { Policy } from './policy.js';
import { parseDocument, type ImportFormat } from './ingestion.js';
import { planPublicationPreview } from './publication-preview-plan.js';
import {resourceArchiveFingerprint} from './education-archive.js';
import {categoryVisibilityFingerprint} from './education-category-policy.js';

type Origin = 'TELEGRAM_ADMIN' | 'ADMIN_WEB';
/** Public resource projections must not reveal internal audit identities or import job IDs. */
export type PublicEducationResource = Pick<EducationResource,'id'|'categoryId'|'scope'|'title'|'university'|'cycle'|'degree'|'seats'>;
export function publicEducationResource(r:EducationResource):PublicEducationResource {
  const {id,categoryId,scope,title,university,cycle,degree,seats}=r;
  return {id,categoryId,scope,title,university,cycle,degree,seats};
}
const goodId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);

/** B3 core is intentionally simulated. Telegram and web upload adapters are not connected. */
export class EducationService {
  constructor(private readonly store: BotStore, private readonly policy: Policy, private readonly clock: () => number = Date.now) {}
  private scopeReady(s: BotState, scope: string): boolean {
    return scope === 'private' ? true : this.policy.canUseChat(s,scope,'navigation');
  }
  private canBrowse(s: BotState, actor: string, scope: string): boolean {
    return Boolean(actor) && (scope === 'private'
      ? this.policy.privateFeature(s,'education.navigate',actor)
      : this.policy.canUseChat(s,scope,'navigation'));
  }
  private canUpload(s: BotState, actor: string, scope: string): boolean {
    return this.scopeReady(s,scope) && (scope === 'private'
      ? this.policy.privateFeature(s,'content.upload',actor)
      : this.policy.has(s,actor,'content.upload',scope,this.clock()));
  }
  private canPublish(s: BotState, actor: string, scope: string): boolean {
    return this.scopeReady(s,scope) && this.policy.has(s,actor,'content.publish',scope,this.clock());
  }
  private assertOwner(actor: string): void { if (!this.policy.isOwner(actor)) throw new Error('OWNER_ONLY'); }
  private visibleCategory(s: BotState, cat: EducationCategory): boolean {
    if (!cat.enabled) return false;
    if (!cat.parentId) return true;
    const parent=s.educationCategories.find(x=>x.id===cat.parentId && x.scope===cat.scope);
    return Boolean(parent && this.visibleCategory(s,parent));
  }
  async createCategory(actor: string, input: {id: string; scope: string; title: string; order: number; parentId?: string}): Promise<EducationCategory> {
    this.assertOwner(actor);
    if (!goodId(input.id) || !input.title.trim() || input.title.length>100 || !Number.isSafeInteger(input.order)) throw new Error('INVALID_CATEGORY');
    return this.store.transaction(s=>{
      if (!this.scopeReady(s,input.scope)) throw new Error('SCOPE_DENIED');
      if(s.educationCategories.some(c=>c.id===input.id)) throw new Error('CATEGORY_EXISTS');
      if(input.parentId && !s.educationCategories.some(c=>c.id===input.parentId && c.scope===input.scope)) throw new Error('INVALID_PARENT');
      const category: EducationCategory={id:input.id,scope:input.scope,parentId:input.parentId??null,title:input.title.trim(),order:input.order,enabled:true};
      s.educationCategories.push(category); return category;
    });
  }
  async setCategoryEnabled(actor:string, id:string, enabled:boolean):Promise<void> {
    this.assertOwner(actor);
    await this.store.transaction(s=>{
      const cat=s.educationCategories.find(c=>c.id===id); if(!cat) throw new Error('CATEGORY_NOT_FOUND');
      cat.enabled=enabled;
      cat.revision=(cat.revision??0)+1;
    });
  }
  /** A private owner UI action must be independently authorized during the
   * write, bound to current category metadata/revision and to group epoch.
   * This may expand visible published resources on explicit enable, never
   * re-publishes archived resources or contacts Telegram channel providers.
   */
  async setCategoryEnabledIfCurrent(actor:string,id:string,enabled:boolean,
    proof:string,scopeRevision:number,categoryRevision:number):Promise<void>{
    this.assertOwner(actor);
    if(!goodId(id)||typeof enabled!=='boolean'||!/^~[a-f0-9]{16}$/u.test(proof)||
      !Number.isSafeInteger(scopeRevision)||scopeRevision<0||
      !Number.isSafeInteger(categoryRevision)||categoryRevision<0)
      throw Error('CATEGORY_VISIBILITY_STALE');
    await this.store.transaction(s=>{
      const cat=s.educationCategories.find(x=>x.id===id);
      if(!cat||!this.scopeReady(s,cat.scope))throw Error('CATEGORY_VISIBILITY_STALE');
      const currentEpoch=cat.scope==='private'?0:this.policy.chatRevision(s,cat.scope);
      if(currentEpoch!==scopeRevision||(cat.revision??0)!==categoryRevision||
         categoryVisibilityFingerprint(cat)!==proof||cat.enabled===enabled)
        throw Error('CATEGORY_VISIBILITY_STALE');
      if(enabled&&cat.parentId){
        const parent=s.educationCategories.find(x=>x.id===cat.parentId&&x.scope===cat.scope);
        if(!parent||!this.visibleCategory(s,parent))throw Error('CATEGORY_PARENT_DISABLED');
      }
      cat.enabled=enabled;
      cat.revision=categoryRevision+1;
      s.audit.push({updateKey:'b3:category-visibility:'+id+':'+cat.revision,
       decision:'ALLOW',reason:'CATEGORY_VISIBILITY_CHANGED',
       policyVersion:currentEpoch,at:this.clock()});
    });
  }
  async listCategories(viewer:string,scope:string):Promise<EducationCategory[]> {
    const s=await this.store.snapshot(); if(!this.canBrowse(s,viewer,scope)) return [];
    return s.educationCategories.filter(c=>c.scope===scope&&this.visibleCategory(s,c))
      .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
  }
  async submitText(actor:string,scope:string,origin:Origin,format:ImportFormat,filename:string,text:string):Promise<ImportRun> {
    const initial=await this.store.snapshot();
    if (!this.canUpload(initial,actor,scope)) throw new Error('UPLOAD_DENIED');
    if (!['TELEGRAM_ADMIN','ADMIN_WEB'].includes(origin)) throw new Error('INVALID_UPLOAD_ORIGIN');
    const parsed=parseDocument(format,filename,text); // input is never executed or fetched
    return this.store.transaction(s=>{
      if(!this.canUpload(s,actor,scope)) throw new Error('UPLOAD_DENIED');
      const duplicate=s.importRuns.find(r=>r.scope===scope && r.digest===parsed.digest);
      if(duplicate) return duplicate;
      const run:ImportRun={id:randomUUID(),scope,origin,format,filename,digest:parsed.digest,report:parsed.report,
        candidates:parsed.candidates,uploadedBy:actor,createdAt:this.clock()};
      s.importRuns.push(run);return run;
    });
  }
  async approveCandidate(actor:string,importId:string,index:number,categoryId:string):Promise<void> {
    await this.store.transaction(s=>{
      const run=s.importRuns.find(r=>r.id===importId); if(!run) throw new Error('IMPORT_NOT_FOUND');
      if(!this.canPublish(s,actor,run.scope)) throw new Error('PUBLISH_DENIED');
      const category=s.educationCategories.find(c=>c.id===categoryId && c.scope===run.scope);
      if(!category) throw new Error('CATEGORY_SCOPE_MISMATCH');
      // The approval transaction itself must enforce category visibility,
      // not only a preflight UI read: a revoked/disabled category cannot gain
      // a newly approved candidate from a delayed or forged action.
      if(!this.visibleCategory(s,category))throw new Error('CATEGORY_DISABLED_OR_MISSING');
      const candidate=Number.isSafeInteger(index) ? run.candidates[index] : undefined;
      if(!candidate) throw new Error('CANDIDATE_NOT_FOUND');
      if(candidate.status==='NEEDS_REVIEW') throw new Error('NEEDS_REVIEW');
      if(candidate.status==='DUPLICATE') throw new Error('DUPLICATE_CANDIDATE');
      if(candidate.status==='APPROVED') {
        if(candidate.categoryId!==categoryId) throw new Error('APPROVAL_CATEGORY_CONFLICT');
        return;
      }
      candidate.status='APPROVED'; candidate.approvedBy=actor; candidate.categoryId=categoryId;
      s.audit.push({updateKey:`b3:approve:${importId}:${index}`,decision:'ALLOW',reason:'CONTENT_APPROVED',policyVersion:0,at:this.clock()});
    });
  }
  async publishCandidate(actor:string,importId:string,index:number,categoryId:string):Promise<EducationResource> {
    return this.store.transaction(s=>{
      const run=s.importRuns.find(r=>r.id===importId); if(!run) throw new Error('IMPORT_NOT_FOUND');
      if(!this.canPublish(s,actor,run.scope)) throw new Error('PUBLISH_DENIED');
      const candidate=Number.isSafeInteger(index) ? run.candidates[index] : undefined;
      if(!candidate || candidate.status!=='APPROVED' || candidate.categoryId!==categoryId) throw new Error('NOT_APPROVED');
      const category=s.educationCategories.find(c=>c.id===categoryId && c.scope===run.scope);
      if(!category || !this.visibleCategory(s,category)) throw new Error('CATEGORY_DISABLED_OR_MISSING');
      const existing=s.educationResources.find(r=>r.sourceImportId===importId && r.sourceLocator===candidate.locator);
      if(existing) {
        if(existing.status==='ARCHIVED') throw new Error('RESOURCE_ARCHIVED');
        return existing;
      }
      const resource:EducationResource={id:randomUUID(),categoryId,scope:run.scope,title:candidate.title,
        university:candidate.university,cycle:candidate.cycle,degree:candidate.degree,seats:candidate.seats,
        sourceImportId:importId,sourceLocator:candidate.locator,reviewedBy:candidate.approvedBy!,status:'PUBLISHED'};
      s.educationResources.push(resource);
      s.audit.push({updateKey:`b3:publish:${importId}:${index}`,decision:'ALLOW',reason:'RESOURCE_PUBLISHED_LOCALLY',policyVersion:0,at:this.clock()});
      return resource;
    });
  }
  /**
   * Explicitly reviewed long-form publication copy for an already published education resource.
   * Never originates from an unreviewed upload; changing it invalidates existing campaign previews.
   */
  async setPublicationText(actor:string,id:string,text:string):Promise<void> {
    const plan=planPublicationPreview({text}); // fail before any storage write
    if(plan.kind!=='TEXT')throw new Error('INVALID_PUBLICATION_PLAN');
    await this.store.transaction(s=>{
      const resource=s.educationResources.find(r=>r.id===id);
      if(!resource)throw new Error('RESOURCE_NOT_FOUND');
      if(!this.canPublish(s,actor,resource.scope))throw new Error('PUBLISH_DENIED');
      const category=s.educationCategories.find(c=>c.id===resource.categoryId&&c.scope===resource.scope);
      if(resource.status!=='PUBLISHED'||!category||!this.visibleCategory(s,category))throw new Error('RESOURCE_NOT_PUBLISHED_OR_DISABLED');
      resource.publicationText=text.trim();
      resource.publicationTextReviewedBy=actor;
      s.audit.push({updateKey:`b4:review-text:${id}:${this.clock()}`,decision:'ALLOW',
        reason:'PUBLICATION_COPY_REVIEWED',policyVersion:this.policy.chatRevision(s,resource.scope),at:this.clock()});
    });
  }
  async listResources(viewer:string,scope:string,categoryId:string):Promise<PublicEducationResource[]> {
    const s=await this.store.snapshot(); if(!this.canBrowse(s,viewer,scope)) return [];
    const category=s.educationCategories.find(c=>c.id===categoryId && c.scope===scope);
    if(!category || !this.visibleCategory(s,category)) return [];
    return s.educationResources.filter(r=>r.scope===scope&&r.categoryId===categoryId&&r.status==='PUBLISHED').map(publicEducationResource);
  }
  /** Search the currently visible, published, private student library only.
   * One immutable snapshot provides a consistent scoped result. Group/channel
   * content is deliberately excluded: its subscription gate is independent.
   * Return the existing public projection, never import or reviewer metadata.
   */
  async searchPublishedResources(viewer:string,query:string):Promise<PublicEducationResource[]>{
    if(typeof query!=='string'||Array.from(query).length<2||Array.from(query).length>32)
      return [];
    const s=await this.store.snapshot();
    if(!this.canBrowse(s,viewer,'private'))return [];
    const visible=new Set(s.educationCategories
      .filter(c=>c.scope==='private'&&this.visibleCategory(s,c)).map(c=>c.id));
    const fold=(text:string)=>text.normalize('NFKC').toLowerCase()
      .replace(/\s+/gu,' ').trim();
    const needle=fold(query);
    if(!needle)return [];
    return s.educationResources.filter(r=>
      r.scope==='private'&&r.status==='PUBLISHED'&&visible.has(r.categoryId)&&
      [r.title,r.university,r.cycle,r.degree].some(v=>fold(v).includes(needle)))
      .sort((a,b)=>a.title.localeCompare(b.title,'ar')||a.id.localeCompare(b.id))
      .map(publicEducationResource);
  }
  /** Archive only the resource the owner just reviewed, not an outdated item
   * with matching ID. Recheck group authorization epoch and the exact reviewed
   * publication fingerprint atomically in the durable BotStore transaction.
   * This changes only the LOCAL library status; it does not edit/send Telegram.
   */
  async archiveResourceIfCurrent(actor:string,id:string,proof:string,scopeRevision:number):Promise<void>{
    this.assertOwner(actor);
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)||
      !/^~[a-f0-9]{16}$/u.test(proof)||
      !Number.isSafeInteger(scopeRevision)||scopeRevision<0)
      throw Error('RESOURCE_ARCHIVE_STALE');
    await this.store.transaction(s=>{
      const resource=s.educationResources.find(r=>r.id===id);
      if(!resource||resource.status!=='PUBLISHED'||!this.canPublish(s,actor,resource.scope))
       throw Error('RESOURCE_ARCHIVE_STALE');
      const currentRevision=resource.scope==='private'?0:this.policy.chatRevision(s,resource.scope);
      if(currentRevision!==scopeRevision||resourceArchiveFingerprint(resource)!==proof)
       throw Error('RESOURCE_ARCHIVE_STALE');
      resource.status='ARCHIVED';
      s.audit.push({updateKey:'b3:archive:'+id,decision:'ALLOW',
       reason:'RESOURCE_ARCHIVED',policyVersion:currentRevision,at:this.clock()});
    });
  }
  async archiveResource(actor:string,id:string):Promise<void> {
    await this.store.transaction(s=>{
      const resource=s.educationResources.find(r=>r.id===id); if(!resource) throw new Error('RESOURCE_NOT_FOUND');
      if(!this.canPublish(s,actor,resource.scope)) throw new Error('PUBLISH_DENIED');
      resource.status='ARCHIVED';
      s.audit.push({updateKey:`b3:archive:${id}`,decision:'ALLOW',reason:'RESOURCE_ARCHIVED',policyVersion:0,at:this.clock()});
    });
  }
}
