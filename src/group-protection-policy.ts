import {advanceFloodWindow} from './protection-flood.js';
import {protectionEntityLinks} from './protection-message-entities.js';
import {BotStore,type BotState} from './store.js';
import type {Policy} from './policy.js';
import type {ProtectionEnforcer,ProtectionDelivery} from './protection-enforcement.js';
import type {ProtectionAction} from './protection-rules.js';
import {isValidProtectionPolicy,protectionMemberExempt,evaluateProtectionRules,type GroupProtectionRecord,type ProtectionEvaluation,type ProtectionMessage} from './protection-rules.js';
type Inspection={status:'DENIED'|'UNCONFIGURED'|'STALE'}|{status:'CONFIGURED';record:GroupProtectionRecord;enforcementConnected:boolean};
const clockValid=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000;
/** Owner/delegated operator control of one group's local rules. Saving a
 * monitor configuration is not permission to issue Telegram mutations. */
export class GroupProtectionPolicyService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now,private readonly enforcer?:ProtectionEnforcer){}
 deletionConnected():boolean{return this.enforcer?.supports('DELETE')===true;}
 canEnforce(config:GroupProtectionRecord['policy']):boolean{
  return Boolean(this.enforcer&&config.rules.filter(r=>r.enabled).every(r=>this.enforcer!.supports(r.action))&&
   (!config.flood?.enabled||this.enforcer.supports(config.flood.action))&&(!config.escalation?.enabled||this.enforcer.supports('MUTE'))&&(!config.raid?.enabled||this.enforcer.supportsRaid?.()===true)&&(!config.night?.enabled||this.enforcer.supportsRaid?.()===true));
 }
 private allowed(state:BotState,actor:string,chat:string,now:number):boolean{
  return clockValid(now)&&this.policy.canUseChat(state,chat,'moderation')&&this.policy.has(state,actor,'chat.manage',chat,now);
 }
 async inspect(actor:string,chat:string):Promise<Inspection>{
  const state=await this.store.snapshot(),now=this.clock();
  if(!this.allowed(state,actor,chat,now))return {status:'DENIED'};
  const rows=(state.protectionPolicies??[]).filter(r=>r.policy.chatId===chat);
  if(!rows.length)return {status:'UNCONFIGURED'};
  if(rows.length!==1||rows[0]!.updatedAt>now||rows[0]!.chatPolicyVersion!==this.policy.chatRevision(state,chat))return {status:'STALE'};
  return {status:'CONFIGURED',record:structuredClone(rows[0]!),enforcementConnected:this.canEnforce(rows[0]!.policy)};
 }
 async save(actor:string,proposed:unknown,expectedChatRevision:number,expectedRevision:number):Promise<{
  status:'SAVED'|'DENIED'|'INVALID'|'STALE'|'ENFORCEMENT_NOT_CONNECTED';revision?:number
 }>{
  if(!isValidProtectionPolicy(proposed)||!Number.isSafeInteger(expectedChatRevision)||expectedChatRevision<1||
   !Number.isSafeInteger(expectedRevision)||expectedRevision<0||proposed.revision!==expectedRevision+1)return {status:'INVALID'};
  const candidate=structuredClone(proposed);
  return this.store.transaction(state=>{
   const now=this.clock();
   if(!this.allowed(state,actor,candidate.chatId,now))return {status:'DENIED' as const};
   if(candidate.mode==='ENFORCE'&&!this.canEnforce(candidate))return {status:'ENFORCEMENT_NOT_CONNECTED' as const};
   if(this.policy.chatRevision(state,candidate.chatId)!==expectedChatRevision)return {status:'STALE' as const};
   const rows=(state.protectionPolicies??[]).filter(r=>r.policy.chatId===candidate.chatId),old=rows[0];
   if(rows.length>1||(old?.policy.revision??0)!==expectedRevision||old&&(old.updatedAt>now||old.chatPolicyVersion!==expectedChatRevision))return {status:'STALE' as const};
   const record:GroupProtectionRecord={policy:candidate,chatPolicyVersion:expectedChatRevision,updatedBy:actor,updatedAt:now};
   state.protectionPolicies??=[];
   if(old)state.protectionPolicies[state.protectionPolicies.indexOf(old)]=record;
   else state.protectionPolicies.push(record);
   if(state.protectionFloodWindows)state.protectionFloodWindows=state.protectionFloodWindows.filter(w=>w.chatId!==candidate.chatId);
   state.audit.push({actorId:actor,updateKey:'protection:policy:'+candidate.chatId+':'+candidate.revision,
    decision:'ALLOW',reason:'PROTECTION_POLICY_SAVED_'+candidate.mode,policyVersion:expectedChatRevision,at:now});
   return {status:'SAVED' as const,revision:candidate.revision};
  });
 }
 private pruneFloodWindows(state:BotState,now:number):{removedWindows:number;removedEvents:number;clockUntrusted:boolean}{
  const previous=state.protectionFloodWindows??[];let removedEvents=0,clockUntrusted=false;
  const windows=previous.flatMap(w=>{
   const record=state.protectionPolicies?.find(r=>r.policy.chatId===w.chatId),config=record?.policy.flood;
   if(!record||record.policy.mode==='OFF'||!config?.enabled||record.policy.revision!==w.policyRevision||
    record.chatPolicyVersion!==w.chatPolicyVersion||record.chatPolicyVersion!==this.policy.chatRevision(state,w.chatId)||!this.policy.canUseChat(state,w.chatId,'moderation')){removedEvents+=w.events.length;return [];}
   if(w.updatedAt>now||record.updatedAt>now){clockUntrusted=true;return [w];}
   const events=w.events.filter(e=>e.at>now-config.windowMs);removedEvents+=w.events.length-events.length;
   return events.length?[{...w,events}]:[];
  });
  if(state.protectionFloodWindows)state.protectionFloodWindows=windows;
  return {removedWindows:previous.length-windows.length,removedEvents,clockUntrusted};
 }
 async cleanupFloodWindows():Promise<{status:'CLEANED'|'CLOCK_UNTRUSTED';removedWindows:number;removedEvents:number}>{
  if(!(await this.store.snapshot()).protectionFloodWindows?.length)return {status:'CLEANED',removedWindows:0,removedEvents:0};
  return this.store.transaction(state=>{
   const now=this.clock();if(!clockValid(now))return {status:'CLOCK_UNTRUSTED' as const,removedWindows:0,removedEvents:0};
   const result=this.pruneFloodWindows(state,now);
   return {status:result.clockUntrusted?'CLOCK_UNTRUSTED' as const:'CLEANED' as const,removedWindows:result.removedWindows,removedEvents:result.removedEvents};
  });
 }
 private raidThreshold(state:BotState,record:GroupProtectionRecord,now:number):boolean{
  const raid=record.policy.raid,flood=record.policy.flood;if(!raid?.enabled||!flood?.enabled)return false;
  const windows=(state.protectionFloodWindows??[]).filter(w=>w.chatId===record.policy.chatId&&w.policyRevision===record.policy.revision&&w.chatPolicyVersion===record.chatPolicyVersion&&w.updatedAt<=now);
  const counts=windows.map(w=>w.events.filter(e=>e.at<=now&&e.at>now-flood.windowMs).length).filter(n=>n>0);
  return counts.length>=raid.minimumMembers&&counts.reduce((a,b)=>a+b,0)>=raid.minimumMessages;
 }
 private observeFlood(state:BotState,record:GroupProtectionRecord,member:string,key:string,now:number):'CLEAR'|'EXCEEDED'|'DUPLICATE'|'INVALID'{
  const config=record.policy.flood;if(!config?.enabled)return 'CLEAR';
  state.protectionFloodWindows??=[];
  this.pruneFloodWindows(state,now);
  const windows=state.protectionFloodWindows,index=windows.findIndex(w=>w.chatId===record.policy.chatId&&w.memberId===member),old=windows[index];
  if(!old&&windows.length>=1000)return 'INVALID';
  const result=advanceFloodWindow(config,old?.events??[],key,now);
  if(result.status==='INVALID'||result.status==='DUPLICATE')return result.status;
  if(result.status==='DISABLED')return 'CLEAR';
  const value={chatId:record.policy.chatId,memberId:member,chatPolicyVersion:record.chatPolicyVersion,policyRevision:record.policy.revision,events:result.events,updatedAt:now};
  if(index<0)windows.push(value);else windows[index]=value;
  return result.status;
 }
 /** Record-only incoming TEXT monitor. Authorization precedes body/entity
  * evaluation; observations retain no sender identity or message contents. */
 async observeIncomingText(member:string,chat:string,text:string,entities:unknown,updateKey:string,countTraffic=true,delivery?:ProtectionDelivery):Promise<string>{
  return this.observeIncomingMessage({chatId:chat,memberId:member,type:'TEXT',text},entities,updateKey,countTraffic,delivery);
 }
 async observeIncomingMessage(message:ProtectionMessage,entities:unknown,updateKey:string,countTraffic=true,delivery?:ProtectionDelivery):Promise<string>{
  const {chatId:chat,memberId:member}=message;
  if(!/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]+$/u.test(updateKey))return 'DENIED';
  const prepared=await this.store.transaction(state=>{
   const now=this.clock();
   if(!clockValid(now)||!this.policy.canUseChat(state,chat,'moderation'))return 'DENIED';
   const record=state.protectionPolicies?.find(r=>r.policy.chatId===chat);
   if(!record||record.policy.mode==='OFF')return 'DISABLED';
   if(record.policy.mode==='ENFORCE'&&!this.canEnforce(record.policy))return 'ENFORCEMENT_NOT_CONNECTED';
   if(record.policy.mode==='ENFORCE'&&!this.allowed(state,record.updatedBy,chat,now))return 'DENIED';
   if(record.updatedAt>now||record.chatPolicyVersion!==this.policy.chatRevision(state,chat))return 'STALE';
   if(this.policy.isOwner(member)||this.policy.has(state,member,'chat.manage',chat,now)||protectionMemberExempt(record.policy,member,now))return 'EXEMPT';
   const key=updateKey+':protection:'+chat;
   if(state.audit.some(a=>a.updateKey===key))return 'DUPLICATE';
   const body=message.text??message.caption??'';
   const links=typeof body==='string'&&body.length<=4096?protectionEntityLinks(body,entities):null;
   const result=links===null?null:evaluateProtectionRules(record.policy,{...message,links,mentionCount:Array.isArray(entities)?new Set(entities.filter(e=>e&&typeof e==='object'&&['mention','text_mention'].includes(e.type)).map(e=>e.offset+':'+e.length)).size:0},now);
   if(!result||result.status==='INVALID_MESSAGE'||result.status==='INVALID_POLICY'){
    state.audit.push({updateKey:key,decision:'NOOP',reason:'PROTECTION_MONITOR_INPUT_UNAVAILABLE',policyVersion:record.chatPolicyVersion,at:now});
    return 'UNAVAILABLE';
   }
   const flood=countTraffic?this.observeFlood(state,record,member,updateKey,now):'CLEAR';
   if(flood==='DUPLICATE')return 'DUPLICATE';
   if(flood==='INVALID'){
    state.audit.push({updateKey:key,decision:'NOOP',reason:'PROTECTION_MONITOR_INPUT_UNAVAILABLE',policyVersion:record.chatPolicyVersion,at:now});
    return 'UNAVAILABLE';
   }
   const raid=Boolean(countTraffic&&record.policy.mode==='ENFORCE'&&this.raidThreshold(state,record,now)&&!state.audit.some(a=>a.updateKey==='protection:raid:'+chat&&a.at>now-record.policy.raid!.lockSeconds*1000));
   if(raid)state.audit.push({actorId:record.updatedBy,updateKey:'protection:raid:'+chat,decision:'NOOP',reason:'PROTECTION_RAID_CLAIM',policyVersion:record.chatPolicyVersion,at:now});
   const matches=result.matchedRuleIds.length+(flood==='EXCEEDED'?1:0);
   const choices=['REVIEW','WARN','DELETE','MUTE'];
   const floodAction=flood==='EXCEEDED'?record.policy.flood!.action:null;
   let action=floodAction&&choices.indexOf(floodAction)>choices.indexOf(result.proposedAction??'')?floodAction:result.proposedAction;
   const escalation=record.policy.escalation;
   const warningSource=escalation?.enabled?JSON.stringify(state.warnings.filter(w=>w.chatId===chat&&w.memberId===member)):null;
   const previousAction=action;
   if(matches&&action==='WARN'&&escalation?.enabled&&state.warnings.filter(w=>w.chatId===chat&&w.memberId===member&&w.active&&w.at<=now&&w.at>now-escalation.windowMs).length>=escalation.afterWarnings)action='MUTE';
   if(raid)action='REVIEW';
   if(matches||raid)state.audit.push({updateKey:key,decision:'NOOP',
    reason:(record.policy.mode==='ENFORCE'?'PROTECTION_ENFORCEMENT_CLAIM:':'PROTECTION_MONITOR_MATCH:')+'revision='+record.policy.revision+';action='+action+';rules='+matches,
    policyVersion:record.chatPolicyVersion,at:now});
   if((matches||raid)&&action&&record.policy.mode==='ENFORCE')return {record:structuredClone(record),action,key,at:now,warningSource,escalated:previousAction==='WARN'&&action==='MUTE',raid};
   return 'OBSERVED';
  });
  if(typeof prepared==='string')return prepared;
  const current=(state:BotState)=>{
   const now=this.clock(),rows=state.protectionPolicies?.filter(r=>r.policy.chatId===chat)??[];
   return clockValid(now)&&now>=prepared.at&&now<prepared.at+5000&&rows.length===1&&
    JSON.stringify(rows[0])===JSON.stringify(prepared.record)&&(!prepared.raid||this.raidThreshold(state,prepared.record,now))&&(!prepared.escalated||state.warnings.filter(w=>w.chatId===chat&&w.memberId===member&&w.active&&w.at<=now&&w.at>now-prepared.record.policy.escalation!.windowMs).length>=prepared.record.policy.escalation!.afterWarnings)&&(prepared.warningSource===null||prepared.warningSource===JSON.stringify(state.warnings.filter(w=>w.chatId===chat&&w.memberId===member)))&&this.allowed(state,prepared.record.updatedBy,chat,now)&&
    prepared.record.chatPolicyVersion===this.policy.chatRevision(state,chat)&&
    !this.policy.isOwner(member)&&!this.policy.has(state,member,'chat.manage',chat,now)&&!protectionMemberExempt(prepared.record.policy,member,now);
  };
  // The durable claim precedes the external authority reads. A lost/failed
  // attempt is not replayed by redelivery, even after a process restart.
  let status:string;
  try{status=prepared.raid?await this.enforcer!.executeRaid!(prepared.record.updatedBy,chat,prepared.record.policy.raid!.lockSeconds,current):await this.enforcer!.execute(prepared.record.updatedBy,chat,member,prepared.action as ProtectionAction,prepared.key,current,delivery);}
  catch{status='UNAVAILABLE';}
  await this.store.transaction(state=>{state.audit.push({updateKey:prepared.key+':result',decision:'NOOP',
   reason:'PROTECTION_ENFORCEMENT_RESULT:'+(['ADDED','NO_CHANGE','APPLIED','DENIED','BLOCKED_PENDING','BLOCKED_UNKNOWN','FAILED_CONFIRMED','UNKNOWN_OUTCOME','REVIEW','CONFIRMED','ACKNOWLEDGED'].includes(status)?status:'UNAVAILABLE'),
   policyVersion:prepared.record.chatPolicyVersion,at:this.clock()});});
  return 'ENFORCEMENT_ATTEMPTED';
 }
 async preview(actor:string,chat:string,message:unknown):Promise<{status:'DENIED'|'UNCONFIGURED'|'STALE'}|{status:'EVALUATED';result:ProtectionEvaluation}>{
  const inspection=await this.inspect(actor,chat);
  if(inspection.status!=='CONFIGURED')return inspection;
  return {status:'EVALUATED',result:evaluateProtectionRules(inspection.record.policy,message,this.clock())};
 }
}
