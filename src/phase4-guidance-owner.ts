import {validCommunityGuideText} from './phase4-community-model.js';
import {Phase4GuidanceService,validGuidanceGroup,
 guidanceEscape,renderGuidanceWelcome,renderGuidanceRules,
 type GuidanceData} from './phase4-guidance.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const ID='-[1-9][0-9]{0,15}',PAGE='(?:0|[1-9][0-9]?)';
const UUID='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const ROUTE=new RegExp('^gd:1:(?:[23]:(?:h|p:'+PAGE+'|g:'+ID+
 ')|2:[cxay]:[a-f0-9]{24}|2:z:[a-f0-9]{24}|2:[ts]:'+ID+
 '|2:[rk]:[a-f0-9]{24}|3:[rf]:'+ID+':'+PAGE+'|3:d:'+ID+':'+UUID+')$','u');
export const validPhase4GuidanceOwnerRoute=(v:unknown):v is string=>
 typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&ROUTE.test(v);
export type GuidanceOwnerCommand=
 {section:'GUIDE'|'FIXED';kind:'HOME'}|
 {section:'GUIDE'|'FIXED';kind:'GROUP';chatId:string}|
 {section:'GUIDE';kind:'EDIT';chatId:string;request:{
  kind:'GUIDE_INTRO_SET'|'GUIDE_TOPICS_SET'|'GUIDE_SERVICES_SET'|'GUIDE_INTRO_CLEAR'|'GUIDE_TOPICS_CLEAR'|'GUIDE_SERVICES_CLEAR';
  text?:string;
 }};
export function parseGuidanceOwnerCommand(input:string):GuidanceOwnerCommand|null{
 if(input==='/newmemberguide')return {section:'GUIDE',kind:'HOME'};
 if(input==='/groupfixed')return {section:'FIXED',kind:'HOME'};
 if(typeof input!=='string'||input.length>460)return null;
 const set=/^\/(guideset|guidetopics|guideservices) (-[1-9][0-9]{0,15}) ([^\r\n]+)$/u.exec(input);
 if(set&&validGuidanceGroup(set[2]!)){
  const kind=set[1]==='guideset'?'GUIDE_INTRO_SET':
   set[1]==='guidetopics'?'GUIDE_TOPICS_SET':'GUIDE_SERVICES_SET',
   limit=kind==='GUIDE_INTRO_SET'?320:240;
  if(!validCommunityGuideText(set[3],limit))return null;
  return {section:'GUIDE',kind:'EDIT',chatId:set[2]!,
   request:{kind,text:set[3]!}};
 }
 const clear=/^\/(guideclear|guidetopicsclear|guideservicesclear) (-[1-9][0-9]{0,15})$/u.exec(input);
 if(clear&&validGuidanceGroup(clear[2]!))return {
  section:'GUIDE',kind:'EDIT',chatId:clear[2]!,
  request:{kind:clear[1]==='guideclear'?'GUIDE_INTRO_CLEAR':
   clear[1]==='guidetopicsclear'?'GUIDE_TOPICS_CLEAR':'GUIDE_SERVICES_CLEAR'}
 };
 if(input.length>90)return null;
 const match=/^\/(newmemberguide|groupfixed) (-[1-9][0-9]{0,15})$/u.exec(input);
 return match&&validGuidanceGroup(match[2]!)?
  {section:match[1]==='newmemberguide'?'GUIDE':'FIXED',
   kind:'GROUP',chatId:match[2]!}:null;
}
type Button={text:string;callback_data:string};
const btn=(text:string,callback_data:string):Button=>({text,callback_data});
const ui=(text:string,rows:Button[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const root=(section:'2'|'3')=>'gd:1:'+section+':h';
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:0');
const group=(section:'2'|'3',id:string)=>'gd:1:'+section+':g:'+id;
async function groups(service:Phase4GuidanceService,actor:string,
 section:'2'|'3',page:number):Promise<OwnerInlineScreen|null>{
 const all=await service.groups(actor),pages=Math.max(1,Math.ceil(all.length/8));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows:Button[][]=all.slice(page*8,page*8+8).map(x=>
  [btn('👥 '+x.chatId+(x.configured?' • لها إعداد':' • افتراضية'),
   group(section,x.chatId))]);
 const pager:Button[]=[];
 if(page>0)pager.push(btn('⬅️ السابق','gd:1:'+section+':p:'+(page-1)));
 if(page+1<pages)pager.push(btn('التالي ➡️','gd:1:'+section+':p:'+(page+1)));
 if(pager.length)rows.push(pager);
 rows.push([back,btn('🏠 لوحة المالك','mi:1:h')]);
 return ui('<b>'+(section==='2'?'🧭 دليل العضو الجديد — 09:02':
  '📜 القوانين والرسائل الثابتة — 09:03')+'</b>\n'+
  'اختر مجموعة معتمدة لمراجعة المواد المرئية فيها.\n'+
  'هذه شاشة معاينة، ولا تنشر تلقائيًا أي رسالة أو تعدل حقوق المجموعة.\n'+
  'الصفحة '+(page+1)+' من '+pages+' • عدد المجموعات: '+all.length+'\n'+
  'الأمر المباشر: <code>/'+(section==='2'?'newmemberguide':'groupfixed')+
  ' -1001234</code>',rows);
}
function welcome(d:GuidanceData):OwnerInlineScreen{
 const full=renderGuidanceWelcome(d);
 // The owner's control panel has extra instructions and must remain under
 // Telegram's 4096-byte ceiling even when the student guide is lengthy.
 const abbreviated=Buffer.byteLength(full,'utf8')>2100?
  '<b>نبذة مختصرة عن الدليل:</b>\n'+
   guidanceEscape((d.config.guideIntro??'مرحبًا بك في مجتمع منارتك التعليمي').slice(0,150))+
   '\n\nالمجالات: '+guidanceEscape((d.config.guideTopics??d.educationTopics.join('، ')).slice(0,130))+
   '\n\nلرؤية النص الكامل كما سيظهر في المجموعة اختر «معاينة نشر الدليل».':
  full;
 return ui('<b>👁️ معاينة المالك — دليل العضو الجديد 09:02</b>\n\n'+
  abbreviated+'\n\n'+
  'هذا الدليل للعرض عند طلب الطالب المتحقق من عضويته، ولا يُرسل عند الانضمام تلقائيًا.\n\n'+
  'لإعداد تعريف المجموعة: <code>/guideset '+d.chatId+' تعريف خاص بالمجموعة</code>\n'+
  'لتحديد المجالات: <code>/guidetopics '+d.chatId+' المنح، الدورات، الاختبارات</code>\n'+
  'لتخصيص الخدمات: <code>/guideservices '+d.chatId+' إرشاد الطلاب ومصادر المنح</code>\n'+
  'لإزالة التعريف: <code>/guideclear '+d.chatId+'</code>\n'+
  'لإزالة المجالات: <code>/guidetopicsclear '+d.chatId+'</code>\n'+
  'لإزالة الخدمات المخصصة: <code>/guideservicesclear '+d.chatId+'</code>\n'+
  'للنشر مرة واحدة بعد المراجعة: <code>/guidepublish '+d.chatId+'</code>\n'+
  'كل أمر يعرض معاينة خاصة ولا يُطبّق قبل موافقة مستقلة.',
  [[btn('📢 معاينة نشر الدليل في المجموعة','gd:1:2:t:'+d.chatId)],
   [btn('🕘 حالة آخر منشور تمهيدي','gd:1:2:s:'+d.chatId)],
   [btn('📜 القوانين والرسائل الثابتة',group('3',d.chatId))],
   [btn('✏️ إعدادات الترحيب والروابط','p4c:1:g:'+d.chatId)],
   [btn('📁 إعداد مجلد المجتمع','cf:1:h')],
   [btn('↩️ اختيار المجموعة',root('2')),back]]);
}
function fixed(d:GuidanceData):OwnerInlineScreen{
 return ui('<b>👁️ معاينة المالك — القوانين والرسائل الثابتة 09:03</b>\n\n'+
  renderGuidanceRules(d)+'\n\n'+
  'يمكن تعديل رابط القوانين والملاحظات وربط FAQ بمحرر الردود الحالي بعد المعاينة والتأكيد.',
  [[btn('📜 المصادر والردود ('+d.config.rules.length+')','gd:1:3:r:'+d.chatId+':0')],
   [btn('📚 فهرس FAQ المعتمد ('+d.faqs.length+')','gd:1:3:f:'+d.chatId+':0')],
   [btn('✏️ محرر القوانين والردود','p4c:1:g:'+d.chatId)],
   [btn('🧭 دليل الطالب',group('2',d.chatId))],
   [btn('↩️ اختيار المجموعة',root('3')),back]]);
}
function ruleList(d:GuidanceData,page:number):OwnerInlineScreen|null{
 const all=d.config.rules, pages=Math.max(1,Math.ceil(all.length/6));
 if(page>=pages)return null;
 const lines=all.slice(page*6,page*6+6).map((x,i)=>{
  const source=x.source??'NOTE',enabled=x.enabled?'مفعّل':'معطّل';
  return '◾ '+(page*6+i+1)+'. '+guidanceEscape(x.trigger.slice(0,80))+
   ' — '+source+' / '+enabled+
   (source==='FAQ'?'\n    FAQ: '+(x.sourceFaqId??'غير متاح'):
    source==='RULES'?'\n    المصدر: رابط القوانين المعتمد':
    '\n    الرد: '+guidanceEscape(x.response.slice(0,120)));
 });
 const rows:Button[][]=[];
 const nav:Button[]=[];
 if(page>0)nav.push(btn('⬅️ السابق','gd:1:3:r:'+d.chatId+':'+(page-1)));
 if(page+1<pages)nav.push(btn('التالي ➡️','gd:1:3:r:'+d.chatId+':'+(page+1)));
 if(nav.length)rows.push(nav);
 rows.push([btn('✏️ إدارة قواعد الرد','p4c:1:r:'+d.chatId+':0')],
  [btn('↩️ القوانين المعتمدة',group('3',d.chatId))]);
 return ui('<b>📝 فهرس المصادر والردود — 09:03</b>\n'+
  'المجموعة: <code>'+d.chatId+'</code> • '+(page+1)+'/'+pages+'\n'+
  (lines.join('\n')||'لا توجد قواعد معتمدة حاليًا.')+'\n\n'+
  'تعطيل القاعدة أو فقد مصدر FAQ يمنع الرد الآلي ولا يغيّر قانون الإشراف.',rows);
}
function faqList(d:GuidanceData,page:number):OwnerInlineScreen|null{
 const all=d.faqs,pages=Math.max(1,Math.ceil(all.length/6));
 if(page>=pages)return null;
 const visible=all.slice(page*6,page*6+6);
 const rows:Button[][]=visible.map(x=>[
  btn('📚 '+x.question.slice(0,55),'gd:1:3:d:'+d.chatId+':'+x.id)]);
 const nav:Button[]=[];
 if(page>0)nav.push(btn('⬅️ السابق','gd:1:3:f:'+d.chatId+':'+(page-1)));
 if(page+1<pages)nav.push(btn('التالي ➡️','gd:1:3:f:'+d.chatId+':'+(page+1)));
 if(nav.length)rows.push(nav);
 rows.push([btn('↩️ القوانين المعتمدة',group('3',d.chatId))]);
 return ui('<b>📚 الأسئلة المعتمدة وذات مصدر منشور — 09:03</b>\n'+
  'المجموعة: <code>'+d.chatId+'</code> • '+(page+1)+'/'+pages+
  '\nالعدد: '+all.length+'\n'+
  (visible.length?visible.map((x,i)=>'◾ '+(page*6+i+1)+'. '+guidanceEscape(x.question)).join('\n'):
   'لا توجد إجابات معتمدة ومرئية بعد.')+
  '\nلا تظهر الأسئلة المؤرشفة أو المصادر غير المنشورة أو التصنيفات المحجوبة.',rows);
}
export async function phase4GuidanceOwnerScreen(service:Phase4GuidanceService,
 actor:string,input:string):Promise<OwnerInlineScreen|null>{
 try{
  const publishCommand=/^\/guidepublish (-[1-9][0-9]{0,15})$/u.exec(input);
  if(publishCommand||/^gd:1:2:t:-[1-9][0-9]{0,15}$/u.test(input)){
   const chatId=publishCommand?.[1]??input.slice('gd:1:2:t:'.length);
   if(!validGuidanceGroup(chatId))return null;
   const {draft,preview}=await service.preparePublication(actor,chatId);
   return ui('<b>📢 معاينة المنشور التمهيدي للمجموعة</b>\n'+
    'المجموعة: <code>'+chatId+'</code>\n'+
    'الرسالة التالية ستظهر لجميع أعضاء المجموعة عند النشر.\n\n'+preview+
    '\n\nهذا اعتماد لنشر واحد فقط، وليس رسالة تلقائية لكل عضو جديد.\n'+
    'ينتهي التأكيد بعد دقيقتين؛ يتوقف النشر إذا تغيرت المصادر أو موافقة المجموعة.',
    [[btn('✅ اعتماد نشر واحد','gd:1:2:a:'+draft.id)],
     [btn('❌ إلغاء المسودة','gd:1:2:y:'+draft.id)],
     [btn('↩️ دليل المجموعة',group('2',chatId))]]);
  }
  const cmd=parseGuidanceOwnerCommand(input);
  if(cmd?.kind==='EDIT'){
   const draft=await service.edit(actor,cmd.chatId,cmd.request);
   return ui(service.preview(draft)+'\n\nالمسودة صالحة لدقيقتين فقط، ولا تنشر أي رسالة.',
    [[btn('✅ اعتماد التعديل','gd:1:2:c:'+draft.id)],
     [btn('❌ إلغاء التعديل','gd:1:2:x:'+draft.id)],
     [btn('↩️ دليل المجموعة',group('2',cmd.chatId))]]);
  }
  if(cmd?.kind==='HOME')return groups(service,actor,cmd.section==='GUIDE'?'2':'3',0);
  if(cmd?.kind==='GROUP'){
   const d=await service.ownerGroup(actor,cmd.chatId);
   return d?(cmd.section==='GUIDE'?welcome(d):fixed(d)):null;
  }
  if(input==='mi:1:i:09:02'||input==='gd:1:2:h')
   return groups(service,actor,'2',0);
  if(input==='mi:1:i:09:03'||input==='gd:1:3:h')
   return groups(service,actor,'3',0);
  if(!validPhase4GuidanceOwnerRoute(input))return null;
  const publishDecision=/^gd:1:2:([ay]):([a-f0-9]{24})$/u.exec(input);
  if(publishDecision){
   if(publishDecision[1]==='y'){
    const cancelled=await service.cancelPublicationDraft(actor,publishDecision[2]!);
    return cancelled?ui('أُلغيت مسودة النشر. لم تُرسل أي رسالة إلى المجموعة.',
     [[btn('↩️ اختيار المجموعة',root('2'))]]):null;
   }
   const job=await service.confirmPublication(actor,publishDecision[2]!);
   return ui('<b>📢 طلب نشر الدليل معتمد</b>\n'+
    'المجموعة: <code>'+job.chatId+'</code>\n'+
    'الحالة: في طابور النشر الآمن. لم نتأكد بعد من تسليم Telegram.\n'+
    'يتحقق المرسل من الصلاحيات ومصادر الدليل قبل الطلب، ولن يعيد النشر تلقائيًا عند نتيجة مجهولة.',
    [[btn('🕘 حالة النشر','gd:1:2:s:'+job.chatId)],
     [btn('↩️ دليل المجموعة',group('2',job.chatId))]]);
  }
  const postStatus=/^gd:1:2:s:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(postStatus){
   const chatId=postStatus[1]!,job=await service.publicationStatus(actor,chatId);
   const status:Record<string,string>={
    QUEUED:'في طابور الإرسال ولم تُرسل بعد',
    SENDING:'بدأت محاولة الإرسال؛ النتيجة غير محسومة',
    CONFIRMED:'أكد Telegram تسليم المنشور',
    FAILED_CONFIRMED:'فشل مؤكد؛ لا إعادة إرسال تلقائية',
    UNKNOWN_OUTCOME:'النتيجة غير مؤكدة؛ راجع المجموعة قبل أي نشر جديد',
    REVIEWED_UNKNOWN:'راجع المالك النتيجة غير المؤكدة؛ لا دليل على نجاح أو فشل النشر',
    SKIPPED:'أُلغي/تُرك دون إرسال لتغير الصلاحية أو الإعدادات'};
   return ui('<b>🕘 حالة المنشور التمهيدي — 09:02</b>\n'+
    'المجموعة: <code>'+chatId+'</code>\n'+
    (job?'الحالة: '+(status[job.status]??'غير معروفة')+
     '\nوقت الاعتماد: '+new Date(job.approvedAt).toISOString().slice(0,16).replace('T',' ')+' UTC'+
     (job.status==='CONFIRMED'&&job.messageId?'\nرقم رسالة Telegram: '+job.messageId:''):
     'لم يطلب المالك نشر دليل لهذه المجموعة بعد.')+
    '\nلا تُحسب حالة الطابور نشرًا ناجحًا.',
    [...(job?.status==='QUEUED'?[[btn('⛔ إلغاء النشر قبل الإرسال','gd:1:2:z:'+job.id)]]:[]),
     ...(job&&['SENDING','UNKNOWN_OUTCOME'].includes(job.status)&&
       Date.now()>=job.approvedAt+600000?
       [[btn('⚠️ مراجعة نتيجة الإرسال غير المؤكدة','gd:1:2:r:'+job.id)]]:[]),
     [btn('↩️ دليل المجموعة',group('2',chatId))]]);
  }
  const unknownReview=/^gd:1:2:r:([a-f0-9]{24})$/u.exec(input);
  if(unknownReview){
   return ui('<b>⚠️ تأكيد مراجعة منشور بنتيجة غير مؤكدة</b>\n\n'+
    'تحقق بنفسك من رسائل المجموعة قبل السماح بطلب نشر جديد.\n'+
    'قد يكون Telegram نشر الدليل بالفعل، وإلغاء حظر الطلبات لا يعني أنه لم يصل.\n'+
    'لن نعيد إرسال المحاولة السابقة أبدًا.',
    [[btn('✅ راجعت المجموعة وأقر بالنتيجة غير المؤكدة','gd:1:2:k:'+unknownReview[1])],
     [btn('❌ رجوع دون تغيير',root('2'))]]);
  }
  const finalizeUnknown=/^gd:1:2:k:([a-f0-9]{24})$/u.exec(input);
  if(finalizeUnknown){
   const done=await service.reviewUnknownPublication(actor,finalizeUnknown[1]!);
   return done?ui('سُجلت المراجعة البشرية للنتيجة غير المؤكدة.\n'+
    'لم نعد محاولة النشر السابقة، ويمكن الآن طلب منشور جديد بعد معاينة وموافقة مستقلة.',
    [[btn('↩️ اختيار المجموعة',root('2'))]]):null;
  }
  const cancelQueued=/^gd:1:2:z:([a-f0-9]{24})$/u.exec(input);
  if(cancelQueued){
   const done=await service.cancelQueuedPublication(actor,cancelQueued[1]!);
   return done?ui('أُلغيت مهمة نشر الدليل التي لم يبدأ إرسالها. لا تغيير في مواد الدليل.',
    [[btn('↩️ اختيار المجموعة',root('2'))]]):null;
  }
  const decision=/^gd:1:2:([cx]):([a-f0-9]{24})$/u.exec(input);
  if(decision){
   if(decision[1]==='x'){
    const cancelled=await service.cancel(actor,decision[2]!);
    return cancelled?ui('أُلغيت المسودة ولم تتغير إعدادات الدليل.',
     [[btn('↩️ اختيار المجموعة',root('2'))]]):null;
   }
   const chatId=await service.confirm(actor,decision[2]!);
   const current=await service.ownerGroup(actor,chatId);
   return current?welcome(current):null;
  }
  const list=/^gd:1:([23]):p:(0|[1-9][0-9]?)$/u.exec(input);
  if(list)return groups(service,actor,list[1]! as '2'|'3',Number(list[2]));
  const detail=/^gd:1:([23]):g:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(detail){
   const d=await service.ownerGroup(actor,detail[2]!);
   return d?(detail[1]==='2'?welcome(d):fixed(d)):null;
  }
  const page=/^gd:1:3:([rf]):(-[1-9][0-9]{0,15}):(0|[1-9][0-9]?)$/u.exec(input);
  if(page){
   const d=await service.ownerGroup(actor,page[2]!);
   return d?(page[1]==='r'?ruleList(d,Number(page[3])):
    faqList(d,Number(page[3]))):null;
  }
  const faq=/^gd:1:3:d:(-[1-9][0-9]{0,15}):([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.exec(input);
  if(!faq)return null;
  const answer=await service.ownerFAQ(actor,faq[1]!,faq[2]!);
  return answer?ui(answer,[[btn('📚 قائمة الأسئلة','gd:1:3:f:'+faq[1]+':0')],
   [btn('↩️ القوانين والرسائل',group('3',faq[1]!))]]):null;
 }catch{return null;}
}
