import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyQuizState,type QuizState,type Quiz,type QuizInput,
 validQuizInput,quizUser,quizGroup,quizId} from './phase4-quiz-model.js';

type VerifyMember=(chatId:string,userId:string)=>Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
export type QuizAnswerStatus='RECORDED'|'ALREADY_ANSWERED'|'VERIFICATION_REQUIRED'|
 'NOT_FOUND'|'CLOSED'|'EXPIRED'|'STALE'|'INVALID'|'CAPACITY';
export interface QuizInfo{
 id:string;title:string;question:string;category:string;
 options:string[];status:'OPEN'|'CLOSED';expiresAt:number;
 sourceUrl:string;answer?:{correctIndex:number;explanation:string};
}
export interface QuizAggregate{total:number;correct:number;counts:number[];}
const state=(s:BotState):QuizState=>s.phase4Quizzes??emptyQuizState();
const time=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-100*86_400_000;
const approved=(s:BotState,p:Policy,chatId:string)=>{
 const rows=s.chats.filter(c=>c.id===chatId),chat=rows[0];
 return rows.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&p.canUseChat(s,chatId,'navigation')?chat:null;
};
const fingerprint=(s:BotState,id:string)=>
 JSON.stringify(s.subscriptionRequirements.filter(x=>x.chatId===id));
const newId=(rows:readonly Quiz[]):string=>{
 let id:string;do{id=randomBytes(12).toString('hex');}
 while(rows.some(x=>x.id===id));return id;
};
/** GAME-002 / 08:03 — private, opt-in, owner-reviewed educational questions.
 * Does not publish group messages, give scholarship priority, alter moderators,
 * assign rewards or use Telegram native polls. Unknown membership fails closed.
 */
export class Phase4QuizService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private owner(s:BotState,actor:string,chatId:string):number|null{
  const chat=approved(s,this.policy,chatId);
  return chat&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?chat.version:null;
 }
 async draft(actor:string,chatId:string,input:QuizInput):Promise<Quiz>{
  const now=this.clock();
  if(!time(now)||!quizGroup(chatId)||!validQuizInput(input))
   throw Error('QUIZ_INVALID');
  return this.store.transaction(s=>{
   const version=this.owner(s,actor,chatId);
   if(version===null)throw Error('QUIZ_DENIED');
   const d=state(s);
   if(d.quizzes.length>=150||d.quizzes.filter(x=>
    x.chatId===chatId&&x.status!=='CLOSED').length>=20)
    throw Error('QUIZ_CAPACITY');
   const row:Quiz={id:newId(d.quizzes),chatId,chatVersion:version,
    ownerId:actor,category:input.category,durationMinutes:input.durationMinutes,
    title:input.title,question:input.question,
    options:[...input.options] as QuizInput['options'],
    correctIndex:input.correctIndex,explanation:input.explanation,
    sourceUrl:input.sourceUrl,status:'DRAFT',revision:1,createdAt:now};
   d.quizzes.push(row);s.phase4Quizzes=d;return structuredClone(row);
  });
 }
 async open(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();
  if(!quizId(id)||revision!==1||!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.quizzes.filter(q=>q.id===id),row=rows[0];
   if(rows.length!==1||!row||row.status!=='DRAFT'||row.revision!==1||
    row.ownerId!==actor||now<row.createdAt||
    now>=row.createdAt+15*60_000||
    this.owner(s,actor,row.chatId)!==row.chatVersion||
    d.quizzes.some(q=>q.id!==row.id&&q.chatId===row.chatId&&
     q.status==='OPEN'&&q.expiresAt!==undefined&&now<q.expiresAt))
    return false;
   row.status='OPEN';row.revision=2;row.openedAt=now;
   row.expiresAt=now+row.durationMinutes*60_000;
   s.phase4Quizzes=d;return true;
  });
 }
 async close(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();
  if(!time(now)||!quizId(id)||revision!==2)return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.quizzes.filter(q=>q.id===id),row=rows[0];
   if(rows.length!==1||!row||row.status!=='OPEN'||row.revision!==2||
    row.ownerId!==actor||now<row.openedAt!||
    this.owner(s,actor,row.chatId)!==row.chatVersion)return false;
   row.status='CLOSED';row.revision=3;row.closedAt=now;
   s.phase4Quizzes=d;return true;
  });
 }
 /** Answers are atomic, one per Telegram account and quiz.
  * The verified member gate runs before writing; approval epoch and mandatory
  * subscriptions are revalidated AFTER the async Telegram check returns.
  */
 async answer(memberId:string,id:string,choice:number):Promise<{status:QuizAnswerStatus}>{
  const deny=(status:QuizAnswerStatus)=>({status});
  const start=this.clock();
  if(!quizUser(memberId)||!quizId(id)||!Number.isSafeInteger(choice)||
   choice<0||choice>3||!time(start))return deny('INVALID');
  const initial=await this.store.snapshot(),rows=state(initial).quizzes.filter(x=>x.id===id);
  const q=rows[0];
  if(rows.length!==1||!q)return deny('NOT_FOUND');
  const g=approved(initial,this.policy,q.chatId);
  if(!g||g.version!==q.chatVersion)return deny('STALE');
  if(q.status==='CLOSED')return deny('CLOSED');
  if(q.status!=='OPEN')return deny('CLOSED');
  if(start>=q.expiresAt!)return deny('EXPIRED');
  if(start<q.openedAt!||memberId===q.ownerId)return deny('INVALID');
  const f=fingerprint(initial,q.chatId);
  let member=false;
  try{member=await this.verifyMember(q.chatId,memberId)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!member)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const now=this.clock(),d=state(s),rows=d.quizzes.filter(x=>x.id===id),fresh=rows[0];
   const group=approved(s,this.policy,q.chatId);
   if(!time(now)||!group||group.version!==q.chatVersion||
    fingerprint(s,q.chatId)!==f)return deny('STALE');
   if(rows.length!==1||!fresh||fresh.status!=='OPEN'||
    fresh.revision!==2||fresh.chatVersion!==q.chatVersion)
    return deny('STALE');
   if(now>=fresh.expiresAt!)return deny('EXPIRED');
   if(now<fresh.openedAt!)return deny('STALE');
   if(d.answers.some(x=>x.quizId===id&&x.memberId===memberId))
    return deny('ALREADY_ANSWERED');
   if(d.answers.length>=5000)return deny('CAPACITY');
   d.answers.push({quizId:id,memberId,status:'ACTIVE',
    submittedAt:now,choice});
   s.phase4Quizzes=d;return deny('RECORDED');
  });
 }
 /** Privacy withdrawal redacts the choice immediately; a minimal member id
  * tombstone remains only until quiz retention ends, preventing vote farming.
  * Withdrawal does not depend on continued group membership.
  */
 async withdraw(memberId:string,id:string):Promise<boolean>{
  if(!quizUser(memberId)||!quizId(id)||!time(this.clock()))return false;
  return this.store.transaction(s=>{
   const d=state(s),row=d.answers.find(x=>x.quizId===id&&x.memberId===memberId);
   if(!row||row.status!=='ACTIVE')return false;
   row.status='WITHDRAWN';delete row.choice;row.withdrawnAt=this.clock();
   s.phase4Quizzes=d;return true;
  });
 }
 private async memberQuiz(memberId:string,id:string):Promise<Quiz|null>{
  if(!quizUser(memberId)||!quizId(id))return null;
  const initial=await this.store.snapshot(),rows=state(initial).quizzes.filter(x=>x.id===id),
   quiz=rows[0];
  if(rows.length!==1||!quiz||quiz.status==='DRAFT')return null;
  const g=approved(initial,this.policy,quiz.chatId);
  if(!g||g.version!==quiz.chatVersion)return null;
  const f=fingerprint(initial,quiz.chatId);
  let verified=false;
  try{verified=await this.verifyMember(quiz.chatId,memberId)==='VERIFIED';}
  catch{return null;}
  if(!verified)return null;
  const fresh=await this.store.snapshot(),g2=approved(fresh,this.policy,quiz.chatId);
  const q=state(fresh).quizzes.filter(x=>x.id===id)[0];
  return g2&&g2.version===quiz.chatVersion&&
   fingerprint(fresh,quiz.chatId)===f&&q&&q.status!=='DRAFT'&&
   q.chatVersion===quiz.chatVersion?structuredClone(q):null;
 }
 async info(memberId:string,id:string):Promise<QuizInfo|null>{
  const q=await this.memberQuiz(memberId,id);if(!q)return null;
  return {id:q.id,title:q.title,question:q.question,category:q.category,
   options:[...q.options],status:q.status as 'OPEN'|'CLOSED',
   expiresAt:q.expiresAt!,sourceUrl:q.sourceUrl,
   ...(q.status==='CLOSED'?{answer:{correctIndex:q.correctIndex,
    explanation:q.explanation}}:{})};
 }
 async mine(memberId:string,id:string):Promise<'ANSWERED'|'WITHDRAWN'|'NONE'|null>{
  if(!await this.memberQuiz(memberId,id))return null;
  const s=await this.store.snapshot();
  const row=state(s).answers.find(x=>x.quizId===id&&x.memberId===memberId);
  return row?.status==='ACTIVE'?'ANSWERED':
   row?.status==='WITHDRAWN'?'WITHDRAWN':'NONE';
 }
 async view(actor:string,id:string):Promise<Quiz|null>{
  const s=await this.store.snapshot(),rows=state(s).quizzes.filter(q=>q.id===id),
   q=rows[0];
  return rows.length===1&&q&&q.ownerId===actor&&
   this.owner(s,actor,q.chatId)===q.chatVersion?structuredClone(q):null;
 }
 async list(actor:string):Promise<Quiz[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||
   !this.policy.privateFeature(s,'owner.dashboard',actor))
   throw Error('QUIZ_DENIED');
  return state(s).quizzes.filter(q=>q.ownerId===actor&&
   this.owner(s,actor,q.chatId)===q.chatVersion)
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
   .slice(0,40).map(q=>structuredClone(q));
 }
 /** Suppress aggregates for fewer than five opt-in accounts. Never expose
  * voter identities, raw choices or a count of individual incorrect answers.
  */
 async results(actor:string,id:string):Promise<QuizAggregate|null>{
  const s=await this.store.snapshot(),rows=state(s).quizzes.filter(q=>q.id===id),
   q=rows[0];
  if(rows.length!==1||!q||q.status!=='CLOSED'||q.ownerId!==actor||
   this.owner(s,actor,q.chatId)!==q.chatVersion)return null;
  const votes=state(s).answers.filter(a=>a.quizId===id&&a.status==='ACTIVE');
  if(votes.length<5)return null;
  const counts=q.options.map((_,i)=>votes.filter(v=>v.choice===i).length);
  return {total:votes.length,correct:counts[q.correctIndex]!,counts};
 }
 /** No background Telegram operations. Run from safe local scheduler or
  * service entrypoints. Removes retained member IDs and source copy after 7d.
  */
 async expire():Promise<number>{
  const now=this.clock();if(!time(now))return 0;
  return this.store.transaction(s=>{
   const d=state(s);let changed=0;
   for(const q of d.quizzes){
    if(q.status==='OPEN'&&q.expiresAt!==undefined&&now>=q.expiresAt){
     q.status='CLOSED';q.revision=3;q.closedAt=now;changed++;
    }
   }
   const old=d.quizzes.length;
   d.quizzes=d.quizzes.filter(q=>
    q.status==='DRAFT'?now<q.createdAt+15*60_000:
    q.status==='CLOSED'?q.closedAt!==undefined&&
     now<q.closedAt+7*86_400_000:true);
   changed+=old-d.quizzes.length;
   const retained=new Set(d.quizzes.map(q=>q.id)),before=d.answers.length;
   d.answers=d.answers.filter(a=>retained.has(a.quizId));
   changed+=before-d.answers.length;
   if(changed)s.phase4Quizzes=d;
   return changed;
  });
 }
}
