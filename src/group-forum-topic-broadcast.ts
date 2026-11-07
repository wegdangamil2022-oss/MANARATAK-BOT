import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {forumTopicGroupAccess,localForumTopics} from './group-forum-topics.js';
import {forumTopicEducationMode} from './group-forum-topic-policy.js';
import {visibleEducationCategory} from './education-category-policy.js';

/** TOPIC-002: one educational resource to one explicitly selected Forum
 * thread. At-most-once audit receipt: a START without an outcome is unknown.
 * No general-thread fallback, no group fan-out, no automatic retries.
 */
export type ForumBroadcastOutcome='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
export interface ForumBroadcastStart{
 readonly id:string;readonly group:string;readonly thread:number;
 readonly resource:string;readonly resourceDigest:string;readonly body:string;
 readonly registration:string;readonly groupVersion:number;
 readonly actor:string;readonly startedAt:number;
 readonly outcome?:ForumBroadcastOutcome;readonly finishedAt?:number;
}
const ROOT='group:forum:broadcast:',REASON='GROUP_FORUM_BROADCAST:';
const KEY=/^group:forum:broadcast:([A-Za-z0-9_-]{24}):([SR])$/u;
const RID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const REG=/^group:forum:topic:[A-Za-z0-9_-]{24}$/u;
const actor=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const group=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const thread=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>1&&v<=2147483647;
const version=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=1&&v<=9_999_999_999;
const validTime=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-120_000;
const outcome=(v:unknown):v is ForumBroadcastOutcome=>
 v==='CONFIRMED'||v==='FAILED_CONFIRMED'||v==='UNKNOWN_OUTCOME';
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clean=(v:unknown,limit:number):v is string=>
 typeof v==='string'&&v===v.trim()&&Array.from(v).length>=4&&
 Array.from(v).length<=limit&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
type Body={phase:'START'|'RESULT';group:string;thread:number;
 groupVersion:number;registration:string;resource:string;
 resourceDigest:string;outcome?:ForumBroadcastOutcome};
function parse(raw:string):Body|null{
 if(!raw.startsWith(REASON))return null;
 let v:unknown;
 try{v=JSON.parse(raw.slice(REASON.length));}catch{return null;}
 if(!v||typeof v!=='object'||Array.isArray(v))return null;
 const x=v as Record<string,unknown>,keys=Object.keys(x).sort().join(',');
 if(!((x.phase==='START'&&keys==='group,groupVersion,phase,registration,resource,resourceDigest,thread')||
       (x.phase==='RESULT'&&keys==='group,groupVersion,outcome,phase,registration,resource,resourceDigest,thread'))||
  !group(x.group)||!thread(x.thread)||!version(x.groupVersion)||
  !REG.test(String(x.registration))||!RID.test(String(x.resource))||
  typeof x.resourceDigest!=='string'||!/^[a-f0-9]{64}$/u.test(x.resourceDigest)||
  (x.phase==='RESULT'&&!outcome(x.outcome)))return null;
 return x as unknown as Body;
}
export function forumBroadcastHistory(s:BotState,p:Policy,
 owner:string,g:string,t:number,now:number):ForumBroadcastStart[]|null{
 if(forumTopicGroupAccess(s,p,owner,g,now)===null||!thread(t)||!validTime(now))
  return null;
 const registration=localForumTopics(s,p,owner,g,now)?.find(x=>x.threadId===t);
 if(!registration)return null;
 const relevant=s.audit.filter(a=>a.updateKey.startsWith(ROOT));
 if(relevant.length>2000)return null;
 const start=new Map<string,ForumBroadcastStart>(),
  end=new Map<string,{record:Body;at:number;who:string}>(),
  seen=new Set<string>();
 for(const a of relevant){
  const m=KEY.exec(a.updateKey),v=parse(a.reason);
  if(!m||!v||seen.has(a.updateKey)||a.policyVersion!==v.groupVersion||
   !actor(a.actorId)||!validTime(a.at)||a.at>now)return null;
  seen.add(a.updateKey);
  if(m[2]==='S'){
   if(v.phase!=='START'||a.decision!=='ALLOW'||start.has(m[1]!))return null;
   start.set(m[1]!,{id:m[1]!,group:v.group,thread:v.thread,
    groupVersion:v.groupVersion,registration:v.registration,
    resource:v.resource,resourceDigest:v.resourceDigest,
    body:'',actor:a.actorId,startedAt:a.at});
  }else{
   if(v.phase!=='RESULT'||a.decision!==
    (v.outcome==='CONFIRMED'?'ALLOW':'NOOP')||end.has(m[1]!))
    return null;
   end.set(m[1]!,{record:v,at:a.at,who:a.actorId});
  }
 }
 for(const [id,result] of end){
  const old=start.get(id),v=result.record;
  if(!old||result.who!==old.actor||result.at<old.startedAt||
   v.group!==old.group||v.thread!==old.thread||
   v.groupVersion!==old.groupVersion||v.registration!==old.registration||
   v.resource!==old.resource||v.resourceDigest!==old.resourceDigest)
   return null;
  start.set(id,{...old,outcome:v.outcome,finishedAt:result.at});
 }
 const history=[...start.values()];
 const grouped=new Map<string,ForumBroadcastStart[]>();
 for(const a of history){
  const k=JSON.stringify([a.group,a.groupVersion,a.thread]);
  const list=grouped.get(k)??[];list.push(a);grouped.set(k,list);
 }
 for(const list of grouped.values()){
  if(list.length>60)return null;
  list.sort((a,b)=>a.startedAt-b.startedAt||a.id.localeCompare(b.id));
  for(let i=1;i<list.length;i++){
   const older=list[i-1]!,next=list[i]!;
   if(older.outcome===undefined||older.outcome==='UNKNOWN_OUTCOME'||
    older.finishedAt===undefined||next.startedAt<=older.startedAt||
    next.startedAt<older.finishedAt||next.registration!==older.registration)
    return null;
  }
 }
 const scoped=history.filter(x=>x.group===g&&x.thread===t&&
  x.groupVersion===registration.groupVersion);
 if(scoped.some(x=>x.registration!==registration.reference))return null;
 return scoped.sort((a,b)=>b.startedAt-a.startedAt);
}
function prepared(s:BotState,p:Policy,owner:string,g:string,t:number,
 resourceId:string,now:number):Omit<ForumBroadcastStart,'id'|'actor'|'startedAt'>|null{
 if(!validTime(now)||!thread(t)||!RID.test(resourceId))return null;
 const v=forumTopicGroupAccess(s,p,owner,g,now);
 const reg=localForumTopics(s,p,owner,g,now)?.find(x=>x.threadId===t);
 if(v===null||!reg||reg.groupVersion!==v||
  !p.canUseChat(s,g,'navigation')||
  forumTopicEducationMode(s,p,g,t,now)!=='INHERIT')return null;
 const resources=s.educationResources.filter(x=>x.id===resourceId),r=resources[0];
 if(resources.length!==1||!r||r.scope!==g||r.status!=='PUBLISHED'||
  !clean(r.title,160)||!clean(r.publicationText,1700)||
  typeof r.publicationTextReviewedBy!=='string'||
  !actor(r.publicationTextReviewedBy))return null;
 const categories=s.educationCategories.filter(c=>c.id===r.categoryId),category=categories[0];
 if(categories.length!==1||!category||category.scope!==g||
  !visibleEducationCategory(s,category,t))return null;
 const body='📚 '+r.title+'\n\n'+r.publicationText+
  '\n\n— منارتك | محتوى تعليمي مُراجع';
 if(Buffer.byteLength(body,'utf8')>2600||
  Buffer.byteLength(body.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').
   replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;'),
   'utf8')>3000)return null;
 return {group:g,thread:t,groupVersion:v,registration:reg.reference,
  resource:resourceId,resourceDigest:sha([r,category,reg]),
  body};
}
export function forumBroadcastProof(s:BotState,p:Policy,owner:string,
 g:string,t:number,resourceId:string,now:number):string|null{
 const source=prepared(s,p,owner,g,t,resourceId,now);
 const ledger=forumBroadcastHistory(s,p,owner,g,t,now);
 if(!source||!ledger||ledger.length>=60||
  ledger.some(x=>x.outcome===undefined||x.outcome==='UNKNOWN_OUTCOME')||
  ledger.some(x=>x.resource===resourceId&&
   x.resourceDigest===source.resourceDigest&&x.outcome==='CONFIRMED'))
  return null;
 return sha([owner,source,
  s.chats.filter(c=>c.id===g),
  s.grants.filter(x=>x.chatId===g&&x.actor===owner),
  s.privateFeatures,s.privateSettingsRevision??0,
  s.audit.filter(a=>a.updateKey.startsWith(ROOT)||
   a.updateKey.startsWith('group:forum:topic:')||
   a.updateKey.startsWith('group:forum:education:')),
  s.educationCategories.filter(c=>c.scope===g),
  s.educationResources.filter(r=>r.scope===g)]);
}
export function prepareForumBroadcastSource(s:BotState,p:Policy,owner:string,
 g:string,t:number,resourceId:string,now:number):
 {body:string;digest:string;resource:string}|null{
 const source=prepared(s,p,owner,g,t,resourceId,now),
  proof=forumBroadcastProof(s,p,owner,g,t,resourceId,now);
 return source&&proof?{body:source.body,digest:proof,resource:resourceId}:null;
}
/** Transaction-only: logs an irrevocably consumed attempt before POST. */
export function startForumBroadcast(s:BotState,p:Policy,owner:string,g:string,
 t:number,resourceId:string,now:number,proof:string):
 ForumBroadcastStart|null{
 if(typeof proof!=='string'||!/^[a-f0-9]{64}$/u.test(proof)||
  forumBroadcastProof(s,p,owner,g,t,resourceId,now)!==proof)return null;
 const source=prepared(s,p,owner,g,t,resourceId,now);
 if(!source)return null;
 const id=randomBytes(18).toString('base64url');
 if(s.audit.some(a=>a.updateKey.startsWith(ROOT+id+':')))return null;
 const payload:Body={phase:'START',group:g,thread:t,
  groupVersion:source.groupVersion,registration:source.registration,
  resource:resourceId,resourceDigest:source.resourceDigest};
 s.audit.push({updateKey:ROOT+id+':S',actorId:owner,decision:'ALLOW',
  reason:REASON+JSON.stringify(payload),policyVersion:source.groupVersion,at:now});
 return {id,actor:owner,startedAt:now,...source};
}
export function stillAuthorizedForumBroadcast(s:BotState,p:Policy,
 row:ForumBroadcastStart,now:number):boolean{
 if(!validTime(now)||now<row.startedAt||now>=row.startedAt+120000)return false;
 const current=prepared(s,p,row.actor,row.group,row.thread,row.resource,now);
 const all=forumBroadcastHistory(s,p,row.actor,row.group,row.thread,now);
 const receipt=all?.filter(x=>x.id===row.id);
 return !!current&&current.resourceDigest===row.resourceDigest&&
  current.body===row.body&&current.registration===row.registration&&
  current.groupVersion===row.groupVersion&&receipt?.length===1&&
  receipt[0]!.outcome===undefined&&receipt[0]!.actor===row.actor&&
  receipt[0]!.startedAt===row.startedAt;
}
export function finishForumBroadcast(s:BotState,p:Policy,row:ForumBroadcastStart,
 result:ForumBroadcastOutcome,now:number):boolean{
 if(!outcome(result)||!validTime(now)||now<row.startedAt)return false;
 // A group can be unlinked WHILE the API is in flight: still persist
 // the terminal result without relying on CURRENT group permissions.
 const start=s.audit.filter(a=>a.updateKey===ROOT+row.id+':S');
 const prior=s.audit.filter(a=>a.updateKey===ROOT+row.id+':R');
 if(start.length!==1||prior.length!==0)return false;
 const payload=parse(start[0]!.reason);
 if(!payload||payload.phase!=='START'||payload.group!==row.group||
  payload.thread!==row.thread||payload.groupVersion!==row.groupVersion||
  payload.registration!==row.registration||payload.resource!==row.resource||
  payload.resourceDigest!==row.resourceDigest||
  start[0]!.actorId!==row.actor||start[0]!.at!==row.startedAt)
  return false;
 const final:Body={...payload,phase:'RESULT',outcome:result};
 s.audit.push({updateKey:ROOT+row.id+':R',actorId:row.actor,
  decision:result==='CONFIRMED'?'ALLOW':'NOOP',
  reason:REASON+JSON.stringify(final),policyVersion:row.groupVersion,at:now});
 return true;
}
