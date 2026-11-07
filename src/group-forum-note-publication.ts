import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {forumTopicNote,forumTopicGroupAccess,registeredForumTopic,
 registeredForumTopicNote,type LocalForumTopicNote} from './group-forum-topics.js';
import {forumTopicEducationMode} from './group-forum-topic-policy.js';

/** TOPIC-004 — approved topic-note publication with an independent grant.
 * Local editorial notes are NEVER public merely because they exist.
 * No automatic Telegram send, forwarding, or general-topic fallback.
 */
export type ForumTopicNotePublicationAction='PUBLISH'|'WITHDRAW';
export interface ForumTopicNotePublicationReceipt{
 readonly group:string;readonly groupVersion:number;readonly thread:number;
 readonly registration:string;readonly eventRevision:number;
 readonly noteRevision:number;readonly noteDigest:string;
 readonly action:ForumTopicNotePublicationAction;readonly actor:string;
 readonly at:number;
}
export interface ForumTopicNotePublicationState{
 readonly published:boolean;readonly note:LocalForumTopicNote;
 readonly eventRevision:number;readonly publishedAt:number|null;
}
const ROOT='group:forum:publication:',REASON='GROUP_FORUM_NOTE_PUBLICATION:';
const KEY=/^group:forum:publication:[A-Za-z0-9_-]{24}$/u;
const registration=/^group:forum:topic:[A-Za-z0-9_-]{24}$/u;
const isGroup=(x:unknown):x is string=>typeof x==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const isPerson=(x:unknown):x is string=>typeof x==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const isThread=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>0&&x<=2147483647;
const isVersion=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=1&&x<=9_999_999_999;
const isRevision=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=1&&x<=100;
const isTime=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=0&&x<=8640000000000000-120000;
const isDigest=(x:unknown):x is string=>typeof x==='string'&&
 /^[a-f0-9]{64}$/u.test(x);
const sha=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const noteDigest=(note:LocalForumTopicNote)=>sha([note.group,note.groupVersion,
 note.thread,note.registration,note.revision,note.text,note.at]);
const action=(x:unknown):x is ForumTopicNotePublicationAction=>
 x==='PUBLISH'||x==='WITHDRAW';

function receipts(s:BotState,now:number):ForumTopicNotePublicationReceipt[]|null{
 if(!isTime(now))return null;
 const rows=s.audit.filter(a=>a.updateKey.startsWith(ROOT));
 if(rows.length>2_000)return null;
 const seen=new Set<string>(),all:ForumTopicNotePublicationReceipt[]=[];
 for(const row of rows){
  if(!KEY.test(row.updateKey)||seen.has(row.updateKey)||
   row.decision!=='ALLOW'||!isPerson(row.actorId)||
   !isVersion(row.policyVersion)||!isTime(row.at)||row.at>now||
   !row.reason.startsWith(REASON))return null;
  seen.add(row.updateKey);
  let payload:unknown;
  try{payload=JSON.parse(row.reason.slice(REASON.length));}
  catch{return null;}
  if(payload===null||typeof payload!=='object'||Array.isArray(payload))
   return null;
  const v=payload as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='action,eventRevision,group,groupVersion,noteDigest,noteRevision,registration,thread'||
   !isGroup(v.group)||!isVersion(v.groupVersion)||!isThread(v.thread)||
   !registration.test(String(v.registration))||!isRevision(v.eventRevision)||
   !isVersion(v.noteRevision)||v.noteRevision>60||
   !isDigest(v.noteDigest)||!action(v.action)||
   v.groupVersion!==row.policyVersion)return null;
  all.push({group:v.group,groupVersion:v.groupVersion,thread:v.thread,
   registration:v.registration as string,eventRevision:v.eventRevision,
   noteRevision:v.noteRevision,noteDigest:v.noteDigest,action:v.action,
   actor:row.actorId,at:row.at});
 }
 const byTopic=new Map<string,ForumTopicNotePublicationReceipt[]>();
 for(const record of all){
  const key=JSON.stringify([record.group,record.groupVersion,record.thread]);
  const list=byTopic.get(key)??[];list.push(record);byTopic.set(key,list);
 }
 for(const list of byTopic.values()){
  list.sort((a,b)=>a.eventRevision-b.eventRevision);
  let old:ForumTopicNotePublicationReceipt|undefined;
  for(const next of list){
   if(next.eventRevision!==(old?.eventRevision??0)+1||
    old!==undefined&&(next.at<=old.at||
     next.registration!==old.registration||
     next.action==='WITHDRAW'&&old.action!=='PUBLISH'))
    return null;
   old=next;
  }
 }
 return all;
}
function localState(s:BotState,p:Policy,g:string,t:number,
 now:number):ForumTopicNotePublicationState|null{
 if(!isGroup(g)||!isThread(t)||!isTime(now)||
  !p.canUseChat(s,g,'navigation')||!p.canUseChat(s,g,'moderation')||
  forumTopicEducationMode(s,p,g,t,now)===null)return null;
 const topic=registeredForumTopic(s,g,t,now);
 const note=registeredForumTopicNote(s,g,t,now);
 const rows=receipts(s,now);
 if(!topic||!note||!rows)return null;
 const related=rows.filter(x=>x.group===g&&x.thread===t&&
  x.groupVersion===topic.groupVersion);
 if(related.some(x=>x.registration!==topic.reference))return null;
 related.sort((a,b)=>a.eventRevision-b.eventRevision);
 const current=related.at(-1);
 const published=!!current&&current.action==='PUBLISH'&&
  current.noteRevision===note.revision&&current.noteDigest===noteDigest(note);
 return {published,note,eventRevision:current?.eventRevision??0,
  publishedAt:published?current!.at:null};
}
/** Owner-only state, with current group authorization. */
export function ownerForumNotePublication(s:BotState,p:Policy,actor:string,
 g:string,t:number,now:number):ForumTopicNotePublicationState|null{
 if(forumTopicGroupAccess(s,p,actor,g,now)===null)return null;
 const note=forumTopicNote(s,p,actor,g,t,now);
 const state=localState(s,p,g,t,now);
 return !note||!state||state.note.revision!==note.revision?null:state;
}
/** null = invalid/unverified; undefined = hidden/not approved.
 * Only an exact approval for the latest local note revision is readable.
 */
export function publishedForumTopicNote(s:BotState,p:Policy,g:string,t:number,
 now:number):LocalForumTopicNote|null|undefined{
 if(forumTopicEducationMode(s,p,g,t,now)!=='INHERIT')return null;
 // A correctly registered topic may not yet have an editorial note.
 // Distinguish that from corrupt note/publication evidence so a request
 // can receive a harmless "no approved note" response in its own thread.
 const note=registeredForumTopicNote(s,g,t,now);
 if(note===undefined){
  const current=registeredForumTopic(s,g,t,now),ledger=receipts(s,now);
  if(!current||!ledger||ledger.some(x=>x.group===g&&x.thread===t&&
   x.groupVersion===current.groupVersion))return null;
  return undefined;
 }
 if(note===null)return null;
 const state=localState(s,p,g,t,now);
 if(!state)return null;
 return state.published?state.note:undefined;
}
export function forumNotePublicationProof(s:BotState,p:Policy,actor:string,
 g:string,t:number,next:ForumTopicNotePublicationAction,
 now:number):string|null{
 if(!action(next))return null;
 const state=ownerForumNotePublication(s,p,actor,g,t,now);
 if(!state||state.eventRevision>=100||
  (next==='PUBLISH'?state.published:!state.published)||
  (next==='PUBLISH'&&forumTopicEducationMode(s,p,g,t,now)!=='INHERIT'))
  return null;
 return sha([actor,g,t,next,state,
  s.chats.filter(x=>x.id===g),s.grants.filter(x=>x.chatId===g&&x.actor===actor),
  s.privateFeatures,s.privateSettingsRevision??0,
  s.audit.filter(a=>a.updateKey.startsWith(ROOT)||
   a.updateKey.startsWith('group:forum:note:')||
   a.updateKey.startsWith('group:forum:education:'))]);
}
export function changeForumNotePublication(s:BotState,p:Policy,actor:string,
 g:string,t:number,next:ForumTopicNotePublicationAction,now:number,
 proof:string):boolean{
 if(!isDigest(proof)||
  forumNotePublicationProof(s,p,actor,g,t,next,now)!==proof)return false;
 const state=ownerForumNotePublication(s,p,actor,g,t,now);
 const topic=registeredForumTopic(s,g,t,now);
 if(!state||!topic)return false;
 const key=ROOT+randomBytes(18).toString('base64url');
 if(s.audit.some(x=>x.updateKey===key))return false;
 s.audit.push({updateKey:key,actorId:actor,decision:'ALLOW',
  reason:REASON+JSON.stringify({group:g,groupVersion:topic.groupVersion,
   thread:t,registration:topic.reference,eventRevision:state.eventRevision+1,
   noteRevision:state.note.revision,noteDigest:noteDigest(state.note),
   action:next}),policyVersion:topic.groupVersion,at:now});
 return true;
}
export function forumNotePublicationHistory(s:BotState,p:Policy,actor:string,
 g:string,t:number,now:number):ForumTopicNotePublicationReceipt[]|null{
 const state=ownerForumNotePublication(s,p,actor,g,t,now);
 const rows=receipts(s,now);
 if(!state||!rows)return null;
 const topic=registeredForumTopic(s,g,t,now);
 if(!topic)return null;
 const history=rows.filter(x=>x.group===g&&x.thread===t&&
  x.groupVersion===topic.groupVersion);
 if(history.some(x=>x.registration!==topic.reference))return null;
 return history.sort((a,b)=>b.eventRevision-a.eventRevision);
}
