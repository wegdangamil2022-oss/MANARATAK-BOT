/** Phase 4 / 09:09 — educational event registration and reviewed resources.
 * No attendance inference, group broadcast or Telegram reminder delivery.
 */
export type EventStatus='DRAFT'|'OPEN'|'CANCELLED'|'FINISHED';
export interface Phase4Event{
 id:string;chatId:string;chatVersion:number;ownerId:string;
 title:string;link:string;startsAt:number;endsAt:number;capacity:number;
 status:EventStatus;revision:number;createdAt:number;
 openedAt?:number;cancelledAt?:number;finishedAt?:number;
 /** One-time reviewed links to existing same-group, private question/survey windows. */
 questionSessionId?:string;pollId?:string;
}
export interface EventRegistration{
 id:string;eventId:string;memberId:string;
 status:'REGISTERED'|'CANCELLED';reminderConsent:boolean;
 revision:number;createdAt:number;cancelledAt?:number;
}
export interface EventSummary{
 eventId:string;text:string;urls:string[];status:'DRAFT'|'APPROVED';
 revision:number;createdAt:number;approvedAt?:number;
}
export interface EventState{
 events:Phase4Event[];registrations:EventRegistration[];summaries:EventSummary[];
}
export const emptyEventState=():EventState=>({events:[],registrations:[],summaries:[]});
const obj=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(x:Record<string,unknown>,needed:readonly string[],optionals:readonly string[]=[]) =>
 needed.every(k=>Object.hasOwn(x,k))&&
 Object.keys(x).every(k=>needed.includes(k)||optionals.includes(k));
const time=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-60*86_400_000;
const revision=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=1&&v<=9_999_999_999;
export const eventId=(v:unknown):v is string=>
 typeof v==='string'&&/^[a-f0-9]{24}$/u.test(v);
export const eventUser=(v:unknown):v is string=>
 typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
export const eventGroup=(v:unknown):v is string=>
 typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const goodText=(v:unknown,min:number,max:number):v is string=>
 typeof v==='string'&&v.length>=min&&v.length<=max&&v===v.trim()&&
 !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
/** Reject HTTP, credentials, local/loopback addresses and disguised hosts.
 * An HTTPS URL remains a manual owner-reviewed reference, not proof of
 * ownership of a university domain or guarantee that the link is safe. */
export function validEventURL(value:unknown):value is string{
 if(typeof value!=='string'||value.length>300||value!==value.trim()||
  /[\u0000-\u0020\u007f<>"'\\]/u.test(value))return false;
 try{
  const url=new URL(value);
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port||
   !host.includes('.')||!host.match(/^[a-z0-9.-]+$/u)||
   /(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$|(?:^|\.)test$|(?:^|\.)invalid$/u.test(host)||
   /^\d+(?:\.\d+){3}$/u.test(host)||host.startsWith('.')||
   host.endsWith('.')||host.includes('..')||url.hash||url.href!==value)return false;
  return true;
 }catch{return false;}
}
export function validEventInput(raw:unknown):raw is {
 title:string;startsAt:number;durationMinutes:number;capacity:number;link:string;
}{
 if(!obj(raw)||!exact(raw,['title','startsAt','durationMinutes','capacity','link']))return false;
 return goodText(raw.title,5,100)&&time(raw.startsAt)&&
  Number.isSafeInteger(raw.durationMinutes)&&
  Number(raw.durationMinutes)>=15&&Number(raw.durationMinutes)<=360&&
  Number.isSafeInteger(raw.capacity)&&
  Number(raw.capacity)>=1&&Number(raw.capacity)<=500&&validEventURL(raw.link);
}
export function validEventSummaryInput(text:unknown,urls:unknown):boolean{
 return goodText(text,20,800)&&Array.isArray(urls)&&urls.length<=3&&
  urls.every(u=>validEventURL(u))&&new Set(urls).size===urls.length;
}
export function validEventRow(raw:unknown):raw is Phase4Event{
 if(!obj(raw)||!exact(raw,['id','chatId','chatVersion','ownerId','title','link',
  'startsAt','endsAt','capacity','status','revision','createdAt'],
  ['openedAt','cancelledAt','finishedAt','questionSessionId','pollId']))return false;
 if(!eventId(raw.id)||!eventGroup(raw.chatId)||!eventUser(raw.ownerId)||
  !revision(raw.chatVersion)||!time(raw.createdAt)||!time(raw.startsAt)||
  !time(raw.endsAt)||!validEventInput({
   title:raw.title,startsAt:raw.startsAt,capacity:raw.capacity,
   link:raw.link,durationMinutes:(Number(raw.endsAt)-Number(raw.startsAt))/60_000
  })||Number(raw.startsAt)-Number(raw.createdAt)<600_000)return false;
 if((raw.questionSessionId!==undefined&&(!eventId(raw.questionSessionId)||raw.openedAt===undefined))||
  (raw.pollId!==undefined&&(!eventId(raw.pollId)||raw.openedAt===undefined)))return false;
 if(raw.status==='DRAFT')return raw.revision===1&&
  raw.openedAt===undefined&&raw.cancelledAt===undefined&&raw.finishedAt===undefined;
 if(raw.status==='OPEN')return raw.revision===2&&
  time(raw.openedAt)&&Number(raw.openedAt)>=Number(raw.createdAt)&&
  Number(raw.openedAt)<Number(raw.startsAt)&&
  raw.cancelledAt===undefined&&raw.finishedAt===undefined;
 if(raw.status==='CANCELLED')return time(raw.cancelledAt)&&
  Number(raw.cancelledAt)>=Number(raw.createdAt)&&
  raw.finishedAt===undefined&&
  (raw.openedAt===undefined?raw.revision===2:
   raw.revision===3&&time(raw.openedAt)&&
   Number(raw.openedAt)>=Number(raw.createdAt)&&
   Number(raw.openedAt)<Number(raw.startsAt));
 if(raw.status==='FINISHED')return raw.revision===3&&
  time(raw.openedAt)&&Number(raw.openedAt)>=Number(raw.createdAt)&&
  Number(raw.openedAt)<Number(raw.startsAt)&&raw.cancelledAt===undefined&&
  time(raw.finishedAt)&&Number(raw.finishedAt)>=Number(raw.endsAt);
 return false;
}
function validRegistration(raw:unknown):raw is EventRegistration{
 if(!obj(raw)||!exact(raw,['id','eventId','memberId','status','reminderConsent',
  'revision','createdAt'],['cancelledAt'])||
  !eventId(raw.id)||!eventId(raw.eventId)||!eventUser(raw.memberId)||
  !revision(raw.revision)||!time(raw.createdAt)||
  typeof raw.reminderConsent!=='boolean')return false;
 if(raw.status==='REGISTERED')return raw.cancelledAt===undefined;
 if(raw.status==='CANCELLED')return raw.reminderConsent===false&&
  raw.revision>=2&&time(raw.cancelledAt)&&
  Number(raw.cancelledAt)>=Number(raw.createdAt);
 return false;
}
function validSummary(raw:unknown):raw is EventSummary{
 if(!obj(raw)||!exact(raw,['eventId','text','urls','status','revision',
  'createdAt'],['approvedAt'])||!eventId(raw.eventId)||
  !validEventSummaryInput(raw.text,raw.urls)||!time(raw.createdAt))return false;
 if(raw.status==='DRAFT')return raw.revision===1&&raw.approvedAt===undefined;
 if(raw.status==='APPROVED')return raw.revision===2&&
  time(raw.approvedAt)&&Number(raw.approvedAt)>=Number(raw.createdAt);
 return false;
}
export function validEventState(raw:unknown):raw is EventState{
 if(!obj(raw)||!exact(raw,['events','registrations','summaries'])||
  !Array.isArray(raw.events)||raw.events.length>200||
  !Array.isArray(raw.registrations)||raw.registrations.length>5000||
  !Array.isArray(raw.summaries)||raw.summaries.length>200||
  raw.events.some(e=>!validEventRow(e))||
  raw.registrations.some(e=>!validRegistration(e))||
  raw.summaries.some(e=>!validSummary(e)))return false;
 const events=raw.events as Phase4Event[];
 const registrations=raw.registrations as EventRegistration[];
 const summaries=raw.summaries as EventSummary[];
 const map=new Map(events.map(e=>[e.id,e]));
 if(map.size!==events.length||
  new Set(registrations.map(x=>x.id)).size!==registrations.length||
  new Set(registrations.map(x=>x.eventId+':'+x.memberId)).size!==registrations.length||
  new Set(summaries.map(x=>x.eventId)).size!==summaries.length)return false;
 const active=new Map<string,number>();
 for(const row of registrations){
  const e=map.get(row.eventId);
  if(!e||e.openedAt===undefined||e.status==='CANCELLED'||
   row.memberId===e.ownerId||row.createdAt<e.openedAt||
   row.createdAt>=e.startsAt||row.createdAt>e.endsAt)return false;
  if(row.status==='REGISTERED'){
   const count=(active.get(e.id)??0)+1;
   if(count>e.capacity)return false;
   active.set(e.id,count);
  }
 }
 for(const row of summaries){
  const e=map.get(row.eventId);
  if(!e||e.status!=='FINISHED'||row.createdAt<e.endsAt||
   row.createdAt<e.finishedAt!)return false;
 }
 return true;
}
