import {Phase4DiscussionService} from './phase4-discussions.js';

/** Only private Telegram messages from a verified sender may reach this UI.
 * This parser never treats the session/question ID as an access token. */
export type DiscussionMemberCommand=
 |{kind:'ASK';sessionId:string;text:string}
 |{kind:'WITHDRAW'|'STATUS'|'ANSWER';questionId:string};
export function parseDiscussionMemberCommand(value:string):DiscussionMemberCommand|null{
 if(typeof value!=='string'||value.length>530)return null;
 const ask=/^\/discussask ([a-f0-9]{24}) ([^\r\n]{4,400})$/u.exec(value);
 if(ask)return {kind:'ASK',sessionId:ask[1]!,text:ask[2]!};
 const other=/^\/discuss(withdraw|status|answer) ([a-f0-9]{24})$/u.exec(value);
 if(other)return {kind:other[1]==='withdraw'?'WITHDRAW':
  other[1]==='answer'?'ANSWER':'STATUS',questionId:other[2]!};
 return null;
}
export interface DiscussionMemberScreen{readonly text:string;}
/** Student responses never echo submitted content, reveal other students
 * or claim that a question was sent to a public chat or accepted by an expert. */
export async function discussionMemberScreen(
 service:Phase4DiscussionService,actor:string,input:string
):Promise<DiscussionMemberScreen|null>{
 const cmd=parseDiscussionMemberCommand(input);
 if(!cmd)return null;
 try{
  if(cmd.kind==='ASK'){
   const received=await service.ask(actor,cmd.sessionId,cmd.text);
   switch(received.status){
    case 'RECEIVED':
     return {text:'📥 تم استلام سؤالك في صندوق المراجعة الخاص. لا يُنشر تلقائيًا.\n'+
      'رقم سؤالك: <code>'+received.questionId+'</code>\n'+
      'لسحب السؤال: <code>/discusswithdraw '+received.questionId+'</code>\n'+
      'لمعرفة الحالة: <code>/discussstatus '+received.questionId+'</code>'};
    case 'ALREADY_SUBMITTED':return {text:'ℹ️ يوجد سؤال مسجّل لهذا الحساب في الجلسة؛ يُسمح بسؤال واحد لكل جلسة.'};
    case 'FULL':return {text:'⏳ اكتمل العدد المسموح من الأسئلة. لم يُضف سؤال جديد.'};
    case 'VERIFICATION_REQUIRED':return {text:'🔒 تعذّر التحقق من عضويتك أو الاشتراكات المطلوبة. لم يُحفظ السؤال.'};
    case 'EXPIRED':case 'CLOSED':return {text:'🔒 باب الأسئلة لهذه الجلسة مغلق أو انتهى موعده.'};
    case 'INVALID':return {text:'🔒 أدخل سؤالًا بين 4 و400 حرف، دون روابط أو أسماء مستخدمين أو بيانات تواصل.'};
    default:return {text:'🔒 هذه الجلسة غير متاحة حاليًا أو تغيّر تفويضها. لم يُحفظ السؤال.'};
   }
  }
  if(cmd.kind==='WITHDRAW'){
   const removed=await service.withdraw(actor,cmd.questionId);
   return {text:removed?
    '✅ تم سحب سؤالك وحذف نصه من السجل النشط. لا يمكن استرداد ما ظهر سابقًا في معاينة.':
    '🔒 تعذّر سحب هذا السؤال أو لم يعد لديك سؤال نشط بهذا الرقم.'};
  }
  if(cmd.kind==='ANSWER'){
   const verified=await service.myApprovedAnswer(actor,cmd.questionId);
   const escape=(x:string)=>x.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
    .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
   return {text:verified?
    '📚 إجابة معتمدة من الأسئلة الشائعة:\n'+escape(verified.answer)+
    '\nالمصدر المعتمد: <code>'+escape(verified.sourceId)+'</code>':
    '🔒 لا توجد إجابة موثقة سارية لهذا السؤال أو لم تعد متاحة لهذا الحساب.'};
  }
  const status=await service.myQuestion(actor,cmd.questionId);
  const labels={
   PENDING:'⏳ بانتظار المراجعة',APPROVED:'✅ معتمد للمراجعة، لم يُنشر',
   REJECTED:'🔒 مرفوض ونصه محذوف',WITHDRAWN:'✅ مسحوب ونصه محذوف',
   ANSWERED:'☑️ مميز كمجاب عنه محليًا، بلا إرسال تلقائي',
   ARCHIVED:'🗃️ أُغلقت الجلسة وحُذف نص السؤال'
  };
  return {text:status?
   '📋 حالة سؤالك: '+labels[status.status]:
   '🔒 لا يوجد سؤال بهذا الرقم لهذا الحساب.'};
 }catch{
  return {text:'🔒 تعذّر تنفيذ طلبك. لم يتم نشر أي سؤال في المجموعة.'};
 }
}
