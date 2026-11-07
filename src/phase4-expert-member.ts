import {Phase4ExpertService} from './phase4-experts.js';
import type {ExpertReportReason} from './phase4-expert-model.js';

export type ExpertMemberCommand=
 |{kind:'SUMMARY';sessionId:string}
 |{kind:'VOTE'|'UNVOTE';sessionId:string;questionId:string}
 |{kind:'REPORT';sessionId:string;questionId:string;reason:ExpertReportReason};
export function parseExpertMemberCommand(value:string):ExpertMemberCommand|null{
 if(typeof value!=='string'||value.length>115)return null;
 const summary=/^\/amasummary ([a-f0-9]{24})$/u.exec(value);
 if(summary)return {kind:'SUMMARY',sessionId:summary[1]!};
 const vote=/^\/ama(vote|unvote) ([a-f0-9]{24}) ([a-f0-9]{24})$/u.exec(value);
 if(vote)return {kind:vote[1]==='vote'?'VOTE':'UNVOTE',
  sessionId:vote[2]!,questionId:vote[3]!};
 const report=/^\/amareport ([a-f0-9]{24}) ([a-f0-9]{24}) (CONTACT_DETAILS|UNLICENSED_ADVICE|HARASSMENT)$/u.exec(value);
 if(report)return {kind:'REPORT',sessionId:report[1]!,questionId:report[2]!,
  reason:report[3]! as ExpertReportReason};
 return null;
}
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
/** Every member action is initiated privately, and Telegram sender ID is
 * authenticated before this function is called from transport. No question
 * text, student ID or public popularity tally is returned to other members.
 */
export async function expertMemberScreen(
 service:Phase4ExpertService,actor:string,input:string
):Promise<{text:string}|null>{
 const command=parseExpertMemberCommand(input);if(!command)return null;
 try{
  if(command.kind==='VOTE'){
   const result=await service.voteQuestion(actor,command.sessionId,command.questionId);
   const messages={
    CAST:'✅ سُجّل تأييدك لهذا السؤال في الطابور المحلي. هذا ليس نشرًا أو إجابة من الخبير.',
    ALREADY_VOTED:'ℹ️ سبق أن صوّت هذا الحساب لهذا السؤال أو سحب صوته. لا يمكن تكرار التأييد.',
    SELF_VOTE:'🔒 لا يمكن تأييد السؤال الذي قدمته بنفسك.',
    NOT_APPROVED:'🔒 لم يُعتمد هذا السؤال للمشاركة في التصويت.',
    CLOSED:'🔒 نافذة التصويت غير متاحة أو انتهت.',
    STALE:'🔒 تغيّر اعتماد المجموعة أو سياسة الاشتراكات. لم يُسجّل صوت.',
    VERIFICATION_REQUIRED:'🔒 تعذّر التحقق من عضويتك واشتراكاتك. لم يُسجّل صوت.',
    CAPACITY:'⏳ بلغ طابور الأصوات الحد المسموح.',
    INVALID:'🔒 بيانات التصويت غير صالحة.'
   };
   return {text:messages[result.status]};
  }
  if(command.kind==='UNVOTE'){
   const ok=await service.withdrawVote(actor,command.sessionId,command.questionId);
   return {text:ok?
    '✅ سُحب تأييدك. يحتفظ النظام بسجل محدود يمنع تكرار التصويت؛ يُزال بعد انتهاء مدة الخصوصية.':
    '🔒 لا يوجد صوت نشط لهذا الحساب يمكن سحبه.'};
  }
  if(command.kind==='REPORT'){
   const result=await service.reportQuestion(actor,command.sessionId,command.questionId,command.reason);
   const messages={
    REPORTED:'✅ سُجّل بلاغك الخاص للمراجعة من المالك، دون نشر اسمك أو النص في المجموعة.',
    ALREADY_REPORTED:'ℹ️ سبق أن بلّغ هذا الحساب عن هذا السؤال.',
    NOT_APPROVED:'🔒 لا يمكن الإبلاغ عبر هذا المسار إلا عن سؤال معتمد ومتاح للمراجعة.',
    CLOSED:'🔒 انتهت جلسة السؤال أو أُغلق باب البلاغات.',
    STALE:'🔒 تغيّر تفويض المجموعة أو سياسة الاشتراكات. لم يُسجّل بلاغ.',
    VERIFICATION_REQUIRED:'🔒 تعذّر التحقق من العضوية. لم يُسجّل بلاغ.',
    CAPACITY:'⏳ امتلأ طابور البلاغات الآمن.',
    INVALID:'🔒 نوع البلاغ أو معرّفات الطلب غير صحيحة.'
   };
   return {text:messages[result.status]};
  }
  const answer=await service.memberSummary(actor,command.sessionId);
  return {text:answer?
   '📚 <b>ملخص جلسة اسأل الخبير — راجعه مالك المجموعة</b>\n'+
   escape(answer.text)+(answer.urls.length?
    '\nروابط المراجع التي راجعها المالك:\n'+answer.urls.map(escape).join('\n'):'')+
   '\n\n⚠️ المحتوى إرشادي، وليس قرار قبول أو ضمان منحة. لا يعني هذا أن Telegram أو الجامعة تحقق من صفة المتحدث.':
   '🔒 لا يتوفر ملخص معتمد لهذا الحساب أو تغيّرت صلاحية المجموعة.'};
 }catch{return {text:'🔒 تعذّر تنفيذ طلبك الخاص ولم تُرسل رسالة جماعية.'};}
}
