import {warningActive} from './group-rule-warning-policy.js';
import {groupRuleDescription} from './group-rules-model.js';
import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore,Warning,ModerationOperation} from './store.js';
import type {Policy} from './policy.js';
import type {GroupPermissionJob} from './group-permission-model.js';
import {adminRoomNotificationTarget,adminRoomDailyTargets,adminRoomModeWitness,type AdminRoomDailyTarget} from './admin-room-links.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

const PREFIX='admin-room:notice:',WINDOW=120000;
const KEY=/^admin-room:notice:([A-Za-z0-9_-]{24})$/u,ID=/^[A-Za-z0-9_-]{24}$/u;
const chat=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
type NoticeKind='REPORT'|'WARNING'|'ACTION'|'FAILURE'|'INCIDENT';
type Notice={key:string;group:string;room:string;link:string;setting:string;kind:NoticeKind;source:string;version:number;at:number};
const operationStatuses={ACTION:'CONFIRMED',FAILURE:'FAILED_CONFIRMED',INCIDENT:'UNKNOWN_OUTCOME'} as const;
const clockValid=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
function reportValid(s:BotState,p:Policy,group:string,report:string,version:number,now:number):boolean{
 const rows=s.audit.filter(a=>a.updateKey==='moderation:report:'+report),a=rows[0];if(rows.length!==1||!a||a.decision!=='ALLOW'||!a.actorId||!/^[1-9][0-9]{0,15}$/u.test(a.actorId)||!Number.isSafeInteger(Number(a.actorId))||!Number.isSafeInteger(a.at)||a.at<0||a.at>now||a.policyVersion!==version||version!==p.chatRevision(s,group)||!a.reason.startsWith('MODERATION_REPORT:')||s.audit.some(x=>x.updateKey===a.updateKey+':closed'))return false;
 try{const v:unknown=JSON.parse(Buffer.from(a.reason.slice('MODERATION_REPORT:'.length),'base64url').toString('utf8'));return obj(v)&&Object.keys(v).sort().join(',')===(Object.hasOwn(v,'reference')?'chat,member,message,reference':'chat,member,message')&&v.chat===group&&typeof v.member==='string'&&/^[1-9][0-9]{0,15}$/u.test(v.member)&&Number.isSafeInteger(Number(v.member))&&Number.isSafeInteger(v.message)&&Number(v.message)>0&&(!Object.hasOwn(v,'reference')||typeof v.reference==='string'&&!!groupRuleDescription(s,group,v.reference)&&Number(/_m([1-9][0-9]{0,15})$/u.exec(v.reference)?.[1])===v.message);}catch{return false;}
}
const warningDigest=(w:Warning)=>createHash('sha256').update(JSON.stringify(w)).digest('hex');
function warningValid(s:BotState,p:Policy,group:string,digest:string,version:number,now:number):boolean{
 if(!/^[a-f0-9]{64}$/u.test(digest)||version!==p.chatRevision(s,group))return false;
 const matches=s.warnings.filter(w=>w.chatId===group&&warningActive(w,now)&&clockValid(w.at)&&w.at<=now&&warningDigest(w)===digest);return matches.length===1;
}
const operationDigest=(op:ModerationOperation|GroupPermissionJob)=>createHash('sha256').update(JSON.stringify(op)).digest('hex');
function operationValid(s:BotState,p:Policy,group:string,digest:string,kind:keyof typeof operationStatuses,version:number,now:number):boolean{
 if(!/^[a-f0-9]{64}$/u.test(digest)||version!==p.chatRevision(s,group))return false;
 const matches=s.moderationOperations.filter(o=>o.chatId===group&&o.policyVersion===version&&o.status===operationStatuses[kind]&&o.attemptGateway==='TELEGRAM_API'&&clockValid(o.createdAt)&&o.createdAt<=now&&operationDigest(o)===digest);
 if(matches.length===1&&s.moderationOperations.filter(o=>o.id===matches[0]!.id).length===1)return true;
 const jobs=(s.groupPermissionJobs??[]).filter(j=>j.chatId===group&&j.scopeVersion===version&&j.gatewayOrigin==='TELEGRAM_API'&&j.status===operationStatuses[kind]&&clockValid(j.createdAt)&&j.createdAt<=now&&operationDigest(j)===digest);
 if(jobs.length===1&&(s.groupPermissionJobs??[]).filter(j=>j.id===jobs[0]!.id).length===1)return true;
 const events=s.audit.filter(a=>a.updateKey.startsWith('admin-room:event:')&&a.policyVersion===version&&a.decision==='NOOP'&&a.reason==='ADMIN_ROOM_EVENT:BOT_RIGHTS_UNAVAILABLE:'+group&&clockValid(a.at)&&a.at<=now&&createHash('sha256').update(JSON.stringify(a)).digest('hex')===digest);
 return kind==='FAILURE'&&events.length===1&&s.audit.filter(a=>a.updateKey===events[0]!.updateKey).length===1;
}
function notices(s:BotState):Notice[]{
 const counts=new Map<string,number>();for(const a of s.audit)counts.set(a.updateKey,(counts.get(a.updateKey)??0)+1);
 const out:Notice[]=[];for(const a of s.audit){if(!KEY.test(a.updateKey)||counts.get(a.updateKey)!==1||a.decision!=='ALLOW'||!clockValid(a.at)||!Number.isSafeInteger(a.policyVersion)||a.policyVersion<1)continue;const kind=(['REPORT','WARNING','ACTION','FAILURE','INCIDENT'] as const).find(k=>a.reason.startsWith('ADMIN_ROOM_'+k+'_NOTICE:'));if(!kind)continue;
  try{const v:unknown=JSON.parse(a.reason.slice(('ADMIN_ROOM_'+kind+'_NOTICE:').length));if(!obj(v)||!chat(v.group)||!chat(v.room)||typeof v.link!=='string'||!ID.test(v.link))continue;const source=kind==='REPORT'?v.report:kind==='WARNING'?v.warning:v.operation,keys=Object.keys(v).sort().join(','),legacy=kind==='REPORT'?'group,link,report,room':kind==='WARNING'?'group,link,room,warning':null,current=kind==='REPORT'?'group,link,report,room,setting':kind==='WARNING'?'group,link,room,setting,warning':'group,link,operation,room,setting';if(keys!==legacy&&keys!==current||typeof source!=='string'||!(kind==='REPORT'?ID:/^[a-f0-9]{64}$/u).test(source)||v.setting!==undefined&&(typeof v.setting!=='string'||!/^(?:0|[a-f0-9]{64})$/u.test(v.setting)))continue;out.push({key:a.updateKey,group:v.group,room:v.room,link:v.link,setting:typeof v.setting==='string'?v.setting:'0',kind,source,version:a.policyVersion,at:a.at});}catch{/* malformed journal data never becomes a delivery */}
 }return out;
}
function eligible(s:BotState,p:Policy,n:Notice,now:number):boolean{
 if(!clockValid(now)||now<n.at||now-n.at>=WINDOW||!(n.kind==='REPORT'?reportValid(s,p,n.group,n.source,n.version,now):n.kind==='WARNING'?warningValid(s,p,n.group,n.source,n.version,now):operationValid(s,p,n.group,n.source,n.kind,n.version,now)))return false;
 const target=adminRoomNotificationTarget(s,p,n.group,now);return !!target&&target.id===n.link&&target.room===n.room&&target.setting===n.setting;
}
/** A warning is referenced by a digest; no member or free-text reason is queued. */
export function enqueueAdminRoomWarningNotice(s:BotState,p:Policy,w:Warning,now:number):void{
 if(!chat(w.chatId)||!clockValid(now))return;const target=adminRoomNotificationTarget(s,p,w.chatId,now),version=p.chatRevision(s,w.chatId),warning=warningDigest(w);if(!target||!warningValid(s,p,w.chatId,warning,version,now))return;
 const previous=notices(s);if(previous.some(n=>n.group===w.chatId&&n.room===target.room&&n.at<=now&&n.at>now-60000)||previous.filter(n=>n.at<=now&&n.at>now-WINDOW).length>=1000)return;
 s.audit.push({updateKey:PREFIX+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:'ADMIN_ROOM_WARNING_NOTICE:'+JSON.stringify({group:w.chatId,room:target.room,link:target.id,warning,setting:target.setting}),policyVersion:version,at:now});
}
/** Called only inside the same transaction that recorded a report. */
export function enqueueAdminRoomReportNotice(s:BotState,p:Policy,group:string,report:string,now:number):void{
 if(!chat(group)||!ID.test(report)||!clockValid(now))return;const target=adminRoomNotificationTarget(s,p,group,now),version=p.chatRevision(s,group);if(!target||!reportValid(s,p,group,report,version,now))return;
 const previous=notices(s);if(previous.some(n=>n.group===group&&n.room===target.room&&n.at<=now&&n.at>now-60000)||previous.filter(n=>n.at<=now&&n.at>now-WINDOW).length>=1000)return;
 s.audit.push({updateKey:PREFIX+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:'ADMIN_ROOM_REPORT_NOTICE:'+JSON.stringify({group,room:target.room,link:target.id,report,setting:target.setting}),policyVersion:version,at:now});
}
/** Terminal official-adapter outcomes only; never queues an action or member ID. */
export function enqueueAdminRoomOperationNotice(s:BotState,p:Policy,op:ModerationOperation|GroupPermissionJob,now:number):void{
 if(!chat(op.chatId)||!clockValid(now))return;const kind=(Object.keys(operationStatuses) as (keyof typeof operationStatuses)[]).find(k=>operationStatuses[k]===op.status);if(!kind)return;
 const target=adminRoomNotificationTarget(s,p,op.chatId,now),version=p.chatRevision(s,op.chatId),operation=operationDigest(op);if(!target||!operationValid(s,p,op.chatId,operation,kind,version,now))return;
 const previous=notices(s);if(previous.some(n=>n.group===op.chatId&&n.room===target.room&&n.at<=now&&n.at>now-60000)||previous.filter(n=>n.at<=now&&n.at>now-WINDOW).length>=1000)return;
 s.audit.push({updateKey:PREFIX+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:'ADMIN_ROOM_'+kind+'_NOTICE:'+JSON.stringify({group:op.chatId,room:target.room,link:target.id,operation,setting:target.setting}),policyVersion:version,at:now});
}
/** Rights preflight failure is a system notice, never a sanction receipt. */
export function enqueueAdminRoomRightsFailure(s:BotState,p:Policy,group:string,now:number):void{
 if(!chat(group)||!clockValid(now))return;const target=adminRoomNotificationTarget(s,p,group,now);if(!target)return;const previous=notices(s);if(previous.some(n=>n.group===group&&n.room===target.room&&n.at<=now&&n.at>now-60000)||previous.filter(n=>n.at<=now&&n.at>now-WINDOW).length>=1000)return;
 const version=p.chatRevision(s,group),event={updateKey:'admin-room:event:'+randomBytes(18).toString('base64url'),decision:'NOOP' as const,reason:'ADMIN_ROOM_EVENT:BOT_RIGHTS_UNAVAILABLE:'+group,policyVersion:version,at:now};s.audit.push(event);const operation=createHash('sha256').update(JSON.stringify(event)).digest('hex');s.audit.push({updateKey:PREFIX+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:'ADMIN_ROOM_FAILURE_NOTICE:'+JSON.stringify({group,room:target.room,link:target.id,operation,setting:target.setting}),policyVersion:version,at:now});
}
type SendResult='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT';
/** Fixed content and verified response identity; does not accept user text. */
export class TelegramAdminRoomNoticeSender{
 readonly #token:string;readonly #request:typeof fetch;readonly #botId:number;
 constructor(token:string,request:typeof fetch=fetch){if(!/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))throw Error('INVALID_TELEGRAM_TOKEN');this.#token=token;this.#request=request;this.#botId=Number(token.split(':')[0]);}
 async send(group:string,room:string,kind:NoticeKind,verify:()=>Promise<boolean>,controlReport?:string):Promise<SendResult>{
  if(controlReport!==undefined&&(kind!=='REPORT'||!ID.test(controlReport)))return 'NOT_SENT';
  if(!chat(group)||!chat(room)||!['REPORT','WARNING','ACTION','FAILURE','INCIDENT'].includes(kind)||typeof verify!=='function')return 'NOT_SENT';try{if(await verify()!==true)return 'NOT_SENT';}catch{return 'NOT_SENT';}
  const text=kind==='REPORT'?'📋 مراجعة\nبلاغ جديد للمراجعة في المجموعة '+group+'. افتح صندوق البلاغات في خاص البوت.':kind==='WARNING'?'🛡 إجراء\nصدر تحذير في المجموعة '+group+'. راجع حالات الإشراف في خاص البوت.':kind==='ACTION'?'🛡 إجراء\nسُجل نجاح إجراء إشرافي في المجموعة '+group+'. راجع سجل الإشراف في خاص البوت.':kind==='FAILURE'?'⚙️ نظام\nرُفض تنفيذ إجراء إشرافي في المجموعة '+group+'. راجع سجل الإشراف في خاص البوت.':'🚨 عاجل\nنتيجة إجراء إشرافي غير محسومة في المجموعة '+group+'. يلزم فحص السجل في خاص البوت؛ لا تعِد التنفيذ تلقائيًا.';
  try{const response=await this.#request('https://api.telegram.org/bot'+this.#token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:room,text,link_preview_options:{is_disabled:true},...(controlReport?{reply_markup:{inline_keyboard:[[{text:'📋 مراجعة إغلاق البلاغ',callback_data:'rc:1:p:'+controlReport}],[{text:'⚠️ مراجعة تحذير',callback_data:'rc:1:w:'+controlReport},{text:'🔇 مراجعة كتم لدقيقة',callback_data:'rc:1:m:'+controlReport}]]}}:{})}),redirect:'error',signal:AbortSignal.timeout(8000)});const raw=await response.text();if(raw.length>16384)return 'UNKNOWN_OUTCOME';const v:unknown=JSON.parse(raw);if(!obj(v))return 'UNKNOWN_OUTCOME';
   if(response.ok&&response.status===200&&v.ok===true&&obj(v.result)){const m=v.result;return obj(m.chat)&&m.chat.id===Number(room)&&obj(m.from)&&m.from.id===this.#botId&&m.from.is_bot===true&&typeof m.message_id==='number'&&Number.isSafeInteger(m.message_id)&&m.message_id>0?'CONFIRMED':'UNKNOWN_OUTCOME';}
   return response.status>=400&&response.status<500&&v.ok===false&&v.error_code===response.status?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
  }catch{return 'UNKNOWN_OUTCOME';}
 }
 /** NETWORK-006: fixed, identity-free network review alert. Never accepts
  * report text, student IDs, evidence, or moderation callback buttons.
  * Caller MUST re-check independent consent and room privacy.
  */
 async sendNetworkReview(group:string,room:string,
  kind:'WATCH_CASE'|'SANCTION_REVIEW',verify:()=>Promise<boolean>):Promise<SendResult>{
  if(!chat(group)||!chat(room)||group===room||
   !['WATCH_CASE','SANCTION_REVIEW'].includes(kind)||
   typeof verify!=='function')return 'NOT_SENT';
  try{if(await verify()!==true)return 'NOT_SENT';}catch{return 'NOT_SENT';}
  const text=kind==='WATCH_CASE'?
   '🛡 مراجعات الشبكة\nتغيّرت حالة بلاغ للمراجعة في المجموعة '+group+
   '. راجع سجل الشبكة في خاص البوت. ليس هذا إثبات مخالفة أو أمر عقوبة.':
   '⚖️ مراجعات الشبكة\nتغيّرت حالة اقتراح إجراء بشري في المجموعة '+group+
   '. افتح سجل المراجعات في خاص البوت؛ لا يُنفَّذ أي حظر أو كتم بهذه الرسالة.';
  try{
   const response=await this.#request('https://api.telegram.org/bot'+this.#token+
    '/sendMessage',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:room,text,link_preview_options:{is_disabled:true}}),
    redirect:'error',signal:AbortSignal.timeout(8000)});
   const raw=await response.text();if(raw.length>16384)return 'UNKNOWN_OUTCOME';
   const data:unknown=JSON.parse(raw);if(!obj(data))return 'UNKNOWN_OUTCOME';
   if(response.ok&&response.status===200&&data.ok===true&&obj(data.result)){
    const message=data.result;
    return obj(message.chat)&&message.chat.id===Number(room)&&
     obj(message.from)&&message.from.id===this.#botId&&message.from.is_bot===true&&
     typeof message.message_id==='number'&&Number.isSafeInteger(message.message_id)&&
     message.message_id>0?'CONFIRMED':'UNKNOWN_OUTCOME';
   }
   return response.status>=400&&response.status<500&&data.ok===false&&
    data.error_code===response.status?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
  }catch{return 'UNKNOWN_OUTCOME';}
 }
 async sendDaily(target:AdminRoomDailyTarget,verify:()=>Promise<boolean>):Promise<SendResult>{
  try{target=structuredClone(target);}catch{return 'NOT_SENT';}
  if(!target?.summary||!['reports','warnings','actions','changes','failures','incidents'].every(k=>Number.isSafeInteger(target.summary[k as keyof typeof target.summary])&&Number(target.summary[k as keyof typeof target.summary])>=0&&Number(target.summary[k as keyof typeof target.summary])<=1000000))return 'NOT_SENT';
  if(!target||!chat(target.group)||!chat(target.room)||!Number.isSafeInteger(target.summary?.reports)||target.summary.reports<0||target.summary.reports>1000000||!Number.isSafeInteger(target.summary.warnings)||target.summary.warnings<0||target.summary.warnings>1000000||typeof verify!=='function')return 'NOT_SENT';
  try{if(await verify()!==true)return 'NOT_SENT';}catch{return 'NOT_SENT';}
  try{const response=await this.#request('https://api.telegram.org/bot'+this.#token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:target.room,text:'⚙️ نظام\nملخص يومي للمجموعة '+target.group+'\nالبلاغات: '+target.summary.reports+'\nالتحذيرات: '+target.summary.warnings+'\nالإجراءات المؤكدة: '+target.summary.actions+'\nتعديلات الأذونات: '+target.summary.changes+'\nرفض التنفيذ: '+target.summary.failures+'\nالنتائج غير المحسومة: '+target.summary.incidents+'\nالأعداد من السجل المحفوظ، وتشمل التحذيرات الملغاة.',link_preview_options:{is_disabled:true}}),redirect:'error',signal:AbortSignal.timeout(8000)});const raw=await response.text();if(raw.length>16384)return 'UNKNOWN_OUTCOME';const v:unknown=JSON.parse(raw);if(!obj(v))return 'UNKNOWN_OUTCOME';
   if(response.ok&&response.status===200&&v.ok===true&&obj(v.result)){const m=v.result;return obj(m.chat)&&m.chat.id===Number(target.room)&&obj(m.from)&&m.from.id===this.#botId&&m.from.is_bot===true&&typeof m.message_id==='number'&&Number.isSafeInteger(m.message_id)&&m.message_id>0?'CONFIRMED':'UNKNOWN_OUTCOME';}
   return response.status>=400&&response.status<500&&v.ok===false&&v.error_code===response.status?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
  }catch{return 'UNKNOWN_OUTCOME';}
 }
}
function intact(s:BotState,n:Notice,now:number):boolean{
 const original=notices(s).filter(x=>x.key===n.key),started=s.audit.filter(a=>a.updateKey===n.key+':started'),a=started[0];return original.length===1&&JSON.stringify(original[0])===JSON.stringify(n)&&started.length===1&&!!a&&a.decision==='ALLOW'&&a.reason==='ADMIN_ROOM_NOTICE_STARTED'&&a.policyVersion===n.version&&clockValid(a.at)&&a.at>=n.at&&a.at<=now&&!s.audit.some(x=>x.updateKey===n.key+':outcome'||x.updateKey===n.key+':cancelled');
}
/** Official, short-lived visibility observation. Every sender must ask
 * again inside its final pre-send verifier; a previous private-room check
 * does not authorize a later send after visibility changes.
 */
async function adminRoomPrivateAtSend(gateway:TelegramBotApiModerationGateway,
 room:string):Promise<boolean>{
 if(!TelegramBotApiModerationGateway.usesOfficialRoomPrivacyRead(gateway))
  return false;
 try{return await gateway.inspectRoomPrivacy(room)==='NO_PUBLIC_USERNAME';}
 catch{return false;}
}

export class AdminRoomNoticeDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly gateway:TelegramBotApiModerationGateway,private readonly sender:TelegramAdminRoomNoticeSender,private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 async drain(limit=5):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('ADMIN_ROOM_NOTICE_LIMIT_INVALID');const safe=async()=>{try{return await this.safety()===true;}catch{return false;}};let sent=0;
  for(let i=0;i<limit;i++){
   if(!await safe())break;const job=await this.store.transaction(s=>{const now=this.clock();if(!clockValid(now))return null;const n=notices(s).find(x=>!s.audit.some(a=>a.updateKey===x.key+':started'||a.updateKey===x.key+':cancelled'||a.updateKey===x.key+':outcome'));if(!n)return null;const ok=eligible(s,this.policy,n,now);s.audit.push({updateKey:n.key+(ok?':started':':cancelled'),decision:ok?'ALLOW':'NOOP',reason:ok?'ADMIN_ROOM_NOTICE_STARTED':'ADMIN_ROOM_NOTICE_CANCELLED',policyVersion:n.version,at:now});return ok?n:'CANCELLED' as const;});if(!job)break;if(job==='CANCELLED')continue;
   const controlState=await this.store.snapshot(),control=job.kind==='REPORT'?adminRoomModeWitness(controlState,this.policy,this.policy.ownerId,job.group,job.room,'CONTROL',this.clock()):null;
   const current=async()=>{const s=await this.store.snapshot(),now=this.clock();return clockValid(now)&&eligible(s,this.policy,job,now)&&intact(s,job,now)&&(!control||adminRoomModeWitness(s,this.policy,this.policy.ownerId,job.group,job.room,'CONTROL',now)===control);};
   let result:SendResult='NOT_SENT';
   if(await safe()&&await current()&&
    await adminRoomPrivateAtSend(this.gateway,job.room)&&
    await safe()&&await current()){
    result=await this.sender.send(job.group,job.room,job.kind,
     async()=>await safe()&&await current()&&
      await adminRoomPrivateAtSend(this.gateway,job.room)&&
      await safe()&&await current(),control?job.source:undefined);
   }
   await this.store.transaction(s=>{const now=this.clock();if(s.audit.some(a=>a.updateKey===job.key+':outcome'))return;const consistent=clockValid(now)&&intact(s,job,now)&&eligible(s,this.policy,job,now);s.audit.push({updateKey:job.key+':outcome',decision:'NOOP',reason:'ADMIN_ROOM_NOTICE_'+(consistent?result:'UNKNOWN_OUTCOME'),policyVersion:job.version,at:clockValid(now)?now:job.at});});if(result!=='NOT_SENT')sent++;
  }return sent;
 }
}
/** A deterministic slot claim survives restart; uncertain sends never retry. */
export class AdminRoomDailyDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly gateway:TelegramBotApiModerationGateway,private readonly sender:TelegramAdminRoomNoticeSender,private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 async drain(limit=5):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('ADMIN_ROOM_DAILY_LIMIT_INVALID');const safe=async()=>{try{return await this.safety()===true;}catch{return false;}};let sent=0;
  for(let i=0;i<limit;i++){
   if(!await safe())break;const claim=await this.store.transaction(s=>{const now=this.clock(),target=adminRoomDailyTargets(s,this.policy,now).find(t=>{const prefix='admin-room:daily-send:'+t.id+':'+t.sequence+':';return !s.audit.some(a=>{if(!a.updateKey.startsWith(prefix))return false;const part=a.updateKey.slice(prefix.length);return /^[1-9][0-9]{0,8}$/u.test(part)&&Number(part)>=t.slot;});});if(!target)return null;const key='admin-room:daily-send:'+target.id+':'+target.sequence+':'+target.slot;s.audit.push({updateKey:key,decision:'ALLOW',reason:'ADMIN_ROOM_DAILY_STARTED:'+target.setting,policyVersion:target.version,at:now});return {key,target,at:now};});if(!claim)break;
   const intactDaily=(s:BotState,now:number)=>{const rows=s.audit.filter(a=>a.updateKey===claim.key),a=rows[0],targets=adminRoomDailyTargets(s,this.policy,now).filter(t=>t.id===claim.target.id);return clockValid(now)&&now>=claim.at&&now-claim.at<WINDOW&&rows.length===1&&!!a&&a.decision==='ALLOW'&&a.reason==='ADMIN_ROOM_DAILY_STARTED:'+claim.target.setting&&a.policyVersion===claim.target.version&&a.at===claim.at&&targets.length===1&&JSON.stringify(targets[0])===JSON.stringify(claim.target)&&!s.audit.some(x=>x.updateKey===claim.key+':outcome');};
   const current=async()=>intactDaily(await this.store.snapshot(),this.clock());
   let result:SendResult='NOT_SENT';
   if(await safe()&&await current()&&
    await adminRoomPrivateAtSend(this.gateway,claim.target.room)&&
    await safe()&&await current()){
    result=await this.sender.sendDaily(claim.target,
     async()=>await safe()&&await current()&&
      await adminRoomPrivateAtSend(this.gateway,claim.target.room)&&
      await safe()&&await current());
   }
   await this.store.transaction(s=>{if(s.audit.some(a=>a.updateKey===claim.key+':outcome'))return;const now=this.clock(),valid=intactDaily(s,now);s.audit.push({updateKey:claim.key+':outcome',decision:'NOOP',reason:'ADMIN_ROOM_DAILY_'+(valid?result:'UNKNOWN_OUTCOME'),policyVersion:claim.target.version,at:clockValid(now)?now:claim.at});});if(result!=='NOT_SENT')sent++;
  }return sent;
 }
}
