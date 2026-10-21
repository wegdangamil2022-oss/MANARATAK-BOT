import {createHash} from 'node:crypto';
import type {BotState,FAQEntry} from './store.js';

/** Use the same Unicode/punctuation rules as the FAQ answer matcher.
 * One currently approved answer with overlapping alias/question key makes
 * another answer ambiguous. Only approved entries can block a new approval.
 */
export const normalizedFAQQuestion=(value:string):string=>value.normalize('NFKC')
 .toLocaleLowerCase('en-US').replace(/[!?؟.,،؛:;\s]+/gu,' ').trim();
export function faqApprovalConflicts(state:BotState,record:FAQEntry):number{
 const keys=new Set([record.question,...record.aliases].map(normalizedFAQQuestion).filter(Boolean));
 if(!keys.size)return 0;
 return state.faqEntries.filter(f=>f.id!==record.id&&f.scope===record.scope&&
   f.status==='APPROVED'&&
   [f.question,...f.aliases].some(x=>keys.has(normalizedFAQQuestion(x)))).length;
}

/** Binds a review to exact FAQ copy AND current reviewed source status/copy
 * and ancestor-category visibility/revisions. This hash is NOT authorization;
 * trusted owner/private origin and current policy are independently checked.
 */
export function faqReviewFingerprint(s:BotState,q:FAQEntry):string{
 const resource=s.educationResources.find(r=>r.id===q.sourceResourceId&&r.scope===q.scope);
 const chain:unknown[]=[];
 const visited=new Set<string>();
 let parentId=resource?.categoryId;
 while(parentId&&chain.length<64){
  if(visited.has(parentId)){chain.push('CATEGORY_CYCLE');break;}
  visited.add(parentId);
  const cat=s.educationCategories.find(c=>c.id===parentId&&c.scope===q.scope);
  if(!cat){chain.push('CATEGORY_MISSING');break;}
  chain.push([cat.id,cat.scope,cat.parentId,cat.enabled,cat.revision??0,cat.order,cat.title]);
  parentId=cat.parentId??undefined;
 }
 return '~'+createHash('sha256').update(JSON.stringify([
  q.id,q.scope,q.question,q.aliases,q.answer,q.sourceResourceId,
  q.status,q.createdAt,q.createdBy,q.approvedBy??null,
  resource??null,chain
 ]),'utf8').digest('hex').slice(0,16);
}
