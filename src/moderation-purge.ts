import {createHash,randomUUID} from 'node:crypto';
import {BotStore,type BotState,type RollingMessageMeta,type PurgeJob,type PurgeFilter,type PurgeItem} from './store.js';
import {Policy} from './policy.js';
import {nextDispatchLease,leaseExpired} from './publication-worker-lease.js';

const WINDOW_MS=48*60*60*1000, REVIEW_MS=10*60*1000, MAX_PREVIEW=25, DAILY_LIMIT=50;
type PurgeOutcome='ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
export interface PurgeGateway {
 canDelete(chatId:string):Promise<boolean>;
 deleteMessage(chatId:string,messageId:number,attemptId:string):Promise<PurgeOutcome>;
}
export class FakePurgeGateway implements PurgeGateway {
 rights=true;
 throwAfterDelete=false;
 outcome:PurgeOutcome='ACKNOWLEDGED';
 calls:{chatId:string;messageId:number;attemptId:string}[]=[];
 async canDelete(_chatId:string):Promise<boolean>{return this.rights;}
 async deleteMessage(chatId:string,messageId:number,attemptId:string):Promise<PurgeOutcome>{
  this.calls.push({chatId,messageId,attemptId});
  if(this.throwAfterDelete)throw new Error('simulated ambiguous timeout');
  return this.outcome;
 }
}
export type PurgeDispatchResult={status:PurgeOutcome|'EMPTY'|'BLOCKED'|'BLOCKED_UNKNOWN'|'BLOCKED_DAILY_LIMIT'|'NOT_CONFIRMED'|'PAUSED'|'CANCELLED';messageId?:number};
const hash=(m:RollingMessageMeta)=>createHash('sha256').update(JSON.stringify([
 m.chatId,m.messageId,m.senderKind,m.senderId??null,m.sentAt,m.contentType,m.hasLinks,
 m.pinned,m.linkedChannel,m.adminLog,m.approvedAnnouncement
])).digest('hex');
const protectedMessage=(m:RollingMessageMeta)=>m.pinned||m.linkedChannel||m.adminLog||m.approvedAnnouncement;
const validId=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const validTime=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const validActor=(v:unknown)=>typeof v==='string'&&/^\d+$/.test(v)&&v!=='0';
const day=(n:number)=>Math.floor(n/(24*60*60*1000));
const recent=(m:RollingMessageMeta,now:number)=>m.sentAt>now-WINDOW_MS&&m.sentAt<=now;
const prune=(s:BotState,now:number)=>{s.rollingMessageMeta=s.rollingMessageMeta.filter(x=>recent(x,now));};
const inputFields=new Set(['chatId','messageId','senderKind','senderId','sentAt','observedAt',
 'contentType','hasLinks','pinned','linkedChannel','adminLog','approvedAnnouncement']);
function validMeta(value:RollingMessageMeta):boolean{
 if(!value||typeof value!=='object'||Object.keys(value).some(k=>!inputFields.has(k)))return false;
 if(typeof value.chatId!=='string'||!/^-[0-9]+$/.test(value.chatId)||
    !validId(value.messageId)||!validTime(value.sentAt)||!validTime(value.observedAt)||
    !['USER','CHANNEL','UNKNOWN'].includes(value.senderKind)||
    !['TEXT','MEDIA','COMMAND','OTHER'].includes(value.contentType)||
    ['hasLinks','pinned','linkedChannel','adminLog','approvedAnnouncement'].some(k=>typeof value[k as keyof RollingMessageMeta]!=='boolean'))return false;
 return value.senderKind==='UNKNOWN' ? value.senderId===undefined :
   typeof value.senderId==='string'&&value.senderId.length>0&&value.senderId.length<=128;
}
function matches(m:RollingMessageMeta,f:PurgeFilter):boolean{
 return (f.senderId===undefined||m.senderId===f.senderId)&&
   (f.linksOnly!==true||m.hasLinks)&&
   (f.mediaOnly!==true||m.contentType==='MEDIA')&&
   (f.commandsOnly!==true||m.contentType==='COMMAND')&&
   (f.beforeMessageId===undefined||m.messageId<f.beforeMessageId);
}
function allowed(s:BotState,policy:Policy,actor:string,chat:string,now:number):boolean{
 return validActor(actor)&&policy.canUseChat(s,chat,'moderation')&&policy.has(s,actor,'chat.manage',chat,now);
}
function available(s:BotState,job:PurgeJob,now:number):boolean{
 return job.items.every(item=>{
  const current=s.rollingMessageMeta.find(m=>m.chatId===job.chatId&&m.messageId===item.messageId);
  return current&&recent(current,now)&&!protectedMessage(current)&&
    matches(current,job.filter)&&hash(current)===item.metaDigest;
 });
}
function dailyReserved(s:BotState,now:number):number{
 return s.purgeJobs.filter(x=>x.status!=='PREVIEW'&&x.confirmedAt!==undefined&&day(x.confirmedAt)===day(now))
  .reduce((n,job)=>n+job.items.filter(i=>i.status!=='CANCELLED').length,0);
}
/** Daily dispatch limit is enforced at the actual attempt time, not merely at approval.
 * Otherwise plans confirmed late yesterday could all run today over the hard cap. */
function attemptsToday(s:BotState,now:number):number{
 return s.purgeJobs.reduce((count,job)=>count+
   job.items.filter(item=>item.startedAt!==undefined&&day(item.startedAt)===day(now)).length,0);
}
/**
 * B2-Advanced S121-06: the input is a trusted transport's already observed metadata,
 * NEVER arbitrary Telegram chat history (Bot API has no getChatHistory).
 * No text, captions, media payloads, or human readable body is persisted.
 */
export class ModerationPurgeService {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
             private readonly gateway:PurgeGateway,private readonly clock:()=>number=Date.now){}
 async observe(meta:RollingMessageMeta):Promise<boolean>{
  if(!validMeta(meta))throw new Error('RAW_MESSAGE_DATA_FORBIDDEN_OR_INVALID_META');
  const now=this.clock();
  if(meta.observedAt>now||meta.sentAt>meta.observedAt)throw new Error('INVALID_OBSERVATION_TIME');
  return this.store.transaction(s=>{
   if(!this.policy.canUseChat(s,meta.chatId,'moderation'))throw new Error('CHAT_NOT_APPROVED');
   prune(s,now);
   if(!recent(meta,now))return false; // too old cannot enter index or be reported as seen
   const old=s.rollingMessageMeta.find(x=>x.chatId===meta.chatId&&x.messageId===meta.messageId);
   if(old){
    if(old.sentAt!==meta.sentAt||old.senderKind!==meta.senderKind||old.senderId!==meta.senderId)
      throw new Error('OBSERVED_IDENTITY_CHANGED');
    // Protection flags can only become more restrictive on edits.
    Object.assign(old,{
      observedAt:now,contentType:meta.contentType,hasLinks:meta.hasLinks,
      pinned:old.pinned||meta.pinned,
      linkedChannel:old.linkedChannel||meta.linkedChannel,
      adminLog:old.adminLog||meta.adminLog,
      approvedAnnouncement:old.approvedAnnouncement||meta.approvedAnnouncement
    });
   } else s.rollingMessageMeta.push({...meta,observedAt:now});
   return true;
  });
 }
 async preview(actor:string,chatId:string,filter:PurgeFilter):Promise<PurgeJob>{
  if(!filter||!Number.isSafeInteger(filter.limit)||filter.limit<1||filter.limit>MAX_PREVIEW||
    (filter.beforeMessageId!==undefined&&!validId(filter.beforeMessageId))||
    (filter.senderId!==undefined&&(typeof filter.senderId!=='string'||!/^\d+$/.test(filter.senderId)))||
    ['linksOnly','mediaOnly','commandsOnly'].some(k=>filter[k as keyof PurgeFilter]!==undefined&&typeof filter[k as keyof PurgeFilter]!=='boolean')||
    Object.keys(filter).some(k=>!['limit','beforeMessageId','senderId','linksOnly','mediaOnly','commandsOnly'].includes(k)))
   throw new Error('INVALID_PURGE_FILTER');
  return this.store.transaction(s=>{
   if(!allowed(s,this.policy,actor,chatId,this.clock()))throw new Error('MANAGE_DENIED');
   const now=this.clock();
   prune(s,now);
   const observed=s.rollingMessageMeta.filter(m=>m.chatId===chatId&&matches(m,filter))
     .sort((a,b)=>b.messageId-a.messageId);
   const excluded={protected:observed.filter(protectedMessage).length,expired:0};
   const selected=observed.filter(m=>!protectedMessage(m)).slice(0,filter.limit);
   if(selected.length===0)throw new Error('NO_ELIGIBLE_OBSERVED_MESSAGES');
   const job:PurgeJob={id:randomUUID(),chatId,actorId:actor,createdAt:now,expiresAt:now+REVIEW_MS,
     scopeVersion:this.policy.chatRevision(s,chatId),status:'PREVIEW',filter:structuredClone(filter),
     excluded,items:selected.map(m=>({messageId:m.messageId,metaDigest:hash(m),status:'QUEUED'}))};
   s.purgeJobs.push(job);
   return structuredClone(job);
  });
 }
 async confirm(actor:string,jobId:string):Promise<PurgeJob>{
  return this.store.transaction(s=>{
   const job=s.purgeJobs.find(x=>x.id===jobId);
   if(!job)throw new Error('PURGE_NOT_FOUND');
   const now=this.clock();
   if(!allowed(s,this.policy,actor,job.chatId,now))throw new Error('MANAGE_DENIED');
   if(actor!==job.actorId&&!this.policy.isOwner(actor))throw new Error('PREVIEW_ACTOR_MISMATCH');
   if(job.items.length>10&&!this.policy.isOwner(actor))throw new Error('OWNER_APPROVAL_REQUIRED');
   if(job.status!=='PREVIEW')throw new Error('ALREADY_CONFIRMED');
   if(now>job.expiresAt||this.policy.chatRevision(s,job.chatId)!==job.scopeVersion)
     throw new Error('PREVIEW_STALE');
   prune(s,now);
   if(!available(s,job,now))throw new Error('PREVIEW_STALE');
   if(dailyReserved(s,now)+job.items.length>DAILY_LIMIT)throw new Error('DAILY_PURGE_LIMIT');
   const conflict=s.purgeJobs.some(other=>other.id!==job.id&&other.chatId===job.chatId&&
     other.status!=='PREVIEW'&&other.items.some(item=>job.items.some(x=>x.messageId===item.messageId)));
   if(conflict)throw new Error('PURGE_ID_ALREADY_RESERVED');
   job.status='READY';job.confirmedBy=actor;job.confirmedAt=now;
   s.audit.push({updateKey:`b2:purge:confirm:${jobId}`,actorId:actor,
     decision:'ALLOW',reason:'PURGE_PREVIEW_CONFIRMED',
     policyVersion:job.scopeVersion,at:now});
   return structuredClone(job);
  });
 }
 async dispatchNext(jobId:string):Promise<PurgeDispatchResult>{
  const claimed=await this.store.transaction(s=>{
   const job=s.purgeJobs.find(x=>x.id===jobId);
   if(!job)throw new Error('PURGE_NOT_FOUND');
   if(job.status==='PREVIEW')return {kind:'NOT_CONFIRMED' as const};
   if(job.status==='CANCELLED')return {kind:'CANCELLED' as const};
   if(job.status==='PAUSED')return {kind:'PAUSED' as const};
   if(job.status==='COMPLETED')return {kind:'EMPTY' as const};
   const current=job.items.find(x=>x.status!=='ACKNOWLEDGED'&&x.status!=='CANCELLED');
   if(!current){job.status='COMPLETED';return {kind:'EMPTY' as const};}
   if(current.status!=='QUEUED')return {kind:'BLOCKED_UNKNOWN' as const};
   const now=this.clock();
   if(attemptsToday(s,now)>=DAILY_LIMIT)return {kind:'BLOCKED_DAILY_LIMIT' as const};
   prune(s,now);
   if(!allowed(s,this.policy,job.actorId,job.chatId,now)||
      this.policy.chatRevision(s,job.chatId)!==job.scopeVersion||
      !available(s,{...job,items:[current]},now)){
     job.status='PAUSED';return {kind:'BLOCKED' as const};
   }
   current.status='SENDING';current.attemptId=randomUUID();current.startedAt=now;
   current.leaseUntil=nextDispatchLease(now);
   s.audit.push({updateKey:`b2:purge:attempt:${job.id}:${current.messageId}:${current.attemptId}`,
      actorId:job.actorId,decision:'ALLOW',reason:'PURGE_ATTEMPT_DURABLY_RECORDED',
      policyVersion:job.scopeVersion,at:now});
   return {kind:'SEND' as const,chatId:job.chatId,messageId:current.messageId,
     attemptId:current.attemptId,actor:job.actorId,version:job.scopeVersion};
  });
  if(claimed.kind!=='SEND')return {status:claimed.kind};
  let rights=false;
  try{rights=(await this.gateway.canDelete(claimed.chatId))===true;}catch{/* fail closed */}
  const permit=await this.store.transaction(s=>{
   const job=s.purgeJobs.find(x=>x.id===jobId);
   const item=job?.items.find(x=>x.messageId===claimed.messageId);
   if(!job||!item||item.status!=='SENDING'||item.attemptId!==claimed.attemptId)return false;
   if(leaseExpired(item.leaseUntil,this.clock())){item.status='UNKNOWN_OUTCOME';return false;}
   prune(s,this.clock());
   if(job.status==='READY'&&rights&&allowed(s,this.policy,claimed.actor,claimed.chatId,this.clock())&&
     this.policy.chatRevision(s,claimed.chatId)===claimed.version&&available(s,{...job,items:[item]},this.clock()))return true;
   item.status=job.status==='CANCELLED'?'CANCELLED':'QUEUED';
   delete item.attemptId;delete item.leaseUntil;delete item.startedAt;
   if(job.status==='READY')job.status='PAUSED';
   return false;
  });
  if(!permit)return {status:'BLOCKED'};
  let outcome:PurgeOutcome;
  try{outcome=await this.gateway.deleteMessage(claimed.chatId,claimed.messageId,claimed.attemptId);}
  catch{outcome='UNKNOWN_OUTCOME';}
  return this.store.transaction(s=>{
   const job=s.purgeJobs.find(x=>x.id===jobId);
   const item=job?.items.find(x=>x.messageId===claimed.messageId);
   if(!job||!item||item.status!=='SENDING'||item.attemptId!==claimed.attemptId)
     return {status:'BLOCKED' as const};
   item.status=outcome;
   s.audit.push({updateKey:`b2:purge:result:${job.id}:${item.messageId}:${item.attemptId}`,
     actorId:job.actorId,decision:outcome==='ACKNOWLEDGED'?'ALLOW':'NOOP',
     reason:outcome==='ACKNOWLEDGED'?'PURGE_DELETE_REQUEST_ACCEPTED':`PURGE_${outcome}`,
     policyVersion:job.scopeVersion,at:this.clock()});
   if(job.status==='READY'&&job.items.every(x=>x.status==='ACKNOWLEDGED'||x.status==='CANCELLED'))
     job.status='COMPLETED';
   return {status:outcome,messageId:item.messageId};
  });
 }
 async recoverPending():Promise<number>{
  return this.store.transaction(s=>{
   let changed=0;
   for(const job of s.purgeJobs)for(const item of job.items){
    if(item.status==='SENDING'&&leaseExpired(item.leaseUntil,this.clock())){
      item.status='UNKNOWN_OUTCOME';changed++;
    }
   }
   return changed;
  });
 }
 async cancel(actor:string,jobId:string):Promise<void>{
  await this.store.transaction(s=>{
   const job=s.purgeJobs.find(x=>x.id===jobId);
   if(!job)throw new Error('PURGE_NOT_FOUND');
   if(!allowed(s,this.policy,actor,job.chatId,this.clock())||
     (actor!==job.actorId&&!this.policy.isOwner(actor)))throw new Error('MANAGE_DENIED');
   if(job.status==='CANCELLED')return;
   if(job.status==='COMPLETED')throw new Error('PURGE_ALREADY_COMPLETED');
   job.status='CANCELLED';
   for(const item of job.items)if(item.status==='QUEUED'||item.status==='FAILED_CONFIRMED')item.status='CANCELLED';
   s.audit.push({updateKey:`b2:purge:cancel:${jobId}`,actorId:actor,decision:'ALLOW',
      reason:'PURGE_CANCELLED',policyVersion:job.scopeVersion,at:this.clock()});
  });
 }
}
