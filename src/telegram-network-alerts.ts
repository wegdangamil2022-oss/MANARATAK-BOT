import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {validGroupNetwork} from './group-network-model.js';
import {networkAlertScope,networkAlertEnabled,networkAlertConsentProof,
 setNetworkAlertPreference,type NetworkAlertKind} from './network-event-alerts.js';
import {networkAlertSilenceUntil,networkAlertSilenceProof,setNetworkAlertSilence}
 from './network-alert-silence.js';

/** Private-chat-only caller. Each recipient consents for *their own* managed
 * group; neither an owner choice nor membership in a network grants access. */
const net='([a-f0-9]{12})',group='(-[1-9][0-9]{0,15})',page='(0|[1-9][0-9]{0,2})';
const HOME=new RegExp('^na:1:h:'+page+'$','u');
const GROUPS=new RegExp('^na:1:g:'+net+':'+page+'$','u');
const DETAIL=new RegExp('^na:1:d:'+net+':'+group+'$','u');
const PREVIEW=new RegExp('^na:1:p:'+net+':'+group+':([wrs])$','u');
const CONFIRM=/^na:1:c:([A-Za-z0-9_-]{24})$/u;
const CANCEL=/^na:1:x:([A-Za-z0-9_-]{24})$/u;
const SILENCE=new RegExp('^na:1:z:'+net+':'+group+':([018])
const person=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-TTL;
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const names:Record<NetworkAlertKind,string>={
 w:'🛡️ البلاغات',r:'⚖️ مقترحات مراجعة العقوبات',s:'📸 حفظ نسخ السياسات'
};
export function validNetworkAlertRoute(value:unknown):boolean{
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
 [HOME,GROUPS,DETAIL,PREVIEW,CONFIRM,CANCEL,SILENCE,SILENCE_CONFIRM,SILENCE_CANCEL].some(x=>x.test(value));
}
interface Preview {network:string;chat:string;kind:NetworkAlertKind;
 proof:string;createdAt:number;enabled:boolean;}
function parsePreview(c:string):Preview|null{
 let obj:unknown;try{obj=JSON.parse(c);}catch{return null;}
 if(!obj||typeof obj!=='object'||Array.isArray(obj))return null;
 const x=obj as Record<string,unknown>;
 if(Object.keys(x).sort().join(',')!=='chat,createdAt,enabled,kind,network,proof'||
  typeof x.network!=='string'||!/^[a-f0-9]{12}$/u.test(x.network)||
  typeof x.chat!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(x.chat)||
  !Number.isSafeInteger(Number(x.chat))||!['w','r','s'].includes(String(x.kind))||
  typeof x.proof!=='string'||!/^[a-f0-9]{64}$/u.test(x.proof)||
  typeof x.enabled!=='boolean'||!time(x.createdAt))return null;
 return x as unknown as Preview;
}
interface SilencePreview {network:string;chat:string;hours:0|1|8;proof:string;createdAt:number;}
function parseSilencePreview(raw:string):SilencePreview|null{
 let value:unknown;
 try{value=JSON.parse(raw);}catch{return null;}
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='chat,createdAt,hours,network,proof'||
  typeof v.network!=='string'||!/^[a-f0-9]{12}$/u.test(v.network)||
  typeof v.chat!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(v.chat)||
  !Number.isSafeInteger(Number(v.chat))||
  ![0,1,8].includes(v.hours as number)||!Number.isInteger(v.hours)||
  typeof v.proof!=='string'||!/^[a-f0-9]{64}$/u.test(v.proof)||
  !time(v.createdAt))return null;
 return v as unknown as SilencePreview;
}
export class TelegramNetworkAlertEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private networks(s:BotState,actor:string,now:number){
  return (s.groupNetworks??[]).filter(n=>validGroupNetwork(n)&&n.updatedAt<=now&&
   n.members.some(m=>networkAlertScope(s,this.policy,actor,n.id,m.chatId,now)!==null))
   .sort((a,b)=>a.id.localeCompare(b.id));
 }
 private groupIds(s:BotState,actor:string,now:number,network:string){
  const rows=(s.groupNetworks??[]).filter(x=>x.id===network);
  if(rows.length!==1||!rows[0]||!validGroupNetwork(rows[0]))return null;
  return rows[0].members.filter(m=>networkAlertScope(s,this.policy,actor,network,m.chatId,now))
   .map(x=>x.chatId).sort((a,b)=>a.localeCompare(b));
 }
 private home(s:BotState,actor:string,now:number,p:number):OwnerInlineScreen|null{
  const networks=this.networks(s,actor,now),pages=Math.max(1,Math.ceil(networks.length/SIZE));
  if(p>=pages)return null;
  const rows=networks.slice(p*SIZE,(p+1)*SIZE)
   .map(n=>[btn('🌐 '+n.name,'na:1:g:'+n.id+':0')]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','na:1:h:'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','na:1:h:'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🏠 القائمة الرئيسية','pn:1:h')]);
  return ui('<b>🔔 إشعارات الشبكات الخاصة</b>\n'+
   'اختر شبكة ثم مجموعة لديك حق إدارتها، وحدد أنواع الأحداث التي تريد استقبالها.\n'+
   'كل الاشتراكات متوقفة افتراضيًا، ولا يرسل البوت تفاصيل حساسة أو عقوبات.\n'+
   'عدد الشبكات المخوّلة: '+networks.length+' · صفحة '+(p+1)+'/'+pages,rows);
 }
 private groups(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const groups=this.groupIds(s,actor,now,id);if(!groups||groups.length===0)return null;
  const pages=Math.max(1,Math.ceil(groups.length/SIZE));
  if(p>=pages)return null;
  const rows=groups.slice(p*SIZE,(p+1)*SIZE)
   .map(idGroup=>[btn('👥 '+idGroup,'na:1:d:'+id+':'+idGroup)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','na:1:g:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','na:1:g:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ الشبكات','na:1:h:0')]);
  return ui('<b>👥 مجموعات الشبكة المخوّلة لك</b>\n'+
   'اختر مجموعة لتحديد إشعاراتها الشخصية. لا تظهر المجموعات بلا تفويض صالح.\n'+
   'عدد المجموعات: '+groups.length+' · صفحة '+(p+1)+'/'+pages,rows);
 }
 private detail(s:BotState,actor:string,now:number,network:string,chat:string):OwnerInlineScreen|null{
  if(!networkAlertScope(s,this.policy,actor,network,chat,now))return null;
  const silence=networkAlertSilenceUntil(s,this.policy,actor,network,chat,now);
  if(silence===null)return null;
  const rows=(Object.keys(names) as NetworkAlertKind[]).map(kind=>[
   btn((networkAlertEnabled(s,this.policy,actor,network,chat,kind,now)?
    '🔔 مفعّلة · ':'🔕 متوقفة · ')+names[kind],
    'na:1:p:'+network+':'+chat+':'+kind)]);
  rows.push([btn('🔕 صمت ساعة','na:1:z:'+network+':'+chat+':1'),
   btn('🌙 صمت 8 ساعات','na:1:z:'+network+':'+chat+':8')]);
  if(silence>now)rows.push([btn('🔔 إلغاء الصمت','na:1:z:'+network+':'+chat+':0')]);
  rows.push([btn('↩️ مجموعات الشبكة','na:1:g:'+network+':0')]);
  return ui('<b>🔔 تفضيلات إشعارات الشبكة</b>\n'+
   'المجموعة: <code>'+escape(chat)+'</code>\n'+
   'الصمت المؤقت: '+(silence>now?'مفعّل حتى '+new Date(silence).toISOString().slice(0,16)+' UTC':'غير مفعّل')+'\n'+
   'استلام الرسائل اختياري وشخصي، ولا يُرسل نص البلاغ أو هوية الطالب.\n'+
   'أوقف النوع أو فعّل الصمت المؤقت في أي وقت. لا تُرسل أحداث سابقة لتفعيلك.',rows);
 }
 private async silencePreview(actor:string,network:string,chat:string,hours:0|1|8):
  Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),proof=networkAlertSilenceProof(s,this.policy,actor,network,chat,now);
   const until=networkAlertSilenceUntil(s,this.policy,actor,network,chat,now);
   if(!proof||!time(now)||until===null||(hours===0&&until<=now))return null;
   const scope=networkAlertScope(s,this.policy,actor,network,chat,now)!;
   const ref=randomBytes(18).toString('base64url');
   for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(SILENCE_PREFIX)&&!c.used)c.revoked=true;
   s.callbacks.push({ref:SILENCE_PREFIX+ref,
    action:JSON.stringify({network,chat,hours,proof,createdAt:now}),
    chatId:'private',actorId:actor,policyVersion:scope.chatVersion,
    expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
   const label=hours===0?'إلغاء الصمت':hours===1?'كتم الإشعارات لمدة ساعة':'كتم الإشعارات لمدة 8 ساعات';
   return ui('<b>🔕 معاينة الصمت المؤقت</b>\nالمجموعة: <code>'+escape(chat)+'</code>\n'+
    'القرار: '+label+'\n'+
    'ينطبق على تنبيهات هذه المجموعة فقط، ولا يغير الاشتراكات أو العقوبات.\n'+
    'أحداث فترة الصمت لن تُرسل لاحقًا. التأكيد صالح لدقيقتين ولمرة واحدة.',[
     [btn('✅ تأكيد '+label,'na:1:zc:'+ref)],
     [btn('✖ إلغاء','na:1:zx:'+ref)]]);
  });
 }
 private async resolveSilence(actor:string,ref:string,apply:boolean):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===SILENCE_PREFIX+ref),c=rows[0];
   if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||!c.oneShot||
    c.used||c.revoked||!time(now)||now>=c.expiresAt||c.expiresAt>now+TTL||
    !person(actor))return null;
   const data=parseSilencePreview(c.action);
   if(!data||now<data.createdAt||c.expiresAt!==data.createdAt+TTL)return null;
   const scope=networkAlertScope(s,this.policy,actor,data.network,data.chat,now);
   if(!scope||scope.chatVersion!==c.policyVersion||
    networkAlertSilenceProof(s,this.policy,actor,data.network,data.chat,now)!==data.proof)return null;
   if(apply&&!setNetworkAlertSilence(s,this.policy,actor,data.network,data.chat,data.hours,now))return null;
   c.used=true;
   return apply?this.detail(s,actor,now,data.network,data.chat):
    ui('أُلغيت معاينة الصمت دون تغيير.',[[btn('↩️ العودة','na:1:d:'+data.network+':'+data.chat)]]);
  });
 }
 private async preview(actor:string,network:string,chat:string,kind:NetworkAlertKind):
  Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),proof=networkAlertConsentProof(s,this.policy,actor,network,chat,kind,now);
   if(!proof||!time(now))return null;
   const enabled=networkAlertEnabled(s,this.policy,actor,network,chat,kind,now),
    ref=randomBytes(18).toString('base64url');
   for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used)c.revoked=true;
   const scope=networkAlertScope(s,this.policy,actor,network,chat,now)!;
   s.callbacks.push({ref:PREFIX+ref,action:JSON.stringify({network,chat,kind,proof,createdAt:now,enabled}),
    chatId:'private',actorId:actor,policyVersion:scope.chatVersion,
    expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
   return ui('<b>🔔 معاينة الاشتراك الشخصي</b>\n'+
    'المجموعة: <code>'+escape(chat)+'</code>\n'+
    'النوع: '+names[kind]+'\n'+
    'القرار: '+(enabled?'إيقاف الإشعار':'تفعيل الإشعار')+
    '\nيسري فقط أثناء صلاحية تفويضك، ولا يسمح بإجراء عقوبة.\n'+
    'التأكيد لمرة واحدة خلال دقيقتين.',[
     [btn('✅ تأكيد '+(enabled?'الإيقاف':'التفعيل'),'na:1:c:'+ref)],
     [btn('✖ إلغاء','na:1:x:'+ref)]]);
  });
 }
 private async resolve(actor:string,ref:string,apply:boolean):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===PREFIX+ref),c=rows[0];
   if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||!c.oneShot||
    c.used||c.revoked||!time(now)||now>=c.expiresAt||c.expiresAt>now+TTL||
    !person(actor))return null;
   const data=parsePreview(c.action);
   if(!data||c.expiresAt!==data.createdAt+TTL||now<data.createdAt)return null;
   const scope=networkAlertScope(s,this.policy,actor,data.network,data.chat,now);
   if(!scope||c.policyVersion!==scope.chatVersion||
    networkAlertConsentProof(s,this.policy,actor,data.network,data.chat,data.kind,now)!==data.proof||
    networkAlertEnabled(s,this.policy,actor,data.network,data.chat,data.kind,now)!==data.enabled)return null;
   if(apply&&!setNetworkAlertPreference(s,this.policy,actor,data.network,data.chat,data.kind,now))return null;
   c.used=true;
   return apply?this.detail(s,actor,now,data.network,data.chat):
    ui('أُلغيت المعاينة دون تعديل الاشتراك.',[[btn('↩️ العودة','na:1:d:'+data.network+':'+data.chat)]]);
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!person(actor)||!validNetworkAlertRoute(data))return null;
  const zc=SILENCE_CONFIRM.exec(data);if(zc)return this.resolveSilence(actor,zc[1]!,true);
  const zx=SILENCE_CANCEL.exec(data);if(zx)return this.resolveSilence(actor,zx[1]!,false);
  const z=SILENCE.exec(data);if(z)return this.silencePreview(actor,z[1]!,z[2]!,Number(z[3]) as 0|1|8);
  const c=CONFIRM.exec(data);if(c)return this.resolve(actor,c[1]!,true);
  const x=CANCEL.exec(data);if(x)return this.resolve(actor,x[1]!,false);
  const p=PREVIEW.exec(data);
  if(p)return this.preview(actor,p[1]!,p[2]!,p[3] as NetworkAlertKind);
  const s=await this.store.snapshot(),now=this.clock();
  if(!time(now))return null;
  const h=HOME.exec(data);if(h)return this.home(s,actor,now,Number(h[1]));
  const g=GROUPS.exec(data);if(g)return this.groups(s,actor,now,g[1]!,Number(g[2]));
  const d=DETAIL.exec(data);if(d)return this.detail(s,actor,now,d[1]!,d[2]!);
  return null;
 }
}
,'u');
const SILENCE_CONFIRM=/^na:1:zc:([A-Za-z0-9_-]{24})$/u;
const SILENCE_CANCEL=/^na:1:zx:([A-Za-z0-9_-]{24})$/u;
const SILENCE_PREFIX='network-silence-preview:';
const PREFIX='network-alert-preview:',TTL=120_000,SIZE=8;
const person=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-TTL;
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const names:Record<NetworkAlertKind,string>={
 w:'🛡️ البلاغات',r:'⚖️ مقترحات مراجعة العقوبات',s:'📸 حفظ نسخ السياسات'
};
export function validNetworkAlertRoute(value:unknown):boolean{
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
 [HOME,GROUPS,DETAIL,PREVIEW,CONFIRM,CANCEL].some(x=>x.test(value));
}
interface Preview {network:string;chat:string;kind:NetworkAlertKind;
 proof:string;createdAt:number;enabled:boolean;}
function parsePreview(c:string):Preview|null{
 let obj:unknown;try{obj=JSON.parse(c);}catch{return null;}
 if(!obj||typeof obj!=='object'||Array.isArray(obj))return null;
 const x=obj as Record<string,unknown>;
 if(Object.keys(x).sort().join(',')!=='chat,createdAt,enabled,kind,network,proof'||
  typeof x.network!=='string'||!/^[a-f0-9]{12}$/u.test(x.network)||
  typeof x.chat!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(x.chat)||
  !Number.isSafeInteger(Number(x.chat))||!['w','r','s'].includes(String(x.kind))||
  typeof x.proof!=='string'||!/^[a-f0-9]{64}$/u.test(x.proof)||
  typeof x.enabled!=='boolean'||!time(x.createdAt))return null;
 return x as unknown as Preview;
}
export class TelegramNetworkAlertEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private networks(s:BotState,actor:string,now:number){
  return (s.groupNetworks??[]).filter(n=>validGroupNetwork(n)&&n.updatedAt<=now&&
   n.members.some(m=>networkAlertScope(s,this.policy,actor,n.id,m.chatId,now)!==null))
   .sort((a,b)=>a.id.localeCompare(b.id));
 }
 private groupIds(s:BotState,actor:string,now:number,network:string){
  const rows=(s.groupNetworks??[]).filter(x=>x.id===network);
  if(rows.length!==1||!rows[0]||!validGroupNetwork(rows[0]))return null;
  return rows[0].members.filter(m=>networkAlertScope(s,this.policy,actor,network,m.chatId,now))
   .map(x=>x.chatId).sort((a,b)=>a.localeCompare(b));
 }
 private home(s:BotState,actor:string,now:number,p:number):OwnerInlineScreen|null{
  const networks=this.networks(s,actor,now),pages=Math.max(1,Math.ceil(networks.length/SIZE));
  if(p>=pages)return null;
  const rows=networks.slice(p*SIZE,(p+1)*SIZE)
   .map(n=>[btn('🌐 '+n.name,'na:1:g:'+n.id+':0')]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','na:1:h:'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','na:1:h:'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🏠 القائمة الرئيسية','pn:1:h')]);
  return ui('<b>🔔 إشعارات الشبكات الخاصة</b>\n'+
   'اختر شبكة ثم مجموعة لديك حق إدارتها، وحدد أنواع الأحداث التي تريد استقبالها.\n'+
   'كل الاشتراكات متوقفة افتراضيًا، ولا يرسل البوت تفاصيل حساسة أو عقوبات.\n'+
   'عدد الشبكات المخوّلة: '+networks.length+' · صفحة '+(p+1)+'/'+pages,rows);
 }
 private groups(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const groups=this.groupIds(s,actor,now,id);if(!groups||groups.length===0)return null;
  const pages=Math.max(1,Math.ceil(groups.length/SIZE));
  if(p>=pages)return null;
  const rows=groups.slice(p*SIZE,(p+1)*SIZE)
   .map(idGroup=>[btn('👥 '+idGroup,'na:1:d:'+id+':'+idGroup)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','na:1:g:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','na:1:g:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ الشبكات','na:1:h:0')]);
  return ui('<b>👥 مجموعات الشبكة المخوّلة لك</b>\n'+
   'اختر مجموعة لتحديد إشعاراتها الشخصية. لا تظهر المجموعات بلا تفويض صالح.\n'+
   'عدد المجموعات: '+groups.length+' · صفحة '+(p+1)+'/'+pages,rows);
 }
 private detail(s:BotState,actor:string,now:number,network:string,chat:string):OwnerInlineScreen|null{
  if(!networkAlertScope(s,this.policy,actor,network,chat,now))return null;
  const rows=(Object.keys(names) as NetworkAlertKind[]).map(kind=>[
   btn((networkAlertEnabled(s,this.policy,actor,network,chat,kind,now)?
    '🔔 مفعّلة · ':'🔕 متوقفة · ')+names[kind],
    'na:1:p:'+network+':'+chat+':'+kind)]);
  rows.push([btn('↩️ مجموعات الشبكة','na:1:g:'+network+':0')]);
  const statuses=(Object.keys(names) as NetworkAlertKind[]).map(kind=>
   names[kind]+': '+(networkAlertEnabled(s,this.policy,actor,network,chat,kind,now)?
    'مفعّلة':'متوقفة')).join('\n');
  return ui('<b>🔔 تفضيلات إشعارات الشبكة</b>\n'+
   'المجموعة: <code>'+escape(chat)+'</code>\n'+statuses+'\n'+
   'استلام الرسائل اختياري وشخصي، ولا يُرسل نص البلاغ أو هوية الطالب.\n'+
   'أوقف النوع الذي لا تريد استلامه في أي وقت. لا تُرسل أحداث سابقة لتفعيلك.',rows);
 }
 private async preview(actor:string,network:string,chat:string,kind:NetworkAlertKind):
  Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),proof=networkAlertConsentProof(s,this.policy,actor,network,chat,kind,now);
   if(!proof||!time(now))return null;
   const enabled=networkAlertEnabled(s,this.policy,actor,network,chat,kind,now),
    ref=randomBytes(18).toString('base64url');
   for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used)c.revoked=true;
   const scope=networkAlertScope(s,this.policy,actor,network,chat,now)!;
   s.callbacks.push({ref:PREFIX+ref,action:JSON.stringify({network,chat,kind,proof,createdAt:now,enabled}),
    chatId:'private',actorId:actor,policyVersion:scope.chatVersion,
    expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
   return ui('<b>🔔 معاينة الاشتراك الشخصي</b>\n'+
    'المجموعة: <code>'+escape(chat)+'</code>\n'+
    'النوع: '+names[kind]+'\n'+
    'القرار: '+(enabled?'إيقاف الإشعار':'تفعيل الإشعار')+
    '\nيسري فقط أثناء صلاحية تفويضك، ولا يسمح بإجراء عقوبة.\n'+
    'التأكيد لمرة واحدة خلال دقيقتين.',[
     [btn('✅ تأكيد '+(enabled?'الإيقاف':'التفعيل'),'na:1:c:'+ref)],
     [btn('✖ إلغاء','na:1:x:'+ref)]]);
  });
 }
 private async resolve(actor:string,ref:string,apply:boolean):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===PREFIX+ref),c=rows[0];
   if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||!c.oneShot||
    c.used||c.revoked||!time(now)||now>=c.expiresAt||c.expiresAt>now+TTL||
    !person(actor))return null;
   const data=parsePreview(c.action);
   if(!data||c.expiresAt!==data.createdAt+TTL||now<data.createdAt)return null;
   const scope=networkAlertScope(s,this.policy,actor,data.network,data.chat,now);
   if(!scope||c.policyVersion!==scope.chatVersion||
    networkAlertConsentProof(s,this.policy,actor,data.network,data.chat,data.kind,now)!==data.proof||
    networkAlertEnabled(s,this.policy,actor,data.network,data.chat,data.kind,now)!==data.enabled)return null;
   if(apply&&!setNetworkAlertPreference(s,this.policy,actor,data.network,data.chat,data.kind,now))return null;
   c.used=true;
   return apply?this.detail(s,actor,now,data.network,data.chat):
    ui('أُلغيت المعاينة دون تعديل الاشتراك.',[[btn('↩️ العودة','na:1:d:'+data.network+':'+data.chat)]]);
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!person(actor)||!validNetworkAlertRoute(data))return null;
  const c=CONFIRM.exec(data);if(c)return this.resolve(actor,c[1]!,true);
  const x=CANCEL.exec(data);if(x)return this.resolve(actor,x[1]!,false);
  const p=PREVIEW.exec(data);
  if(p)return this.preview(actor,p[1]!,p[2]!,p[3] as NetworkAlertKind);
  const s=await this.store.snapshot(),now=this.clock();
  if(!time(now))return null;
  const h=HOME.exec(data);if(h)return this.home(s,actor,now,Number(h[1]));
  const g=GROUPS.exec(data);if(g)return this.groups(s,actor,now,g[1]!,Number(g[2]));
  const d=DETAIL.exec(data);if(d)return this.detail(s,actor,now,d[1]!,d[2]!);
  return null;
 }
}
