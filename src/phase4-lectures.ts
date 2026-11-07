import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyLectureState,type LectureState,type LectureSession,
 lectureId,lectureGroup,lectureTime,lectureDuration} from './phase4-lecture-model.js';

const state=(s:BotState):LectureState=>s.phase4Lectures??emptyLectureState();
const approved=(s:BotState,p:Policy,chatId:string)=>{
 const matches=s.chats.filter(c=>c.id===chatId),chat=matches[0];
 return matches.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&p.canUseChat(s,chatId,'navigation')?chat:null;
};
const key=(rows:readonly LectureSession[]):string=>{
 let x:string;do{x=randomBytes(12).toString('hex');}
 while(rows.some(p=>p.id===x));return x;
};
/** Pure predicate reusable in inbound decision and *outbound* Telegram
 * dispatcher. A revoked/changed group epoch never inherits an old session.
 * False is NOT a bypass of any security check; it only allows original
 * automation configuration to make its usual independent decision.
 */
export function lectureBlocksAutomation(s:BotState,chatId:string,now:number):boolean{
 if(!lectureGroup(chatId)||!lectureTime(now))return false;
 const matches=s.chats.filter(c=>c.id===chatId),chat=matches[0];
 if(matches.length!==1||!chat||!chat.approved||!chat.scopes.includes('navigation'))
  return false;
 return (s.phase4Lectures?.sessions??[]).some(x=>
  x.chatId===chatId&&x.chatVersion===chat.version&&
  x.status==='ACTIVE'&&x.startedAt!==undefined&&x.endsAt!==undefined&&
  now>=x.startedAt&&now<x.endsAt);
}
const retire=(s:BotState,p:Policy,now:number):number=>{
 const data=state(s);let changed=0;
 for(const q of data.sessions){
  if(q.status==='DRAFT'&&now>=q.createdAt+15*60_000){
   q.status='ENDED';q.revision=2;q.closedAt=now;changed++;
  }
  if(q.status==='ACTIVE'&&(
   now>=q.endsAt!||approved(s,p,q.chatId)?.version!==q.chatVersion)){
   q.status='ENDED';q.revision=3;q.closedAt=now;changed++;
  }
 }
 const before=data.sessions.length;
 data.sessions=data.sessions.filter(x=>
  x.status!=='ENDED'||x.closedAt!==undefined&&now-x.closedAt<7*86_400_000);
 if(before!==data.sessions.length)changed+=before-data.sessions.length;
 if(changed)s.phase4Lectures=data;
 return changed;
};
/** Lecture quiet mode changes no old policy fields and never touches bans,
 * mute, CAPTCHA, mandatory channels, security alerts or moderation.
 */
export class Phase4LectureService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private owner(s:BotState,actor:string,chatId:string):number|null{
  const chat=approved(s,this.policy,chatId);
  return chat&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?chat.version:null;
 }
 async draft(actor:string,chatId:string,durationMinutes:number):Promise<LectureSession>{
  const now=this.clock();
  if(!lectureGroup(chatId)||!lectureDuration(durationMinutes)||!lectureTime(now))
   throw Error('LECTURE_INVALID');
  return this.store.transaction(s=>{
   const version=this.owner(s,actor,chatId);
   if(version===null)throw Error('LECTURE_DENIED');
   retire(s,this.policy,now);
   const d=state(s);
   if(d.sessions.length>=250)throw Error('LECTURE_CAPACITY');
   if(d.sessions.some(x=>x.chatId===chatId&&
    (x.status==='ACTIVE'||x.status==='DRAFT')))throw Error('LECTURE_CONFLICT');
   const row:LectureSession={id:key(d.sessions),chatId,chatVersion:version,
    ownerId:actor,durationMinutes,status:'DRAFT',revision:1,createdAt:now};
   d.sessions.push(row);s.phase4Lectures=d;return structuredClone(row);
  });
 }
 async start(actor:string,id:string,expectedRevision:number):Promise<boolean>{
  const now=this.clock();
  if(!lectureTime(now)||!lectureId(id)||expectedRevision!==1)return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.sessions.filter(x=>x.id===id),row=rows[0];
   if(rows.length!==1||!row||row.status!=='DRAFT'||row.revision!==expectedRevision||
    row.ownerId!==actor||now<row.createdAt||now>=row.createdAt+15*60_000||
    this.owner(s,actor,row.chatId)!==row.chatVersion||
    d.sessions.some(x=>x.id!==id&&x.chatId===row.chatId&&x.status==='ACTIVE'))
    return false;
   row.status='ACTIVE';row.revision=2;row.startedAt=now;
   row.endsAt=now+row.durationMinutes*60_000;
   s.phase4Lectures=d;return true;
  });
 }
 async stop(actor:string,id:string,expectedRevision:number):Promise<boolean>{
  const now=this.clock();
  if(!lectureTime(now)||!lectureId(id)||expectedRevision!==2)return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.sessions.filter(x=>x.id===id),row=rows[0];
   if(rows.length!==1||!row||row.status!=='ACTIVE'||
    row.revision!==expectedRevision||row.ownerId!==actor||
    this.owner(s,actor,row.chatId)!==row.chatVersion||
    row.startedAt===undefined||now<row.startedAt||now>=row.endsAt!)return false;
   row.status='ENDED';row.revision=3;row.closedAt=now;
   s.phase4Lectures=d;return true;
  });
 }
 async view(actor:string,id:string):Promise<LectureSession|null>{
  if(!lectureId(id))return null;
  const s=await this.store.snapshot(),matches=state(s).sessions.filter(x=>x.id===id),row=matches[0];
  return matches.length===1&&row&&row.ownerId===actor&&
   this.owner(s,actor,row.chatId)===row.chatVersion?structuredClone(row):null;
 }
 async list(actor:string):Promise<LectureSession[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor))
   throw Error('LECTURE_DENIED');
  return state(s).sessions.filter(x=>x.ownerId===actor&&
   this.owner(s,actor,x.chatId)===x.chatVersion)
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
   .slice(0,30).map(x=>structuredClone(x));
 }
 async expire():Promise<number>{
  const now=this.clock();if(!lectureTime(now))return 0;
  return this.store.transaction(s=>retire(s,this.policy,now));
 }
}
