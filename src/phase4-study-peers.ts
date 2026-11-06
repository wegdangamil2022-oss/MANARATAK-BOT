import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyStudyPeerState,type StudyCircle,type StudyPeerState,
 type StudyLevel,type StudyReportReason,validStudyInput,studyId,studyGroup,studyUser}
 from './phase4-study-peer-model.js';

type VerifyMember=(chatId:string,memberId:string)=>Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
type JoinStatus='JOINED'|'ALREADY_JOINED'|'CLOSED'|'STALE'|'EXPIRED'|
 'FULL'|'VERIFICATION_REQUIRED'|'INVALID'|'NOT_FOUND';
type ReportStatus='REPORTED'|'ALREADY_REPORTED'|'INVALID'|'NOT_JOINED'|
 'CLOSED'|'STALE'|'VERIFICATION_REQUIRED'|'CAPACITY';
const time=(x:number)=>Number.isSafeInteger(x)&&x>=0&&
 x<=8_640_000_000_000_000-31*86_400_000;
const state=(s:BotState):StudyPeerState=>s.phase4StudyPeers??emptyStudyPeerState();
const newId=(rows:readonly {id:string}[])=>{
 let out='';do{out=randomBytes(12).toString('hex');}
 while(rows.some(x=>x.id===out));return out;
};
const approved=(s:BotState,p:Policy,id:string)=>{
 const rows=s.chats.filter(x=>x.id===id),chat=rows[0];
 return rows.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&p.canUseChat(s,id,'navigation')?chat:null;
};
const policyFingerprint=(s:BotState,id:string)=>JSON.stringify(
 s.subscriptionRequirements.filter(x=>x.chatId===id));
/** Moderator-managed groups, not personal matchmaking. No minor-to-adult
 * one-to-one pairing, member directory, Telegram direct messages, contacts,
 * personal addresses, usernames or automatic invitation links.
 */
export class Phase4StudyPeersService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private scope(s:BotState,actor:string,chatId:string):number|null{
  const chat=approved(s,this.policy,chatId);
  return chat&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?chat.version:null;
 }
 async draft(actor:string,chatId:string,input:{
  topic:string;level:StudyLevel;startsAt:number;durationMinutes:number;capacity:number;
 }):Promise<StudyCircle>{
  const now=this.clock();
  if(!time(now)||!studyGroup(chatId)||!validStudyInput(input)||
   input.startsAt<now+600_000||input.startsAt>now+90*86_400_000)
   throw Error('PEER_INVALID');
  return this.store.transaction(s=>{
   const version=this.scope(s,actor,chatId);
   if(version===null)throw Error('PEER_DENIED');
   const d=state(s);if(d.circles.length>=100)throw Error('PEER_CAPACITY');
   const circle:StudyCircle={id:newId(d.circles),chatId,chatVersion:version,
    ownerId:actor,topic:input.topic,level:input.level,startsAt:input.startsAt,
    endsAt:input.startsAt+input.durationMinutes*60_000,
    capacity:input.capacity,status:'DRAFT',revision:1,createdAt:now};
   d.circles.push(circle);s.phase4StudyPeers=d;return structuredClone(circle);
  });
 }
 async open(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.circles.filter(x=>x.id===id),circle=rows[0];
   if(rows.length!==1||!circle||circle.status!=='DRAFT'||revision!==1||
    circle.revision!==revision||circle.ownerId!==actor||
    this.scope(s,actor,circle.chatId)!==circle.chatVersion||
    now<circle.createdAt||now>=circle.startsAt)return false;
   circle.status='OPEN';circle.revision=2;circle.openedAt=now;
   s.phase4StudyPeers=d;return true;
  });
 }
 async cancel(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.circles.filter(x=>x.id===id),circle=rows[0];
   if(rows.length!==1||!circle||!['DRAFT','OPEN'].includes(circle.status)||
    circle.revision!==revision||circle.ownerId!==actor||
    this.scope(s,actor,circle.chatId)!==circle.chatVersion||now<circle.createdAt)return false;
   circle.status='CANCELLED';circle.revision++;circle.closedAt=now;
   d.members=d.members.filter(x=>x.circleId!==id);
   d.reports=d.reports.filter(x=>x.circleId!==id);
   s.phase4StudyPeers=d;return true;
  });
 }
 async join(actor:string,id:string):Promise<{status:JoinStatus}>{
  const deny=(status:JoinStatus)=>({status});
  const start=this.clock();if(!studyUser(actor)||!studyId(id)||!time(start))
   return deny('INVALID');
  const first=await this.store.snapshot(),d=state(first),found=d.circles.filter(x=>x.id===id),c=found[0];
  if(found.length!==1||!c)return deny('NOT_FOUND');
  if(c.status!=='OPEN')return deny('CLOSED');
  if(start>=c.startsAt)return deny('EXPIRED');
  if(actor===c.ownerId)return deny('INVALID');
  const chat=approved(first,this.policy,c.chatId);
  if(!chat||chat.version!==c.chatVersion)return deny('STALE');
  if(d.members.some(x=>x.circleId===id&&x.memberId===actor))return deny('ALREADY_JOINED');
  const fence=policyFingerprint(first,c.chatId);
  let proof=false;
  try{proof=await this.verifyMember(c.chatId,actor)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!proof)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const data=state(s),rows=data.circles.filter(x=>x.id===id),live=rows[0];
   const now=this.clock();
   if(rows.length!==1||!live||live.status!=='OPEN')return deny('CLOSED');
   if(now<start||now>=live.startsAt)return deny('EXPIRED');
   if(live.revision!==c.revision||live.chatVersion!==c.chatVersion||
    approved(s,this.policy,live.chatId)?.version!==live.chatVersion||
    policyFingerprint(s,live.chatId)!==fence)return deny('STALE');
   if(data.members.some(x=>x.circleId===id&&x.memberId===actor))
    return deny('ALREADY_JOINED');
   if(data.members.filter(x=>x.circleId===id&&x.status==='JOINED').length>=live.capacity||
    data.members.length>=3000)return deny('FULL');
   data.members.push({id:newId(data.members),circleId:id,memberId:actor,
    status:'JOINED',revision:1,createdAt:now});
   s.phase4StudyPeers=data;return deny('JOINED');
  });
 }
 /** Leave without network or current membership so withdrawing opt-in
  * cannot be held hostage by a subscription or group removal.
  */
 async leave(actor:string,id:string):Promise<boolean>{
  const now=this.clock();if(!time(now)||!studyUser(actor)||!studyId(id))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.members.filter(x=>x.circleId===id&&x.memberId===actor),member=rows[0];
   if(rows.length!==1||!member||member.status!=='JOINED'||now<member.createdAt)return false;
   member.status='LEFT';member.revision=2;member.leftAt=now;
   s.phase4StudyPeers=d;return true;
  });
 }
 async memberStatus(actor:string,id:string):Promise<{status:'JOINED'|'LEFT'}|null>{
  if(!studyUser(actor)||!studyId(id))return null;
  const d=state(await this.store.snapshot()),rows=d.members.filter(x=>x.circleId===id&&x.memberId===actor);
  return rows.length===1?{status:rows[0]!.status}:null;
 }
 async memberInfo(actor:string,id:string):Promise<{
  topic:string;level:StudyLevel;startsAt:number;endsAt:number;
  capacity:number;joined:number;status:'OPEN'|'CLOSED'
 }|null>{
  if(!studyUser(actor)||!studyId(id))return null;
  const initial=await this.store.snapshot(),d=state(initial),found=d.circles.filter(x=>x.id===id),c=found[0];
  if(found.length!==1||!c||!['OPEN','CLOSED'].includes(c.status)||
   approved(initial,this.policy,c.chatId)?.version!==c.chatVersion)return null;
  const fence=policyFingerprint(initial,c.chatId);
  let proof=false;
  try{proof=await this.verifyMember(c.chatId,actor)==='VERIFIED';}
  catch{return null;}
  if(!proof)return null;
  const fresh=await this.store.snapshot(),liveState=state(fresh),rows=liveState.circles.filter(x=>x.id===id),row=rows[0];
  if(rows.length!==1||!row||!['OPEN','CLOSED'].includes(row.status)||
   row.chatVersion!==c.chatVersion||row.revision!==c.revision||
   approved(fresh,this.policy,row.chatId)?.version!==row.chatVersion||
   policyFingerprint(fresh,row.chatId)!==fence)return null;
  return {topic:row.topic,level:row.level,startsAt:row.startsAt,endsAt:row.endsAt,
   capacity:row.capacity,joined:liveState.members.filter(x=>
    x.circleId===id&&x.status==='JOINED').length,status:row.status};
 }
 async report(actor:string,id:string,reason:string):Promise<{status:ReportStatus}>{
  const deny=(status:ReportStatus)=>({status});
  const start=this.clock();
  if(!studyUser(actor)||!studyId(id)||!time(start)||
   !['CONTACT_REQUEST','UNSAFE_MATCH','HARASSMENT'].includes(reason))return deny('INVALID');
  const initial=await this.store.snapshot(),d=state(initial),
   found=d.circles.filter(x=>x.id===id),c=found[0];
  if(found.length!==1||!c||c.status!=='OPEN'||start>=c.endsAt)return deny('CLOSED');
  if(!d.members.some(x=>x.circleId===id&&x.memberId===actor&&x.status==='JOINED'))
   return deny('NOT_JOINED');
  if(d.reports.some(x=>x.circleId===id&&x.reporterId===actor))return deny('ALREADY_REPORTED');
  if(approved(initial,this.policy,c.chatId)?.version!==c.chatVersion)return deny('STALE');
  const fence=policyFingerprint(initial,c.chatId);
  let proof=false;try{proof=await this.verifyMember(c.chatId,actor)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!proof)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const d=state(s),rows=d.circles.filter(x=>x.id===id),live=rows[0];
   const now=this.clock();
   if(rows.length!==1||!live||live.status!=='OPEN'||now<start||now>=live.endsAt)
    return deny('CLOSED');
   if(live.chatVersion!==c.chatVersion||live.revision!==c.revision||
    approved(s,this.policy,live.chatId)?.version!==live.chatVersion||
    policyFingerprint(s,live.chatId)!==fence)return deny('STALE');
   if(!d.members.some(x=>x.circleId===id&&x.memberId===actor&&x.status==='JOINED'))
    return deny('NOT_JOINED');
   if(d.reports.some(x=>x.circleId===id&&x.reporterId===actor))
    return deny('ALREADY_REPORTED');
   if(d.reports.length>=500)return deny('CAPACITY');
   d.reports.push({id:newId(d.reports),circleId:id,reporterId:actor,
    reason:reason as StudyReportReason,createdAt:now});
   s.phase4StudyPeers=d;return deny('REPORTED');
  });
 }
 async ownerCounts(actor:string,id:string):Promise<number|null>{
  const s=await this.store.snapshot(),d=state(s),found=d.circles.filter(x=>x.id===id),c=found[0];
  if(found.length!==1||!c||c.ownerId!==actor||
   this.scope(s,actor,c.chatId)!==c.chatVersion)return null;
  return d.members.filter(x=>x.circleId===id&&x.status==='JOINED').length;
 }
 async ownerReports(actor:string,id:string):Promise<{
  CONTACT_REQUEST:number;UNSAFE_MATCH:number;HARASSMENT:number;
 }|null>{
  const s=await this.store.snapshot(),d=state(s),found=d.circles.filter(x=>x.id===id),c=found[0];
  if(found.length!==1||!c||c.ownerId!==actor||
   this.scope(s,actor,c.chatId)!==c.chatVersion)return null;
  const count={CONTACT_REQUEST:0,UNSAFE_MATCH:0,HARASSMENT:0};
  for(const report of d.reports.filter(x=>x.circleId===id))count[report.reason]++;
  return count;
 }
 async ownerView(actor:string,id:string):Promise<StudyCircle|null>{
  const s=await this.store.snapshot(),d=state(s),found=d.circles.filter(x=>x.id===id),c=found[0];
  return found.length===1&&c&&c.ownerId===actor&&
   this.scope(s,actor,c.chatId)===c.chatVersion?structuredClone(c):null;
 }
 async list(actor:string):Promise<StudyCircle[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor))
   throw Error('PEER_DENIED');
  return state(s).circles.filter(x=>x.ownerId===actor&&
   this.scope(s,actor,x.chatId)===x.chatVersion)
   .sort((a,b)=>a.startsAt-b.startsAt||a.id.localeCompare(b.id))
   .slice(0,50).map(x=>structuredClone(x));
 }
 async expire():Promise<number>{
  const now=this.clock();if(!time(now))return 0;
  return this.store.transaction(s=>{
   const d=state(s);let count=0;
   for(const c of d.circles){
    if(c.status==='DRAFT'&&now>=c.startsAt){
     c.status='CANCELLED';c.revision=2;c.closedAt=now;count++;
    }else if(c.status==='OPEN'&&now>=c.endsAt){
     c.status='CLOSED';c.revision=3;c.closedAt=now;count++;
    }
   }
   const members=d.members.length,reports=d.reports.length,circles=d.circles.length;
   d.members=d.members.filter(x=>{
    const c=d.circles.find(z=>z.id===x.circleId);
    return Boolean(c&&c.status!=='CANCELLED'&&now<c.endsAt+86_400_000);
   });
   d.reports=d.reports.filter(x=>{
    const c=d.circles.find(z=>z.id===x.circleId);
    return Boolean(c&&c.status!=='CANCELLED'&&now<c.endsAt+86_400_000);
   });
   d.circles=d.circles.filter(c=>now<c.endsAt+30*86_400_000);
   if(count||members!==d.members.length||reports!==d.reports.length||
    circles!==d.circles.length)s.phase4StudyPeers=d;
   return count;
  });
 }
}
