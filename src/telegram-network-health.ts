import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {networkHealthSummary,type NetworkGroupDiagnostic}
 from './network-health-summary.js';

/** NETWORK-004 owner-private read-only diagnostic. No Telegram rights probe,
 * member identity exposure, policy mutation or implicit emergency restart.
 */
const net='([a-f0-9]{12})',group='(-[1-9][0-9]{0,15})',
 page='(0|[1-9][0-9]{0,2})',SIZE=8;
const HOME=new RegExp('^nw:1:hh:'+net+':'+page+'$','u');
const DETAIL=new RegExp('^nw:1:hd:'+net+':'+group+'$','u');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const labels:Record<NetworkGroupDiagnostic['status'],string>={
 READY:'اعتماد ونطاق إشراف محليان صالحان',
 NO_MODERATION_SCOPE:'اعتماد موجود لكن نطاق الإشراف غير متاح',
 STALE:'ارتباط قديم أو مجموعة غير مسجلة بالإصدار المطلوب',
 REVOKED:'اعتماد المجموعة ملغى',
 DUPLICATE:'سجلات اعتماد مكررة؛ مرفوضة للاعتماد'
};
const local=(g:NetworkGroupDiagnostic)=>
 g.status==='READY'&&g.locallyPresent!==true?'⚠️':
 g.status==='READY'?'✅':g.status==='REVOKED'?'⛔':g.status==='DUPLICATE'?'⚠️':'🟠';
export function validOwnerNetworkHealthRoute(data:unknown):boolean{
 return typeof data==='string'&&Buffer.byteLength(data,'utf8')<=64&&
  (HOME.test(data)||DETAIL.test(data));
}
export class OwnerNetworkHealthEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validOwnerNetworkHealthRoute(data))return null;
  const h=HOME.exec(data),d=DETAIL.exec(data),id=(h??d)?.[1];
  if(!id)return null;
  const state=await this.store.snapshot(),now=this.clock(),
   report=networkHealthSummary(state,this.policy,actor,id,now);
  if(!report)return null;
  if(d){
   const g=report.groups.find(x=>x.id===d[2]);
   if(!g)return null;
   return ui('<b>🩺 تشخيص محلي لمجموعة الشبكة</b>\n'+
    'الشبكة: '+esc(report.networkName)+'\n'+
    'المجموعة: <code>'+g.id+'</code>\n'+
    'إصدار عضوية الشبكة: '+g.membershipVersion+'\n'+
    'حالة الاعتماد: '+labels[g.status]+'\n'+
    'وجود البوت بالسجل: '+(g.locallyPresent===null?'غير مؤكد':
     g.locallyPresent?'مسجّل محليًا كموجود':'مسجّل محليًا كغير موجود')+'\n'+
    (g.status==='READY'&&g.locallyPresent!==true?
     '⚠️ السجل قد يملك اعتمادًا محليًا قديمًا رغم عدم إثبات وجود البوت؛ لا يُعامل كدليل إذن.\n':'')+
    'سياسة الحماية المحلية: '+g.policy+
    (g.policyRevision!==null?' · الإصدار '+g.policyRevision:'')+'\n'+
    'حالة المساعد المحلي: '+esc(g.assistant)+'\n'+
    'روابط متابعة فعالة تمس المجموعة: '+g.activeFollows+'\n'+
    'روابط متابعة موقوفة: '+g.pausedFollows+'\n'+
    'بلاغات تنتظر: '+g.watchPending+'\n'+
    'مقترحات عقوبات تنتظر: '+g.sanctionPending+'\n'+
    'المعلومات محلية فقط، ولا تثبت عضوية Telegram أو حقوق المشرف الحية.\n'+
    'هذا العرض لا يفعّل الحماية ولا يعيد تشغيل روابط موقوفة.',
    [[btn('🛡️ البلاغات المركزية','nw:1:w:'+id+':0')],
     [btn('🏢 غرفة إدارة المجموعة','nw:1:rg:'+id+':'+g.id)],
     [btn('🩺 تشخيص الشبكة','nw:1:hh:'+id+':0)],
     [btn('🌐 بطاقة الشبكة','nw:1:d:'+id)]]);
  }
  const p=Number(h![2]),pages=Math.max(1,Math.ceil(report.groups.length/SIZE));
  if(p>=pages)return null;
  const items=report.groups.slice(p*SIZE,(p+1)*SIZE)
   .map(g=>[btn(local(g)+' '+g.id+' · '+g.policy,'nw:1:hd:'+id+':'+g.id)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:hh:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:hh:'+id+':'+(p+1)));
  if(nav.length)items.push(nav);
  items.push([btn('🚨 حالة طوارئ الشبكة','nw:1:eh:'+id),
   btn('🛑 إيقاف خدمات الشبكة','nw:1:sh:'+id)]);
  items.push([btn('🎯 إدارة توريث السياسات','nw:1:f:'+id+':0'),
   btn('🧭 صندوق المراجعات','nw:1:iq:'+id+':0)]);
  items.push([btn('🏢 جرد غرف الإدارة','nw:1:rl:'+id+':0')]);
  items.push([btn('🌐 بطاقة الشبكة','nw:1:d:'+id)]);
  return ui('<b>🩺 لوحة التشخيص المحلي للشبكة</b>\n'+
   'الشبكة: '+esc(report.networkName)+' · الإصدار '+report.networkRevision+'\n'+
   'الطوارئ: '+(report.stopped?'⛔ إيقاف محلي فعّال':'لا يوجد إيقاف طارئ فعّال')+
   ' · مراجعة الطوارئ '+report.emergencyRevision+'\n'+
   'المجموعات المرتبطة: '+report.groups.length+
   ' · صالحة محليًا: '+report.ready+'\n'+
   'ارتباطات قديمة: '+report.stale+' · اعتماد ملغى: '+report.revoked+
   ' · سجلات مكررة: '+report.duplicates+
   ' · بلا نطاق إشراف: '+report.withoutModeration+'\n'+
   'السياسات: OFF '+report.off+' · MONITOR '+report.monitor+
   ' · ENFORCE '+report.enforce+'\n'+
   'بلا سياسة: '+report.noPolicy+' · سياسة غير سليمة: '+report.invalidPolicies+'\n'+
   'الحضور المحلي: غير موجود '+report.locallyAbsent+
   ' · غير مؤكد '+report.presenceUnconfirmed+'\n'+
   'التوريث: فعّال '+report.activeFollows+' · موقوف '+report.pausedFollows+'\n'+
   'بلاغات تنتظر: '+report.watchPending+
   ' · مقترحات إجراءات تنتظر: '+report.sanctionPending+'\n'+
   (report.incomplete?'⚠️ توجد مجموعات تحتاج مراجعة محلية قبل اعتماد إعدادات جديدة.\n':'')+
   'صفحة '+(p+1)+'/'+pages+
   '\nفحص السجلات المحلية فقط؛ لا قراءة حقوق Telegram الحية، ولا تغيير سياسات أو عقوبات.',
   items);
 }
}
