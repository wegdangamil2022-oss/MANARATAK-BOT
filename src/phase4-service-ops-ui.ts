import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {Phase4CleanupOperations,type CleanupReviewAction,type CleanupOwnerSnapshot} from './phase4-cleanup-ops.js';
import type {CommunityCleanupJob,CommunityCleanupStatus} from './phase4-community-model.js';

const GROUP='-[1-9][0-9]{0,15}',PAGE='(?:0|[1-9][0-9]?)',
 INDEX='(?:0|[1-9][0-9]?)',DRAFT='[a-f0-9]{24}';
const route=new RegExp('^sc4:1:(?:h|p:'+PAGE+'|g:'+GROUP+
 '|l:'+GROUP+':'+PAGE+'|j:'+GROUP+':'+INDEX+
 '|[qv]:'+GROUP+':'+INDEX+'|b:'+GROUP+
 '|[cx]:'+DRAFT+')$','u');
export const validPhase4ServiceOpsRoute=(value:unknown):value is string=>
 typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&route.test(value);
const btn=(text:string,callback_data:string)=>({text,callback_data});
const keyboard=(rows:{text:string;callback_data:string}[][]):TelegramInlineKeyboard=>
 ({inline_keyboard:rows});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:keyboard(rows)});
const label=(on:boolean)=>on?'✅ مفعّل':'⛔ متوقف';
const kindLabels:Record<CommunityCleanupJob['kind'],string>={
 JOIN:'رسالة دخول',LEAVE:'رسالة مغادرة',
 TITLE_CHANGED:'تغيير اسم المجموعة',PHOTO_CHANGED:'تغيير الصورة',
 PHOTO_REMOVED:'حذف الصورة',AUTOMATIC_REPLY:'رد آلي من منارتك'
};
const statusLabels:Record<CommunityCleanupStatus,string>={
 QUEUED:'بانتظار المهلة',SENDING:'بدأت محاولة الحذف، والنتيجة غير محسومة',
 CONFIRMED:'أكد Telegram الحذف',
 FAILED_CONFIRMED:'رفض Telegram الحذف أو فقد البوت الإذن',
 UNKNOWN_OUTCOME:'نتيجة Telegram غير مؤكدة',
 REVIEWED_UNKNOWN:'راجع المالك الحالة المجهولة دون إثبات نجاح الحذف',
 SKIPPED:'أُلغي أو فقد شروطه قبل محاولة Telegram'
};
const when=(n:number)=>new Date(n).toISOString().slice(0,16).replace('T',' ')+' UTC';
const total=(s:CleanupOwnerSnapshot)=>Object.values(s.counts).reduce((n,v)=>n+v,0);
export async function phase4ServiceOpsScreen(service:Phase4CleanupOperations,
 actor:string,input:string):Promise<OwnerInlineScreen|null>{
 try{
  if(input==='mi:1:i:09:04'||input==='sc4:1:h'||input==='/servicejobs')
   input='sc4:1:p:0';
  if(!validPhase4ServiceOpsRoute(input))return null;
  const groupsPage=/^sc4:1:p:(0|[1-9][0-9]?)$/u.exec(input);
  if(groupsPage){
   const page=Number(groupsPage[1]),groups=await service.groups(actor);
   const pages=Math.max(1,Math.ceil(groups.length/6));
   if(page>=pages)return null;
   const rows=groups.slice(page*6,page*6+6).map(group=>[
    btn('👥 مجموعة '+group,'sc4:1:g:'+group)]);
   const pager:{text:string;callback_data:string}[]=[];
   if(page>0)pager.push(btn('⬅️ السابق','sc4:1:p:'+(page-1)));
   if(page+1<pages)pager.push(btn('التالي ➡️','sc4:1:p:'+(page+1)));
   if(pager.length)rows.push(pager);
   rows.push([btn('↩️ التفاعل والترحيب','mi:1:s:09:0'),
    btn('🏠 لوحة المالك','mi:1:h')]);
   return ui('<b>🧹 09:04 — الرسائل الخدمية</b>\n'+
    'المجموعات المعتمدة: '+groups.length+' · صفحة '+(page+1)+' / '+pages+
    '\n\nاختر مجموعة لعرض إعدادات تنظيف رسائل الخدمة وردود البوت ومهام الحذف.'+
    '\nلا يحذف فتح اللوحة أي رسالة. جميع عمليات الحذف تخضع لحقوق Telegram، ومفتاح الطوارئ، وموافقة المجموعة.',
    rows);
  }
  const groupHome=/^sc4:1:g:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(groupHome){
   const group=groupHome[1]!,s=await service.snapshot(actor,group);
   if(!s)return null;
   const c=s.counts;
   return ui('<b>🧹 الرسائل الخدمية — المجموعة</b>\n'+
    '<code>'+group+'</code>\n'+
    'إصدار الإعداد: '+s.configVersion+(s.configVersion===0?' (لم تُهيأ المجموعة بعد)':'')+
    '\nتنظيف رسائل الخدمة: '+label(s.cleanupEnabled)+
    '\nرسائل الدخول: '+label(s.joinEnabled)+
    '\nرسائل المغادرة: '+label(s.leaveEnabled)+
    '\nتغييرات الاسم والصورة: '+label(s.profileEnabled)+
    '\nمهلة الخدمة: '+s.delayMs/1000+' ثانية'+
    '\nحذف ردود البوت الآلية: '+label(s.replyCleanupEnabled)+
    '\nمهلة الرد الآلي: '+s.replyDelayMs/1000+' ثانية'+
    '\n\n<b>سجل المهام (محفوظ محليًا)</b>\n'+
    'العدد: '+total(s)+' · بالطابور: '+c.QUEUED+
    ' · بدأت المحاولة: '+c.SENDING+
    '\nحذف مؤكد: '+c.CONFIRMED+
    ' · فشل مؤكد: '+c.FAILED_CONFIRMED+
    '\nنتيجة مجهولة: '+c.UNKNOWN_OUTCOME+
    ' · راجعها المالك: '+c.REVIEWED_UNKNOWN+
    ' · مستبعدة: '+c.SKIPPED+
    '\nمهام الطابور: خدمة '+s.queueKind.service+
    ' / ردود البوت '+s.queueKind.automaticReply+
    '\n\nهذه الأرقام توضح محاولات محفوظة وليست عدد رسائل المجموعة كلها.',
    [[btn('📋 سجل مهام التنظيف','sc4:1:l:'+group+':0')],
     ...(c.QUEUED?[[btn('⛔ معاينة إلغاء كل المهام المعلقة','sc4:1:b:'+group)]]:[]),
     [btn('⚙️ مفاتيح تنظيف رسائل الخدمة','p4c:1:s:'+group)],
     [btn('🧼 إعداد تنظيف ردود البوت','p4c:1:g:'+group)],
     [btn('🚦 سقف إعلانات البوت','p4c:1:i:'+group)],
     [btn('↩️ المجموعات','sc4:1:p:0'),btn('🏠 لوحة المالك','mi:1:h')]]);
  }
  const logPage=/^sc4:1:l:(-[1-9][0-9]{0,15}):(0|[1-9][0-9]?)$/u.exec(input);
  if(logPage){
   const group=logPage[1]!,page=Number(logPage[2]);
   const s=await service.snapshot(actor,group);
   if(!s)return null;
   const pages=Math.max(1,Math.ceil(s.jobs.length/6));
   if(page>=pages)return null;
   const rows=s.jobs.slice(page*6,page*6+6).map((job,index)=>[
    btn((job.status==='QUEUED'?'⏳ ':job.status==='CONFIRMED'?'✅ ':
      job.status==='UNKNOWN_OUTCOME'?'⚠️ ':'📄 ')+
     kindLabels[job.kind]+' · '+statusLabels[job.status].slice(0,20),
     'sc4:1:j:'+group+':'+(page*6+index))]);
   const nav:{text:string;callback_data:string}[]=[];
   if(page>0)nav.push(btn('⬅️ السابق','sc4:1:l:'+group+':'+(page-1)));
   if(page+1<pages)nav.push(btn('التالي ➡️','sc4:1:l:'+group+':'+(page+1)));
   if(nav.length)rows.push(nav);
   rows.push([btn('↩️ لوحة المجموعة','sc4:1:g:'+group)]);
   return ui('<b>📋 المهام الخدمية — آخر 100 مهمة</b>\n'+
    'المجموعة: <code>'+group+'</code> · صفحة '+(page+1)+' / '+pages+
    '\nالعدد المحفوظ: '+total(s)+
    '\n\nلا تُعرض هوية الطالب أو محتوى الرسائل. المهام التي بدأت بالفعل لا يمكن إلغاؤها من هنا.',
    rows);
  }
  const jobRoute=/^sc4:1:([jqv]):(-[1-9][0-9]{0,15}):(0|[1-9][0-9]?)$/u.exec(input);
  if(jobRoute){
   const action=jobRoute[1]!,group=jobRoute[2]!,index=Number(jobRoute[3]);
   const s=await service.snapshot(actor,group);
   if(!s||index>=s.jobs.length)return null;
   const job=s.jobs[index]!;
   if(action==='j'){
    const rows=[
     ...(job.status==='QUEUED'?
       [[btn('⛔ مراجعة إلغاء هذه المهمة','sc4:1:q:'+group+':'+index)]]:[]),
     ...(['SENDING','UNKNOWN_OUTCOME'].includes(job.status)&&
        Date.now()>=job.dueAt+600000?
       [[btn('⚠️ مراجعة نتيجة مجهولة','sc4:1:v:'+group+':'+index)]]:[]),
     [btn('↩️ سجل المهام','sc4:1:l:'+group+':'+Math.floor(index/6))]
    ];
    return ui('<b>📄 تفاصيل مهمة حذف</b>\n'+
     'المجموعة: <code>'+group+'</code>\n'+
     'النوع: '+kindLabels[job.kind]+
     '\nالحالة: '+statusLabels[job.status]+
     '\nرُصدت: '+when(job.observedAt)+
     '\nموعد التنفيذ: '+when(job.dueAt)+
     '\nرقم رسالة Telegram داخل المجموعة: '+job.messageId+
     '\n\nلا يحتوي السجل على اسم العضو أو نص الرسالة.'+
     '\nلا تُستعاد الرسالة إذا أكّد Telegram حذفها.',
     rows);
   }
   const review:CleanupReviewAction=action==='q'?'CANCEL_ONE':'REVIEW_ONE';
   const {draft,count}=await service.prepare(actor,group,review,job.key);
   return ui('<b>🔐 مراجعة مستقلة — 09:04</b>\n'+
    'المجموعة: <code>'+group+'</code>\n'+
    'المهمة: '+kindLabels[job.kind]+'\n'+
    'الإجراء: '+(review==='CANCEL_ONE'?
     'إلغاء محاولة الحذف قبل إرسالها إلى Telegram. لا تُحذف الرسالة.':
     'تدوين أن نتيجة الحذف غير مؤكدة بعد مراجعتك للمجموعة. لن نعيد محاولة حذفها.')+
    '\n\nالعدد: '+count+' · صلاحية التأكيد: دقيقتان.',
    [[btn('✅ اعتماد هذا الإجراء','sc4:1:c:'+draft.id)],
     [btn('❌ إلغاء المراجعة','sc4:1:x:'+draft.id)],
     [btn('↩️ تفاصيل المهمة','sc4:1:j:'+group+':'+index)]]);
  }
  const bulk=/^sc4:1:b:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(bulk){
   const group=bulk[1]!;
   const {draft,count}=await service.prepare(actor,group,'CANCEL_GROUP');
   return ui('<b>⛔ معاينة إلغاء جميع المهام المعلقة</b>\n'+
    'المجموعة: <code>'+group+'</code>\n'+
    'العدد الذي ستتغير حالته إلى مستبعدة: '+count+
    '\n\nهذا لا يحذف رسائل Telegram، ولا يعطل إعداد التنظيف.'+
    '\nإن بدأت أي مهمة أو وصلت مهمة أخرى أثناء المعاينة يُرفض تأكيد الدفعة كلها.'+
    '\nلا يمكن إلغاء حذف أُرسل بالفعل أو إعادته. صالحة لدقيقتين.',
    [[btn('✅ أؤكد إلغاء المهام المعلقة','sc4:1:c:'+draft.id)],
     [btn('❌ رجوع دون تغيير','sc4:1:x:'+draft.id)]]);
  }
  const approval=/^sc4:1:([cx]):([a-f0-9]{24})$/u.exec(input);
  if(approval){
   if(approval[1]==='x'){
    const done=await service.cancelDraft(actor,approval[2]!);
    return done?ui('أُلغيت مسودة المراجعة دون تغيير المهام.',
     [[btn('↩️ المجموعات','sc4:1:p:0')]]):null;
   }
   const done=await service.confirm(actor,approval[2]!);
   return ui('<b>✅ اعتمد المالك إجراء القسم 09:04</b>\n'+
    'المجموعة: <code>'+done.chatId+'</code>\n'+
    'العدد: '+done.count+'\n'+
    (done.action==='REVIEW_ONE'?
      'سُجلت نتيجة غير مؤكدة فقط؛ لم نحاول الحذف مجددًا.':
      'أُلغيت المهام التي لم يبدأ تنفيذها؛ لم نرسل طلب حذف إلى Telegram.'),
    [[btn('🧹 حالة المجموعة','sc4:1:g:'+done.chatId)],
     [btn('↩️ المجموعات','sc4:1:p:0')]]);
  }
  return null;
 }catch{return null;}
}
