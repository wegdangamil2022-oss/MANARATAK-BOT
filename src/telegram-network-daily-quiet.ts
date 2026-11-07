import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {networkAlertScope} from './network-event-alerts.js';
import {networkDailyQuietCurrent,networkDailyQuietProof,
 setNetworkDailyQuiet,disabledNetworkDailyQuiet,validNetworkDailyQuietChoice,
 type NetworkDailyQuietChoice} from './network-alert-daily-quiet.js';

/** NETWORK-006 recipient-owned daily silence. Private-only caller enforced in
 * transport; a callback on another user's keyboard cannot change preferences.
 * All choices are in explicitly specified *fixed* UTC offsets (not DST zones).
 */
const PREFIX='network-daily-quiet-preview:',TTL=120_000;
const net='([a-f0-9]{12})',chat='(-[1-9][0-9]{0,15})';
const GUIDE=new RegExp('^na:1:qh:'+net+':'+chat+'$','u');
const STOP=new RegExp('^na:1:qz:'+net+':'+chat+'$','u');
const CONFIRM=/^na:1:qc:([A-Za-z0-9_-]{24})$/u;
const CANCEL=/^na:1:qx:([A-Za-z0-9_-]{24})$/u;
const command=/^\/networkquiet ([a-f0-9]{12}) (-[1-9][0-9]{0,15}) ([0-9]{2}:[0-9]{2}) ([0-9]{2}:[0-9]{2}) ([+-][0-9]{2}:[0-9]{2})$/u;
const off=/^\/networkquietoff ([a-f0-9]{12}) (-[1-9][0-9]{0,15})$/u;
const time=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000-TTL;
const actor=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
const gid=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
const fmt=(m:number)=>String(Math.floor(m/60)).padStart(2,'0')+':'+
 String(m%60).padStart(2,'0');
const zone=(minutes:number)=>(minutes>=0?'+':'-')+
 String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')+':'+
 String(Math.abs(minutes)%60).padStart(2,'0');
export function dailyQuietLabel(c:NetworkDailyQuietChoice):string{
 return c.enabled?fmt(c.startMinute)+' — '+fmt(c.endMinute)+
  ' (UTC'+zone(c.offsetMinutes)+' ثابت، يوميًا)':'متوقف';
}
function readClock(s:string):number|null{
 const m=/^([0-9]{2}):([0-9]{2})$/u.exec(s);
 if(!m)return null;
 const hour=Number(m[1]),minute=Number(m[2]);
 return hour<=23&&minute<=59?hour*60+minute:null;
}
function readOffset(s:string):number|null{
 const m=/^([+-])([0-9]{2}):([0-9]{2})$/u.exec(s);
 if(!m)return null;
 const h=Number(m[2]),min=Number(m[3]),
  n=(m[1]==='-'?-1:1)*(h*60+min);
 return h<=14&&min<=59&&n>=-720&&n<=840&&n%15===0?n:null;
}
export const validNetworkDailyQuietRoute=(v:unknown):boolean=>typeof v==='string'&&
 Buffer.byteLength(v,'utf8')<=64&&[GUIDE,STOP,CONFIRM,CANCEL].some(re=>re.test(v));
interface Pending {
 network:string;chat:string;choice:NetworkDailyQuietChoice;
 proof:string;createdAt:number;
}
function parsePending(raw:string):Pending|null{
 let v:unknown;try{v=JSON.parse(raw);}catch{return null;}
 if(!v||typeof v!=='object'||Array.isArray(v))return null;
 const a=v as Record<string,unknown>;
 if(Object.keys(a).sort().join(',')!=='chat,choice,createdAt,network,proof'||
  typeof a.network!=='string'||!/^[a-f0-9]{12}$/u.test(a.network)||
  !gid(a.chat)||!validNetworkDailyQuietChoice(a.choice)||
  typeof a.createdAt!=='number'||!time(a.createdAt)||
  typeof a.proof!=='string'||!/^[a-f0-9]{64}$/u.test(a.proof))return null;
 return a as unknown as Pending;
}
export class TelegramNetworkDailyQuietEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private guide(s:BotState,who:string,network:string,chat:string,now:number):
 OwnerInlineScreen|null{
  const scope=networkAlertScope(s,this.policy,who,network,chat,now);
  if(!scope)return null;
  const current=networkDailyQuietCurrent(s,who,network,chat,now,scope);
  if(!current)return null;
  const example='/networkquiet '+network+' '+chat+' 22:00 08:00 +03:00';
  return ui('<b>🌙 ساعات الصمت اليومية</b>\n'+
   'المجموعة: <code>'+chat+'</code>\n'+
   'الحالة: '+dailyQuietLabel(current)+'\n'+
   'لضبط بداية ونهاية مختلفتين أرسل من خاص البوت:\n'+
   '<code>'+example+'</code>\n'+
   'تنسيق الوقت: HH:MM بالنظام 24 ساعة. الإزاحة ثابتة من UTC بصيغة ±HH:MM.\n'+
   'مثال +03:00 يناسب توقيت اليمن/السعودية دون تغيير موسمي، '+
   'ولا يتابع التوقيت الصيفي في الدول التي تستخدمه.\n'+
   'يعمل الجدول كل يوم ويشمل الفترات العابرة لمنتصف الليل.\n'+
   'أي حدث داخل فترة صمت لن يُرسل عند انتهائها. لا تتغير الاشتراكات أو العقوبات.\n'+
   'إلغاء الجدول يتطلب معاينة وموافقة خاصة، ولا يحرر أحداث الصمت الماضية.',
   [...(current.enabled?[[btn('✖ إلغاء الصمت اليومي','na:1:qz:'+network+':'+chat)]]:[]),
    [btn('↩️ إعدادات المجموعة','na:1:d:'+network+':'+chat)]]);
 }
 private async preview(who:string,network:string,chat:string,
  choice:NetworkDailyQuietChoice):Promise<OwnerInlineScreen|null>{
  if(!validNetworkDailyQuietChoice(choice))return null;
  return this.store.transaction(s=>{
   const now=this.clock(),scope=networkAlertScope(s,this.policy,who,network,chat,now);
   if(!scope||!time(now))return null;
   const proof=networkDailyQuietProof(s,who,network,chat,now,scope),
    current=networkDailyQuietCurrent(s,who,network,chat,now,scope);
   if(!proof||!current||JSON.stringify(current)===JSON.stringify(choice))return null;
   const existing=s.callbacks.filter(c=>c.ref.startsWith(PREFIX)&&
    c.actorId===who&&!c.used&&!c.revoked&&c.expiresAt>now);
   if(existing.length>100)return null;
   const token=randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===PREFIX+token))return null;
   for(const row of existing)row.revoked=true;
   const payload:Pending={network,chat,choice,proof,createdAt:now};
   s.callbacks.push({ref:PREFIX+token,
    action:JSON.stringify(payload),chatId:'private',actorId:who,
    policyVersion:scope.chatVersion,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   return ui('<b>🔎 معاينة تغيير الصمت اليومي</b>\n'+
    'المجموعة: <code>'+chat+'</code>\n'+
    'الحالي: '+dailyQuietLabel(current)+'\n'+
    'المقترح: '+dailyQuietLabel(choice)+'\n'+
    'سيُكتم الإرسال إلى حسابك لهذه المجموعة فقط خلال الفترة المختارة كل يوم.\n'+
    'لن يُعاد إرسال أي حدث وقع خلال الصمت ولو ألغيته لاحقًا.\n'+
    'تأكيد خاص صالح لدقيقتين ولمرة واحدة، ولا يؤثر على صلاحيات Telegram.',
    [[btn('✅ تأكيد تغيير الصمت اليومي','na:1:qc:'+token)],
     [btn('✖ إلغاء المعاينة','na:1:qx:'+token)],
     [btn('↩️ معلومات الصمت','na:1:qh:'+network+':'+chat)]]);
  });
 }
 private async resolve(who:string,nonce:string,commit:boolean):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===PREFIX+nonce),c=rows[0];
   if(rows.length!==1||!c||!time(now)||!actor(who)||
    c.actorId!==who||c.chatId!=='private'||!c.oneShot||
    c.used||c.revoked||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   const data=parsePending(c.action);
   if(!data||now<data.createdAt||c.expiresAt!==data.createdAt+TTL)return null;
   const scope=networkAlertScope(s,this.policy,who,data.network,data.chat,now);
   if(!scope||c.policyVersion!==scope.chatVersion||
    networkDailyQuietProof(s,who,data.network,data.chat,now,scope)!==data.proof)return null;
   if(commit&&!setNetworkDailyQuiet(s,who,data.network,data.chat,data.choice,now,scope))return null;
   c.used=true;
   return ui(commit?'<b>✅ تم حفظ جدول الصمت اليومي</b>\n'+
    'الجدول: '+dailyQuietLabel(data.choice)+'\n'+
    'القرار محفوظ محليًا ويؤثر على إرسال الإشعارات لهذه المجموعة فقط.':
    'ألغيت المعاينة دون تغيير أي إعداد.',[
    [btn('🌙 إعدادات الصمت اليومي','na:1:qh:'+data.network+':'+data.chat)],
    [btn('🔔 إعدادات المجموعة','na:1:d:'+data.network+':'+data.chat)]]);
  });
 }
 async command(who:string,text:string):Promise<OwnerInlineScreen|null>{
  if(!actor(who)||typeof text!=='string'||text.length>160)return null;
  const on=command.exec(text);
  if(on&&gid(on[2])){
   const start=readClock(on[3]!),end=readClock(on[4]!),
    offset=readOffset(on[5]!);
   if(start===null||end===null||offset===null)return null;
   return this.preview(who,on[1]!,on[2]!,{
    enabled:true,startMinute:start,endMinute:end,offsetMinutes:offset});
  }
  const clear=off.exec(text);
  if(clear&&gid(clear[2]))return this.preview(who,clear[1]!,clear[2]!,
   disabledNetworkDailyQuiet());
  return null;
 }
 async handle(who:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!actor(who)||!validNetworkDailyQuietRoute(data))return null;
  const c=CONFIRM.exec(data);
  if(c)return this.resolve(who,c[1]!,true);
  const x=CANCEL.exec(data);
  if(x)return this.resolve(who,x[1]!,false);
  const z=STOP.exec(data);
  if(z)return this.preview(who,z[1]!,z[2]!,disabledNetworkDailyQuiet());
  const d=GUIDE.exec(data);
  if(!d)return null;
  const s=await this.store.snapshot();
  return this.guide(s,who,d[1]!,d[2]!,this.clock());
 }
}
