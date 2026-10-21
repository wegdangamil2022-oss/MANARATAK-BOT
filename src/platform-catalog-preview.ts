import {createHash} from 'node:crypto';
import type {PlatformReviewQueueEntry} from './store.js';
import {BotStore} from './store.js';
import {Policy} from './policy.js';

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
  async stage(actor:string,sourceId:string,expectedPageFingerprint:string):
   Promise<PlatformStageResult>{
   if(!this.policy.isOwner(actor))return {status:'DENIED'};
   if(typeof sourceId!=='string'||!validId.test(sourceId)||
     typeof expectedPageFingerprint!=='string'||!strictDigest.test(expectedPageFingerprint))
    return {status:'UNAVAILABLE'};
   const preview=await this.preview(actor);
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
      sourceId,sourceRevision:candidate.revision,title:candidate.title,
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
   const preview=await this.preview(actor);
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
     current.status='REVIEWED_METADATA_ONLY';
     current.reviewedBy=actor;current.reviewedAt=Date.now();
     s.audit.push({updateKey:'b5:review:'+sourceId+':'+expectedDigest.slice(0,16),
      decision:'ALLOW',reason:'EXTERNAL_METADATA_REVIEW_ONLY',
      policyVersion:0,at:current.reviewedAt});
     return {status:'REVIEWED',entry:structuredClone(current)};
    });
   }catch{return {status:'UNAVAILABLE'};}
  }

}
