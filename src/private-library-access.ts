import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
/** Fences private inline library reply contents against changed sources and
 * feature access. It is a freshness witness, not an authorization token. */
export function privateLibraryEpoch(s:BotState,policy:Policy,actor:string):string|null{
 if(!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor))||!policy.privateFeature(s,'education.navigate',actor))return null;
 const categories=s.educationCategories.filter(c=>c.scope==='private');
 const resources=s.educationResources.filter(r=>r.scope==='private');
 return createHash('sha256').update('MANARATAK:PRIVATE-LIBRARY:V1:').update(JSON.stringify([actor,s.privateSettingsRevision??0,categories,resources])).digest('hex');
}
