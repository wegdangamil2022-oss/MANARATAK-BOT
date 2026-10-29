import {createHash} from 'node:crypto';
import type {BotState,EducationCategory} from './store.js';
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
/** A restored cycle, missing parent or duplicated ID must never grant visibility. */
export function visibleEducationCategory(state:BotState,category:EducationCategory):boolean{
 const seen=new Set<string>();let current:EducationCategory|undefined=category;
 while(current){
  if(current.scope!==category.scope||current.enabled!==true||seen.has(current.id)||
   state.educationCategories.filter(x=>x.id===current!.id).length!==1)return false;
  seen.add(current.id);if(current.parentId===null)return true;
  const parents=state.educationCategories.filter(x=>x.id===current!.parentId);
  if(parents.length!==1)return false;current=parents[0];
 }
 return false;
}
export function validCategoryLanguage(value:unknown):value is string{
 try{return typeof value==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u.test(value)&&Intl.getCanonicalLocales(value).length===1;}catch{return false;}
}
/** Compact text label token, uniquely resolved against current authorized
 * categories on each tap. Not an authentication credential.
 */
export function ownerCategoryChoiceToken(id:string):string{
 if(!idPattern.test(id))throw Error('INVALID_OWNER_CATEGORY_ID');
 return id.length<=24?id:'~'+createHash('sha256').update(id,'utf8')
  .digest('hex').slice(0,16);
}
/** Bind the owner's decision to metadata, current enabled bit and optional
 * monotonically increasing revision (0 for older stored categories).
 */
export function categoryVisibilityFingerprint(cat:EducationCategory):string{
 return '~'+createHash('sha256').update(JSON.stringify([
  cat.id,cat.scope,cat.parentId,cat.title,cat.order,cat.enabled,cat.revision??0,...(cat.language===undefined?[]:[cat.language])
 ]),'utf8').digest('hex').slice(0,16);
}

/** Ordering is always relative to same-scope siblings (including roots).
 * No global category IDs or groups can be moved across scope/parent.
 */
export function categoryOrderPeers(state:BotState,category:EducationCategory):EducationCategory[]{
 return state.educationCategories.filter(c=>
  c.scope===category.scope&&c.parentId===category.parentId)
  .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
}
/** Bind ordering decisions to the entire currently saved sibling set, not just
 * the clicked category. Concurrent edits, tie resolution, or sibling insertion
 * invalidate an old confirmation. This fingerprint is not authorization.
 */
export function categoryOrderFingerprint(state:BotState,category:EducationCategory):string{
 const peers=categoryOrderPeers(state,category);
 return '~'+createHash('sha256').update(JSON.stringify([
  category.id,category.scope,category.parentId,
  peers.map(c=>[c.id,c.scope,c.parentId,c.title,c.order,c.enabled,c.revision??0])
 ]),'utf8').digest('hex').slice(0,16);
}
