import type {ProtectionAction} from './protection-rules.js';
export interface FloodPolicy{enabled:boolean;limit:number;windowMs:number;action:ProtectionAction;}
export interface FloodEvent{key:string;at:number;}
export interface FloodWindow{chatId:string;memberId:string;chatPolicyVersion:number;policyRevision:number;events:FloodEvent[];updatedAt:number;}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).length===expected.length&&expected.every(k=>Object.hasOwn(v,k));
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const update=(v:unknown):v is string=>typeof v==='string'&&/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]{1,16}$/u.test(v);
export function isValidFloodPolicy(v:unknown):v is FloodPolicy{
 return object(v)&&keys(v,['enabled','limit','windowMs','action'])&&typeof v.enabled==='boolean'&&positive(v.limit)&&v.limit<=100&&
  positive(v.windowMs)&&v.windowMs>=1000&&v.windowMs<=60000&&typeof v.action==='string'&&['REVIEW','WARN','DELETE','MUTE'].includes(v.action);
}
function validEvents(v:unknown):v is FloodEvent[]{
 if(!Array.isArray(v)||v.length>101)return false;
 const seen=new Set<string>();let previous=-1;
 return v.every(e=>{
  if(!object(e)||!keys(e,['key','at'])||!update(e.key)||!time(e.at)||e.at<previous||seen.has(e.key))return false;
  previous=e.at;seen.add(e.key);return true;
 });
}
export function isValidFloodWindow(v:unknown):v is FloodWindow{
 return object(v)&&keys(v,['chatId','memberId','chatPolicyVersion','policyRevision','events','updatedAt'])&&
  typeof v.chatId==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v.chatId)&&Number.isSafeInteger(Number(v.chatId))&&
  typeof v.memberId==='string'&&/^[1-9][0-9]{0,15}$/u.test(v.memberId)&&Number.isSafeInteger(Number(v.memberId))&&
  positive(v.chatPolicyVersion)&&positive(v.policyRevision)&&validEvents(v.events)&&v.events.length>0&&time(v.updatedAt)&&v.updatedAt===v.events.at(-1)!.at;
}
/** Sliding window, with at most limit+1 most recent events. A saturated window
 * proves a threshold crossing without pretending to count all past traffic. */
export function advanceFloodWindow(config:unknown,previous:unknown,key:unknown,now:unknown):{
 status:'INVALID'|'DISABLED'|'DUPLICATE'|'CLEAR'|'EXCEEDED';events:FloodEvent[]
}{
 if(!isValidFloodPolicy(config)||!validEvents(previous)||!update(key)||!time(now)||previous.some(e=>e.at>now))return {status:'INVALID',events:[]};
 if(!config.enabled)return {status:'DISABLED',events:[]};
 if(previous.some(e=>e.key===key))return {status:'DUPLICATE',events:structuredClone(previous)};
 const events=[...previous.filter(e=>e.at>now-config.windowMs),{key,at:now}].slice(-config.limit-1);
 return {status:events.length>config.limit?'EXCEEDED':'CLEAR',events};
}
