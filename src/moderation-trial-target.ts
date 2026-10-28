import {inspectOfflineModerationTrialScope,
 type OfflineModerationTrialOptions} from './moderation-trial-scope.js';
import {checkpoint,sameCheckpoint,inspectIsolatedModerationRightsReadOnly,
 type ReadOnlyModerationRightsReport} from './moderation-trial-rights.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

type Target='ELIGIBLE'|'PROTECTED_OR_UNVERIFIED'|'CHANGED'|'NOT_CHECKED';
type Reason=ReadOnlyModerationRightsReport['reasons'][number]|
 'TRIAL_TARGET_NOT_VERIFIED_MEMBER'|'TRIAL_TARGET_STATUS_CHANGED'|
 'BOT_MODERATION_RIGHTS_CHANGED';
export interface ReadOnlyModerationTargetReport{
 readonly stage:'READ_ONLY_MODERATION_TARGET';
 readonly status:'PASS'|'BLOCKED';
 readonly safety:'STOP'|'RUN';
 readonly rollback:'MATCH'|'MISMATCH';
 readonly botRights:ReadOnlyModerationRightsReport['botRights'];
 readonly target:Target;
 readonly reasons:readonly Reason[];
}
const validMember=(value:unknown):value is string=>
 typeof value==='string'&&/^[1-9][0-9]{0,15}$/u.test(value)&&
 Number.isSafeInteger(Number(value));

/**
 * Advisory, NON-MUTATING eligibility preflight for one nominated trial
 * member. The current STOP-backed, single-approved-group, independently
 * backed-up local trial must first pass double trusted BOT rights reads.
 *
 * Two further target reads are bracketed by fresh bot rights reads and
 * offline/epoch checks. "ELIGIBLE" means only "ordinary human group member
 * in these bounded observations"; it is never an authorization to sanction.
 *
 * No token, target identifier or path enters the returned report. No
 * sanction endpoint, state writer, or safety-switch mutation is reachable.
 */
export async function inspectIsolatedModerationTargetReadOnly(
 options:OfflineModerationTrialOptions,
 targetMemberId:string,
 gateway:TelegramBotApiModerationGateway
):Promise<ReadOnlyModerationTargetReport>{
 if(!validMember(targetMemberId))
  throw Error('MODERATION_TRIAL_INVALID_TARGET');

 const initialCheckpoint=await checkpoint(options);
 const rights=await inspectIsolatedModerationRightsReadOnly(options,gateway);
 const base=(target:Target,botRights:ReadOnlyModerationTargetReport['botRights'],
  reasons:readonly Reason[],
  safety=rights.safety,rollback=rights.rollback):ReadOnlyModerationTargetReport=>({
   stage:'READ_ONLY_MODERATION_TARGET',status:reasons.length?'BLOCKED':'PASS',
   safety,rollback,botRights,target,reasons
  });
 if(rights.status!=='PASS')return base('NOT_CHECKED',rights.botRights,rights.reasons);
 const stale=()=>base('NOT_CHECKED','NOT_CHECKED',['TRIAL_CHECKPOINT_CHANGED']);
 const untrusted=()=>base('NOT_CHECKED','NOT_CHECKED',['BOT_MODERATION_GATEWAY_UNTRUSTED']);
 const authentic=()=>
  TelegramBotApiModerationGateway.usesOfficialDispatch(gateway)&&
  TelegramBotApiModerationGateway.usesOfficialRightsRead(gateway);
 const changed=async():Promise<boolean>=>{
  const current=await checkpoint(options);
  return !initialCheckpoint||!current||
   !sameCheckpoint(initialCheckpoint,current);
 };
 // Any replacement of the source, backup or STOP while the BOT rights
 // observations ran invalidates even a locally matching rights report.
 if(await changed())return stale();
 if(!authentic())return untrusted();

 const verifyLocal=async():Promise<ReadOnlyModerationTargetReport|null>=>{
  const local=await inspectOfflineModerationTrialScope(options);
  if(local.status!=='PASS')
   return base('NOT_CHECKED',rights.botRights,local.reasons,
    local.safety,local.rollback);
  if(await changed())return stale();
  if(!authentic())return untrusted();
  return null;
 };
 const readTarget=async():Promise<Target>=>{
  try{
   const protectedTarget=await gateway.isProtected(options.trialChatId,targetMemberId);
   return protectedTarget===false?'ELIGIBLE':'PROTECTED_OR_UNVERIFIED';
  }catch{return 'PROTECTED_OR_UNVERIFIED';}
 };
 const readRights=async():Promise<'GRANTED'|'DENIED'|'UNKNOWN'>=>{
  try{
   const observed=await gateway.inspectBotModerationRights(options.trialChatId);
   return observed==='GRANTED'||observed==='DENIED'?observed:'UNKNOWN';
  }catch{return 'UNKNOWN';}
 };

 const first=await readTarget();
 let local=await verifyLocal();
 if(local)return local;
 const middleRights=await readRights();
 local=await verifyLocal();
 if(local)return local;
 if(middleRights!=='GRANTED')
  return base('NOT_CHECKED','CHANGED',['BOT_MODERATION_RIGHTS_CHANGED']);

 const second=await readTarget();
 local=await verifyLocal();
 if(local)return local;
 const finalRights=await readRights();
 local=await verifyLocal();
 if(local)return local;
 if(finalRights!=='GRANTED')
  return base('NOT_CHECKED','CHANGED',['BOT_MODERATION_RIGHTS_CHANGED']);

 if(first!==second)
  return base('CHANGED','GRANTED',['TRIAL_TARGET_STATUS_CHANGED']);
 if(second!=='ELIGIBLE')
  return base('PROTECTED_OR_UNVERIFIED','GRANTED',['TRIAL_TARGET_NOT_VERIFIED_MEMBER']);
 return base('ELIGIBLE','GRANTED',[]);
}
