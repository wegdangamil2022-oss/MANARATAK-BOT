import {createHash,randomBytes} from 'node:crypto';
import type {BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {GroupNetwork} from './group-network-model.js';
import {networkEmergencyStopped} from './network-emergency-stop.js';
import {isValidProtectionPolicy,isValidGroupProtectionRecord,
 type ProtectionPolicy,type GroupProtectionRecord} from './protection-rules.js';
import {validNetworkInheritanceLink,validNetworkInheritanceLinks,
 type NetworkInheritanceLink,type NetworkInheritancePauseReason} from './network-inheritance-model.js';

/** NETWORK-002, Phase 3 only: reviewed local moderation-policy templates.
 * No Telegram call, no automatic punishment, no Phase 4 greeting dependency. */
export const networkInheritanceDigest=(p:ProtectionPolicy):string=>
 createHash('sha256').update(JSON.stringify(p)).digest('hex');
const validClock=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000-600000;
function approvedMember(s:BotState,policy:Policy,actor:string,now:number,network:GroupNetwork,chatId:string):Chat|null{
 const rows=s.chats.filter(c=>c.id===chatId),chat=rows[0],
  member=network.members.filter(m=>m.chatId===chatId);
 if(rows.length!==1||!chat||!chat.approved||chat.version<1||member.length!==1||
  member[0]!.version!==chat.version||!chat.scopes.includes('moderation')||
  !policy.canUseChat(s,chatId,'moderation')||
  !policy.has(s,actor,'chat.manage',chatId,now))return null;
 return chat;
}
const templateAllowed=(p:ProtectionPolicy):boolean=>
 isValidProtectionPolicy(p)&&p.mode!=='ENFORCE'&&p.revision===1&&
 p.allowedDomains.length===0&&p.allowedPhrases.length===0&&p.exemptMemberIds.length===0&&
 (!p.ruleExemptions||p.ruleExemptions.length===0);
/** Must be called by a reviewed per-target owner transaction; only prepares
 * a candidate and grants no authority itself. */
export function prepareNetworkInheritance(s:BotState,policy:Policy,actor:string,now:number,
 kind:'POLICY',network:GroupNetwork,sourceId:string,targetId:string,sourceRevision:number,
 targetPolicy:ProtectionPolicy):NetworkInheritanceLink|null{
 if(kind!=='POLICY'||!validClock(now)||!policy.isOwner(actor)||
   !templateAllowed(targetPolicy)||targetPolicy.chatId!==targetId||
   !Number.isSafeInteger(sourceRevision)||sourceRevision<1||
   (s.networkInheritance??[]).length>=500||
   !validNetworkInheritanceLinks(s.networkInheritance??[])||
   networkEmergencyStopped(s,network.id))return null;
 const source=approvedMember(s,policy,actor,now,network,sourceId),
  target=approvedMember(s,policy,actor,now,network,targetId);
 const linked=(s.networkInheritance??[]).filter(x=>x.kind===kind);
 if(!source||!target||sourceId===targetId||linked.some(x=>
  x.targetChatId===targetId||x.status==='ACTIVE'&&(x.targetChatId===sourceId||x.sourceChatId===targetId)))return null;
 const origin=(s.protectionPolicies??[]).filter(x=>x.policy.chatId===sourceId),
  original=origin[0];
 if(origin.length!==1||!original||!isValidGroupProtectionRecord(original)||
  original.chatPolicyVersion!==source.version||original.policy.revision!==sourceRevision||
  original.updatedAt>now||original.policy.mode==='ENFORCE')return null;
 const targetRecords=(s.protectionPolicies??[]).filter(x=>x.policy.chatId===targetId);
 if(targetRecords.length!==1||!targetRecords[0]||!isValidGroupProtectionRecord(targetRecords[0])||
  targetRecords[0].chatPolicyVersion!==target.version||
  targetRecords[0].policy.revision!==targetPolicy.revision||
  JSON.stringify(targetRecords[0].policy)!==JSON.stringify(targetPolicy))return null;
 const id=randomBytes(6).toString('hex');
 if(linked.some(x=>x.id===id))return null;
 const link:NetworkInheritanceLink={id,kind:'POLICY',networkId:network.id,
  networkRevision:network.revision,sourceChatId:sourceId,sourceChatVersion:source.version,
  sourceRevision,targetChatId:targetId,targetChatVersion:target.version,targetRevision:1,
  targetDigest:networkInheritanceDigest(targetPolicy),createdAt:now,lastSyncedAt:now,status:'ACTIVE'};
 return validNetworkInheritanceLink(link)?link:null;
}
const pause=(link:NetworkInheritanceLink,reason:NetworkInheritancePauseReason):void=>{
 link.status='PAUSED';link.pausedReason=reason;
};
/** Manual local policy overrides win over inherited network drafts. */
export function pauseNetworkInheritanceForLocalEdit(s:BotState,kind:'POLICY',chatId:string):number{
 let result=0;
 for(const l of s.networkInheritance??[])if(l.kind===kind&&l.targetChatId===chatId&&l.status==='ACTIVE'){
  pause(l,'LOCAL_OVERRIDE');result++;
 }
 return result;
}
export function pauseNetworkInheritanceByOwner(s:BotState,id:string):boolean{
 const rows=(s.networkInheritance??[]).filter(x=>x.id===id),row=rows[0];
 if(rows.length!==1||!row||row.status!=='ACTIVE')return false;
 pause(row,'OWNER_PAUSED');return true;
}
export type NetworkInheritanceSyncReport={updated:number;unchanged:number;paused:number};
/** Runs inside the same BotStore transaction as the approved source change.
 * Every linked target is reauthorized and compared against a full target digest.
 * No source allowlist, exception, rule-exemption or enforcement grant crosses. */
export function synchronizeNetworkInheritance(s:BotState,policy:Policy,actor:string,now:number,
 kind:'POLICY',sourceId:string):NetworkInheritanceSyncReport{
 const result:NetworkInheritanceSyncReport={updated:0,unchanged:0,paused:0};
 const links=(s.networkInheritance??[]).filter(x=>x.kind===kind&&
  x.sourceChatId===sourceId&&x.status==='ACTIVE');
 for(const link of links){
  let reason:NetworkInheritancePauseReason|null=null;
  if(networkEmergencyStopped(s,link.networkId))reason='NETWORK_EMERGENCY';
  const candidates=(s.groupNetworks??[]).filter(n=>n.id===link.networkId),n=candidates[0];
  if(!reason&&(!validClock(now)||!policy.isOwner(actor)))reason='OWNER_REQUIRED';
  else if(candidates.length!==1||!n||n.revision!==link.networkRevision)reason='NETWORK_STALE';
  const from=n&&!reason?approvedMember(s,policy,actor,now,n,link.sourceChatId):null;
  const to=n&&!reason?approvedMember(s,policy,actor,now,n,link.targetChatId):null;
  if(!reason&&(!from||!to||from.version!==link.sourceChatVersion||
   to.version!==link.targetChatVersion))reason='GROUP_STALE';
  const sourceRows=(s.protectionPolicies??[]).filter(r=>r.policy.chatId===sourceId),
   targetRows=(s.protectionPolicies??[]).filter(r=>r.policy.chatId===link.targetChatId),
   source=sourceRows[0],target=targetRows[0];
  if(!reason&&(sourceRows.length!==1||!source||!isValidGroupProtectionRecord(source)||
   source.chatPolicyVersion!==link.sourceChatVersion||
   source.updatedAt>now||source.policy.mode==='ENFORCE'||source.policy.revision!==link.sourceRevision+1))
   reason='SOURCE_STALE';
  if(!reason&&(targetRows.length!==1||!target||!isValidGroupProtectionRecord(target)||
   target.chatPolicyVersion!==link.targetChatVersion||
   target.updatedAt>now||target.policy.mode==='ENFORCE'||target.policy.revision!==link.targetRevision||
   networkInheritanceDigest(target.policy)!==link.targetDigest))reason='TARGET_STALE';
  if(!reason&&target!.policy.revision>=2_000_000_000)reason='CAP_EXCEEDED';
  if(reason){pause(link,reason);result.paused++;continue;}
  const previous=target!.policy,sourcePolicy=source!.policy;
  const draft:ProtectionPolicy={chatId:link.targetChatId,revision:previous.revision+1,
   mode:sourcePolicy.mode,rules:structuredClone(sourcePolicy.rules),
   allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],
   ...(sourcePolicy.flood?{flood:structuredClone(sourcePolicy.flood)}:{})};
  if(!isValidProtectionPolicy(draft)){pause(link,'SOURCE_STALE');result.paused++;continue;}
  if(JSON.stringify({...draft,revision:previous.revision})===JSON.stringify(previous)){
   link.sourceRevision=sourcePolicy.revision;link.lastSyncedAt=now;result.unchanged++;continue;
  }
  target!.policy=draft;target!.updatedBy=actor;target!.updatedAt=now;
  if(s.protectionFloodWindows)s.protectionFloodWindows=s.protectionFloodWindows.filter(x=>x.chatId!==link.targetChatId);
  link.sourceRevision=sourcePolicy.revision;link.targetRevision=draft.revision;
  link.targetDigest=networkInheritanceDigest(draft);link.lastSyncedAt=now;result.updated++;
 }
 if(result.updated||result.paused){
  const key='network-follow:POLICY:'+createHash('sha256').update(JSON.stringify([
   sourceId,now,links.map(x=>[x.id,x.sourceRevision,x.targetRevision,x.status])])).digest('hex');
  if(!s.audit.some(x=>x.updateKey===key))s.audit.push({actorId:actor,updateKey:key,
   decision:'ALLOW',reason:'NETWORK_INHERITANCE_RESULT_UPDATED_'+result.updated+
    '_PAUSED_'+result.paused,policyVersion:0,at:now});
 }
 return result;
}
