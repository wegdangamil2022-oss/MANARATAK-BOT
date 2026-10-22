import {createHash,randomUUID} from 'node:crypto';
import type {PlatformReviewQueueEntry,EducationResource,BotState,EducationCategory} from './store.js';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {resourceArchiveFingerprint} from './education-archive.js';

/** B5's proposed read-only adapter boundary. An independently reviewed
 * adapter may later map a real platform API into this contract. It MUST be
 * configured and authenticated separately: this package does not invent
 * routes, credentials, tokens, or a production endpoint.
 */
export interface PlatformCatalogReader{
 fetchPage(query:Readonly<{scope:'private';limit:number;cursor:string|null}>):Promise<unknown>;
}
export interface PlatformReviewCandidate{
 id:string;revision:number;title:string;university:string;cycle:string;
 degree:string;reviewState:'UNVERIFIED_EXTERNAL';
}
export type PlatformCatalogPreviewResult=
 |{status:'DENIED'|'UNAVAILABLE'}
 |{status:'PREVIEW';records:PlatformReviewCandidate[];nextCursor:string|null;fingerprint:string};

const validId=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const validCursor=/^[A-Za-z0-9_-]{1,64}$/u;
const controls=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const isObject=(value:unknown):value is Record<string,unknown>=>
 Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function exactKeys(value:Record<string,unknown>,expected:readonly string[]):boolean{
 return Object.keys(value).length===expected.length&&
  expected.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}
const boundedText=(value:unknown,max:number):value is string=>
 typeof value==='string'&&value.length>=1&&value.length<=max&&
 value.trim()===value&&value.length>0&&!controls.test(value);
function parsePage(raw:unknown,limit:number,cursor:string|null):
 {records:PlatformReviewCandidate[];nextCursor:string|null}|null{
 if(!isObject(raw)||!exactKeys(raw,['schema','records','nextCursor'])||
   raw.schema!=='manaratak-readonly-catalog-v1'||
   !Array.isArray(raw.records)||raw.records.length>limit||
   !(raw.nextCursor===null||typeof raw.nextCursor==='string'&&
     validCursor.test(raw.nextCursor)&&raw.nextCursor!==cursor))return null;
 const result:PlatformReviewCandidate[]=[];
 const seen=new Set<string>();
 for(const item of raw.records){
  if(!isObject(item)||
    !exactKeys(item,['id','revision','scope','publication','title','university','cycle','degree'])||
    typeof item.id!=='string'||!validId.test(item.id)||
    seen.has(item.id)||typeof item.revision!=='number'||
    !Number.isSafeInteger(item.revision)||item.revision<1||
    item.scope!=='private'||item.publication!=='PUBLISHED'||
    !boundedText(item.title,160)||!boundedText(item.university,120)||
    !boundedText(item.cycle,32)||!boundedText(item.degree,64))return null;
  seen.add(item.id);
  result.push({
   id:item.id,revision:item.revision as number,title:item.title,
   university:item.university,cycle:item.cycle,degree:item.degree,
   reviewState:'UNVERIFIED_EXTERNAL'
  });
 }
 return {records:result,nextCursor:raw.nextCursor as string|null};
}

export type PlatformStageResult=
 |{status:'DENIED'|'STALE'|'UNAVAILABLE'|'LIMIT_REACHED'}
 |{status:'STAGED';entry:PlatformReviewQueueEntry};
export type PlatformReviewResult=
 |{status:'DENIED'|'STALE'|'UNAVAILABLE'}
 |{status:'REVIEWED';entry:PlatformReviewQueueEntry};
export type PlatformApproveResult=
 |{status:'DENIED'|'STALE'|'UNAVAILABLE'}
 |{status:'APPROVED';entry:PlatformReviewQueueEntry};
export type PlatformLocalPublishResult=
 |{status:'DENIED'|'STALE'|'UNAVAILABLE'}
 |{status:'PUBLISHED';resource:EducationResource};
/** Advisory owner-only read of a published local copy. A missing cursor-page
 * record is NOT evidence that a scholarship has been withdrawn or closed.
 */
export type PlatformLocalArchiveResult=
 |{status:'DENIED'|'STALE'|'UNAVAILABLE'}
 |{status:'ARCHIVED';resourceId:string};
export type PlatformPublishedIntegrityResult=
 |{status:'DENIED'|'STALE'|'UNAVAILABLE'|'SOURCE_CHANGED'|
    'NOT_ON_PAGE'|'LOCAL_ARCHIVED'|'LOCAL_INCONSISTENT'}
 |{status:'CURRENT';sourceId:string;resourceId:string};

/** A category's entire private parent chain must remain visible. Fail closed
 * on missing/cyclic parents, including old or malicious stored state.
 */
function activePrivateCategory(state:BotState,id:string):EducationCategory|null{
 const visited=new Set<string>();let current=id;
 while(current){
  if(visited.has(current))return null;
  visited.add(current);
  const cat=state.educationCategories.find(c=>c.id===current&&c.scope==='private');
  if(!cat||!cat.enabled)return null;
  if(!cat.parentId)return state.educationCategories.find(c=>c.id===id&&c.scope==='private')??null;
  current=cat.parentId;
 }
 return null;
}
export const PLATFORM_IMPORT_SOURCE='b5-external-catalog-v1';
const strictDigest=/^[a-f0-9]{64}$/u;
export function platformCandidateDigest(record:PlatformReviewCandidate):string{
 return createHash('sha256').update(JSON.stringify([
  'b5-candidate-v1',record.id,record.revision,record.title,record.university,
  record.cycle,record.degree
 ]),'utf8').digest('hex');
}
/** Owner-only, ephemeral external candidate preview. Never writes BotStore,
 * never publishes locally, never changes Telegram buttons, never sends to
 * channels or makes network requests by itself. Platform self-reported
 * 'PUBLISHED' is still NOT a locally reviewed publication approval.
 */
export class PlatformCatalogPreviewService{
 constructor(
  private readonly store:BotStore,
  private readonly policy:Policy,
  private readonly reader:PlatformCatalogReader
 ){}
 async preview(actor:string,request:Readonly<{limit?:number;cursor?:string|null}>={}):
  Promise<PlatformCatalogPreviewResult>{
  if(!this.policy.isOwner(actor))return {status:'DENIED'};
  if(!isObject(request)||Object.keys(request).some(k=>k!=='limit'&&k!=='cursor'))
   return {status:'UNAVAILABLE'};
  const limit=request.limit??10,cursor=request.cursor??null;
  if(!Number.isSafeInteger(limit)||limit<1||limit>10||
    cursor!==null&&(typeof cursor!=='string'||!validCursor.test(cursor)))
   return {status:'UNAVAILABLE'};
  const ownerDashboardActive=async():Promise<boolean>=>{
   const state=await this.store.snapshot();
   return this.policy.privateFeature(state,'owner.dashboard',actor);
  };
  try{
   if(!await ownerDashboardActive())return {status:'DENIED'};
  }catch{return {status:'UNAVAILABLE'};}
  let raw:unknown;
  try{raw=await this.reader.fetchPage({scope:'private',limit,cursor});}
  catch{return {status:'UNAVAILABLE'};}
  // Re-check after external work; a disabled owner dashboard must invalidate
  // the stale response rather than exposing third-party candidate content.
  try{
   if(!await ownerDashboardActive())return {status:'DENIED'};
  }catch{return {status:'UNAVAILABLE'};}
  let parsed:ReturnType<typeof parsePage>=null;
  try{parsed=parsePage(raw,limit,cursor);}
  catch{return {status:'UNAVAILABLE'};}
  if(!parsed)return {status:'UNAVAILABLE'};
  const fingerprint=createHash('sha256').update(JSON.stringify({
   schema:'manaratak-readonly-catalog-v1',scope:'private',limit,cursor,
   records:parsed.records,nextCursor:parsed.nextCursor
  }),'utf8').digest('hex');
  return {status:'PREVIEW',records:parsed.records,
   nextCursor:parsed.nextCursor,fingerprint};
 }
  /**
   * Owner explicitly stages *one* candidate from the current full-page
   * fingerprint. No values supplied by the caller are persisted: every field
   * comes from a fresh, schema-validated read-only source projection.
   * Conflicting revisions cannot silently overwrite an existing review.
   */
  async stage(actor:string,sourceId:string,expectedPageFingerprint:string,
   request:Readonly<{cursor?:string|null}>={}):
   Promise<PlatformStageResult>{
   if(!this.policy.isOwner(actor))return {status:'DENIED'};
   if(typeof sourceId!=='string'||!validId.test(sourceId)||
     typeof expectedPageFingerprint!=='string'||!strictDigest.test(expectedPageFingerprint))
    return {status:'UNAVAILABLE'};
   const cursor=request.cursor??null;
   const preview=await this.preview(actor,{cursor});
   if(preview.status!=='PREVIEW')return preview;
   if(preview.fingerprint!==expectedPageFingerprint)return {status:'STALE'};
   const records=preview.records.filter(c=>c.id===sourceId);
   if(records.length!==1)return {status:'STALE'};
   const candidate=records[0]!;
   const digest=platformCandidateDigest(candidate);
   try{
    return await this.store.transaction<PlatformStageResult>(s=>{
     if(!this.policy.privateFeature(s,'owner.dashboard',actor))return {status:'DENIED'};
     const queue=s.platformReviewQueue??(s.platformReviewQueue=[]);
     const existing=queue.find(x=>x.sourceId===sourceId);
     if(existing){
      if(existing.digest!==digest||existing.sourceRevision!==candidate.revision)
       return {status:'STALE'};
      return {status:'STAGED',entry:structuredClone(existing)};
     }
     if(queue.length>=200)return {status:'LIMIT_REACHED'};
     const entry:PlatformReviewQueueEntry={
      sourceId,...(cursor?{pageCursor:cursor}:{}),
      sourceRevision:candidate.revision,title:candidate.title,
      university:candidate.university,cycle:candidate.cycle,
      degree:candidate.degree,digest,status:'UNVERIFIED_EXTERNAL',
      stagedBy:actor,stagedAt:Date.now()
     };
     queue.push(entry);
     s.audit.push({updateKey:'b5:stage:'+sourceId+':'+digest.slice(0,16),
      decision:'ALLOW',reason:'EXTERNAL_CANDIDATE_STAGED_ONLY',policyVersion:0,at:entry.stagedAt});
     return {status:'STAGED',entry:structuredClone(entry)};
    });
   }catch{return {status:'UNAVAILABLE'};}
  }
  /**
   * 'Reviewed' means metadata was manually checked against a fresh external
   * read. It is NEVER a publication or local B3 import approval. A different
   * revision/title/university/cycle/degree invalidates the old digest.
   */
  async review(actor:string,sourceId:string,expectedDigest:string):
   Promise<PlatformReviewResult>{
   if(!this.policy.isOwner(actor))return {status:'DENIED'};
   if(typeof sourceId!=='string'||!validId.test(sourceId)||
     typeof expectedDigest!=='string'||!strictDigest.test(expectedDigest))
    return {status:'UNAVAILABLE'};
   let previouslyStaged:PlatformReviewQueueEntry|undefined;
   try{
    const state=await this.store.snapshot();
    if(!this.policy.privateFeature(state,'owner.dashboard',actor))return {status:'DENIED'};
    previouslyStaged=state.platformReviewQueue?.find(x=>x.sourceId===sourceId);
   }catch{return {status:'UNAVAILABLE'};}
   if(!previouslyStaged||previouslyStaged.digest!==expectedDigest)return {status:'STALE'};
   const preview=await this.preview(actor,{cursor:previouslyStaged.pageCursor??null});
   if(preview.status!=='PREVIEW')return preview;
   const candidates=preview.records.filter(c=>c.id===sourceId);
   if(candidates.length!==1||
     platformCandidateDigest(candidates[0]!)!==expectedDigest)return {status:'STALE'};
   try{
    return await this.store.transaction<PlatformReviewResult>(s=>{
     if(!this.policy.privateFeature(s,'owner.dashboard',actor))return {status:'DENIED'};
     const current=s.platformReviewQueue?.find(x=>x.sourceId===sourceId);
     if(!current||current.digest!==expectedDigest)return {status:'STALE'};
     if(current.status==='REVIEWED_METADATA_ONLY')
      return {status:'REVIEWED',entry:structuredClone(current)};
     if(current.status!=='UNVERIFIED_EXTERNAL')return {status:'STALE'};
     current.status='REVIEWED_METADATA_ONLY';
     current.reviewedBy=actor;current.reviewedAt=Date.now();
     s.audit.push({updateKey:'b5:review:'+sourceId+':'+expectedDigest.slice(0,16),
      decision:'ALLOW',reason:'EXTERNAL_METADATA_REVIEW_ONLY',
      policyVersion:0,at:current.reviewedAt});
     return {status:'REVIEWED',entry:structuredClone(current)};
    });
   }catch{return {status:'UNAVAILABLE'};}
  }

  /** Local owner approval is a *different action* from source metadata review.
   * No item becomes visible until a separate publishLocally call succeeds.
   * Category and owner permissions are checked inside the atomic transaction.
   */
  async approveForLocal(actor:string,sourceId:string,expectedDigest:string,
   categoryId:string):Promise<PlatformApproveResult>{
   if(!this.policy.isOwner(actor))return {status:'DENIED'};
   if(typeof sourceId!=='string'||!validId.test(sourceId)||
      typeof expectedDigest!=='string'||!strictDigest.test(expectedDigest)||
      typeof categoryId!=='string'||!validId.test(categoryId))
     return {status:'UNAVAILABLE'};
   const before=await this.store.snapshot();
   if(!this.policy.privateFeature(before,'owner.dashboard',actor))return {status:'DENIED'};
   const entry=before.platformReviewQueue?.find(e=>e.sourceId===sourceId);
   if(!entry||entry.digest!==expectedDigest||
     !['REVIEWED_METADATA_ONLY','APPROVED_FOR_LOCAL'].includes(entry.status))
     return {status:'STALE'};
   const fresh=await this.preview(actor,{cursor:entry.pageCursor??null});
   if(fresh.status!=='PREVIEW')return fresh;
   const match=fresh.records.filter(c=>c.id===sourceId);
   if(match.length!==1||platformCandidateDigest(match[0]!)!==expectedDigest)
     return {status:'STALE'};
   try{
    return await this.store.transaction<PlatformApproveResult>(s=>{
     if(!this.policy.privateFeature(s,'owner.dashboard',actor)||
       !this.policy.has(s,actor,'content.publish','private'))
       return {status:'DENIED'};
     if(!activePrivateCategory(s,categoryId))return {status:'STALE'};
     const current=s.platformReviewQueue?.find(x=>x.sourceId===sourceId);
     if(!current||current.digest!==expectedDigest||
       (current.status!=='REVIEWED_METADATA_ONLY'&&current.status!=='APPROVED_FOR_LOCAL'))
       return {status:'STALE'};
     if(current.status==='APPROVED_FOR_LOCAL'){
      return current.approvedCategoryId===categoryId
       ?{status:'APPROVED',entry:structuredClone(current)}:{status:'STALE'};
     }
     current.status='APPROVED_FOR_LOCAL';
     current.approvedCategoryId=categoryId;current.approvedBy=actor;
     current.approvedAt=Date.now();
     s.audit.push({updateKey:'b5:approve-local:'+sourceId+':'+expectedDigest.slice(0,16),
       decision:'ALLOW',reason:'EXTERNAL_METADATA_APPROVED_FOR_LOCAL_ONLY',
       policyVersion:0,at:current.approvedAt});
     return {status:'APPROVED',entry:structuredClone(current)};
    });
   }catch{return {status:'UNAVAILABLE'};}
  }
  /**
   * Distinct, explicit owner action publishes to the bot's LOCAL private
   * library, never to a Telegram channel. A fresh trusted provider snapshot
   * is required again; metadata cannot be pulled from an arbitrary message.
   * An archived previously published resource is never resurrected.
   */
  async publishLocally(actor:string,sourceId:string,expectedDigest:string,
   categoryId:string):Promise<PlatformLocalPublishResult>{
   if(!this.policy.isOwner(actor))return {status:'DENIED'};
   if(typeof sourceId!=='string'||!validId.test(sourceId)||
     typeof expectedDigest!=='string'||!strictDigest.test(expectedDigest)||
     typeof categoryId!=='string'||!validId.test(categoryId))
    return {status:'UNAVAILABLE'};
   const before=await this.store.snapshot();
   if(!this.policy.privateFeature(before,'owner.dashboard',actor))return {status:'DENIED'};
   const entry=before.platformReviewQueue?.find(x=>x.sourceId===sourceId);
   if(!entry||entry.digest!==expectedDigest||entry.approvedCategoryId!==categoryId||
      !['APPROVED_FOR_LOCAL','PUBLISHED_LOCALLY'].includes(entry.status))
    return {status:'STALE'};
   const fresh=await this.preview(actor,{cursor:entry.pageCursor??null});
   if(fresh.status!=='PREVIEW')return fresh;
   const match=fresh.records.filter(c=>c.id===sourceId);
   if(match.length!==1||platformCandidateDigest(match[0]!)!==expectedDigest)
    return {status:'STALE'};
   try{
    return await this.store.transaction<PlatformLocalPublishResult>(s=>{
     if(!this.policy.privateFeature(s,'owner.dashboard',actor)||
       !this.policy.has(s,actor,'content.publish','private'))return {status:'DENIED'};
     if(!activePrivateCategory(s,categoryId))return {status:'STALE'};
     const current=s.platformReviewQueue?.find(x=>x.sourceId===sourceId);
     if(!current||current.digest!==expectedDigest||
       current.approvedCategoryId!==categoryId||
       (current.status!=='APPROVED_FOR_LOCAL'&&current.status!=='PUBLISHED_LOCALLY'))
      return {status:'STALE'};
     const matches=s.educationResources.filter(r=>
       r.scope==='private'&&r.sourceImportId===PLATFORM_IMPORT_SOURCE&&r.sourceLocator===sourceId);
     if(matches.length>1||matches.some(x=>x.status!=='PUBLISHED'))return {status:'STALE'};
     if(matches.length===1){
      const existing=matches[0]!;
      if(current.status!=='PUBLISHED_LOCALLY'||
        current.publishedResourceId!==existing.id||
        existing.categoryId!==categoryId||existing.title!==current.title||
        existing.university!==current.university||existing.cycle!==current.cycle||
        existing.degree!==current.degree)return {status:'STALE'};
      return {status:'PUBLISHED',resource:structuredClone(existing)};
     }
     if(current.status!=='APPROVED_FOR_LOCAL')return {status:'STALE'};
     const resource:EducationResource={
      id:randomUUID(),categoryId,scope:'private',title:current.title,
      university:current.university,cycle:current.cycle,degree:current.degree,seats:null,
      sourceImportId:PLATFORM_IMPORT_SOURCE,sourceLocator:sourceId,
      reviewedBy:actor,status:'PUBLISHED'
     };
     s.educationResources.push(resource);
     current.status='PUBLISHED_LOCALLY';current.publishedResourceId=resource.id;
     s.audit.push({updateKey:'b5:publish-local:'+sourceId+':'+resource.id,
       decision:'ALLOW',reason:'EXTERNAL_REVIEWED_RESOURCE_PUBLISHED_LOCALLY',
       policyVersion:0,at:Date.now()});
     return {status:'PUBLISHED',resource:structuredClone(resource)};
    });
   }catch{return {status:'UNAVAILABLE'};}
  }

  /**
   * Read-only owner inspection of a previously locally published candidate.
   * This does NOT refresh, archive or republish resources. No unknown external
   * provider status is interpreted as proof that an application has closed.
   * The local association is revalidated after the awaited upstream read.
   */
  async inspectPublished(actor:string,sourceId:string,expectedDigest:string):
    Promise<PlatformPublishedIntegrityResult>{
    if(!this.policy.isOwner(actor))return {status:'DENIED'};
    if(typeof sourceId!=='string'||!validId.test(sourceId)||
       typeof expectedDigest!=='string'||!strictDigest.test(expectedDigest))
      return {status:'UNAVAILABLE'};
    const inspectLocal=(s:BotState):{
      status:'DENIED'|'STALE'|'LOCAL_ARCHIVED'|'LOCAL_INCONSISTENT'|'READY';
      entry?:PlatformReviewQueueEntry;resource?:EducationResource
    }=>{
      if(!this.policy.privateFeature(s,'owner.dashboard',actor))return {status:'DENIED'};
      const entry=s.platformReviewQueue?.find(q=>q.sourceId===sourceId);
      if(!entry||entry.digest!==expectedDigest||entry.status!=='PUBLISHED_LOCALLY'||
         !entry.publishedResourceId||!entry.approvedCategoryId)return {status:'STALE'};
      const related=s.educationResources.filter(r=>r.scope==='private'&&
       r.sourceImportId===PLATFORM_IMPORT_SOURCE&&r.sourceLocator===sourceId);
      if(related.length!==1)return {status:'LOCAL_INCONSISTENT'};
      const local=related[0]!;
      if(local.id!==entry.publishedResourceId||
        local.categoryId!==entry.approvedCategoryId||
        local.title!==entry.title||local.university!==entry.university||
        local.cycle!==entry.cycle||local.degree!==entry.degree||
        local.seats!==null)return {status:'LOCAL_INCONSISTENT'};
      if(local.status==='ARCHIVED')return {status:'LOCAL_ARCHIVED'};
      if(local.status!=='PUBLISHED')return {status:'LOCAL_INCONSISTENT'};
      return {status:'READY',entry,resource:local};
    };
    let before:ReturnType<typeof inspectLocal>;
    try{before=inspectLocal(await this.store.snapshot());}
    catch{return {status:'UNAVAILABLE'};}
    if(before.status!=='READY')return {status:before.status};
    const page=await this.preview(actor,{cursor:before.entry!.pageCursor??null});
    if(page.status!=='PREVIEW')return page;
    let after:ReturnType<typeof inspectLocal>;
    try{after=inspectLocal(await this.store.snapshot());}
    catch{return {status:'UNAVAILABLE'};}
    if(after.status!=='READY')return {status:after.status};
    // Fail closed on any concurrent local edit between snapshots.
    if(JSON.stringify(before.entry)!==JSON.stringify(after.entry)||
       JSON.stringify(before.resource)!==JSON.stringify(after.resource))
      return {status:'STALE'};
    const rows=page.records.filter(r=>r.id===sourceId);
    if(rows.length!==1)return {status:'NOT_ON_PAGE'};
    if(platformCandidateDigest(rows[0]!)!==expectedDigest)return {status:'SOURCE_CHANGED'};
    return {status:'CURRENT',sourceId,resourceId:after.resource!.id};
  }

  /**
   * A separate owner-confirmed LOCAL archival operation. The external source
   * is intentionally not consulted: changed/missing/offline pages are not
   * authority to archive, and an owner may archive an inaccurate local item
   * even if the provider is unreachable. A reviewed local resource fingerprint
   * is revalidated in the same transaction as the status mutation.
   */
  async archiveLocal(actor:string,sourceId:string,expectedDigest:string,
   resourceProof:string):Promise<PlatformLocalArchiveResult>{
   if(!this.policy.isOwner(actor))return {status:'DENIED'};
   if(typeof sourceId!=='string'||!validId.test(sourceId)||
     typeof expectedDigest!=='string'||!strictDigest.test(expectedDigest)||
     typeof resourceProof!=='string'||!/^~[a-f0-9]{16}$/u.test(resourceProof))
    return {status:'UNAVAILABLE'};
   try{
    return await this.store.transaction<PlatformLocalArchiveResult>(s=>{
     if(!this.policy.privateFeature(s,'owner.dashboard',actor)||
       !this.policy.has(s,actor,'content.publish','private'))
      return {status:'DENIED'};
     const entry=s.platformReviewQueue?.find(x=>x.sourceId===sourceId);
     if(!entry||entry.status!=='PUBLISHED_LOCALLY'||
       entry.digest!==expectedDigest||!entry.publishedResourceId||
       !entry.approvedCategoryId)return {status:'STALE'};
     const matches=s.educationResources.filter(x=>
      x.scope==='private'&&x.sourceImportId===PLATFORM_IMPORT_SOURCE&&
      x.sourceLocator===sourceId);
     if(matches.length!==1)return {status:'STALE'};
     const resource=matches[0]!;
     if(resource.id!==entry.publishedResourceId||
       resource.categoryId!==entry.approvedCategoryId||
       resource.title!==entry.title||resource.university!==entry.university||
       resource.cycle!==entry.cycle||resource.degree!==entry.degree||
       resource.seats!==null||resource.status!=='PUBLISHED'||
       resourceArchiveFingerprint(resource)!==resourceProof)return {status:'STALE'};
     resource.status='ARCHIVED';
     s.audit.push({updateKey:'b5:archive-local:'+sourceId+':'+resource.id,
      decision:'ALLOW',reason:'B5_EXTERNAL_RESOURCE_ARCHIVED_LOCALLY',
      policyVersion:0,at:Date.now()});
     return {status:'ARCHIVED',resourceId:resource.id};
    });
   }catch{return {status:'UNAVAILABLE'};}
  }

}
