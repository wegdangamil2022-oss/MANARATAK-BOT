import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';
import {isValidGroupProtectionRecord,isValidProtectionPolicy,
 type ProtectionPolicy} from './protection-rules.js';
import {summarizeNetworkSettings,type ComparisonField} from './network-policy-diff.js';

/** Historical, locally stored policies for NETWORK-005. This structure is
 * never permission to reinstate a policy or dispatch Telegram sanctions. */
export interface NetworkPolicySnapshot{
 id:string;networkId:string;networkRevision:number;chatId:string;
 chatVersion:number;policyRevision:number;capturedBy:string;capturedAt:number;
 digest:string;policy:ProtectionPolicy;
}
export interface NetworkPolicySnapshotPreview{
 networkId:string;chatId:string;chatVersion:number;networkRevision:number;
 policyRevision:number;mode:ProtectionPolicy['mode'];ruleCount:number;
 digest:string;/** Full config digest (also bound to the consent receipt). */
 proof:string;
}
export interface NetworkPolicySnapshotInspection{
 snapshot:NetworkPolicySnapshot;currentStatus:'CURRENT'|'STALE'|'MISSING'|'INVALID';
 comparable:boolean;equivalent:boolean;differences:ComparisonField[];
 emergencyStopped:boolean;
}
const net=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{12}$/u.test(x);
const chat=(x:unknown):x is string=>typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const owner=(x:unknown):x is string=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const revision=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=1&&x<=9_999_999_999;
const clock=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000;
const sha=(payload:unknown)=>createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const digest=(v:Omit<NetworkPolicySnapshot,'digest'>)=>sha([
 v.id,v.networkId,v.networkRevision,v.chatId,v.chatVersion,
 v.policyRevision,v.capturedBy,v.capturedAt,v.policy
]);
const fields:readonly Exclude<ComparisonField,'groupAI'|'scopes'|'policyStatus'>[]=[
 'mode','rules','allowedDomains','allowedPhrases','exemptMemberIds','flood',
 'joinRaid','night','raid','escalation','temporaryExemptions','ruleExemptions'
];
export function isValidNetworkPolicySnapshot(v:unknown):v is NetworkPolicySnapshot{
 if(v===null||typeof v!=='object'||Array.isArray(v))return false;
 const s=v as Record<string,unknown>;
 const keys=['id','networkId','networkRevision','chatId','chatVersion',
  'policyRevision','capturedBy','capturedAt','digest','policy'];
 if(Object.keys(s).length!==keys.length||keys.some(key=>!Object.hasOwn(s,key))||
  !net(s.id)||!net(s.networkId)||!revision(s.networkRevision)||!chat(s.chatId)||
  !revision(s.chatVersion)||!revision(s.policyRevision)||!owner(s.capturedBy)||
  !clock(s.capturedAt)||typeof s.digest!=='string'||!/^[a-f0-9]{64}$/u.test(s.digest)||
  !isValidProtectionPolicy(s.policy))return false;
 const policy=s.policy as ProtectionPolicy;
 if(policy.chatId!==s.chatId||policy.revision!==s.policyRevision)return false;
 return digest(s as unknown as NetworkPolicySnapshot)===s.digest;
}
export function isValidNetworkPolicySnapshots(v:unknown):v is NetworkPolicySnapshot[]{
 if(!Array.isArray(v)||v.length>100||v.some(x=>!isValidNetworkPolicySnapshot(x)))return false;
 const ids=new Set<string>(),counts=new Map<string,number>();
 for(const item of v as NetworkPolicySnapshot[]){
  if(ids.has(item.id))return false;
  ids.add(item.id);
  const key=JSON.stringify([item.networkId,item.chatId]);
  const n=(counts.get(key)??0)+1;counts.set(key,n);
  if(n>5)return false;
 }
 return true;
}
const accessible=(s:BotState,policy:Policy,actor:string,now:number,networkId:string,chatId:string)=>{
 if(!policy.isOwner(actor)||!policy.privateFeature(s,'owner.dashboard',actor)||
  !clock(now)||!net(networkId)||!chat(chatId)||
  !isValidNetworkPolicySnapshots(s.networkPolicySnapshots??[]))return null;
 const networks=(s.groupNetworks??[]).filter(x=>x.id===networkId);
 const network=networks[0];
 if(networks.length!==1||!network||!validGroupNetwork(network)||network.updatedAt>now)return null;
 const member=network.members.find(m=>m.chatId===chatId);
 const chats=s.chats.filter(x=>x.id===chatId),current=chats[0];
 if(!member||chats.length!==1||!current||!current.approved||current.version!==member.version||
  !current.scopes.includes('moderation')||
  !policy.has(s,actor,'chat.manage',chatId,now))return null;
 const policies=(s.protectionPolicies??[]).filter(x=>x?.policy?.chatId===chatId);
 const record=policies[0];
 if(policies.length!==1||!record||!isValidGroupProtectionRecord(record)||
  record.chatPolicyVersion!==current.version||record.updatedAt>now)return null;
 return {network,current,record};
};
/** No persisted mutation: this is the exact prospective capture (no history
 * can be created for a stale approval, duplicate record, or foreign network). */
export function previewNetworkPolicySnapshot(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string,chatId:string
):NetworkPolicySnapshotPreview|null{
 const current=accessible(s,policy,actor,now,networkId,chatId);
 if(!current)return null;
 const captures=(s.networkPolicySnapshots??[]).filter(x=>x.networkId===networkId&&x.chatId===chatId);
 if(captures.length>=5||(s.networkPolicySnapshots??[]).length>=100)return null;
 return {
  networkId,chatId,networkRevision:current.network.revision,
  chatVersion:current.current.version,
  policyRevision:current.record.policy.revision,
  mode:current.record.policy.mode,ruleCount:current.record.policy.rules.length,
  digest:sha(current.record.policy),
  proof:sha([current.network,s.chats,s.grants,s.protectionPolicies??[],
   s.networkPolicySnapshots??[],s.privateFeatures,s.privateSettingsRevision??null])
 };
}
/** Run only inside BotStore.transaction after one-shot consent validation.
 * Appends an immutable clone; never touches the live protection policy. */
export function captureNetworkPolicySnapshot(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string,chatId:string,id:string
):NetworkPolicySnapshot|null{
 if(!net(id)||(s.networkPolicySnapshots??[]).some(x=>x.id===id))return null;
 const preview=previewNetworkPolicySnapshot(s,policy,actor,now,networkId,chatId);
 const access=accessible(s,policy,actor,now,networkId,chatId);
 if(!preview||!access)return null;
 const entry:Omit<NetworkPolicySnapshot,'digest'>={
  id,networkId,networkRevision:access.network.revision,chatId,
  chatVersion:access.current.version,policyRevision:access.record.policy.revision,
  capturedBy:actor,capturedAt:now,policy:structuredClone(access.record.policy)
 };
 const snapshot:NetworkPolicySnapshot={...entry,digest:digest(entry)};
 const result=[...(s.networkPolicySnapshots??[]),snapshot];
 if(!isValidNetworkPolicySnapshots(result))return null;
 s.networkPolicySnapshots=result;
 return snapshot;
}
/** Historical comparison includes only field NAMES; never return raw diff
 * content in a human-facing text response. Stored policy is not a restore token. */
export function inspectSavedNetworkPolicy(
 s:BotState,policy:Policy,actor:string,now:number,id:string
):NetworkPolicySnapshotInspection|null{
 if(!net(id)||!clock(now)||!policy.isOwner(actor)||
  !policy.privateFeature(s,'owner.dashboard',actor)||
  !isValidNetworkPolicySnapshots(s.networkPolicySnapshots??[]))return null;
 const rows=(s.networkPolicySnapshots??[]).filter(x=>x.id===id),item=rows[0];
 if(rows.length!==1||!item||item.capturedAt>now||!isValidNetworkPolicySnapshot(item))return null;
 const overview=summarizeNetworkSettings(s,policy,actor,now,item.networkId);
 if(!overview||!overview.members.some(x=>x.chatId===item.chatId))return null;
 const m=overview.members.find(x=>x.chatId===item.chatId)!;
 const currentStatus=m.status!=='CURRENT'?'STALE':
  m.policyStatus==='MISSING'?'MISSING':
  m.policyStatus!=='CURRENT'?'INVALID':'CURRENT';
 const current=currentStatus==='CURRENT'?
  (s.protectionPolicies??[]).find(x=>x.policy.chatId===item.chatId):undefined;
 const differences:ComparisonField[]=[];
 if(current&&isValidGroupProtectionRecord(current)){
  for(const field of fields)
   if(JSON.stringify(item.policy[field])!==JSON.stringify(current.policy[field]))
    differences.push(field);
 }
 const comparable=currentStatus==='CURRENT';
 return {snapshot:item,currentStatus,comparable,
  equivalent:comparable&&differences.length===0,
  differences,emergencyStopped:overview.emergencyStopped};
}
