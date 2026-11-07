import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {forumTopicActionHistory} from './group-forum-topic-control.js';
import {forumBroadcastHistory} from './group-forum-topic-broadcast.js';
import {forumTopicGroupAccess,localForumTopics} from './group-forum-topics.js';

/** For human triage ONLY: no replay and no withdrawal of the quarantine.
 * Even an acknowledgement cannot turn UNKNOWN into CONFIRMED.
 */
export type ForumUnresolvedKind='CONTROL'|'BROADCAST';
export type ForumUnresolvedDisposition='ACKNOWLEDGED_UNRESOLVED'|'ESCALATED';
export interface ForumUnresolvedReview{
 readonly group:string;readonly thread:number;readonly groupVersion:number;
 readonly registration:string;readonly kind:ForumUnresolvedKind;
 readonly attempt:string;readonly decision:ForumUnresolvedDisposition;
 readonly actor:string;readonly at:number;
}
const ROOT='group:forum:review:',REASON='GROUP_FORUM_UNRESOLVED_REVIEW:';
const ENTRY=/^group:forum:review:[A-Za-z0-9_-]{24}$/u;
const ATTEMPT=/^[A-Za-z0-9_-]{24}$/u,REG=/^group:forum:topic:[A-Za-z0-9_-]{24}$/u;
const person=(x:unknown):x is string=>typeof x==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const group=(x:unknown):x is string=>typeof x==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const thread=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>1&&x<=2147483647;
const revision=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=1&&x<=9_999_999_999;
const time=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=0&&x<=8640000000000000-120000;
const kind=(x:unknown):x is ForumUnresolvedKind=>
 x==='CONTROL'||x==='BROADCAST';
const decision=(x:unknown):x is ForumUnresolvedDisposition=>
 x==='ACKNOWLEDGED_UNRESOLVED'||x==='ESCALATED';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

function ledger(s:BotState,now:number):ForumUnresolvedReview[]|null{
 if(!time(now))return null;
 const rows=s.audit.filter(x=>x.updateKey.startsWith(ROOT));
 if(rows.length>1000)return null;
 const keys=new Set<string>(),attempts=new Map<string,ForumUnresolvedReview>();
 const out:ForumUnresolvedReview[]=[];
 for(const record of rows){
  if(!ENTRY.test(record.updateKey)||keys.has(record.updateKey)||
   record.decision!=='NOOP'||!person(record.actorId)||
   !revision(record.policyVersion)||!time(record.at)||
   record.at>now||!record.reason.startsWith(REASON))return null;
  keys.add(record.updateKey);
  let parsed:unknown;
  try{parsed=JSON.parse(record.reason.slice(REASON.length));}
  catch{return null;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
  const v=parsed as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!==
   'attempt,decision,group,groupVersion,kind,registration,thread'||
   !group(v.group)||!thread(v.thread)||!revision(v.groupVersion)||
   v.groupVersion!==record.policyVersion||
   typeof v.registration!=='string'||!REG.test(v.registration)||
   typeof v.attempt!=='string'||!ATTEMPT.test(v.attempt)||
   !kind(v.kind)||!decision(v.decision))return null;
  const key=JSON.stringify([v.group,v.groupVersion,v.thread,v.kind,v.attempt]);
  const before=attempts.get(key);
  if(before&&(before.decision!=='ACKNOWLEDGED_UNRESOLVED'||
   v.decision!=='ESCALATED'||record.at<=before.at||
   before.registration!==v.registration))return null;
  const review:ForumUnresolvedReview={group:v.group,thread:v.thread,
   groupVersion:v.groupVersion,registration:v.registration,
   kind:v.kind,attempt:v.attempt,decision:v.decision,
   actor:record.actorId,at:record.at};
  attempts.set(key,review);
  out.push(review);
 }
 return out;
}
function target(s:BotState,p:Policy,actor:string,g:string,t:number,
 k:ForumUnresolvedKind,attempt:string,now:number){
 if(!kind(k)||!thread(t)||typeof attempt!=='string'||
  !ATTEMPT.test(attempt)||forumTopicGroupAccess(s,p,actor,g,now)===null)
  return null;
 const history=k==='CONTROL'?
  forumTopicActionHistory(s,p,actor,g,t,now):
  forumBroadcastHistory(s,p,actor,g,t,now);
 if(!history)return null;
 const entries=history.filter(x=>x.id===attempt),item=entries[0];
 return entries.length===1&&item&&
  (item.outcome===undefined||item.outcome==='UNKNOWN_OUTCOME')?
  item:null;
}
export function forumUnresolvedReviewHistory(s:BotState,p:Policy,actor:string,
 g:string,t:number,now:number):ForumUnresolvedReview[]|null{
 if(forumTopicGroupAccess(s,p,actor,g,now)===null||
  !thread(t)||!time(now))return null;
 const current=localForumTopics(s,p,actor,g,now)?.find(x=>x.threadId===t);
 const rows=ledger(s,now);
 if(!current||!rows)return null;
 const scoped=rows.filter(x=>x.group===g&&x.thread===t&&
  x.groupVersion===current.groupVersion);
 if(scoped.some(x=>x.registration!==current.reference))return null;
 return scoped.filter(x=>x.registration===current.reference).
  sort((a,b)=>b.at-a.at);
}
export function forumUnresolvedReviewProof(s:BotState,p:Policy,actor:string,
 g:string,t:number,k:ForumUnresolvedKind,attempt:string,
 what:ForumUnresolvedDisposition,now:number):string|null{
 if(!decision(what))return null;
 const item=target(s,p,actor,g,t,k,attempt,now),
  reviews=forumUnresolvedReviewHistory(s,p,actor,g,t,now);
 const previous=reviews?.filter(r=>r.kind===k&&r.attempt===attempt)??[];
 if(!item||!reviews||previous.some(r=>r.decision==='ESCALATED')||
  what==='ACKNOWLEDGED_UNRESOLVED'&&previous.length>0||
  what==='ESCALATED'&&previous.length>0&&
   (previous.length!==1||previous[0]!.decision!=='ACKNOWLEDGED_UNRESOLVED'||
    previous[0]!.at>=now))return null;
 return digest([actor,g,t,k,attempt,what,item,reviews,
  s.chats.filter(x=>x.id===g),
  s.grants.filter(x=>x.chatId===g&&x.actor===actor),
  s.privateFeatures,s.privateSettingsRevision??0,
  s.audit.filter(x=>x.updateKey.startsWith('group:forum:control:')||
   x.updateKey.startsWith('group:forum:broadcast:')||
   x.updateKey.startsWith(ROOT))]);
}
export function acknowledgeUnresolvedForumAttempt(s:BotState,p:Policy,
 actor:string,g:string,t:number,k:ForumUnresolvedKind,attempt:string,
 what:ForumUnresolvedDisposition,now:number,proof:string):boolean{
 if(typeof proof!=='string'||!/^[a-f0-9]{64}$/u.test(proof)||
  forumUnresolvedReviewProof(s,p,actor,g,t,k,attempt,what,now)!==proof)
  return false;
 const item=target(s,p,actor,g,t,k,attempt,now);
 if(!item)return false;
 const key=ROOT+randomBytes(18).toString('base64url');
 if(s.audit.some(x=>x.updateKey===key))return false;
 s.audit.push({updateKey:key,actorId:actor,decision:'NOOP',
  policyVersion:item.groupVersion,at:now,
  reason:REASON+JSON.stringify({group:g,thread:t,
   groupVersion:item.groupVersion,registration:item.registration,
   kind:k,attempt,decision:what})});
 return true;
}
