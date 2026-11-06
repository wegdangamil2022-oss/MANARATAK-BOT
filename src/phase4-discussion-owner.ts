import {Phase4DiscussionService,type DiscussionDraftInput} from './phase4-discussions.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const HEX='[a-f0-9]{24}';
const ACTION=new RegExp('^dq:1:(?:h|[slq]:'+HEX+'|[okardc]:'+HEX+':[1-4])$','u');
export const validDiscussionOwnerRoute=(x:unknown):x is string=>
 typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&ACTION.test(x);
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:0');
const home=btn('📋 الجلسات','dq:1:h');
const USER=/^[1-9][0-9]{0,15}$/u;
const CHAT=/^-[1-9][0-9]{0,15}$/u;
export type DiscussionOwnerCommand=
 |{kind:'LIST'}
 |{kind:'CREATE';chatId:string;input:DiscussionDraftInput};
export function parseDiscussionOwnerCommand(input:string):DiscussionOwnerCommand|null{
 if(input==='/discussions')return {kind:'LIST'};
 if(typeof input!=='string'||input.length>180)return null;
 const m=/^\/discussionnew (-[1-9][0-9]{0,15}) ([0-9]{1,4}) ([0-9]{1,3}) ([^\r\n]{4,100})$/u.exec(input);
 if(!m||!CHAT.test(m[1]!)||!Number.isSafeInteger(Number(m[1]))||
  !USER.test(m[2]!)||!USER.test(m[3]!)||
  Number(m[2])<15||Number(m[2])>1440||
  Number(m[3])<1||Number(m[3])>100)return null;
 return {kind:'CREATE',chatId:m[1]!,input:{
  durationMinutes:Number(m[2]),maxQuestions:Number(m[3]),title:m[4]!
 }};
}
async function sessionDetail(service:Phase4DiscussionService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const row=await service.ownerView(actor,id);if(!row)return null;
 const questions=await service.ownerQuestions(actor,id);if(!questions)return null;
 const used=questions.length,approved=questions.filter(q=>q.status==='APPROVED'||q.status==='ANSWERED').length;
 const labels={DRAFT:'📝 مسودة لم تُفتح',OPEN:'✅ باب الأسئلة مفتوح محليًا',
  CLOSED:'🔒 مغلقة ومحتوى الأسئلة محذوف'};
 const text='<b>💬 جلسة نقاش وأسئلة — 09:07</b>\n'+
  'العنوان: '+escape(row.title)+'\n'+
  'المجموعة: <code>'+row.chatId+'</code>\n'+
  (row.topicId===undefined?'':'موضوع Forum: '+row.topicId+'\n')+
  'الحالة: '+labels[row.status]+'\n'+
  'السعة: '+used+'/'+row.maxQuestions+' · مجاب/معتمد: '+approved+'\n'+
  'تنتهي: '+new Date(row.expiresAt).toISOString()+'\n'+
  '🔒 لا توجد رسالة مجموعة أو نشر تلقائي للأسئلة. المراجعة خاصة بالمالك.';
 const actions:{text:string;callback_data:string}[][]=[];
 if(row.status==='DRAFT')actions.push([btn('✅ فتح استقبال الأسئلة بعد المعاينة','dq:1:o:'+id+':'+row.revision)]);
 if(row.status==='OPEN')actions.push(
  [btn('📥 مراجعة الأسئلة ('+used+')','dq:1:l:'+id)],
  [btn('🔒 مراجعة إغلاق الجلسة','dq:1:k:'+id+':'+row.revision)]);
 actions.push([home],[back]);return ui(text,actions);
}
async function questionList(service:Phase4DiscussionService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const session=await service.ownerView(actor,id);
 const questions=await service.ownerQuestions(actor,id);
 if(!session||!questions)return null;
 const actions=questions.slice(0,12).map(q=>[btn(
  (q.status==='PENDING'?'⏳ ':q.status==='APPROVED'?'✅ ':'🗃️ ')+
  q.status+' · '+new Date(q.createdAt).toISOString().slice(11,16),
  'dq:1:q:'+q.id)]);
 actions.push([btn('↩️ الجلسة','dq:1:s:'+id)],[home]);
 return ui('<b>📥 طابور أسئلة الجلسة</b>\n'+escape(session.title)+'\n'+
  'العدد: '+questions.length+' — تظهر أول 12 للمراجعة.\n'+
  '🔐 لا نعرض هويات الطلاب، ولا ننشر النص في المجموعة.',actions);
}
async function questionDetail(service:Phase4DiscussionService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const q=await service.ownerQuestion(actor,id);if(!q)return null;
 const session=await service.ownerView(actor,q.sessionId);if(!session)return null;
 const actions:{text:string;callback_data:string}[][]=[];
 if(session.status==='OPEN'&&q.status==='PENDING'){
  actions.push([btn('✅ اعتماد السؤال محليًا','dq:1:a:'+id+':'+q.revision)],
   [btn('🚫 رفض وحذف النص','dq:1:r:'+id+':'+q.revision)]);
 }else if(session.status==='OPEN'&&q.status==='APPROVED')
  actions.push([btn('☑️ تمييز كمجاب عنه (محليًا)','dq:1:d:'+id+':'+q.revision)]);
 actions.push([btn('↩️ جميع الأسئلة','dq:1:l:'+q.sessionId)],[home]);
 return ui('<b>💬 مراجعة سؤال (خاص بالمالك)</b>\n'+
  'الحالة: '+q.status+' · الإصدار: '+q.revision+'\n'+
  (q.text===undefined?'🔒 نص السؤال محذوف.':'<b>السؤال:</b>\n'+escape(q.text))+
  '\n\n⚠️ اعتماد السؤال أو تمييزه كمجاب عنه لا ينشره في Telegram ولا ينشئ ردًا للطالب.',
  actions);
}
/** Every destructive or state-changing callback is re-authorized at commit. */
export async function discussionOwnerScreen(
 service:Phase4DiscussionService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const cmd=parseDiscussionOwnerCommand(input);
  if(cmd?.kind==='CREATE'){
   const session=await service.draft(actor,cmd.chatId,cmd.input);
   return sessionDetail(service,actor,session.id);
  }
  if(cmd?.kind==='LIST'||input==='mi:1:i:09:07'||input==='dq:1:h'){
   const sessions=await service.list(actor);
   const items=sessions.slice(0,12).map(s=>[btn(
    (s.status==='DRAFT'?'📝 ':s.status==='OPEN'?'✅ ':'🔒 ')+
    s.title.slice(0,23)+' · '+s.chatId,'dq:1:s:'+s.id
   )]);
   items.push([back]);
   return ui('<b>💬 النقاشات والأسئلة — 09:07</b>\n'+
    'أنشئ جلسة أسئلة خاصة بالمراجعة:\n'+
    '<code>/discussionnew -1001234 60 30 أسئلة منح الصين</code>\n'+
    'الصيغة: معرّف المجموعة · المدة بالدقائق (15–1440) · الحد (1–100) · العنوان.\n'+
    'تفتح الجلسة بعد معاينتها، ويُرسل الطالب سؤاله عبر الخاص فقط:\n'+
    '<code>/discussask SESSION_ID نص السؤال</code>\n'+
    'لا يتم نشر أسئلة أو الكشف عن هوية طالب تلقائيًا.\n'+
    'الجلسات: '+sessions.length+' (آخر 12 هنا).',items);
  }
  if(!validDiscussionOwnerRoute(input))return null;
  const session=/^dq:1:s:([a-f0-9]{24})$/u.exec(input);
  if(session)return sessionDetail(service,actor,session[1]!);
  const questions=/^dq:1:l:([a-f0-9]{24})$/u.exec(input);
  if(questions)return questionList(service,actor,questions[1]!);
  const question=/^dq:1:q:([a-f0-9]{24})$/u.exec(input);
  if(question)return questionDetail(service,actor,question[1]!);
  const open=/^dq:1:o:([a-f0-9]{24}):([1-4])$/u.exec(input);
  if(open){
   if(!await service.open(actor,open[1]!,Number(open[2])))return null;
   return sessionDetail(service,actor,open[1]!);
  }
  const check=/^dq:1:k:([a-f0-9]{24}):([1-4])$/u.exec(input);
  if(check){
   const row=await service.ownerView(actor,check[1]!);
   if(!row||row.status==='CLOSED'||row.revision!==Number(check[2]))return null;
   return ui('<b>⚠️ تأكيد إغلاق الجلسة</b>\n'+
    'ستُحذف نصوص جميع الأسئلة من التخزين النشط ولن تُقبل أسئلة جديدة.\n'+
    'الجلسة: '+escape(row.title)+'\nلم يتم إرسال شيء إلى المجموعة.',
    [[btn('🔒 تأكيد الإغلاق','dq:1:c:'+row.id+':'+row.revision)],
     [btn('↩️ إلغاء','dq:1:s:'+row.id)]]);
  }
  const close=/^dq:1:c:([a-f0-9]{24}):([1-4])$/u.exec(input);
  if(close){
   if(!await service.close(actor,close[1]!,Number(close[2])))return null;
   return sessionDetail(service,actor,close[1]!);
  }
  const moderation=/^dq:1:([ard]):([a-f0-9]{24}):([1-4])$/u.exec(input);
  if(moderation){
   const decision=moderation[1]==='a'?'APPROVED':
    moderation[1]==='r'?'REJECTED':'ANSWERED';
   if(!await service.moderate(actor,moderation[2]!,decision,Number(moderation[3])))
    return null;
   return questionDetail(service,actor,moderation[2]!);
  }
  return null;
 }catch{return null;}
}
