import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';
import {validNetworkInheritanceLinks} from './network-inheritance-model.js';
import {validNetworkEmergencyControls,networkEmergencyStopped}
 from './network-emergency-stop.js';
import {isValidGroupProtectionRecord} from './protection-rules.js';
import {validNetworkWatchCases} from './network-watchlist-model.js';
import {validNetworkSanctionReviews,validNetworkSanctionReviewReferences}
 from './network-sanction-review-model.js';

/** NETWORK-004 diagnostic snapshot, strictly local: it cannot prove current
 * Telegram administrator rights and must never grant or execute sanctions.
 */
export type NetworkGroupLocalStatus=
 'READY'|'NO_MODERATION_SCOPE'|'STALE'|'REVOKED'|'DUPLICATE';
export type NetworkGroupPolicyStatus='OFF'|'MONITOR'|'ENFORCE'|'MISSING'|'INVALID';
export interface NetworkGroupDiagnostic{
 readonly id:string;readonly membershipVersion:number;
 readonly status:NetworkGroupLocalStatus;readonly locallyPresent:boolean|null;
 readonly policy:NetworkGroupPolicyStatus;
 readonly policyRevision:number|null;
 readonly assistant:string;
 readonly activeFollows:number;readonly pausedFollows:number;
 readonly watchPending:number;readonly sanctionPending:number;
}
export interface NetworkHealthSummary{
 readonly networkId:string;readonly networkName:string;
 readonly networkRevision:number;
 readonly stopped:boolean;readonly emergencyRevision:number;
 readonly groups:readonly NetworkGroupDiagnostic[];
 readonly ready:number;readonly stale:number;readonly revoked:number;
 readonly duplicates:number;readonly withoutModeration:number;
 readonly off:number;readonly monitor:number;readonly enforce:number;
 readonly invalidPolicies:number;readonly noPolicy:number;
 readonly locallyAbsent:number;readonly presenceUnconfirmed:number;
 readonly activeFollows:number;readonly pausedFollows:number;
 readonly watchPending:number;readonly sanctionPending:number;
 readonly incomplete:boolean;
}
const time=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000;
export function networkHealthSummary(s:BotState,p:Policy,actor:string,
 networkId:string,now:number):NetworkHealthSummary|null{
 if(!time(now)||!p.isOwner(actor)||!p.privateFeature(s,'owner.dashboard',actor)||
  !/^[a-f0-9]{12}$/u.test(networkId)||
  !validNetworkInheritanceLinks(s.networkInheritance??[])||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  !validNetworkWatchCases(s.networkWatchCases??[])||
  !validNetworkSanctionReviews(s.networkSanctionReviews??[])||
  !validNetworkSanctionReviewReferences(
   s.networkSanctionReviews??[],s.networkWatchCases??[]))return null;
 const nets=(s.groupNetworks??[]).filter(n=>n.id===networkId),n=nets[0];
 if(nets.length!==1||!n||!validGroupNetwork(n)||n.updatedAt>now)return null;
 const controls=(s.networkEmergencyControls??[]).filter(c=>c.networkId===networkId);
 if(controls.length>1)return null;
 const groups:NetworkGroupDiagnostic[]=[];
 for(const member of n.members){
  const matching=s.chats.filter(c=>c.id===member.chatId),chat=matching[0];
  let status:NetworkGroupLocalStatus='STALE';
  if(matching.length>1)status='DUPLICATE';
  else if(chat&&!chat.approved)status='REVOKED';
  else if(chat&&chat.approved&&chat.version===member.version){
   status=chat.scopes.includes('moderation')&&
    p.canUseChat(s,chat.id,'moderation')&&
    p.has(s,actor,'chat.manage',chat.id,now)?'READY':'NO_MODERATION_SCOPE';
  }
  const matches=(s.protectionPolicies??[]).filter(x=>x.policy.chatId===member.chatId),
   policy=matches[0];
  let mode:NetworkGroupPolicyStatus='MISSING',revision:number|null=null;
  if(matches.length>1)mode='INVALID';
  else if(policy){
   if(!chat||!isValidGroupProtectionRecord(policy)||
    policy.chatPolicyVersion!==member.version||policy.updatedAt>now)
    mode='INVALID';
   else {mode=policy.policy.mode;revision=policy.policy.revision;}
  }
  const followRows=(s.networkInheritance??[]).filter(x=>x.networkId===networkId&&
   (x.sourceChatId===member.chatId||x.targetChatId===member.chatId));
  const watches=(s.networkWatchCases??[]).filter(c=>
   c.networkId===networkId&&c.sourceChatId===member.chatId&&
   c.sourceChatVersion===member.version&&c.submittedAt<=now&&c.status==='PENDING');
  const sanctions=(s.networkSanctionReviews??[]).filter(c=>
   c.networkId===networkId&&c.targetChatId===member.chatId&&
   c.targetChatVersion===member.version&&c.status==='PENDING'&&
   c.requestedAt<=now);
  groups.push({id:member.chatId,membershipVersion:member.version,status,
   locallyPresent:chat?.present??null,policy:mode,policyRevision:revision,
   assistant:chat?.groupAI??'غير مؤكد',
   activeFollows:followRows.filter(x=>x.status==='ACTIVE').length,
   pausedFollows:followRows.filter(x=>x.status==='PAUSED').length,
   watchPending:watches.length,sanctionPending:sanctions.length});
 }
 groups.sort((a,b)=>a.id.localeCompare(b.id));
 const count=(f:(x:NetworkGroupDiagnostic)=>boolean)=>groups.filter(f).length;
 // A link touching two groups is ONE dependency; do not double-count it in
 // the network-level totals.
 const ownFollows=(s.networkInheritance??[]).filter(x=>x.networkId===networkId);
 return {networkId,networkName:n.name,networkRevision:n.revision,
  stopped:networkEmergencyStopped(s,networkId),
  emergencyRevision:controls[0]?.revision??0,groups,
  ready:count(x=>x.status==='READY'),
  stale:count(x=>x.status==='STALE'),
  revoked:count(x=>x.status==='REVOKED'),
  duplicates:count(x=>x.status==='DUPLICATE'),
  withoutModeration:count(x=>x.status==='NO_MODERATION_SCOPE'),
  off:count(x=>x.policy==='OFF'),
  monitor:count(x=>x.policy==='MONITOR'),
  enforce:count(x=>x.policy==='ENFORCE'),
  invalidPolicies:count(x=>x.policy==='INVALID'),
  noPolicy:count(x=>x.policy==='MISSING'),
  // Local cached presence is diagnostic, never a Telegram rights witness.
  // Mark the gap even if stale grants still make the group appear READY.
  locallyAbsent:count(x=>x.locallyPresent===false),
  presenceUnconfirmed:count(x=>x.locallyPresent===null),
  activeFollows:ownFollows.filter(x=>x.status==='ACTIVE').length,
  pausedFollows:ownFollows.filter(x=>x.status==='PAUSED').length,
  watchPending:groups.reduce((a,x)=>a+x.watchPending,0),
  sanctionPending:groups.reduce((a,x)=>a+x.sanctionPending,0),
  incomplete:groups.some(g=>g.status!=='READY'||g.policy==='MISSING'||
   g.policy==='INVALID'||g.locallyPresent!==true)
 };
}
