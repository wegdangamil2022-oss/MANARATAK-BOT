import {BotStore,type BotState} from './store.js';
import type {Policy} from './policy.js';
import {isValidProtectionPolicy,evaluateProtectionRules,type GroupProtectionRecord,type ProtectionEvaluation} from './protection-rules.js';
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
   state.audit.push({actorId:actor,updateKey:'protection:policy:'+candidate.chatId+':'+candidate.revision,
    decision:'ALLOW',reason:'PROTECTION_POLICY_SAVED_'+candidate.mode,policyVersion:expectedChatRevision,at:now});
   return {status:'SAVED' as const,revision:candidate.revision};
  });
 }
 async preview(actor:string,chat:string,message:unknown):Promise<{status:'DENIED'|'UNCONFIGURED'|'STALE'}|{status:'EVALUATED';result:ProtectionEvaluation}>{
  const inspection=await this.inspect(actor,chat);
  if(inspection.status!=='CONFIGURED')return inspection;
  return {status:'EVALUATED',result:evaluateProtectionRules(inspection.record.policy,message)};
 }
}
