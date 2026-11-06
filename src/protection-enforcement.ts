import {createHash,randomBytes} from 'node:crypto';
import {purgeReviewDigest,type ModerationPurgeService} from './moderation-purge.js';
import type {BotStore} from './store.js';
import type {BotState} from './store.js';
import type {ModerationService} from './moderation.js';
import type {GroupPermissionLockService} from './group-permission-lock.js';
import type {ProtectionAction} from './protection-rules.js';

export interface ProtectionDelivery{messageId:number;sentAt:number;}
/** Trusted composition port. The evaluator itself never authorizes a sanction. */
export interface ProtectionEnforcer {
 supports(action:ProtectionAction):boolean;
 supportsMuteDuration?:(seconds:number)=>boolean;
 supportsRaid?:()=>boolean;
 executeRaid?:(actor:string,chat:string,seconds:number,current:(s:BotState)=>boolean)=>Promise<string>;
 execute(actor:string,chat:string,member:string,action:ProtectionAction,key:string,current:(s:BotState)=>boolean,delivery?:ProtectionDelivery,muteSeconds?:number):Promise<string>;
}
export function moderationProtectionEnforcer(service:ModerationService,groupPermissions?:GroupPermissionLockService,deletion?:{store:BotStore;purge:ModerationPurgeService}):ProtectionEnforcer {
 return Object.freeze({
  supportsMuteDuration:(seconds:number)=>Number.isSafeInteger(seconds)&&seconds>=60&&seconds<=86400,
  supportsRaid:()=>Boolean(groupPermissions),
  async executeRaid(actor:string,chat:string,seconds:number,current:(s:BotState)=>boolean){
   if(!groupPermissions)return 'DENIED';
   const job=await groupPermissions.preview(actor,chat,'LOCK','MESSAGES',seconds,undefined,s=>current(s)&&!(s.groupPermissionJobs??[]).some(j=>(j.actorId===actor||j.chatId===chat)&&j.status==='PREVIEW'),randomBytes(32).toString('hex'));
   if(!job)return 'DENIED';return groupPermissions.confirm(actor,job.id,current);
  },
  supports:(action:ProtectionAction)=>action==='REVIEW'||action==='WARN'||action==='MUTE'||action==='DELETE'&&Boolean(deletion),
  async execute(actor:string,chat:string,member:string,action:ProtectionAction,key:string,current:(s:BotState)=>boolean,delivery?:ProtectionDelivery,muteSeconds=60){
   if(!Number.isSafeInteger(muteSeconds)||muteSeconds<60||muteSeconds>86400||action!=='MUTE'&&muteSeconds!==60)return 'DENIED';
   const reference='protection_'+createHash('sha256').update(key).digest('hex').slice(0,48);
   delivery=delivery?{messageId:delivery.messageId,sentAt:delivery.sentAt}:undefined;
   if(action==='DELETE'){
    if(!deletion||!delivery||!Number.isSafeInteger(delivery.messageId)||delivery.messageId<=0||!Number.isSafeInteger(delivery.sentAt)||delivery.sentAt<0||!await service.canReviewCommand(actor,chat,member))return 'DENIED';
    const {store,purge}=deletion;const target=delivery;
    const verified=(s:BotState)=>{
     const rows=s.rollingMessageMeta.filter(m=>m.chatId===chat&&m.messageId===target.messageId),m=rows[0];
     return current(s)&&rows.length===1&&!!m&&m.senderKind==='USER'&&m.senderId===member&&m.sentAt===target.sentAt&&!m.pinned&&!m.linkedChannel&&!m.adminLog&&!m.approvedAnnouncement&&m.protectionUnverified===undefined;
    };
    if(!verified(await store.snapshot()))return 'DENIED';
    let job;try{
     job=await purge.preview(actor,chat,{limit:1,senderId:member,beforeMessageId:delivery.messageId+1},verified,true);
     if(job.items.length!==1||job.items[0]!.messageId!==delivery.messageId){await purge.cancel(actor,job.id);return 'DENIED';}
     await purge.confirm(actor,job.id,purgeReviewDigest(job),verified);
     return (await purge.dispatchNext(job.id,verified)).status;
    }catch{if(job)try{await purge.cancel(actor,job.id);}catch{/* preserve pending/unknown receipts */}return 'DENIED';}
   }
   if(action==='REVIEW')return 'REVIEW';
   if(action==='WARN')return (await service.issueWarning(actor,chat,member,reference,current)).status;
   if(action==='MUTE')return (await service.addManualReason(actor,chat,member,reference,'MUTE',current,muteSeconds,current)).status;
   return 'DENIED';
  }
 });
}
