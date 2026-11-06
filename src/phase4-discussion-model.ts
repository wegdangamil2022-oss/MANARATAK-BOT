/** Phase 4 / 09:07 — PRIVATE, human-moderated study discussions.
 * No question or student identity may be published from this state by default.
 * The owner decides which questions are approved; APPROVED is not a Telegram
 * delivery or permission to send anything to a group.
 */
export interface DiscussionSession{
 id:string;chatId:string;chatVersion:number;ownerId:string;title:string;
 topicId?:number;maxQuestions:number;revision:number;
 status:'DRAFT'|'OPEN'|'CLOSED';createdAt:number;expiresAt:number;
 openedAt?:number;closedAt?:number;
}
export type DiscussionQuestionStatus='PENDING'|'APPROVED'|'REJECTED'|
 'WITHDRAWN'|'ANSWERED'|'ARCHIVED';
export interface DiscussionQuestion{
 id:string;sessionId:string;memberId:string;status:DiscussionQuestionStatus;
 text?:string;createdAt:number;revision:number;reviewedAt?:number;
}
export interface DiscussionState{
 sessions:DiscussionSession[];questions:DiscussionQuestion[];
}
export const emptyDiscussionState=():DiscussionState=>({sessions:[],questions:[]});
const record=(x:unknown):x is Record<string,unknown>=>
 x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]) =>
 required.every(k=>Object.hasOwn(x,k))&&
 Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
const validId=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{24}$/u.test(x);
export const validDiscussionUser=(x:unknown):x is string=>
 typeof x==='string'&&/^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
export const validDiscussionGroup=(x:unknown):x is string=>
 typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const safeTime=(n:unknown):n is number=>typeof n==='number'&&
 Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000-86_400_000;
const version=(n:unknown):n is number=>typeof n==='number'&&
 Number.isSafeInteger(n)&&n>=1&&n<=9_999_999_999;
const noControls=(s:string)=>!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(s);
export const validDiscussionTitle=(x:unknown):x is string=>
 typeof x==='string'&&x.trim()===x&&x.length>=4&&x.length<=100&&noControls(x);
export const validDiscussionQuestionText=(x:unknown):x is string=>
 typeof x==='string'&&x.trim()===x&&x.length>=4&&x.length<=400&&noControls(x)&&
 // Direct contact details, links and usernames need a separate reviewed
 // workflow, not an unmoderated study-question inbox.
 !/(?:https?:\/\/|www\.|t\.me\/|@[A-Za-z0-9_]{4,})/iu.test(x);
export function validDiscussionSession(value:unknown):value is DiscussionSession{
 if(!record(value)||!exact(value,['id','chatId','chatVersion','ownerId',
  'title','maxQuestions','revision','status','createdAt','expiresAt'],
  ['topicId','openedAt','closedAt']))return false;
 const x=value;
 if(!validId(x.id)||!validDiscussionGroup(x.chatId)||
  !version(x.chatVersion)||!validDiscussionUser(x.ownerId)||
  !validDiscussionTitle(x.title)||
  !Number.isSafeInteger(x.maxQuestions)||Number(x.maxQuestions)<1||
  Number(x.maxQuestions)>100||!version(x.revision)||
  !safeTime(x.createdAt)||!safeTime(x.expiresAt)||
  Number(x.expiresAt)-Number(x.createdAt)<900_000||
  Number(x.expiresAt)-Number(x.createdAt)>86_400_000||
  (x.topicId!==undefined&&(!Number.isSafeInteger(x.topicId)||
    Number(x.topicId)<1||Number(x.topicId)>2_147_483_647)))return false;
 if(x.status==='DRAFT')return x.revision===1&&
  x.openedAt===undefined&&x.closedAt===undefined;
 if(x.status==='OPEN')return x.revision===2&&safeTime(x.openedAt)&&
  Number(x.openedAt)>=Number(x.createdAt)&&
  Number(x.openedAt)<Number(x.expiresAt)&&x.closedAt===undefined;
 if(x.status!=='CLOSED'||!safeTime(x.closedAt)||
  Number(x.closedAt)<Number(x.createdAt))return false;
 if(x.openedAt===undefined)return x.revision===2;
 return x.revision===3&&safeTime(x.openedAt)&&
  Number(x.openedAt)>=Number(x.createdAt)&&
  Number(x.openedAt)<Number(x.expiresAt)&&
  Number(x.closedAt)>=Number(x.openedAt);
}
export function validDiscussionQuestion(value:unknown):value is DiscussionQuestion{
 if(!record(value)||!exact(value,['id','sessionId','memberId','status',
  'createdAt','revision'],['text','reviewedAt']))return false;
 const x=value;
 if(!validId(x.id)||!validId(x.sessionId)||!validDiscussionUser(x.memberId)||
  !safeTime(x.createdAt)||!version(x.revision))return false;
 if(x.status==='PENDING')return x.revision===1&&
  validDiscussionQuestionText(x.text)&&x.reviewedAt===undefined;
 if(!safeTime(x.reviewedAt)||Number(x.reviewedAt)<Number(x.createdAt))return false;
 if(x.status==='APPROVED')return x.revision===2&&validDiscussionQuestionText(x.text);
 if(x.status==='ANSWERED')return x.revision===3&&validDiscussionQuestionText(x.text);
 if(x.status==='REJECTED'||x.status==='WITHDRAWN')
  return x.revision>=2&&x.revision<=4&&x.text===undefined;
 if(x.status==='ARCHIVED')return x.revision>=2&&x.revision<=4&&x.text===undefined;
 return false;
}
/** Validate restored JSON and SQLite state as an indivisible snapshot. */
export function validDiscussionState(value:unknown):value is DiscussionState{
 if(!record(value)||!exact(value,['sessions','questions'])||
  !Array.isArray(value.sessions)||value.sessions.length>100||
  !Array.isArray(value.questions)||value.questions.length>2000||
  value.sessions.some(s=>!validDiscussionSession(s))||
  value.questions.some(q=>!validDiscussionQuestion(q)))return false;
 const sessions=value.sessions as DiscussionSession[],questions=value.questions as DiscussionQuestion[];
 if(new Set(sessions.map(s=>s.id)).size!==sessions.length||
  new Set(questions.map(q=>q.id)).size!==questions.length||
  new Set(questions.map(q=>q.sessionId+':'+q.memberId)).size!==questions.length)return false;
 const byId=new Map(sessions.map(s=>[s.id,s]));
 const counts=new Map<string,number>();
 for(const q of questions){
  const s=byId.get(q.sessionId);
  if(!s||s.openedAt===undefined||q.createdAt<s.openedAt||
   q.createdAt>s.expiresAt||s.status==='DRAFT'||s.status==='CLOSED'&&q.text!==undefined)
   return false;
  const used=(counts.get(q.sessionId)??0)+1;
  if(used>s.maxQuestions)return false;
  counts.set(q.sessionId,used);
 }
 return true;
}
