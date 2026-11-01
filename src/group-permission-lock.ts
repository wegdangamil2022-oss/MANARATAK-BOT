import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {GROUP_LOCK_MODES,equalGroupPermissions,lockedGroupPermissions,validGroupPermissions,type GroupLockMode,type GroupPermissionJob} from './group-permission-model.js';
import type {GroupPermissionPort} from './telegram-group-permission-gateway.js';
const TTL=120000;
export function groupPermissionEpoch(s:BotState,p:Policy,actor:string,chat:string,now:number,except=''):string|null{
 if(/^[1-9][0-9]{0,15}$/u.exec(actor)?.[0]!==actor||!Number.isSafeInteger(Number(actor))||/^-[1-9][0-9]{0,15}$/u.exec(chat)?.[0]!==chat||!Number.isSafeInteger(Number(chat))||!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL||s.chats.filter(c=>c.id===chat).length!==1||!p.canUseChat(s,chat,'moderation')||!p.has(s,actor,'chat.manage',chat,now)||p.isOwner(actor)&&!p.privateFeature(s,'owner.dashboard',actor))return null;
 return createHash('sha256').update('MANARATAK:GROUP-PERMISSIONS:V1:').update(JSON.stringify([actor,chat,s.chats.filter(c=>c.id===chat),s.grants.filter(g=>g.chatId===chat),s.privateFeatures,s.privateSettingsRevision,(s.groupPermissionJobs??[]).filter(j=>j.chatId===chat&&j.id!==except)])).digest('hex');
}
const epoch=groupPermissionEpoch;
const blocked=(s:BotState,chat:string,except='')=>(s.groupPermissionJobs??[]).some(j=>j.chatId===chat&&j.id!==except&&['INTENT','STARTED','UNKNOWN_OUTCOME'].includes(j.status));
const identity=(j:GroupPermissionJob)=>JSON.stringify([j.id,j.chatId,j.actorId,j.scopeVersion,j.kind,j.mode,j.before,j.after,j.sourceEpoch,j.createdAt,j.expiresAt,j.restores]);
function lastLock(s:BotState,chat:string):GroupPermissionJob|null{
 const jobs=s.groupPermissionJobs??[],restored=new Set(jobs.filter(j=>j.chatId===chat&&j.status==='CONFIRMED'&&j.kind==='RESTORE').map(j=>j.restores));
 const active=jobs.filter(j=>j.chatId===chat&&j.kind==='LOCK'&&j.status==='CONFIRMED'&&!restored.has(j.id));if(!active.length)return null;
 const latest=Math.max(...active.map(j=>j.createdAt)),rows=active.filter(j=>j.createdAt===latest);return rows.length===1?rows[0]!:null;
}
export class GroupPermissionLockService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly gateway:GroupPermissionPort,private readonly clock:()=>number){}
 async cancelForActor(actor:string):Promise<void>{await this.store.transaction(s=>{for(const j of s.groupPermissionJobs??[])if(j.actorId===actor&&j.status==='PREVIEW')j.status='CANCELLED';});}
 async preview(actor:string,chat:string,kind:'LOCK'|'RESTORE',mode:GroupLockMode='MESSAGES'):Promise<GroupPermissionJob|null>{
  if(!['LOCK','RESTORE'].includes(kind)||!GROUP_LOCK_MODES.includes(mode))return null;
  const before=await this.store.snapshot(),now=this.clock(),source=epoch(before,this.policy,actor,chat,now);if(!source||blocked(before,chat)||(before.groupPermissionJobs?.length??0)>=1000)return null;
  const permissions=await this.gateway.read(chat);if(!permissions||!validGroupPermissions(permissions))return null;
  return this.store.transaction(s=>{
   const at=this.clock();if(at<now||at>=now+TTL||epoch(s,this.policy,actor,chat,at)!==source||blocked(s,chat)||(s.groupPermissionJobs?.length??0)>=1000)return null;
   const old=kind==='RESTORE'?lastLock(s,chat):null;if(kind==='RESTORE'&&(!old||old.scopeVersion!==this.policy.chatRevision(s,chat)||!equalGroupPermissions(permissions,old.after)))return null;
   const desired=kind==='RESTORE'?old!.before:lockedGroupPermissions(permissions,mode);if(equalGroupPermissions(permissions,desired))return null;
   for(const j of s.groupPermissionJobs??[])if(j.actorId===actor&&j.status==='PREVIEW')j.status='CANCELLED';
   const job:GroupPermissionJob={id:randomBytes(18).toString('base64url'),chatId:chat,actorId:actor,scopeVersion:this.policy.chatRevision(s,chat),kind,mode:old?.mode??mode,before:structuredClone(permissions),after:structuredClone(desired),sourceEpoch:epoch(s,this.policy,actor,chat,at)!,createdAt:at,expiresAt:at+TTL,status:'PREVIEW',...(old?{restores:old.id}:{})};
   s.groupPermissionJobs??=[];s.groupPermissionJobs.push(job);return structuredClone(job);
  });
 }
 async cancel(actor:string,id:string):Promise<boolean>{return this.store.transaction(s=>{const j=s.groupPermissionJobs?.find(j=>j.id===id);if(!j||j.actorId!==actor||j.status!=='PREVIEW'||!epoch(s,this.policy,actor,j.chatId,this.clock(),j.id))return false;j.status='CANCELLED';return true;});}
 async confirm(actor:string,id:string):Promise<'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'DENIED'>{
  const reserved=await this.store.transaction(s=>{
   const j=s.groupPermissionJobs?.find(j=>j.id===id),now=this.clock();if(!j||j.actorId!==actor||j.status!=='PREVIEW'||j.attemptId!==undefined||now<j.createdAt||now>=j.expiresAt||epoch(s,this.policy,actor,j.chatId,now,j.id)!==j.sourceEpoch||blocked(s,j.chatId,j.id))return null;
   if(j.kind==='RESTORE'&&lastLock(s,j.chatId)?.id!==j.restores)return null;
   j.status='INTENT';return structuredClone(j);
  });
  if(!reserved)return 'DENIED';
  const still=async(status:'INTENT'|'STARTED',attemptId?:string)=>{const s=await this.store.snapshot(),j=s.groupPermissionJobs?.find(j=>j.id===id),now=this.clock();return !!j&&j.status===status&&j.attemptId===attemptId&&identity(j)===identity(reserved)&&now>=j.createdAt&&now<j.expiresAt&&epoch(s,this.policy,actor,j.chatId,now,j.id)===j.sourceEpoch&&!blocked(s,j.chatId,j.id);};
  let observed;try{observed=await this.gateway.read(reserved.chatId);}catch{observed=null;}
  if(!observed||!validGroupPermissions(observed)||!equalGroupPermissions(observed,reserved.before)||!await still('INTENT')){
   await this.store.transaction(s=>{const j=s.groupPermissionJobs?.find(j=>j.id===id);if(j?.status==='INTENT'&&identity(j)===identity(reserved))j.status='CANCELLED';});return 'DENIED';
  }
  const attemptId=randomBytes(18).toString('base64url');
  const started=await this.store.transaction(s=>{const j=s.groupPermissionJobs?.find(j=>j.id===id),now=this.clock();if(!j||j.status!=='INTENT'||identity(j)!==identity(reserved)||now<j.createdAt||now>=j.expiresAt||epoch(s,this.policy,actor,j.chatId,now,j.id)!==j.sourceEpoch||blocked(s,j.chatId,j.id))return false;j.status='STARTED';j.attemptId=attemptId;return true;});
  if(!started)return 'DENIED';let outcome:'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
  try{outcome=await this.gateway.apply(reserved.chatId,reserved.before,reserved.after,()=>still('STARTED',attemptId));}catch{outcome='UNKNOWN_OUTCOME';}
  if(!['CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME'].includes(outcome))outcome='UNKNOWN_OUTCOME';
  if(outcome==='CONFIRMED')try{const readback=await this.gateway.read(reserved.chatId);if(!readback||!validGroupPermissions(readback)||!equalGroupPermissions(readback,reserved.after)||!await still('STARTED',attemptId))outcome='UNKNOWN_OUTCOME';}catch{outcome='UNKNOWN_OUTCOME';}
  return this.store.transaction(s=>{
   const j=s.groupPermissionJobs?.find(j=>j.id===id);if(!j||j.status!=='STARTED'||j.attemptId!==attemptId||identity(j)!==identity(reserved)){
    s.groupPermissionJobs??=[];s.groupPermissionJobs.push({...reserved,id:randomBytes(18).toString('base64url'),status:'UNKNOWN_OUTCOME',attemptId});return 'UNKNOWN_OUTCOME' as const;
   }
   if(outcome==='CONFIRMED'&&epoch(s,this.policy,actor,j.chatId,this.clock(),j.id)!==j.sourceEpoch)outcome='UNKNOWN_OUTCOME';j.status=outcome;
   s.audit.push({actorId:actor,updateKey:'group-permissions:'+j.id,decision:outcome==='CONFIRMED'?'ALLOW':'DENY',reason:'GROUP_PERMISSIONS_'+outcome,policyVersion:j.scopeVersion,at:this.clock()});return outcome;
  });
 }
}
