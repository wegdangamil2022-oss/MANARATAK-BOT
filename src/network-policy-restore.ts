import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {networkEmergencyStopped,validNetworkEmergencyControls} from './network-emergency-stop.js';
import {validNetworkInheritanceLinks} from './network-inheritance-model.js';
import {isValidGroupProtectionRecord,isValidProtectionPolicy,
 type ProtectionPolicy} from './protection-rules.js';
import {isValidNetworkPolicySnapshots,type NetworkPolicySnapshot} from './network-policy-snapshots.js';
import {validGroupNetwork} from './group-network-model.js';

export type RestorablePolicyField=
 'rules'|'allowedDomains'|'allowedPhrases'|'exemptMemberIds'|
 'flood'|'joinRaid'|'night'|'raid'|'escalation'|
 'temporaryExemptions'|'ruleExemptions';
export const restoreFields:readonly RestorablePolicyField[]=[
 'rules','allowedDomains','allowedPhrases','exemptMemberIds',
 'flood','joinRaid','night','raid','escalation',
 'temporaryExemptions','ruleExemptions'
];
export interface NetworkPolicyRestorePreview{
 snapshotId:string;networkId:string;chatId:string;
 currentRevision:number;archiveRevision:number;networkRevision:number;
 currentMode:'OFF'|'MONITOR';archiveMode:'OFF'|'MONITOR';
 changedFields:RestorablePolicyField[];
 pausedLinks:number;proof:string;
}
export interface NetworkPolicyRestoreResult{
 snapshotId:string;chatId:string;newRevision:number;
 currentMode:'OFF'|'MONITOR';changedFields:RestorablePolicyField[];
 pausedLinks:number;
}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clock=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000-120_000;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Full proof prevents even a change in another group from silently
 * changing the owner-reviewed impact. It includes external-network follows. */
function proof(s:BotState,snapshotId:string):string{
 return digest([snapshotId,s.groupNetworks??[],s.chats,s.grants,
  s.protectionPolicies??[],s.networkPolicySnapshots??[],s.networkInheritance??[],
  s.networkEmergencyControls??[],s.privateFeatures,s.privateSettingsRevision??null,
  s.protectionFloodWindows??[]]);
}
/** Preview requires the archived policy to belong to the SAME approval and
 * network epochs. Saved ENFORCE policies and live ENFORCE policies cannot be
 * applied by this workflow, even if the owner is authorized. Historical mode
 * is never copied; OFF stays OFF and MONITOR stays MONITOR. */
export function previewNetworkPolicyRestore(
 s:BotState,policy:Policy,actor:string,now:number,snapshotId:string
):NetworkPolicyRestorePreview|null{
 if(!clock(now)||!policy.isOwner(actor)||
  !policy.privateFeature(s,'owner.dashboard',actor)||!id(snapshotId)||
  !isValidNetworkPolicySnapshots(s.networkPolicySnapshots??[])||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  !validNetworkInheritanceLinks(s.networkInheritance??[]))return null;
 const versions=(s.networkPolicySnapshots??[]).filter(x=>x.id===snapshotId);
 const archive:NetworkPolicySnapshot|undefined=versions[0];
 if(versions.length!==1||!archive||archive.capturedAt>now||
  archive.policy.mode==='ENFORCE')return null;
 const nets=(s.groupNetworks??[]).filter(x=>x.id===archive.networkId),network=nets[0];
 if(nets.length!==1||!network||!validGroupNetwork(network)||
  network.revision!==archive.networkRevision||network.updatedAt>now||
  networkEmergencyStopped(s,archive.networkId))return null;
 const members=network.members.filter(x=>x.chatId===archive.chatId),member=members[0];
 const chats=s.chats.filter(x=>x.id===archive.chatId),chat=chats[0];
 if(members.length!==1||!member||chats.length!==1||!chat||
  !chat.approved||chat.version!==member.version||
  chat.version!==archive.chatVersion||!chat.scopes.includes('moderation')||
  !policy.has(s,actor,'chat.manage',archive.chatId,now))return null;
 const rows=(s.protectionPolicies??[]).filter(x=>x?.policy?.chatId===archive.chatId),
  record=rows[0];
 if(rows.length!==1||!record||!isValidGroupProtectionRecord(record)||
  record.chatPolicyVersion!==chat.version||record.updatedAt>now||
  record.policy.revision>=2_000_000_000||record.policy.mode==='ENFORCE')return null;
 const changedFields=restoreFields.filter(key=>
  !same(archive.policy[key],record.policy[key]));
 if(!changedFields.length)return null;
 const pausedLinks=(s.networkInheritance??[]).filter(link=>
  link.status==='ACTIVE'&&(link.sourceChatId===archive.chatId||
   link.targetChatId===archive.chatId)).length;
 return {snapshotId,networkId:archive.networkId,chatId:archive.chatId,
  currentRevision:record.policy.revision,archiveRevision:archive.policyRevision,
  networkRevision:network.revision,currentMode:record.policy.mode,
  archiveMode:archive.policy.mode,changedFields,pausedLinks,
  proof:proof(s,snapshotId)};
}
/** Invoke inside the SAME BotStore.transaction that consumes a one-shot
 * receipt. Re-evaluate the preview before changing a single record. */
export function applyNetworkPolicyRestore(
 s:BotState,policy:Policy,actor:string,now:number,snapshotId:string,
 expectedProof?:string
):NetworkPolicyRestoreResult|null{
 const current=previewNetworkPolicyRestore(s,policy,actor,now,snapshotId);
 if(!current||(expectedProof!==undefined&&current.proof!==expectedProof))return null;
 const saved=(s.networkPolicySnapshots??[]).find(x=>x.id===snapshotId)!;
 const live=(s.protectionPolicies??[]).find(x=>x.policy.chatId===saved.chatId)!;
 const restored:ProtectionPolicy=structuredClone(saved.policy);
 restored.chatId=saved.chatId;
 restored.mode=current.currentMode; // NEVER enable MONITOR or ENFORCE.
 restored.revision=current.currentRevision+1;
 if(!isValidProtectionPolicy(restored))return null;
 live.policy=restored;
 live.updatedAt=now;
 live.updatedBy=actor;
 if(s.protectionFloodWindows)
  s.protectionFloodWindows=s.protectionFloodWindows.filter(row=>row.chatId!==saved.chatId);
 let pausedLinks=0;
 for(const link of s.networkInheritance??[]){
  if(link.status!=='ACTIVE')continue;
  if(link.targetChatId===saved.chatId){
   link.status='PAUSED';link.pausedReason='LOCAL_OVERRIDE';pausedLinks++;
  }else if(link.sourceChatId===saved.chatId){
   link.status='PAUSED';link.pausedReason='SOURCE_STALE';pausedLinks++;
  }
 }
 return {snapshotId,chatId:saved.chatId,newRevision:restored.revision,
  currentMode:restored.mode,changedFields:current.changedFields,pausedLinks};
}
