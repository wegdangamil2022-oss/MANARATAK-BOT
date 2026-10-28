import {inspectContinuousModerationTrialReadOnly,
 type ContinuousModerationTrialReadOnlyReport} from './moderation-trial-continuous.js';
import type {OfflineModerationTrialOptions} from './moderation-trial-scope.js';
import type {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

/** An operator-readable record of observable technical facts ONLY.
 * The owner has NOT approved a real trial merely because this returns
 * TECHNICAL_PASS. This report is ephemeral; no state/secret/ID is written.
 */
export interface ModerationTrialAcceptanceReport{
 readonly stage:'READ_ONLY_MODERATION_ACCEPTANCE';
 readonly status:'TECHNICAL_PASS'|'BLOCKED';
 readonly safety:'STOP'|'RUN'|'UNKNOWN';
 readonly rollback:'MATCH'|'MISMATCH'|'UNKNOWN';
 readonly botRights:ContinuousModerationTrialReadOnlyReport['botRights'];
 readonly group:ContinuousModerationTrialReadOnlyReport['group'];
 readonly target:ContinuousModerationTrialReadOnlyReport['target'];
 readonly reasons:readonly string[];
 readonly operatorChecks:readonly (
  'ISOLATED_TEST_GROUP_CONFIRMATION'|
  'VOLUNTEER_MEMBER_CONSENT'|
  'RESTORE_AND_REVERSAL_PLAN_REVIEW'|
  'OWNER_EXPLICIT_TRIAL_APPROVAL'
 )[];
 readonly operatorApproved:false;
 readonly liveModeration:'DISARMED';
 readonly authorizedToSendSanctions:false;
}

/** Explicit, stable list of unautomatable checks. Reading chat type and
 * membership cannot prove isolation, informed consent or human approval.
 * No caller can convert this field into a dispatch credential.
 */
const pendingOperatorChecks=Object.freeze([
 'ISOLATED_TEST_GROUP_CONFIRMATION',
 'VOLUNTEER_MEMBER_CONSENT',
 'RESTORE_AND_REVERSAL_PLAN_REVIEW',
 'OWNER_EXPLICIT_TRIAL_APPROVAL'
] as const);
const allowedReasons=new Set<string>([
 'SAFETY_NOT_STOP','BACKUP_STATE_MISMATCH','PENDING_REPLIES',
 'UNRESOLVED_REPLIES','UNRESOLVED_UPDATES','UNRESOLVED_OPERATIONS',
 'UNRESOLVED_PUBLICATIONS','ACTIVE_PURGE','INVALID_SUBSCRIPTION_REQUIREMENTS',
 'BACKUP_TOO_OLD','BACKUP_TIMESTAMP_IN_FUTURE',
 'ORPHAN_MODERATION_REVIEW_AUDIT','UNSAFE_MODERATION_LEDGER','UNSAFE_REPLY_LEDGER',
 'TRIAL_GROUP_NOT_APPROVED','TRIAL_GROUP_NOT_PRESENT',
 'TRIAL_MODERATION_SCOPE_MISSING','OTHER_MODERATION_GROUP_APPROVED',
 'OTHER_APPROVED_CHAT_PRESENT','OTHER_MODERATION_HISTORY',
 'OTHER_MODERATION_REASONS','OTHER_MODERATION_WARNINGS',
 'TRIAL_GROUP_HAS_MODERATION_HISTORY','TRIAL_GROUP_HAS_MODERATION_REASONS',
 'TRIAL_GROUP_HAS_WARNINGS','TRIAL_GROUP_HAS_MODERATION_GRANTS',
 'OTHER_MODERATION_GRANTS','TRIAL_GROUP_APPROVAL_AMBIGUOUS',
 'OTHER_CHAT_APPROVAL_AMBIGUOUS',
 'BOT_MODERATION_RIGHTS_DENIED','BOT_MODERATION_RIGHTS_UNKNOWN',
 'BOT_MODERATION_RIGHTS_CHANGED','BOT_MODERATION_GATEWAY_UNTRUSTED',
 'TRIAL_CHECKPOINT_CHANGED','TRIAL_REMOTE_CHAT_NOT_GROUP',
 'TRIAL_REMOTE_CHAT_UNKNOWN','TRIAL_REMOTE_CHAT_KIND_CHANGED',
 'TRIAL_TARGET_NOT_VERIFIED_MEMBER','TRIAL_TARGET_STATUS_CHANGED'
]);
const kinds=new Set<string>(['GROUP','SUPERGROUP','NOT_GROUP','UNKNOWN',
 'CHANGED','NOT_CHECKED']);
const targets=new Set<string>(['ELIGIBLE','PROTECTED_OR_UNVERIFIED',
 'CHANGED','NOT_CHECKED']);
const rights=new Set<string>(['GRANTED','DENIED','UNKNOWN','CHANGED','NOT_CHECKED']);
const fallback='TRIAL_ACCEPTANCE_EVIDENCE_INCONSISTENT';

/** Strictly project the single anchored GROUP→TARGET→GROUP inspection.
 * Runtime guard prevents a contradictory/malformed result from becoming a
 * false technical PASS or leaking arbitrary restored/provider error strings.
 * It NEVER issues or stores approval and is NOT an authentication token.
 */
export function buildModerationTrialAcceptanceReport(
 source:ContinuousModerationTrialReadOnlyReport
):ModerationTrialAcceptanceReport{
 const v=source as unknown as Record<string,unknown>;
 const safety=v?.safety==='STOP'||v?.safety==='RUN'?v.safety:'UNKNOWN';
 const rollback=v?.rollback==='MATCH'||v?.rollback==='MISMATCH'?
  v.rollback:'UNKNOWN';
 const botRights=rights.has(String(v?.botRights))?
  v.botRights as ModerationTrialAcceptanceReport['botRights']:'NOT_CHECKED';
 const group=kinds.has(String(v?.group))?
  v.group as ModerationTrialAcceptanceReport['group']:'NOT_CHECKED';
 const target=targets.has(String(v?.target))?
  v.target as ModerationTrialAcceptanceReport['target']:'NOT_CHECKED';
 const validReasons=Array.isArray(v?.reasons)&&v.reasons.length<=40&&
  v.reasons.every((x:unknown)=>typeof x==='string'&&allowedReasons.has(x));
 const reasons=validReasons?[...v.reasons as string[]]:[];
 const complete=v?.stage==='READ_ONLY_MODERATION_TRIAL'&&
  v?.status==='PASS'&&safety==='STOP'&&rollback==='MATCH'&&
  botRights==='GRANTED'&&(group==='GROUP'||group==='SUPERGROUP')&&
  target==='ELIGIBLE'&&reasons.length===0&&validReasons;
 const coherentBlocked=v?.stage==='READ_ONLY_MODERATION_TRIAL'&&
  v?.status==='BLOCKED'&&reasons.length>0&&validReasons&&
  safety!=='UNKNOWN'&&rollback!=='UNKNOWN'&&
  rights.has(String(v?.botRights))&&
  kinds.has(String(v?.group))&&targets.has(String(v?.target));
 const reportReasons=complete?[]:coherentBlocked?reasons:[fallback];
 return {
  stage:'READ_ONLY_MODERATION_ACCEPTANCE',
  status:complete?'TECHNICAL_PASS':'BLOCKED',
  safety,rollback,botRights,group,target,
  reasons:reportReasons,
  operatorChecks:[...pendingOperatorChecks],
  operatorApproved:false,
  liveModeration:'DISARMED',
  authorizedToSendSanctions:false
 };
}

/** One-shot, read-only acceptance inventory. No Telegram mutation is
 * reachable through the continuous inspector, and the status returned by
 * this wrapper cannot be used to arm a live ModerationGateway.
 */
export async function inspectModerationTrialAcceptanceReadOnly(
 options:OfflineModerationTrialOptions,
 targetMemberId:string,
 gateway:TelegramBotApiModerationGateway,
 protectedOwnerId:string
):Promise<ModerationTrialAcceptanceReport>{
 const observed=await inspectContinuousModerationTrialReadOnly(
  options,targetMemberId,gateway,protectedOwnerId);
 return buildModerationTrialAcceptanceReport(observed);
}
