import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {subscriptionConfigEpoch} from './subscription-config-epoch.js';
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
 const sessions=state.wizards.filter(w=>w.userId===actor&&w.chatId===actor&&w.status==='ACTIVE'&&typeof w.flow==='string'&&(w.flow.startsWith('protection-enforce:')||w.flow.startsWith('moderation-command:')||w.flow.startsWith('protection-ui:')||w.flow.startsWith('group-setup:')||w.flow.startsWith('owner-upload:')||w.flow.startsWith('subscription-editor:')||w.flow.startsWith('folder-owner:')||w.flow.startsWith('purge-editor:')||w.flow.startsWith('admin-role-review:')||w.flow.startsWith('admin-role:')||w.flow.startsWith('owner-rights:')||w.flow.startsWith('moderation-rate:')||w.flow.startsWith('admin-room-check:')))
  .map(w=>[w.key,w.flow,w.version,w.expiresAt]);
 return createHash('sha256').update('MANARATAK:PROTECTION-UI:V1:').update(JSON.stringify([
  actor,policy.ownerId,...(policy.isOwner(actor)?[state.audit.filter(a=>a.updateKey.startsWith('captcha:policy:')),state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('captcha-owner:')&&!c.used&&!c.revoked)]:[]),state.audit.filter(a=>a.updateKey.startsWith('moderation:rule-notice:')),state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('rule-action-choice:')&&!c.used&&!c.revoked),chats.map(c=>[c,state.protectionPolicies?.find(r=>r.policy.chatId===c.id)??null]),sessions,
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('moderation:appeal-warning:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('moderation:appeal-warning:')&&!c.used&&!c.revoked)]:[]),
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('rule-exemption-preview:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('rule-exemption-preview:')&&!c.used&&!c.revoked)]:[]),
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('rule-exemption-revoke:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('rule-exemption-revoke:')&&!c.used&&!c.revoked)]:[]),
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('room-action:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('room-action:')&&!c.used&&!c.revoked)]:[]),
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('oncall-preview:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('oncall-preview:')&&!c.used&&!c.revoked)]:[]),
  ...(state.audit.some(a=>a.updateKey.startsWith('admin-room:oncall:'))?[state.audit.filter(a=>a.updateKey.startsWith('admin-room:oncall:'))]:[]),
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('admin-room:revoke-preview:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('admin-room:revoke-preview:')&&!c.used&&!c.revoked)]:[]),
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('admin-room:quiet-preview:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('admin-room:quiet-preview:')&&!c.used&&!c.revoked)]:[]),
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('admin-room:daily-preview:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('admin-room:daily-preview:')&&!c.used&&!c.revoked)]:[]),
  state.warnings.filter(w=>chats.some(c=>c.id===w.chatId)),state.moderationReasons.filter(r=>chats.some(c=>c.id===r.chatId)),state.moderationOperations.filter(o=>chats.some(c=>c.id===o.chatId)),
  ...(state.audit.some(a=>a.updateKey.startsWith('moderation:appeal:'))?[state.audit.filter(a=>a.updateKey.startsWith('moderation:appeal:')),state.privateFeatures['support.use']]:[]),
  ...(state.audit.some(a=>a.updateKey.startsWith('moderation:report:'))?[state.audit.filter(a=>a.updateKey.startsWith('moderation:report:')),state.privateFeatures['support.use']]:[]),
  ...(state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith('rule-warning-policy-preview:')&&!c.used&&!c.revoked)?[state.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith('rule-warning-policy-preview:')&&!c.used&&!c.revoked)]:[]),
  ...(state.audit.some(a=>a.updateKey.startsWith('moderation:rule-warning-policy:'))?[state.audit.filter(a=>a.updateKey.startsWith('moderation:rule-warning-policy:'))]:[]),
  ...(state.audit.some(a=>a.updateKey.startsWith('moderation:rules:'))?[state.audit.filter(a=>a.updateKey.startsWith('moderation:rules:'))]:[]),
  ...(state.audit.some(a=>a.updateKey.startsWith('moderation:rule-exemption:'))?[state.audit.filter(a=>a.updateKey.startsWith('moderation:rule-exemption:'))]:[]),
  ...(state.audit.some(a=>a.updateKey.startsWith('admin-room:request:'))?[state.audit.filter(a=>a.updateKey.startsWith('admin-room:request:')),state.warnings]:[]),
  ...(state.audit.some(a=>a.updateKey.startsWith('admin-room:quiet:'))?[state.audit.filter(a=>a.updateKey.startsWith('admin-room:quiet:'))]:[]),
  ...(state.audit.some(a=>a.updateKey.startsWith('admin-room:daily:'))?[state.audit.filter(a=>a.updateKey.startsWith('admin-room:daily:'))]:[]),
  ...(state.groupPermissionJobs===undefined?[]:[state.groupPermissionJobs]),
  ...(state.moderationRateConfig===undefined?[]:[state.moderationRateConfig]),
  ...(policy.isOwner(actor)&&state.privateSettingsRevision!==undefined?[state.privateSettingsRevision]:[]),
  ...(policy.isOwner(actor)?[state.importRuns,state.educationCategories,state.educationResources,subscriptionConfigEpoch(state),...(state.communityFolders!==undefined?[state.communityFolders]:[])]:[])
 ])).digest('hex');
}
/** Navigation can cancel an input session without changing the displayed staff sources. */
export function protectionUISourceEpoch(state:BotState,policy:Policy,actor:string,now:number):string|null{
 return protectionUIEpoch({...state,wizards:[]},policy,actor,now);
}
