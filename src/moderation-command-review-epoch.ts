import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
export function moderationCommandReviewEpoch(s:BotState,p:Policy,actor:string,chat:string,member:string,now:number):string|null{
 if(!Number.isSafeInteger(now)||now<0||!p.canUseChat(s,chat,'moderation')||!p.has(s,actor,'chat.manage',chat,now)||actor===member||member===p.ownerId||p.has(s,member,'chat.manage',chat,now)||p.isOwner(actor)&&!p.privateFeature(s,'owner.dashboard',actor))return null;
 return createHash('sha256').update('MANARATAK:MODERATION-COMMAND:V1:').update(JSON.stringify([actor,chat,member,s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision,s.warnings.filter(w=>w.chatId===chat&&w.memberId===member),s.moderationReasons.filter(r=>r.chatId===chat&&r.memberId===member),s.moderationOperations])).digest('hex');
}
