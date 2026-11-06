import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {TelegramReplySender,TelegramSendResult} from './telegram-replies.js';
import {validGroupNetwork} from './group-network-model.js';
import {reportManager} from './moderation-report-notices.js';
import {networkAdministrativeEvents,type NetworkAdministrativeEventKind}
 from './network-administrative-events.js';

/** NETWORK-006: manager-specific, separately opted-in private event alerts.
 * An event is information, never Telegram moderation authorization.
 * Consent and send attempts are immutable audit receipts in JSON/SQLite. */
export type NetworkAlertKind='w'|'r'|'s';
const EVENT_KIND:Record<NetworkAlertKind,NetworkAdministrativeEventKind>={
 w:'WATCH_CASE',r:'SANCTION_REVIEW',s:'SNAPSHOT'
};
const PREF='network:event:pref:',SEND='network:event:send:';
const KEY=/^network:event:pref:([A-Za-z0-9_-]{24})$/u;
const SEND_KEY=/^network:event:send:([a-f0-9]{64})$/u;
const actorId=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const chatId=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const networkId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&
 v>=0&&v<=8_640_000_000_000_000-120_000;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const isKind=(v:unknown):v is NetworkAlertKind=>v==='w'||v==='r'||v==='s';
interface Preference {
 key:string;actor:string;network:string;networkRevision:number;
 chat:string;chatVersion:number;kind:NetworkAlertKind;enabled:boolean;
 authority:string;at:number;
}
const validRev=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=9_999_999_999;
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

export function networkAlertScope(s:BotState,p:Policy,actor:string,network:string,chat:string,now:number):
 {networkRevision:number;chatVersion:number;authority:string}|null{
 if(!time(now)||!actorId(actor)||!networkId(network)||!chatId(chat)||
  !reportManager(s,p,actor,chat,now))return null;
 const nets=(s.groupNetworks??[]).filter(x=>x.id===network),n=nets[0];
 if(nets.length!==1||!n||!validGroupNetwork(n)||n.updatedAt>now)return null;
 const m=n.members.find(x=>x.chatId===chat),chats=s.chats.filter(x=>x.id===chat),c=chats[0];
 if(!m||chats.length!==1||!c||!c.approved||!c.scopes.includes('moderation')||
  m.version!==c.version||!p.canUseChat(s,chat,'moderation'))return null;
 // Revoking and regranting the exact capability changes consent authority.
 const grants=s.grants.filter(g=>g.actor===actor&&g.chatId===chat&&g.capability==='chat.manage');
 return {networkRevision:n.revision,chatVersion:c.version,
  authority:hash([n,c,grants,s.privateFeatures['support.use'],
   p.isOwner(actor)?s.privateFeatures['owner.dashboard']:null])};
}
const uniqueCounts=(s:BotState)=>{
 const counts=new Map<string,number>();for(const a of s.audit)
  if(a.updateKey.startsWith(PREF))counts.set(a.updateKey,(counts.get(a.updateKey)??0)+1);
 return counts;
};
function preferences(s:BotState):Preference[]|null{
 const counts=uniqueCounts(s),out:Preference[]=[];
 if(s.audit.filter(a=>a.updateKey.startsWith(PREF)).length>3000)return null;
 for(const a of s.audit){
  if(!a.updateKey.startsWith(PREF))continue;
  if(!KEY.test(a.updateKey)||counts.get(a.updateKey)!==1||a.decision!=='ALLOW'||
   !actorId(a.actorId)||!time(a.at)||!validRev(a.policyVersion)||
   !a.reason.startsWith('NETWORK_EVENT_ALERT_PREF:'))return null;
  let payload:unknown;try{payload=JSON.parse(a.reason.slice('NETWORK_EVENT_ALERT_PREF:'.length));}catch{return null;}
  if(!obj(payload)||Object.keys(payload).sort().join(',')!=='authority,chat,chatVersion,enabled,kind,network,networkRevision'||
   !networkId(payload.network)||!chatId(payload.chat)||!validRev(payload.chatVersion)||
   !validRev(payload.networkRevision)||!isKind(payload.kind)||
   typeof payload.enabled!=='boolean'||typeof payload.authority!=='string'||
   !/^[a-f0-9]{64}$/u.test(payload.authority)||a.policyVersion!==payload.chatVersion)return null;
  out.push({key:a.updateKey,actor:a.actorId,network:payload.network,
   networkRevision:payload.networkRevision,chat:payload.chat,chatVersion:payload.chatVersion,
   kind:payload.kind,enabled:payload.enabled,authority:payload.authority,at:a.at});
 }
 return out;
}
function latest(rows:Preference[],actor:string,net:string,chat:string,kind:NetworkAlertKind):Preference|null{
 const same=rows.filter(p=>p.actor===actor&&p.network===net&&p.chat===chat&&p.kind===kind)
  .sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key));
 if(same.length>1&&same[0]!.at===same[1]!.at)return null;
 return same[0]??null;
}
function active(s:BotState,p:Policy,pref:Preference,now:number):boolean{
 const scope=networkAlertScope(s,p,pref.actor,pref.network,pref.chat,now);
 return pref.enabled&&pref.at<=now&&!!scope&&scope.networkRevision===pref.networkRevision&&
  scope.chatVersion===pref.chatVersion&&scope.authority===pref.authority;
}
export function networkAlertEnabled(s:BotState,p:Policy,actor:string,network:string,chat:string,
 kind:NetworkAlertKind,now:number):boolean{
 const rows=preferences(s);if(!rows||!isKind(kind))return false;
 const item=latest(rows,actor,network,chat,kind);
 return item!==null&&active(s,p,item,now);
}
export function networkAlertConsentProof(s:BotState,p:Policy,actor:string,network:string,
 chat:string,kind:NetworkAlertKind,now:number):string|null{
 if(!isKind(kind))return null;
 const scope=networkAlertScope(s,p,actor,network,chat,now),rows=preferences(s);
 if(!scope||!rows)return null;
 const same=rows.filter(x=>x.actor===actor&&x.network===network&&x.chat===chat&&x.kind===kind);
 const last=latest(rows,actor,network,chat,kind);
 if(same.length>0&&!last)return null;
 return hash([actor,network,chat,kind,scope,last??null]);
}
/** Call only inside a trusted private callback transaction. OFF by default. */
export function setNetworkAlertPreference(s:BotState,p:Policy,actor:string,network:string,
 chat:string,kind:NetworkAlertKind,now:number):boolean{
 const scope=networkAlertScope(s,p,actor,network,chat,now),rows=preferences(s);
 if(!scope||!isKind(kind)||!rows||rows.length>=3000)return false;
 const history=rows.filter(x=>x.actor===actor&&x.network===network&&x.chat===chat&&x.kind===kind),
  last=latest(rows,actor,network,chat,kind);
 if(history.length>0&&!last||last&&now<=last.at)return false;
 const enabled=!last||!active(s,p,last,now);
 s.audit.push({updateKey:PREF+randomBytes(18).toString('base64url'),actorId:actor,
  decision:'ALLOW',reason:'NETWORK_EVENT_ALERT_PREF:'+JSON.stringify({
   network,networkRevision:scope.networkRevision,chat,chatVersion:scope.chatVersion,
   kind,enabled,authority:scope.authority}),
  policyVersion:scope.chatVersion,at:now});
 return true;
}
interface Candidate{
 key:string;pref:Preference;eventId:string;eventAt:number;label:string;started:number;
}
/** Sources must be unique, current, owner-visible and current-manager scoped.
 * A forged preference or lost grant cannot unlock an old event. */
function event(s:BotState,p:Policy,pref:Preference,now:number,eventId?:string){
 if(!active(s,p,pref,now)||!p.privateFeature(s,'owner.dashboard',p.ownerId))return null;
 const matches=networkAdministrativeEvents(s,p,p.ownerId,now,pref.network,{
  kind:EVENT_KIND[pref.kind],chatId:pref.chat});
 if(!matches)return null;
 return matches.find(e=>e.at>pref.at&&e.at<=now&&now-e.at<120_000&&
  (eventId===undefined||e.id===eventId))??null;
}
function intact(s:BotState,job:Candidate,now:number):boolean{
 if(!time(now)||now<job.started||now-job.started>=120_000)return false;
 const rows=s.audit.filter(x=>x.updateKey===job.key),row=rows[0];
 return rows.length===1&&!!row&&row.actorId===job.pref.actor&&row.decision==='ALLOW'&&
  row.policyVersion===job.pref.chatVersion&&row.at===job.started&&
  row.reason=== 'NETWORK_EVENT_ALERT_STARTED:'+hash([job.pref,job.eventId,job.eventAt,job.label])&&
  s.audit.filter(x=>x.updateKey===job.key+':outcome').length===0;
}
export class NetworkEventAlertDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly sender:TelegramReplySender,private readonly clock:()=>number,
  private readonly safety:()=>Promise<boolean>){}
 private async safe():Promise<boolean>{try{return await this.safety()===true;}catch{return false;}}
 async drain(limit=5):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('NETWORK_ALERT_LIMIT_INVALID');
  let sent=0;
  for(let i=0;i<limit;i++){
   if(!await this.safe())break;
   const job=await this.store.transaction(s=>{
    const now=this.clock();if(!time(now))return null;
    const prefs=preferences(s);if(!prefs)return null;
    const sorted=prefs.filter(p=>active(s,this.policy,p,now)).sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key));
    // Only newest current consent for each actor/group/type can deliver.
    for(const pref of sorted){
     if(latest(prefs,pref.actor,pref.network,pref.chat,pref.kind)?.key!==pref.key)continue;
     if(s.audit.some(a=>SEND_KEY.test(a.updateKey)&&a.actorId===pref.actor&&
       a.decision==='ALLOW'&&a.at<=now&&a.at>now-60_000))continue;
     const e=event(s,this.policy,pref,now);
     if(!e)continue;
     const key=SEND+hash([pref.key,e.id,e.at]);
     if(s.audit.some(a=>a.updateKey===key||a.updateKey===key+':outcome'))continue;
     // Bound total outbound volume; an audit journal is not a blank cheque.
     if(s.audit.filter(a=>SEND_KEY.test(a.updateKey)&&a.at<=now&&a.at>now-60_000).length>=100)return null;
     s.audit.push({updateKey:key,actorId:pref.actor,decision:'ALLOW',
      reason:'NETWORK_EVENT_ALERT_STARTED:'+hash([pref,e.id,e.at,e.label]),
      policyVersion:pref.chatVersion,at:now});
     return {key,pref,eventId:e.id,eventAt:e.at,label:e.label,started:now};
    }
    return null;
   });
   if(!job)break;
   const safe=await this.safe(),state=await this.store.snapshot(),now=this.clock();
   const current=event(state,this.policy,job.pref,now,job.eventId);
   if(!safe||!current||current.at!==job.eventAt||current.label!==job.label||
    !intact(state,job,now)){
    await this.finish(job,'UNKNOWN_OUTCOME');continue;
   }
   let result:TelegramSendResult;
   // No student IDs, report text, policy values or sensitive event IDs.
   try{result=await this.sender.send({chatId:job.pref.actor,parseMode:'HTML',
    text:'🔔 حدث إداري جديد لمجموعة مخوّل بمراجعتها: '+job.label+
     '\nافتح لوحة إشعارات الشبكة للمراجعة. لا تُنفذ هذه الرسالة أي عقوبة.',
    inlineMarkup:{inline_keyboard:[[{text:'⚙️ إعداد إشعارات الشبكات',
      callback_data:'na:1:h:0'}]]}});}
   catch{result={status:'UNKNOWN_OUTCOME'};}
   const status=result.status==='CONFIRMED'&&Number.isSafeInteger(result.messageId)&&
    result.messageId>0?'CONFIRMED':
    result.status==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
   await this.finish(job,status);sent++;
  }
  return sent;
 }
 private async finish(job:Candidate,status:'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'):Promise<void>{
  await this.store.transaction(s=>{
   const now=this.clock();
   if(s.audit.some(a=>a.updateKey===job.key+':outcome'))return;
   const curr=time(now)?event(s,this.policy,job.pref,now,job.eventId):null;
   const valid=curr&&curr.at===job.eventAt&&curr.label===job.label&&intact(s,job,now);
   s.audit.push({updateKey:job.key+':outcome',actorId:job.pref.actor,decision:'NOOP',
    reason:'NETWORK_EVENT_ALERT_'+(valid?status:'UNKNOWN_OUTCOME'),
    policyVersion:job.pref.chatVersion,at:time(now)?now:job.started});
  });
 }
}
