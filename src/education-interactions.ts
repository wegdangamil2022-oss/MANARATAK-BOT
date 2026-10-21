import { randomBytes, randomUUID } from 'node:crypto';
import { type BotState, type FAQEntry, BotStore } from './store.js';
import { Policy } from './policy.js';
import { publicEducationResource, type PublicEducationResource } from './education.js';
import {faqReviewFingerprint} from './faq-review.js';

/** Only a trusted Telegram adapter may attest the chat membership status; user-provided claims are not evidence. */
export type MembershipStatus = 'VERIFIED' | 'NOT_MEMBER' | 'UNKNOWN';
export type MembershipPort = (chatId: string, actorId: string) => Promise<MembershipStatus>;
export type FAQResult = {status:'ANSWER'; answer:string; sourceId:string} | {status:'DISABLED' | 'NO_MATCH' | 'AMBIGUOUS'};
export type LinkResult = {status:'FOUND'; resource:PublicEducationResource} | {status:'DENIED'};

const questionKey=(text:string):string=>text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[!?؟.,،؛:;\s]+/gu,' ').trim();
const validText=(text:string,max:number):boolean=>typeof text==='string' && text.trim().length>0 && text.length<=max && !/[\u0000-\u001F\u007F]/u.test(text);
function hasApprovedSource(s:BotState, scope:string, id:string):boolean {
  const resource=s.educationResources.find(r=>r.id===id && r.scope===scope && r.status==='PUBLISHED');
  if(!resource) return false;
  const category=s.educationCategories.find(c=>c.id===resource.categoryId && c.scope===scope);
  if(!category || !category.enabled) return false;
  let node=category; const visited=new Set<string>();
  while(node.parentId) {
    if(visited.has(node.id)) return false; visited.add(node.id);
    const parent=s.educationCategories.find(c=>c.id===node.parentId && c.scope===scope);
    if(!parent || !parent.enabled) return false;
    node=parent;
  }
  return true;
}
const scopeActive=(s:BotState, policy:Policy, scope:string):boolean=>scope==='private'||policy.canUseChat(s,scope,'navigation');
const mayUpload=(s:BotState, policy:Policy, by:string, scope:string, now:number):boolean=>scopeActive(s,policy,scope) && (scope==='private'
  ? policy.privateFeature(s,'content.upload',by)
  : policy.has(s,by,'content.upload',scope,now));
const mayPublish=(s:BotState,policy:Policy,by:string,scope:string,now:number):boolean=>scopeActive(s,policy,scope)&&policy.has(s,by,'content.publish',scope,now);

export class ApprovedAnswerService {
  constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now) {}
  async submit(by:string,scope:string,input:{question:string; aliases?:string[]; answer:string; sourceResourceId:string}):Promise<FAQEntry> {
    if(!validText(input.question,240) || !validText(input.answer,1200) || (input.aliases?.length??0)>10 || (input.aliases??[]).some(a=>!validText(a,240)) || !input.sourceResourceId) throw new Error('INVALID_FAQ');
    const aliases=[...new Set((input.aliases??[]).map(a=>a.trim()))];
    return this.store.transaction(s=>{
      if(!mayUpload(s,this.policy,by,scope,this.clock())) throw new Error('UPLOAD_DENIED');
      if(!hasApprovedSource(s,scope,input.sourceResourceId)) throw new Error('SOURCE_NOT_PUBLISHED');
      const record:FAQEntry={id:randomUUID(),scope,question:input.question.trim(),aliases,answer:input.answer.trim(),sourceResourceId:input.sourceResourceId,createdBy:by,createdAt:this.clock(),status:'DRAFT'};
      s.faqEntries.push(record);
      s.audit.push({updateKey:`faq:draft:${record.id}`,reason:'FAQ_DRAFT',decision:'ALLOW',policyVersion:0,at:this.clock()});
      return record;
    });
  }
  async approve(by:string,id:string):Promise<void> {
    await this.store.transaction(s=>{
      const q=s.faqEntries.find(x=>x.id===id);if(!q)throw new Error('FAQ_NOT_FOUND');
      if(!mayPublish(s,this.policy,by,q.scope,this.clock()))throw new Error('PUBLISH_DENIED');
      if(!hasApprovedSource(s,q.scope,q.sourceResourceId))throw new Error('SOURCE_NOT_PUBLISHED');
      if(q.status==='ARCHIVED')throw new Error('FAQ_ARCHIVED');
      if(q.status==='APPROVED')return;
      q.approvedBy=by; q.status='APPROVED';
      s.audit.push({updateKey:`faq:approve:${id}`,reason:'FAQ_APPROVED',decision:'ALLOW',policyVersion:0,at:this.clock()});
    });
  }
  async archive(by:string,id:string):Promise<void> {
    await this.store.transaction(s=>{
      const q=s.faqEntries.find(x=>x.id===id);if(!q)throw new Error('FAQ_NOT_FOUND');
      if(!mayPublish(s,this.policy,by,q.scope,this.clock()))throw new Error('PUBLISH_DENIED');
      q.status='ARCHIVED';
      s.audit.push({updateKey:`faq:archive:${id}`,reason:'FAQ_ARCHIVED',decision:'ALLOW',policyVersion:0,at:this.clock()});
    });
  }
  /** Verified private owner FAQ decision with atomic exact-copy and
   * source/ancestor fingerprint and group policy-epoch checks. A draft cannot
   * become public if the cited source is no longer published and visible.
   * An approved entry may be archived even if its source later goes stale.
   */
  async transitionIfCurrent(by:string,id:string,target:'APPROVED'|'ARCHIVED',
    proof:string,scopeVersion:number):Promise<void>{
    if(!this.policy.isOwner(by))throw Error('OWNER_ONLY');
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)||
      !['APPROVED','ARCHIVED'].includes(target)||!/^~[a-f0-9]{16}$/u.test(proof)||
      !Number.isSafeInteger(scopeVersion)||scopeVersion<0)throw Error('FAQ_REVIEW_STALE');
    await this.store.transaction(s=>{
      const q=s.faqEntries.find(f=>f.id===id);
      if(!q||!scopeActive(s,this.policy,q.scope))throw Error('FAQ_REVIEW_STALE');
      const policyVersion=q.scope==='private'?0:this.policy.chatRevision(s,q.scope);
      if(policyVersion!==scopeVersion || faqReviewFingerprint(s,q)!==proof)
       throw Error('FAQ_REVIEW_STALE');
      if(target==='APPROVED'){
       if(q.status!=='DRAFT'||!hasApprovedSource(s,q.scope,q.sourceResourceId))
        throw Error('FAQ_REVIEW_STALE');
       q.status='APPROVED';q.approvedBy=by;
      }else{
       if(q.status!=='APPROVED')throw Error('FAQ_REVIEW_STALE');
       q.status='ARCHIVED';
      }
      s.audit.push({updateKey:'owner:faq:'+id+':'+target,
       decision:'ALLOW',reason:target==='APPROVED'?'FAQ_OWNER_APPROVED':'FAQ_OWNER_ARCHIVED',
       policyVersion,at:this.clock()});
    });
  }
  private match(s:BotState,scope:string,question:string):FAQResult {
    const key=questionKey(question);
    if(!key || key.length>240)return {status:'NO_MATCH'};
    const matches=s.faqEntries.filter(q=>q.scope===scope && q.status==='APPROVED' && hasApprovedSource(s,scope,q.sourceResourceId)
      && [q.question,...q.aliases].some(alias=>questionKey(alias)===key));
    if(matches.length===0)return {status:'NO_MATCH'};
    if(matches.length>1)return {status:'AMBIGUOUS'};
    return {status:'ANSWER',answer:matches[0]!.answer,sourceId:matches[0]!.sourceResourceId};
  }
  /**
   * Strictly source-backed private FAQ retrieval, independent of generative
   * AI mode. The user must explicitly issue /faq in the private transport.
   * Never select a group FAQ or draft, and honor education.navigate on each
   * request and the current linked publication/category hierarchy.
   */
  /** A current, private-scope-only catalogue of reviewed questions.
   * No IDs, draft text, unapproved sources or cross-chat metadata are returned
   * to Telegram; transport renders opaque fingerprints as button locators.
   */
  async listPrivateReviewedFAQs(actor:string):Promise<
    {status:'DISABLED';items:[]} | {status:'OK';items:{id:string;question:string}[]}>{
    if(!/^[1-9][0-9]*$/u.test(actor))return {status:'DISABLED',items:[]};
    const s=await this.store.snapshot();
    if(!this.policy.privateFeature(s,'education.navigate',actor))
      return {status:'DISABLED',items:[]};
    const items=s.faqEntries.filter(q=>q.scope==='private'&&q.status==='APPROVED'&&
      hasApprovedSource(s,'private',q.sourceResourceId))
      .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
      .map(q=>({id:q.id,question:q.question}));
    return {status:'OK',items};
  }
  /** The answer must be revalidated after any UI browse/snapshot. */
  async answerPrivateReviewedFAQById(actor:string,id:string):Promise<FAQResult>{
    if(!/^[1-9][0-9]*$/u.test(actor)||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))
      return {status:'DISABLED'};
    const s=await this.store.snapshot();
    if(!this.policy.privateFeature(s,'education.navigate',actor))
      return {status:'DISABLED'};
    const q=s.faqEntries.find(x=>x.id===id&&x.scope==='private'&&x.status==='APPROVED'&&
      hasApprovedSource(s,'private',x.sourceResourceId));
    return q?{status:'ANSWER',answer:q.answer,sourceId:q.sourceResourceId}:{status:'NO_MATCH'};
  }
  async answerPrivateApprovedFAQ(actor:string,question:string):Promise<FAQResult>{
    if(!/^[1-9][0-9]*$/u.test(actor)||typeof question!=='string'||
       question.trim().length===0||question.length>240||
       /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(question))
      return {status:'NO_MATCH'};
    const s=await this.store.snapshot();
    if(!this.policy.privateFeature(s,'education.navigate',actor))return {status:'DISABLED'};
    return this.match(s,'private',question);
  }
  async answerGroup(actor:string,chatId:string,question:string,explicitMention:boolean):Promise<FAQResult> {
    const s=await this.store.snapshot();
    if(!this.policy.mayAskGroup(s,chatId,actor,explicitMention))return {status:'DISABLED'};
    return this.match(s,chatId,question);
  }
  async answerPrivate(actor:string,question:string,optedIn:boolean):Promise<FAQResult> {
    const s=await this.store.snapshot();
    if(!this.policy.mayAskPrivate(s,actor,optedIn))return {status:'DISABLED'};
    return this.match(s,'private',question);
  }
}

/** Server-owned opaque references. No Telegram send or external calls are made here. */
export class ResourceLinkService {
  constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now) {}
  async issue(by:string,resourceId:string,expiresAt:number,boundUserId?:string):Promise<string> {
    if(!Number.isSafeInteger(expiresAt) || expiresAt<=this.clock() || expiresAt-this.clock()>30*24*60*60*1000 || (boundUserId!==undefined && !/^\d+$/.test(boundUserId)))throw new Error('INVALID_LINK');
    return this.store.transaction(s=>{
      const resource=s.educationResources.find(r=>r.id===resourceId);
      if(!resource || !hasApprovedSource(s,resource.scope,resource.id))throw new Error('SOURCE_NOT_PUBLISHED');
      if(!mayPublish(s,this.policy,by,resource.scope,this.clock()))throw new Error('PUBLISH_DENIED');
      const ref='r_'+randomBytes(18).toString('base64url');
      const policyVersion=resource.scope==='private'?0:this.policy.chatRevision(s,resource.scope);
      s.resourceLinks.push({ref,scope:resource.scope,resourceId:resource.id,resourceRevision:1,policyVersion,expiresAt,...(boundUserId ? {boundUserId} : {}),issuedBy:by,revoked:false});
      return ref;
    });
  }
  async resolve(ref:string,actor:string,membership:MembershipPort):Promise<LinkResult> {
    if(!/^r_[A-Za-z0-9_-]{24}$/.test(ref) || !/^\d+$/.test(actor))return {status:'DENIED'};
    const preliminary=await this.store.snapshot();
    const link=preliminary.resourceLinks.find(x=>x.ref===ref);
    if(!link || link.revoked || link.expiresAt<=this.clock() || (link.boundUserId && link.boundUserId!==actor))return {status:'DENIED'};
    let member:MembershipStatus='UNKNOWN';
    if(link.scope!=='private') {
      if(!this.policy.canUseChat(preliminary,link.scope,'navigation'))return {status:'DENIED'};
      try { member=await membership(link.scope,actor); }catch {return {status:'DENIED'};}
      if(member!=='VERIFIED')return {status:'DENIED'};
    }
    // Re-read after the external membership check, so a concurrent revocation cannot pass.
    const s=await this.store.snapshot();const current=s.resourceLinks.find(x=>x.ref===ref);
    if(!current || current.revoked || current.expiresAt<=this.clock() || current.resourceRevision!==1 || (current.boundUserId && current.boundUserId!==actor))return {status:'DENIED'};
    if(current.scope==='private') {
      if(!this.policy.privateFeature(s,'education.navigate',actor))return {status:'DENIED'};
    } else if(!this.policy.canUseChat(s,current.scope,'navigation') || this.policy.chatRevision(s,current.scope)!==current.policyVersion)return {status:'DENIED'};
    if(!hasApprovedSource(s,current.scope,current.resourceId))return {status:'DENIED'};
    const resource=s.educationResources.find(r=>r.id===current.resourceId);
    return resource?{status:'FOUND',resource:publicEducationResource(resource)}:{status:'DENIED'};
  }
  async revoke(by:string,ref:string):Promise<void> {
    await this.store.transaction(s=>{
      const link=s.resourceLinks.find(x=>x.ref===ref);if(!link)throw new Error('LINK_NOT_FOUND');
      if(!mayPublish(s,this.policy,by,link.scope,this.clock()))throw new Error('PUBLISH_DENIED');
      link.revoked=true;
    });
  }
}
