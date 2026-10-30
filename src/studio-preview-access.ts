import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {protectionUIEpoch} from './protection-ui-access.js';
/** Freshness witness for a private studio preview, not a grant. */
export function studioPreviewEpoch(s:BotState,policy:Policy,actor:string,now:number):string|null{
 if(!policy.isOwner(actor))return null;
 const access=protectionUIEpoch(s,policy,actor,now);if(!access)return null;
 return createHash('sha256').update('MANARATAK:STUDIO-PREVIEW:V1:').update(JSON.stringify([
  access,s.buttonStudio?.templates??[],s.buttonStudio?.settings??null,
  s.privateFeatures['education.navigate'],s.educationCategories.filter(c=>c.scope==='private'),
  s.educationResources.filter(r=>r.scope==='private')
 ])).digest('hex');
}
