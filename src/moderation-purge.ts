import {createHash,randomUUID} from 'node:crypto';
import {BotStore,type BotState,type RollingMessageMeta,type PurgeJob,type PurgeFilter,type PurgeItem} from './store.js';
import {Policy} from './policy.js';
import {nextDispatchLease,leaseExpired} from './publication-worker-lease.js';

const WINDOW_MS=48*60*60*1000, REVIEW_MS=10*60*1000, MAX_PREVIEW=25, DAILY_LIMIT=50;
const RETENTION_MS=30*24*60*60*1000;
const MIN_REVIEW_CADENCE_MS=24*60*60*1000,MAX_REVIEW_CADENCE_MS=30*24*60*60*1000;
const timeInt=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function validRetentionControl(v:unknown):boolean{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const c=v as Record<string,unknown>;
 if(Object.keys(c).some(k=>!['enabled','cadenceMs','version','nextCheckAt','lastCheckedAt','lastNotice'].includes(k)))return false;
 if(typeof c.enabled!=='boolean'||!Number.isSafeInteger(c.cadenceMs)||
    typeof c.cadenceMs!=='number'||c.cadenceMs<MIN_REVIEW_CADENCE_MS||
    c.cadenceMs>MAX_REVIEW_CADENCE_MS||!timeInt(c.nextCheckAt)||
    !Number.isSafeInteger(c.version)||typeof c.version!=='number'||c.version<1)return false;
 if(c.lastCheckedAt!==undefined&&!timeInt(c.lastCheckedAt))return false;
 if(c.lastNotice!==undefined){
  const n=c.lastNotice;
  if(!n||typeof n!=='object'||Array.isArray(n))return false;
  const x=n as Record<string,unknown>;
  if(Object.keys(x).some(k=>!['checkedAt','expiresAt','digest','expiredObserved','eligibleJobs','reasonsToRedact','evidenceIdsToRedact','senderFiltersToRedact'].includes(k))||
   !['checkedAt','expiresAt','expiredObserved','eligibleJobs','reasonsToRedact','evidenceIdsToRedact','senderFiltersToRedact'].every(k=>timeInt(x[k]))||
   typeof x.digest!=='string'||!(/^[0-9a-f]{64}$/.test(x.digest))||
   c.lastCheckedAt!==x.checkedAt)return false;
 }
 return true;
}
const retentionDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidenceDigest=(id:string)=>createHash('sha256').update('manaratak:purge:evidence:'+id).digest('hex');
export interface PurgeRetentionPreview {
 checkedAt:number; expiresAt:number; digest:string;
 expiredObserved:number; eligibleJobs:number; reasonsToRedact:number;
 evidenceIdsToRedact:number; senderFiltersToRedact:number;
}

type PurgeOutcome='ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
/** A rate-limit is eligible for later retry only when the gateway explicitly proves
 * the provider rejected the request BEFORE any delete operation was accepted. */
export type PurgeRateLimit={status:'RATE_LIMITED';retryAfterMs:number};
export type PurgeGatewayResult=PurgeOutcome|PurgeRateLimit;
/** Provider-independent *mock* proof binding to one outbound deletion attempt.
 * ACKNOWLEDGED is proof of request acceptance only, never physical deletion. */
export interface PurgeEvidence {
 evidenceId:string;chatId:string;messageId:number;attemptId:string;
 outcome:'ACKNOWLEDGED'|'FAILED_CONFIRMED';
}
function validEvidence(v:unknown):v is PurgeEvidence {
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const e=v as Record<string,unknown>;
 return Object.keys(e).length===5&&
  typeof e.evidenceId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(e.evidenceId)&&
  typeof e.chatId==='string'&&/^-[0-9]+$/.test(e.chatId)&&
  typeof e.messageId==='number'&&Number.isSafeInteger(e.messageId)&&e.messageId>0&&
  typeof e.attemptId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(e.attemptId)&&
  (e.outcome==='ACKNOWLEDGED'||e.outcome==='FAILED_CONFIRMED');
}
const MAX_RETRY_AFTER_MS=3_600_000;
function confirmedRateLimit(value:unknown):value is PurgeRateLimit {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const r=value as Record<string,unknown>;
 return r.status==='RATE_LIMITED'&&Number.isSafeInteger(r.retryAfterMs)&&
   typeof r.retryAfterMs==='number'&&r.retryAfterMs>=1&&r.retryAfterMs<=MAX_RETRY_AFTER_MS&&
   Object.keys(r).length===2;
}
function normalizedOutcome(value:unknown):PurgeOutcome|'RATE_LIMITED' {
 if(confirmedRateLimit(value))return 'RATE_LIMITED';
 if(value==='ACKNOWLEDGED'||value==='FAILED_CONFIRMED'||value==='UNKNOWN_OUTCOME')return value;
 return 'UNKNOWN_OUTCOME'; // malformed 429 or impossible gateway status is not proof of failure
}

export interface PurgeGateway {
 canDelete(chatId:string):Promise<boolean>;
 deleteMessage(chatId:string,messageId:number,attemptId:string):Promise<PurgeGatewayResult>;
 /** Must independently verify issuer, scope, attempt and statement of provider result. */
 verifyEvidence(evidence:PurgeEvidence):Promise<boolean>;
}
export class FakePurgeGateway implements PurgeGateway {
 rights=true;
 throwAfterDelete=false;
 outcome:PurgeGatewayResult='ACKNOWLEDGED';
 calls:{chatId:string;messageId:number;attemptId:string}[]=[];
 private evidenceRegistry=new Map<string,PurgeEvidence>();
 /** Test-only provenance simulation, not external proof. */
 acceptEvidence(evidence:PurgeEvidence):void {this.evidenceRegistry.set(evidence.evidenceId,structuredClone(evidence));}
 async verifyEvidence(evidence:PurgeEvidence):Promise<boolean>{
  return JSON.stringify(this.evidenceRegistry.get(evidence.evidenceId))===JSON.stringify(evidence);
 }
 async canDelete(_chatId:string):Promise<boolean>{return this.rights;}
 async deleteMessage(chatId:string,messageId:number,attemptId:string):Promise<PurgeGatewayResult>{
  this.calls.push({chatId,messageId,attemptId});
  if(this.throwAfterDelete)throw new Error('simulated ambiguous timeout');
  return this.outcome;
 }
}
export type PurgeDispatchResult={status:PurgeOutcome|'RATE_LIMITED'|'EMPTY'|'BLOCKED'|'BLOCKED_UNKNOWN'|'BLOCKED_PENDING'|'BLOCKED_DAILY_LIMIT'|'NOT_CONFIRMED'|'PAUSED'|'CANCELLED';messageId?:number};
const hash=(m:RollingMessageMeta)=>createHash('sha256').update(JSON.stringify([
 m.chatId,m.messageId,m.senderKind,m.senderId??null,m.sentAt,m.contentType,m.hasLinks,
 m.pinned,m.linkedChannel,m.adminLog,m.approvedAnnouncement
])).digest('hex');
const terminalItem=(s:PurgeItem['status'])=>s==='ACKNOWLEDGED'||s==='CANCELLED'||s==='SKIPPED_UNVERIFIED';
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
 // Count immutable intent audit events, not the latest mutable item.startedAt.
 // A confirmed 429 permits another attempt later; EVERY attempt consumes the daily cap.
 return s.audit.filter(a=>a.reason==='PURGE_ATTEMPT_DURABLY_RECORDED'&&day(a.at)===day(now)).length;
}
function chatCooldown(s:BotState,chatId:string):number {
 return s.purgeJobs.reduce((until,job)=>job.chatId===chatId?Math.max(until,job.rateLimitedUntil??0):until,0);
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
   const current=job.items.find(x=>!terminalItem(x.status));
   if(!current){job.status='COMPLETED';return {kind:'EMPTY' as const};}
   if(current.status!=='QUEUED')return {kind:'BLOCKED_UNKNOWN' as const};
   // Serialize all outbound mock delete attempts per destination chat. A separate
   // job must not race the first worker's awaited preflight or 429 response.
   if(s.purgeJobs.some(other=>other.id!==job.id&&other.chatId===job.chatId&&
      other.items.some(item=>item.status==='SENDING')))return {kind:'BLOCKED_PENDING' as const};
   const now=this.clock();
   if(chatCooldown(s,job.chatId)>now)return {kind:'RATE_LIMITED' as const};
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
  let response:unknown;
  try{response=await this.gateway.deleteMessage(claimed.chatId,claimed.messageId,claimed.attemptId);}
  catch{response='UNKNOWN_OUTCOME';}
  const outcome=normalizedOutcome(response);
  return this.store.transaction(s=>{
   const job=s.purgeJobs.find(x=>x.id===jobId);
   const item=job?.items.find(x=>x.messageId===claimed.messageId);
   if(!job||!item||item.status!=='SENDING'||item.attemptId!==claimed.attemptId)
     return {status:'BLOCKED' as const};
   const recordedAttempt=item.attemptId;
   if(outcome==='RATE_LIMITED'&&confirmedRateLimit(response)){
     // Explicit 429 is a confirmed rejection, not an ambiguous network outcome.
     // Never auto-loop; only a future explicit dispatch can retry after cooldown.
     const next=this.clock()+response.retryAfterMs;
     if(!Number.isSafeInteger(next)) {
       item.status='UNKNOWN_OUTCOME';
     }else{
       item.status=job.status==='CANCELLED'?'CANCELLED':'QUEUED';
       job.rateLimitedUntil=Math.max(job.rateLimitedUntil??0,next);
       delete item.attemptId;delete item.leaseUntil;delete item.startedAt;
     }
   }else item.status=outcome==='RATE_LIMITED'?'UNKNOWN_OUTCOME':outcome;
   const result=item.status==='QUEUED'||(job.status==='CANCELLED'&&item.status==='CANCELLED')
     ? 'RATE_LIMITED' : item.status;
   s.audit.push({updateKey:`b2:purge:result:${job.id}:${item.messageId}:${recordedAttempt}`,
     actorId:job.actorId,decision:result==='ACKNOWLEDGED'?'ALLOW':'NOOP',
     reason:result==='ACKNOWLEDGED'?'PURGE_DELETE_REQUEST_ACCEPTED':`PURGE_${result}`,
     policyVersion:job.scopeVersion,at:this.clock()});
   if(job.status==='READY'&&job.items.every(x=>terminalItem(x.status)))
     job.status='COMPLETED';
   return {status:result,messageId:item.messageId};
  });
 }
 /**
  * Explicit human reconciliation of ONE quarantined attempt. A gateway callback,
  * timestamp or message text alone cannot prove whether an external delete occurred.
  * Verify asynchronously then recheck all rights, attempt ID and proof uniqueness in
  * the same durable transaction (SQLite independent-process safe).
  */
 async reconcileUnknown(actor:string,jobId:string,messageId:number,evidence:PurgeEvidence):Promise<PurgeItem>{
  if(!validEvidence(evidence)||!validId(messageId)||evidence.messageId!==messageId)
   throw new Error('EVIDENCE_INVALID');
  const before=await this.store.snapshot();
  const job=before.purgeJobs.find(j=>j.id===jobId),item=job?.items.find(i=>i.messageId===messageId);
  if(!job||!item)throw new Error('PURGE_NOT_FOUND');
  if(!allowed(before,this.policy,actor,job.chatId,this.clock())||
     (actor!==job.actorId&&!this.policy.isOwner(actor)))throw new Error('REVIEW_DENIED');
  if(item.status!=='UNKNOWN_OUTCOME'||item.attemptId!==evidence.attemptId||
     evidence.chatId!==job.chatId||this.evidenceReused(before,evidence.evidenceId))
   throw new Error('EVIDENCE_INVALID');
  let verified=false;
  try { verified=(await this.gateway.verifyEvidence(evidence))===true; }
  catch {/* external failure is not evidence */}
  if(!verified)throw new Error('EVIDENCE_UNVERIFIED');
  return this.store.transaction(s=>{
   const currentJob=s.purgeJobs.find(j=>j.id===jobId);
   const current=currentJob?.items.find(i=>i.messageId===messageId);
   if(!currentJob||!current)throw new Error('PURGE_NOT_FOUND');
   if(!allowed(s,this.policy,actor,currentJob.chatId,this.clock())||
      (actor!==currentJob.actorId&&!this.policy.isOwner(actor)))throw new Error('REVIEW_DENIED');
   if(current.status!=='UNKNOWN_OUTCOME'||current.attemptId!==evidence.attemptId||
      currentJob.chatId!==evidence.chatId||this.evidenceReused(s,evidence.evidenceId))
     throw new Error('EVIDENCE_INVALID');
   current.status=evidence.outcome;
   current.reconciliation={evidenceId:evidence.evidenceId,reviewedBy:actor,at:this.clock(),
     verifiedOutcome:evidence.outcome};
   s.audit.push({updateKey:`b2:purge:reconcile:${jobId}:${messageId}:${evidenceDigest(evidence.evidenceId)}`,
     actorId:actor,decision:'ALLOW',reason:'PURGE_EVIDENCE_RECONCILED',
     policyVersion:currentJob.scopeVersion,at:this.clock()});
   if(currentJob.status==='READY'&&currentJob.items.every(x=>terminalItem(x.status)))
      currentJob.status='COMPLETED';
   return structuredClone(current);
  });
 }
 private evidenceReused(s:BotState,evidenceId:string):boolean {
  const hash=evidenceDigest(evidenceId);
  return s.purgeJobs.some(job=>job.items.some(i=>i.reconciliation?.evidenceId===evidenceId||
    i.reconciliation?.evidenceDigest===hash));
 }
 /** Owner's irrevocable choice to stop investigating—not a finding that the
  * message was deleted, nor approval to replay an UNKNOWN attempt. */
 async skipForReview(actor:string,jobId:string,messageId:number,reason:string):Promise<PurgeItem>{
  if(!this.policy.isOwner(actor))throw new Error('OWNER_ONLY');
  if(typeof reason!=='string'||reason.trim().length<5||reason.trim().length>200||
     /[\u0000-\u001F\u007F]/u.test(reason))
    throw new Error('INVALID_REVIEW_REASON');
  return this.store.transaction(s=>{
   const job=s.purgeJobs.find(j=>j.id===jobId);
   const item=job?.items.find(i=>i.messageId===messageId);
   if(!job||!item)throw new Error('PURGE_NOT_FOUND');
   if(!allowed(s,this.policy,actor,job.chatId,this.clock()))throw new Error('REVIEW_DENIED');
   if(item.status!=='UNKNOWN_OUTCOME'&&item.status!=='FAILED_CONFIRMED')
     throw new Error('NOT_REVIEWABLE');
   item.status='SKIPPED_UNVERIFIED';
   item.reconciliation={reviewedBy:actor,at:this.clock(),reason:reason.trim(),verifiedOutcome:'SKIPPED_UNVERIFIED'};
   s.audit.push({updateKey:`b2:purge:skip:${jobId}:${messageId}`,
     actorId:actor,decision:'ALLOW',reason:'PURGE_MANUAL_SKIP_UNVERIFIED',
     policyVersion:job.scopeVersion,at:this.clock()});
   if(job.status==='READY'&&job.items.every(x=>terminalItem(x.status)))job.status='COMPLETED';
   return structuredClone(item);
  });
 }
 /** Access-controlled counts, not an assertion of physical Telegram deletion. */
 async reviewProgress(actor:string,jobId:string):Promise<{
  total:number;remaining:number;requestAccepted:number;deletedConfirmed:0;skippedUnverified:number;
  confirmedFailed:number;unknown:number;cancelled:number;
 }>{
  const s=await this.store.snapshot();
  const job=s.purgeJobs.find(j=>j.id===jobId);
  if(!job)throw new Error('PURGE_NOT_FOUND');
  if(!allowed(s,this.policy,actor,job.chatId,this.clock()))throw new Error('REVIEW_DENIED');
  const count=(status:PurgeItem['status'])=>job.items.filter(i=>i.status===status).length;
  return {total:job.items.length,remaining:job.items.filter(i=>!terminalItem(i.status)).length,
    requestAccepted:count('ACKNOWLEDGED'),deletedConfirmed:0,skippedUnverified:count('SKIPPED_UNVERIFIED'),
    confirmedFailed:count('FAILED_CONFIRMED'),unknown:count('UNKNOWN_OUTCOME'),cancelled:count('CANCELLED')};
 }
 /**
  * Owner-visible, read-only retention review. This function never deletes, redacts
  * or alters the ledger and never makes a provider API request.
  */
 /** Only owner may opt in. Cadence is a minimum 24h and maximum 30 days.
  * No cron, background task, provider call or deletion is started here. */
 async configureRetentionReview(actor:string,settings:{enabled:boolean;cadenceMs:number}):
 Promise<import('./store.js').PurgeRetentionReviewControl>{
  if(!this.policy.isOwner(actor))throw new Error('OWNER_ONLY');
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||
     Object.keys(settings).length!==2||Object.keys(settings).some(k=>!['enabled','cadenceMs'].includes(k))||
     typeof settings.enabled!=='boolean'||!Number.isSafeInteger(settings.cadenceMs)||
     typeof settings.cadenceMs!=='number'||settings.cadenceMs<MIN_REVIEW_CADENCE_MS||
     settings.cadenceMs>MAX_REVIEW_CADENCE_MS)throw new Error('INVALID_RETENTION_SCHEDULE');
  const now=this.clock();
  if(!timeInt(now)||!timeInt(now+settings.cadenceMs))throw new Error('INVALID_RETENTION_SCHEDULE');
  return this.store.transaction(s=>{
   const old=s.purgeRetentionReview;
   if(old!==undefined&&!validRetentionControl(old))throw new Error('INVALID_RETENTION_SCHEDULE');
   const next={enabled:settings.enabled,cadenceMs:settings.cadenceMs,
     version:(old?.version??0)+1,nextCheckAt:now+settings.cadenceMs};
   if(!Number.isSafeInteger(next.version))throw new Error('INVALID_RETENTION_SCHEDULE');
   s.purgeRetentionReview=next;
   s.audit.push({actorId:actor,updateKey:'b2:retention:configure:'+randomUUID(),
     decision:'ALLOW',reason:settings.enabled?'PURGE_RETENTION_REVIEW_ENABLED':'PURGE_RETENTION_REVIEW_DISABLED',
     policyVersion:0,at:now});
   return structuredClone(next);
  });
 }
 /** Owner-only access to the previously generated aggregate notice; no sender IDs. */
 async getRetentionReview(actor:string):Promise<import('./store.js').PurgeRetentionReviewControl|null>{
  if(!this.policy.isOwner(actor))throw new Error('OWNER_ONLY');
  const state=await this.store.snapshot(),config=state.purgeRetentionReview;
  if(config===undefined)return null;
  if(!validRetentionControl(config))throw new Error('INVALID_RETENTION_SCHEDULE');
  return structuredClone(config);
 }
 /** Invoked only by a future trusted scheduler/manual operator. It NEVER redacts,
  * deletes, calls Telegram or authorizes compactRetention. Cross-worker claiming
  * and preview calculation happen in one atomic state transaction. */
 async tickRetentionReview():Promise<{status:'DISABLED'|'NOT_DUE'|'CLOCK_ROLLBACK'|'READY';notice?:PurgeRetentionPreview}>{
  return this.store.transaction(s=>{
   const config=s.purgeRetentionReview;
   if(config===undefined)return {status:'DISABLED' as const};
   if(!validRetentionControl(config))throw new Error('INVALID_RETENTION_SCHEDULE');
   if(!config.enabled)return {status:'DISABLED' as const};
   const now=this.clock();
   if(!timeInt(now)||!timeInt(now+config.cadenceMs))throw new Error('INVALID_RETENTION_SCHEDULE');
   if(config.lastCheckedAt!==undefined&&now<config.lastCheckedAt)return {status:'CLOCK_ROLLBACK' as const};
   if(now<config.nextCheckAt)return {status:'NOT_DUE' as const};
   const notice=this.retentionCandidates(s,now).preview;
   config.lastCheckedAt=now;
   config.lastNotice=structuredClone(notice);
   config.nextCheckAt=now+config.cadenceMs; // late ticks catch up once; no hourly replay loop
   s.audit.push({actorId:'SYSTEM_RETENTION_REVIEW',updateKey:'b2:retention:review:'+randomUUID(),
     decision:'NOOP',reason:'PURGE_RETENTION_REVIEW_DUE',policyVersion:0,at:now});
   return {status:'READY' as const,notice};
  });
 }
 async previewRetention(actor:string):Promise<PurgeRetentionPreview>{
  if(!this.policy.isOwner(actor))throw new Error('OWNER_ONLY');
  return this.retentionCandidates(await this.store.snapshot(),this.clock()).preview;
 }
 private retentionCandidates(s:BotState,checkedAt:number):{preview:PurgeRetentionPreview;ids:string[]}{
  // A message's send timestamp governs deletion eligibility; retained metadata
  // older than 48h must be pruned independent of later observation time.
  const expired=s.rollingMessageMeta.filter(m=>!recent(m,checkedAt));
  const eligible=s.purgeJobs.filter(job=>{
   if(!['COMPLETED','CANCELLED'].includes(job.status)||!job.items.every(i=>terminalItem(i.status)))return false;
   // Last activity, not creation or initial confirmation, starts the redaction clock.
   const latest=Math.max(job.createdAt,job.confirmedAt??0,
     ...job.items.map(i=>Math.max(i.startedAt??0,i.reconciliation?.at??0)),
     ...s.audit.filter(a=>a.updateKey.includes(job.id)).map(a=>a.at));
   if(checkedAt-latest<RETENTION_MS)return false;
   return job.filter.senderId!==undefined||job.items.some(i=>
     i.metaDigest!=='REDACTED'||i.attemptId!==undefined||
     i.reconciliation?.reason!==undefined||i.reconciliation?.evidenceId!==undefined);
  });
  const material={expired,eligible};
  return {ids:eligible.map(x=>x.id),preview:{
   checkedAt,expiresAt:checkedAt+REVIEW_MS,
   digest:retentionDigest(material),
   expiredObserved:expired.length,eligibleJobs:eligible.length,
   reasonsToRedact:eligible.reduce((n,j)=>n+j.items.filter(x=>x.reconciliation?.reason!==undefined).length,0),
   evidenceIdsToRedact:eligible.reduce((n,j)=>n+j.items.filter(x=>x.reconciliation?.evidenceId!==undefined).length,0),
   senderFiltersToRedact:eligible.filter(x=>x.filter.senderId!==undefined).length
  }};
 }
 /** Explicit second approval; optimistic fingerprint and time fence plus atomic state
  * mutation prevent racing workers from scrubbing newly changed records.
  * The message reservation IDs and statuses remain immutable tombstones.
  */
 async compactRetention(actor:string,review:PurgeRetentionPreview):Promise<{
   expiredObserved:number;redactedJobs:number;redactedReasons:number;redactedEvidenceIds:number;
 }>{
  if(!this.policy.isOwner(actor))throw new Error('OWNER_ONLY');
  const now=this.clock();
  if(!review||!Number.isSafeInteger(review.checkedAt)||review.checkedAt>now||
     now>review.checkedAt+REVIEW_MS)throw new Error('RETENTION_PREVIEW_EXPIRED');
  return this.store.transaction(s=>{
   const {preview,ids}=this.retentionCandidates(s,review.checkedAt);
   if(preview.digest!==review.digest||preview.expiredObserved!==review.expiredObserved||
      preview.eligibleJobs!==review.eligibleJobs||
      preview.reasonsToRedact!==review.reasonsToRedact||
      preview.evidenceIdsToRedact!==review.evidenceIdsToRedact||
      preview.senderFiltersToRedact!==review.senderFiltersToRedact)
      throw new Error('RETENTION_PREVIEW_STALE');
   // Recheck eligibility at COMMIT time, not only when the preview was generated.
   const current=this.retentionCandidates(s,now);
   if(ids.some(id=>!current.ids.includes(id)))throw new Error('RETENTION_PREVIEW_STALE');
   const expiredBefore=s.rollingMessageMeta.length;
   prune(s,now);
   let redactedReasons=0,redactedEvidenceIds=0;
   for(const id of ids){
    const job=s.purgeJobs.find(x=>x.id===id)!;
    delete job.filter.senderId;
    for(const item of job.items){
     item.metaDigest='REDACTED'; // do not retain digest of a sender's metadata
     delete item.attemptId;delete item.leaseUntil;delete item.startedAt;
     const rec=item.reconciliation;
     if(!rec)continue;
     if(rec.reason!==undefined){delete rec.reason;redactedReasons++;}
     if(rec.evidenceId!==undefined){
      const oldId=rec.evidenceId;
      rec.evidenceDigest=evidenceDigest(oldId); // retain one-use safety without raw identifier
      delete rec.evidenceId;redactedEvidenceIds++;
      // Legacy v0.5.2 audit IDs contained the raw proof ID in the updateKey.
      // Scrub those while retaining a stable unique hashed audit key.
      for(const audit of s.audit)if(audit.updateKey.includes(':purge:reconcile:'+job.id+':')&&
           audit.updateKey.endsWith(':'+oldId))
        audit.updateKey=audit.updateKey.slice(0,-oldId.length)+rec.evidenceDigest;
     }
    }
   }
   if(expiredBefore!==s.rollingMessageMeta.length||ids.length>0)
    s.audit.push({updateKey:'b2:retention:'+randomUUID(),actorId:actor,
      decision:'ALLOW',reason:'PURGE_RETENTION_COMPACTED',policyVersion:0,at:now});
   return {expiredObserved:expiredBefore-s.rollingMessageMeta.length,
     redactedJobs:ids.length,redactedReasons,redactedEvidenceIds};
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
