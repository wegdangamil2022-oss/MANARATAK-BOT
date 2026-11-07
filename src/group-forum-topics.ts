import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';

/** TOPIC-001/004: owner-approved LOCAL forum topic registry. A Telegram
 * thread ID has not been remotely verified. None of these records permit
 * sending messages, running sanctions, or changing topic permissions.
 */
const PREFIX='group:forum:topic:',REASON='GROUP_FORUM_TOPIC_REGISTERED:';
const KEY=/^group:forum:topic:([A-Za-z0-9_-]{24})$/u;
const chat=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const person=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const thread=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>0&&v<=2_147_483_647;
const version=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=1&&v<=9_999_999_999;
const clock=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-120_000;
export const validForumTopicTitle=(value:unknown):value is string=>
 typeof value==='string'&&value===value.trim()&&
 Array.from(value).length>=2&&Array.from(value).length<=48&&
 Buffer.byteLength(value,'utf8')<=128&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);

export interface LocalForumTopic{
 readonly chatId:string;readonly groupVersion:number;
 readonly threadId:number;readonly title:string;readonly registeredAt:number;
 readonly registeredBy:string;readonly reference:string;
}
function all(s:BotState,now:number):LocalForumTopic[]|null{
 const rows=s.audit.filter(a=>a.updateKey.startsWith(PREFIX));
 if(!clock(now)||rows.length>1000)return null;
 const keys=new Set<string>(),topics=new Set<string>(),out:LocalForumTopic[]=[];
 for(const a of rows){
  if(!KEY.test(a.updateKey)||keys.has(a.updateKey)||
   a.decision!=='ALLOW'||!person(a.actorId)||
   !version(a.policyVersion)||!clock(a.at)||a.at>now||
   !a.reason.startsWith(REASON))return null;
  keys.add(a.updateKey);
  let parsed:unknown;
  try{parsed=JSON.parse(a.reason.slice(REASON.length));}catch{return null;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
  const x=parsed as Record<string,unknown>;
  if(Object.keys(x).sort().join(',')!=='chat,groupVersion,thread,title'||
   !chat(x.chat)||!version(x.groupVersion)||!thread(x.thread)||
   !validForumTopicTitle(x.title)||x.groupVersion!==a.policyVersion)
   return null;
  const key=JSON.stringify([x.chat,x.groupVersion,x.thread]);
  if(topics.has(key))return null;
  topics.add(key);
  out.push({chatId:x.chat,groupVersion:x.groupVersion,threadId:x.thread,
   title:x.title,registeredAt:a.at,registeredBy:a.actorId,
   reference:a.updateKey});
 }
 return out;
}
/** Registered topic lookup that never implies Telegram-side rights.
 * Public command gates need no owner dashboard capability but do require
 * the group's current unique approval revision.
 * null = untrustworthy registry or group, undefined = unregistered thread.
 */
export function registeredForumTopic(s:BotState,groupId:string,topicId:number,
 now:number):LocalForumTopic|null|undefined{
 if(!chat(groupId)||!thread(topicId)||!clock(now))return null;
 const chats=s.chats.filter(c=>c.id===groupId),c=chats[0];
 if(chats.length!==1||!c||!c.approved||!c.present||!version(c.version))
  return null;
 const records=all(s,now);
 if(!records)return null;
 return records.find(r=>r.chatId===groupId&&r.groupVersion===c.version&&
  r.threadId===topicId);
}

export function forumTopicGroupAccess(s:BotState,p:Policy,actor:string,
 groupId:string,now:number):number|null{
 if(!clock(now)||!person(actor)||!p.isOwner(actor)||
  !p.privateFeature(s,'owner.dashboard',actor)||!chat(groupId))return null;
 const matching=s.chats.filter(c=>c.id===groupId),group=matching[0];
 if(matching.length!==1||!group||!group.approved||!group.present||
  !version(group.version)||!group.scopes.includes('moderation')||
  !p.canUseChat(s,groupId,'moderation')||
  !p.has(s,actor,'chat.manage',groupId,now))return null;
 return group.version;
}
export function localForumTopics(s:BotState,p:Policy,actor:string,
 groupId:string,now:number):LocalForumTopic[]|null{
 const current=forumTopicGroupAccess(s,p,actor,groupId,now);
 const rows=all(s,now);
 if(current===null||!rows)return null;
 return rows.filter(x=>x.chatId===groupId&&x.groupVersion===current)
  .sort((a,b)=>a.threadId-b.threadId);
}
function digest(value:unknown):string{
 return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function forumTopicRegistrationProof(s:BotState,p:Policy,
 actor:string,groupId:string,topicId:number,title:string,now:number):string|null{
 const v=forumTopicGroupAccess(s,p,actor,groupId,now);
 const rows=all(s,now);
 if(v===null||!rows||rows.length>=1000||
  !thread(topicId)||!validForumTopicTitle(title)||
  rows.some(x=>x.chatId===groupId&&x.groupVersion===v&&x.threadId===topicId)||
  rows.filter(x=>x.chatId===groupId&&x.groupVersion===v).length>=64)return null;
 return digest([actor,groupId,topicId,title,v,
  s.chats.filter(c=>c.id===groupId),
  s.grants.filter(g=>g.chatId===groupId&&g.actor===actor),
  s.privateFeatures,s.privateSettingsRevision??0,
  s.audit.filter(a=>a.updateKey.startsWith(PREFIX))]);
}
/** An outer owner-private, expiring one-shot callback must guard this call.
 * The service performs a second read under the store transaction itself.
 */
export function registerLocalForumTopic(s:BotState,p:Policy,
 actor:string,groupId:string,topicId:number,title:string,now:number,
 expected:string):boolean{
 if(!/^[a-f0-9]{64}$/u.test(expected)||
  forumTopicRegistrationProof(s,p,actor,groupId,topicId,title,now)!==expected)
  return false;
 const current=forumTopicGroupAccess(s,p,actor,groupId,now);
 if(current===null)return false;
 const reference=PREFIX+randomBytes(18).toString('base64url');
 if(s.audit.some(a=>a.updateKey===reference))return false;
 s.audit.push({updateKey:reference,actorId:actor,decision:'ALLOW',
  reason:REASON+JSON.stringify({chat:groupId,groupVersion:current,
   thread:topicId,title}),policyVersion:current,at:now});
 return true;
}

/** TOPIC-004: optional owner-reviewed local notes for a registered topic.
 * Notes are NOT published, are never inserted into an automatic reply, and
 * must never be sent to a general thread if a real topic is unavailable.
 */
const NOTE='group:forum:note:',NOTE_REASON='GROUP_FORUM_TOPIC_NOTE:';
const NOTE_KEY=/^group:forum:note:([A-Za-z0-9_-]{24})$/u;
export interface LocalForumTopicNote{
 readonly group:string;readonly groupVersion:number;
 readonly thread:number;readonly registration:string;readonly revision:number;
 readonly text:string;readonly at:number;
}
export const validForumTopicNote=(value:unknown):value is string=>
 typeof value==='string'&&value===value.trim()&&
 Array.from(value).length>=8&&Array.from(value).length<=400&&
 Buffer.byteLength(value,'utf8')<=1200&&
 !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function notes(s:BotState,now:number):LocalForumTopicNote[]|null{
 if(!clock(now))return null;
 const rows=s.audit.filter(a=>a.updateKey.startsWith(NOTE));
 if(rows.length>2000)return null;
 const seen=new Set<string>(),items:LocalForumTopicNote[]=[];
 for(const a of rows){
  if(!NOTE_KEY.test(a.updateKey)||seen.has(a.updateKey)||
   a.decision!=='ALLOW'||!person(a.actorId)||
   !version(a.policyVersion)||!clock(a.at)||a.at>now||
   !a.reason.startsWith(NOTE_REASON))return null;
  seen.add(a.updateKey);
  let value:unknown;
  try{value=JSON.parse(a.reason.slice(NOTE_REASON.length));}catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='group,groupVersion,registration,revision,text,thread'||
   !chat(v.group)||!thread(v.thread)||!version(v.groupVersion)||
   !version(v.revision)||Number(v.revision)>60||
   !validForumTopicNote(v.text)||typeof v.registration!=='string'||
   !KEY.test(v.registration)||a.policyVersion!==v.groupVersion)return null;
  items.push({group:v.group,groupVersion:v.groupVersion,
   thread:v.thread,registration:v.registration,
   revision:v.revision,text:v.text,at:a.at});
 }
 const ordered=[...items].sort((a,b)=>
  a.group.localeCompare(b.group)||a.groupVersion-b.groupVersion||
  a.thread-b.thread||a.revision-b.revision);
 const state=new Map<string,{rev:number;at:number}>();
 for(const item of ordered){
  const key=JSON.stringify([item.group,item.groupVersion,item.thread]);
  const prev=state.get(key);
  if(item.revision!==(prev?.rev??0)+1||
   (prev!==undefined&&item.at<=prev.at))return null;
  state.set(key,{rev:item.revision,at:item.at});
 }
 return ordered;
}
export function forumTopicNote(s:BotState,p:Policy,actor:string,g:string,
 t:number,now:number):LocalForumTopicNote|null|undefined{
 const registry=localForumTopics(s,p,actor,g,now);
 const allNotes=notes(s,now);
 if(!registry||!allNotes||!thread(t))return null;
 const topic=registry.find(x=>x.threadId===t);
 if(!topic)return null;
 const matching=allNotes.filter(x=>x.group===g&&
  x.groupVersion===topic.groupVersion&&x.thread===t);
 if(matching.some(x=>x.registration!==topic.reference))return null;
 return matching.at(-1);
}
/** TOPIC-004: non-owner accessor for a note tied to the CURRENT local
 * registered thread. This is not publication authorization: a separately
 * approved publication witness is required before students can see it.
 * null means invalid state; undefined means no note exists.
 */
export function registeredForumTopicNote(s:BotState,g:string,t:number,
 now:number):LocalForumTopicNote|null|undefined{
 const registration=registeredForumTopic(s,g,t,now);
 const list=notes(s,now);
 if(!registration||!list)return null;
 const scoped=list.filter(x=>x.group===g&&x.thread===t&&
  x.groupVersion===registration.groupVersion);
 if(scoped.some(x=>x.registration!==registration.reference))return null;
 return scoped.at(-1);
}

/** Owner-only, bounded editorial history. Current chat permission and
 * exact registration witness are checked again for every read. */
export function localForumTopicNoteHistory(s:BotState,p:Policy,actor:string,
 g:string,t:number,now:number):LocalForumTopicNote[]|null{
 const topics=localForumTopics(s,p,actor,g,now);
 const topic=topics?.find(x=>x.threadId===t),allNotes=notes(s,now);
 if(!topic||!allNotes)return null;
 const records=allNotes.filter(x=>x.group===g&&
  x.groupVersion===topic.groupVersion&&x.thread===t);
 if(records.some(x=>x.registration!==topic.reference))return null;
 return [...records].sort((a,b)=>b.revision-a.revision).slice(0,60);
}
export function forumTopicNoteProof(s:BotState,p:Policy,actor:string,
 g:string,t:number,note:string,now:number):string|null{
 if(!validForumTopicNote(note))return null;
 const rows=localForumTopics(s,p,actor,g,now),topic=rows?.find(x=>x.threadId===t);
 const current=forumTopicNote(s,p,actor,g,t,now);
 if(!topic||current===null||current?.revision===60)return null;
 return digest([actor,g,t,note,topic,current??null,
  s.chats.filter(c=>c.id===g),
  s.grants.filter(gr=>gr.chatId===g&&gr.actor===actor),
  s.privateFeatures,s.privateSettingsRevision??0,
  s.audit.filter(a=>a.updateKey.startsWith(NOTE))]);
}
export function saveLocalForumTopicNote(s:BotState,p:Policy,actor:string,
 g:string,t:number,note:string,now:number,proof:string):boolean{
 if(!/^[a-f0-9]{64}$/u.test(proof)||
  forumTopicNoteProof(s,p,actor,g,t,note,now)!==proof)return false;
 const topic=localForumTopics(s,p,actor,g,now)?.find(x=>x.threadId===t);
 const previous=forumTopicNote(s,p,actor,g,t,now);
 if(!topic||previous===null||previous&&previous.at>=now)return false;
 const key=NOTE+randomBytes(18).toString('base64url');
 if(s.audit.some(a=>a.updateKey===key))return false;
 s.audit.push({updateKey:key,actorId:actor,decision:'ALLOW',
  reason:NOTE_REASON+JSON.stringify({group:g,groupVersion:topic.groupVersion,
   thread:t,registration:topic.reference,revision:(previous?.revision??0)+1,
   text:note}),policyVersion:topic.groupVersion,at:now});
 return true;
}
