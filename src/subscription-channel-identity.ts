import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import {recordSubscriptionIdentityChange} from './subscription-change-alert.js';
type Baseline={key:string;hash:string;at:number};
const id=(v:unknown)=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
function validKey(key:unknown):key is string{
 if(typeof key!=='string'||key.length>200)return false;try{const v:unknown=JSON.parse(key);return Array.isArray(v)&&v.length===5&&id(v[0])&&id(v[1])&&v.slice(2).every(n=>Number.isSafeInteger(n)&&n>0)&&JSON.stringify(v)===key;}catch{return false;}
}
/** Store only a digest of the observed public username, never an invite URL. */
export function recordChannelIdentity(s:BotState,actor:string,group:string,channel:string,ruleVersion:number,scopeVersion:number,channelVersion:number,username:unknown,started:number,at:number):boolean{
 if(username!==null&&(typeof username!=='string'||/^[a-z][a-z0-9_]{4,31}$/u.exec(username)?.[0]!==username)||!Number.isSafeInteger(at)||!Number.isSafeInteger(started)||started<0||at<started||at>8640000000000000)return false;
 const key=JSON.stringify([group,channel,ruleVersion,scopeVersion,channelVersion]);if(!validKey(key))return false;
 const raw=s.subscriptionChannelIdentities;if(raw!==undefined&&(!Array.isArray(raw)||raw.length>1000))return false;
 const rows:Baseline[]=[],seen=new Set<string>();for(const value of raw as unknown[]??[]){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;const r=value as Record<string,unknown>;
  if(Object.keys(r).sort().join(',')!=='at,hash,key'||!validKey(r.key)||seen.has(r.key)||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/u.test(r.hash)||!Number.isSafeInteger(r.at)||Number(r.at)<0||Number(r.at)>at)return false;
  seen.add(r.key);if(Number(r.at)>at-30*86400000)rows.push({key:r.key,hash:r.hash,at:Number(r.at)});
 }
 const hash=createHash('sha256').update(JSON.stringify(username)).digest('hex'),previous=rows.find(r=>r.key===key);
 if(previous){if(previous.at>started)return false;if(previous.hash!==hash)recordSubscriptionIdentityChange(s,actor,group,channel,ruleVersion,scopeVersion,previous.hash,hash,at);previous.hash=hash;previous.at=at;}
 else{if(rows.length>=1000)return false;rows.push({key,hash,at});}
 s.subscriptionChannelIdentities=rows;return true;
}
