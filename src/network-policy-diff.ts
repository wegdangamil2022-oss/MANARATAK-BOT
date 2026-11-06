import type {BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import {isValidGroupNetwork} from './group-network-model.js';
import {isValidGroupProtectionRecord,type GroupProtectionRecord,type ProtectionPolicy}
 from './protection-rules.js';
import {networkEmergencyStopped} from './network-emergency-stop.js';

/** NETWORK-005 read-only comparisons. Never copy rule literals, member IDs,
 * domains, allowed phrases or exemption values into UI output. Each read
 * rechecks approved group versions and owner capability from current state. */
export type NetworkMemberStatus='CURRENT'|'STALE'|'REVOKED'|'DUPLICATE'|'MISSING';
export type NetworkPolicyStatus=
 'CURRENT'|'MISSING'|'STALE'|'DUPLICATE'|'CORRUPT'|'UNAVAILABLE';
export interface NetworkSettingsMember{
 chatId:string;status:NetworkMemberStatus;version:number;
 groupAI:string|null;policyStatus:NetworkPolicyStatus;
}
export interface NetworkSettingsOverview{
 networkId:string;networkName:string;networkRevision:number;emergencyStopped:boolean;
 members:NetworkSettingsMember[];
 current:number;stale:number;unavailablePolicies:number;
}
export type ComparisonField='groupAI'|'scopes'|'policyStatus'|'mode'|
 'rules'|'allowedDomains'|'allowedPhrases'|'exemptMemberIds'|
 'flood'|'joinRaid'|'night'|'raid'|'escalation'|
 'temporaryExemptions'|'ruleExemptions';
export interface NetworkSettingsDifference{
 field:ComparisonField;source:string;target:string;
}
export interface NetworkSettingsComparison{
 source:NetworkSettingsMember;target:NetworkSettingsMember;
 comparable:boolean;equivalent:boolean;differences:NetworkSettingsDifference[];
 emergencyStopped:boolean;
}
const policyFields:readonly Exclude<ComparisonField,'groupAI'|'scopes'|'policyStatus'>[]=[
 'mode','rules','allowedDomains','allowedPhrases','exemptMemberIds',
 'flood','joinRaid','night','raid','escalation',
 'temporaryExemptions','ruleExemptions'
];
const validClock=(t:number)=>Number.isSafeInteger(t)&&t>=0&&t<=8_640_000_000_000_000;
const validId=(id:string)=>/^-[1-9][0-9]{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function memberWithPolicy(s:BotState,chat:Chat,now:number):NetworkSettingsMember{
 const records=(s.protectionPolicies??[]).filter(x=>x?.policy?.chatId===chat.id);
 const status:NetworkPolicyStatus=records.length>1?'DUPLICATE':
  records.length===0?'MISSING':
  !isValidGroupProtectionRecord(records[0])?'CORRUPT':
  records[0]!.chatPolicyVersion!==chat.version||records[0]!.updatedAt>now?'STALE':'CURRENT';
 return {chatId:chat.id,status:'CURRENT',version:chat.version,
  groupAI:chat.groupAI,policyStatus:status};
}
function currentMember(
 s:BotState,policy:Policy,actor:string,now:number,id:string,expected:number
):NetworkSettingsMember{
 const rows=s.chats.filter(x=>x.id===id),chat=rows[0];
 if(rows.length>1)return {chatId:id,status:'DUPLICATE',version:expected,
  groupAI:null,policyStatus:'UNAVAILABLE'};
 if(!rows.length||!chat)return {chatId:id,status:'MISSING',version:expected,
  groupAI:null,policyStatus:'UNAVAILABLE'};
 if(!chat.approved)return {chatId:id,status:'REVOKED',version:expected,
  groupAI:null,policyStatus:'UNAVAILABLE'};
 if(chat.version!==expected||!policy.has(s,actor,'chat.manage',id,now))
  return {chatId:id,status:'STALE',version:expected,groupAI:null,policyStatus:'UNAVAILABLE'};
 return memberWithPolicy(s,chat,now);
}
/** Includes invalid/stale association *counts*, never treats them as grants. */
export function summarizeNetworkSettings(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string
):NetworkSettingsOverview|null{
 if(!validClock(now)||!policy.isOwner(actor)||
  !policy.privateFeature(s,'owner.dashboard',actor)||
  !/^[a-f0-9]{12}$/u.test(networkId))return null;
 const rows=(s.groupNetworks??[]).filter(n=>n.id===networkId),n=rows[0];
 if(rows.length!==1||!n||!isValidGroupNetwork(n)||n.updatedAt>now)return null;
 const members:NetworkSettingsMember[]=[];
 for(const m of n.members){
  if(!validId(m.chatId))return null;
  members.push(currentMember(s,policy,actor,now,m.chatId,m.version));
 }
 members.sort((a,b)=>a.chatId.localeCompare(b.chatId));
 const current=members.filter(x=>x.status==='CURRENT').length;
 const unavailablePolicies=members.filter(x=>x.status==='CURRENT'&&
  x.policyStatus!=='CURRENT').length;
 return {networkId:n.id,networkName:n.name,networkRevision:n.revision,
  emergencyStopped:networkEmergencyStopped(s,n.id),
  members,current,stale:members.length-current,unavailablePolicies};
}
const policyFor=(s:BotState,id:string):GroupProtectionRecord|null=>{
 const rows=(s.protectionPolicies??[]).filter(x=>x?.policy?.chatId===id);
 return rows.length===1&&isValidGroupProtectionRecord(rows[0])?rows[0]!:null;
};
const count=(v:unknown):string=>Array.isArray(v)?String(v.length)+' عنصر':
 v===undefined?'غير مفعّل':typeof v==='object'&&v!==null?'مضبوط':
 String(v);
/** Compare only stable config (not chatId/revisions/editor/timestamp).
 * Content fingerprint comparisons stay in memory; callers only get
 * aggregate values and field labels, never literal rule/domain content. */
export function compareNetworkGroupSettings(
 s:BotState,policy:Policy,actor:string,now:number,
 networkId:string,sourceId:string,targetId:string
):NetworkSettingsComparison|null{
 const overview=summarizeNetworkSettings(s,policy,actor,now,networkId);
 if(!overview||!validId(sourceId)||!validId(targetId)||sourceId===targetId)return null;
 const source=overview.members.find(x=>x.chatId===sourceId);
 const target=overview.members.find(x=>x.chatId===targetId);
 if(!source||!target||source.status!=='CURRENT'||target.status!=='CURRENT'||
  [source.policyStatus,target.policyStatus].some(x=>x==='CORRUPT'||x==='DUPLICATE'))return null;
 const differences:NetworkSettingsDifference[]=[];
 const add=(field:ComparisonField,a:unknown,b:unknown)=>{
  if(!same(a,b))differences.push({field,source:count(a),target:count(b)});
 };
 add('groupAI',source.groupAI,target.groupAI);
 const sourceChat=s.chats.find(x=>x.id===sourceId)!;
 const targetChat=s.chats.find(x=>x.id===targetId)!;
 add('scopes',[...sourceChat.scopes].sort(),[...targetChat.scopes].sort());
 if(source.policyStatus!=='CURRENT'||target.policyStatus!=='CURRENT'){
  differences.push({field:'policyStatus',source:source.policyStatus,target:target.policyStatus});
 }else{
  const sp=policyFor(s,sourceId)?.policy,tp=policyFor(s,targetId)?.policy;
  if(!sp||!tp)return null;
  for(const field of policyFields)add(field,sp[field],tp[field]);
 }
 const comparable=source.policyStatus==='CURRENT'&&target.policyStatus==='CURRENT';
 return {source,target,comparable,equivalent:comparable&&differences.length===0,
  differences,emergencyStopped:overview.emergencyStopped};
}
