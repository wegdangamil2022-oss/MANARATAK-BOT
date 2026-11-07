import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {networkRoomBridgeSummary,type NetworkRoomBridgeRow}
 from './network-room-bridge.js';

/** Owner-private, read-only network <-> approved administrative rooms.
 * Never provides room IDs when the current owner cannot manage that room.
 */
const net='([a-f0-9]{12})',group='(-[1-9][0-9]{0,15})',
 page='(0|[1-9][0-9]{0,2})',SIZE=8;
const LIST=new RegExp('^nw:1:rl:'+net+':'+page+'$','u');
const DETAIL=new RegExp('^nw:1:rg:'+net+':'+group+'$','u');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(x:string)=>x.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const names:Record<NetworkRoomBridgeRow['status'],string>={
 ACTIVE:'غرفة إشعارات معتمدة مع إرسال غير موقوف محليًا',
 QUIET:'غرفة إشعارات معتمدة لكنها في وضع الصمت الخاص بالغرفة',
 UNLINKED:'لا يوجد رابط إشعارات نشط قابل للتحقق لهذه المجموعة',
 ROOM_NOT_AUTHORIZED:'يوجد رابط إشعارات لكن لا تملك حق إدارة الغرفة أو أن الدليل غير صالح'
};
const marker:Record<NetworkRoomBridgeRow['status'],string>={
 ACTIVE:'🔔',QUIET:'🔕',UNLINKED:'▫️',ROOM_NOT_AUTHORIZED:'🔐'
};
export function validNetworkRoomBridgeRoute(data:unknown):boolean{
 return typeof data==='string'&&Buffer.byteLength(data,'utf8')<=64&&
  (LIST.test(data)||DETAIL.test(data));
}
export class OwnerNetworkRoomBridge{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validNetworkRoomBridgeRoute(data))return null;
  const list=LIST.exec(data),detail=DETAIL.exec(data),id=(list??detail)?.[1];
  if(!id)return null;
  const s=await this.store.snapshot(),now=this.clock(),
   report=networkRoomBridgeSummary(s,this.policy,actor,id,now);
  if(!report)return null;
  if(detail){
   const row=report.rows.find(x=>x.groupId===detail[2]);
   if(!row)return null;
   return ui('<b>🏢 تفويض غرفة إدارة لمجموعة الشبكة</b>\n'+
    'الشبكة: '+escape(report.networkName)+'\n'+
    'المجموعة: <code>'+row.groupId+'</code>'+
    ' · اعتماد '+row.groupVersion+'\n'+
    'الحالة: '+names[row.status]+'\n'+
    (row.roomId!==null?'الغرفة المخوّل بإدارتها: <code>'+row.roomId+'</code>\n':
     'لا نعرض معرّف أي غرفة لا تملك صلاحية إدارتها الحالية.\n')+
    (row.pendingReviews!==null?'حالات تنتظر مراجعة بشرية: '+row.pendingReviews+'\n':'')+
    (row.overdue72h!==null?'↳ تجاوزت 72 ساعة: '+row.overdue72h+'\n':'')+
    (row.events24h!==null?
     'أحداث إدارية محلية مرئية آخر 24 ساعة: '+row.events24h+'\n':'')+
    (row.truncated?'⚠️ حد العرض 200 حدث؛ العدد قد يكون جزئيًا.\n':'')+
    'توثيق الغرفة مستقل عن عضوية الشبكة: يلزم تفويض المجموعة '+
    'والغرفة بنمط NOTIFICATIONS. \n'+
    'هذه قراءة محلية، ولا تثبت صلاحيات Telegram الحية، '+
    'ولا ترسل بلاغات أو بيانات طلاب إلى الغرفة.',
    [[btn('🔔 موافقة توجيه مراجعات الشبكة','nw:1:rh:'+id+':0')],
     [btn('🏢 إدارة روابط الغرف','al:1:h:0')],
     [btn('➕ طلب ربط إشعارات جديد','al:1:n:notifications')],
     [btn('🔔 أحداث المجموعة في الشبكة','nw:1:ev:'+id+':0')],
     [btn('↩️ غرف الشبكة','nw:1:rl:'+id+':0)]]);
  }
  const pageNo=Number(list![2]),
   pages=Math.max(1,Math.ceil(report.rows.length/SIZE));
  if(pageNo>=pages)return null;
  const rows:{text:string;callback_data:string}[][]=report.rows
   .slice(pageNo*SIZE,(pageNo+1)*SIZE)
   .map(g=>[btn(marker[g.status]+' '+g.groupId,
    'nw:1:rg:'+id+':'+g.groupId)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(pageNo)nav.push(btn('⬅️ السابق','nw:1:rl:'+id+':'+(pageNo-1)));
  if(pageNo+1<pages)nav.push(btn('➡️ التالي','nw:1:rl:'+id+':'+(pageNo+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('➕ ربط غرفة إشعارات','al:1:n:notifications')]);
  rows.push([btn('🔔 مراجعة تفويض الإشعارات للغرف','nw:1:rh:'+id+':0')]);
  rows.push([btn('🏢 إدارة الغرف','al:1:h:0'),
   btn('🔔 أحداث الشبكة','nw:1:ev:'+id+':0')]);
  rows.push([btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]);
  return ui('<b>🏢 تكامل الشبكة وغرف الإدارة</b>\n'+
   'الشبكة: '+escape(report.networkName)+' · الإصدار '+report.networkRevision+'\n'+
   (report.networkStopped?'⛔ الشبكة موقوفة طارئًا؛ لا تصدر منها ملخصات شبكة تلقائية.\n':'')+
   'المجموعات ذات الصلاحية المحلية: '+report.eligibleGroups+
   ' · صفحة '+(pageNo+1)+'/'+pages+'\n'+
   'غرفة إشعارات فعالة: '+report.linked+
   ' · غرفة صامتة: '+report.quiet+'\n'+
   'لا يوجد ربط إشعارات: '+report.unlinked+
   ' · غرفة بلا تفويض صالح لهذا المالك: '+report.unauthorizedRooms+'\n'+
   'كل مجموعة وغرفة تحتاجان تفويضًا مستقلًا؛ الشبكة لا تمنح أي صلاحية.\n'+
   'عرض حالة الربط للقراءة فقط. لتفعيل إرسال أحداث مراجعات الشبكة يلزم تفويض ثالث مستقل من المالك.',
   rows);
 }
}
