import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {registeredForumTopic,forumTopicGroupAccess,
 localForumTopics} from './group-forum-topics.js';
import {normalizeProtectionText,type ProtectionMessage}
 from './protection-rules.js';

/** TOPIC-001: topic-specific CONTENT MONITORING only.
 * It supplements, and NEVER weakens, the group-wide protection engine.
 * No action here can delete, mute, ban, exempt a group rule or send a message.
 */
export type TopicMonitorMode='OFF'|'MONITOR';
export type TopicMonitorKind='WORD'|'PHRASE'|'LINK'|'FORWARD';
export interface TopicMonitorRule{readonly kind:TopicMonitorKind;readonly value:string;}
export interface TopicMonitorConfig{
 readonly group:string;readonly groupVersion:number;
 readonly thread:number;readonly registration:string;readonly revision:number;
 readonly mode:TopicMonitorMode;readonly rules:readonly TopicMonitorRule[];
 readonly actor:string;readonly at:number;
}
export type TopicMonitorChange=
 |{kind:'MODE';mode:TopicMonitorMode}
 |{kind:'ADD';rule:TopicMonitorRule}
 |{kind:'REMOVE';index:number};
const ROOT='group:forum:monitor:config:',WHY='GROUP_FORUM_TOPIC_MONITOR_CONFIG:';
const ENTRY=/^group:forum:monitor:config:[A-Za-z0-9_-]{24}$/u;
const group=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const person=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const thread=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=1&&v<=2147483647;
const version=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>0&&v<=9_999_999_999;
const revision=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=1&&v<=100;
const time=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-120_000;
const mode=(v:unknown):v is TopicMonitorMode=>v==='OFF'||v==='MONITOR';
const kind=(v:unknown):v is TopicMonitorKind=>
 v==='WORD'||v==='PHRASE'||v==='LINK'||v==='FORWARD';
const digest=(v:unknown):string=>
 createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validRule=(v:unknown):v is TopicMonitorRule=>{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const x=v as Record<string,unknown>;
 if(Object.keys(x).sort().join(',')!=='kind,value'||!kind(x.kind)||
  typeof x.value!=='string')return false;
 if(x.kind==='LINK'||x.kind==='FORWARD')return x.value==='';
 if(x.value.trim()!==x.value||
  Array.from(x.value).length<2||Array.from(x.value).length>80||
  Buffer.byteLength(x.value,'utf8')>240||
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(x.value))
  return false;
 const normalized=normalizeProtectionText(x.value);
 return normalized.length>=2&&normalized.length<=100&&
  (x.kind!=='WORD'||normalized.split(' ').length===1);
};
const validRules=(v:unknown):v is TopicMonitorRule[]=>{
 if(!Array.isArray(v)||v.length>24)return false;
 const seen=new Set<string>();
 for(const rule of v){
  if(!validRule(rule))return false;
  const key=JSON.stringify([rule.kind,normalizeProtectionText(rule.value)]);
  if(seen.has(key))return false;
  seen.add(key);
 }
 return true;
};
function all(s:BotState,now:number):TopicMonitorConfig[]|null{
 if(!time(now))return null;
 const events=s.audit.filter(x=>x.updateKey.startsWith(ROOT));
 if(events.length>2000)return null;
 const used=new Set<string>(),rows:TopicMonitorConfig[]=[];
 for(const x of events){
  if(!ENTRY.test(x.updateKey)||used.has(x.updateKey)||
   x.decision!=='ALLOW'||!person(x.actorId)||!version(x.policyVersion)||
   !time(x.at)||x.at>now||!x.reason.startsWith(WHY))return null;
  used.add(x.updateKey);
  let v:unknown;
  try{v=JSON.parse(x.reason.slice(WHY.length));}catch{return null;}
  if(!v||typeof v!=='object'||Array.isArray(v))return null;
  const data=v as Record<string,unknown>;
  if(Object.keys(data).sort().join(',')!==
    'group,groupVersion,mode,registration,revision,rules,thread'||
   !group(data.group)||!version(data.groupVersion)||
   data.groupVersion!==x.policyVersion||!thread(data.thread)||
   !mode(data.mode)||!revision(data.revision)||
   !validRules(data.rules)||typeof data.registration!=='string'||
   !/^group:forum:topic:[A-Za-z0-9_-]{24}$/u.test(data.registration))
    return null;
  rows.push({group:data.group,groupVersion:data.groupVersion,
   thread:data.thread,registration:data.registration,
   revision:data.revision,mode:data.mode,rules:data.rules,
   actor:x.actorId,at:x.at});
 }
 const ordered=[...rows].sort((a,b)=>a.group.localeCompare(b.group)||
  a.groupVersion-b.groupVersion||a.thread-b.thread||a.revision-b.revision);
 const prev=new Map<string,TopicMonitorConfig>();
 for(const item of ordered){
  const key=JSON.stringify([item.group,item.groupVersion,item.thread]);
  const old=prev.get(key);
  if(item.revision!==(old?.revision??0)+1||
   old!==undefined&&(item.at<=old.at||old.registration!==item.registration))
    return null;
  prev.set(key,item);
 }
 return ordered;
}
export function topicMonitorCurrent(s:BotState,g:string,t:number,
 now:number):{mode:TopicMonitorMode;rules:readonly TopicMonitorRule[];
 revision:number;registration:string;groupVersion:number}|null{
 const topic=registeredForumTopic(s,g,t,now),rows=all(s,now);
 if(!topic||!rows)return null;
 const found=rows.filter(x=>x.group===g&&x.thread===t&&
  x.groupVersion===topic.groupVersion);
 if(found.some(x=>x.registration!==topic.reference))return null;
 const last=found.at(-1);
 return last?{mode:last.mode,rules:last.rules,revision:last.revision,
  registration:last.registration,groupVersion:last.groupVersion}:
  {mode:'OFF',rules:[],revision:0,registration:topic.reference,
   groupVersion:topic.groupVersion};
}
export function ownerTopicMonitor(s:BotState,p:Policy,owner:string,
 g:string,t:number,now:number){
 if(forumTopicGroupAccess(s,p,owner,g,now)===null||
  !localForumTopics(s,p,owner,g,now)?.some(x=>x.threadId===t))return null;
 return topicMonitorCurrent(s,g,t,now);
}
function changeState(current:NonNullable<ReturnType<typeof topicMonitorCurrent>>,
 change:TopicMonitorChange):{mode:TopicMonitorMode;rules:TopicMonitorRule[]}|null{
 if(change.kind==='MODE'){
  if(!mode(change.mode)||current.mode===change.mode)return null;
  return {mode:change.mode,rules:[...current.rules]};
 }
 if(change.kind==='ADD'){
  if(!validRule(change.rule)||current.rules.length>=24||
   current.rules.some(x=>x.kind===change.rule.kind&&
    normalizeProtectionText(x.value)===normalizeProtectionText(change.rule.value)))
   return null;
  return {mode:current.mode,rules:[...current.rules,change.rule]};
 }
 if(change.kind==='REMOVE'){
  if(!Number.isSafeInteger(change.index)||change.index<0||
   change.index>=current.rules.length)return null;
  return {mode:current.mode,rules:current.rules.filter((_,i)=>i!==change.index)};
 }
 return null;
}
export function topicMonitorProof(s:BotState,p:Policy,owner:string,g:string,
 t:number,change:TopicMonitorChange,now:number):string|null{
 const old=ownerTopicMonitor(s,p,owner,g,t,now);
 if(!old||old.revision>=100||!changeState(old,change))return null;
 return digest([owner,g,t,old,change,s.chats.filter(x=>x.id===g),
  s.grants.filter(x=>x.chatId===g&&x.actor===owner),
  s.privateFeatures,s.privateSettingsRevision??0,
  s.audit.filter(x=>x.updateKey.startsWith(ROOT))]);
}
export function saveTopicMonitor(s:BotState,p:Policy,owner:string,g:string,
 t:number,change:TopicMonitorChange,now:number,proof:string):boolean{
 if(typeof proof!=='string'||!/^[a-f0-9]{64}$/u.test(proof)||
  topicMonitorProof(s,p,owner,g,t,change,now)!==proof)return false;
 const prev=ownerTopicMonitor(s,p,owner,g,t,now);
 if(!prev)return false;
 const next=changeState(prev,change),key=ROOT+randomBytes(18).toString('base64url');
 if(!next||s.audit.some(x=>x.updateKey===key))return false;
 s.audit.push({updateKey:key,decision:'ALLOW',actorId:owner,
  policyVersion:prev.groupVersion,at:now,
  reason:WHY+JSON.stringify({group:g,groupVersion:prev.groupVersion,
   thread:t,registration:prev.registration,revision:prev.revision+1,
   mode:next.mode,rules:next.rules})});
 return true;
}
export function topicMonitorHistory(s:BotState,p:Policy,owner:string,
 g:string,t:number,now:number):TopicMonitorConfig[]|null{
 const current=ownerTopicMonitor(s,p,owner,g,t,now),rows=all(s,now);
 if(!current||!rows)return null;
 return rows.filter(x=>x.group===g&&x.thread===t&&
  x.groupVersion===current.groupVersion&&
  x.registration===current.registration).reverse().slice(0,100);
}
/** A pure, non-enforcing evaluation. No Telegram action or sanctions.
 * Return null on damaged/invalid state; log only anonymized result labels.
 */
export function evaluateTopicMonitor(s:BotState,p:Policy,
 message:ProtectionMessage,t:number,now:number):
 {status:'OFF'|'EXEMPT'|'CLEAR'|'MATCH';ruleIds:string[];revision:number}|null{
 if(!thread(t)||!time(now)||!p.canUseChat(s,message.chatId,'moderation'))
  return null;
 const current=topicMonitorCurrent(s,message.chatId,t,now);
 if(!current)return null;
 if(current.mode==='OFF')return {status:'OFF',ruleIds:[],revision:current.revision};
 if(p.isOwner(message.memberId)||
  p.has(s,message.memberId,'chat.manage',message.chatId,now))
  return {status:'EXEMPT',ruleIds:[],revision:current.revision};
 if(typeof message.text!=='string'&&typeof message.caption!=='string'&&
  message.forwarded!==true)return {status:'CLEAR',ruleIds:[],revision:current.revision};
 const body=message.text??message.caption??'';
 if(body.length>4096)return null;
 const normalized=normalizeProtectionText(body),wrapped=' '+normalized+' ';
 const rules=current.rules.flatMap((rule,index)=>{
  const matched=rule.kind==='FORWARD'?message.forwarded===true:
   rule.kind==='LINK'?/(?:https?:\/\/|www\.|t\.me\/)/iu.test(body):
   rule.kind==='WORD'?wrapped.includes(' '+normalizeProtectionText(rule.value)+' '):
   wrapped.includes(' '+normalizeProtectionText(rule.value)+' ');
  return matched?[String(index+1)]:[];
 });
 return {status:rules.length?'MATCH':'CLEAR',ruleIds:rules,
  revision:current.revision};
}
/** Must run inside the same update-protection transaction. No raw text,
 * member identifier, URL or message is persisted in the audit entry. */
export function recordTopicMonitor(s:BotState,p:Policy,message:ProtectionMessage,
 t:number,updateKey:string,now:number):'OFF'|'CLEAR'|'MATCH'|'EXEMPT'|'UNAVAILABLE'|'DUPLICATE'{
 if(!/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]+$/u.test(updateKey)||
  !thread(t)||!time(now))return 'UNAVAILABLE';
 const key=updateKey+':forum-monitor:'+message.chatId+':'+t;
 if(s.audit.some(x=>x.updateKey===key))return 'DUPLICATE';
 const result=evaluateTopicMonitor(s,p,message,t,now);
 if(!result)return 'UNAVAILABLE';
 if(result.status==='OFF'||result.status==='EXEMPT')return result.status;
 // Bound audit growth; a stale/corrupt history is not a grant to punish.
 const count=s.audit.filter(x=>x.updateKey.includes(':forum-monitor:'));
 if(count.length>=10_000)return 'UNAVAILABLE';
 s.audit.push({updateKey:key,decision:'NOOP',policyVersion:result.revision,
  at:now,reason:result.status==='MATCH'?
   'TOPIC_MONITOR_MATCH:revision='+result.revision+
    ';rules='+result.ruleIds.join(','):
   'TOPIC_MONITOR_CLEAR:revision='+result.revision});
 return result.status;
}
