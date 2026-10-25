import {BotStore,type BotState} from './store.js';
import {inspectTelegramTrialAcceptanceReadOnly,
 type TelegramTrialAcceptanceOptions,type TelegramTrialAcceptanceReport} from './telegram-trial-acceptance.js';

/** Offline, status-only checklist for selecting a SINGLE local trial group.
 * A local PASS cannot attest that the chat is a genuine/isolated Telegram
 * test environment. No Bot API calls, tokens, permissions mutations or sends.
 */
export interface OfflineModerationTrialOptions extends TelegramTrialAcceptanceOptions{
 trialChatId:string;
}
export type ModerationTrialBlocker=
 TelegramTrialAcceptanceReport['reasons'][number]|
 'TRIAL_GROUP_NOT_APPROVED'|'TRIAL_GROUP_NOT_PRESENT'|
 'TRIAL_MODERATION_SCOPE_MISSING'|'OTHER_MODERATION_GROUP_APPROVED'|
 'OTHER_APPROVED_CHAT_PRESENT'|'OTHER_MODERATION_HISTORY'|
 'OTHER_MODERATION_REASONS'|'OTHER_MODERATION_WARNINGS'|
 'TRIAL_GROUP_HAS_MODERATION_HISTORY'|'TRIAL_GROUP_HAS_MODERATION_REASONS'|
 'TRIAL_GROUP_HAS_WARNINGS'|'TRIAL_GROUP_HAS_MODERATION_GRANTS'|
 'OTHER_MODERATION_GRANTS';
export interface OfflineModerationTrialReport{
 readonly stage:'OFFLINE_MODERATION_TRIAL';
 readonly status:'PASS'|'BLOCKED';
 readonly safety:'STOP'|'RUN';
 readonly rollback:'MATCH'|'MISMATCH';
 readonly reasons:readonly ModerationTrialBlocker[];
}
const validChat=(id:unknown):id is string=>
 typeof id==='string'&&/^-[1-9][0-9]{0,15}$/u.test(id)&&
 Number.isSafeInteger(Number(id));
const FIELDS=['stateFile','backupFile','safetyFile','now','staleAfterMs','trialChatId'];

/** Local policy snapshot only. It deliberately requires an EMPTY moderation
 * history on the selected group; old simulated/confirmed attempts are not
 * evidence that a real Telegram trial is safe to repeat.
 */
export function localModerationTrialBlockers(s:BotState,trialChatId:string):ModerationTrialBlocker[]{
 const reasons:ModerationTrialBlocker[]=[];
 const chat=s.chats.find(c=>c.id===trialChatId);
 if(!chat?.approved)reasons.push('TRIAL_GROUP_NOT_APPROVED');
 else{
  if(!chat.present)reasons.push('TRIAL_GROUP_NOT_PRESENT');
  if(!chat.scopes.includes('moderation'))reasons.push('TRIAL_MODERATION_SCOPE_MISSING');
 }
 // A strictly isolated trial must not have ANY other active approved chat,
 // including publishing/navigation chats that would become live if the
 // operator ever lifted the global STOP switch. Distinguish existing legacy
 // moderation-scope blockers without duplicating a second reason.
 const approvedElsewhere=s.chats.filter(c=>c.id!==trialChatId&&c.approved);
 if(approvedElsewhere.some(c=>c.scopes.includes('moderation')))
  reasons.push('OTHER_MODERATION_GROUP_APPROVED');
 else if(approvedElsewhere.length)reasons.push('OTHER_APPROVED_CHAT_PRESENT');
 // Historical sanctions and warnings are never evidence that it is safe to
 // replay or overwrite them. This must cover all chats, including revoked
 // groups, and *inactive* records, not just currently actionable work.
 if(s.moderationOperations.some(o=>o.chatId===trialChatId))
  reasons.push('TRIAL_GROUP_HAS_MODERATION_HISTORY');
 if(s.moderationReasons.some(o=>o.chatId===trialChatId))
  reasons.push('TRIAL_GROUP_HAS_MODERATION_REASONS');
 if(s.warnings.some(w=>w.chatId===trialChatId))
  reasons.push('TRIAL_GROUP_HAS_WARNINGS');
 if(s.moderationOperations.some(o=>o.chatId!==trialChatId))
  reasons.push('OTHER_MODERATION_HISTORY');
 if(s.moderationReasons.some(o=>o.chatId!==trialChatId))
  reasons.push('OTHER_MODERATION_REASONS');
 if(s.warnings.some(w=>w.chatId!==trialChatId))
  reasons.push('OTHER_MODERATION_WARNINGS');
 // Owner-only test: no non-revoked chat.manage grants on this or other
 // groups. Even expired grants must be explicitly revoked, rather than
 // silently treating latent imported staff configurations as a clean trial.
 if(s.grants.some(g=>g.chatId===trialChatId&&
   g.capability==='chat.manage'&&!g.revoked))
  reasons.push('TRIAL_GROUP_HAS_MODERATION_GRANTS');
 if(s.grants.some(g=>g.chatId!==trialChatId&&
   g.capability==='chat.manage'&&!g.revoked))
  reasons.push('OTHER_MODERATION_GRANTS');
 return reasons;
}
export async function inspectOfflineModerationTrialScope(
 options:OfflineModerationTrialOptions):Promise<OfflineModerationTrialReport>{
 if(!options||typeof options!=='object'||Array.isArray(options)||
   Object.keys(options).length!==6||
   Object.keys(options).some(k=>!FIELDS.includes(k))||
   !validChat(options.trialChatId))
  throw Error('MODERATION_TRIAL_INVALID_REQUEST');
 const {trialChatId,...acceptanceOptions}=options;
 // The existing STOP, independent SQLite backup, no-unresolved-work and
 // freshness checks are mandatory prerequisites; this cannot bypass them.
 const accepted=await inspectTelegramTrialAcceptanceReadOnly(acceptanceOptions);
 if(accepted.status!=='PASS')return {stage:'OFFLINE_MODERATION_TRIAL',
  status:'BLOCKED',safety:accepted.safety,rollback:accepted.rollback,
  reasons:accepted.reasons};
 let before:BotState,after:BotState;
 try{before=await BotStore.snapshotSqliteReadOnly(options.stateFile);}
 catch{throw Error('MODERATION_TRIAL_STATE_CHANGED');}
 const local=localModerationTrialBlockers(before,trialChatId);
 // The group can be revoked while the local read is in flight. Recheck
 // *both* the complete acceptance prerequisites and the scope snapshot.
 const recheck=await inspectTelegramTrialAcceptanceReadOnly(acceptanceOptions);
 try{after=await BotStore.snapshotSqliteReadOnly(options.stateFile);}
 catch{throw Error('MODERATION_TRIAL_STATE_CHANGED');}
 if(JSON.stringify(accepted)!==JSON.stringify(recheck)||
    JSON.stringify(before)!==JSON.stringify(after))
  throw Error('MODERATION_TRIAL_STATE_CHANGED');
 return {stage:'OFFLINE_MODERATION_TRIAL',
  status:local.length?'BLOCKED':'PASS',safety:accepted.safety,
  rollback:accepted.rollback,reasons:local};
}
