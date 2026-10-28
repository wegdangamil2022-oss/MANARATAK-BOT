import {inspectOfflineModerationTrialScope,
 type OfflineModerationTrialOptions} from './moderation-trial-scope.js';
import {checkpoint,sameCheckpoint,inspectIsolatedModerationRightsReadOnly,
 type ReadOnlyModerationRightsReport} from './moderation-trial-rights.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

type GroupKind='GROUP'|'SUPERGROUP'|'NOT_GROUP'|'UNKNOWN'|'CHANGED'|'NOT_CHECKED';
type Blocker=ReadOnlyModerationRightsReport['reasons'][number]|
 'TRIAL_REMOTE_CHAT_NOT_GROUP'|'TRIAL_REMOTE_CHAT_UNKNOWN'|
 'TRIAL_REMOTE_CHAT_KIND_CHANGED'|'BOT_MODERATION_RIGHTS_CHANGED';

export interface ReadOnlyModerationGroupReport{
 readonly stage:'READ_ONLY_MODERATION_GROUP';
 readonly status:'PASS'|'BLOCKED';
 readonly safety:'STOP'|'RUN';
 readonly rollback:'MATCH'|'MISMATCH';
 readonly botRights:ReadOnlyModerationRightsReport['botRights'];
 readonly group:GroupKind;
 readonly reasons:readonly Blocker[];
}

/** Two getChat observations of the exact trial group, each followed by a
 * new official bot-rights read. All remote calls are read-only. Never
 * return chat titles, identifiers, file paths or Telegram response bodies.
 *
 * A PASS is momentary advisory information, never permission to lift STOP
 * or issue BAN/MUTE; the real sanctions adapter is still not connected.
 */
export async function inspectIsolatedModerationGroupReadOnly(
 options:OfflineModerationTrialOptions,
 gateway:TelegramBotApiModerationGateway
):Promise<ReadOnlyModerationGroupReport>{
 const initialCheckpoint=await checkpoint(options);
 const rights=await inspectIsolatedModerationRightsReadOnly(options,gateway);
 const make=(group:GroupKind,botRights:ReadOnlyModerationGroupReport['botRights'],
  reasons:readonly Blocker[],safety=rights.safety,rollback=rights.rollback):
  ReadOnlyModerationGroupReport=>({
   stage:'READ_ONLY_MODERATION_GROUP',
   status:reasons.length?'BLOCKED':'PASS',
   safety,rollback,botRights,group,reasons
  });
 if(rights.status!=='PASS')
  return make('NOT_CHECKED',rights.botRights,rights.reasons);
 const stale=()=>make('NOT_CHECKED','NOT_CHECKED',['TRIAL_CHECKPOINT_CHANGED']);
 const untrusted=()=>make('NOT_CHECKED','NOT_CHECKED',['BOT_MODERATION_GATEWAY_UNTRUSTED']);
 const authentic=()=>
  TelegramBotApiModerationGateway.usesOfficialRightsRead(gateway)&&
  TelegramBotApiModerationGateway.usesOfficialTrialGroupRead(gateway);
 const drifted=async()=>{
  const current=await checkpoint(options);
  return !initialCheckpoint||!current||
   !sameCheckpoint(initialCheckpoint,current);
 };
 if(await drifted())return stale();
 if(!authentic())return untrusted();

 // The local group approval, source SQLite, private STOP and independent
 // rollback evidence are rechecked AFTER every external network await.
 const verifyLocal=async():Promise<ReadOnlyModerationGroupReport|null>=>{
  const local=await inspectOfflineModerationTrialScope(options);
  if(local.status!=='PASS')
   return make('NOT_CHECKED',rights.botRights,local.reasons,
    local.safety,local.rollback);
  if(await drifted())return stale();
  if(!authentic())return untrusted();
  return null;
 };
 const readGroup=async():Promise<'GROUP'|'SUPERGROUP'|'NOT_GROUP'|'UNKNOWN'>=>{
  try{
   const result=await gateway.inspectTrialGroupKind(options.trialChatId);
   if(result==='GROUP'||result==='SUPERGROUP'||result==='NOT_GROUP')return result;
  }catch{/* Remote errors are not evidence of a verified group. */}
  return 'UNKNOWN';
 };
 const readRights=async():Promise<'GRANTED'|'DENIED'|'UNKNOWN'>=>{
  try{
   const result=await gateway.inspectBotModerationRights(options.trialChatId);
   if(result==='GRANTED'||result==='DENIED')return result;
  }catch{/* Remote errors are not proof of can_restrict_members. */}
  return 'UNKNOWN';
 };

 const first=await readGroup();
 let local=await verifyLocal();
 if(local)return local;
 const midpointRights=await readRights();
 local=await verifyLocal();
 if(local)return local;
 if(midpointRights!=='GRANTED')
  return make('NOT_CHECKED','CHANGED',['BOT_MODERATION_RIGHTS_CHANGED']);

 const second=await readGroup();
 local=await verifyLocal();
 if(local)return local;
 const finalRights=await readRights();
 local=await verifyLocal();
 if(local)return local;
 if(finalRights!=='GRANTED')
  return make('NOT_CHECKED','CHANGED',['BOT_MODERATION_RIGHTS_CHANGED']);

 if(first!==second)
  return make('CHANGED','GRANTED',['TRIAL_REMOTE_CHAT_KIND_CHANGED']);
 if(second==='NOT_GROUP')
  return make('NOT_GROUP','GRANTED',['TRIAL_REMOTE_CHAT_NOT_GROUP']);
 if(second==='UNKNOWN')
  return make('UNKNOWN','GRANTED',['TRIAL_REMOTE_CHAT_UNKNOWN']);
 return make(second,'GRANTED',[]);
}
