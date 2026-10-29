import {advanceFloodWindow} from './protection-flood.js';
import {protectionEntityLinks} from './protection-message-entities.js';
import {BotStore,type BotState} from './store.js';
import type {Policy} from './policy.js';
import {isValidProtectionPolicy,evaluateProtectionRules,type GroupProtectionRecord,type ProtectionEvaluation,type ProtectionMessage} from './protection-rules.js';
type Inspection={status:'DENIED'|'UNCONFIGURED'|'STALE'}|{status:'CONFIGURED';record:GroupProtectionRecord;enforcementConnected:false};
const clockValid=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000;
/** Owner/delegated operator control of one group's local rules. Saving a
 * monitor configuration is not permission to issue Telegram mutations. */
export class GroupProtectionPolicyService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now){}
 private allowed(state:BotState,actor:string,chat:string,now:number):boolean{
  return clockValid(now)&&this.policy.canUseChat(state,chat,'moderation')&&this.policy.has(state,actor,'chat.manage',chat,now);
 }
 async inspect(actor:string,chat:string):Promise<Inspection>{
  const state=await this.store.snapshot(),now=this.clock();
  if(!this.allowed(state,actor,chat,now))return {status:'DENIED'};
  const rows=(state.protectionPolicies??[]).filter(r=>r.policy.chatId===chat);
  if(!rows.length)return {status:'UNCONFIGURED'};
  if(rows.length!==1||rows[0]!.updatedAt>now||rows[0]!.chatPolicyVersion!==this.policy.chatRevision(state,chat))return {status:'STALE'};
  return {status:'CONFIGURED',record:structuredClone(rows[0]!),enforcementConnected:false};
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
   if(candidate.mode==='ENFORCE')return {status:'ENFORCEMENT_NOT_CONNECTED' as const};
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
   if(!record||record.policy.mode!=='MONITOR'||!config?.enabled||record.policy.revision!==w.policyRevision||
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
 async observeIncomingText(member:string,chat:string,text:string,entities:unknown,updateKey:string,countTraffic=true):Promise<string>{
  return this.observeIncomingMessage({chatId:chat,memberId:member,type:'TEXT',text},entities,updateKey,countTraffic);
 }
 async observeIncomingMessage(message:ProtectionMessage,entities:unknown,updateKey:string,countTraffic=true):Promise<string>{
  const {chatId:chat,memberId:member}=message;
  if(!/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]+$/u.test(updateKey))return 'DENIED';
  return this.store.transaction(state=>{
   const now=this.clock();
   if(!clockValid(now)||!this.policy.canUseChat(state,chat,'moderation'))return 'DENIED';
   const record=state.protectionPolicies?.find(r=>r.policy.chatId===chat);
   if(!record||record.policy.mode!=='MONITOR')return 'DISABLED';
   if(record.updatedAt>now||record.chatPolicyVersion!==this.policy.chatRevision(state,chat))return 'STALE';
   if(this.policy.isOwner(member)||this.policy.has(state,member,'chat.manage',chat,now)||record.policy.exemptMemberIds.includes(member))return 'EXEMPT';
   const key=updateKey+':protection:'+chat;
   if(state.audit.some(a=>a.updateKey===key))return 'DUPLICATE';
   const flood=countTraffic?this.observeFlood(state,record,member,updateKey,now):'CLEAR';
   if(flood==='DUPLICATE')return 'DUPLICATE';
   const body=message.text??message.caption??'';
   const links=typeof body==='string'&&body.length<=4096?protectionEntityLinks(body,entities):null;
   const result=links===null?null:evaluateProtectionRules(record.policy,{...message,links});
   if(flood==='INVALID'||!result||result.status==='INVALID_MESSAGE'||result.status==='INVALID_POLICY'){
    state.audit.push({updateKey:key,decision:'NOOP',reason:'PROTECTION_MONITOR_INPUT_UNAVAILABLE',policyVersion:record.chatPolicyVersion,at:now});
    return 'UNAVAILABLE';
   }
   const matches=result.matchedRuleIds.length+(flood==='EXCEEDED'?1:0);
   const choices=['REVIEW','WARN','DELETE','MUTE'];
   const floodAction=flood==='EXCEEDED'?record.policy.flood!.action:null;
   const action=floodAction&&choices.indexOf(floodAction)>choices.indexOf(result.proposedAction??'')?floodAction:result.proposedAction;
   if(matches)state.audit.push({updateKey:key,decision:'NOOP',
    reason:'PROTECTION_MONITOR_MATCH:revision='+record.policy.revision+';action='+action+';rules='+matches,
    policyVersion:record.chatPolicyVersion,at:now});
   return 'OBSERVED';
  });
 }
 async preview(actor:string,chat:string,message:unknown):Promise<{status:'DENIED'|'UNCONFIGURED'|'STALE'}|{status:'EVALUATED';result:ProtectionEvaluation}>{
  const inspection=await this.inspect(actor,chat);
  if(inspection.status!=='CONFIGURED')return inspection;
  return {status:'EVALUATED',result:evaluateProtectionRules(inspection.record.policy,message)};
 }
}
