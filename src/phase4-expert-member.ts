import {Phase4ExpertService} from './phase4-experts.js';

export function parseExpertMemberCommand(value:string):
 {kind:'SUMMARY';sessionId:string}|null{
 if(typeof value!=='string'||value.length>80)return null;
 const m=/^\/amasummary ([a-f0-9]{24})$/u.exec(value);
 return m?{kind:'SUMMARY',sessionId:m[1]!}:null;
}
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
/** Private, verified membership-gated reviewed session summary.
 * Does not expose a student question, speaker credentials or user IDs.
 */
export async function expertMemberScreen(
 service:Phase4ExpertService,actor:string,input:string
):Promise<{text:string}|null>{
 const command=parseExpertMemberCommand(input);if(!command)return null;
 try{
  const answer=await service.memberSummary(actor,command.sessionId);
  return {text:answer?
   '📚 <b>ملخص جلسة اسأل الخبير — راجعه مالك المجموعة</b>\n'+
   escape(answer.text)+(answer.urls.length?
    '\nروابط المراجع التي راجعها المالك:\n'+answer.urls.map(escape).join('\n'):'')+
   '\n\n⚠️ المحتوى إرشادي، وليس قرار قبول أو ضمان منحة. لا يعني هذا أن Telegram أو الجامعة تحقق من صفة المتحدث.':
   '🔒 لا يتوفر ملخص معتمد لهذا الحساب أو تغيّرت صلاحية المجموعة.'};
 }catch{return {text:'🔒 تعذّر جلب ملخص معتمد، ولم تُرسل أي رسالة جماعية.'};}
}
