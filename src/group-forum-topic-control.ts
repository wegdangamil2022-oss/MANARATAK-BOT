import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {forumTopicGroupAccess,localForumTopics} from './group-forum-topics.js';

/** TOPIC-005: durable at-most-once CLOSE/REOPEN intent + outcome receipts.
 * An uncompleted START is deliberately UNKNOWN: it must never be replayed.
 * Telegram cannot reliably reveal current per-topic open/closed status.
 */
export type ForumTopicAction='CLOSE'|'REOPEN';
export type ForumTopicActionOutcome='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
export interface ForumTopicControlRecord{
 readonly id:string;readonly group:string;readonly thread:number;
 readonly groupVersion:number;readonly registration:string;
 readonly actor:string;readonly action:ForumTopicAction;
 readonly startedAt:number;readonly outcome?:ForumTopicActionOutcome;
 readonly finishedAt?:number;
}
const ROOT='group:forum:control:',REASON='GROUP_FORUM_CONTROL:';
const KEY=/^group:forum:control:([A-Za-z0-9_-]{24}):([SR])$/u;
const REG=/^group:forum:topic:[A-Za-z0-9_-]{24}$/u;
const person=(s:unknown):s is string=>typeof s==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const chat=(s:unknown):s is string=>typeof s==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const topic=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>1&&v<=2147483647; // general topic #1 is never controlled
const revision=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>0&&v<=9_999_999_999;
const clock=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-120_000;
const action=(v:unknown):v is ForumTopicAction=>v==='CLOSE'||v==='REOPEN';
const outcome=(v:unknown):v is ForumTopicActionOutcome=>
 v==='CONFIRMED'||v==='FAILED_CONFIRMED'||v==='UNKNOWN_OUTCOME';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Body={action:ForumTopicAction;group:string;groupVersion:number;
 registration:string;thread:number;phase:'START'|'RESULT';outcome?:ForumTopicActionOutcome};
function parse(raw:string):Body|null{
 if(!raw.startsWith(REASON))return null;
 let data:unknown;
 try{data=JSON.parse(raw.slice(REASON.length));}catch{return null;}
 if(!data||typeof data!=='object'||Array.isArray(data))return null;
 const x=data as Record<string,unknown>,keys=Object.keys(x).sort().join(',');
 if(!((keys==='action,group,groupVersion,phase,registration,thread'&&x.phase==='START')||
       (keys==='action,group,groupVersion,outcome,phase,registration,thread'&&x.phase==='RESULT'))||
  !action(x.action)||!chat(x.group)||!revision(x.groupVersion)||
  !REG.test(String(x.registration))||!topic(x.thread)||
  (x.phase==='RESULT'&&!outcome(x.outcome)))return null;
 return x as Body;
}
function ledger(s:BotState,now:number):ForumTopicControlRecord[]|null{
 if(!clock(now))return null;
 const events=s.audit.filter(e=>e.updateKey.startsWith(ROOT));
 if(events.length>2500)return null;
 const starts=new Map<string,ForumTopicControlRecord>(),
  ends=new Map<string,{at:number;status:ForumTopicActionOutcome}>(),
  unique=new Set<string>();
 for(const row of events){
  const match=KEY.exec(row.updateKey);
  if(!match||unique.has(row.updateKey)||
   !person(row.actorId)||!revision(row.policyVersion)||
   !clock(row.at)||row.at>now)return null;
  unique.add(row.updateKey);
  const v=parse(row.reason),key=match[1]!,phase=match[2]!;
  if(!v||v.groupVersion!==row.policyVersion||
   phase==='S'&&v.phase!=='START'||phase==='R'&&v.phase!=='RESULT')return null;
  if(phase==='S'){
   if(row.decision!=='ALLOW'||starts.has(key))return null;
   starts.set(key,{id:key,group:v.group,thread:v.thread,
    groupVersion:v.groupVersion,registration:v.registration,
    actor:row.actorId,action:v.action,startedAt:row.at});
  }else{
   if(ends.has(key)||row.decision!==
    (v.outcome==='CONFIRMED'?'ALLOW':'NOOP'))return null;
   ends.set(key,{at:row.at,status:v.outcome!});
  }
 }
 for(const [id,end] of ends){
  const start=starts.get(id);
  const row=events.find(e=>e.updateKey===ROOT+id+':R')!;
  const body=parse(row.reason)!;
  if(!start||end.at<start.startedAt||
   row.actorId!==start.actor||body.action!==start.action||
   body.group!==start.group||body.thread!==start.thread||
   body.groupVersion!==start.groupVersion||
   body.registration!==start.registration)return null;
  starts.set(id,{...start,outcome:end.status,finishedAt:end.at});
 }
 const entries=[...starts.values()],grouped=new Map<string,ForumTopicControlRecord[]>();
 for(const r of entries){
  const k=JSON.stringify([r.group,r.groupVersion,r.thread]);
  const list=grouped.get(k)??[];list.push(r);grouped.set(k,list);
 }
 for(const list of grouped.values()){
  if(list.length>60)return null;
  list.sort((a,b)=>a.startedAt-b.startedAt||a.id.localeCompare(b.id));
  let previous:ForumTopicControlRecord|undefined;
  for(const current of list){
   if(previous&&
    (previous.outcome===undefined||
     previous.outcome==='UNKNOWN_OUTCOME'||
     current.startedAt<=previous.startedAt||
     previous.finishedAt===undefined||
     current.startedAt<previous.finishedAt||
     current.registration!==previous.registration))return null;
   previous=current;
  }
 }
 return entries;
}
function current(s:BotState,p:Policy,actor:string,g:string,t:number,now:number){
 const version=forumTopicGroupAccess(s,p,actor,g,now);
 const registration=localForumTopics(s,p,actor,g,now)?.find(x=>x.threadId===t);
 return version!==null&&topic(t)&&registration&&registration.groupVersion===version?
  registration:null;
}
function available(s:BotState,p:Policy,actor:string,g:string,t:number,
 next:ForumTopicAction,now:number):{version:number;registration:string}|null{
 if(!action(next))return null;
 const local=current(s,p,actor,g,t,now),rows=ledger(s,now);
 if(!local||!rows)return null;
 const all=rows.filter(r=>r.group===g&&r.thread===t&&
  r.groupVersion===local.groupVersion);
 if(all.some(r=>r.registration!==local.reference)||all.length>=60)return null;
 const latest=[...all].sort((a,b)=>b.startedAt-a.startedAt)[0];
 if(latest&&(latest.outcome===undefined||
  latest.outcome==='UNKNOWN_OUTCOME'||
  latest.outcome==='CONFIRMED'&&latest.action===next))return null;
 return {version:local.groupVersion,registration:local.reference};
}
export function forumTopicActionProof(s:BotState,p:Policy,
 actor:string,g:string,t:number,next:ForumTopicAction,now:number):string|null{
 const info=available(s,p,actor,g,t,next,now);
 if(!info)return null;
 return digest([actor,g,t,next,info,
  s.chats.filter(c=>c.id===g),
  s.grants.filter(gr=>gr.chatId===g&&gr.actor===actor),
  s.privateFeatures,s.privateSettingsRevision??0,
  s.audit.filter(a=>a.updateKey.startsWith(ROOT)||
   a.updateKey.startsWith('group:forum:topic:'))]);
}
/** Must run inside a store transaction. This irrevocably spends the attempt. */
export function startForumTopicAction(s:BotState,p:Policy,actor:string,
 g:string,t:number,next:ForumTopicAction,now:number,proof:string):
 ForumTopicControlRecord|null{
 if(typeof proof!=='string'||!/^[a-f0-9]{64}$/u.test(proof)||
  forumTopicActionProof(s,p,actor,g,t,next,now)!==proof)return null;
 const info=available(s,p,actor,g,t,next,now);
 if(!info)return null;
 const id=randomBytes(18).toString('base64url');
 if(s.audit.some(a=>a.updateKey.startsWith(ROOT+id+':')))return null;
 const body:Body={phase:'START',action:next,group:g,groupVersion:info.version,
  registration:info.registration,thread:t};
 s.audit.push({updateKey:ROOT+id+':S',actorId:actor,decision:'ALLOW',
  reason:REASON+JSON.stringify(body),policyVersion:info.version,at:now});
 return {id,group:g,thread:t,groupVersion:info.version,
  registration:info.registration,actor,action:next,startedAt:now};
}
/** Resolved on every remote preflight await, including just before POST. */
export function stillAuthorizedForumTopicAction(s:BotState,p:Policy,
 expected:ForumTopicControlRecord,now:number):boolean{
 if(!clock(now)||now<expected.startedAt||now>=expected.startedAt+120_000)
  return false;
 const topicNow=current(s,p,expected.actor,expected.group,expected.thread,now);
 const list=ledger(s,now);
 if(!topicNow||!list||topicNow.reference!==expected.registration||
  topicNow.groupVersion!==expected.groupVersion)return false;
 const active=list.filter(x=>x.id===expected.id),row=active[0];
 return active.length===1&&!!row&&row.outcome===undefined&&
  row.actor===expected.actor&&row.action===expected.action&&
  row.group===expected.group&&row.thread===expected.thread&&
  row.startedAt===expected.startedAt;
}
/** Append a terminal receipt once; unknown status is a permanent quarantine.
 * Never retry a Telegram call merely because this write fails.
 */
export function finishForumTopicAction(s:BotState,expected:ForumTopicControlRecord,
 result:ForumTopicActionOutcome,now:number):boolean{
 const records=ledger(s,now),entry=records?.filter(x=>x.id===expected.id);
 if(!outcome(result)||!entry||entry.length!==1||entry[0]!.outcome!==undefined||
  entry[0]!.group!==expected.group||
  entry[0]!.thread!==expected.thread||
  entry[0]!.actor!==expected.actor||
  entry[0]!.action!==expected.action||
  entry[0]!.groupVersion!==expected.groupVersion||
  entry[0]!.registration!==expected.registration||
  entry[0]!.startedAt!==expected.startedAt||
  now<expected.startedAt)return false;
 const payload:Body={phase:'RESULT',action:expected.action,group:expected.group,
  groupVersion:expected.groupVersion,registration:expected.registration,
  thread:expected.thread,outcome:result};
 s.audit.push({updateKey:ROOT+expected.id+':R',actorId:expected.actor,
  decision:result==='CONFIRMED'?'ALLOW':'NOOP',reason:REASON+JSON.stringify(payload),
  policyVersion:expected.groupVersion,at:now});
 return true;
}
export function forumTopicActionHistory(s:BotState,p:Policy,actor:string,
 g:string,t:number,now:number):ForumTopicControlRecord[]|null{
 const topicNow=current(s,p,actor,g,t,now),rows=ledger(s,now);
 if(!topicNow||!rows)return null;
 const relevant=rows.filter(x=>x.group===g&&x.thread===t&&
  x.groupVersion===topicNow.groupVersion);
 if(relevant.some(x=>x.registration!==topicNow.reference))return null;
 return relevant.sort((a,b)=>b.startedAt-a.startedAt).slice(0,60);
}
