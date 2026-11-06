import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import {recordSubscriptionIdentityChange} from './subscription-change-alert.js';
type Baseline={key:string;hash:string;at:number};
const id=(v:unknown)=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
function validKey(key:unknown):key is string{
 if(typeof key!=='string'||key.length>200)return false;try{const v:unknown=JSON.parse(key);return Array.isArray(v)&&v.length===5&&id(v[0])&&id(v[1])&&v.slice(2).every(n=>Number.isSafeInteger(n)&&n>0)&&JSON.stringify(v)===key;}catch{return false;}
}
/** Accept either the historical primary-only observation or a complete
 * getChat active_usernames snapshot for the exact same numeric channel.
 * Order and case are not identity changes. Invalid/partial alias sets never
 * overwrite a valid baseline or issue alerts. */
function normalizedIdentity(observation:unknown):string|null|{username:string|null;activeUsernames:string[]}|undefined{
 const name=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9_]{4,31}$/iu.test(v);
 if(observation===null)return null;
 if(typeof observation==='string')return name(observation)?observation.toLowerCase():undefined;
 if(!observation||typeof observation!=='object'||Array.isArray(observation))return undefined;
 const value=observation as Record<string,unknown>;
 if(Object.keys(value).sort().join(',')!=='activeUsernames,username'||
    value.username!==null&&!name(value.username)||!Array.isArray(value.activeUsernames)||
    value.activeUsernames.length>100||!value.activeUsernames.every(name))return undefined;
 const username=typeof value.username==='string'?value.username.toLowerCase():null;
 const aliases=(value.activeUsernames as string[]).map(x=>x.toLowerCase());
 if(new Set(aliases).size!==aliases.length||username!==null&&aliases.length>0&&!aliases.includes(username))return undefined;
 // Exact compatibility with historical single-username observations: a bot
 // upgrade must not create a false channel-identity alert on unchanged state.
 if(aliases.length===0||aliases.length===1&&aliases[0]===username)return username;
 return {username,activeUsernames:aliases.sort()};
}
/** Store only a digest of the complete observed public username set, never
 * usernames, student details or private invite links. */

export function recordChannelIdentity(s:BotState,actor:string,group:string,channel:string,ruleVersion:number,scopeVersion:number,channelVersion:number,username:unknown,started:number,at:number):boolean{
 const normalized=normalizedIdentity(username);
 if(normalized===undefined||!Number.isSafeInteger(at)||!Number.isSafeInteger(started)||started<0||at<started||at>8640000000000000)return false;
 const key=JSON.stringify([group,channel,ruleVersion,scopeVersion,channelVersion]);if(!validKey(key))return false;
 const raw=s.subscriptionChannelIdentities;if(raw!==undefined&&(!Array.isArray(raw)||raw.length>1000))return false;
 const rows:Baseline[]=[],seen=new Set<string>();for(const value of raw as unknown[]??[]){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;const r=value as Record<string,unknown>;
  if(Object.keys(r).sort().join(',')!=='at,hash,key'||!validKey(r.key)||seen.has(r.key)||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/u.test(r.hash)||!Number.isSafeInteger(r.at)||Number(r.at)<0||Number(r.at)>at)return false;
  seen.add(r.key);if(Number(r.at)>at-30*86400000)rows.push({key:r.key,hash:r.hash,at:Number(r.at)});
 }
 const hash=createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),previous=rows.find(r=>r.key===key);
 if(previous){if(previous.at>started)return false;if(previous.hash!==hash)recordSubscriptionIdentityChange(s,actor,group,channel,ruleVersion,scopeVersion,previous.hash,hash,at);previous.hash=hash;previous.at=at;}
 else{if(rows.length>=1000)return false;rows.push({key,hash,at});}
 s.subscriptionChannelIdentities=rows;return true;
}
