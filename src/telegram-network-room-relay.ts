import {randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {validGroupNetwork} from './group-network-model.js';
import {adminRoomNotificationTarget} from './admin-room-links.js';
import {networkRoomRelayScope,networkRoomRelayEnabled,
 networkRoomRelayProof,setNetworkRoomRelay} from './network-room-relay.js';

/** NETWORK-006: explicit opt-in for reviewed network event announcements to
 * independently approved NOTIFICATIONS rooms. All controls owner-private.
 */
const PREFIX='network-room-relay-preview:',TTL=120_000,SIZE=8;
const net='([a-f0-9]{12})',grp='(-[1-9][0-9]{0,15})',
 page='(0|[1-9][0-9]{0,2})';
const HOME=new RegExp('^nw:1:rh:'+net+':'+page+'$','u');
const DETAIL=new RegExp('^nw:1:rd:'+net+':'+grp+'$','u');
const PREVIEW=new RegExp('^nw:1:rp:'+net+':'+grp+':([01])$','u');
const CONFIRM=/^nw:1:rc:([A-Za-z0-9_-]{24})$/u;
const CANCEL=/^nw:1:rx:([A-Za-z0-9_-]{24})$/u;
const time=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-TTL;
const person=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const group=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
interface Pending{
 network:string;chat:string;enabled:boolean;
 room:string;link:string;proof:string;createdAt:number;
}
function parse(raw:string):Pending|null{
 let value:unknown;
 try{value=JSON.parse(raw);}catch{return null;}
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='chat,createdAt,enabled,link,network,proof,room'||
  typeof v.network!=='string'||!/^[a-f0-9]{12}$/u.test(v.network)||
  !group(v.chat)||!group(v.room)||v.chat===v.room||
  typeof v.link!=='string'||!/^[A-Za-z0-9_-]{24}$/u.test(v.link)||
  typeof v.enabled!=='boolean'||typeof v.proof!=='string'||
  !/^[a-f0-9]{64}$/u.test(v.proof)||
  typeof v.createdAt!=='number'||!time(v.createdAt))return null;
 return v as unknown as Pending;
}
export const validOwnerNetworkRoomRelayRoute=(value:unknown):boolean=>
 typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
 [HOME,DETAIL,PREVIEW,CONFIRM,CANCEL].some(re=>re.test(value));
export class OwnerNetworkRoomRelay {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private listed(s:BotState,actor:string,id:string,now:number){
  if(!time(now)||!this.policy.isOwner(actor)||
   !this.policy.privateFeature(s,'owner.dashboard',actor))return null;
  const nets=(s.groupNetworks??[]).filter(n=>n.id===id),n=nets[0];
  if(nets.length!==1||!n||!validGroupNetwork(n)||n.updatedAt>now)return null;
  const groups=n.members.map(m=>{
   const scope=networkRoomRelayScope(s,this.policy,actor,id,m.chatId,now);
   if(!scope)return null;
   const enabled=networkRoomRelayEnabled(s,this.policy,actor,id,m.chatId,now);
   if(enabled===null)return null;
   return {id:m.chatId,room:scope.room,enabled};
  }).filter((x):x is {id:string;room:string;enabled:boolean}=>!!x)
   .sort((a,b)=>a.id.localeCompare(b.id));
  return {network:n,groups};
 }
 private home(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const state=this.listed(s,actor,id,now);
  if(!state)return null;
  const pages=Math.max(1,Math.ceil(state.groups.length/SIZE));
  if(p>=pages)return null;
  const rows=state.groups.slice(p*SIZE,(p+1)*SIZE).map(g=>[
   btn((g.enabled?'🔔 ':'🔕 ')+g.id+' · غرفة '+g.room,'nw:1:rd:'+id+':'+g.id)
  ]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:rh:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:rh:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🌐 بطاقة الشبكة','nw:1:d:'+id)]);
  return ui('<b>🏢 توجيه أحداث الشبكة إلى غرف الإدارة</b>\n'+
   'الشبكة: '+esc(state.network.name)+'\n'+
   'المجموعات ذات غرفة تنبيهات معتمدة مستقلة: '+state.groups.length+
   ' · صفحة '+(p+1)+'/'+pages+'\n'+
   '🔔 تعني موافقة المالك على إرسال تنبيه مجرد من هوية الطلاب؛ '+
   'ولا تغيّر اعتماد الغرفة أو صلاحيات الإشراف.\n'+
   'لا تُعرض الغرف المرتبطة بوضع CONTROL أو CENTRAL وحده، '+
   'ولا الغرف التي يفتقد المالك حق إدارتها.\n'+
   'صمت غرفة الإدارة أو طوارئ الشبكة يمنعان أي إرسال.',
   rows);
 }
 private detail(s:BotState,actor:string,now:number,id:string,chat:string):
 OwnerInlineScreen|null{
  const state=this.listed(s,actor,id,now);
  const found=state?.groups.find(g=>g.id===chat);
  if(!state||!found)return null;
  const target=adminRoomNotificationTarget(s,this.policy,chat,now);
  return ui('<b>🏢 تفويض إشعار مراجعات الشبكة</b>\n'+
   'الشبكة: '+esc(state.network.name)+'\n'+
   'المجموعة المصدر: <code>'+chat+'</code>\n'+
   'غرفة التنبيهات المعتمدة: <code>'+found.room+'</code>\n'+
   'موافقة المالك الإضافية: '+(found.enabled?'مفعّلة':'متوقفة')+'\n'+
   'إرسال الغرفة: '+(target?'مسموح محليًا بعد فحوص Telegram':'صامت أو غير متاح')+'\n'+
   'المجال: تغيّر البلاغات المركزية أو مقترحات مراجعة العقوبات فقط.\n'+
   'لا تُرسل هوية طالب أو النص الأصلي أو دليل العقوبة، ولا تظهر أزرار عقوبات.\n'+
   'يلزم تأكيد خاص مستقل، وتُلغى صلاحية الإرسال عند تغيير الربط أو تفويض الشبكة.\n'+
   'لا يمنح هذا التفويض إذن استخدام Telegram لتنفيذ أي إجراء.',
   [[btn(found.enabled?'🔕 مراجعة إلغاء التفويض':'🔔 مراجعة تفعيل التفويض',
     'nw:1:rp:'+id+':'+chat+':'+(found.enabled?'0':'1'))],
    [btn('↩️ غرف الشبكة','nw:1:rh:'+id+':0)],
    [btn('🌐 بطاقة الشبكة','nw:1:d:'+id)]]);
 }
 private async preview(actor:string,id:string,chat:string,enabled:boolean):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),scope=networkRoomRelayScope(s,this.policy,actor,id,chat,now);
   const current=networkRoomRelayEnabled(s,this.policy,actor,id,chat,now),
    proof=networkRoomRelayProof(s,this.policy,actor,id,chat,now);
   if(!time(now)||!scope||current===null||!proof||current===enabled)return null;
   const pending=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)&&
    !c.used&&!c.revoked&&c.expiresAt>now);
   if(pending.length>=100)return null;
   const token=randomBytes(18).toString('base64url'),ref=PREFIX+token;
   if(s.callbacks.some(c=>c.ref===ref))return null;
   for(const old of pending)old.revoked=true;
   const receipt:Pending={network:id,chat,enabled,room:scope.room,
    link:scope.linkId,proof,createdAt:now};
   s.callbacks.push({ref,action:JSON.stringify(receipt),chatId:'private',
    actorId:actor,policyVersion:scope.groupVersion,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة تفويض الغرفة المستقل</b>\n'+
    'المجموعة: <code>'+chat+'</code>\n'+
    'غرفة NOTIFICATIONS: <code>'+scope.room+'</code>\n'+
    'القرار: '+(enabled?'إتاحة إرسال تنبيهات مراجعة الشبكة للغرفة':
     'إيقاف إرسال تنبيهات الشبكة لهذه الغرفة')+'\n'+
    'الأحداث المسموحة: مراجعات البلاغات واقتراحات العقوبات فقط.\n'+
    'يتم منع الإرسال في وضع الصمت أو طوارئ الشبكة، ويُفحص الوضع الخاص للغرفة رسميًا.\n'+
    'التأكيد خاص ولمرة واحدة خلال دقيقتين، دون تغيير أذونات أو إرسال الآن.',
    [[btn('✅ تأكيد القرار','nw:1:rc:'+token)],
     [btn('✖ إلغاء المعاينة','nw:1:rx:'+token)],
     [btn('↩️ بطاقة المجموعة','nw:1:rd:'+id+':'+chat)]]);
  });
 }
 private async decide(actor:string,nonce:string,apply:boolean):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),records=s.callbacks.filter(c=>c.ref===PREFIX+nonce),
    c=records[0];
   if(records.length!==1||!c||!time(now)||!person(actor)||
    c.actorId!==actor||c.chatId!=='private'||!c.oneShot||
    c.used||c.revoked||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   const pending=parse(c.action);
   if(!pending||now<pending.createdAt||c.expiresAt!==pending.createdAt+TTL)return null;
   const scope=networkRoomRelayScope(s,this.policy,actor,
    pending.network,pending.chat,now);
   const proof=networkRoomRelayProof(s,this.policy,actor,
    pending.network,pending.chat,now);
   if(!scope||scope.room!==pending.room||scope.linkId!==pending.link||
    c.policyVersion!==scope.groupVersion||proof!==pending.proof)return null;
   if(apply&&!setNetworkRoomRelay(s,this.policy,actor,pending.network,
    pending.chat,pending.enabled,now))return null;
   c.used=true;
   return ui(apply?'<b>✅ حُفظ تفويض غرفة التنبيهات</b>\n'+
    'المجموعة: <code>'+pending.chat+'</code>\n'+
    'الغرفة: <code>'+pending.room+'</code>\n'+
    'التوجيه: '+(pending.enabled?'مفعّل بتفويض مستقل':'متوقف')+'\n'+
    'لا يغيّر هذا القرار نطاق الحقوق أو موافقات الربط الأصلية.':
    'أُلغيت المعاينة؛ لم يتغير التفويض.',
    [[btn('🏢 تفاصيل المجموعة','nw:1:rd:'+pending.network+':'+pending.chat)],
     [btn('🌐 غرف الشبكة','nw:1:rh:'+pending.network+':0)]]);
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!person(actor)||!this.policy.isOwner(actor)||
   !validOwnerNetworkRoomRelayRoute(data))return null;
  const c=CONFIRM.exec(data);if(c)return this.decide(actor,c[1]!,true);
  const x=CANCEL.exec(data);if(x)return this.decide(actor,x[1]!,false);
  const p=PREVIEW.exec(data);
  if(p)return this.preview(actor,p[1]!,p[2]!,p[3]==='1');
  const snapshot=await this.store.snapshot(),now=this.clock();
  const h=HOME.exec(data);if(h)return this.home(snapshot,actor,now,h[1]!,Number(h[2]));
  const d=DETAIL.exec(data);
  return d?this.detail(snapshot,actor,now,d[1]!,d[2]!):null;
 }
}
