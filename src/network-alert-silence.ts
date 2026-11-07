import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {networkAlertScope} from './network-event-alerts.js';
import {networkDailyQuietSuppress} from './network-alert-daily-quiet.js';

/** NETWORK-006: personal, temporary silence. No stored member identities or message bodies.
 * Silence changes never grant event subscriptions or moderation permissions. */
const PREFIX='network:event:silence:';
const KEY=/^network:event:silence:([A-Za-z0-9_-]{24})$/u;
const REASON='NETWORK_EVENT_SILENCE:';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-28_800_000;
const rev=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=9_999_999_999;
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const actorId=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const chatId=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const networkId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
interface Silence {
 key:string;actor:string;network:string;chat:string;at:number;until:number;
 authority:string;networkRevision:number;chatVersion:number;
}
/** Every matching receipt must be well-formed and unique. Broken evidence fails closed. */
function read(s:BotState):Silence[]|null{
 const entries=s.audit.filter(x=>x.updateKey.startsWith(PREFIX));
 if(entries.length>2000)return null;
 const keys=new Set<string>(),result:Silence[]=[];
 for(const a of entries){
  if(!KEY.test(a.updateKey)||keys.has(a.updateKey)||!actorId(a.actorId)||
   a.decision!=='ALLOW'||!time(a.at)||!rev(a.policyVersion)||
   !a.reason.startsWith(REASON))return null;
  keys.add(a.updateKey);
  let value:unknown;
  try{value=JSON.parse(a.reason.slice(REASON.length));}catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='authority,chat,chatVersion,network,networkRevision,until'||
   !networkId(v.network)||!chatId(v.chat)||!rev(v.chatVersion)||
   !rev(v.networkRevision)||!hex(v.authority)||
   (v.until!==0&&(!time(v.until)||v.until<=a.at||v.until>a.at+28_800_000))||
   a.policyVersion!==v.chatVersion)return null;
  result.push({key:a.updateKey,actor:a.actorId,network:v.network,
   chat:v.chat,chatVersion:v.chatVersion,networkRevision:v.networkRevision,
   authority:v.authority,at:a.at,until:v.until as number});
 }
 return result;
}
function inScope(rows:Silence[],actor:string,network:string,chat:string){
 return rows.filter(x=>x.actor===actor&&x.network===network&&x.chat===chat)
  .sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key));
}
/** Returns null for an unauthorized scope or corrupted/ambiguous audit; 0 means no active silence. */
export function networkAlertSilenceUntil(s:BotState,p:Policy,actor:string,network:string,
 chat:string,now:number):number|null{
 const scope=networkAlertScope(s,p,actor,network,chat,now),all=read(s);
 if(!scope||!all)return null;
 const rows=inScope(all,actor,network,chat),last=rows[0];
 if(rows.length>1&&last?.at===rows[1]?.at)return null;
 if(!last||last.authority!==scope.authority||last.chatVersion!==scope.chatVersion||
  last.networkRevision!==scope.networkRevision)return 0;
 return last.until>now?last.until:0;
}
export function networkAlertSilenceProof(s:BotState,p:Policy,actor:string,network:string,
 chat:string,now:number):string|null{
 const scope=networkAlertScope(s,p,actor,network,chat,now),all=read(s);
 if(!scope||!all)return null;
 const rows=inScope(all,actor,network,chat);
 if(rows.length>1&&rows[0]!.at===rows[1]!.at)return null;
 return hash([actor,network,chat,scope,rows[0]??null]);
}
/** Only a confirmed self-service callback may call this inside a store transaction.
 * duration: 1h / 8h / 0 to cancel. A cancelled window does not deliver old events. */
export function setNetworkAlertSilence(s:BotState,p:Policy,actor:string,network:string,
 chat:string,hours:0|1|8,now:number):boolean{
 if(![0,1,8].includes(hours)||!time(now))return false;
 const scope=networkAlertScope(s,p,actor,network,chat,now),all=read(s);
 if(!scope||!all||all.length>=2000)return false;
 const rows=inScope(all,actor,network,chat),last=rows[0];
 if(last&&now<=last.at||rows.length>1&&last?.at===rows[1]?.at)return false;
 if(hours===0&&networkAlertSilenceUntil(s,p,actor,network,chat,now)===0)return false;
 const until=hours===0?0:now+hours*3_600_000;
 s.audit.push({updateKey:PREFIX+randomBytes(18).toString('base64url'),actorId:actor,
  decision:'ALLOW',reason:REASON+JSON.stringify({
   network,networkRevision:scope.networkRevision,chat,chatVersion:scope.chatVersion,
   authority:scope.authority,until}),policyVersion:scope.chatVersion,at:now});
 return true;
}
/** Suppress active silence AND any event created inside a historical silence window,
 * even if the worker starts just after expiration or a manual cancellation. */
export function networkAlertEventSilenced(s:BotState,p:Policy,actor:string,network:string,
 chat:string,now:number,eventAt:number):boolean{
 const scope=networkAlertScope(s,p,actor,network,chat,now),all=read(s);
 if(!scope||!all||!time(eventAt)||eventAt>now)return true;
 const rows=inScope(all,actor,network,chat);
 if(rows.length>1&&rows[0]!.at===rows[1]!.at)return true;
 const current=rows[0];
 if(current&&current.authority===scope.authority&&
  current.chatVersion===scope.chatVersion&&current.networkRevision===scope.networkRevision&&
  current.until>now)return true;
 const before=rows.find(x=>x.at<=eventAt);
 // Independently review recurring daily quiet hours, both at event creation
 // and at dispatch. Invalid receipts must suppress sends, never permit them.
 if(networkDailyQuietSuppress(s,actor,network,chat,now,eventAt,scope))return true;
 if(!before)return false;
 // Stale authority never enables a silent window to grant anything.
 if(before.authority!==scope.authority||before.chatVersion!==scope.chatVersion||
  before.networkRevision!==scope.networkRevision)return true;
 return before.until>eventAt;
}
