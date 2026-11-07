import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {networkAlertScope} from './network-event-alerts.js';
import {networkAlertEventSilenced} from './network-alert-silence.js';
import {networkManagerDigest,type NetworkManagerDigest} from './network-manager-digest.js';

/** NETWORK-006: opt-in one-per-local-calendar-day administrative digest.
 * Recipients are specific current managers, not a broadcast list. Fixed UTC
 * offsets are deliberate: we never infer the recipient's location/timezone.
 */
const PREFIX='network:digest:pref:',REASON='NETWORK_DAILY_DIGEST_PREF:';
const KEY=/^network:digest:pref:([A-Za-z0-9_-]{24})$/u;
const time=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&
 x>=86_400_000&&x<=8_640_000_000_000_000-86_400_000;
const actor=(x:unknown):x is string=>typeof x==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const network=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{12}$/u.test(x);
const group=(x:unknown):x is string=>typeof x==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const rev=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&
 x>=1&&x<=9_999_999_999;
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x);
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export interface NetworkDailyDigestChoice{
 enabled:boolean;minute:number;offsetMinutes:number;
}
interface Preference extends NetworkDailyDigestChoice{
 key:string;actor:string;network:string;group:string;
 authority:string;networkRevision:number;chatVersion:number;at:number;
}
export interface NetworkDailyDigestDue{
 readonly pref:Readonly<Preference>;
 readonly localDay:number;readonly digest:NetworkManagerDigest;
 readonly scheduledAt:number;
}
const disabled=():NetworkDailyDigestChoice=>({enabled:false,minute:0,offsetMinutes:0});
export const disabledNetworkDailyDigest=disabled;
export function validNetworkDailyDigestChoice(v:unknown):v is NetworkDailyDigestChoice{
 if(!object(v)||Object.keys(v).sort().join(',')!=='enabled,minute,offsetMinutes'||
  typeof v.enabled!=='boolean'||!Number.isSafeInteger(v.minute)||
  !Number.isSafeInteger(v.offsetMinutes))return false;
 if(!v.enabled)return v.minute===0&&v.offsetMinutes===0;
 return (v.minute as number)>=0&&(v.minute as number)<=1439&&
  (v.offsetMinutes as number)>=-720&&(v.offsetMinutes as number)<=840&&
  (v.offsetMinutes as number)%15===0;
}
function all(s:BotState):Preference[]|null{
 const records=s.audit.filter(a=>a.updateKey.startsWith(PREFIX));
 if(records.length>2000)return null;
 const keys=new Set<string>(),out:Preference[]=[];
 for(const a of records){
  if(!KEY.test(a.updateKey)||keys.has(a.updateKey)||
   a.decision!=='ALLOW'||!actor(a.actorId)||!time(a.at)||
   !rev(a.policyVersion)||!a.reason.startsWith(REASON))return null;
  keys.add(a.updateKey);
  let v:unknown;try{v=JSON.parse(a.reason.slice(REASON.length));}catch{return null;}
  if(!object(v)||Object.keys(v).sort().join(',')!==
   'authority,chatVersion,enabled,group,minute,network,networkRevision,offsetMinutes'||
   !hex(v.authority)||!rev(v.chatVersion)||!group(v.group)||!network(v.network)||
   !rev(v.networkRevision)||a.policyVersion!==v.chatVersion||
   !validNetworkDailyDigestChoice({
    enabled:v.enabled,minute:v.minute,offsetMinutes:v.offsetMinutes
   }))return null;
  out.push({key:a.updateKey,actor:a.actorId,network:v.network,
   group:v.group,networkRevision:v.networkRevision as number,
   chatVersion:v.chatVersion as number,authority:v.authority,at:a.at,
   enabled:v.enabled as boolean,minute:v.minute as number,
   offsetMinutes:v.offsetMinutes as number});
 }
 return out;
}
function relevant(rows:Preference[],actorId:string,net:string,chatId:string){
 return rows.filter(x=>x.actor===actorId&&x.network===net&&x.group===chatId)
  .sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key));
}
function latest(rows:Preference[]):Preference|null|undefined{
 if(rows.length>1&&rows[0]!.at===rows[1]!.at)return null;
 return rows[0];
}
function authorized(s:BotState,p:Policy,x:Preference,now:number):boolean{
 const scope=networkAlertScope(s,p,x.actor,x.network,x.group,now);
 return !!scope&&scope.networkRevision===x.networkRevision&&
  scope.chatVersion===x.chatVersion&&scope.authority===x.authority&&
  p.privateFeature(s,'owner.dashboard',p.ownerId);
}
export function networkDailyDigestCurrent(s:BotState,p:Policy,who:string,
 net:string,chatId:string,now:number):NetworkDailyDigestChoice|null{
 if(!time(now)||!actor(who)||!network(net)||!group(chatId))return null;
 const scope=networkAlertScope(s,p,who,net,chatId,now),rows=all(s);
 if(!scope||!rows)return null;
 const matches=relevant(rows,who,net,chatId),row=latest(matches);
 if(row===null||row&&row.at>now)return null;
 if(!row||!authorized(s,p,row,now))return disabled();
 return {enabled:row.enabled,minute:row.minute,offsetMinutes:row.offsetMinutes};
}
export function networkDailyDigestProof(s:BotState,p:Policy,who:string,
 net:string,chatId:string,now:number):string|null{
 if(!time(now)||!actor(who)||!network(net)||!group(chatId))return null;
 const scope=networkAlertScope(s,p,who,net,chatId,now),rows=all(s);
 if(!scope||!rows||rows.length>=2000)return null;
 const record=latest(relevant(rows,who,net,chatId));
 if(record===null||record&&record.at>now)return null;
 return digest([who,net,chatId,scope,record??null]);
}
/** A private, explicit manager confirmation must precede every preference. */
export function setNetworkDailyDigest(s:BotState,p:Policy,who:string,
 net:string,chatId:string,choice:NetworkDailyDigestChoice,now:number):boolean{
 if(!validNetworkDailyDigestChoice(choice)||!time(now))return false;
 const proof=networkDailyDigestProof(s,p,who,net,chatId,now),
  current=networkDailyDigestCurrent(s,p,who,net,chatId,now),
  scope=networkAlertScope(s,p,who,net,chatId,now),rows=all(s);
 if(!proof||!current||!scope||!rows||rows.length>=2000||
  JSON.stringify(current)===JSON.stringify(choice))return false;
 const last=latest(relevant(rows,who,net,chatId));
 if(last===null||last&&now<=last.at)return false;
 const key=PREFIX+randomBytes(18).toString('base64url');
 if(rows.some(x=>x.key===key))return false;
 s.audit.push({actorId:who,updateKey:key,decision:'ALLOW',
  reason:REASON+JSON.stringify({
   network:net,group:chatId,networkRevision:scope.networkRevision,
   chatVersion:scope.chatVersion,authority:scope.authority,...choice
  }),policyVersion:scope.chatVersion,at:now});
 return true;
}
/** Return only currently scheduled, unmuted messages due in the first
 * 10 minutes of their opted-in LOCAL day. No backlog or delayed catchup.
 * This is a read-only snapshot; a separate durable dispatcher claims sends.
 */
export function dueNetworkDailyDigests(s:BotState,p:Policy,now:number):
 NetworkDailyDigestDue[]|null{
 if(!time(now))return null;
 const rows=all(s);
 if(!rows)return null;
 const current=new Map<string,Preference>();
 const ordered=[...rows].sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key));
 const seen=new Set<string>();
 for(const pref of ordered){
  const id=[pref.actor,pref.network,pref.group].join(':');
  if(seen.has(id))continue;
  const colliding=ordered.filter(x=>x.actor===pref.actor&&x.network===pref.network&&
   x.group===pref.group&&x.at===pref.at);
  if(colliding.length!==1)return null;
  seen.add(id);
  if(pref.enabled&&pref.at<=now&&authorized(s,p,pref,now))current.set(id,pref);
 }
 const results:NetworkDailyDigestDue[]=[];
 for(const pref of current.values()){
  const localNow=now+pref.offsetMinutes*60_000,
   day=Math.floor(localNow/86_400_000),
   scheduledAt=day*86_400_000+pref.minute*60_000-pref.offsetMinutes*60_000;
  if(scheduledAt>now||now>=scheduledAt+600_000||pref.at>=scheduledAt)continue;
  const scope=networkAlertScope(s,p,pref.actor,pref.network,pref.group,now);
  if(!scope||networkAlertEventSilenced(s,p,pref.actor,pref.network,pref.group,now,now))continue;
  const summary=networkManagerDigest(s,p,pref.actor,pref.network,pref.group,now,24);
  if(!summary)continue;
  results.push({pref,localDay:day,digest:summary,scheduledAt});
 }
 return results.sort((a,b)=>a.pref.actor.localeCompare(b.pref.actor)||
  a.pref.network.localeCompare(b.pref.network)||a.pref.group.localeCompare(b.pref.group));
}
export function dailyDigestReceiptKey(item:NetworkDailyDigestDue):string{
 return 'network:digest:send:'+digest([item.pref.key,item.localDay]);
}
