import {createHash} from 'node:crypto';
import type {EducationCategory} from './store.js';
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
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
  cat.id,cat.scope,cat.parentId,cat.title,cat.order,cat.enabled,cat.revision??0
 ]),'utf8').digest('hex').slice(0,16);
}
