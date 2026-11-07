import {createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';
import {TelegramAdminRoomNoticeSender} from './admin-room-notices.js';
import {adminRoomNotificationTarget} from './admin-room-links.js';
import {validNetworkEmergencyControls,networkEmergencyStopped}
 from './network-emergency-stop.js';
import {currentNetworkRoomRelays,type NetworkRoomRelayPreference}
 from './network-room-relay.js';
import {networkAdministrativeEvents,type NetworkAdministrativeEvent}
 from './network-administrative-events.js';

/** NETWORK-006: review-only network events -> separately approved private
 * NOTIFICATIONS room, with OWNER opt-in. No ban, mute or group mutation.
 * At-most-once attempted delivery, including ambiguous Telegram outcomes.
 */
const SEND='network:room:send:',RECEIPT=/^network:room:send:[a-f0-9]{64}$/u;
const clock=(v:number)=>Number.isSafeInteger(v)&&v>=0&&
 v<=8_640_000_000_000_000-120_000;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Kind='WATCH_CASE'|'SANCTION_REVIEW';
interface Candidate{
 key:string;pref:NetworkRoomRelayPreference;
 eventId:string;eventAt:number;eventLabel:string;kind:Kind;
 room:string;started:number;
}
const reason=(c:Omit<Candidate,'key'|'started'>)=>'NETWORK_ROOM_RELAY_STARTED:'+
 hash([c.pref.key,c.eventId,c.eventAt,c.eventLabel,c.kind,c.room]);

/** The send namespace is an append-only, at-most-once audit ledger.
 * A malformed, duplicated or orphaned receipt must never relax throttling or
 * make a previously reserved Telegram event look fresh again.
 */
function relaySendLedger(s:BotState,now:number):{recent:BotState['audit']}|null{
 const rows=s.audit.filter(a=>a.updateKey.startsWith(SEND));
 if(rows.length>4000)return null;
 const seen=new Set<string>();
 const starts=new Map<string,(typeof rows)[number]>();
 const outcomes=new Map<string,(typeof rows)[number]>();
 for(const row of rows){
  const outcome=row.updateKey.endsWith(':outcome');
  const base=outcome?row.updateKey.slice(0,-8):row.updateKey;
  if(!RECEIPT.test(base)||seen.has(row.updateKey)||
   !Number.isSafeInteger(row.at)||row.at<0||row.at>now||
   !Number.isSafeInteger(row.policyVersion)||row.policyVersion<1||
   !/^[1-9][0-9]{0,15}$/u.test(row.actorId)||
   !Number.isSafeInteger(Number(row.actorId)))return null;
  seen.add(row.updateKey);
  if(outcome){
   if(row.decision!=='NOOP'||!/^NETWORK_ROOM_RELAY_(?:CONFIRMED|FAILED_CONFIRMED|UNKNOWN_OUTCOME|NOT_SENT)$/u.test(row.reason))return null;
   outcomes.set(base,row);
  }else{
   if(row.decision!=='ALLOW'||!/^NETWORK_ROOM_RELAY_STARTED:[a-f0-9]{64}$/u.test(row.reason))return null;
   starts.set(base,row);
  }
 }
 for(const [base,row] of outcomes){
  const start=starts.get(base);
  if(!start||start.actorId!==row.actorId||
   start.policyVersion!==row.policyVersion||row.at<start.at)return null;
 }
 return {recent:[...starts.values()].filter(a=>a.at>now-60_000)};
}

function eligible(s:BotState,p:Policy,pref:NetworkRoomRelayPreference,
 now:number,eventId?:string,eventAt?:number):{
 event:NetworkAdministrativeEvent;room:string
}|null{
 if(!clock(now)||!p.privateFeature(s,'owner.dashboard',p.ownerId)||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  networkEmergencyStopped(s,pref.network))return null;
 const enabled=currentNetworkRoomRelays(s,p,now);
 if(!enabled||!enabled.some(x=>x.key===pref.key&&
  x.actor===pref.actor&&x.network===pref.network&&x.group===pref.group&&
  x.authority===pref.authority&&x.room===pref.room&&x.linkId===pref.linkId))
  return null;
 const target=adminRoomNotificationTarget(s,p,pref.group,now);
 if(!target||target.id!==pref.linkId||target.room!==pref.room||
  target.setting!==pref.setting)return null;
 const events=networkAdministrativeEvents(s,p,p.ownerId,now,pref.network,
  {chatId:pref.group});
 if(!events)return null;
 // Present only the freshest CURRENT human-review state, not a ledger of
 // long-closed allegations or an assumption that an action occurred.
 const relevant=events.filter(x=>
  (x.kind==='WATCH_CASE'||x.kind==='SANCTION_REVIEW')&&
  x.at>pref.at&&x.at<=now&&now-x.at<120_000&&
  (eventId===undefined||x.id===eventId)&&
  (eventAt===undefined||x.at===eventAt));
 const next=relevant.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))[0];
 return next?{event:next,room:target.room}:null;
}
function intact(s:BotState,p:Policy,job:Candidate,now:number):boolean{
 if(!clock(now)||now<job.started||now-job.started>=120_000||
  now-job.eventAt>=120_000)return false;
 const keys=s.audit.filter(a=>a.updateKey===job.key),row=keys[0];
 if(keys.length!==1||!row||row.actorId!==job.pref.actor||
  row.decision!=='ALLOW'||row.policyVersion!==job.pref.groupVersion||
  row.at!==job.started||row.reason!==reason(job)||
  s.audit.some(a=>a.updateKey===job.key+':outcome'))return false;
 const current=eligible(s,p,job.pref,now,job.eventId,job.eventAt);
 return !!current&&current.room===job.room&&current.event.label===job.eventLabel&&
  current.event.kind===job.kind;
}
export class NetworkRoomRelayDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:TelegramBotApiModerationGateway,
  private readonly sender:TelegramAdminRoomNoticeSender,
  private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 private async safe():Promise<boolean>{
  try{return await this.safety()===true;}catch{return false;}
 }
 async drain(limit=3):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>8)
   throw Error('NETWORK_ROOM_RELAY_LIMIT_INVALID');
  let attempted=0;
  for(let i=0;i<limit;i++){
   if(!await this.safe())break;
   const job=await this.store.transaction(s=>{
    const now=this.clock();
    if(!clock(now)||!validNetworkEmergencyControls(s.networkEmergencyControls??[]))return null;
    const prefs=currentNetworkRoomRelays(s,this.policy,now);
    if(!prefs)return null;
    const ledger=relaySendLedger(s,now);
    if(!ledger)return null;
    const recent=ledger.recent;
    if(recent.length>=60)return null;
    for(const pref of prefs){
     if(networkEmergencyStopped(s,pref.network))continue;
     if(recent.some(a=>a.actorId===pref.actor)){
      // One network-room notice per owner per minute (other rooms and groups
      // cannot bypass this rate fuse by selecting different destinations).
      continue;
     }
     const target=adminRoomNotificationTarget(s,this.policy,pref.group,now);
     if(!target||target.id!==pref.linkId||target.room!==pref.room||
      target.setting!==pref.setting)continue;
     const events=networkAdministrativeEvents(s,this.policy,this.policy.ownerId,
      now,pref.network,{chatId:pref.group});
     if(!events)return null;
     const selected=events.filter(e=>
      (e.kind==='WATCH_CASE'||e.kind==='SANCTION_REVIEW')&&
      e.at>pref.at&&e.at<=now&&now-e.at<120_000)
      .sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
     for(const e of selected){
      const key=SEND+hash([pref.key,e.id,e.at]);
      if(s.audit.some(a=>a.updateKey===key||a.updateKey===key+':outcome'))continue;
      if(!eligible(s,this.policy,pref,now,e.id,e.at))continue;
      const base={pref,eventId:e.id,eventAt:e.at,eventLabel:e.label,
       kind:e.kind as Kind,room:pref.room};
      s.audit.push({updateKey:key,actorId:pref.actor,decision:'ALLOW',
       reason:reason(base),policyVersion:pref.groupVersion,at:now});
      return {...base,key,started:now};
     }
    }
    return null;
   });
   if(!job)break;
   const current=async()=>{
    if(!await this.safe())return false;
    const s=await this.store.snapshot(),now=this.clock();
    return intact(s,this.policy,job,now)&&await this.safe();
   };
   let result:'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT'='NOT_SENT';
   const roomPrivate=async():Promise<boolean>=>{
    if(!TelegramBotApiModerationGateway.usesOfficialRoomPrivacyRead(this.gateway))
     return false;
    try{return await this.gateway.inspectRoomPrivacy(job.room)===
     'NO_PUBLIC_USERNAME';}catch{return false;}
   };
   if(await current()&&await roomPrivate()&&await current()){
    // The official privacy proof must be fresh at the sender boundary too.
    // Revocation, a public username, unknown visibility, or loss of source
    // authority vetoes the send; never retry the reserved event blindly.
    result=await this.sender.sendNetworkReview(job.pref.group,job.room,job.kind,
     async()=>await current()&&await roomPrivate()&&await current());
   }
   await this.store.transaction(s=>{
    const now=this.clock();
    if(s.audit.some(a=>a.updateKey===job.key+':outcome'))return;
    const valid=intact(s,this.policy,job,now);
    s.audit.push({updateKey:job.key+':outcome',actorId:job.pref.actor,
     decision:'NOOP',reason:'NETWORK_ROOM_RELAY_'+(valid?result:'UNKNOWN_OUTCOME'),
     policyVersion:job.pref.groupVersion,at:clock(now)?now:job.started});
   });
   if(result!=='NOT_SENT')attempted++;
  }
  return attempted;
 }
}
