import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyEventState,type EventState,type Phase4Event,
 type EventSummary,validEventInput,validEventSummaryInput,
 eventId,eventUser,eventGroup} from './phase4-event-model.js';

type VerifyMember=(groupId:string,userId:string)=>Promise<
 'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
type RegisterStatus='REGISTERED'|'ALREADY_REGISTERED'|'CLOSED'|
 'NOT_FOUND'|'STALE'|'FULL'|'VERIFICATION_REQUIRED'|'INVALID'|'EXPIRED';
type RegisterResult={status:RegisterStatus};
const time=(x:number)=>Number.isSafeInteger(x)&&x>=0&&
 x<=8_640_000_000_000_000-60*86_400_000;
const state=(s:BotState):EventState=>s.phase4Events??emptyEventState();
const newId=(rows:readonly {id:string}[])=>{
 let id='';
 do{id=randomBytes(12).toString('hex');}
 while(rows.some(x=>x.id===id));
 return id;
};
const currentChat=(s:BotState,policy:Policy,id:string)=>{
 const matches=s.chats.filter(c=>c.id===id),chat=matches[0];
 return matches.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&policy.canUseChat(s,id,'navigation')?chat:null;
};
const witness=(s:BotState,id:string)=>JSON.stringify(
 s.subscriptionRequirements.filter(r=>r.chatId===id));
/** Local, owner-reviewed event planner. No Telegram delivery, auto-DM,
 * attendance tracking or public announcement is performed by this module.
 * User IDs are retained only while registrations are active/within 24h of
 * the event end and are not exposed by owner UI.
 */
export class Phase4EventService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private owner(s:BotState,actor:string,chatId:string):number|null{
  const c=currentChat(s,this.policy,chatId);
  return c&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?c.version:null;
 }
 async draft(actor:string,chatId:string,input:{
  title:string;startsAt:number;durationMinutes:number;capacity:number;link:string;
 }):Promise<Phase4Event>{
  const now=this.clock();
  if(!time(now)||!eventGroup(chatId)||!validEventInput(input)||
   input.startsAt<now+600_000||input.startsAt>now+180*86_400_000)
   throw Error('EVENT_INVALID');
  return this.store.transaction(s=>{
   const version=this.owner(s,actor,chatId);
   if(version===null)throw Error('EVENT_DENIED');
   const d=state(s);if(d.events.length>=200)throw Error('EVENT_CAPACITY');
   const row:Phase4Event={
    id:newId(d.events),chatId,chatVersion:version,ownerId:actor,
    title:input.title,link:input.link,startsAt:input.startsAt,
    endsAt:input.startsAt+input.durationMinutes*60_000,capacity:input.capacity,
    status:'DRAFT',revision:1,createdAt:now
   };
   d.events.push(row);s.phase4Events=d;
   return structuredClone(row);
  });
 }
 /** Owner confirmation opens self-registration only; no group send. */
 async open(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),list=d.events.filter(e=>e.id===id),e=list[0];
   if(list.length!==1||!e||e.status!=='DRAFT'||e.revision!==revision||
    revision!==1||e.ownerId!==actor||this.owner(s,actor,e.chatId)!==e.chatVersion||
    now<e.createdAt||now>=e.startsAt)return false;
   e.status='OPEN';e.revision=2;e.openedAt=now;s.phase4Events=d;
   return true;
  });
 }
 async cancel(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),list=d.events.filter(e=>e.id===id),e=list[0];
   if(list.length!==1||!e||!['DRAFT','OPEN'].includes(e.status)||
    e.revision!==revision||e.ownerId!==actor||
    this.owner(s,actor,e.chatId)!==e.chatVersion||now<e.createdAt)return false;
   e.status='CANCELLED';e.revision++;e.cancelledAt=now;
   // Cancelled events may not retain member identifiers.
   d.registrations=d.registrations.filter(r=>r.eventId!==id);
   s.phase4Events=d;return true;
  });
 }
 /** Register only in the member's initiated private chat, after a trusted
  * Telegram membership + any required subscriptions have been verified.
  * The snapshot and the transactional commit BOTH validate the policy.
  */
 async register(memberId:string,id:string,reminderConsent:boolean):Promise<RegisterResult>{
  const deny=(status:RegisterStatus):RegisterResult=>({status});
  const now=this.clock();
  if(!time(now)||!eventUser(memberId)||typeof reminderConsent!=='boolean')
   return deny('INVALID');
  const initial=await this.store.snapshot(),d=state(initial);
  const list=d.events.filter(x=>x.id===id),e=list[0];
  if(list.length!==1||!e)return deny('NOT_FOUND');
  if(e.status!=='OPEN')return deny('CLOSED');
  if(now<e.createdAt||now>=e.startsAt)return deny('EXPIRED');
  if(e.ownerId===memberId)return deny('INVALID');
  const c=currentChat(initial,this.policy,e.chatId);
  if(!c||c.version!==e.chatVersion)return deny('STALE');
  if(d.registrations.some(r=>r.eventId===id&&r.memberId===memberId))
   return deny('ALREADY_REGISTERED');
  if(d.registrations.filter(r=>r.eventId===id&&r.status==='REGISTERED').length>=e.capacity)
   return deny('FULL');
  const subscriptionFence=witness(initial,e.chatId);
  let proof=false;
  try{proof=await this.verifyMember(e.chatId,memberId)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!proof)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const data=state(s),found=data.events.filter(x=>x.id===id),fresh=found[0];
   if(found.length!==1||!fresh)return deny('NOT_FOUND');
   if(fresh.status!=='OPEN')return deny('CLOSED');
   const at=this.clock();
   if(!time(at)||at<now)return deny('STALE');
   if(at>=fresh.startsAt)return deny('EXPIRED');
   const chat=currentChat(s,this.policy,fresh.chatId);
   if(!chat||chat.version!==fresh.chatVersion||
    fresh.chatVersion!==e.chatVersion||fresh.revision!==e.revision||
    fresh.startsAt!==e.startsAt||witness(s,fresh.chatId)!==subscriptionFence)
    return deny('STALE');
   if(fresh.ownerId===memberId)return deny('INVALID');
   if(data.registrations.some(r=>r.eventId===id&&r.memberId===memberId))
    return deny('ALREADY_REGISTERED');
   if(data.registrations.filter(r=>r.eventId===id&&r.status==='REGISTERED').length>=fresh.capacity||
    data.registrations.length>=5000)return deny('FULL');
   data.registrations.push({id:newId(data.registrations),eventId:id,
    memberId,status:'REGISTERED',reminderConsent,revision:1,createdAt:at});
   s.phase4Events=data;return deny('REGISTERED');
  });
 }
 /** Removing consent or cancelling does not need membership: leaving the
  * group must never trap a person's previously given consent. */
 async withdraw(memberId:string,id:string):Promise<boolean>{
  const now=this.clock();if(!time(now)||!eventUser(memberId))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.registrations.filter(x=>x.eventId===id&&x.memberId===memberId),r=rows[0];
   if(rows.length!==1||!r||r.status!=='REGISTERED'||now<r.createdAt)return false;
   r.status='CANCELLED';r.reminderConsent=false;r.cancelledAt=now;r.revision++;
   s.phase4Events=d;return true;
  });
 }
 async reminderConsent(memberId:string,id:string,enabled:boolean):Promise<boolean>{
  const now=this.clock();
  if(!time(now)||!eventUser(memberId)||typeof enabled!=='boolean')return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.registrations.filter(x=>x.eventId===id&&x.memberId===memberId),r=rows[0];
   const events=d.events.filter(e=>e.id===id),e=events[0];
   if(rows.length!==1||!r||r.status!=='REGISTERED'||events.length!==1||!e||
    now<r.createdAt||r.reminderConsent===enabled||
    enabled&&(e.status!=='OPEN'||now>=e.startsAt))return false;
   r.reminderConsent=enabled;r.revision++;s.phase4Events=d;return true;
  });
 }
 async myRegistration(memberId:string,id:string):
 Promise<{status:'REGISTERED'|'CANCELLED';reminderConsent:boolean}|null>{
  if(!eventUser(memberId))return null;
  const rows=state(await this.store.snapshot()).registrations.filter(
   x=>x.memberId===memberId&&x.eventId===id);
  return rows.length===1?{status:rows[0]!.status,
   reminderConsent:rows[0]!.reminderConsent}:null;
 }
 /** This is a count of consented people, NOT messages sent or actual attendance.
  * A later audited dispatcher must verify consent again before each send. */
 async reminderCount(actor:string,id:string):Promise<number|null>{
  const s=await this.store.snapshot(),d=state(s),matches=d.events.filter(e=>e.id===id),e=matches[0];
  if(matches.length!==1||!e||e.status!=='OPEN'||this.owner(s,actor,e.chatId)!==e.chatVersion||
   e.ownerId!==actor||this.clock()>=e.startsAt)return null;
  return d.registrations.filter(x=>x.eventId===id&&x.status==='REGISTERED'&&
   x.reminderConsent).length;
 }
 async view(actor:string,id:string):Promise<Phase4Event|null>{
  const s=await this.store.snapshot(),list=state(s).events.filter(e=>e.id===id),e=list[0];
  return list.length===1&&e&&e.ownerId===actor&&
   this.owner(s,actor,e.chatId)===e.chatVersion?structuredClone(e):null;
 }
 async list(actor:string):Promise<Phase4Event[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor))
   throw Error('EVENT_DENIED');
  return state(s).events.filter(e=>e.ownerId===actor&&
   this.owner(s,actor,e.chatId)===e.chatVersion)
   .sort((a,b)=>a.startsAt-b.startsAt||a.id.localeCompare(b.id))
   .slice(0,50).map(e=>structuredClone(e));
 }
 /** Viewable schedule: no attendee list or registration metadata. */
 async eventInfo(memberId:string,id:string):Promise<Pick<Phase4Event,
  'title'|'link'|'startsAt'|'endsAt'|'status'|'capacity'>|null>{
  if(!eventUser(memberId))return null;
  const s=await this.store.snapshot(),rows=state(s).events.filter(e=>e.id===id),e=rows[0];
  if(rows.length!==1||!e||!['OPEN','FINISHED'].includes(e.status)||
   currentChat(s,this.policy,e.chatId)?.version!==e.chatVersion)return null;
  try{if(await this.verifyMember(e.chatId,memberId)!=='VERIFIED')return null;}
  catch{return null;}
  return {title:e.title,link:e.link,startsAt:e.startsAt,endsAt:e.endsAt,
   status:e.status,capacity:e.capacity};
 }
 /** Draft after event ended, then distinct revision-fenced owner approval.
  * Approved links are owner-reviewed HTTPS references, not link crawling.
  */
 async draftSummary(actor:string,id:string,text:string,urls:string[]):Promise<EventSummary>{
  const now=this.clock();
  if(!time(now)||!validEventSummaryInput(text,urls))
   throw Error('EVENT_SUMMARY_INVALID');
  return this.store.transaction(s=>{
   const d=state(s),matches=d.events.filter(e=>e.id===id),e=matches[0];
   if(matches.length!==1||!e||e.status!=='FINISHED'||e.ownerId!==actor||
    this.owner(s,actor,e.chatId)!==e.chatVersion||
    now<e.finishedAt!||now>e.endsAt+30*86_400_000||
    d.summaries.some(x=>x.eventId===id))throw Error('EVENT_SUMMARY_DENIED');
   const summary:EventSummary={eventId:id,text,urls:[...urls],
    status:'DRAFT',revision:1,createdAt:now};
   d.summaries.push(summary);s.phase4Events=d;
   return structuredClone(summary);
  });
 }
 async approveSummary(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.summaries.filter(x=>x.eventId===id),summary=rows[0];
   const events=d.events.filter(e=>e.id===id),e=events[0];
   if(rows.length!==1||!summary||summary.status!=='DRAFT'||summary.revision!==revision||
    events.length!==1||!e||e.status!=='FINISHED'||e.ownerId!==actor||
    this.owner(s,actor,e.chatId)!==e.chatVersion||
    now<summary.createdAt||now>e.endsAt+30*86_400_000)return false;
   summary.status='APPROVED';summary.revision=2;summary.approvedAt=now;
   s.phase4Events=d;return true;
  });
 }
 /** Read-only owner review of unpublished post-event material. */
 async ownerSummary(actor:string,id:string):Promise<EventSummary|null>{
  const s=await this.store.snapshot(),d=state(s);
  const matches=d.events.filter(e=>e.id===id),e=matches[0];
  if(matches.length!==1||!e||e.ownerId!==actor||
   this.owner(s,actor,e.chatId)!==e.chatVersion)return null;
  const rows=d.summaries.filter(x=>x.eventId===id);
  return rows.length===1?structuredClone(rows[0]!):null;
 }
 async summary(memberId:string,id:string):Promise<{text:string;urls:string[]}|null>{
  if(!eventUser(memberId))return null;
  const s=await this.store.snapshot(),d=state(s);
  const events=d.events.filter(e=>e.id===id),e=events[0];
  const summaries=d.summaries.filter(x=>x.eventId===id),row=summaries[0];
  if(events.length!==1||!e||e.status!=='FINISHED'||summaries.length!==1||
   !row||row.status!=='APPROVED'||
   currentChat(s,this.policy,e.chatId)?.version!==e.chatVersion)return null;
  const fence=witness(s,e.chatId);
  try{if(await this.verifyMember(e.chatId,memberId)!=='VERIFIED')return null;}
  catch{return null;}
  const fresh=await this.store.snapshot(),fs=state(fresh);
  const actual=fs.events.filter(x=>x.id===id),current=actual[0];
  const versions=fs.summaries.filter(x=>x.eventId===id),published=versions[0];
  if(actual.length!==1||!current||current.status!=='FINISHED'||
   current.chatVersion!==e.chatVersion||versions.length!==1||!published||
   published.status!=='APPROVED'||published.revision!==row.revision||
   currentChat(fresh,this.policy,current.chatId)?.version!==current.chatVersion||
   witness(fresh,current.chatId)!==fence)return null;
  return {text:published.text,urls:[...published.urls]};
 }
 /** Expire safely without network; minimize identifiers at +24h and
  * remove the event and reviewed summary at +30 days. */
 async expire():Promise<number>{
  const now=this.clock();if(!time(now))return 0;
  return this.store.transaction(s=>{
   const d=state(s);let changed=0;
   for(const e of d.events){
    if(e.status==='DRAFT'&&now>=e.startsAt){
     e.status='CANCELLED';e.revision++;e.cancelledAt=now;changed++;
    }else if(e.status==='OPEN'&&now>=e.endsAt){
     e.status='FINISHED';e.revision++;e.finishedAt=now;changed++;
    }
   }
   const count=d.registrations.length;
   d.registrations=d.registrations.filter(r=>{
    const e=d.events.find(x=>x.id===r.eventId);
    return Boolean(e&&e.status!=='CANCELLED'&&now<e.endsAt+86_400_000);
   });
   const countEvents=d.events.length;
   d.events=d.events.filter(e=>now<e.endsAt+30*86_400_000);
   const retained=new Set(d.events.map(e=>e.id)),before=d.summaries.length;
   d.summaries=d.summaries.filter(row=>retained.has(row.eventId));
   if(changed||count!==d.registrations.length||countEvents!==d.events.length||
    before!==d.summaries.length)s.phase4Events=d;
   return changed;
  });
 }
}
