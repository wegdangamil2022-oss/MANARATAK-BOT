import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {TelegramReplySender,TelegramSendResult} from './telegram-replies.js';

const nonce=()=>randomBytes(18).toString('base64url');
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
const prefPrefix='moderation:report:notice-pref:';
const jobPrefix='moderation:report:notice-job:';
const prefKey=/^moderation:report:notice-pref:([A-Za-z0-9_-]{24})$/u;
const jobKey=/^moderation:report:notice-job:([A-Za-z0-9_-]{24})$/u;
type Preference={key:string;actor:string;chat:string;version:number;enabled:boolean;at:number};
type Notice={key:string;actor:string;chat:string;report:string;epoch:string;at:number;version:number};
const validActor=(v:string)=>/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const validChat=(v:string)=>/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
function parse(value:string):unknown{try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{return null;}}
function keyCounts(s:BotState):Map<string,number>{const counts=new Map<string,number>();for(const a of s.audit)counts.set(a.updateKey,(counts.get(a.updateKey)??0)+1);return counts;}
function preferences(s:BotState):Preference[]{
 const out:Preference[]=[],counts=keyCounts(s);
 for(const a of s.audit){
  if(!prefKey.test(a.updateKey)||counts.get(a.updateKey)!==1||!a.actorId||!validActor(a.actorId)||!a.reason.startsWith('REPORT_NOTICE_PREF:')||!Number.isSafeInteger(a.at)||a.at<0)continue;
  const v=parse(a.reason.slice('REPORT_NOTICE_PREF:'.length));
  if(!v||typeof v!=='object'||Array.isArray(v))continue;
  const p=v as Record<string,unknown>;
  if(Object.keys(p).sort().join(',')!=='chat,enabled'||typeof p.chat!=='string'||!validChat(p.chat)||typeof p.enabled!=='boolean'||!Number.isSafeInteger(a.policyVersion)||a.policyVersion<1)continue;
  out.push({key:a.updateKey,actor:a.actorId,chat:p.chat,enabled:p.enabled,version:a.policyVersion,at:a.at});
 }
 return out;
}
function latest(s:BotState,actor:string,chat:string):Preference|undefined{
 const rows=preferences(s).filter(x=>x.actor===actor&&x.chat===chat).sort((a,b)=>b.at-a.at);
 return rows.length&&(!rows[1]||rows[0]!.at>rows[1]!.at)?rows[0]:undefined;
}
export function reportManager(s:BotState,policy:Policy,actor:string,chat:string,now:number):boolean{
 return policy.privateFeature(s,'support.use',actor)&&policy.canUseChat(s,chat,'moderation')&&policy.has(s,actor,'chat.manage',chat,now)&&(!policy.isOwner(actor)||policy.privateFeature(s,'owner.dashboard',actor));
}
export function reportNoticeEnabled(s:BotState,policy:Policy,actor:string,chat:string,now:number):boolean{
 const pref=latest(s,actor,chat);return !!pref&&pref.enabled&&pref.version===policy.chatRevision(s,chat)&&pref.at<=now&&reportManager(s,policy,actor,chat,now);
}
export function setReportNoticePreference(s:BotState,policy:Policy,actor:string,chat:string,now:number):boolean{
 if(!reportManager(s,policy,actor,chat,now)||!validActor(actor)||!validChat(chat)||!Number.isSafeInteger(now)||now<0)return false;
 const previous=preferences(s).filter(p=>p.actor===actor&&p.chat===chat);
 if(previous.some(p=>p.at>=now))return false;
 const enabled=!reportNoticeEnabled(s,policy,actor,chat,now);
 s.audit.push({actorId:actor,updateKey:prefPrefix+nonce(),decision:'ALLOW',reason:'REPORT_NOTICE_PREF:'+Buffer.from(JSON.stringify({chat,enabled})).toString('base64url'),policyVersion:policy.chatRevision(s,chat),at:now});return true;
}
function epoch(s:BotState,policy:Policy,actor:string,chat:string,now:number):string|null{
 const pref=latest(s,actor,chat);if(!pref||!reportNoticeEnabled(s,policy,actor,chat,now))return null;
 return digest([pref,s.chats.filter(c=>c.id===chat),s.grants.filter(g=>g.actor===actor&&g.chatId===chat),s.privateFeatures,s.privateSettingsRevision]);
}
function notices(s:BotState):Notice[]{
 const result:Notice[]=[],counts=keyCounts(s);
 for(const a of s.audit){
  if(!jobKey.test(a.updateKey)||counts.get(a.updateKey)!==1||!a.actorId||!validActor(a.actorId)||!a.reason.startsWith('REPORT_NOTICE_JOB:')||!Number.isSafeInteger(a.at)||a.at<0)continue;
  const v=parse(a.reason.slice('REPORT_NOTICE_JOB:'.length));if(!v||typeof v!=='object'||Array.isArray(v))continue;
  const p=v as Record<string,unknown>;
  if(Object.keys(p).sort().join(',')!=='chat,epoch,report'||typeof p.chat!=='string'||!validChat(p.chat)||typeof p.epoch!=='string'||!/^[a-f0-9]{16}$/u.test(p.epoch)||typeof p.report!=='string'||!/^[A-Za-z0-9_-]{24}$/u.test(p.report))continue;
  result.push({key:a.updateKey,actor:a.actorId,chat:p.chat,report:p.report,epoch:p.epoch,at:a.at,version:a.policyVersion});
 }
 return result;
}
/** Queue only opted-in current managers, in the same transaction as the report. */
export function enqueueReportNotices(s:BotState,policy:Policy,chat:string,report:string,now:number):void{
 const existing=notices(s);
 // Historical receipts stay in the journal, but completed old jobs must not
 // permanently consume the outstanding-work budget.
 const keys=new Set(s.audit.map(a=>a.updateKey));
 const outstanding=existing.filter(j=>j.at>now-120000||keys.has(j.key+':started')&&!keys.has(j.key+':outcome'));
 if(outstanding.length>=10000)return;
 const actors=[...new Set(preferences(s).filter(p=>p.chat===chat).map(p=>p.actor))].sort();
 let queued=0;
 for(const actor of actors){
  const source=epoch(s,policy,actor,chat,now);
  if(!source||existing.some(j=>j.actor===actor&&j.chat===chat&&j.at>now-60000)||queued>=10)continue;
  s.audit.push({actorId:actor,updateKey:jobPrefix+nonce(),decision:'ALLOW',reason:'REPORT_NOTICE_JOB:'+Buffer.from(JSON.stringify({chat,report,epoch:source})).toString('base64url'),policyVersion:policy.chatRevision(s,chat),at:now});queued++;
 }
}
function eligible(s:BotState,policy:Policy,j:Notice,now:number):boolean{
 const reports=s.audit.filter(a=>a.updateKey==='moderation:report:'+j.report);
 const report=reports.length===1&&reports[0]!.reason.startsWith('MODERATION_REPORT:')?parse(reports[0]!.reason.slice('MODERATION_REPORT:'.length)):null;
 return !!report&&typeof report==='object'&&!Array.isArray(report)&&(report as Record<string,unknown>).chat===j.chat&&now>=j.at&&now-j.at<=120000&&j.version===policy.chatRevision(s,j.chat)&&epoch(s,policy,j.actor,j.chat,now)===j.epoch&&!s.audit.some(a=>a.updateKey==='moderation:report:'+j.report+':closed');
}
/** Each attempt has durable intent before sending; ambiguous attempts are never retried. */
export class ModerationReportNoticeDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly sender:TelegramReplySender,private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 async drain(limit=5):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('REPORT_NOTICE_LIMIT_INVALID');
  let count=0;
  for(let i=0;i<limit;i++){
   if(!await this.safety())break;
   const job=await this.store.transaction(s=>{
    const now=this.clock();if(!Number.isSafeInteger(now)||now<0)return null;
    const j=notices(s).find(x=>!s.audit.some(a=>a.updateKey===x.key+':started'||a.updateKey===x.key+':cancelled'||a.updateKey===x.key+':outcome'));
    if(!j)return null;
    const ok=eligible(s,this.policy,j,now);s.audit.push({actorId:j.actor,updateKey:j.key+(ok?':started':':cancelled'),decision:ok?'ALLOW':'NOOP',reason:ok?'REPORT_NOTICE_STARTED':'REPORT_NOTICE_CANCELLED',policyVersion:j.version,at:now});return ok?j:'CANCELLED' as const;
   });
   if(!job)break;if(job==='CANCELLED')continue;
   const state=await this.store.snapshot();
   if(!await this.safety()||!eligible(state,this.policy,job,this.clock())||state.audit.filter(a=>a.updateKey===job.key+':started').length!==1){await this.finish(job,'FAILED_CONFIRMED');continue;}
   let result:TelegramSendResult;
   try{result=await this.sender.send({chatId:job.actor,parseMode:'HTML',text:'يوجد بلاغ جديد في مجموعة مخوّل بمراجعتها. افتح صندوق البلاغات.',inlineMarkup:{inline_keyboard:[[{text:'📨 صندوق البلاغات',callback_data:'rp:1:r:0'}]]}});}catch{result={status:'UNKNOWN_OUTCOME'};}
   const status=result.status==='CONFIRMED'&&Number.isSafeInteger(result.messageId)&&result.messageId>0?'CONFIRMED':result.status==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
   await this.finish(job,status);count++;
  }
  return count;
 }
 private async finish(job:Notice,status:'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'):Promise<void>{
  await this.store.transaction(s=>{
   const now=this.clock(),started=s.audit.filter(a=>a.updateKey===job.key+':started');
   const current=notices(s).find(x=>x.key===job.key);
   const safe=started.length===1&&started[0]!.actorId===job.actor&&current!==undefined&&JSON.stringify(current)===JSON.stringify(job)&&eligible(s,this.policy,job,now);
   if(s.audit.some(a=>a.updateKey===job.key+':outcome'))return;
   s.audit.push({actorId:job.actor,updateKey:job.key+':outcome',decision:'NOOP',reason:'REPORT_NOTICE_'+(safe?status:'UNKNOWN_OUTCOME'),policyVersion:job.version,at:Number.isSafeInteger(now)&&now>=0?now:job.at});
  });
 }
}
