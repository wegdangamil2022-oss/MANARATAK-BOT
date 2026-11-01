import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
/** Public join links, not group content or a membership grant. */
export function communityFolderEpoch(s:BotState,p:Policy,actor:string):string|null{
 if(!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor))||!p.privateFeature(s,'education.navigate',actor))return null;
 return createHash('sha256').update('MANARATAK:COMMUNITY-FOLDER:V1:').update(JSON.stringify([actor,s.privateSettingsRevision??0,s.communityFolders??[],s.chats,s.subscriptionRequirements])).digest('hex');
}
