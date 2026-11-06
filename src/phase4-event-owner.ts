import {Phase4EventService} from './phase4-events.js';
import {validEventSummaryInput,validEventURL} from './phase4-event-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const ID='[a-f0-9]{24}';
const ROUTE=new RegExp('^ev:1:(?:h|p:[0-4]|[vs]:'+ID+'|[okcm]:'+ID+':[1-3]|[qb]:'+ID+':'+ID+':[12])$','u');
export const validEventOwnerRoute=(x:unknown):x is string=>
 typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&ROUTE.test(x);
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const button=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const home=button('🗓️ اللقاءات','ev:1:h');
const back=button('↩️ صفحة التفاعل','mi:1:s:09:1');
export type EventOwnerCommand=
 |{kind:'LIST'}
 |{kind:'CREATE';chatId:string;input:{
  title:string;startsAt:number;durationMinutes:number;capacity:number;link:string;
 }}
 |{kind:'DRAFT_SUMMARY';eventId:string;text:string;urls:string[]}
 |{kind:'LINK_QUESTIONS'|'LINK_POLL';eventId:string;linkedId:string};
export function parseEventOwnerCommand(value:string):EventOwnerCommand|null{
 if(value==='/events')return {kind:'LIST'};
 const link=/^\/event(questions|poll) ([a-f0-9]{24}) ([a-f0-9]{24})$/u.exec(value);
 if(link)return {kind:link[1]==='questions'?'LINK_QUESTIONS':'LINK_POLL',
  eventId:link[2]!,linkedId:link[3]!};
 if(typeof value!=='string'||value.length>1400||/[\r\n]/u.test(value))return null;
 const create=/^\/eventnew (-[1-9][0-9]{0,15}) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) ([0-9]{1,3}) ([0-9]{1,3}) (\S+) (.{5,100})$/u.exec(value);
 if(create){
  const startsAt=Date.parse(create[2]!);
  if(!Number.isSafeInteger(Number(create[1]))||!Number.isSafeInteger(startsAt)||
   !validEventURL(create[5])||new Date(startsAt).toISOString()!==create[2])return null;
  return {kind:'CREATE',chatId:create[1]!,input:{
   startsAt,durationMinutes:Number(create[3]),capacity:Number(create[4]),
   link:create[5]!,title:create[6]!
  }};
 }
 const summary=/^\/eventsummarynew ([a-f0-9]{24}) (.{20,1120})$/u.exec(value);
 if(summary){
  const fields=summary[2]!.split(' | ');
  const text=fields[0]??'',urls=fields.slice(1);
  if(!validEventSummaryInput(text,urls))return null;
  return {kind:'DRAFT_SUMMARY',eventId:summary[1]!,text,urls};
 }
 return null;
}
async function detail(service:Phase4EventService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const event=await service.view(actor,id);if(!event)return null;
 const summary=await service.ownerSummary(actor,id);
 const labels={DRAFT:'📝 مسودة للمراجعة',OPEN:'✅ استقبال التسجيلات',
  CANCELLED:'🔒 ملغى',FINISHED:'🏁 انتهى اللقاء'} as const;
 const rows:{text:string;callback_data:string}[][]=[];
 if(event.status==='DRAFT')rows.push([
  button('✅ فتح التسجيل بعد المعاينة','ev:1:o:'+id+':'+event.revision)]);
 if(event.status==='OPEN'){
  rows.push([button('⚠️ مراجعة إلغاء اللقاء','ev:1:k:'+id+':'+event.revision)]);
 }
 if(summary?.status==='DRAFT')rows.push([
  button('📚 مراجعة الملخص واعتماده','ev:1:s:'+id)]);
 if(summary?.status==='APPROVED')rows.push([
  button('📚 الملخص المعتمد','ev:1:s:'+id)]);
 rows.push([home],[back]);
 const consent=await service.reminderCount(actor,id);
 return ui('<b>🗓️ اللقاءات والفعاليات — 09:09</b>\n'+
  'العنوان: '+escape(event.title)+'\n'+
  'المجموعة: <code>'+event.chatId+'</code>\n'+
  'تاريخ اللقاء (UTC): '+new Date(event.startsAt).toISOString()+'\n'+
  'النهاية (UTC): '+new Date(event.endsAt).toISOString()+'\n'+
  'رابط الحضور الذي يراجعه المالك: '+escape(event.link)+'\n'+
  'السعة القصوى: '+event.capacity+'\n'+
  (consent===null?'':'موافقات التذكير المسجلة محليًا: '+consent+'\n')+
  'الحالة: '+labels[event.status]+'\n'+
  'معرّف اللقاء: <code>'+event.id+'</code>\n'+
  (event.questionSessionId?'أسئلة الطلاب المسبقة: <code>'+event.questionSessionId+'</code>\n':'')+
  (event.pollId?'استطلاع التحضير: <code>'+event.pollId+'</code>\n':'')+
  (event.status==='OPEN'&&!event.questionSessionId?'للربط بعد فتح الأسئلة: <code>/eventquestions '+id+' SESSION_ID</code>\n':'')+
  (event.status==='OPEN'&&!event.pollId?'للربط بعد فتح الاستطلاع: <code>/eventpoll '+id+' POLL_ID</code>\n':'')+
  'للمشاركة اليدوية: <code>/eventjoin '+id+' no</code>\n'+
  'ملخص اللقاء: '+(summary?summary.status:'لم يُعد بعد')+'\n'+
  '🔐 لا يوجد إعلان جماعي ولا تذكير تلقائي ولا إثبات حضور.',
  rows);
}
async function list(service:Phase4EventService,actor:string,page=0):
 Promise<OwnerInlineScreen|null>{
 const rows=(await service.list(actor));
 const pages=Math.max(1,Math.ceil(rows.length/10));
 if(page<0||page>=pages||!Number.isSafeInteger(page))return null;
 const buttons=rows.slice(page*10,page*10+10).map(e=>[button(
  (e.status==='DRAFT'?'📝 ':e.status==='OPEN'?'✅ ':e.status==='FINISHED'?'🏁 ':'🔒 ')+
   e.title.slice(0,23),'ev:1:v:'+e.id)]);
 if(pages>1){
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(button('⬅️ السابق','ev:1:p:'+(page-1)));
  if(page+1<pages)nav.push(button('التالي ➡️','ev:1:p:'+(page+1)));
  if(nav.length)buttons.push(nav);
 }
 buttons.push([back]);
 return ui('<b>🗓️ اللقاءات والفعاليات — 09:09</b>\n'+
  'أنشئ لقاء ثم راجع الموعد والرابط والسعة قبل فتح التسجيل:\n'+
  '<code>/eventnew -1001234 2026-12-01T15:00:00.000Z 60 100 https://university.example.edu/event ندوة التقديم للمنح</code>\n'+
  'التوقيت: UTC بصيغة ISO كاملة، المدة 15–360 دقيقة، السعة 1–500.\n'+
  'التسجيل اختياري من خاص الطالب: <code>/eventjoin EVENT_ID yes</code> لتفعيل موافقة التذكير، أو <code>no</code> دون موافقة.\n'+
  'للموارد بعد انتهاء اللقاء: <code>/eventsummarynew EVENT_ID نص الملخص (20 حرفًا فأكثر) | https://university.example.edu/resource</code>\n'+
  'يُراجع المالك الملخص ويعتمده بشكل منفصل.\n'+
  'هذه إدارة محلية، وليست إرسال Telegram تلقائيًا.\n'+
  'صفحة '+(page+1)+' من '+pages+' · عدد اللقاءات '+rows.length,buttons);
}
async function summaryReview(service:Phase4EventService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const e=await service.view(actor,id),summary=await service.ownerSummary(actor,id);
 if(!e||!summary)return null;
 const rows:{text:string;callback_data:string}[][]=[];
 if(summary.status==='DRAFT')rows.push([
  button('✅ تأكيد اعتماد الملخص','ev:1:m:'+id+':'+summary.revision)]);
 rows.push([button('↩️ تفاصيل اللقاء','ev:1:v:'+id)],[home]);
 return ui('<b>📚 مراجعة ملخص اللقاء (المالك فقط)</b>\n'+
  'الحالة: '+summary.status+'\n'+
  'اللقاء: '+escape(e.title)+'\n'+
  'النص:\n'+escape(summary.text)+'\n'+
  (summary.urls.length?'روابط المراجع التي أدخلها المالك:\n'+summary.urls.map(escape).join('\n')+'\n':'')+
  '⚠️ اعتماد الملخص يتيحه بالطلب لأعضاء المجموعة المُتحقق منهم، دون إرسال جماعي أو ادعاء رصد حضور.',
  rows);
}
export async function eventOwnerScreen(service:Phase4EventService,actor:string,input:string):
 Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const parsed=parseEventOwnerCommand(input);
  if(parsed?.kind==='CREATE'){
   const e=await service.draft(actor,parsed.chatId,parsed.input);
   return detail(service,actor,e.id);
  }
  if(parsed?.kind==='DRAFT_SUMMARY'){
   await service.draftSummary(actor,parsed.eventId,parsed.text,parsed.urls);
   return summaryReview(service,actor,parsed.eventId);
  }
  if(parsed?.kind==='LINK_QUESTIONS'){
   const review=await service.previewQuestionLink(actor,parsed.eventId,parsed.linkedId);
   if(!review)return null;
   return ui('<b>❓ مراجعة ربط أسئلة ما قبل اللقاء</b>\n'+
    'اللقاء: '+escape(review.eventTitle)+'\n'+
    'جلسة الأسئلة: '+escape(review.sessionTitle)+'\n'+
    'نهاية استقبال الأسئلة (UTC): '+new Date(review.expiresAt).toISOString()+'\n'+
    'لن تُنشر الأسئلة، ولن تُعرض هويات الطلاب من هذا الربط.',
    [[button('✅ تأكيد الربط مرة واحدة','ev:1:q:'+parsed.eventId+':'+parsed.linkedId+':2')],
     [button('↩️ إلغاء','ev:1:v:'+parsed.eventId)]]);
  }
  if(parsed?.kind==='LINK_POLL'){
   const review=await service.previewPollLink(actor,parsed.eventId,parsed.linkedId);
   if(!review)return null;
   return ui('<b>📊 مراجعة ربط استطلاع ما قبل اللقاء</b>\n'+
    'اللقاء: '+escape(review.eventTitle)+'\n'+
    'سؤال الاستطلاع: '+escape(review.pollQuestion)+'\n'+
    'نهاية التصويت (UTC): '+new Date(review.expiresAt).toISOString()+'\n'+
    'لا يُرسل استطلاع أو نتيجة للمجموعة تلقائيًا.',
    [[button('✅ تأكيد الربط مرة واحدة','ev:1:b:'+parsed.eventId+':'+parsed.linkedId+':2')],
     [button('↩️ إلغاء','ev:1:v:'+parsed.eventId)]]);
  }
  if(parsed?.kind==='LIST'||input==='mi:1:i:09:09'||input==='ev:1:h')
   return list(service,actor);
  if(!validEventOwnerRoute(input))return null;
  const page=/^ev:1:p:([0-4])$/u.exec(input);
  if(page)return list(service,actor,Number(page[1]));
  const view=/^ev:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const summary=/^ev:1:s:([a-f0-9]{24})$/u.exec(input);
  if(summary)return summaryReview(service,actor,summary[1]!);
  const questionLink=/^ev:1:q:([a-f0-9]{24}):([a-f0-9]{24}):([12])$/u.exec(input);
  if(questionLink){
   if(!await service.bindQuestionSession(actor,questionLink[1]!,questionLink[2]!,
    Number(questionLink[3])))return null;
   return detail(service,actor,questionLink[1]!);
  }
  const pollLink=/^ev:1:b:([a-f0-9]{24}):([a-f0-9]{24}):([12])$/u.exec(input);
  if(pollLink){
   if(!await service.bindPoll(actor,pollLink[1]!,pollLink[2]!,
    Number(pollLink[3])))return null;
   return detail(service,actor,pollLink[1]!);
  }
  const opened=/^ev:1:o:([a-f0-9]{24}):([1-3])$/u.exec(input);
  if(opened){
   if(!await service.open(actor,opened[1]!,Number(opened[2])))return null;
   return detail(service,actor,opened[1]!);
  }
  const check=/^ev:1:k:([a-f0-9]{24}):([1-3])$/u.exec(input);
  if(check){
   const e=await service.view(actor,check[1]!);
   if(!e||e.status!=='OPEN'||e.revision!==Number(check[2]))return null;
   return ui('<b>⚠️ مراجعة إلغاء اللقاء</b>\n'+escape(e.title)+
    '\nسيُلغى التسجيل لكل المشاركين وتُحذف معرفات التسجيل النشطة دون إرسال تنبيهات تلقائية.',
    [[button('🔒 تأكيد الإلغاء','ev:1:c:'+e.id+':'+e.revision)],
     [button('↩️ إلغاء','ev:1:v:'+e.id)]]);
  }
  const cancel=/^ev:1:c:([a-f0-9]{24}):([1-3])$/u.exec(input);
  if(cancel){
   if(!await service.cancel(actor,cancel[1]!,Number(cancel[2])))return null;
   return detail(service,actor,cancel[1]!);
  }
  const publish=/^ev:1:m:([a-f0-9]{24}):([1-3])$/u.exec(input);
  if(publish){
   if(!await service.approveSummary(actor,publish[1]!,Number(publish[2])))return null;
   return summaryReview(service,actor,publish[1]!);
  }
  return null;
 }catch{return null;}
}
