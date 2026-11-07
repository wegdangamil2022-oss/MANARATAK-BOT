import {createHash} from 'node:crypto';
import type {BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';
import {networkEmergencyStopped,validNetworkEmergencyControls} from './network-emergency-stop.js';
import {validNetworkInheritanceLinks} from './network-inheritance-model.js';
import {isValidGroupProtectionRecord,isValidProtectionPolicy,
 type ProtectionPolicy,type GroupProtectionRecord} from './protection-rules.js';

/** NETWORK-007: bounded, explicitly reviewed local copy to an EXISTING policy.
 * Never copies chat identity, protected-member IDs, hidden allowlists, trusted
 * account IDs, source mode, Telegram rights, or network credentials. */
export type NetworkCopyPart='r'|'f'|'b';
export interface NetworkCopyPreview{
 networkId:string;networkRevision:number;sourceId:string;targetId:string;
 sourceRevision:number;targetRevision:number;targetMode:'OFF'|'MONITOR';
 parts:NetworkCopyPart;fields:('rules'|'flood')[];
 ruleCount:number;excludedRules:number;pausedLinks:number;proof:string;
}
export interface NetworkCopyResult{
 targetId:string;newRevision:number;mode:'OFF'|'MONITOR';
 fields:('rules'|'flood')[];ruleCount:number;pausedLinks:number;
}
const digest=(x:unknown):string=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validClock=(x:number)=>Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000-120_000;
const id=(x:string)=>/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const network=(x:string)=>/^[a-f0-9]{12}$/u.test(x);
const safeKinds=new Set(['WORD','PHRASE','LOOKALIKE','TYPE','LINK','FORWARD','HIDDEN','PHONE','LIMIT']);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const proof=(s:BotState,net:string,source:string,target:string,part:NetworkCopyPart)=>digest([
 net,source,target,part,s.groupNetworks??[],s.chats,s.grants,
 s.protectionPolicies??[],s.networkInheritance??[],s.networkEmergencyControls??[],
 s.protectionFloodWindows??[],s.privateFeatures,s.privateSettingsRevision??0
]);
const member=(s:BotState,p:Policy,actor:string,now:number,
 groupId:string,expected:number):Chat|null=>{
 const rows=s.chats.filter(c=>c.id===groupId),c=rows[0];
 if(rows.length!==1||!c||!c.approved||c.version!==expected||
  !c.scopes.includes('moderation')||!p.canUseChat(s,groupId,'moderation')||
  !p.has(s,actor,'chat.manage',groupId,now))return null;
 return c;
};
const record=(s:BotState,c:Chat,now:number):GroupProtectionRecord|null=>{
 const rows=(s.protectionPolicies??[]).filter(x=>x.policy.chatId===c.id),rec=rows[0];
 return rows.length===1&&!!rec&&isValidGroupProtectionRecord(rec)&&
  rec.chatPolicyVersion===c.version&&rec.updatedAt<=now&&
  rec.policy.mode!=='ENFORCE'&&rec.policy.revision<2_000_000_000?rec:null;
};
/** Requires both group revisions to match the network membership snapshot.
 * Rejects a source with any nonportable identity/payment rule rather than
 * silently omitting a rule that the owner believed was copied.
 */
export function previewNetworkGroupCopy(
 s:BotState,p:Policy,actor:string,now:number,
 netId:string,sourceId:string,targetId:string,parts:NetworkCopyPart
):NetworkCopyPreview|null{
 if(!validClock(now)||!p.isOwner(actor)||!p.privateFeature(s,'owner.dashboard',actor)||
  !network(netId)||!id(sourceId)||!id(targetId)||sourceId===targetId||
  !['r','f','b'].includes(parts)||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  !validNetworkInheritanceLinks(s.networkInheritance??[])||
  networkEmergencyStopped(s,netId))return null;
 const nets=(s.groupNetworks??[]).filter(n=>n.id===netId),n=nets[0];
 if(nets.length!==1||!n||!validGroupNetwork(n)||n.updatedAt>now)return null;
 const sourceMembers=n.members.filter(m=>m.chatId===sourceId),
  targetMembers=n.members.filter(m=>m.chatId===targetId);
 if(sourceMembers.length!==1||targetMembers.length!==1)return null;
 const source=member(s,p,actor,now,sourceId,sourceMembers[0]!.version),
  target=member(s,p,actor,now,targetId,targetMembers[0]!.version);
 if(!source||!target)return null;
 const from=record(s,source,now),to=record(s,target,now);
 if(!from||!to)return null;
 const copyRules=parts==='r'||parts==='b',copyFlood=parts==='f'||parts==='b';
 const rules=from.policy.rules;
 if(copyRules&&(
    // These entries bind a person, account or sensitive fraud claim. They
    // cannot be transplanted safely to another group.
    rules.some(r=>!safeKinds.has(r.kind))||
    to.policy.rules.some(r=>!safeKinds.has(r.kind))||
    (to.policy.ruleExemptions?.length??0)!==0
 ))return null;
 const fields:('rules'|'flood')[]=[];
 if(copyRules&&!same(rules,to.policy.rules))fields.push('rules');
 if(copyFlood&&!same(from.policy.flood,to.policy.flood))fields.push('flood');
 if(!fields.length)return null;
 const pausedLinks=(s.networkInheritance??[]).filter(l=>l.status==='ACTIVE'&&
  (l.sourceChatId===targetId||l.targetChatId===targetId)).length;
 return {networkId:netId,networkRevision:n.revision,sourceId,targetId,
  sourceRevision:from.policy.revision,targetRevision:to.policy.revision,
  targetMode:to.policy.mode,parts,fields,ruleCount:rules.length,excludedRules:0,
  pausedLinks,proof:proof(s,netId,sourceId,targetId,parts)};
}
/** Only call in the SAME transaction as consuming a one-shot confirmation.
 * No operation is authorized by the existence of a preview object alone. */
export function applyNetworkGroupCopy(
 s:BotState,p:Policy,actor:string,now:number,netId:string,sourceId:string,
 targetId:string,parts:NetworkCopyPart,expectedProof:string
):NetworkCopyResult|null{
 if(typeof expectedProof!=='string'||!/^[a-f0-9]{64}$/u.test(expectedProof))return null;
 const current=previewNetworkGroupCopy(s,p,actor,now,netId,sourceId,targetId,parts);
 if(!current||current.proof!==expectedProof)return null;
 const from=(s.protectionPolicies??[]).find(x=>x.policy.chatId===sourceId)!;
 const target=(s.protectionPolicies??[]).find(x=>x.policy.chatId===targetId)!;
 const draft:ProtectionPolicy=structuredClone(target.policy);
 if(current.fields.includes('rules'))draft.rules=structuredClone(from.policy.rules);
 if(current.fields.includes('flood')){
  if(from.policy.flood)draft.flood=structuredClone(from.policy.flood);
  else delete draft.flood;
 }
 draft.revision=current.targetRevision+1;
 // Preserve destination mode, group-specific allowlists, member exemptions,
 // channel identities, and all settings outside this explicit selection.
 if(draft.chatId!==targetId||draft.mode!==current.targetMode||
  !isValidProtectionPolicy(draft))return null;
 target.policy=draft;target.updatedBy=actor;target.updatedAt=now;
 if(s.protectionFloodWindows)
  s.protectionFloodWindows=s.protectionFloodWindows.filter(x=>x.chatId!==targetId);
 let pausedLinks=0;
 for(const link of s.networkInheritance??[]){
  if(link.status!=='ACTIVE')continue;
  if(link.targetChatId===targetId){
   link.status='PAUSED';link.pausedReason='LOCAL_OVERRIDE';pausedLinks++;
  }else if(link.sourceChatId===targetId){
   link.status='PAUSED';link.pausedReason='SOURCE_STALE';pausedLinks++;
  }
 }
 return {targetId,newRevision:draft.revision,mode:current.targetMode,
  fields:current.fields,ruleCount:draft.rules.length,pausedLinks};
}
