import {Phase4WhisperService,type WhisperDraftInput} from './phase4-whispers.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const hex='[a-f0-9]{24}';
const route=new RegExp('^wh:1:(?:h|l:(?:0|[1-9][0-9]?)|[vaxps]:'+hex+'|c:'+hex+':[12]|r:-[1-9][0-9]{0,15}|[zykj]:'+hex+'|f:(?:0|[1-9][0-9]?)|t:(?:0|[1-9][0-9]?)|g:-[1-9][0-9]{0,15}|o:-[1-9][0-9]{0,15}:[01])$','u');
export const validWhisperOwnerRoute=(s:unknown):s is string=>
 typeof s==='string'&&Buffer.byteLength(s,'utf8')<=64&&route.test(s);
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const home=btn('↩️ التفاعل والترحيب','mi:1:s:09:0');
const list=btn('📋 قائمة الهمسات','wh:1:h');
export type WhisperOwnerCommand=
 |{kind:'CREATE';chatId:string;input:WhisperDraftInput}
 |{kind:'LIST'}
 |{kind:'REPORTS';chatId:string}
 |{kind:'SETTINGS';chatId:string;enabled:boolean};
const user=(value:string)=>/^[1-9][0-9]{0,15}$/u.test(value)&&
 Number.isSafeInteger(Number(value));
const group=(value:string)=>/^-[1-9][0-9]{0,15}$/u.test(value)&&
 Number.isSafeInteger(Number(value));
export function parseWhisperOwnerCommand(text:string):WhisperOwnerCommand|null{
 if(text==='/whispers')return {kind:'LIST'};
 const policy=/^\/whispermembers (-[1-9][0-9]{0,15}) (on|off)$/u.exec(text);
 if(policy&&group(policy[1]!))return {kind:'SETTINGS',chatId:policy[1]!,
  enabled:policy[2]==='on'};
 const reports=/^\/whisperreports (-[1-9][0-9]{0,15})$/u.exec(text);
 if(reports&&group(reports[1]!))return {kind:'REPORTS',chatId:reports[1]!};
 const first=/^\/whisperfirst (-[1-9][0-9]{0,15}) ([0-9]{1,2}) ([0-9]{1,2}) ([^\r\n]{1,800})$/u.exec(text);
 if(first&&group(first[1]!)&&Number(first[2])>=1&&Number(first[2])<=20&&
  Number(first[3])>=1&&Number(first[3])<=60)
  return {kind:'CREATE',chatId:first[1]!,input:{
   kind:'FIRST_N',seats:Number(first[2]),durationMinutes:Number(first[3]),text:first[4]!
  }};
 const everyone=/^\/whispereveryone (-[1-9][0-9]{0,15}) ([0-9]{1,2}) ([^\r\n]{1,800})$/u.exec(text);
 if(everyone&&group(everyone[1]!)&&Number(everyone[2])>=1&&
    Number(everyone[2])<=60)
  return {kind:'CREATE',chatId:everyone[1]!,input:{
   kind:'EVERYONE',durationMinutes:Number(everyone[2]),text:everyone[3]!
  }};
 const direct=/^\/whisperdirect (-[1-9][0-9]{0,15}) ([1-9][0-9]{0,15}) ([0-9]{1,2}) ([^\r\n]{1,800})$/u.exec(text);
 if(direct&&group(direct[1]!)&&user(direct[2]!)&&
  Number(direct[3])>=1&&Number(direct[3])<=60)
  return {kind:'CREATE',chatId:direct[1]!,input:{
   kind:'DIRECT',recipientId:direct[2]!,durationMinutes:Number(direct[3]),text:direct[4]!
  }};
 return null;
}
async function detail(service:Phase4WhisperService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const row=await service.ownerView(actor,id);
 if(!row)return null;
 const names={DRAFT:'📝 مسودة تنتظر اعتمادك',OPEN:'✅ معتمدة محليًا',
  CLOSED:'🔒 مغلقة ومحذوف محتواها'} as const;
 const type=row.kind==='FIRST_N'?'أول '+row.seats+' مستلمين مؤهلين':
  row.kind==='EVERYONE'?'للجميع المؤهلين (يفتحون بشكل فردي فقط)':
  'إلى مستلم واحد مُحدد';
 const publication=await service.announcementStatus(actor,id);
 const text='<b>💌 معاينة همسة خاصة للمالك فقط</b>\n'+
  'المنشئ: '+(row.submittedByMember?'✉️ طالب، بانتظار مراجعتك':'🛡️ المالك')+
  (row.submittedByMember?' · <code>'+row.creatorId+'</code>':'')+'\n'+
  'المجموعة: <code>'+row.chatId+'</code>\n'+
  'الوضع: '+type+'\n'+
  'الحالة: '+names[row.status]+'\n'+
  'تاريخ الانتهاء: '+new Date(row.expiresAt).toISOString()+'\n'+
  (row.status==='DRAFT'?
   '\n<b>نص المسودة:</b>\n'+escape(row.text??'')+'\n':
   '\nتم إخفاء النص عن صفحات الحالة؛ لا يظهر في رسالة مجموعة.\n')+
  '\nحالة إعلان Telegram: '+(publication==='NOT_POSTED'?'لم يُطلب النشر':
   publication==='QUEUED'?'بانتظار الإرسال':publication==='SENDING'?
   'بدأ الإرسال، والنتيجة غير مؤكدة':publication==='CONFIRMED'?
   '✅ أكد Telegram نشر الإعلان':publication==='UNKNOWN_OUTCOME'?
   '⚠️ نتيجة نشر الإعلان غير مؤكدة؛ لا إعادة تلقائية':
   publication==='FAILED_CONFIRMED'?'رفض Telegram النشر':'استبعد النظام الإعلان')+
  '\n⚠️ إعلان المجموعة لا يحتوي نص الهمسة. حجز المقعد لا يثبت التسليم أو القراءة.';
 const actions:{text:string;callback_data:string}[][]=[];
 if(row.status==='DRAFT')actions.push([btn('✅ اعتماد المسودة محليًا','wh:1:a:'+id)]);
 if(row.status==='OPEN'&&publication==='NOT_POSTED')
  actions.push([btn('📣 معاينة نشر إعلان المجموعة','wh:1:p:'+id)]);
 if(row.status!=='CLOSED')actions.push([btn('🔒 إغلاق وحذف النص','wh:1:x:'+id)]);
 actions.push([list],[home]);
 return ui(text,actions);
}
export async function whisperOwnerScreen(
 service:Phase4WhisperService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  // A private owner interaction also opportunistically redacts expired
  // content; this is NOT a substitute for a separate scheduled sweeper.
  await service.expire();
  const cmd=parseWhisperOwnerCommand(input);
  if(cmd?.kind==='CREATE'){
   const d=await service.draft(actor,cmd.chatId,cmd.input);
   return detail(service,actor,d.id);
  }
  if(cmd?.kind==='REPORTS')input='wh:1:r:'+cmd.chatId;
  if(cmd?.kind==='SETTINGS')input='wh:1:o:'+cmd.chatId+':'+(cmd.enabled?'1':'0');
  const memberReviewPage=/^wh:1:t:(0|[1-9][0-9]?)$/u.exec(input);
  if(memberReviewPage){
   const drafts=await service.pendingMemberDrafts(actor),
    page=Number(memberReviewPage[1]),pages=Math.max(1,Math.ceil(drafts.length/8));
   if(page>=pages)return null;
   const buttons=drafts.slice(page*8,page*8+8).map(d=>[
    btn('📝 مجموعة '+d.chatId+' · '+(d.kind==='DIRECT'?'لمستلم معين':
      'أول '+d.seats)+' · ينتهي '+new Date(d.expiresAt).toISOString().slice(11,16),
    'wh:1:v:'+d.id)]);
   const nav:{text:string;callback_data:string}[]=[];
   if(page>0)nav.push(btn('⬅️ السابق','wh:1:t:'+(page-1)));
   if(page+1<pages)nav.push(btn('التالي ➡️','wh:1:t:'+(page+1)));
   if(nav.length)buttons.push(nav);
   buttons.push([list],[home]);
   return ui('<b>📝 مراجعة مسودات الهمسات المقدمة من الطلاب</b>\n'+
    'المعلقة حاليًا: '+drafts.length+' · صفحة '+(page+1)+'/'+pages+
    '\n\nالمراجعة تتم في خاص المالك فقط. افتح المسودة للاطلاع على النص، '+ 
    'ثم اعتمادها محليًا أو إغلاقها. ولا يُنشر إعلان دون موافقة مستقلة أخرى.',
    buttons);
  }
  const groupPage=/^wh:1:f:(0|[1-9][0-9]?)$/u.exec(input);
  if(groupPage){
   const groups=await service.ownerGroups(actor),page=Number(groupPage[1]),
    pages=Math.max(1,Math.ceil(groups.length/8));
   if(page>=pages)return null;
   const buttons=groups.slice(page*8,page*8+8).map(id=>[
    btn('👥 مجموعة '+id,'wh:1:g:'+id)]);
   const nav:{text:string;callback_data:string}[]=[];
   if(page>0)nav.push(btn('⬅️ السابق','wh:1:f:'+(page-1)));
   if(page+1<pages)nav.push(btn('التالي ➡️','wh:1:f:'+(page+1)));
   if(nav.length)buttons.push(nav);
   buttons.push([list],[home]);
   return ui('<b>⚙️ إعدادات الهمسات للمجموعات</b>\n'+
    'المجموعات المعتمدة: '+groups.length+' · صفحة '+(page+1)+'/'+pages+
    '\nمسودات الطلاب مغلقة افتراضيًا، ولا تنشر رسالة دون مراجعة المالك.',
    buttons);
  }
  const groupSettings=/^wh:1:g:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(groupSettings){
   const groupId=groupSettings[1]!,settings=await service.groupSettings(actor,groupId);
   if(!settings)return null;
   return ui('<b>💌 09:06 — إعدادات المجموعة</b>\n'+
    'المجموعة: <code>'+groupId+'</code>\n'+
    'إنشاء مسودات الهمسات من الطلاب: '+
    (settings.memberDraftsEnabled?'✅ مفعّل':'⛔ متوقف')+
    '\nنسخة السياسة: '+settings.version+
    '\n\nعند التفعيل: يسمح فقط بمسودات DIRECT أو لأول 1–3، حتى 500 حرف و10 دقائق،'+
    ' بحد 2 لكل طالب و12 لكل مجموعة في الساعة.\n'+
    'لا نشر قبل مراجعة المالك واعتماد إعلان منفصل.\n'+
    'إيقاف الميزة يسحب نصوص مسودات الطلاب غير المعتمدة.\n\n'+
    'أوامر الطلاب في الخاص: /whispersend و/whisperfirstsend',
    [[btn(settings.memberDraftsEnabled?'⛔ معاينة إيقاف مسودات الطلاب':
      '✅ معاينة تفعيل مسودات الطلاب',
      'wh:1:o:'+groupId+':'+(settings.memberDraftsEnabled?'0':'1'))],
     [btn('🚩 البلاغات','wh:1:r:'+groupId)],
     [btn('↩️ المجموعات','wh:1:f:0')],[list]]);
  }
  const settingPreview=/^wh:1:o:(-[1-9][0-9]{0,15}):([01])$/u.exec(input);
  if(settingPreview){
   const groupId=settingPreview[1]!,enabled=settingPreview[2]==='1',
    settings=await service.groupSettings(actor,groupId);
   if(!settings||settings.memberDraftsEnabled===enabled)return null;
   const id=await service.prepareGroupSettings(actor,groupId,enabled);
   return ui('<b>🔐 تأكيد مستقل لتغيير استقبال همسات الطلاب</b>\n'+
    'المجموعة: <code>'+groupId+'</code>\n'+
    'التغيير: '+(enabled?'تفعيل المسودات المدققة':'إيقاف قبول المسودات الجديدة')+
    '\nالقرار ينتهي بعد دقيقتين وتُراجع صلاحية المجموعة والإصدار من جديد.'+
    (enabled?'\nكل مسودة طالب تحتاج مراجعة المالك ثم موافقة ثانية للنشر.':
    '\nسيُحذف محتوى المسودات الطلابية غير المعتمدة في هذه المجموعة.'),
    [[btn('✅ اعتماد سياسة المجموعة','wh:1:k:'+id)],
     [btn('❌ إلغاء دون تغيير','wh:1:j:'+id)],
     [btn('↩️ إعدادات المجموعة','wh:1:g:'+groupId)]]);
  }
  const settingDecision=/^wh:1:([kj]):([a-f0-9]{24})$/u.exec(input);
  if(settingDecision){
   if(settingDecision[1]==='j'){
    const cancelled=await service.cancelGroupSettings(actor,settingDecision[2]!);
    return cancelled?ui('أُلغي طلب الإعداد دون أي تغيير.',[[list]]):null;
   }
   const done=await service.confirmGroupSettings(actor,settingDecision[2]!);
   return ui('✅ حُفظ إعداد مسودات الطلاب للمجموعة <code>'+done.chatId+'</code>\n'+
    (done.memberDraftsEnabled?'الاستقبال مفعل مع مراجعة المالك.':'استقبال المسودات متوقف.'),
    [[btn('↩️ إعدادات المجموعة','wh:1:g:'+done.chatId)],[list]]);
  }
  const reportsInput=/^wh:1:r:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(reportsInput){
   const reports=await service.reports(actor,reportsInput[1]!);
   const rows=reports.slice(0,10).map(r=>[
    btn((r.status==='OPEN'?'🚩 ':'✅ ')+r.reason+
     ' · '+new Date(r.reportedAt).toISOString().slice(0,10),
     'wh:1:z:'+r.id)]);
   rows.push([list],[home]);
   return ui('<b>🚩 مراجعات الهمسات الخاصة</b>\n'+
    'المجموعة: <code>'+reportsInput[1]+'</code>\n'+
    'بلاغات محفوظة: '+reports.length+'\n'+
    'يظهر نوع الإساءة وتاريخها دون نص الهمسة أو هوية المُبلّغ. '+ 
    'المراجعة لا تثبت وصول المحتوى إلى المستلم.',rows);
  }
  const reviewPreview=/^wh:1:z:([a-f0-9]{24})$/u.exec(input);
  if(reviewPreview){
   const rows=await service.list(actor);
   // The report service itself enforces the group permission; never reveal
   // whether an unrelated private report ID exists.
   for(const m of rows){
    const found=(await service.reports(actor,m.chatId)).find(r=>r.id===reviewPreview[1]);
    if(found){
     if(found.status!=='OPEN')return ui('هذا البلاغ سبق أن تمت مراجعته.',[[list]]);
     return ui('<b>🚩 معاينة إغلاق بلاغ همسة</b>\n'+
      'نوع البلاغ: '+found.reason+'\n'+
      'تاريخ الإبلاغ: '+new Date(found.reportedAt).toISOString()+
      '\nمعرّف الحالة: <code>'+found.id+'</code>\n'+
      'لن يُعرض متن الهمسة أو بيانات المُبلّغ. هذا تسجيل مراجعة فقط.',
      [[btn('✅ تأكيد المراجعة','wh:1:y:'+found.id)],[list]]);
    }
   }
   return null;
  }
  const reviewConfirm=/^wh:1:y:([a-f0-9]{24})$/u.exec(input);
  if(reviewConfirm){
   if(!await service.reviewReport(actor,reviewConfirm[1]!))return null;
   return ui('✅ اعتُمدت مراجعة البلاغ دون نسخ نص الهمسة.',
    [[list],[home]]);
  }
  const listing=/^wh:1:l:(0|[1-9][0-9]?)$/u.exec(input);
  if(cmd?.kind==='LIST'||input==='mi:1:i:09:06'||input==='wh:1:h'||listing){
   const rows=await service.list(actor);
   const page=listing?Number(listing[1]):0;
   const pages=Math.max(1,Math.ceil(rows.length/8));
   if(page>=pages)return null;
   const buttons=rows.slice(page*8,page*8+8).map(m=>[btn(
    (m.status==='DRAFT'?'📝 ':m.status==='OPEN'?'✅ ':'🔒 ')+
     (m.kind==='FIRST_N'?'أول '+m.seats:m.kind==='EVERYONE'?
      'كل المؤهلين':'شخص محدد')+' · '+m.chatId,
    'wh:1:v:'+m.id
   )]);
   const nav:{text:string;callback_data:string}[]=[];
   if(page>0)nav.push(btn('⬅️ السابق','wh:1:l:'+(page-1)));
   if(page+1<pages)nav.push(btn('التالي ➡️','wh:1:l:'+(page+1)));
   if(nav.length)buttons.push(nav);
   buttons.push([btn('📝 مسودات الطلاب بانتظار المراجعة','wh:1:t:0')]);
   buttons.push([btn('⚙️ إدارة المجموعات ومسودات الطلاب','wh:1:f:0')]);
   buttons.push([home]);
   return ui('<b>💌 الهمسات الخاصة — القسم 09:06</b>\n'+
    'إنشاء المسودة من خاص المالك فقط:\n'+
    '<code>/whisperfirst -1001234 3 10 نص الهمسة</code>\n'+
    '<code>/whisperdirect -1001234 200 10 نص الهمسة</code>\n'+
    '<code>/whispereveryone -1001234 10 نص تعليمي عام</code>\n'+
    'الأرقام: معرّف مجموعة · عدد المقاعد أو المستلم · مدة بالدقائق (1–60).\n'+
    '🔐 المسودة لا تُنشر تلقائيًا. بعد الاعتماد المحلي، راجع زر إعلان المجموعة مستقلًا.\n'+
    'رابط الإعلان لا يحمل النص، والمستلم لا يراه إلا في الخاص بعد التحقق.\n'+
    'الهمسات المخزنة: '+rows.length+' · صفحة '+(page+1)+'/'+pages+' (8 بكل صفحة).'+
    '\nبلاغات المجموعة: <code>/whisperreports GROUP_ID</code>',buttons);
  }
  if(!validWhisperOwnerRoute(input))return null;
  const publishPreview=/^wh:1:p:([a-f0-9]{24})$/u.exec(input);
  if(publishPreview){
   const message=await service.ownerView(actor,publishPreview[1]!);
   if(!message||message.status!=='OPEN'||
      await service.announcementStatus(actor,message.id)!=='NOT_POSTED')return null;
   return ui('<b>📣 موافقة مستقلة على إعلان الهمسة</b>\n'+
    'المجموعة: <code>'+message.chatId+'</code>\n'+
    'نوع الهمسة: '+(message.kind==='DIRECT'?'مستلم محدد':
     message.kind==='EVERYONE'?'جميع المؤهلين، وليس سرًا بين الجميع':
     'أول '+message.seats)+
    '\nموعد الانتهاء: '+new Date(message.expiresAt).toISOString()+
    (message.kind==='EVERYONE'?
      '\n⚠️ قد يفتحها جميع أعضاء المجموعة المؤهلين فرديًا؛ محدد فقط بسعة التشغيل.':
      '')+
    '\n\nسيُنشر ملصق بلا أي نص سري أو هوية مستلم، وزر فتح ينقل إلى خاص البوت. '+
    'يتحقق البوت هناك من العضوية والموافقة قبل كشف المحتوى. '+
    'نتيجة إرسال Telegram غير مضمونة؛ لا نعيد إرسال العملية إذا كانت نتيجتها مجهولة.',
    [[btn('✅ الموافقة وطلب إعلان Telegram','wh:1:s:'+message.id)],
     [btn('❌ العودة دون نشر','wh:1:v:'+message.id)]]);
  }
  const publishConfirm=/^wh:1:s:([a-f0-9]{24})$/u.exec(input);
  if(publishConfirm){
   await service.queueAnnouncement(actor,publishConfirm[1]!);
   return detail(service,actor,publishConfirm[1]!);
  }
  const view=/^wh:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const approve=/^wh:1:a:([a-f0-9]{24})$/u.exec(input);
  if(approve){
   await service.approve(actor,approve[1]!);
   return detail(service,actor,approve[1]!);
  }
  const check=/^wh:1:x:([a-f0-9]{24})$/u.exec(input);
  if(check){
   const row=await service.ownerView(actor,check[1]!);
   if(!row||row.status==='CLOSED')return null;
   return ui('<b>⚠️ تأكيد إغلاق الهمسة وحذف محتواها</b>\n'+
    'سيتوقف حجز المقاعد الجديدة، ولن يُعاد محتوى الرسالة بعد هذا الإجراء.\n'+
    'المجموعة: <code>'+row.chatId+'</code>\n'+
    'هذه المراجعة لا تُجري عملية Telegram.',
    [[btn('🔒 تأكيد الإغلاق','wh:1:c:'+row.id+':'+row.revision)],
     [btn('↩️ إلغاء الإغلاق','wh:1:v:'+row.id)]]);
  }
  const close=/^wh:1:c:([a-f0-9]{24}):([12])$/u.exec(input);
  if(close){
   if(!await service.close(actor,close[1]!,Number(close[2])))return null;
   return detail(service,actor,close[1]!);
  }
  return null;
 }catch{return null;}
}
