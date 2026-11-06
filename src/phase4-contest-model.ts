import {validQuizInput,quizId,type QuizInput}
 from './phase4-quiz-model.js';
/** Phase 4 / 08:02 — private, owner-reviewed multi-round educational contests.
 * No monetary awards, lottery, ranking, group broadcasts, or Telegram games.
 * Account signups are opt-in and temporary (not evidence of human uniqueness).
 */
export type ContestStatus='DRAFT'|'REGISTRATION'|'RUNNING'|'CLOSED'|'CANCELLED';
export interface ContestRecord{
 id:string;chatId:string;chatVersion:number;ownerId:string;
 title:string;description:string;status:ContestStatus;revision:number;
 createdAt:number;updatedAt:number;rounds:QuizInput[];quizIds:string[];
 registrationEndsAt?:number;startedAt?:number;closedAt?:number;
}
export interface ContestMember{
 contestId:string;memberId:string;status:'ACTIVE'|'WITHDRAWN';
 joinedAt:number;withdrawnAt?:number;
}
export interface ContestState{contests:ContestRecord[];members:ContestMember[];}
export const emptyContestState=():ContestState=>({contests:[],members:[]});
export const contestId=quizId;
export const contestUser=(v:unknown):v is string=>
 typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
export const contestGroup=(v:unknown):v is string=>
 typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
const object=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,req:readonly string[],optional:readonly string[]=[]) =>
 req.every(x=>Object.hasOwn(v,x))&&
 Object.keys(v).every(x=>req.includes(x)||optional.includes(x));
const integer=(v:unknown,min:number,max:number):v is number=>
 typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=(v:unknown)=>integer(v,0,8_640_000_000_000_000-100*86_400_000);
const badText=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const privacy=/(?:https?:\/\/|www\.|t\.me\/|@[a-z0-9_]{3,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d[\d\s+()-]{7,}\d)/iu;
export const validContestText=(v:unknown,min:number,max:number):v is string=>
 typeof v==='string'&&v.trim()===v&&v.length>=min&&
 v.length<=max&&!badText.test(v)&&!privacy.test(v);
export function validContestRecord(v:unknown):v is ContestRecord{
 if(!object(v)||!exact(v,['id','chatId','chatVersion','ownerId','title',
  'description','status','revision','createdAt','updatedAt','rounds','quizIds'],
  ['registrationEndsAt','startedAt','closedAt'])||
  !contestId(v.id)||!contestGroup(v.chatId)||
  !integer(v.chatVersion,1,999999999)||!contestUser(v.ownerId)||
  !validContestText(v.title,8,100)||
  !validContestText(v.description,16,300)||
  !integer(v.revision,1,999999999)||!stamp(v.createdAt)||
  !stamp(v.updatedAt)||Number(v.updatedAt)<Number(v.createdAt)||
  !Array.isArray(v.rounds)||v.rounds.length>5||
  v.rounds.some(r=>!validQuizInput(r))||
  !Array.isArray(v.quizIds)||v.quizIds.length>5||
  v.quizIds.some(id=>!contestId(id))||
  new Set(v.quizIds).size!==v.quizIds.length)return false;
 if(v.status==='DRAFT')return v.quizIds.length===0&&
  v.registrationEndsAt===undefined&&v.startedAt===undefined&&v.closedAt===undefined;
 if(!stamp(v.registrationEndsAt)||
  Number(v.registrationEndsAt)<Number(v.createdAt)||v.rounds.length<2)return false;
 if(v.status==='REGISTRATION')
  return v.quizIds.length===0&&v.startedAt===undefined&&v.closedAt===undefined;
 if(v.status==='CANCELLED'&&v.startedAt===undefined)
  return v.quizIds.length===0&&stamp(v.closedAt)&&
   Number(v.closedAt)>=Number(v.createdAt);
 if(!stamp(v.startedAt)||Number(v.startedAt)<Number(v.registrationEndsAt)||
  v.quizIds.length<1||v.quizIds.length>v.rounds.length)return false;
 if(v.status==='RUNNING')return v.closedAt===undefined;
 if(v.status==='CLOSED')return v.quizIds.length===v.rounds.length&&
  stamp(v.closedAt)&&Number(v.closedAt)>=Number(v.startedAt);
 if(v.status==='CANCELLED')return stamp(v.closedAt)&&
  Number(v.closedAt)>=Number(v.startedAt);
 return false;
}
function validMember(v:unknown):v is ContestMember{
 if(!object(v)||!exact(v,['contestId','memberId','status','joinedAt'],
  ['withdrawnAt'])||!contestId(v.contestId)||!contestUser(v.memberId)||
  !stamp(v.joinedAt))return false;
 if(v.status==='ACTIVE')return v.withdrawnAt===undefined;
 return v.status==='WITHDRAWN'&&stamp(v.withdrawnAt)&&
  Number(v.withdrawnAt)>=v.joinedAt;
}
export function validContestState(v:unknown):v is ContestState{
 if(!object(v)||!exact(v,['contests','members'])||
  !Array.isArray(v.contests)||!Array.isArray(v.members)||
  v.contests.length>120||v.members.length>5000||
  v.contests.some(x=>!validContestRecord(x))||
  v.members.some(x=>!validMember(x)))return false;
 const contests=v.contests as ContestRecord[],members=v.members as ContestMember[];
 if(new Set(contests.map(x=>x.id)).size!==contests.length||
  new Set(members.map(x=>x.contestId+':'+x.memberId)).size!==members.length||
  new Set(contests.flatMap(x=>x.quizIds)).size!==
   contests.reduce((n,x)=>n+x.quizIds.length,0))return false;
 const byId=new Map(contests.map(x=>[x.id,x]));
 return members.every(m=>{
  const c=byId.get(m.contestId);
  return !!c&&c.ownerId!==m.memberId&&
   c.status!=='DRAFT'&&m.joinedAt>=c.createdAt&&
   c.registrationEndsAt!==undefined&&m.joinedAt<c.registrationEndsAt&&
   (c.closedAt===undefined||m.joinedAt<=c.closedAt);
 });
}
/** Used by existing GAME-002 quiz engine when a question belongs to a
 * registered contest. No opponent's identity or answer is ever returned.
 */
export function contestMemberAllowed(s:{phase4Contests?:ContestState},
 contest:string,quiz:string,member:string):boolean{
 const d=s.phase4Contests;
 if(!d||!contestId(contest)||!contestId(quiz)||!contestUser(member))return false;
 const rows=d.contests.filter(c=>c.id===contest),c=rows[0];
 return rows.length===1&&!!c&&
  (c.status==='RUNNING'||c.status==='CLOSED')&&
  c.quizIds.includes(quiz)&&
  d.members.some(x=>x.contestId===contest&&x.memberId===member&&
   x.status==='ACTIVE');
}
export function contestMemberRevision(s:{phase4Contests?:ContestState},
 id:string,memberId:string):string{
 const d=s.phase4Contests,c=d?.contests.find(x=>x.id===id),
  m=d?.members.find(x=>x.contestId===id&&x.memberId===memberId);
 return c&&m?c.revision+':'+c.status+':'+m.status+':'+c.chatVersion:'ABSENT';
}
