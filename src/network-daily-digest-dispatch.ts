import {createHash} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {TelegramReplySender,TelegramSendResult} from './telegram-replies.js';
import {dueNetworkDailyDigests,dailyDigestReceiptKey,
 type NetworkDailyDigestDue} from './network-daily-digest.js';

/** NETWORK-006: guarded scheduled one-per-day, per-group, per-recipient
 * PRIVATELY OPTED-IN summary. Never forwards moderation IDs/evidence,
 * never retries an ambiguous Telegram send, and uses safety checks at both
 * claim and dispatch. Not an autonomous enforcement workflow.
 */
const PREFIX='network:digest:send:',EVENT='network:event:send:';
const HASH=/^network:digest:send:[a-f0-9]{64}$/u;
const EVENT_HASH=/^network:event:send:[a-f0-9]{64}$/u;
const time=(x:number)=>Number.isSafeInteger(x)&&x>=86_400_000&&
 x<=8_640_000_000_000_000-86_400_000;
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const summary=(item:NetworkDailyDigestDue)=>[
 item.digest.watch,item.digest.sanction,item.digest.snapshots,
 item.digest.settingsCopy,item.digest.selectedFollows,
 item.digest.total,item.digest.truncated,item.digest.subscriptions,
 item.digest.silenceUntil
];
interface Job{
 key:string;pref:NetworkDailyDigestDue['pref'];
 localDay:number;scheduledAt:number;
 values:ReturnType<typeof summary>;started:number;
}
/** Exactly one durable attempted delivery per local calendar day and
 * preference epoch, even after process crashes or unknown outcomes. */
function intact(s:BotState,job:Job,now:number):boolean{
 if(!time(now)||now<job.started||now-job.started>=120_000||
  now>=job.scheduledAt+600_000)return false;
 const records=s.audit.filter(x=>x.updateKey===job.key),r=records[0];
 return records.length===1&&!!r&&r.decision==='ALLOW'&&
  r.actorId===job.pref.actor&&r.at===job.started&&
  r.policyVersion===job.pref.chatVersion&&
  r.reason==='NETWORK_DAILY_DIGEST_STARTED:'+hash([
   job.pref.key,job.localDay,job.scheduledAt,job.values
  ])&&s.audit.filter(x=>x.updateKey===job.key+':outcome').length===0;
}
function sameDue(s:BotState,p:Policy,job:Job,now:number):boolean{
 const scheduled=dueNetworkDailyDigests(s,p,now);
 if(!scheduled)return false;
 const current=scheduled.find(d=>dailyDigestReceiptKey(d)===job.key&&
  d.localDay===job.localDay&&d.scheduledAt===job.scheduledAt&&
  d.pref.key===job.pref.key);
 return !!current&&hash(summary(current))===hash(job.values);
}
export class NetworkDailyDigestDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly sender:TelegramReplySender,
  private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 private async safe():Promise<boolean>{
  try{return await this.safety()===true;}catch{return false;}
 }
 async drain(limit=3):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)
   throw Error('NETWORK_DAILY_DIGEST_LIMIT_INVALID');
  let attempted=0;
  for(let i=0;i<limit;i++){
   if(!await this.safe())break;
   const job=await this.store.transaction(s=>{
    const now=this.clock();if(!time(now))return null;
    const due=dueNetworkDailyDigests(s,this.policy,now);
    if(!due)return null;
    const recent=s.audit.filter(a=>(HASH.test(a.updateKey)||EVENT_HASH.test(a.updateKey))&&
     a.decision==='ALLOW'&&a.at<=now&&a.at>now-60_000);
    if(recent.length>=100)return null;
    for(const item of due){
     const key=dailyDigestReceiptKey(item);
     if(!key.startsWith(PREFIX)||
      s.audit.some(a=>a.updateKey===key||a.updateKey===key+':outcome')||
      recent.some(a=>a.actorId===item.pref.actor))continue;
     const values=summary(item);
     s.audit.push({updateKey:key,actorId:item.pref.actor,decision:'ALLOW',
      reason:'NETWORK_DAILY_DIGEST_STARTED:'+hash([
       item.pref.key,item.localDay,item.scheduledAt,values
      ]),policyVersion:item.pref.chatVersion,at:now});
     return {key,pref:item.pref,localDay:item.localDay,
      scheduledAt:item.scheduledAt,values,started:now};
    }
    return null;
   });
   if(!job)break;
   const allowed=await this.safe(),snapshot=await this.store.snapshot(),now=this.clock();
   if(!allowed||!intact(snapshot,job,now)||!sameDue(snapshot,this.policy,job,now)){
    await this.finish(job,'UNKNOWN_OUTCOME');continue;
   }
   const [watch,sanction,snapshots,copies,follows,total,truncated]=job.values;
   const message='<b>📬 الملخص الإداري اليومي لشبكتك</b>\n'+
    'المجموعة: <code>'+job.pref.group+'</code>\n'+
    'آخر 24 ساعة من أحدث الأحداث المحلية المتاحة:\n'+
    '• بلاغات مراجعة: '+watch+'\n'+
    '• مقترحات عقوبات للمراجعة: '+sanction+'\n'+
    '• نسخ سياسات محفوظة: '+snapshots+'\n'+
    '• نسخ إعدادات محلية: '+copies+'\n'+
    '• متابعات سياسة مختارة: '+follows+'\n'+
    'إجمالي السجلات المعروضة: '+total+'\n'+
    (truncated?'⚠️ بلغ المصدر حد 200 حدث؛ قد تكون الأرقام جزئية.\n':'')+
    'لا تتضمن الرسالة هوية أي طالب أو أدلة أو نصوص قواعد، '+
    'ولا تسمح بتنفيذ أي عقوبة. إن تغيرت الصلاحيات يتوقف الإرسال.';
   let result:TelegramSendResult;
   try{
    result=await this.sender.send({chatId:job.pref.actor,parseMode:'HTML',
     text:message,inlineMarkup:{inline_keyboard:[[
      {text:'🔔 إدارة إشعارات الشبكة',callback_data:'na:1:h:0'}
     ]]}});
   }catch{result={status:'UNKNOWN_OUTCOME'};}
   const status=result.status==='CONFIRMED'&&Number.isSafeInteger(result.messageId)&&
    result.messageId>0?'CONFIRMED':
    result.status==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
   await this.finish(job,status);
   attempted++;
  }
  return attempted;
 }
 private async finish(job:Job,status:'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'){
  await this.store.transaction(s=>{
   const now=this.clock();
   if(s.audit.some(a=>a.updateKey===job.key+':outcome'))return;
   const valid=intact(s,job,now)&&sameDue(s,this.policy,job,now);
   s.audit.push({updateKey:job.key+':outcome',actorId:job.pref.actor,
    decision:'NOOP',reason:'NETWORK_DAILY_DIGEST_'+(valid?status:'UNKNOWN_OUTCOME'),
    policyVersion:job.pref.chatVersion,at:time(now)?now:job.started});
  });
 }
}
