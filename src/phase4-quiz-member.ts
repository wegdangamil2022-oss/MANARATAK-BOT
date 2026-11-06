import {Phase4QuizService} from './phase4-quizzes.js';
export type QuizMemberCommand=
 |{kind:'INFO'|'WITHDRAW'|'STATUS';quizId:string}
 |{kind:'ANSWER';quizId:string;choice:number};
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
export function parseQuizMemberCommand(input:string):QuizMemberCommand|null{
 if(typeof input!=='string'||input.length>100||/[\r\n]/u.test(input))return null;
 const ans=/^\/quizanswer ([a-f0-9]{24}) ([1-4])$/u.exec(input);
 if(ans)return {kind:'ANSWER',quizId:ans[1]!,choice:Number(ans[2])-1};
 const m=/^\/quiz(info|withdraw|status) ([a-f0-9]{24})$/u.exec(input);
 if(!m)return null;
 return {kind:m[1]!.toUpperCase() as 'INFO'|'WITHDRAW'|'STATUS',quizId:m[2]!};
}
/** Private student workflow; never emits answers or scores to a group,
 * and never reveals correct answers until a server-side CLOSED state.
 */
export async function quizMemberScreen(svc:Phase4QuizService,memberId:string,input:string):
 Promise<{text:string}|null>{
 const cmd=parseQuizMemberCommand(input);if(!cmd)return null;
 try{
  await svc.expire();
  if(cmd.kind==='ANSWER'){
   const result=await svc.answer(memberId,cmd.quizId,cmd.choice);
   const messages={
    RECORDED:'✅ تم تسجيل إجابتك مرة واحدة. لا تظهر صحة الإجابة قبل إغلاق الجولة.',
    ALREADY_ANSWERED:'ℹ️ هذا الحساب أجاب بالفعل أو سحب إجابته. لا تتاح محاولة ثانية.',
    VERIFICATION_REQUIRED:'🔒 لم يثبت تحقق عضويتك واشتراكات المجموعة المطلوبة. لم تُسجّل الإجابة.',
    NOT_FOUND:'🔒 السؤال غير متاح.',
    CLOSED:'🔒 السؤال مغلق أو لم يفتح بعد.',
    EXPIRED:'⌛ انتهى وقت الإجابة.',
    STALE:'🔒 تغيّر اعتماد المجموعة أو سياسة الاشتراك أثناء التحقق.',
    INVALID:'🔒 خيار الإجابة أو الحساب أو المعرّف غير صالح.',
    CAPACITY:'⏳ وصل السؤال إلى الحد الآمن للإجابات.'
   };
   return {text:messages[result.status]+(result.status==='RECORDED'?
    '\nلإخفاء اختيارك وإيقاف احتسابه: <code>/quizwithdraw '+cmd.quizId+'</code>':'')};
  }
  if(cmd.kind==='WITHDRAW'){
   const changed=await svc.withdraw(memberId,cmd.quizId);
   return {text:changed?'✅ مُسحت إجابتك واختيارك من التقييم، مع إبقاء حاجز عدم إعادة المحاولة حتى حذف الجولة.':
    '🔒 لا توجد إجابة نشطة لهذا الحساب يمكن سحبها.'};
  }
  if(cmd.kind==='STATUS'){
   const status=await svc.mine(memberId,cmd.quizId);
   return {text:status==='ANSWERED'?'📋 إجابتك مسجّلة في هذا السؤال.':
    status==='WITHDRAWN'?'✅ إجابتك مسحوبة وليست محسوبة.':
    status==='NONE'?'📋 لم تُسجّل إجابة في هذا السؤال.':
    '🔒 تعذّر التحقق من عضويتك أو لم تعد الجولة متاحة.'};
  }
  const q=await svc.info(memberId,cmd.quizId);
  if(!q)return {text:'🔒 السؤال غير متاح أو تعذّر التحقق من العضوية.'};
  return {text:'<b>🧠 سؤال تعليمي — 08:03</b>\n'+
   'العنوان: '+esc(q.title)+'\n'+
   esc(q.question)+'\n'+q.options.map((x,i)=>
    (i+1)+'. '+esc(x)).join('\n')+'\n'+
   (q.status==='OPEN'?
    '🟢 السؤال مفتوح حتى '+new Date(q.expiresAt).toISOString()+
    '\nأجب مرة واحدة من خاص البوت: <code>/quizanswer '+q.id+' 1</code> (بدّل 1 برقم الخيار).':
    '🔒 أُغلقت الجولة. الإجابة الصحيحة: '+(q.answer!.correctIndex+1)+
    '\nالشرح: '+esc(q.answer!.explanation))+
   '\nالمصدر المرجعي الذي راجعه المالك: '+esc(q.sourceUrl)+
   '\nهذه أداة تدريب لا تمنح مقعدًا أو أولوية منحة أو رتبة إدارية.'};
 }catch{return {text:'🔒 تعذّر تنفيذ الطلب بصورة آمنة دون نشر أو إرسال جماعي.'};}
}
