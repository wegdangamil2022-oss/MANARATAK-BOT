import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {networkAlertScope} from './network-event-alerts.js';
import {networkDailyDigestCurrent,networkDailyDigestProof,
 setNetworkDailyDigest,disabledNetworkDailyDigest,validNetworkDailyDigestChoice,
 type NetworkDailyDigestChoice} from './network-daily-digest.js';

/** No implicit subscription: each manager chooses each group's daily delivery
 * independently and confirms an expiring private, one-shot receipt.
 */
const PREFIX='network-daily-digest-preview:',TTL=120_000;
const net='([a-f0-9]{12})',group='(-[1-9][0-9]{0,15})';
const HOME=new RegExp('^na:1:dg:'+net+':'+group+'$','u');
const DISABLE=new RegExp('^na:1:dz:'+net+':'+group+'$','u');
const CONFIRM=/^na:1:dc:([A-Za-z0-9_-]{24})$/u;
const CANCEL=/^na:1:dx:([A-Za-z0-9_-]{24})$/u;
const command=/^\/networkdigest ([a-f0-9]{12}) (-[1-9][0-9]{0,15}) ([0-9]{2}:[0-9]{2}) ([+-][0-9]{2}:[0-9]{2})$/u;
const off=/^\/networkdigestoff ([a-f0-9]{12}) (-[1-9][0-9]{0,15})$/u;
const time=(n:number)=>Number.isSafeInteger(n)&&n>=86_400_000&&
 n<=8_640_000_000_000_000-TTL;
const who=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
const gid=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
const fmt=(m:number)=>String(Math.floor(m/60)).padStart(2,'0')+':'+
 String(m%60).padStart(2,'0');
const zone=(m:number)=>(m>=0?'+':'-')+
 String(Math.floor(Math.abs(m)/60)).padStart(2,'0')+':'+
 String(Math.abs(m)%60).padStart(2,'0');
export function dailyDigestLabel(c:NetworkDailyDigestChoice):string{
 return c.enabled?'يوميًا '+fmt(c.minute)+' (UTC'+zone(c.offsetMinutes)+' ثابت)':
  'متوقف افتراضيًا';
}
function clock(s:string):number|null{
 const m=/^([0-9]{2}):([0-9]{2})$/u.exec(s);
 if(!m)return null;
 const hour=Number(m[1]),minute=Number(m[2]);
 return hour<=23&&minute<=59?hour*60+minute:null;
}
function offset(s:string):number|null{
 const m=/^([+-])([0-9]{2}):([0-9]{2})$/u.exec(s);
 if(!m)return null;
 const hours=Number(m[2]),min=Number(m[3]);
 const n=(m[1]==='-'?-1:1)*(hours*60+min);
 return hours<=14&&min<=59&&n>=-720&&n<=840&&n%15===0?n:null;
}
export const validNetworkDailyDigestRoute=(v:unknown):boolean=>typeof v==='string'&&
 Buffer.byteLength(v,'utf8')<=64&&[HOME,DISABLE,CONFIRM,CANCEL].some(re=>re.test(v));
interface Preview{
 network:string;chat:string;choice:NetworkDailyDigestChoice;
 proof:string;createdAt:number;
}
function decode(raw:string):Preview|null{
 let v:unknown;try{v=JSON.parse(raw);}catch{return null;}
 if(!v||typeof v!=='object'||Array.isArray(v))return null;
 const a=v as Record<string,unknown>;
 if(Object.keys(a).sort().join(',')!=='chat,choice,createdAt,network,proof'||
  typeof a.network!=='string'||!/^[a-f0-9]{12}$/u.test(a.network)||
  !gid(a.chat)||!validNetworkDailyDigestChoice(a.choice)||
  typeof a.createdAt!=='number'||!time(a.createdAt)||
  typeof a.proof!=='string'||!/^[a-f0-9]{64}$/u.test(a.proof))return null;
 return a as unknown as Preview;
}
export class TelegramNetworkDailyDigestEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private guide(s:BotState,actor:string,network:string,chat:string,at:number):
 OwnerInlineScreen|null{
  const current=networkDailyDigestCurrent(s,this.policy,actor,network,chat,at);
  if(!current)return null;
  const example='/networkdigest '+network+' '+chat+' 09:00 +03:00';
  return ui('<b>📬 ملخص الشبكة اليومي الاختياري</b>\n'+
   'المجموعة: <code>'+chat+'</code>\n'+
   'الجدول الحالي: '+dailyDigestLabel(current)+'\n'+
   'لتفعيل ملخص يومي بوقت محدد، أرسل من خاص البوت:\n'+
   '<code>'+example+'</code>\n'+
   'يستخدم HH:MM بتوقيت 24 ساعة وإزاحة UTC ثابتة. مثال +03:00 '+
   'يمثل توقيت اليمن/السعودية. لا توجد معالجة تلقائية للتوقيت الصيفي.\n'+
   'الإرسال اختياري لهذا المسؤول وهذه المجموعة فقط، مستقل عن الاشتراك في التنبيهات الفورية.\n'+
   'تُرسل إحصاءات مجهولة الهوية: البلاغات ومراجعات العقوبات ونسخ السياسات '+
   'والنسخ المحلي والمتابعات الفردية في آخر 24 ساعة.\n'+
   'نافذة التنفيذ أول 10 دقائق بعد الموعد فقط، ولا تعويض للأيام الفائتة. '+
   'تُحترم ساعات الصمت وحالة STOP والتفويض الحالي عند الإرسال.\n'+
   'قد تكون الأعداد جزئية عند بلوغ حد 200 حدث، وسيُذكر ذلك داخل الرسالة.',
   [...(current.enabled?[[btn('✖ إيقاف الملخص اليومي','na:1:dz:'+network+':'+chat)]]:[]),
    [btn('🧾 ملخص يدوي الآن','na:1:q:'+network+':'+chat+':24')],
    [btn('↩️ إشعارات المجموعة','na:1:d:'+network+':'+chat)]]);
 }
 private async review(actor:string,network:string,chat:string,choice:NetworkDailyDigestChoice):
 Promise<OwnerInlineScreen|null>{
  if(!validNetworkDailyDigestChoice(choice))return null;
  return this.store.transaction(s=>{
   const at=this.clock(),scope=networkAlertScope(s,this.policy,actor,network,chat,at);
   if(!time(at)||!scope)return null;
   const current=networkDailyDigestCurrent(s,this.policy,actor,network,chat,at),
    proof=networkDailyDigestProof(s,this.policy,actor,network,chat,at);
   if(!current||!proof||JSON.stringify(current)===JSON.stringify(choice))return null;
   const pending=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)&&
    !c.used&&!c.revoked&&c.expiresAt>at);
   if(pending.length>100)return null;
   const nonce=randomBytes(18).toString('base64url'),ref=PREFIX+nonce;
   if(s.callbacks.some(c=>c.ref===ref))return null;
   for(const row of pending)row.revoked=true;
   const data:Preview={network,chat,choice,proof,createdAt:at};
   s.callbacks.push({ref,action:JSON.stringify(data),chatId:'private',
    actorId:actor,policyVersion:scope.chatVersion,expiresAt:at+TTL,
    oneShot:true,used:false,revoked:false});
   return ui('<b>🔎 معاينة اشتراك الملخص اليومي</b>\n'+
    'المجموعة: <code>'+chat+'</code>\n'+
    'السابق: '+dailyDigestLabel(current)+'\n'+
    'المطلوب: '+dailyDigestLabel(choice)+'\n'+
    'الإرسال إلى حسابك الشخصي فقط. كل مجموعة تحتاج موافقة مستقلة.\n'+
    'لا استعادة لأيام سابقة، ولا إرسال أثناء الصمت أو بعد زوال التفويض.\n'+
    'بصمة المعاينة وصلاحيتها تتحققان عند التأكيد خلال دقيقتين ولمرة واحدة.',
    [[btn('✅ تأكيد الجدول','na:1:dc:'+nonce)],
     [btn('✖ إلغاء المعاينة','na:1:dx:'+nonce)],
     [btn('↩️ إعدادات الملخص','na:1:dg:'+network+':'+chat)]]);
  });
 }
 private async decide(actor:string,nonce:string,apply:boolean):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const at=this.clock(),matches=s.callbacks.filter(c=>c.ref===PREFIX+nonce),c=matches[0];
   if(matches.length!==1||!c||!time(at)||!who(actor)||
    c.actorId!==actor||c.chatId!=='private'||!c.oneShot||
    c.used||c.revoked||c.expiresAt<=at||c.expiresAt>at+TTL)return null;
   const value=decode(c.action);
   if(!value||at<value.createdAt||c.expiresAt!==value.createdAt+TTL)return null;
   const scope=networkAlertScope(s,this.policy,actor,value.network,value.chat,at);
   if(!scope||c.policyVersion!==scope.chatVersion||
    networkDailyDigestProof(s,this.policy,actor,value.network,value.chat,at)!==value.proof)
    return null;
   if(apply&&!setNetworkDailyDigest(s,this.policy,actor,value.network,value.chat,
    value.choice,at))return null;
   c.used=true;
   return ui(apply?'<b>✅ تم حفظ اشتراك الملخص اليومي</b>\n'+
    'الجدول: '+dailyDigestLabel(value.choice)+'\n'+
    'لا يُرسل شيء قبل الموعد التالي وفق الصلاحيات وبوابة السلامة.':
    'أُلغيت معاينة الجدول دون تغيير.',[
    [btn('📬 إعدادات الملخص','na:1:dg:'+value.network+':'+value.chat)],
    [btn('🔔 إشعارات المجموعة','na:1:d:'+value.network+':'+value.chat)]]);
  });
 }
 async command(actor:string,input:string):Promise<OwnerInlineScreen|null>{
  if(!who(actor)||typeof input!=='string'||input.length>150)return null;
  const m=command.exec(input);
  if(m&&gid(m[2])){
   const minute=clock(m[3]!),off=offset(m[4]!);
   if(minute===null||off===null)return null;
   return this.review(actor,m[1]!,m[2]!,{
    enabled:true,minute,offsetMinutes:off});
  }
  const n=off.exec(input);
  if(n&&gid(n[2]))return this.review(actor,n[1]!,n[2]!,disabledNetworkDailyDigest());
  return null;
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!who(actor)||!validNetworkDailyDigestRoute(data))return null;
  const c=CONFIRM.exec(data);if(c)return this.decide(actor,c[1]!,true);
  const x=CANCEL.exec(data);if(x)return this.decide(actor,x[1]!,false);
  const d=DISABLE.exec(data);
  if(d)return this.review(actor,d[1]!,d[2]!,disabledNetworkDailyDigest());
  const home=HOME.exec(data);
  if(!home)return null;
  const state=await this.store.snapshot();
  return this.guide(state,actor,home[1]!,home[2]!,this.clock());
 }
}
