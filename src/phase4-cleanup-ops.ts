import {createHash,randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {defaultCommunityConfig,validCommunityConfig,type CommunityCleanupJob,type CommunityCleanupReviewDraft,
 type CommunityCleanupStatus} from './phase4-community-model.js';

const group=(id:string)=>/^-[1-9]\d{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
const key=(id:string)=>/^[a-f0-9]{64}$/u.test(id);
const reviewId=(id:string)=>/^[a-f0-9]{24}$/u.test(id);
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-120000;
const digest=(keys:readonly string[])=>createHash('sha256')
 .update('MANARATAK:P4:SERVICE:CANCEL-GROUP:v1:')
 .update(keys.slice().sort().join('\n'),'utf8').digest('hex');
const statuses:readonly CommunityCleanupStatus[]=[
 'QUEUED','SENDING','CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME',
 'REVIEWED_UNKNOWN','SKIPPED'];
export interface CleanupOwnerSnapshot{
 chatId:string;chatVersion:number;configVersion:number;
 cleanupEnabled:boolean;replyCleanupEnabled:boolean;delayMs:number;replyDelayMs:number;
 joinEnabled:boolean;leaveEnabled:boolean;profileEnabled:boolean;
 counts:Readonly<Record<CommunityCleanupStatus,number>>;
 queueKind:{service:number;automaticReply:number};
 jobs:CommunityCleanupJob[];
}
export type CleanupReviewAction=CommunityCleanupReviewDraft['action'];
export class Phase4CleanupOperations{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private authorized(state:BotState,actor:string,chatId:string):{chatVersion:number;configVersion:number}|null{
  if(!group(chatId)||!this.policy.isOwner(actor)||
    !this.policy.has(state,actor,'chat.manage',chatId)||
    !this.policy.canUseChat(state,chatId,'navigation'))return null;
  const chats=state.chats.filter(c=>c.id===chatId&&c.approved&&c.present&&
    c.scopes.includes('navigation'));
  const configs=state.phase4Community?.configs.filter(c=>c.chatId===chatId)??[];
  if(chats.length!==1||configs.length>1||
    (configs.length===1&&!validCommunityConfig(configs[0])))return null;
  return {chatVersion:chats[0]!.version,configVersion:configs[0]?.version??0};
 }
 async groups(actor:string):Promise<string[]>{
  if(!this.policy.isOwner(actor))return [];
  const s=await this.store.snapshot();
  const ids=new Set(s.chats.map(x=>x.id).filter(id=>group(id)&&
    this.policy.canUseChat(s,id,'navigation')&&
    this.policy.has(s,actor,'chat.manage',id)));
  return [...ids].sort().filter(id=>s.chats.filter(c=>c.id===id&&
    c.approved&&c.present&&c.scopes.includes('navigation')).length===1);
 }
 async snapshot(actor:string,chatId:string):Promise<CleanupOwnerSnapshot|null>{
  const s=await this.store.snapshot();
  const access=this.authorized(s,actor,chatId);
  if(!access)return null;
  const config=s.phase4Community?.configs.find(c=>c.chatId===chatId)??
   defaultCommunityConfig(chatId);
  const jobs=(s.phase4Community?.cleanupJobs??[])
   .filter(x=>x.chatId===chatId)
   .sort((a,b)=>b.observedAt-a.observedAt||b.key.localeCompare(a.key));
  const counts=Object.fromEntries(statuses.map(k=>[k,0])) as Record<CommunityCleanupStatus,number>;
  for(const job of jobs)counts[job.status]++;
  const queue=jobs.filter(j=>j.status==='QUEUED');
  return {
   chatId,chatVersion:access.chatVersion,configVersion:access.configVersion,
   cleanupEnabled:config.serviceCleanup?.enabled??false,
   replyCleanupEnabled:config.replyCleanup?.enabled??false,
   delayMs:config.serviceCleanup?.delayMs??120000,
   replyDelayMs:config.replyCleanup?.delayMs??120000,
   joinEnabled:config.serviceCleanup?.joinEnabled!==false,
   leaveEnabled:config.serviceCleanup?.leaveEnabled!==false,
   profileEnabled:config.serviceCleanup?.profileEnabled!==false,
   counts,queueKind:{
    service:queue.filter(j=>j.kind!=='AUTOMATIC_REPLY').length,
    automaticReply:queue.filter(j=>j.kind==='AUTOMATIC_REPLY').length
   },
   jobs:structuredClone(jobs.slice(0,100))
  };
 }
 /** An extra explicit approval is needed before cancelling a pending item.
  * A bulk cancellation freezes all currently QUEUED identifiers in a digest;
  * a later arrival or a started deletion invalidates the entire approval.
  */
 async prepare(actor:string,chatId:string,action:CleanupReviewAction,
  targetKey?:string):Promise<{draft:CommunityCleanupReviewDraft;count:number}>{
  if(!this.policy.isOwner(actor)||!group(chatId)||
    !['CANCEL_ONE','CANCEL_GROUP','REVIEW_ONE'].includes(action))
   throw Error('CLEANUP_OWNER_DENIED');
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!validTime(now))throw Error('CLEANUP_CLOCK_UNTRUSTED');
   const access=this.authorized(s,actor,chatId);
   if(!access||access.configVersion<1)throw Error('CLEANUP_GROUP_UNAVAILABLE');
   const jobs=(s.phase4Community?.cleanupJobs??[]).filter(j=>j.chatId===chatId);
   let keys:string[],count=1;
   if(action==='CANCEL_GROUP'){
    if(targetKey!==undefined)throw Error('CLEANUP_BULK_INVALID');
    keys=jobs.filter(j=>j.status==='QUEUED').map(j=>j.key).sort();
    count=keys.length;
    if(!count)throw Error('CLEANUP_QUEUE_EMPTY');
   }else{
    if(!targetKey||!key(targetKey))throw Error('CLEANUP_KEY_INVALID');
    const matches=jobs.filter(j=>j.key===targetKey);
    if(matches.length!==1)throw Error('CLEANUP_JOB_NOT_FOUND');
    const job=matches[0]!;
    if(action==='CANCEL_ONE'&&job.status!=='QUEUED')
     throw Error('CLEANUP_NOT_QUEUED');
    if(action==='REVIEW_ONE'&&(!['SENDING','UNKNOWN_OUTCOME'].includes(job.status)||
       now<job.dueAt+600000))
     throw Error('CLEANUP_REVIEW_NOT_READY');
    keys=[targetKey];
   }
   s.phase4Community!.cleanupReviewDrafts=(s.phase4Community!.cleanupReviewDrafts??[])
    .filter(d=>d.expiresAt>now&&d.createdAt<=now&&d.actorId!==actor);
   if(s.phase4Community!.cleanupReviewDrafts.length>=50)
    throw Error('CLEANUP_DRAFT_CAPACITY');
   const draft:CommunityCleanupReviewDraft={
    id:randomBytes(12).toString('hex'),actorId:actor,chatId,
    chatVersion:access.chatVersion,configVersion:access.configVersion,
    action,createdAt:now,expiresAt:now+120000,
    ...(action==='CANCEL_GROUP'?{queueDigest:digest(keys),targetCount:count}:
      {targetKey:keys[0]!})
   };
   s.phase4Community!.cleanupReviewDrafts.push(draft);
   return {draft:structuredClone(draft),count};
  });
 }
 async cancelDraft(actor:string,id:string):Promise<boolean>{
  if(!this.policy.isOwner(actor)||!reviewId(id))return false;
  return this.store.transaction(s=>{
   const drafts=s.phase4Community?.cleanupReviewDrafts??[];
   if(drafts.filter(d=>d.id===id&&d.actorId===actor).length!==1)return false;
   s.phase4Community!.cleanupReviewDrafts=drafts.filter(d=>d.id!==id);
   return true;
  });
 }
 async confirm(actor:string,id:string):Promise<{count:number;chatId:string;action:CleanupReviewAction}>{
  if(!this.policy.isOwner(actor)||!reviewId(id))throw Error('CLEANUP_OWNER_DENIED');
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!validTime(now))throw Error('CLEANUP_CLOCK_UNTRUSTED');
   const drafts=s.phase4Community?.cleanupReviewDrafts?.filter(d=>d.id===id)??[];
   if(drafts.length!==1||drafts[0]!.actorId!==actor)throw Error('CLEANUP_DRAFT_NOT_FOUND');
   const d=drafts[0]!;
   if(now<d.createdAt||now>=d.expiresAt)throw Error('CLEANUP_DRAFT_EXPIRED');
   const access=this.authorized(s,actor,d.chatId);
   if(!access||access.chatVersion!==d.chatVersion||
      access.configVersion!==d.configVersion)
    throw Error('CLEANUP_POLICY_CHANGED');
   const jobs=(s.phase4Community?.cleanupJobs??[]).filter(j=>j.chatId===d.chatId);
   let targets:CommunityCleanupJob[]=[];
   if(d.action==='CANCEL_GROUP'){
    targets=jobs.filter(j=>j.status==='QUEUED');
    if(targets.length!==d.targetCount||
      digest(targets.map(j=>j.key))!==d.queueDigest)
     throw Error('CLEANUP_QUEUE_CHANGED');
   }else{
    targets=jobs.filter(j=>j.key===d.targetKey);
    if(targets.length!==1)throw Error('CLEANUP_JOB_CHANGED');
    const job=targets[0]!;
    if(d.action==='CANCEL_ONE'&&job.status!=='QUEUED')
     throw Error('CLEANUP_JOB_STARTED');
    if(d.action==='REVIEW_ONE'&&(!['SENDING','UNKNOWN_OUTCOME'].includes(job.status)||
      now<job.dueAt+600000))
     throw Error('CLEANUP_REVIEW_NOT_READY');
   }
   for(const job of targets)job.status=d.action==='REVIEW_ONE'?'REVIEWED_UNKNOWN':'SKIPPED';
   s.phase4Community!.cleanupReviewDrafts=
    s.phase4Community!.cleanupReviewDrafts!.filter(x=>x.id!==id);
   s.audit.push({updateKey:'p4-cleanup-owner:'+d.id,actorId:actor,
    decision:'ALLOW',reason:'CLEANUP_'+d.action,
    policyVersion:access.configVersion,at:now});
   return {count:targets.length,chatId:d.chatId,action:d.action};
  });
 }
}
