import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {ModerationService} from './moderation.js';
import type {ProtectionAction} from './protection-rules.js';

/** Trusted composition port. The evaluator itself never authorizes a sanction. */
export interface ProtectionEnforcer {
 supports(action:ProtectionAction):boolean;
 execute(actor:string,chat:string,member:string,action:ProtectionAction,key:string,current:(s:BotState)=>boolean):Promise<string>;
}
export function moderationProtectionEnforcer(service:ModerationService):ProtectionEnforcer {
 return Object.freeze({
  supports:(action:ProtectionAction)=>action==='REVIEW'||action==='WARN'||action==='MUTE',
  async execute(actor:string,chat:string,member:string,action:ProtectionAction,key:string,current:(s:BotState)=>boolean){
   const reference='protection:'+createHash('sha256').update(key).digest('hex');
   if(action==='REVIEW')return 'REVIEW';
   if(action==='WARN')return (await service.issueWarning(actor,chat,member,reference,current)).status;
   if(action==='MUTE')return (await service.addManualReason(actor,chat,member,reference,'MUTE',current,60,current)).status;
   return 'DENIED';
  }
 });
}
