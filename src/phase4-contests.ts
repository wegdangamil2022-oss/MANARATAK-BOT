import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {gameCatalogAllowsQuiz} from './phase4-game-catalog.js';
import {emptyContestState,type ContestState,type ContestRecord,
 validContestText,contestId,contestUser,contestGroup}
 from './phase4-contest-model.js';
import {emptyQuizState,type QuizInput,type QuizState,
 type Quiz,validQuizInput} from './phase4-quiz-model.js';

type VerifyMember=(group:string,member:string)=>Promise<
 'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
type SignupStatus='REGISTERED'|'ALREADY_REGISTERED'|'VERIFICATION_REQUIRED'|
 'NOT_FOUND'|'CLOSED'|'STALE'|'INVALID'|'CAPACITY';
type NextResult={status:'STARTED'|'NEXT'|'FINISHED'|'DENIED';quizId?:string};
const time=(x:number)=>Number.isSafeInteger(x)&&x>=0&&
 x<=8_640_000_000_000_000-100*86_400_000;
const contests=(s:BotState):ContestState=>s.phase4Contests??emptyContestState();
const quizzes=(s:BotState):QuizState=>s.phase4Quizzes??emptyQuizState();
const approved=(s:BotState,p:Policy,id:string)=>{
 const rows=s.chats.filter(x=>x.id===id),chat=rows[0];
 return rows.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&p.canUseChat(s,id,'navigation')?chat:null;
};
const subscriptions=(s:BotState,id:string)=>
 JSON.stringify(s.subscriptionRequirements.filter(x=>x.chatId===id));
const unique=(ids:readonly string[]):string=>{
 let id='';do{id=randomBytes(12).toString('hex');}while(ids.includes(id));
 return id;
};
const activeQuiz=(d:QuizState,chatId:string,now:number)=>
 d.quizzes.some(q=>q.chatId===chatId&&q.status==='OPEN'&&
 q.expiresAt!==undefined&&now<q.expiresAt);
const activeRegistration=(d:ContestState,group:string,id:string)=>
 d.contests.some(c=>c.chatId===group&&c.id!==id&&
  (c.status==='REGISTRATION'||c.status==='RUNNING'));
const makeRound=(s:BotState,c:ContestRecord,round:number,now:number):string=>{
 const d=quizzes(s);
 if(d.quizzes.length>=150||activeQuiz(d,c.chatId,now)||
  !gameCatalogAllowsQuiz(s,c.chatId,now,'OPEN'))
  throw Error('CONTEST_QUIZ_CAPACITY');
 const input=c.rounds[round]!;
 const id=unique(d.quizzes.map(x=>x.id));
 const q:Quiz={id,chatId:c.chatId,chatVersion:c.chatVersion,
  ownerId:c.ownerId,category:input.category,
  durationMinutes:input.durationMinutes,title:input.title,
  question:input.question,options:[...input.options] as QuizInput['options'],
  correctIndex:input.correctIndex,explanation:input.explanation,
  sourceUrl:input.sourceUrl,contestId:c.id,
  status:'OPEN',revision:2,createdAt:now,openedAt:now,
  expiresAt:now+input.durationMinutes*60_000};
 d.quizzes.push(q);s.phase4Quizzes=d;return id;
};
/** GAME-002 / 08:02: group-scoped, owner-reviewed contest and signups.
 * A contest is not a public broadcast: each round creates a local 08:03 quiz.
 * Participation requires Telegram membership and any mandatory subscriptions.
 */
export class Phase4ContestService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private owner(s:BotState,actor:string,id:string):number|null{
  const chat=approved(s,this.policy,id);
  return chat&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',id,this.clock())?chat.version:null;
 }
 async draft(actor:string,chatId:string,title:string,description:string):Promise<ContestRecord>{
  const now=this.clock();
  if(!time(now)||!contestGroup(chatId)||
   !validContestText(title,8,100)||!validContestText(description,16,300))
   throw Error('CONTEST_INVALID');
  return this.store.transaction(s=>{
   const version=this.owner(s,actor,chatId);
   if(version===null)throw Error('CONTEST_DENIED');
   const d=contests(s);
   if(d.contests.length>=120||d.contests.filter(c=>
    c.chatId===chatId&&c.status==='DRAFT').length>=10)
    throw Error('CONTEST_CAPACITY');
   const c:ContestRecord={id:unique(d.contests.map(x=>x.id)),
    chatId,chatVersion:version,ownerId:actor,title,description,
    status:'DRAFT',revision:1,createdAt:now,updatedAt:now,
    rounds:[],quizIds:[]};
   d.contests.push(c);s.phase4Contests=d;return structuredClone(c);
  });
 }
 async addRound(actor:string,id:string,expected:number,input:QuizInput):Promise<boolean>{
  const now=this.clock();
  if(!time(now)||!contestId(id)||!validQuizInput(input)||
   !Number.isSafeInteger(expected))return false;
  return this.store.transaction(s=>{
   const d=contests(s),c=d.contests.find(x=>x.id===id);
   if(!c||c.status!=='DRAFT'||c.revision!==expected||
    c.rounds.length>=5||c.ownerId!==actor||
    this.owner(s,actor,c.chatId)!==c.chatVersion||
    c.rounds.some(x=>x.question.toLowerCase()===input.question.toLowerCase()))
    return false;
   c.rounds.push(structuredClone(input));c.revision++;c.updatedAt=now;
   s.phase4Contests=d;return true;
  });
 }
 async openRegistration(actor:string,id:string,expected:number,minutes:number):Promise<boolean>{
  const now=this.clock();
  if(!time(now)||!contestId(id)||!Number.isSafeInteger(expected)||
   !Number.isSafeInteger(minutes)||minutes<10||minutes>240)return false;
  return this.store.transaction(s=>{
   const d=contests(s),c=d.contests.find(x=>x.id===id);
   if(!c||c.status!=='DRAFT'||c.revision!==expected||
    c.rounds.length<2||c.ownerId!==actor||
    this.owner(s,actor,c.chatId)!==c.chatVersion||
    activeRegistration(d,c.chatId,c.id))return false;
   c.status='REGISTRATION';c.registrationEndsAt=now+minutes*60_000;
   c.revision++;c.updatedAt=now;s.phase4Contests=d;return true;
  });
 }
 async join(memberId:string,id:string):Promise<{status:SignupStatus}>{
  const deny=(status:SignupStatus)=>({status});
  const now=this.clock();
  if(!time(now)||!contestUser(memberId)||!contestId(id))return deny('INVALID');
  const initial=await this.store.snapshot(),c=contests(initial).contests.find(x=>x.id===id);
  if(!c)return deny('NOT_FOUND');
  const group=approved(initial,this.policy,c.chatId);
  if(!group||group.version!==c.chatVersion)return deny('STALE');
  if(c.status!=='REGISTRATION'||now>=c.registrationEndsAt!)return deny('CLOSED');
  if(memberId===c.ownerId)return deny('INVALID');
  const policy=subscriptions(initial,c.chatId);
  let verified=false;
  try{verified=await this.verifyMember(c.chatId,memberId)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!verified)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const current=contests(s),live=current.contests.find(x=>x.id===id),
    chat=approved(s,this.policy,c.chatId),now2=this.clock();
   if(!time(now2)||!chat||chat.version!==c.chatVersion||
    subscriptions(s,c.chatId)!==policy)return deny('STALE');
   if(!live||live.status!=='REGISTRATION'||now2>=live.registrationEndsAt!||
    live.revision!==c.revision)return deny('CLOSED');
   if(current.members.some(x=>x.contestId===id&&x.memberId===memberId))
    return deny('ALREADY_REGISTERED');
   if(current.members.length>=5000||current.members.filter(x=>
    x.contestId===id).length>=250)return deny('CAPACITY');
   current.members.push({contestId:id,memberId,status:'ACTIVE',joinedAt:now2});
   s.phase4Contests=current;return deny('REGISTERED');
  });
 }
 async withdraw(memberId:string,id:string):Promise<boolean>{
  if(!contestId(id)||!contestUser(memberId)||!time(this.clock()))return false;
  return this.store.transaction(s=>{
   const d=contests(s),m=d.members.find(x=>x.contestId===id&&x.memberId===memberId);
   if(!m||m.status!=='ACTIVE')return false;
   const now=this.clock(),c=d.contests.find(x=>x.id===id);
   const linked=new Set(c?.quizIds??[]),qd=quizzes(s);
   let modified=false;
   qd.answers=qd.answers.filter(a=>{
    if(a.memberId!==memberId||!linked.has(a.quizId)||a.status!=='ACTIVE')
     return true;
    const quiz=qd.quizzes.find(q=>q.id===a.quizId);
    if(quiz?.closedAt!==undefined&&now>quiz.closedAt+7*86_400_000){
     modified=true;return false;
    }
    a.status='WITHDRAWN';delete a.choice;a.withdrawnAt=now;
    modified=true;return true;
   });
   if(modified)s.phase4Quizzes=qd;
   m.status='WITHDRAWN';m.withdrawnAt=now;
   s.phase4Contests=d;return true;
  });
 }
 async info(memberId:string,id:string):Promise<{
  id:string;title:string;description:string;rounds:number;status:string;
  registered:boolean;registrationEndsAt?:number;currentQuizId?:string
 }|null>{
  if(!contestUser(memberId)||!contestId(id))return null;
  const first=await this.store.snapshot(),c=contests(first).contests.find(x=>x.id===id);
  if(!c||c.status==='DRAFT')return null;
  const group=approved(first,this.policy,c.chatId);
  if(!group||group.version!==c.chatVersion)return null;
  const f=subscriptions(first,c.chatId);
  let verified=false;
  try{verified=await this.verifyMember(c.chatId,memberId)==='VERIFIED';}
  catch{return null;}
  if(!verified)return null;
  const s=await this.store.snapshot(),chat=approved(s,this.policy,c.chatId),
   current=contests(s),row=current.contests.find(x=>x.id===id);
  if(!chat||chat.version!==c.chatVersion||
   subscriptions(s,c.chatId)!==f||!row||row.status==='DRAFT')return null;
  const registered=current.members.some(x=>x.contestId===id&&
   x.memberId===memberId&&x.status==='ACTIVE');
  return {id,title:row.title,description:row.description,
   rounds:row.rounds.length,status:row.status,registered,
   ...(row.registrationEndsAt!==undefined?{registrationEndsAt:row.registrationEndsAt}:{}),
   ...(registered&&row.status==='RUNNING'&&row.quizIds.length?
    {currentQuizId:row.quizIds[row.quizIds.length-1]}:{})};
 }
 private async mutate(actor:string,id:string,revision:number,
  op:'START'|'NEXT'):Promise<NextResult>{
  const now=this.clock(),deny:NextResult={status:'DENIED'};
  if(!contestId(id)||!time(now)||!Number.isSafeInteger(revision))return deny;
  return this.store.transaction(s=>{
   const d=contests(s),c=d.contests.find(x=>x.id===id);
   if(!c||c.revision!==revision||c.ownerId!==actor||
    this.owner(s,actor,c.chatId)!==c.chatVersion)return deny;
   if(op==='START'){
    if(c.status!=='REGISTRATION'||now<c.registrationEndsAt!||
     now>=c.registrationEndsAt!+24*60*60_000||
     !d.members.some(x=>x.contestId===id&&x.status==='ACTIVE')||
     activeRegistration(d,c.chatId,c.id))return deny;
    let first='';
    try{first=makeRound(s,c,0,now);}catch{return deny;}
    c.status='RUNNING';c.startedAt=now;c.quizIds.push(first);
    c.revision++;c.updatedAt=now;s.phase4Contests=d;
    return {status:'STARTED',quizId:first};
   }
   if(c.status!=='RUNNING'||!c.quizIds.length)return deny;
   const qd=quizzes(s),last=qd.quizzes.find(x=>
    x.id===c.quizIds[c.quizIds.length-1]);
   if(!last||last.contestId!==c.id||last.chatVersion!==c.chatVersion)return deny;
   if(last.status==='OPEN'){
    if(last.expiresAt===undefined||now<last.expiresAt)return deny;
    last.status='CLOSED';last.revision=3;last.closedAt=now;
    s.phase4Quizzes=qd;
   }else if(last.status!=='CLOSED')return deny;
   if(c.quizIds.length===c.rounds.length){
    c.status='CLOSED';c.closedAt=now;c.revision++;c.updatedAt=now;
    s.phase4Contests=d;return {status:'FINISHED'};
   }
   let next='';
   try{next=makeRound(s,c,c.quizIds.length,now);}catch{return deny;}
   c.quizIds.push(next);c.revision++;c.updatedAt=now;
   s.phase4Contests=d;return {status:'NEXT',quizId:next};
  });
 }
 async start(actor:string,id:string,revision:number):Promise<NextResult>{
  return this.mutate(actor,id,revision,'START');
 }
 async advance(actor:string,id:string,revision:number):Promise<NextResult>{
  return this.mutate(actor,id,revision,'NEXT');
 }
 async cancel(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();
  if(!contestId(id)||!time(now)||!Number.isSafeInteger(revision))return false;
  return this.store.transaction(s=>{
   const d=contests(s),c=d.contests.find(x=>x.id===id);
   if(!c||!['DRAFT','REGISTRATION','RUNNING'].includes(c.status)||
    c.revision!==revision||c.ownerId!==actor||
    this.owner(s,actor,c.chatId)!==c.chatVersion)
    return false;
   const qd=quizzes(s),current=qd.quizzes.find(q=>
    q.id===c.quizIds[c.quizIds.length-1]);
   if(current?.status==='OPEN'){
    current.status='CLOSED';current.revision=3;current.closedAt=now;
    s.phase4Quizzes=qd;
   }
   c.status='CANCELLED';c.revision++;c.closedAt=now;c.updatedAt=now;
   s.phase4Contests=d;return true;
  });
 }
 async view(actor:string,id:string):Promise<ContestRecord|null>{
  if(!contestId(id))return null;
  const s=await this.store.snapshot(),c=contests(s).contests.find(x=>x.id===id);
  return c&&c.ownerId===actor&&
   this.owner(s,actor,c.chatId)===c.chatVersion?structuredClone(c):null;
 }
 async list(actor:string):Promise<ContestRecord[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||
   !this.policy.privateFeature(s,'owner.dashboard',actor))return [];
  return contests(s).contests.filter(c=>c.ownerId===actor&&
   this.owner(s,actor,c.chatId)===c.chatVersion)
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
   .slice(0,40).map(c=>structuredClone(c));
 }
 /** Privacy cleanup is local-only, independent of Telegram delivery and
  * moderation. Abandoned signup/active contests eventually expire.
  */
 async expire():Promise<number>{
  const now=this.clock();if(!time(now))return 0;
  return this.store.transaction(s=>{
   const d=contests(s),qd=quizzes(s);let modified=0;
   for(const c of d.contests){
    if(c.status==='REGISTRATION'&&c.registrationEndsAt!==undefined&&
     now>=c.registrationEndsAt+24*60*60_000){
     // After no owner start for a day, cancel inactive registration.
     c.status='CANCELLED';c.closedAt=now;c.updatedAt=now;c.revision++;
     // cancelled pre-start records have no startedAt.
     modified++;
    }
    if(c.status==='RUNNING'&&c.startedAt!==undefined&&
     now>=c.startedAt+7*86_400_000){
     const q=qd.quizzes.find(x=>x.id===c.quizIds[c.quizIds.length-1]);
     if(q?.status==='OPEN'){
      q.status='CLOSED';q.revision=3;q.closedAt=now;s.phase4Quizzes=qd;
     }
     c.status='CANCELLED';c.closedAt=now;c.updatedAt=now;c.revision++;
     modified++;
    }
   }
   const size=d.contests.length;
   d.contests=d.contests.filter(c=>
    c.status==='DRAFT'?now<c.createdAt+7*86_400_000:
    c.status==='CLOSED'||c.status==='CANCELLED'?
     c.closedAt!==undefined&&now<c.closedAt+7*86_400_000:true);
   modified+=size-d.contests.length;
   const retained=new Set(d.contests.map(c=>c.id));
   const total=d.members.length;
   d.members=d.members.filter(x=>retained.has(x.contestId));
   modified+=total-d.members.length;
   if(modified)s.phase4Contests=d;
   return modified;
  });
 }
}
