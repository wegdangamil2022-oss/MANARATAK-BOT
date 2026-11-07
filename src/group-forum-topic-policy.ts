import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {forumTopicGroupAccess,localForumTopics,registeredForumTopic,
 type LocalForumTopic} from './group-forum-topics.js';

/** TOPIC-001: topic-scoped educational navigation ONLY.
 * INHERIT preserves the group's already approved educational permissions;
 * PAUSED suppresses group library navigation in that specific thread.
 * Neither value grants any permission to send, moderate or manage a topic.
 */
export type ForumTopicEducationMode='INHERIT'|'PAUSED';
export interface ForumTopicEducationPolicy{
 readonly group:string;readonly groupVersion:number;readonly thread:number;
 readonly registration:string;readonly revision:number;
 readonly mode:ForumTopicEducationMode;readonly actor:string;readonly at:number;
}
const ROOT='group:forum:education:',REASON='GROUP_FORUM_EDUCATION:';
const KEY=/^group:forum:education:([A-Za-z0-9_-]{24})$/u;
const person=(x:unknown):x is string=>typeof x==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const group=(x:unknown):x is string=>typeof x==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const thread=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>0&&x<=2147483647;
const time=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=0&&x<=8640000000000000-120000;
const revision=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=1&&x<=100;
const validMode=(x:unknown):x is ForumTopicEducationMode=>
 x==='INHERIT'||x==='PAUSED';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function all(s:BotState,now:number):ForumTopicEducationPolicy[]|null{
 if(!time(now))return null;
 const source=s.audit.filter(a=>a.updateKey.startsWith(ROOT));
 if(source.length>2000)return null;
 const keys=new Set<string>(),out:ForumTopicEducationPolicy[]=[];
 for(const record of source){
  if(!KEY.test(record.updateKey)||keys.has(record.updateKey)||
   record.decision!=='ALLOW'||!person(record.actorId)||
   !time(record.at)||record.at>now||
   !Number.isSafeInteger(record.policyVersion)||record.policyVersion<1||
   !record.reason.startsWith(REASON))return null;
  keys.add(record.updateKey);
  let raw:unknown;
  try{raw=JSON.parse(record.reason.slice(REASON.length));}catch{return null;}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const x=raw as Record<string,unknown>;
  if(Object.keys(x).sort().join(',')!=='group,groupVersion,mode,registration,revision,thread'||
   !group(x.group)||!thread(x.thread)||!validMode(x.mode)||
   !revision(x.revision)||typeof x.registration!=='string'||
   !/^group:forum:topic:[A-Za-z0-9_-]{24}$/u.test(x.registration)||
   !Number.isSafeInteger(x.groupVersion)||x.groupVersion!==record.policyVersion)
   return null;
  out.push({group:x.group,groupVersion:x.groupVersion as number,
   thread:x.thread,registration:x.registration,revision:x.revision,
   mode:x.mode,actor:record.actorId,at:record.at});
 }
 const ordered=[...out].sort((a,b)=>a.group.localeCompare(b.group)||
  a.groupVersion-b.groupVersion||a.thread-b.thread||a.revision-b.revision);
 const seen=new Map<string,{revision:number;at:number}>();
 for(const item of ordered){
  const key=JSON.stringify([item.group,item.groupVersion,item.thread]);
  const before=seen.get(key);
  if(item.revision!==(before?.revision??0)+1||
   before!==undefined&&item.at<=before.at)return null;
  seen.set(key,{revision:item.revision,at:item.at});
 }
 return ordered;
}
/** Returns null on malformed local evidence, not an implicit allowance. */
export function forumTopicEducationMode(s:BotState,p:Policy,
 chat:string,topic:number,now:number):ForumTopicEducationMode|null{
 if(!group(chat)||!thread(topic)||!time(now)||!p.canUseChat(s,chat,'navigation'))
  return null;
 const registration=registeredForumTopic(s,chat,topic,now),records=all(s,now);
 if(registration===null||!records)return null;
 if(registration===undefined){
  // Maintain existing group navigation behavior for topics not registered
  // in this optional local registry. Neither case expands group rights.
  return records.some(r=>r.group===chat&&r.thread===topic)?null:'INHERIT';
 }
 const scoped=records.filter(x=>x.group===chat&&x.thread===topic&&
  x.groupVersion===registration.groupVersion);
 if(scoped.some(x=>x.registration!==registration.reference))return null;
 return scoped.at(-1)?.mode??'INHERIT';
}
export function ownerForumTopicEducationPolicy(s:BotState,p:Policy,
 actor:string,chat:string,topic:number,now:number):
 {mode:ForumTopicEducationMode;revision:number;registration:LocalForumTopic}|null{
 if(forumTopicGroupAccess(s,p,actor,chat,now)===null)return null;
 const source=localForumTopics(s,p,actor,chat,now)?.find(x=>x.threadId===topic);
 const mode=forumTopicEducationMode(s,p,chat,topic,now),records=all(s,now);
 if(!source||!records||!mode)return null;
 const previous=records.filter(x=>x.group===chat&&x.thread===topic&&
  x.groupVersion===source.groupVersion);
 if(previous.some(x=>x.registration!==source.reference))return null;
 return {mode,revision:previous.at(-1)?.revision??0,registration:source};
}
export function forumTopicEducationProof(s:BotState,p:Policy,actor:string,
 chat:string,topic:number,next:ForumTopicEducationMode,now:number):string|null{
 if(!validMode(next))return null;
 const current=ownerForumTopicEducationPolicy(s,p,actor,chat,topic,now);
 if(!current||current.mode===next||current.revision>=100)return null;
 return hash([actor,chat,topic,next,current,
  s.chats.filter(c=>c.id===chat),
  s.grants.filter(g=>g.chatId===chat&&g.actor===actor),
  s.privateFeatures,s.privateSettingsRevision??0,
  s.audit.filter(a=>a.updateKey.startsWith(ROOT))]);
}
/** Called only after private one-shot preview, and again inside transaction. */
export function setForumTopicEducationPolicy(s:BotState,p:Policy,actor:string,
 chat:string,topic:number,next:ForumTopicEducationMode,now:number,
 expected:string):boolean{
 if(typeof expected!=='string'||!/^[a-f0-9]{64}$/u.test(expected)||
  forumTopicEducationProof(s,p,actor,chat,topic,next,now)!==expected)return false;
 const state=ownerForumTopicEducationPolicy(s,p,actor,chat,topic,now);
 if(!state)return false;
 const key=ROOT+randomBytes(18).toString('base64url');
 if(s.audit.some(a=>a.updateKey===key))return false;
 s.audit.push({updateKey:key,actorId:actor,decision:'ALLOW',
  reason:REASON+JSON.stringify({group:chat,
   groupVersion:state.registration.groupVersion,thread:topic,
   registration:state.registration.reference,
   revision:state.revision+1,mode:next}),
  policyVersion:state.registration.groupVersion,at:now});
 return true;
}
export function forumTopicEducationHistory(s:BotState,p:Policy,
 actor:string,chat:string,topic:number,now:number):
 ForumTopicEducationPolicy[]|null{
 const current=ownerForumTopicEducationPolicy(s,p,actor,chat,topic,now);
 const rows=all(s,now);
 if(!current||!rows)return null;
 return rows.filter(x=>x.group===chat&&x.thread===topic&&
  x.groupVersion===current.registration.groupVersion&&
  x.registration===current.registration.reference)
  .reverse().slice(0,100);
}
