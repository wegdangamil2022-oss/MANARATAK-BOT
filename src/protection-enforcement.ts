import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {ModerationService} from './moderation.js';
import type {GroupPermissionLockService} from './group-permission-lock.js';
import type {ProtectionAction} from './protection-rules.js';

/** Trusted composition port. The evaluator itself never authorizes a sanction. */
export interface ProtectionEnforcer {
 supports(action:ProtectionAction):boolean;
 supportsRaid?:()=>boolean;
 executeRaid?:(actor:string,chat:string,seconds:number,current:(s:BotState)=>boolean)=>Promise<string>;
 execute(actor:string,chat:string,member:string,action:ProtectionAction,key:string,current:(s:BotState)=>boolean):Promise<string>;
}
export function moderationProtectionEnforcer(service:ModerationService,groupPermissions?:GroupPermissionLockService):ProtectionEnforcer {
 return Object.freeze({
  supportsRaid:()=>Boolean(groupPermissions),
  async executeRaid(actor:string,chat:string,seconds:number,current:(s:BotState)=>boolean){
   if(!groupPermissions)return 'DENIED';
   const job=await groupPermissions.preview(actor,chat,'LOCK','MESSAGES',seconds,undefined,s=>current(s)&&!(s.groupPermissionJobs??[]).some(j=>j.actorId===actor&&j.status==='PREVIEW'));
   if(!job)return 'DENIED';return groupPermissions.confirm(actor,job.id,current);
  },
  supports:(action:ProtectionAction)=>action==='REVIEW'||action==='WARN'||action==='MUTE',
  async execute(actor:string,chat:string,member:string,action:ProtectionAction,key:string,current:(s:BotState)=>boolean){
   const reference='protection_'+createHash('sha256').update(key).digest('hex').slice(0,48);
   if(action==='REVIEW')return 'REVIEW';
   if(action==='WARN')return (await service.issueWarning(actor,chat,member,reference,current)).status;
   if(action==='MUTE')return (await service.addManualReason(actor,chat,member,reference,'MUTE',current,60,current)).status;
   return 'DENIED';
  }
 });
}
