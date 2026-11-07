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
