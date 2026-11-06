import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyPollState,type Phase4Poll,type PollState,
 validPollInput} from './phase4-poll-model.js';

type MemberVerification=(chatId:string,actor:string)=>Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
export type PollVoteStatus='CAST'|'ALREADY_VOTED'|'VERIFICATION_REQUIRED'|
 'NOT_FOUND'|'CLOSED'|'EXPIRED'|'STALE'|'INVALID'|'CAPACITY';
export type PollVoteResult={status:PollVoteStatus};
export type PollResult={question:string;options:string[];counts:number[];total:number};
const validUser=(x:string)=>/^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const validGroup=(x:string)=>/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const validClock=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-86_400_000;
const state=(s:BotState):PollState=>s.phase4Polls??emptyPollState();
const makeId=(rows:readonly {id:string}[]):string=>{
 let id='';
 do{id=randomBytes(12).toString('hex');}
 while(rows.some(x=>x.id===id));
 return id;
};
const approved=(s:BotState,policy:Policy,id:string)=>{
 const matches=s.chats.filter(c=>c.id===id),chat=matches[0];
 return matches.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&policy.canUseChat(s,id,'navigation')?chat:null;
};
/** Independent 09:08 survey engine; explicitly not competition, ranking or
 * token-based prize voting. No Telegram poll is published by this engine. */
export class Phase4PollService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:MemberVerification=async()=> 'UNKNOWN'){}
 private scope(s:BotState,actor:string,chatId:string):number|null{
  const c=approved(s,this.policy,chatId);
  return c&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?c.version:null;
 }
 async draft(actor:string,chatId:string,input:{
  kind:'NEEDS'|'INTERESTS'|'SESSION_FEEDBACK';question:string;
  options:string[];durationMinutes:number;
 }):Promise<Phase4Poll>{
  const now=this.clock();
  if(!validClock(now)||!validGroup(chatId)||!validPollInput(input))
   throw Error('POLL_INPUT_INVALID');
  return this.store.transaction(s=>{
   const version=this.scope(s,actor,chatId);
   if(version===null)throw Error('POLL_DENIED');
   const d=state(s);
   if(d.polls.length>=200)throw Error('POLL_CAPACITY');
   const row:Phase4Poll={id:makeId(d.polls),chatId,chatVersion:version,
    ownerId:actor,kind:input.kind,question:input.question,
    options:[...input.options],status:'DRAFT',revision:1,
    createdAt:now,expiresAt:now+input.durationMinutes*60_000};
   d.polls.push(row);s.phase4Polls=d;return structuredClone(row);
  });
 }
 async open(actor:string,id:string,expectedRevision:number):Promise<boolean>{
  const now=this.clock();if(!validClock(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.polls.filter(x=>x.id===id),poll=rows[0];
   if(rows.length!==1||!poll||poll.status!=='DRAFT'||
    poll.revision!==expectedRevision||expectedRevision!==1||poll.ownerId!==actor||
    this.scope(s,actor,poll.chatId)!==poll.chatVersion||
    now<poll.createdAt||now>=poll.expiresAt)return false;
   poll.status='OPEN';poll.revision=2;poll.openedAt=now;
   s.phase4Polls=d;return true;
  });
 }
 async close(actor:string,id:string,expectedRevision:number):Promise<boolean>{
  const now=this.clock();if(!validClock(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.polls.filter(x=>x.id===id),poll=rows[0];
   if(rows.length!==1||!poll||poll.status==='CLOSED'||
    poll.revision!==expectedRevision||poll.ownerId!==actor||
    this.scope(s,actor,poll.chatId)!==poll.chatVersion||now<poll.createdAt)
    return false;
   poll.status='CLOSED';poll.revision++;poll.closedAt=now;
   s.phase4Polls=d;return true;
  });
 }
 /** Valid Telegram identity must be checked at ingress. A double-click,
  * late verification or changed group epoch can never add a second ballot. */
 async vote(memberId:string,pollId:string,option:number):Promise<PollVoteResult>{
  const deny=(status:PollVoteStatus):PollVoteResult=>({status});
  const start=this.clock();
  if(!validClock(start)||!validUser(memberId)||!Number.isSafeInteger(option)||option<0)
   return deny('INVALID');
  const initial=await this.store.snapshot(),d=state(initial);
  const rows=d.polls.filter(p=>p.id===pollId),poll=rows[0];
  if(rows.length!==1||!poll)return deny('NOT_FOUND');
  if(poll.status!=='OPEN')return deny('CLOSED');
  if(start<poll.createdAt||start>=poll.expiresAt)return deny('EXPIRED');
  if(option>=poll.options.length||poll.ownerId===memberId)return deny('INVALID');
  const chat=approved(initial,this.policy,poll.chatId);
  if(!chat||chat.version!==poll.chatVersion)return deny('STALE');
  if(d.ballots.some(b=>b.pollId===pollId&&b.memberId===memberId))
   return deny('ALREADY_VOTED');
  let verified=false;
  try{verified=await this.verifyMember(poll.chatId,memberId)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!verified)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const data=state(s),fresh=data.polls.filter(p=>p.id===pollId),row=fresh[0];
   if(fresh.length!==1||!row)return deny('NOT_FOUND');
   if(row.status!=='OPEN')return deny('CLOSED');
   const now=this.clock();
   if(!validClock(now)||now<start)return deny('STALE');
   if(now>=row.expiresAt)return deny('EXPIRED');
   const group=approved(s,this.policy,row.chatId);
   if(!group||group.version!==row.chatVersion||row.chatVersion!==poll.chatVersion||
    row.revision!==poll.revision||row.expiresAt!==poll.expiresAt)
    return deny('STALE');
   if(option>=row.options.length||row.ownerId===memberId)return deny('INVALID');
   if(data.ballots.some(b=>b.pollId===pollId&&b.memberId===memberId))
    return deny('ALREADY_VOTED');
   if(data.ballots.length>=5000)return deny('CAPACITY');
   data.ballots.push({id:makeId(data.ballots),pollId,memberId,
    option,status:'CAST',revision:1,createdAt:now});
   s.phase4Polls=data;return deny('CAST');
  });
 }
 /** Withdraw even without current group membership or Telegram network.
  * Leave a redacted tombstone to block re-voting and count inflation. */
 async withdraw(actor:string,pollId:string):Promise<boolean>{
  const now=this.clock();if(!validClock(now)||!validUser(actor))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.ballots.filter(b=>b.pollId===pollId&&b.memberId===actor),row=rows[0];
   if(rows.length!==1||!row||row.status!=='CAST'||now<row.createdAt)return false;
   row.status='WITHDRAWN';row.revision=2;delete row.option;row.withdrawnAt=now;
   s.phase4Polls=d;return true;
  });
 }
 async myVote(actor:string,id:string):Promise<{status:'CAST'|'WITHDRAWN'}|null>{
  if(!validUser(actor))return null;
  const d=state(await this.store.snapshot()),rows=d.ballots.filter(b=>b.pollId===id&&b.memberId===actor);
  return rows.length===1?{status:rows[0]!.status}:null;
 }
 /** Owner-only aggregate AFTER closure, minimum 5 active voters.
  * Never return identities, raw ballots or one-person vote choices. */
 async results(actor:string,id:string):Promise<PollResult|null>{
  const s=await this.store.snapshot(),d=state(s),rows=d.polls.filter(p=>p.id===id),poll=rows[0];
  if(rows.length!==1||!poll||poll.status!=='CLOSED'||poll.ownerId!==actor||
   this.scope(s,actor,poll.chatId)!==poll.chatVersion)return null;
  const ballots=d.ballots.filter(b=>b.pollId===id&&b.status==='CAST');
  if(ballots.length<5)return null;
  const counts=poll.options.map((_,i)=>ballots.filter(b=>b.option===i).length);
  return {question:poll.question,options:[...poll.options],counts,total:ballots.length};
 }
 async view(actor:string,id:string):Promise<Phase4Poll|null>{
  const s=await this.store.snapshot(),rows=state(s).polls.filter(x=>x.id===id),poll=rows[0];
  return rows.length===1&&poll&&poll.ownerId===actor&&
   this.scope(s,actor,poll.chatId)===poll.chatVersion?structuredClone(poll):null;
 }
 async list(actor:string):Promise<Phase4Poll[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor))
   throw Error('POLL_DENIED');
  return state(s).polls.filter(p=>p.ownerId===actor&&this.scope(s,actor,p.chatId)===p.chatVersion)
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
   .slice(0,50).map(p=>structuredClone(p));
 }
 /** Periodic local retention, no Telegram sends. Purge closed ballots
  * (including member identifiers) and poll rows after 24 hours. */
 async expire():Promise<number>{
  const now=this.clock();if(!validClock(now))return 0;
  return this.store.transaction(s=>{
   const d=state(s);let count=0;
   for(const p of d.polls){
    if(p.status==='CLOSED'||now<p.expiresAt)continue;
    p.status='CLOSED';p.revision++;p.closedAt=now;count++;
   }
   const before=d.polls.length;
   d.polls=d.polls.filter(p=>p.status!=='CLOSED'||p.closedAt===undefined||
    now-p.closedAt<=86_400_000);
   const keep=new Set(d.polls.map(p=>p.id)),ballots=d.ballots.length;
   d.ballots=d.ballots.filter(b=>keep.has(b.pollId));
   if(count||d.polls.length!==before||ballots!==d.ballots.length)
    s.phase4Polls=d;
   return count;
  });
 }
}
