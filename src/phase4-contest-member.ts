import {Phase4ContestService} from './phase4-contests.js';
export type ContestMemberCommand={kind:'JOIN'|'LEAVE'|'INFO';id:string};
export function parseContestMemberCommand(input:string):ContestMemberCommand|null{
 if(typeof input!=='string'||input.length>90||/[\r\n]/u.test(input))return null;
 const m=/^\/contest(join|leave|info) ([a-f0-9]{24})$/u.exec(input);
 if(!m)return null;
 return {kind:m[1]!.toUpperCase() as ContestMemberCommand['kind'],id:m[2]!};
}
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/'/gu,'&#39;').replace(/"/gu,'&quot;');
/** Only in Telegram private origin. Does not reveal individual signups,
 * passwords, answers, scores or prize-eligibility to the requesting student.
 */
export async function contestMemberScreen(
 svc:Phase4ContestService,actor:string,input:string
):Promise<{text:string}|null>{
 const cmd=parseContestMemberCommand(input);if(!cmd)return null;
 try{
  await svc.expire();
  if(cmd.kind==='JOIN'){
   const outcome=await svc.join(actor,cmd.id);
   const messages={
    REGISTERED:'✅ تم تسجيلك في المسابقة التعليمية؛ ستظهر الأسئلة بعد بدء المالك للجولات.',
    ALREADY_REGISTERED:'ℹ️ سُجل حسابك مسبقًا أو سحبت مشاركتك؛ لا تتاح إعادة التسجيل لإعادة ضبط المحاولات.',
    VERIFICATION_REQUIRED:'🔒 لم نستطع تأكيد عضوية مجموعتك والاشتراكات المطلوبة؛ لم نسجّل المشاركة.',
    NOT_FOUND:'🔒 المسابقة غير متاحة.',
    CLOSED:'🔒 نافذة التسجيل مغلقة أو لم تُفتح بعد.',
    STALE:'🔒 تغير اعتماد المجموعة أو سياسة الاشتراكات أثناء التحقق.',
    INVALID:'🔒 الحساب أو معرّف المسابقة غير صالح.',
    CAPACITY:'⏳ بلغت المسابقة الحد الآمن للتسجيلات.'
   };
   return {text:messages[outcome.status]};
  }
  if(cmd.kind==='LEAVE'){
   return {text:await svc.withdraw(actor,cmd.id)?
    '✅ انسحبت من المسابقة؛ أُبطلت أهليتك للجولات ومسح اختيارك من سجل التسجيل، وتبقى إشارة منع إعادة التسجيل مؤقتًا.':
    '🔒 لا توجد مشاركة نشطة لهذا الحساب يمكن سحبها.'};
  }
  const c=await svc.info(actor,cmd.id);
  if(!c)return {text:'🔒 المسابقة غير متاحة أو لم يتحقق النظام من العضوية.'};
  return {text:'<b>🎮 مسابقة تعليمية — 08:02</b>\n'+
   'العنوان: '+esc(c.title)+'\nالوصف: '+esc(c.description)+
   '\nالجولات: '+c.rounds+'\nالحالة: '+c.status+
   '\nالتسجيل: '+(c.registered?'✅ أنت مسجل':'لم تسجل')+
   (c.registrationEndsAt!==undefined?
    '\nنهاية التسجيل UTC: '+new Date(c.registrationEndsAt).toISOString():'')+
   (c.status==='REGISTRATION'&&!c.registered?
    '\nللتسجيل من خاص البوت: <code>/contestjoin '+c.id+'</code>':'')+
   (c.status==='RUNNING'&&c.registered&&c.currentQuizId?
    '\nالسؤال الحالي: <code>/quizinfo '+c.currentQuizId+'</code>':'')+
   '\nللانسحاب: <code>/contestleave '+c.id+'</code>'+
   '\nهذه مسابقة تدريبية بلا رسوم أو جوائز أو ضمان أهلية منحة. لا يتم نشر أسماء المشاركين.'};
 }catch{return {text:'🔒 تعذر تنفيذ العملية دون تغيير مجموعات Telegram أو إرسال رسائل.'};}
}
