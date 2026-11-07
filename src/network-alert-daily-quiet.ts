import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';

/** NETWORK-006: self-service recurring daily private-notification quiet hours.
 * Fixed UTC offset (not a named DST-aware time zone). Recipients are scoped
 * by their current independent networkAlertScope; the records themselves
 * never grant authorization or permit Telegram sends.
 */
export interface NetworkDailyQuietChoice{
 enabled:boolean;startMinute:number;endMinute:number;offsetMinutes:number;
}
export interface NetworkDailyQuietScope{
 networkRevision:number;chatVersion:number;authority:string;
}
interface Entry extends NetworkDailyQuietChoice{
 key:string;actor:string;network:string;chat:string;
 networkRevision:number;chatVersion:number;authority:string;at:number;
}
const PREFIX='network:event:dailyquiet:',REASON='NETWORK_EVENT_DAILY_QUIET:';
const KEY=/^network:event:dailyquiet:([A-Za-z0-9_-]{24})$/u;
const actor=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const chat=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const network=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&
 v>=0&&v<=8_640_000_000_000_000-86_400_000;
const revision=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&
 v>0&&v<=9_999_999_999;
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const validNetworkDailyQuietChoice=(c:unknown):c is NetworkDailyQuietChoice=>{
 if(!plain(c)||Object.keys(c).sort().join(',')!=='enabled,endMinute,offsetMinutes,startMinute'||
  typeof c.enabled!=='boolean'||!Number.isInteger(c.startMinute)||!Number.isInteger(c.endMinute)||
  !Number.isInteger(c.offsetMinutes)||!Number.isSafeInteger(c.startMinute)||
  !Number.isSafeInteger(c.endMinute)||!Number.isSafeInteger(c.offsetMinutes))return false;
 if(!c.enabled)return c.startMinute===0&&c.endMinute===0&&c.offsetMinutes===0;
 return (c.startMinute as number)>=0&&(c.startMinute as number)<1440&&
  (c.endMinute as number)>=0&&(c.endMinute as number)<1440&&
  c.startMinute!==c.endMinute&&(c.offsetMinutes as number)>=-720&&
  (c.offsetMinutes as number)<=840&&(c.offsetMinutes as number)%15===0;
};
const disabled:NetworkDailyQuietChoice={enabled:false,startMinute:0,endMinute:0,offsetMinutes:0};
export const disabledNetworkDailyQuiet=():NetworkDailyQuietChoice=>({...disabled});
const authorityValid=(s:NetworkDailyQuietScope):boolean=>revision(s.networkRevision)&&
 revision(s.chatVersion)&&digest(s.authority);
function recordList(s:BotState):Entry[]|null{
 const records=s.audit.filter(r=>r.updateKey.startsWith(PREFIX));
 if(records.length>2000)return null;
 const keys=new Set<string>(),result:Entry[]=[];
 for(const r of records){
  if(!KEY.test(r.updateKey)||keys.has(r.updateKey)||r.decision!=='ALLOW'||
   !actor(r.actorId)||!time(r.at)||!revision(r.policyVersion)||
   !r.reason.startsWith(REASON))return null;
  keys.add(r.updateKey);
  let payload:unknown;
  try{payload=JSON.parse(r.reason.slice(REASON.length));}catch{return null;}
  if(!plain(payload)||Object.keys(payload).sort().join(',')!==
   'authority,chat,chatVersion,enabled,endMinute,network,networkRevision,offsetMinutes,startMinute'||
   !network(payload.network)||!chat(payload.chat)||!revision(payload.chatVersion)||
   !revision(payload.networkRevision)||!digest(payload.authority)||
   r.policyVersion!==payload.chatVersion||
   !validNetworkDailyQuietChoice({
    enabled:payload.enabled,startMinute:payload.startMinute,
    endMinute:payload.endMinute,offsetMinutes:payload.offsetMinutes
   }))return null;
  result.push({key:r.updateKey,actor:r.actorId,network:payload.network,
   chat:payload.chat,networkRevision:payload.networkRevision as number,
   chatVersion:payload.chatVersion as number,authority:payload.authority,
   at:r.at,enabled:payload.enabled as boolean,
   startMinute:payload.startMinute as number,
   endMinute:payload.endMinute as number,offsetMinutes:payload.offsetMinutes as number});
 }
 return result;
}
function relevant(records:Entry[],who:string,net:string,group:string){
 return records.filter(x=>x.actor===who&&x.network===net&&x.chat===group)
  .sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key));
}
function match(r:Entry,scope:NetworkDailyQuietScope):boolean{
 return r.networkRevision===scope.networkRevision&&
  r.chatVersion===scope.chatVersion&&r.authority===scope.authority;
}
function latest(rows:Entry[]):Entry|null|undefined{
 if(rows.length>1&&rows[0]!.at===rows[1]!.at)return null;
 return rows[0];
}
/** null means corrupt/ambiguous evidence; disabled means no recurring mute. */
export function networkDailyQuietCurrent(s:BotState,who:string,net:string,group:string,
 now:number,scope:NetworkDailyQuietScope):NetworkDailyQuietChoice|null{
 if(!time(now)||!actor(who)||!network(net)||!chat(group)||!authorityValid(scope))return null;
 const records=recordList(s);
 if(!records)return null;
 const matches=relevant(records,who,net,group),entry=latest(matches);
 if(entry===null)return null;
 if(!entry||entry.at>now||!match(entry,scope))return disabledNetworkDailyQuiet();
 return {enabled:entry.enabled,startMinute:entry.startMinute,
  endMinute:entry.endMinute,offsetMinutes:entry.offsetMinutes};
}
export function networkDailyQuietProof(s:BotState,who:string,net:string,group:string,
 now:number,scope:NetworkDailyQuietScope):string|null{
 if(!time(now)||!actor(who)||!network(net)||!chat(group)||!authorityValid(scope))return null;
 const records=recordList(s);
 if(!records||records.length>=2000)return null;
 const matches=relevant(records,who,net,group),entry=latest(matches);
 if(entry===null||entry&&entry.at>now)return null;
 return sha([who,net,group,scope,entry??null]);
}
/** Transaction-only, called after consuming an explicit private confirmation. */
export function setNetworkDailyQuiet(s:BotState,who:string,net:string,group:string,
 choice:NetworkDailyQuietChoice,now:number,scope:NetworkDailyQuietScope):boolean{
 if(!validNetworkDailyQuietChoice(choice)||!authorityValid(scope)||!time(now)||
  !actor(who)||!network(net)||!chat(group))return false;
 const proof=networkDailyQuietProof(s,who,net,group,now,scope);
 if(!proof)return false;
 const current=networkDailyQuietCurrent(s,who,net,group,now,scope);
 if(!current||JSON.stringify(choice)===JSON.stringify(current))return false;
 const records=recordList(s);
 if(!records||records.length>=2000)return false;
 const last=latest(relevant(records,who,net,group));
 if(last===null||last&&now<=last.at)return false;
 const key=PREFIX+randomBytes(18).toString('base64url');
 if(records.some(x=>x.key===key))return false;
 s.audit.push({updateKey:key,actorId:who,decision:'ALLOW',
  reason:REASON+JSON.stringify({
   network:net,networkRevision:scope.networkRevision,
   chat:group,chatVersion:scope.chatVersion,authority:scope.authority,
   ...choice
  }),policyVersion:scope.chatVersion,at:now});
 return true;
}
export function networkDailyQuietInWindow(choice:NetworkDailyQuietChoice,at:number):boolean{
 if(!choice.enabled||!validNetworkDailyQuietChoice(choice)||!time(at))return false;
 const minute=((Math.floor(at/60000)+choice.offsetMinutes)%1440+1440)%1440;
 return choice.startMinute<choice.endMinute?
  minute>=choice.startMinute&&minute<choice.endMinute:
  minute>=choice.startMinute||minute<choice.endMinute;
}
/** Suppress at observation time AND creation time. Historical daily mutes
 * remain effective even after a user cancels the schedule, so a queued event
 * generated during quiet hours can never be delivered retroactively.
 * Invalid or future-dated receipts fail closed.
 */
export function networkDailyQuietSuppress(s:BotState,who:string,net:string,group:string,
 now:number,eventAt:number,scope:NetworkDailyQuietScope):boolean{
 if(!time(now)||!time(eventAt)||eventAt>now||!authorityValid(scope))return true;
 const records=recordList(s);
 if(!records)return true;
 const relevantRows=relevant(records,who,net,group);
 if(relevantRows.length>1&&relevantRows[0]!.at===relevantRows[1]!.at)return true;
 const active=latest(relevantRows);
 if(active===null||active&&active.at>now)return true;
 const current=active&&match(active,scope)?active:disabled;
 const historic=latest(relevantRows.filter(r=>r.at<=eventAt));
 if(historic===null)return true;
 const past=historic&&match(historic,scope)?historic:disabled;
 return networkDailyQuietInWindow(current,now)||networkDailyQuietInWindow(past,eventAt);
}
