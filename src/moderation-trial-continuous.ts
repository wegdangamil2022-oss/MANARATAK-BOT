import {inspectOfflineModerationTrialScope,
 type OfflineModerationTrialOptions} from './moderation-trial-scope.js';
import {checkpoint,sameCheckpoint} from './moderation-trial-rights.js';
import {inspectIsolatedModerationGroupReadOnly,
 type ReadOnlyModerationGroupReport} from './moderation-trial-group.js';
import {inspectIsolatedModerationTargetReadOnly,
 type ReadOnlyModerationTargetReport} from './moderation-trial-target.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

type Group=ReadOnlyModerationGroupReport['group'];
type Target=ReadOnlyModerationTargetReport['target'];
type Rights=ReadOnlyModerationGroupReport['botRights'];
type Reason=ReadOnlyModerationGroupReport['reasons'][number]|
 ReadOnlyModerationTargetReport['reasons'][number];
export interface ContinuousModerationTrialReadOnlyReport{
 readonly stage:'READ_ONLY_MODERATION_TRIAL';
 readonly status:'PASS'|'BLOCKED';
 readonly safety:'STOP'|'RUN';
 readonly rollback:'MATCH'|'MISMATCH';
 readonly botRights:Rights;
 readonly group:Group;
 readonly target:Target;
 readonly reasons:readonly Reason[];
}
const validMember=(x:unknown):x is string=>typeof x==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));

/** One single advisory inspection epoch: GROUP -> TARGET -> GROUP.
 * No separate PASS may override the other phase or survive a changed local
 * STOP/SQLite/backup inode. The final group observation catches topology
 * changes that occur AFTER member verification.
 *
 * This does not arm the emergency switch, record a durable authorization,
 * prove exclusive administrative control, or send ANY Telegram mutation.
 * PASS is observational only; all live sanctions remain DISARMED.
 */
export async function inspectContinuousModerationTrialReadOnly(
 options:OfflineModerationTrialOptions,
 targetMemberId:string,
 gateway:TelegramBotApiModerationGateway,
 protectedOwnerId:string
):Promise<ContinuousModerationTrialReadOnlyReport>{
 // Refuse protected owner without contacting Telegram or reading the local
 // filesystem: an owner may look like an ordinary Telegram group member.
 if(!validMember(targetMemberId)||!validMember(protectedOwnerId)||
    targetMemberId===protectedOwnerId)
  throw Error('MODERATION_TRIAL_INVALID_TARGET');

 const beginning=await checkpoint(options);
 const make=(group:Group,target:Target,rights:Rights,
  reasons:readonly Reason[],safety:'STOP'|'RUN',rollback:'MATCH'|'MISMATCH'):
  ContinuousModerationTrialReadOnlyReport=>({
   stage:'READ_ONLY_MODERATION_TRIAL',status:reasons.length?'BLOCKED':'PASS',
   safety,rollback,botRights:rights,group,target,reasons
  });
 const stale=()=>make('NOT_CHECKED','NOT_CHECKED','NOT_CHECKED',
  ['TRIAL_CHECKPOINT_CHANGED'],'STOP','MATCH');
 const anchorChanged=async()=>{
  const latest=await checkpoint(options);
  return !beginning||!latest||!sameCheckpoint(beginning,latest);
 };
 // Each subphase independently checks isolation, bot rights, STOP and backup.
 // The outer checkpoint additionally binds all three phases into one session.
 const first=await inspectIsolatedModerationGroupReadOnly(options,gateway);
 if(first.status!=='PASS')
  return make(first.group,'NOT_CHECKED',first.botRights,first.reasons,
   first.safety,first.rollback);
 if(await anchorChanged())return stale();

 const target=await inspectIsolatedModerationTargetReadOnly(
  options,targetMemberId,gateway,protectedOwnerId);
 if(target.status!=='PASS')
  return make(first.group,target.target,target.botRights,target.reasons,
   target.safety,target.rollback);
 if(await anchorChanged())return stale();

 // A passing target read is not proof that Telegram still points to the
 // previously verified group. Refresh group type/ID and bot rights again.
 const last=await inspectIsolatedModerationGroupReadOnly(options,gateway);
 if(last.status!=='PASS')
  return make(last.group,'NOT_CHECKED',last.botRights,last.reasons,
   last.safety,last.rollback);
 if(await anchorChanged())return stale();
 if(last.group!==first.group)
  return make('CHANGED','NOT_CHECKED',last.botRights,
   ['TRIAL_REMOTE_CHAT_KIND_CHANGED'],last.safety,last.rollback);

 // Recheck local approval and rollback AFTER the final remote observation.
 // A state revision concurrent with the last getChat must never inherit PASS.
 const final=await inspectOfflineModerationTrialScope(options);
 if(final.status!=='PASS')
  return make('NOT_CHECKED','NOT_CHECKED','NOT_CHECKED',final.reasons,
   final.safety,final.rollback);
 if(await anchorChanged())return stale();
 return make(last.group,'ELIGIBLE','GRANTED',[],final.safety,final.rollback);
}
