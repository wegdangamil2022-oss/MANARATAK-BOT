/** Phase 4 / 09:08 — PRIVATE community polls, never competition votes.
 * This schema holds no Telegram send intent, chat publication or prize.
 */
export type PollKind='NEEDS'|'INTERESTS'|'SESSION_FEEDBACK';
export interface Phase4Poll{
 id:string;chatId:string;chatVersion:number;ownerId:string;
 kind:PollKind;question:string;options:string[];
 status:'DRAFT'|'OPEN'|'CLOSED';revision:number;
 createdAt:number;expiresAt:number;openedAt?:number;closedAt?:number;
}
export interface PollBallot{
 id:string;pollId:string;memberId:string;status:'CAST'|'WITHDRAWN';
 revision:number;createdAt:number;option?:number;withdrawnAt?:number;
}
export interface PollState{polls:Phase4Poll[];ballots:PollBallot[];}
export const emptyPollState=():PollState=>({polls:[],ballots:[]});
const record=(x:unknown):x is Record<string,unknown>=>
 x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]) =>
 required.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
const id=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{24}$/u.test(x);
const member=(x:unknown)=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const group=(x:unknown)=>typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const revision=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=1&&x<=9_999_999_999;
const clock=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000-86_400_000;
const text=(x:unknown,min:number,max:number):x is string=>
 typeof x==='string'&&x.length>=min&&x.length<=max&&x.trim()===x&&
 !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(x);
export function validPollInput(input:unknown):input is {
 kind:PollKind;question:string;options:string[];durationMinutes:number;
}{
 if(!record(input)||!exact(input,['kind','question','options','durationMinutes'])||
  !['NEEDS','INTERESTS','SESSION_FEEDBACK'].includes(String(input.kind))||
  !text(input.question,8,240)||!Array.isArray(input.options)||
  input.options.length<2||input.options.length>8||
  input.options.some(o=>!text(o,2,80))||
  !Number.isSafeInteger(input.durationMinutes)||Number(input.durationMinutes)<10||
  Number(input.durationMinutes)>1440)return false;
 return new Set(input.options.map((o:string)=>o.normalize('NFKC').toLocaleLowerCase('en-US'))).size===
  input.options.length;
}
export function validPoll(row:unknown):row is Phase4Poll{
 if(!record(row)||!exact(row,['id','chatId','chatVersion','ownerId','kind','question',
  'options','status','revision','createdAt','expiresAt'],['openedAt','closedAt']))return false;
 if(!id(row.id)||!group(row.chatId)||!revision(row.chatVersion)||!member(row.ownerId)||
  !validPollInput({kind:row.kind,question:row.question,options:row.options,
   durationMinutes:(Number(row.expiresAt)-Number(row.createdAt))/60_000})||
  !clock(row.createdAt)||!clock(row.expiresAt))return false;
 if(row.status==='DRAFT')
  return row.revision===1&&row.openedAt===undefined&&row.closedAt===undefined;
 if(row.status==='OPEN')
  return row.revision===2&&clock(row.openedAt)&&Number(row.openedAt)>=Number(row.createdAt)&&
   Number(row.openedAt)<Number(row.expiresAt)&&row.closedAt===undefined;
 if(row.status!=='CLOSED'||!clock(row.closedAt)||Number(row.closedAt)<Number(row.createdAt))
  return false;
 if(row.openedAt===undefined)return row.revision===2;
 return row.revision===3&&clock(row.openedAt)&&Number(row.openedAt)>=Number(row.createdAt)&&
  Number(row.openedAt)<Number(row.expiresAt)&&Number(row.closedAt)>=Number(row.openedAt);
}
export function validPollState(raw:unknown):raw is PollState{
 if(!record(raw)||!exact(raw,['polls','ballots'])||
  !Array.isArray(raw.polls)||raw.polls.length>200||
  !Array.isArray(raw.ballots)||raw.ballots.length>5000||
  raw.polls.some(x=>!validPoll(x)))return false;
 const polls=raw.polls as Phase4Poll[];
 if(new Set(polls.map(x=>x.id)).size!==polls.length)return false;
 const map=new Map(polls.map(x=>[x.id,x]));
 if(raw.ballots.some(x=>{
  if(!record(x)||!exact(x,['id','pollId','memberId','status','revision','createdAt'],
   ['option','withdrawnAt'])||!id(x.id)||!id(x.pollId)||!member(x.memberId)||
   !revision(x.revision)||!clock(x.createdAt))return true;
  const poll=map.get(x.pollId as string);
  if(!poll||poll.openedAt===undefined||x.memberId===poll.ownerId||
   Number(x.createdAt)<poll.openedAt||Number(x.createdAt)>=poll.expiresAt||
   poll.closedAt!==undefined&&Number(x.createdAt)>poll.closedAt)return true;
  if(x.status==='CAST')return x.revision!==1||x.withdrawnAt!==undefined||
   !Number.isSafeInteger(x.option)||Number(x.option)<0||Number(x.option)>=poll.options.length;
  if(x.status==='WITHDRAWN')return x.revision!==2||x.option!==undefined||
   !clock(x.withdrawnAt)||Number(x.withdrawnAt)<Number(x.createdAt);
  return true;
 }))return false;
 const ballots=raw.ballots as PollBallot[];
 return new Set(ballots.map(x=>x.id)).size===ballots.length&&
  new Set(ballots.map(x=>x.pollId+':'+x.memberId)).size===ballots.length;
}
