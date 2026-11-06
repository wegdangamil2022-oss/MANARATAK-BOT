import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyExpertState,type ExpertProfile,type ExpertSession,type ExpertSummary,
 expertName,expertSpecialty,expertHex} from './phase4-expert-model.js';
import {validEventURL,validEventSummaryInput} from './phase4-event-model.js';

type VerifyMember=(groupId:string,userId:string)=>Promise<
 'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
const time=(x:number)=>Number.isSafeInteger(x)&&x>=0&&
 x<=8_640_000_000_000_000-60*86_400_000;
const user=(x:string)=>/^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const groupId=(x:string)=>/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const state=(s:BotState)=>s.phase4Experts??emptyExpertState();
const id=(rows:readonly {id:string}[]):string=>{
 let x:string;do{x=randomBytes(12).toString('hex');}
 while(rows.some(p=>p.id===x));return x;
};
const group=(s:BotState,policy:Policy,chatId:string)=>{
 const matches=s.chats.filter(c=>c.id===chatId),chat=matches[0];
 return matches.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&policy.canUseChat(s,chatId,'navigation')?chat:null;
};
const requirement=(s:BotState,chatId:string)=>JSON.stringify(
 s.subscriptionRequirements.filter(x=>x.chatId===chatId));
/** Scrubs the underlying 09:07 inbox AT THE SAME database commit as
 * closing the AMA. Does not publish approved text or deliver a reply.
 */
function closeLinkedDiscussion(s:BotState,id:string,now:number,chatId:string,
 chatVersion:number,actor:string):boolean{
 const rows=s.phase4Discussions?.sessions.filter(q=>q.id===id)??[],q=rows[0];
 if(rows.length!==1||!q||q.chatId!==chatId||
  q.chatVersion!==chatVersion||q.ownerId!==actor)return false;
 if(q.status==='CLOSED')return true;
 if(q.status!=='OPEN'||q.revision!==2)return false;
 q.status='CLOSED';q.revision=3;q.closedAt=now;
 for(const question of s.phase4Discussions?.questions.filter(x=>x.sessionId===id)??[]){
  if(question.text===undefined)continue;
  delete question.text;delete question.faqId;
  question.status='ARCHIVED';question.revision++;
  question.reviewedAt=Math.max(now,question.createdAt);
 }
 return true;
}
export interface AmaStats{
 pending:number;approved:number;deferred:number;answered:number;total:number;
}
/** A manually reviewed profile means ONLY that the owner reviewed an
 * evidence URL. It does not certify the person, credentials or employer.
 * No delegated expert Telegram account can access private questions.
 */
export class Phase4ExpertService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private scope(s:BotState,actor:string,chatId:string):number|null{
  const c=group(s,this.policy,chatId);
  return c&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?c.version:null;
 }
 async draftProfile(actor:string,chatId:string,raw:{
  displayName:string;specialty:string;evidenceUrl:string
 }):Promise<ExpertProfile>{
  const now=this.clock();
  if(!time(now)||!groupId(chatId)||!raw||
   !expertName(raw.displayName)||!expertSpecialty(raw.specialty)||
   !validEventURL(raw.evidenceUrl))throw Error('EXPERT_INVALID');
  return this.store.transaction(s=>{
   const version=this.scope(s,actor,chatId);
   if(version===null)throw Error('EXPERT_DENIED');
   const d=state(s);if(d.profiles.length>=100)throw Error('EXPERT_CAPACITY');
   const row:ExpertProfile={id:id(d.profiles),chatId,chatVersion:version,
    ownerId:actor,displayName:raw.displayName,specialty:raw.specialty,
    evidenceUrl:raw.evidenceUrl,status:'DRAFT',revision:1,createdAt:now};
   d.profiles.push(row);s.phase4Experts=d;return structuredClone(row);
  });
 }
 async reviewProfile(actor:string,profileId:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now)||!expertHex(profileId))return false;
  return this.store.transaction(s=>{
   const d=state(s),profiles=d.profiles.filter(p=>p.id===profileId),p=profiles[0];
   if(profiles.length!==1||!p||p.status!=='DRAFT'||revision!==1||
    p.revision!==revision||p.ownerId!==actor||
    this.scope(s,actor,p.chatId)!==p.chatVersion||now<p.createdAt)return false;
   p.status='REVIEWED';p.revision=2;p.reviewedAt=now;
   s.phase4Experts=d;return true;
  });
 }
 async draftSession(actor:string,profileId:string,questionSessionId:string):
 Promise<ExpertSession>{
  const now=this.clock();
  if(!time(now)||!expertHex(profileId)||!expertHex(questionSessionId))
   throw Error('EXPERT_SESSION_DENIED');
  return this.store.transaction(s=>{
   const d=state(s),profiles=d.profiles.filter(p=>p.id===profileId),p=profiles[0];
   const discussions=s.phase4Discussions?.sessions.filter(q=>q.id===questionSessionId)??[],q=discussions[0];
   if(profiles.length!==1||!p||p.ownerId!==actor||
    this.scope(s,actor,p.chatId)!==p.chatVersion)
    throw Error('EXPERT_SESSION_DENIED');
   if(p.status!=='REVIEWED')throw Error('EXPERT_UNREVIEWED');
   if(discussions.length!==1||!q||q.status!=='OPEN'||q.revision!==2||
    q.ownerId!==actor||q.chatId!==p.chatId||q.chatVersion!==p.chatVersion||
    now>=q.expiresAt||d.sessions.some(x=>x.questionSessionId===questionSessionId)||
    d.sessions.length>=100)throw Error('EXPERT_SESSION_DENIED');
   const row:ExpertSession={id:id(d.sessions),chatId:p.chatId,chatVersion:p.chatVersion,
    ownerId:actor,profileId,questionSessionId,status:'DRAFT',revision:1,
    createdAt:now,expiresAt:q.expiresAt};
   d.sessions.push(row);s.phase4Experts=d;return structuredClone(row);
  });
 }
 async openSession(actor:string,sessionId:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),found=d.sessions.filter(x=>x.id===sessionId),row=found[0];
   const profiles=d.profiles.filter(x=>x.id===row?.profileId),profile=profiles[0];
   const qs=s.phase4Discussions?.sessions.filter(x=>x.id===row?.questionSessionId)??[],q=qs[0];
   if(found.length!==1||!row||row.status!=='DRAFT'||row.revision!==revision||
    revision!==1||row.ownerId!==actor||
    this.scope(s,actor,row.chatId)!==row.chatVersion||now>=row.expiresAt||
    profiles.length!==1||!profile||profile.status!=='REVIEWED'||
    qs.length!==1||!q||q.status!=='OPEN'||q.revision!==2||
    q.chatId!==row.chatId||q.chatVersion!==row.chatVersion||
    q.expiresAt!==row.expiresAt)return false;
   row.status='OPEN';row.revision=2;row.openedAt=now;
   s.phase4Experts=d;return true;
  });
 }
 /** Deferred is an OWNER-ONLY queue marker, never a public assertion that
  * an expert has personally reviewed or answered the question. */
 async deferQuestion(actor:string,sessionId:string,questionId:string):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),sessions=d.sessions.filter(x=>x.id===sessionId),session=sessions[0];
   const questions=s.phase4Discussions?.questions.filter(x=>x.id===questionId)??[],q=questions[0];
   if(sessions.length!==1||!session||session.status!=='OPEN'||session.ownerId!==actor||
    this.scope(s,actor,session.chatId)!==session.chatVersion||
    now>=session.expiresAt||questions.length!==1||!q||
    q.sessionId!==session.questionSessionId||q.status!=='APPROVED'||
    d.decisions.some(x=>x.sessionId===sessionId&&x.questionId===questionId)||
    d.decisions.length>=2000)return false;
   d.decisions.push({id:id(d.decisions),sessionId,questionId,
    status:'DEFERRED',revision:1,createdAt:now});
   s.phase4Experts=d;return true;
  });
 }
 async ownerStats(actor:string,sessionId:string):Promise<AmaStats|null>{
  const s=await this.store.snapshot(),d=state(s),
   found=d.sessions.filter(x=>x.id===sessionId),session=found[0];
  if(found.length!==1||!session||session.ownerId!==actor||
   this.scope(s,actor,session.chatId)!==session.chatVersion)return null;
  const questions=s.phase4Discussions?.questions.filter(
   x=>x.sessionId===session.questionSessionId)??[];
  const deferred=new Set(d.decisions.filter(x=>x.sessionId===sessionId).map(x=>x.questionId));
  return {
   pending:questions.filter(x=>x.status==='PENDING').length,
   approved:questions.filter(x=>x.status==='APPROVED'&&!deferred.has(x.id)).length,
   deferred:questions.filter(x=>x.status==='APPROVED'&&deferred.has(x.id)).length,
   answered:questions.filter(x=>x.status==='ANSWERED').length,total:questions.length
  };
 }
 /** One transaction fences both AMA and original question inbox. */
 async closeSession(actor:string,sessionId:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.sessions.filter(x=>x.id===sessionId),ama=rows[0];
   if(rows.length!==1||!ama||ama.status!=='OPEN'||ama.revision!==revision||
    ama.ownerId!==actor||this.scope(s,actor,ama.chatId)!==ama.chatVersion||
    now<ama.createdAt||!closeLinkedDiscussion(s,ama.questionSessionId,now,
     ama.chatId,ama.chatVersion,actor))return false;
   ama.status='CLOSED';ama.revision=3;ama.closedAt=now;
   s.phase4Experts=d;return true;
  });
 }
 async draftSummary(actor:string,sessionId:string,text:string,urls:string[]):Promise<ExpertSummary>{
  const now=this.clock();
  if(!time(now)||!validEventSummaryInput(text,urls))throw Error('EXPERT_SUMMARY_INVALID');
  return this.store.transaction(s=>{
   const d=state(s),rows=d.sessions.filter(x=>x.id===sessionId),ama=rows[0];
   if(rows.length!==1||!ama||ama.status!=='CLOSED'||ama.ownerId!==actor||
    this.scope(s,actor,ama.chatId)!==ama.chatVersion||
    now<ama.closedAt!||d.summaries.some(x=>x.sessionId===sessionId))
    throw Error('EXPERT_SUMMARY_DENIED');
   const summary:ExpertSummary={sessionId,text,urls:[...urls],
    status:'DRAFT',revision:1,createdAt:now};
   d.summaries.push(summary);s.phase4Experts=d;return structuredClone(summary);
  });
 }
 async approveSummary(actor:string,sessionId:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.sessions.filter(x=>x.id===sessionId),ama=rows[0];
   const reviews=d.summaries.filter(x=>x.sessionId===sessionId),summary=reviews[0];
   if(rows.length!==1||!ama||ama.status!=='CLOSED'||ama.ownerId!==actor||
    this.scope(s,actor,ama.chatId)!==ama.chatVersion||
    reviews.length!==1||!summary||summary.status!=='DRAFT'||
    summary.revision!==revision||revision!==1||now<summary.createdAt)return false;
   summary.status='APPROVED';summary.revision=2;summary.approvedAt=now;
   s.phase4Experts=d;return true;
  });
 }
 /** Recheck Telegram membership and required-channel configuration after
  * the external verifier returns. No public expert titles are certified.
  */
 async memberSummary(actor:string,sessionId:string):Promise<{text:string;urls:string[]}|null>{
  if(!user(actor))return null;
  const s=await this.store.snapshot(),d=state(s);
  const sessions=d.sessions.filter(x=>x.id===sessionId),ama=sessions[0];
  const reviews=d.summaries.filter(x=>x.sessionId===sessionId),summary=reviews[0];
  if(sessions.length!==1||!ama||ama.status!=='CLOSED'||
   reviews.length!==1||!summary||summary.status!=='APPROVED'||
   group(s,this.policy,ama.chatId)?.version!==ama.chatVersion)return null;
  const fence=requirement(s,ama.chatId);
  try{if(await this.verifyMember(ama.chatId,actor)!=='VERIFIED')return null;}
  catch{return null;}
  const fresh=await this.store.snapshot(),fd=state(fresh),
   actual=fd.sessions.filter(x=>x.id===sessionId),current=actual[0],
   summaries=fd.summaries.filter(x=>x.sessionId===sessionId),published=summaries[0];
  if(actual.length!==1||!current||current.status!=='CLOSED'||
   current.chatVersion!==ama.chatVersion||summaries.length!==1||
   !published||published.status!=='APPROVED'||
   published.revision!==summary.revision||
   group(fresh,this.policy,current.chatId)?.version!==current.chatVersion||
   requirement(fresh,current.chatId)!==fence)return null;
  return {text:published.text,urls:[...published.urls]};
 }
 async ownerView(actor:string,sessionId:string):Promise<{
  session:ExpertSession;profile:ExpertProfile;summary:ExpertSummary|null
 }|null>{
  const s=await this.store.snapshot(),d=state(s),rows=d.sessions.filter(x=>x.id===sessionId),ama=rows[0];
  if(rows.length!==1||!ama||ama.ownerId!==actor||
   this.scope(s,actor,ama.chatId)!==ama.chatVersion)return null;
  const profiles=d.profiles.filter(x=>x.id===ama.profileId),profile=profiles[0];
  if(profiles.length!==1||!profile)return null;
  const summaries=d.summaries.filter(x=>x.sessionId===ama.id);
  return {session:structuredClone(ama),profile:structuredClone(profile),
   summary:summaries.length===1?structuredClone(summaries[0]!):null};
 }
 async ownerProfile(actor:string,profileId:string):Promise<ExpertProfile|null>{
  const s=await this.store.snapshot(),rows=state(s).profiles.filter(x=>x.id===profileId),p=rows[0];
  if(rows.length!==1||!p||p.ownerId!==actor||
   this.scope(s,actor,p.chatId)!==p.chatVersion)return null;
  return structuredClone(p);
 }
 async list(actor:string):Promise<{profiles:ExpertProfile[];sessions:ExpertSession[]}>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor))
   throw Error('EXPERT_DENIED');
  const d=state(s);
  return {
   profiles:d.profiles.filter(p=>p.ownerId===actor&&
    this.scope(s,actor,p.chatId)===p.chatVersion)
    .slice(-25).reverse().map(x=>structuredClone(x)),
   sessions:d.sessions.filter(q=>q.ownerId===actor&&
    this.scope(s,actor,q.chatId)===q.chatVersion)
    .slice(-25).reverse().map(x=>structuredClone(x))
  };
 }
 /** Independent single-flight privacy sweep: close expired sessions and
  * scrub private 09:07 question text, prune reference IDs after 24h.
  */
 async expire():Promise<number>{
  const now=this.clock();if(!time(now))return 0;
  return this.store.transaction(s=>{
   const d=state(s);let closed=0;
   for(const ama of d.sessions){
    if(ama.status!=='OPEN'||now<ama.expiresAt)continue;
    if(!closeLinkedDiscussion(s,ama.questionSessionId,now,
     ama.chatId,ama.chatVersion,ama.ownerId))continue;
    ama.status='CLOSED';ama.revision=3;ama.closedAt=now;closed++;
   }
   const before=d.decisions.length;
   d.decisions=d.decisions.filter(x=>{
    const ama=d.sessions.find(q=>q.id===x.sessionId);
    return Boolean(ama&&ama.status!=='CLOSED'||
     ama?.closedAt!==undefined&&now-ama.closedAt<=86_400_000);
   });
   const past=d.sessions.length;
   d.sessions=d.sessions.filter(x=>x.closedAt===undefined||
    now-x.closedAt<=30*86_400_000);
   const ids=new Set(d.sessions.map(x=>x.id));
   const summaries=d.summaries.length;
   d.summaries=d.summaries.filter(x=>ids.has(x.sessionId));
   const profiles=d.profiles.length;
   const activeProfiles=new Set(d.sessions.map(x=>x.profileId));
   d.profiles=d.profiles.filter(p=>activeProfiles.has(p.id)||
    now-p.createdAt<=30*86_400_000);
   if(closed||before!==d.decisions.length||past!==d.sessions.length||
    summaries!==d.summaries.length||profiles!==d.profiles.length)
    s.phase4Experts=d;
   return closed;
  });
 }
}
