import {createHash,randomBytes} from 'node:crypto';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {guidanceContext,renderGuidanceRules,validGuidanceGroup} from './phase4-guidance.js';
import {emptyCommunityState,validCommunityRulesUrl,
 type CommunityFixedPostDraft,type CommunityFixedPostJob} from './phase4-community-model.js';

const ID=/^[a-f0-9]{24}$/u;
const MAX_BYTES=3400;
const REVIEW_MS=120000;
const SEND_MS=600000;
const HISTORY_MS=7*86400000;
const validNow=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-SEND_MS;
const hash=(text:string)=>createHash('sha256')
 .update('MANARATAK:09:03:PUBLIC-FIXED:v1:\n').update(text,'utf8').digest('hex');
/** No rule trigger, filtered word, moderation action or private student data
 * is ever included in the public 09:03 announcement. */
export const publicBody=(state:Parameters<typeof guidanceContext>[0],
 policy:Policy,chatId:string):{body:string;version:number}|null=>{
 const data=guidanceContext(state,policy,chatId);
 if(!data)return null;
 if(!validCommunityRulesUrl(data.config.rulesUrl)&&
    data.notes.length===0&&data.faqs.length===0)return null;
 const body=renderGuidanceRules(data);
 if(!body||Buffer.byteLength(body,'utf8')>MAX_BYTES)return null;
 return {body,version:data.config.version};
};
const liveGroup=(state:Parameters<typeof guidanceContext>[0],policy:Policy,
 actorId:string,chatId:string):number|null=>{
 const chats=state.chats.filter(c=>c.id===chatId&&c.approved&&c.present&&
  c.scopes.includes('navigation'));
 return chats.length===1&&Number.isSafeInteger(chats[0]!.version)&&
  chats[0]!.version>=1&&policy.canUseChat(state,chatId,'navigation')&&
  policy.has(state,actorId,'chat.manage',chatId)?chats[0]!.version:null;
};
const active=(job:CommunityFixedPostJob)=>['QUEUED','SENDING','UNKNOWN_OUTCOME']
 .includes(job.status);
const pendingPin=(job:CommunityFixedPostJob)=>['QUEUED','SENDING','UNKNOWN_OUTCOME']
 .includes(job.pinStatus);

export class Phase4FixedPublicationService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 async prepare(actor:string,chatId:string,pinRequested:boolean):Promise<
  {draft:CommunityFixedPostDraft;preview:string}>{
  if(!this.policy.isOwner(actor)||!validGuidanceGroup(chatId)||
    typeof pinRequested!=='boolean')throw Error('FIXED_OWNER_DENIED');
  return this.store.transaction(state=>{
   const now=this.clock();
   if(!validNow(now))throw Error('FIXED_CLOCK_INVALID');
   const version=liveGroup(state,this.policy,actor,chatId);
   const visible=publicBody(state,this.policy,chatId);
   if(version===null||!visible)throw Error('FIXED_SOURCE_NOT_APPROVED');
   const st=state.phase4Community??=emptyCommunityState();
   const existing=st.fixedPostJobs??[];
   if(existing.some(j=>j.chatId===chatId&&
     (active(j)||pendingPin(j))))throw Error('FIXED_PUBLISH_STILL_PENDING');
   if(existing.some(j=>j.chatId===chatId&&j.status==='CONFIRMED'&&
     now>=j.approvedAt&&now-j.approvedAt<SEND_MS))
    throw Error('FIXED_PUBLISH_RATE_LIMIT');
   const remaining=(st.fixedPostDrafts??[]).filter(d=>
     d.expiresAt>now&&d.createdAt<=now&&d.actorId!==actor);
   if(remaining.length>=50)throw Error('FIXED_DRAFT_CAPACITY');
   const draft:CommunityFixedPostDraft={
    id:randomBytes(12).toString('hex'),actorId:actor,chatId,
    chatVersion:version,configVersion:visible.version,
    contentDigest:hash(visible.body),createdAt:now,expiresAt:now+REVIEW_MS,
    pinRequested
   };
   st.fixedPostDrafts=[...remaining,draft];
   return {draft:structuredClone(draft),preview:visible.body};
  });
 }
 async confirm(actor:string,id:string):Promise<CommunityFixedPostJob>{
  if(!this.policy.isOwner(actor)||!ID.test(id))throw Error('FIXED_OWNER_DENIED');
  return this.store.transaction(state=>{
   const now=this.clock();
   if(!validNow(now))throw Error('FIXED_CLOCK_INVALID');
   const st=state.phase4Community;
   const matching=st?.fixedPostDrafts?.filter(d=>d.id===id)??[];
   if(matching.length!==1||matching[0]!.actorId!==actor)
    throw Error('FIXED_DRAFT_NOT_FOUND');
   const draft=matching[0]!;
   if(now<draft.createdAt||now>=draft.expiresAt)
    throw Error('FIXED_DRAFT_EXPIRED');
   const version=liveGroup(state,this.policy,actor,draft.chatId);
   const current=publicBody(state,this.policy,draft.chatId);
   if(version!==draft.chatVersion||!current||
     current.version!==draft.configVersion||
     hash(current.body)!==draft.contentDigest)
    throw Error('FIXED_PUBLIC_CONTENT_CHANGED');
   const jobs=st!.fixedPostJobs??[];
   if(jobs.some(j=>j.chatId===draft.chatId&&
     (active(j)||pendingPin(j))))throw Error('FIXED_PUBLISH_STILL_PENDING');
   if(jobs.some(j=>j.chatId===draft.chatId&&j.status==='CONFIRMED'&&
      now>=j.approvedAt&&now-j.approvedAt<SEND_MS))
    throw Error('FIXED_PUBLISH_RATE_LIMIT');
   const kept=jobs.filter(j=>active(j)||pendingPin(j)||
      now>=j.approvedAt&&now-j.approvedAt<HISTORY_MS);
   if(kept.length>=250)throw Error('FIXED_JOB_CAPACITY');
   const job:CommunityFixedPostJob={
    id:randomBytes(12).toString('hex'),actorId:actor,
    chatId:draft.chatId,chatVersion:draft.chatVersion,
    configVersion:draft.configVersion,contentDigest:draft.contentDigest,
    approvedAt:now,status:'QUEUED',pinRequested:draft.pinRequested,
    pinStatus:draft.pinRequested?'AWAITING_POST':'NOT_REQUESTED'
   };
   st!.fixedPostJobs=[...kept,job];
   st!.fixedPostDrafts=(st!.fixedPostDrafts??[]).filter(x=>x.id!==id);
   state.audit.push({updateKey:'p4-fixed-publish:'+draft.id,
    actorId:actor,decision:'ALLOW',reason:'FIXED_PUBLICATION_QUEUED',
    policyVersion:job.configVersion,at:now});
   return structuredClone(job);
  });
 }
 async cancelDraft(actor:string,id:string):Promise<boolean>{
  if(!this.policy.isOwner(actor)||!ID.test(id))return false;
  return this.store.transaction(s=>{
   const entries=s.phase4Community?.fixedPostDrafts??[];
   if(entries.filter(x=>x.id===id&&x.actorId===actor).length!==1)return false;
   s.phase4Community!.fixedPostDrafts=entries.filter(x=>x.id!==id);
   return true;
  });
 }
 async cancelQueued(actor:string,id:string):Promise<boolean>{
  if(!this.policy.isOwner(actor)||!ID.test(id))return false;
  return this.store.transaction(s=>{
   const matches=s.phase4Community?.fixedPostJobs?.filter(x=>x.id===id)??[];
   if(matches.length!==1||matches[0]!.actorId!==actor||
     matches[0]!.status!=='QUEUED'||liveGroup(s,this.policy,actor,
       matches[0]!.chatId)===null)return false;
   const job=matches[0]!;
   job.status='SKIPPED';
   if(job.pinRequested)job.pinStatus='SKIPPED';
   s.audit.push({updateKey:'p4-fixed-cancel:'+id,actorId:actor,
    decision:'ALLOW',reason:'FIXED_PUBLICATION_CANCELLED',
    policyVersion:job.configVersion,at:this.clock()});
   return true;
  });
 }
 async recent(actor:string,chatId:string):Promise<CommunityFixedPostJob|null>{
  if(!this.policy.isOwner(actor)||!validGuidanceGroup(chatId))return null;
  const snap=await this.store.snapshot();
  if(liveGroup(snap,this.policy,actor,chatId)===null)return null;
  const rows=(snap.phase4Community?.fixedPostJobs??[]).filter(j=>j.chatId===chatId);
  rows.sort((a,b)=>b.approvedAt-a.approvedAt||b.id.localeCompare(a.id));
  return rows.length?structuredClone(rows[0]!):null;
 }
 /** Explicitly records uncertainty, never infers that Telegram did not send.
  * Requires a second owner action and a conservative ten-minute window. */
 async reviewUnknown(actor:string,id:string,kind:'POST'|'PIN'):Promise<boolean>{
  if(!this.policy.isOwner(actor)||!ID.test(id))return false;
  return this.store.transaction(s=>{
   const rows=s.phase4Community?.fixedPostJobs?.filter(j=>j.id===id)??[];
   if(rows.length!==1||rows[0]!.actorId!==actor)return false;
   const job=rows[0]!,now=this.clock();
   if(!validNow(now)||now<job.approvedAt+SEND_MS||
      liveGroup(s,this.policy,actor,job.chatId)===null)return false;
   if(kind==='POST'&&['SENDING','UNKNOWN_OUTCOME'].includes(job.status)){
    job.status='REVIEWED_UNKNOWN';
    if(job.pinRequested)job.pinStatus='SKIPPED';
   }else if(kind==='PIN'&&job.status==='CONFIRMED'&&
     ['SENDING','UNKNOWN_OUTCOME'].includes(job.pinStatus)){
    job.pinStatus='REVIEWED_UNKNOWN';
   }else return false;
   s.audit.push({updateKey:'p4-fixed-review:'+kind+':'+id,
    actorId:actor,decision:'ALLOW',reason:'FIXED_'+kind+'_OUTCOME_REVIEWED_UNCERTAIN',
    policyVersion:job.configVersion,at:now});
   return true;
  });
 }
}
