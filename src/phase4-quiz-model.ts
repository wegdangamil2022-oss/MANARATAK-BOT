/** Phase 4 / 08:03 GAME-002 — owner-reviewed private educational quizzes.
 * Results are local and non-monetary, not Telegram-native polls or scholarship
 * eligibility. A verified Telegram account is not evidence of a unique human.
 */
export type QuizCategory='SCHOLARSHIPS'|'LANGUAGES'|'UNIVERSITIES'|'GENERAL';
export type QuizStatus='DRAFT'|'OPEN'|'CLOSED';
export interface QuizInput{
 category:QuizCategory;durationMinutes:number;title:string;question:string;
 options:[string,string,string,string];correctIndex:number;
 explanation:string;sourceUrl:string;
}
export interface Quiz{
 id:string;chatId:string;chatVersion:number;ownerId:string;
 category:QuizCategory;durationMinutes:number;title:string;question:string;
 options:[string,string,string,string];correctIndex:number;
 explanation:string;sourceUrl:string;
 /** Optional 08:02 contest registration gate; absent for standalone quizzes. */
 contestId?:string;
 status:QuizStatus;revision:1|2|3;createdAt:number;
 openedAt?:number;expiresAt?:number;closedAt?:number;
}
export interface QuizAnswer{
 quizId:string;memberId:string;status:'ACTIVE'|'WITHDRAWN';
 submittedAt:number;choice?:number;withdrawnAt?:number;
}
export interface QuizState{quizzes:Quiz[];answers:QuizAnswer[];}
export const emptyQuizState=():QuizState=>({quizzes:[],answers:[]});
const object=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]) =>
 required.every(k=>Object.hasOwn(v,k))&&
 Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
export const quizId=(v:unknown):v is string=>
 typeof v==='string'&&/^[a-f0-9]{24}$/u.test(v);
export const quizUser=(v:unknown):v is string=>
 typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
export const quizGroup=(v:unknown):v is string=>
 typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
const time=(v:unknown):v is number=>
 typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&
 v<=8_640_000_000_000_000-100*86_400_000;
const rev=(v:unknown):v is number=>
 typeof v==='number'&&Number.isSafeInteger(v)&&v>=1&&v<1_000_000_000;
const control=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const contact=/(?:https?:\/\/|www\.|t\.me\/|@[A-Za-z0-9_]{4,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d[\d\s+()-]{7,}\d)/iu;
const text=(v:unknown,min:number,max:number):v is string=>
 typeof v==='string'&&v.length>=min&&v.length<=max&&
 v.trim()===v&&!control.test(v)&&!contact.test(v);
const source=(v:unknown):v is string=>{
 if(typeof v!=='string'||v.length>250||!v.startsWith('https://')||
  /\s|[\u0000-\u001f]/u.test(v))return false;
 try{
  const u=new URL(v);
  return u.protocol==='https:'&&u.hostname.includes('.')&&
   !u.username&&!u.password&&!u.hash&&u.port===''&&
   !/^\d+\.\d+\.\d+\.\d+$/u.test(u.hostname);
 }catch{return false;}
};
const categories:readonly QuizCategory[]=['SCHOLARSHIPS','LANGUAGES','UNIVERSITIES','GENERAL'];
export function validQuizInput(v:unknown):v is QuizInput{
 if(!object(v)||!exact(v,['category','durationMinutes','title','question',
  'options','correctIndex','explanation','sourceUrl'])||
  !categories.includes(v.category as QuizCategory)||
  !Number.isSafeInteger(v.durationMinutes)||Number(v.durationMinutes)<10||
  Number(v.durationMinutes)>240||
  !text(v.title,8,100)||!text(v.question,12,400)||
  !Array.isArray(v.options)||v.options.length!==4||
  v.options.some(x=>!text(x,2,120))||
  new Set((v.options as string[]).map(x=>x.toLocaleLowerCase('en-US'))).size!==4||
  !Number.isSafeInteger(v.correctIndex)||Number(v.correctIndex)<0||
  Number(v.correctIndex)>3||!text(v.explanation,15,300)||
  !source(v.sourceUrl))return false;
 return true;
}
function validQuiz(v:unknown):v is Quiz{
 if(!object(v)||!exact(v,['id','chatId','chatVersion','ownerId',
  'category','durationMinutes','title','question','options',
  'correctIndex','explanation','sourceUrl','status','revision','createdAt'],
  ['openedAt','expiresAt','closedAt','contestId'])||
  !quizId(v.id)||!quizGroup(v.chatId)||
  (v.contestId!==undefined&&!quizId(v.contestId))||!rev(v.chatVersion)||
  !quizUser(v.ownerId)||!time(v.createdAt)||!validQuizInput({
   category:v.category,durationMinutes:v.durationMinutes,title:v.title,
   question:v.question,options:v.options,correctIndex:v.correctIndex,
   explanation:v.explanation,sourceUrl:v.sourceUrl
  }))return false;
 if(v.status==='DRAFT')return v.revision===1&&v.openedAt===undefined&&
  v.expiresAt===undefined&&v.closedAt===undefined;
 if(v.status==='OPEN'||v.status==='CLOSED'){
  if(!time(v.openedAt)||!time(v.expiresAt)||
   Number(v.openedAt)<v.createdAt||
   Number(v.expiresAt)!==Number(v.openedAt)+Number(v.durationMinutes)*60_000)
   return false;
  if(v.status==='OPEN')return v.revision===2&&v.closedAt===undefined;
  return v.revision===3&&time(v.closedAt)&&
   Number(v.closedAt)>=Number(v.openedAt);
 }
 return false;
}
function validAnswer(v:unknown):v is QuizAnswer{
 if(!object(v)||!exact(v,['quizId','memberId','status','submittedAt'],
  ['choice','withdrawnAt'])||!quizId(v.quizId)||!quizUser(v.memberId)||
  !time(v.submittedAt))return false;
 if(v.status==='ACTIVE')return Number.isSafeInteger(v.choice)&&
  Number(v.choice)>=0&&Number(v.choice)<=3&&v.withdrawnAt===undefined;
 return v.status==='WITHDRAWN'&&v.choice===undefined&&
  time(v.withdrawnAt)&&Number(v.withdrawnAt)>=v.submittedAt;
}
export function validQuizState(v:unknown):v is QuizState{
 if(!object(v)||!exact(v,['quizzes','answers'])||
  !Array.isArray(v.quizzes)||!Array.isArray(v.answers)||
  v.quizzes.length>150||v.answers.length>5000||
  v.quizzes.some(x=>!validQuiz(x))||v.answers.some(x=>!validAnswer(x)))
  return false;
 const quizzes=v.quizzes as Quiz[],answers=v.answers as QuizAnswer[];
 if(new Set(quizzes.map(x=>x.id)).size!==quizzes.length||
  new Set(answers.map(x=>x.quizId+':'+x.memberId)).size!==answers.length)
  return false;
 const lookup=new Map(quizzes.map(x=>[x.id,x]));
 for(const row of answers){
  const q=lookup.get(row.quizId);
  if(!q||q.status==='DRAFT'||row.memberId===q.ownerId||
   q.openedAt===undefined||q.expiresAt===undefined||
   row.submittedAt<q.openedAt||row.submittedAt>=q.expiresAt||
   q.closedAt!==undefined&&row.submittedAt>q.closedAt||
   row.withdrawnAt!==undefined&&q.closedAt!==undefined&&
    row.withdrawnAt>q.closedAt+7*86_400_000)
   return false;
 }
 return true;
}
