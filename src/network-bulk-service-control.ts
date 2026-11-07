import type {BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import {networkEmergencyStopped,validNetworkEmergencyControls} from './network-emergency-stop.js';
import {validGroupNetwork} from './group-network-model.js';
import {validNetworkInheritanceLinks} from './network-inheritance-model.js';
import {isValidGroupProtectionRecord,type GroupProtectionRecord} from './protection-rules.js';

export type NetworkServiceControl='AI_OFF'|'MONITOR_OFF';
export interface NetworkServiceControlImpact {
 chatId:string;
 chatVersion:number;
 before:string;
 after:'OFF';
 /** Number of affected existing POLICY follow links. */
 linkedPolicies:number;
}
export interface NetworkServiceControlResult {
 operation:NetworkServiceControl;
 affectedChatIds:string[];
 pausedLinks:number;
}
const validChatId=(id:unknown):id is string=>typeof id==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
const validTime=(now:number)=>Number.isSafeInteger(now)&&now>=0&&
 now<=8_640_000_000_000_000-120_000;

/** Return scoped and fully current members; network membership alone never
 * grants authority. This read-only function is shared by UI and commit. */
export function eligibleNetworkServiceTargets(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string,
 operation:NetworkServiceControl
):NetworkServiceControlImpact[]|null{
 if(!validTime(now)||!policy.isOwner(actor)||
  !policy.privateFeature(s,'owner.dashboard',actor)||
  !/^[a-f0-9]{12}$/u.test(networkId)||
  !['AI_OFF','MONITOR_OFF'].includes(operation)||
  networkEmergencyStopped(s,networkId)||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  !validNetworkInheritanceLinks(s.networkInheritance??[]))return null;
 const networks=(s.groupNetworks??[]).filter(n=>n.id===networkId);
 const network=networks[0];
 if(networks.length!==1||!network||!validGroupNetwork(network)||
  network.updatedAt>now)return null;
 const impacts:NetworkServiceControlImpact[]=[];
 for(const member of network.members){
  if(!validChatId(member.chatId))return null;
  const rows=s.chats.filter(x=>x.id===member.chatId),chat=rows[0];
  // A stale member does not become an approved target by accident.
  if(rows.length!==1||!chat||!chat.approved||chat.version!==member.version||
   !policy.has(s,actor,'chat.manage',chat.id,now))continue;
  if(operation==='AI_OFF'){
   if(!chat.scopes.includes('assistant')||chat.groupAI==='OFF'||
    chat.version>=9_999_999_999)continue;
   impacts.push({chatId:chat.id,chatVersion:chat.version,before:chat.groupAI,
    after:'OFF',linkedPolicies:(s.networkInheritance??[]).filter(link=>
     link.status==='ACTIVE'&&(link.sourceChatId===chat.id||
      link.targetChatId===chat.id)).length});
  }else{
   if(!chat.scopes.includes('moderation')||!policy.canUseChat(s,chat.id,'moderation'))continue;
   const records=(s.protectionPolicies??[]).filter(x=>x.policy.chatId===chat.id),
    record=records[0];
   if(records.length!==1||!record||!isValidGroupProtectionRecord(record)||
    record.chatPolicyVersion!==chat.version||record.updatedAt>now||
    record.policy.mode!=='MONITOR'||record.policy.revision>=2_000_000_000)continue;
   impacts.push({chatId:chat.id,chatVersion:chat.version,before:'MONITOR',
    after:'OFF',linkedPolicies:(s.networkInheritance??[]).filter(link=>
     link.status==='ACTIVE'&&(link.sourceChatId===chat.id||
      link.targetChatId===chat.id)).length});
  }
 }
 impacts.sort((a,b)=>a.chatId.localeCompare(b.chatId));
 return impacts;
}
/** Local, restrictive transaction-only operation. Validate ALL exact selected
 * targets before mutating anything; an invalid selection never partly applies.
 * On AI OFF the chat approval epoch changes (network membership becomes stale).
 * Every active inherited policy link touching a changed group is safely paused
 * so old source/target versions cannot reactivate a stopped service. */
export function applyNetworkSelectedServiceDisable(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string,
 operation:NetworkServiceControl,ids:readonly string[]
):NetworkServiceControlResult|null{
 if(!Array.isArray(ids)||ids.length<1||ids.length>8||
  ids.some(id=>!validChatId(id))||new Set(ids).size!==ids.length)return null;
 const eligible=eligibleNetworkServiceTargets(s,policy,actor,now,networkId,operation);
 if(!eligible||!ids.every(id=>eligible.some(x=>x.chatId===id)))return null;
 const changed=new Set(ids);
 // The mutation pass follows a complete eligibility and input validation pass.
 const members=ids.map(id=>s.chats.find(c=>c.id===id) as Chat);
 const policies:GroupProtectionRecord[]=[];
 if(operation==='MONITOR_OFF'){
  for(const id of ids){
   const records=(s.protectionPolicies??[]).filter(r=>r.policy.chatId===id);
   if(records.length!==1||!records[0]||!isValidGroupProtectionRecord(records[0])||
    records[0].policy.mode!=='MONITOR')return null;
   policies.push(records[0]);
  }
 }
 if(operation==='AI_OFF'){
  for(const c of members){c.groupAI='OFF';c.version++;}
 }else{
  for(const record of policies){
   record.policy={...structuredClone(record.policy),mode:'OFF',revision:record.policy.revision+1};
   record.updatedAt=now;record.updatedBy=actor;
  }
  if(s.protectionFloodWindows)
   s.protectionFloodWindows=s.protectionFloodWindows.filter(row=>!changed.has(row.chatId));
 }
 let pausedLinks=0;
 for(const link of s.networkInheritance??[]){
  if(link.status!=='ACTIVE')continue;
  if(operation==='MONITOR_OFF'&&changed.has(link.targetChatId)){
   link.status='PAUSED';link.pausedReason='LOCAL_OVERRIDE';pausedLinks++;
  }else if(changed.has(link.sourceChatId)||changed.has(link.targetChatId)){
   link.status='PAUSED';
   link.pausedReason=operation==='AI_OFF'?'GROUP_STALE':'SOURCE_STALE';
   pausedLinks++;
  }
 }
 return {operation,affectedChatIds:[...ids],pausedLinks};
}
