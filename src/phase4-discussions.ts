import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {visibleEducationCategory} from './education-category-policy.js';
import {emptyDiscussionState,type DiscussionState,type DiscussionSession,
 type DiscussionQuestionStatus,validDiscussionGroup,validDiscussionUser,
 validDiscussionTitle,validDiscussionQuestionText} from './phase4-discussion-model.js';

type VerifyMember=(chatId:string,memberId:string)=>Promise<
 'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
export type DiscussionDraftInput={
 title:string;durationMinutes:number;maxQuestions:number;topicId?:number;
};
export type DiscussionAskStatus='RECEIVED'|'NOT_FOUND'|'CLOSED'|'EXPIRED'|
 'STALE'|'FULL'|'ALREADY_SUBMITTED'|'VERIFICATION_REQUIRED'|'INVALID';
export type DiscussionAskResult={status:DiscussionAskStatus;questionId?:string};
export type DiscussionQuestionView={
 id:string;status:DiscussionQuestionStatus;text?:string;
 createdAt:number;revision:number;reviewedAt?:number;
};
const validClock=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-86_400_000;
const state=(s:BotState):DiscussionState=>
 s.phase4Discussions??emptyDiscussionState();
const group=(s:BotState,p:Policy,id:string)=>{
 const matches=s.chats.filter(c=>c.id===id),c=matches[0];
 return matches.length===1&&c?.approved&&c.version>=1&&
  c.scopes.includes('navigation')&&p.canUseChat(s,id,'navigation')?c:null;
};
const uniqueId=(rows:readonly {id:string}[])=>{
 let id:string;
 do{id=randomBytes(12).toString('hex');}
 while(rows.some(x=>x.id===id));
 return id;
};
const scrubSession=(s:DiscussionState,session:DiscussionSession,now:number):void=>{
 session.status='CLOSED';session.closedAt=now;session.revision++;
 for(const q of s.questions.filter(x=>x.sessionId===session.id)){
  if(q.text===undefined)continue;
  delete q.text;delete q.faqId;q.status='ARCHIVED';q.revision++;q.reviewedAt=Math.max(now,q.createdAt);
 }
};
/** No Telegram posting, answers or member identity exposure.
 * The only private content viewers are owner-authorized review screens.
 * Student replies contain an opaque question ID and a generic status.
 */
export class Phase4DiscussionService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private owner(s:BotState,actor:string):boolean{
  return this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private scope(s:BotState,actor:string,chatId:string):number|null{
  const c=group(s,this.policy,chatId);
  return validDiscussionGroup(chatId)&&c&&this.owner(s,actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?c.version:null;
 }
 async draft(actor:string,chatId:string,input:DiscussionDraftInput):Promise<DiscussionSession>{
  const now=this.clock();
  if(!validClock(now)||!validDiscussionGroup(chatId)||!input||
   !validDiscussionTitle(input.title)||
   !Number.isSafeInteger(input.maxQuestions)||input.maxQuestions<1||input.maxQuestions>100||
   !Number.isSafeInteger(input.durationMinutes)||input.durationMinutes<15||
   input.durationMinutes>1440||
   (input.topicId!==undefined&&(!Number.isSafeInteger(input.topicId)||
    input.topicId<1||input.topicId>2_147_483_647)))
   throw Error('DISCUSS_INPUT_INVALID');
  return this.store.transaction(s=>{
   const chatVersion=this.scope(s,actor,chatId);
   if(chatVersion===null)throw Error('DISCUSS_DENIED');
   const data=state(s);
   if(data.sessions.length>=100)throw Error('DISCUSS_CAPACITY');
   const row:DiscussionSession={
    id:uniqueId(data.sessions),chatId,chatVersion,ownerId:actor,title:input.title,
    ...(input.topicId!==undefined?{topicId:input.topicId}:{}),
    maxQuestions:input.maxQuestions,revision:1,status:'DRAFT',
    createdAt:now,expiresAt:now+input.durationMinutes*60_000
   };
   data.sessions.push(row);s.phase4Discussions=data;
   return structuredClone(row);
  });
 }
 /** A draft becomes OPEN locally; this never creates a group announcement. */
 async open(actor:string,id:string,expectedRevision:number):Promise<boolean>{
  const now=this.clock();if(!validClock(now))return false;
  return this.store.transaction(s=>{
   const data=state(s),matches=data.sessions.filter(x=>x.id===id),row=matches[0];
   if(matches.length!==1||!row||row.status!=='DRAFT'||
    row.revision!==expectedRevision||expectedRevision!==1||
    row.ownerId!==actor||this.scope(s,actor,row.chatId)!==row.chatVersion||
    now<row.createdAt||now>=row.expiresAt)return false;
   row.status='OPEN';row.revision=2;row.openedAt=now;
   s.phase4Discussions=data;return true;
  });
 }
 /** Closing scrubs all unpublished question text. No Telegram side effect. */
 async close(actor:string,id:string,expectedRevision:number):Promise<boolean>{
  const now=this.clock();if(!validClock(now))return false;
  return this.store.transaction(s=>{
   const data=state(s),matches=data.sessions.filter(x=>x.id===id),row=matches[0];
   if(matches.length!==1||!row||row.status==='CLOSED'||
    row.revision!==expectedRevision||row.ownerId!==actor||
    this.scope(s,actor,row.chatId)!==row.chatVersion||now<row.createdAt)
    return false;
   scrubSession(data,row,now);s.phase4Discussions=data;return true;
  });
 }
 /** Ingress must authenticate the sender and require a *private* request.
  * Verified Telegram membership is mandatory before the atomic transaction.
  * Failed/unknown membership cannot consume a question slot. */
 async ask(actor:string,id:string,text:string):Promise<DiscussionAskResult>{
  const deny=(status:DiscussionAskStatus):DiscussionAskResult=>({status});
  const now=this.clock();
  if(!validClock(now)||!validDiscussionUser(actor)||
   !validDiscussionQuestionText(text))return deny('INVALID');
  const before=await this.store.snapshot(),data=state(before);
  const matches=data.sessions.filter(x=>x.id===id),row=matches[0];
  if(matches.length!==1||!row)return deny('NOT_FOUND');
  if(row.status!=='OPEN')return deny('CLOSED');
  if(now<row.createdAt||now>=row.expiresAt)return deny('EXPIRED');
  const approved=group(before,this.policy,row.chatId);
  if(!approved||approved.version!==row.chatVersion)return deny('STALE');
  if(row.ownerId===actor)return deny('INVALID');
  if(data.questions.some(x=>x.sessionId===id&&x.memberId===actor))
   return deny('ALREADY_SUBMITTED');
  if(data.questions.filter(x=>x.sessionId===id).length>=row.maxQuestions)
   return deny('FULL');
  let verified=false;
  try{verified=await this.verifyMember(row.chatId,actor)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!verified)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const d=state(s),list=d.sessions.filter(x=>x.id===id),fresh=list[0];
   if(list.length!==1||!fresh)return deny('NOT_FOUND');
   if(fresh.status!=='OPEN')return deny('CLOSED');
   const commitTime=this.clock();
   if(!validClock(commitTime)||commitTime<now)return deny('STALE');
   if(commitTime>=fresh.expiresAt)return deny('EXPIRED');
   const c=group(s,this.policy,fresh.chatId);
   if(!c||c.version!==fresh.chatVersion||
    fresh.chatVersion!==row.chatVersion||
    fresh.revision!==row.revision||fresh.expiresAt!==row.expiresAt)
    return deny('STALE');
   if(fresh.ownerId===actor)return deny('INVALID');
   if(d.questions.some(x=>x.sessionId===id&&x.memberId===actor))
    return deny('ALREADY_SUBMITTED');
   if(d.questions.filter(x=>x.sessionId===id).length>=fresh.maxQuestions||
    d.questions.length>=2000)return deny('FULL');
   const q={id:uniqueId(d.questions),sessionId:id,memberId:actor,
    status:'PENDING' as const,text,createdAt:commitTime,revision:1};
   d.questions.push(q);s.phase4Discussions=d;
   return {status:'RECEIVED',questionId:q.id};
  });
 }
 /** Self-service withdrawal works even after leaving/revocation/offline Telegram. */
 async withdraw(actor:string,questionId:string):Promise<boolean>{
  const now=this.clock();if(!validClock(now)||!validDiscussionUser(actor))return false;
  return this.store.transaction(s=>{
   const d=state(s),matches=d.questions.filter(x=>x.id===questionId),q=matches[0];
   if(matches.length!==1||!q||q.memberId!==actor||
    q.text===undefined||now<q.createdAt)return false;
   delete q.text;delete q.faqId;q.status='WITHDRAWN';q.revision++;q.reviewedAt=now;
   s.phase4Discussions=d;return true;
  });
 }
 async myQuestion(actor:string,id:string):Promise<{status:DiscussionQuestionStatus}|null>{
  if(!validDiscussionUser(actor))return null;
  const d=state(await this.store.snapshot());
  const found=d.questions.filter(x=>x.id===id&&x.memberId===actor);
  return found.length===1?{status:found[0]!.status}:null;
 }
 /** Moderation uses revision-fenced owner review in the private chat only.
  * Approving or marking answered does NOT create a Telegram reply or an FAQ. */
 async moderate(actor:string,id:string,
  decision:'APPROVED'|'REJECTED'|'ANSWERED',revision:number):Promise<boolean>{
  const now=this.clock();if(!validClock(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),qs=d.questions.filter(x=>x.id===id),q=qs[0];
   if(qs.length!==1||!q||q.revision!==revision||
    !(q.status==='PENDING'&&decision!=='ANSWERED'||
      q.status==='APPROVED'&&decision==='ANSWERED')||
    now<q.createdAt)return false;
   const sessions=d.sessions.filter(x=>x.id===q.sessionId),session=sessions[0];
   if(sessions.length!==1||!session||session.status!=='OPEN'||
    session.ownerId!==actor||
    this.scope(s,actor,session.chatId)!==session.chatVersion||
    now>=session.expiresAt)return false;
   q.status=decision;q.revision++;q.reviewedAt=now;
   if(decision==='REJECTED')delete q.text;
   s.phase4Discussions=d;return true;
  });
 }
 /** Bind a human-reviewed, currently approved group FAQ after explicit
  * question approval. No content or delivery job is created. */
 async answerFromFAQ(actor:string,id:string,revision:number,faqId:string):Promise<boolean>{
  const now=this.clock();if(!validClock(now)||!Number.isSafeInteger(revision)||
   !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(faqId))return false;
  return this.store.transaction(s=>{
   const d=state(s),found=d.questions.filter(q=>q.id===id),q=found[0];
   if(found.length!==1||!q||q.status!=='APPROVED'||q.revision!==revision||
    now<q.createdAt)return false;
   const sessions=d.sessions.filter(x=>x.id===q.sessionId),session=sessions[0];
   if(sessions.length!==1||!session||session.status!=='OPEN'||session.ownerId!==actor||
    this.scope(s,actor,session.chatId)!==session.chatVersion||
    now>=session.expiresAt)return false;
   const faq=s.faqEntries.filter(x=>x.id===faqId),entry=faq[0];
   if(faq.length!==1||!entry||entry.scope!==session.chatId||entry.status!=='APPROVED'||
    !entry.approvedBy||!this.approvedFAQ(s,entry.scope,entry.sourceResourceId))
    return false;
   q.status='ANSWERED';q.revision++;q.reviewedAt=now;q.faqId=entry.id;
   s.phase4Discussions=d;return true;
  });
 }
 /** Repeat publication/source checks on EVERY private answer retrieval.
  * A stale, archived or revoked FAQ is never served from a cached record. */
 private approvedFAQ(s:BotState,scope:string,sourceId:string):boolean{
  const resources=s.educationResources.filter(x=>x.id===sourceId),resource=resources[0];
  if(resources.length!==1||!resource||resource.scope!==scope||resource.status!=='PUBLISHED')
   return false;
  const categories=s.educationCategories.filter(x=>x.id===resource.categoryId),category=categories[0];
  return categories.length===1&&Boolean(category&&category.scope===scope&&
   visibleEducationCategory(s,category));
 }
 async myApprovedAnswer(actor:string,id:string):Promise<{answer:string;sourceId:string}|null>{
  const now=this.clock();if(!validClock(now)||!validDiscussionUser(actor))return null;
  const s=await this.store.snapshot(),d=state(s);
  const found=d.questions.filter(x=>x.id===id&&x.memberId===actor),q=found[0];
  if(found.length!==1||!q||q.status!=='ANSWERED'||!q.faqId)return null;
  const sessions=d.sessions.filter(x=>x.id===q.sessionId),session=sessions[0];
  if(sessions.length!==1||!session||session.status!=='OPEN'||
   now>=session.expiresAt||!group(s,this.policy,session.chatId)||
   group(s,this.policy,session.chatId)!.version!==session.chatVersion)return null;
  const entries=s.faqEntries.filter(x=>x.id===q.faqId),faq=entries[0];
  if(entries.length!==1||!faq||faq.scope!==session.chatId||
   faq.status!=='APPROVED'||!faq.approvedBy||
   !this.approvedFAQ(s,faq.scope,faq.sourceResourceId))return null;
  return {answer:faq.answer,sourceId:faq.sourceResourceId};
 }
 async list(actor:string,chatId?:string):Promise<DiscussionSession[]>{
  const s=await this.store.snapshot();
  if(!this.owner(s,actor))throw Error('DISCUSS_DENIED');
  return state(s).sessions.filter(x=>(chatId===undefined||x.chatId===chatId)&&
   x.ownerId===actor&&this.scope(s,actor,x.chatId)===x.chatVersion)
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
   .slice(0,50).map(x=>structuredClone(x));
 }
 async ownerView(actor:string,id:string):Promise<DiscussionSession|null>{
  const s=await this.store.snapshot(),items=state(s).sessions.filter(x=>x.id===id),row=items[0];
  if(items.length!==1||!row||row.ownerId!==actor||
   this.scope(s,actor,row.chatId)!==row.chatVersion)return null;
  return structuredClone(row);
 }
 /** One redacted owner-private question lookup for callback review. */
 async ownerQuestion(actor:string,id:string):Promise<(DiscussionQuestionView&{sessionId:string})|null>{
  const s=await this.store.snapshot(),d=state(s),rows=d.questions.filter(x=>x.id===id);
  const q=rows[0];
  if(rows.length!==1||!q)return null;
  const sessions=d.sessions.filter(x=>x.id===q.sessionId),session=sessions[0];
  if(sessions.length!==1||!session||session.ownerId!==actor||
   this.scope(s,actor,session.chatId)!==session.chatVersion)return null;
  return {id:q.id,sessionId:q.sessionId,status:q.status,
   ...(q.text!==undefined?{text:q.text}:{}),createdAt:q.createdAt,
   revision:q.revision,...(q.reviewedAt!==undefined?{reviewedAt:q.reviewedAt}:{})};
 }
 /** Deliberately omit student identifiers even from the private owner screen. */
 async ownerQuestions(actor:string,sessionId:string):Promise<DiscussionQuestionView[]|null>{
  const s=await this.store.snapshot(),d=state(s);
  const sessions=d.sessions.filter(x=>x.id===sessionId),row=sessions[0];
  if(sessions.length!==1||!row||row.ownerId!==actor||
   this.scope(s,actor,row.chatId)!==row.chatVersion)return null;
  return d.questions.filter(x=>x.sessionId===sessionId)
   .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))
   .slice(0,100).map(x=>({
    id:x.id,status:x.status,...(x.text!==undefined?{text:x.text}:{}),
    createdAt:x.createdAt,revision:x.revision,
    ...(x.reviewedAt!==undefined?{reviewedAt:x.reviewedAt}:{})
   }));
 }
 /** Independent privacy retention: scrub at expiry, prune tombstones after
  * 24 hours. Active storage only; never promise to erase backups/screenshots. */
 async expire():Promise<number>{
  const now=this.clock();if(!validClock(now))return 0;
  return this.store.transaction(s=>{
   const d=state(s);let closed=0;
   for(const row of d.sessions){
    if(row.status==='CLOSED'||now<row.expiresAt)continue;
    scrubSession(d,row,now);closed++;
   }
   const old=d.sessions.length;
   d.sessions=d.sessions.filter(row=>row.status!=='CLOSED'||
    row.closedAt===undefined||now-row.closedAt<=86_400_000);
   const retained=new Set(d.sessions.map(x=>x.id));
   const beforeQuestions=d.questions.length;
   d.questions=d.questions.filter(q=>retained.has(q.sessionId));
   if(closed||old!==d.sessions.length||beforeQuestions!==d.questions.length)
    s.phase4Discussions=d;
   return closed;
  });
 }
}
