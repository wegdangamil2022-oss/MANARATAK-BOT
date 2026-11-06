import {createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {TelegramReplySender} from './telegram-replies.js';
import {adminRoomNotificationTarget} from './admin-room-links.js';
import {reportManager} from './moderation-report-notices.js';
const ROOT='admin-room:oncall:',WINDOW=120000;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const person=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const time=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-86400000;
export type OncallOptions={primary:string;fallback:string;seconds:number;enabled:boolean};
export type OncallSetting=OncallOptions&{key:string;group:string;link:string;actor:string;at:number;witness:string;authority:string};
type Stored=OncallOptions&{link:string;authority:string};
function authority(s:BotState,p:Policy,actor:string,chat:string,options:OncallOptions,now:number):string|null{
 const actors=[...new Set([actor,options.primary,options.fallback])].sort();
 if(!(options.enabled?actors:[actor]).every(a=>reportManager(s,p,a,chat,now)))return null;
 return hash([actors,s.chats.filter(c=>c.id===chat),s.grants.filter(g=>actors.includes(g.actor)&&g.chatId===chat),s.privateFeatures,s.privateSettingsRevision,adminRoomNotificationTarget(s,p,chat,now,!options.enabled)]);
}
/** Undefined means no configuration; null means damaged or no longer authorized. */
export function oncallSetting(s:BotState,p:Policy,chat:string,now:number,allowStale=false):OncallSetting|null|undefined{
 if(!group(chat)||!time(now))return null;
 const prefix=ROOT+chat+':'+p.chatRevision(s,chat)+':',rows=s.audit.filter(a=>a.updateKey.startsWith(prefix)).sort((a,b)=>Number(a.updateKey.slice(prefix.length))-Number(b.updateKey.slice(prefix.length)));
 if(!rows.length)return undefined;if(rows.length>1000)return null;
 for(const [i,a] of rows.entries())if(a.updateKey!==prefix+(i+1)||a.decision!=='ALLOW'||!person(a.actorId)||!time(a.at)||a.at>now||a.policyVersion!==p.chatRevision(s,chat)||i>0&&a.at<rows[i-1]!.at||!a.reason.startsWith('ADMIN_ROOM_ONCALL:'))return null;
 const last=rows.at(-1)!;let v:Stored;try{v=JSON.parse(last.reason.slice('ADMIN_ROOM_ONCALL:'.length));}catch{return null;}
 if(!v||Object.keys(v).sort().join(',')!=='authority,enabled,fallback,link,primary,seconds'||!validOptions(v)||typeof v.link!=='string'||!/^[A-Za-z0-9_-]{24}$/u.test(v.link)||typeof v.authority!=='string'||!/^[a-f0-9]{64}$/u.test(v.authority))return null;
 const target=adminRoomNotificationTarget(s,p,chat,now,!v.enabled),proof=authority(s,p,last.actorId!,chat,v,now);
 if(!allowStale&&(!target||target.id!==v.link||!proof||proof!==v.authority))return null;
 return {...v,key:last.updateKey,group:chat,actor:last.actorId!,at:last.at,witness:hash(rows)};
}
function validOptions(v:OncallOptions):boolean{return !!v&&typeof v==='object'&&person(v.primary)&&person(v.fallback)&&v.primary!==v.fallback&&Number.isSafeInteger(v.seconds)&&v.seconds>=60&&v.seconds<=3600&&typeof v.enabled==='boolean';}
export function saveOncall(s:BotState,p:Policy,actor:string,chat:string,expected:string,options:OncallOptions,now:number):boolean{
 if(!group(chat)||!person(actor)||!time(now)||!validOptions(options)||Object.keys(options).sort().join(',')!=='enabled,fallback,primary,seconds')return false;
 const current=oncallSetting(s,p,chat,now,true),target=adminRoomNotificationTarget(s,p,chat,now,!options.enabled),proof=authority(s,p,actor,chat,options,now);
 if(current===null||!target||!proof||(current?.witness??'0')!==expected||current&&current.at>=now)return false;
 const prefix=ROOT+chat+':'+p.chatRevision(s,chat)+':',count=s.audit.filter(a=>a.updateKey.startsWith(prefix)).length;if(count>=1000)return false;
 s.audit.push({updateKey:prefix+(count+1),actorId:actor,decision:'ALLOW',reason:'ADMIN_ROOM_ONCALL:'+JSON.stringify({...options,link:target.id,authority:proof}),policyVersion:p.chatRevision(s,chat),at:now});return true;
}
export function oncallPreviewWitness(s:BotState,p:Policy,actor:string,chat:string,options:OncallOptions,now:number):string|null{
 if(!validOptions(options)||Object.keys(options).sort().join(',')!=='enabled,fallback,primary,seconds')return null;const current=oncallSetting(s,p,chat,now,true),target=adminRoomNotificationTarget(s,p,chat,now,!options.enabled),proof=authority(s,p,actor,chat,options,now);
 return current!==null&&target&&proof?hash([target,proof,current?.witness??'0',options]):null;
}
type Assignment={id:string;chat:string;actor:string;stage:'primary'|'fallback';setting:OncallSetting;at:number;deadline:number;witness:string};
function assignments(s:BotState,p:Policy,now:number):Assignment[]{
 if(!time(now))return [];const out:Assignment[]=[];
 for(const a of s.audit){const m=/^moderation:report:([A-Za-z0-9_-]{24})$/u.exec(a.updateKey);if(!m||m[0]!==a.updateKey||a.decision!=='ALLOW'||!person(a.actorId)||!time(a.at)||a.at>now||s.audit.filter(x=>x.updateKey===a.updateKey).length!==1||s.audit.some(x=>x.updateKey===a.updateKey+':closed'))continue;
  let v:Record<string,unknown>;try{v=JSON.parse(Buffer.from(a.reason.slice('MODERATION_REPORT:'.length),'base64url').toString('utf8'));}catch{continue;}
  if(!a.reason.startsWith('MODERATION_REPORT:')||!v||Object.keys(v).sort().join(',')!=='chat,member,message'||!group(v.chat)||!person(v.member)||!Number.isSafeInteger(v.message)||Number(v.message)<=0)continue;
  const setting=oncallSetting(s,p,v.chat,now);if(!setting?.enabled||setting.at>a.at||s.audit.findIndex(x=>x.updateKey===setting.key)>=s.audit.indexOf(a)||a.policyVersion!==p.chatRevision(s,v.chat))continue;
  const witness=hash([a,setting.witness]),id=m[1]!,deadline=a.at+setting.seconds*1000;
  const acknowledgements=s.audit.filter(x=>x.updateKey==='admin-room:oncall-ack:'+id);
  if(acknowledgements.length)continue;
  out.push({id,chat:v.chat,actor:now<deadline?setting.primary:setting.fallback,stage:now<deadline?'primary':'fallback',setting,at:a.at,deadline,witness});
 }return out.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
}
export class AdminRoomOncall{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number){ }
 async acknowledge(actor:string,id:string,witness:string):Promise<boolean>{
  return this.store.transaction(s=>{const now=this.clock(),assignment=assignments(s,this.policy,now).find(a=>a.id===id&&a.actor===actor&&a.witness.slice(0,16)===witness);if(!assignment)return false;
   s.audit.push({updateKey:'admin-room:oncall-ack:'+id,actorId:actor,decision:'ALLOW',reason:'ADMIN_ROOM_ONCALL_ACK:'+assignment.witness,policyVersion:this.policy.chatRevision(s,assignment.chat),at:now});return true;});
 }
}
/** One durable attempt per report, configuration and stage. No sanction path. */
export class AdminRoomOncallDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly sender:TelegramReplySender,private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){ }
 async drain(limit=5):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('ONCALL_LIMIT_INVALID');const safe=async()=>{try{return await this.safety()===true;}catch{return false;}};let count=0;
  for(let i=0;i<limit;i++){
   if(!await safe())break;
   const job=await this.store.transaction(s=>{const now=this.clock(),a=assignments(s,this.policy,now).find(a=>{const key='admin-room:oncall-send:'+a.id+':'+a.setting.witness+':'+a.stage;return now-(a.stage==='primary'?a.at:a.deadline)<WINDOW&&!s.audit.some(x=>x.updateKey===key)&&!s.audit.some(x=>x.updateKey.startsWith('admin-room:oncall-send:')&&x.actorId===a.actor&&x.at<=now&&x.at>now-60000);});if(!a)return null;
    const key='admin-room:oncall-send:'+a.id+':'+a.setting.witness+':'+a.stage;s.audit.push({updateKey:key,actorId:a.actor,decision:'ALLOW',reason:'ADMIN_ROOM_ONCALL_STARTED:'+a.witness,policyVersion:this.policy.chatRevision(s,a.chat),at:now});return {...a,key,started:now};});
   if(!job)break;
   const current=(s:BotState,now:number)=>{const rows=s.audit.filter(a=>a.updateKey===job.key),started=rows[0];return time(now)&&now>=job.started&&now-job.started<WINDOW&&assignments(s,this.policy,now).some(a=>a.id===job.id&&a.actor===job.actor&&a.stage===job.stage&&a.witness===job.witness)&&rows.length===1&&!!started&&started.actorId===job.actor&&started.decision==='ALLOW'&&started.reason==='ADMIN_ROOM_ONCALL_STARTED:'+job.witness&&started.policyVersion===this.policy.chatRevision(s,job.chat)&&started.at===job.started&&!s.audit.some(a=>a.updateKey===job.key+':outcome');};
   if(!await safe()||!current(await this.store.snapshot(),this.clock()))continue;
   let outcome='UNKNOWN_OUTCOME';try{const result=await this.sender.send({chatId:job.actor,parseMode:'HTML',text:(job.stage==='primary'?'📨 بلاغ بانتظار استلامك كمشرف مناوب.':'🚨 تصعيد بلاغ لم يُستلم خلال المهلة. لا ينفذ التصعيد عقوبة.')+'\nالمجموعة: '+job.chat,inlineMarkup:{inline_keyboard:[[{text:'✅ استلام البلاغ',callback_data:'oc:1:a:'+job.id+':'+job.witness.slice(0,16)}],[{text:'📨 صندوق البلاغات',callback_data:'rp:1:r:0'}]]}});outcome=result.status==='CONFIRMED'&&Number.isSafeInteger(result.messageId)&&result.messageId>0?'CONFIRMED':result.status==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';}catch{/* never retry */}
   await this.store.transaction(s=>{const now=this.clock();if(!s.audit.some(a=>a.updateKey===job.key+':outcome'))s.audit.push({updateKey:job.key+':outcome',actorId:job.actor,decision:'NOOP',reason:'ADMIN_ROOM_ONCALL_'+(current(s,now)?outcome:'UNKNOWN_OUTCOME'),policyVersion:this.policy.chatRevision(s,job.chat),at:time(now)?now:job.started});});count++;
  }return count;
 }
}
