import {inspectOfflineModerationTrialScope,
 type OfflineModerationTrialOptions,type ModerationTrialBlocker} from './moderation-trial-scope.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

type Rights='GRANTED'|'DENIED'|'UNKNOWN';
type Probe=Pick<TelegramBotApiModerationGateway,'inspectBotModerationRights'>;
export interface ReadOnlyModerationRightsReport{
 readonly stage:'READ_ONLY_MODERATION_RIGHTS';
 readonly status:'PASS'|'BLOCKED';
 readonly safety:'STOP'|'RUN';
 readonly rollback:'MATCH'|'MISMATCH';
 readonly botRights:Rights|'NOT_CHECKED'|'CHANGED';
 readonly reasons:readonly (ModerationTrialBlocker|
  'BOT_MODERATION_RIGHTS_DENIED'|'BOT_MODERATION_RIGHTS_UNKNOWN'|
  'BOT_MODERATION_RIGHTS_CHANGED'|'BOT_MODERATION_GATEWAY_UNTRUSTED')[];
}
/** Two read-only Telegram bot-rights observations, surrounded by the existing
 * STOP, approved one-group, independent backup, and local policy gate.
 * A PASS is an advisory moment-in-time result, NOT permission to arm a sanction.
 * This function never calls setRestriction, contacts members, or writes state.
 * A concrete trusted TelegramBotApiModerationGateway supplies getChatMember.
 */
export async function inspectIsolatedModerationRightsReadOnly(
 options:OfflineModerationTrialOptions,
 gateway:Probe):Promise<ReadOnlyModerationRightsReport>{
 const initial=await inspectOfflineModerationTrialScope(options);
 const base=(current:typeof initial,botRights:ReadOnlyModerationRightsReport['botRights'],
  reasons:ReadOnlyModerationRightsReport['reasons']):ReadOnlyModerationRightsReport=>({
   stage:'READ_ONLY_MODERATION_RIGHTS',status:reasons.length?'BLOCKED':'PASS',
   safety:current.safety,rollback:current.rollback,botRights,reasons
  });
 if(initial.status!=='PASS')return base(initial,'NOT_CHECKED',initial.reasons);
 // No structural mock or overridden adapter may claim verified bot rights.
 // This never arms the separately disabled live moderation dispatch path.
 const authentic=()=>TelegramBotApiModerationGateway.usesOfficialRightsRead(gateway);
 const untrusted=(current:typeof initial)=>
  base(current,'NOT_CHECKED',['BOT_MODERATION_GATEWAY_UNTRUSTED']);
 if(!authentic())return untrusted(initial);
 const read=async():Promise<Rights>=>{
  try{
   const v=await gateway.inspectBotModerationRights(options.trialChatId);
   return v==='GRANTED'||v==='DENIED'?v:'UNKNOWN';
  }catch{return 'UNKNOWN';}
 };
 const first=await read();
 // The Telegram read may await network while the local operator revokes
 // approval or changes STOP. No second provider read if it is now unsafe.
 const midpoint=await inspectOfflineModerationTrialScope(options);
 if(midpoint.status!=='PASS')return base(midpoint,first,midpoint.reasons);
 // The adapter may itself be replaced while getChatMember awaited network.
 if(!authentic())return untrusted(midpoint);
 const second=await read();
 // Rights may change during a second network lookup; also recheck local
 // evidence at the end. Still cannot make the check+remote mutation atomic.
 const final=await inspectOfflineModerationTrialScope(options);
 if(final.status!=='PASS')return base(final,second,final.reasons);
 if(!authentic())return untrusted(final);
 if(first!==second)return base(final,'CHANGED',['BOT_MODERATION_RIGHTS_CHANGED']);
 if(second==='DENIED')return base(final,'DENIED',['BOT_MODERATION_RIGHTS_DENIED']);
 if(second==='UNKNOWN')return base(final,'UNKNOWN',['BOT_MODERATION_RIGHTS_UNKNOWN']);
 return base(final,'GRANTED',[]);
}
