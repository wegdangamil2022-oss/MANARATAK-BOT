import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
export interface AdminUIAccess{actorId:string;epoch:string;expiresAt:number;}
export const ADMIN_UI_TTL_MS=120000;
export function validAdminUIAccess(v:unknown):v is AdminUIAccess{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const a=v as Record<string,unknown>;
 return Object.keys(a).length===3&&typeof a.actorId==='string'&&/^[1-9][0-9]{0,15}$/u.test(a.actorId)&&Number.isSafeInteger(Number(a.actorId))&&
  typeof a.epoch==='string'&&/^[a-f0-9]{64}$/u.test(a.epoch)&&typeof a.expiresAt==='number'&&Number.isSafeInteger(a.expiresAt)&&a.expiresAt>=0&&a.expiresAt<=8640000000000000;
}
/** Change witness, not a grant or keyed signature. Queue claims independently
 * recompute actual current policy rights. No raw group IDs are queued here. */
export function protectionUIEpoch(state:BotState,policy:Policy,actor:string,now:number):string|null{
 if(!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(now)||now<0||now>8640000000000000)return null;
 if(policy.isOwner(actor)&&!policy.privateFeature(state,'owner.dashboard',actor))return null;
 const chats=state.chats.filter(c=>policy.canUseChat(state,c.id,'moderation')&&policy.has(state,actor,'chat.manage',c.id,now)).sort((a,b)=>a.id.localeCompare(b.id));
 if(!chats.length&&!policy.isOwner(actor))return null;
 const sessions=state.wizards.filter(w=>w.userId===actor&&w.chatId===actor&&w.status==='ACTIVE'&&typeof w.flow==='string'&&(w.flow.startsWith('protection-ui:')||w.flow.startsWith('group-setup:')))
  .map(w=>[w.key,w.flow,w.version,w.expiresAt]);
 return createHash('sha256').update('MANARATAK:PROTECTION-UI:V1:').update(JSON.stringify([
  actor,policy.ownerId,chats.map(c=>[c,state.protectionPolicies?.find(r=>r.policy.chatId===c.id)??null]),sessions,
  ...(policy.isOwner(actor)&&state.privateSettingsRevision!==undefined?[state.privateSettingsRevision]:[])
 ])).digest('hex');
}
