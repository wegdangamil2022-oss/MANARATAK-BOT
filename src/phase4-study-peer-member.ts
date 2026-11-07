import {Phase4StudyPeersService} from './phase4-study-peers.js';

export type StudyPeerMemberCommand=
 |{kind:'JOIN'|'LEAVE'|'INFO'|'STATUS';circleId:string}
 |{kind:'REPORT';circleId:string;reason:'CONTACT_REQUEST'|'UNSAFE_MATCH'|'HARASSMENT'};
export function parseStudyPeerMemberCommand(v:string):StudyPeerMemberCommand|null{
 if(typeof v!=='string'||v.length>100)return null;
 const single=/^\/study(join|leave|info|status) ([a-f0-9]{24})$/u.exec(v);
 if(single)return {kind:single[1]!.toUpperCase() as 'JOIN'|'LEAVE'|'INFO'|'STATUS',
  circleId:single[2]!};
 const report=/^\/studyreport ([a-f0-9]{24}) (CONTACT_REQUEST|UNSAFE_MATCH|HARASSMENT)$/u.exec(v);
 if(report)return {kind:'REPORT',circleId:report[1]!,
  reason:report[2]! as 'CONTACT_REQUEST'|'UNSAFE_MATCH'|'HARASSMENT'};
 return null;
}
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
/** All commands are authenticated private Telegram messages; this screen
 * never exposes another participant's ID, username or contact information.
 */
export async function studyPeerMemberScreen(
 service:Phase4StudyPeersService,actor:string,raw:string
):Promise<{text:string}|null>{
 const cmd=parseStudyPeerMemberCommand(raw);if(!cmd)return null;
 try{
  if(cmd.kind==='JOIN'){
   const r=await service.join(actor,cmd.circleId);
   const messages={
    JOINED:'✅ انضممت إلى دائرة المذاكرة الجماعية محليًا. لا توجد مطابقة فردية أو مشاركة لبياناتك مع غرباء.',
    ALREADY_JOINED:'ℹ️ سبق تسجيل هذا الحساب أو انسحابه من الدائرة؛ لا تُفعّل المشاركة القديمة تلقائيًا.',
    CLOSED:'🔒 الدائرة مغلقة أو لم تُفتح للمشاركة.',
    STALE:'🔒 تغيّر تفويض المجموعة أو الاشتراكات. لم يتم تسجيلك.',
    EXPIRED:'⌛ انتهى موعد الانضمام.',
    FULL:'⏳ اكتمل العدد المسموح لهذه الدائرة.',
    VERIFICATION_REQUIRED:'🔒 تعذّر التحقق من عضويتك واشتراكاتك.',
    INVALID:'🔒 معرّف الدائرة أو الطلب غير صحيح.',
    NOT_FOUND:'🔒 الدائرة غير متاحة.'
   };
   return {text:messages[r.status]+
    (r.status==='JOINED'?'\nللانسحاب: <code>/studyleave '+cmd.circleId+'</code>':'')};
  }
  if(cmd.kind==='LEAVE'){
   const left=await service.leave(actor,cmd.circleId);
   return {text:left?'✅ انسحبت من الدائرة وحُذفت مشاركتك من عدد الأماكن النشطة.':
    '🔒 لا يوجد تسجيل نشط لهذا الحساب يمكن سحبه.'};
  }
  if(cmd.kind==='STATUS'){
   const row=await service.memberStatus(actor,cmd.circleId);
   return {text:row?(row.status==='JOINED'?'📋 أنت مشارك في دائرة جماعية ضمن البوت.':
    '📋 سبق انسحابك من هذه الدائرة.'):
    '🔒 لا يوجد تسجيل لهذا الحساب.'};
  }
  if(cmd.kind==='REPORT'){
   const result=await service.report(actor,cmd.circleId,cmd.reason);
   const messages={
    REPORTED:'✅ بلاغك محفوظ للمراجعة من مالك المجموعة، دون إعلان هويتك للطلاب.',
    ALREADY_REPORTED:'ℹ️ أُرسل بلاغ سابق من هذا الحساب في الدائرة.',
    INVALID:'🔒 سبب البلاغ غير صالح.',
    NOT_JOINED:'🔒 البلاغ متاح للمشاركين فقط.',
    CLOSED:'🔒 باب بلاغات الدائرة مغلق أو انتهى وقتها.',
    STALE:'🔒 تغيّر اعتماد المجموعة أو شروط الاشتراك.',
    VERIFICATION_REQUIRED:'🔒 تعذّر التحقق من العضوية، ولم يُسجّل بلاغ.',
    CAPACITY:'⏳ اكتمل طابور البلاغات.'
   };
   return {text:messages[result.status]};
  }
  const info=await service.memberInfo(actor,cmd.circleId);
  return {text:info?'<b>👥 دائرة مذاكرة جماعية</b>\n'+
   'المادة: '+escape(info.topic)+'\n'+
   'المستوى: '+info.level+'\n'+
   'موعد البداية UTC: '+new Date(info.startsAt).toISOString()+'\n'+
   'موعد النهاية UTC: '+new Date(info.endsAt).toISOString()+'\n'+
   'عدد المشاركين: '+info.joined+' من '+info.capacity+'\n'+
   'الحالة: '+info.status+'\n'+
   'لا تُعرض هويات أو أرقام اتصال، ولا توجد مطابقة فردية، خاصة للقاصرين.':
   '🔒 لا يمكن عرض بيانات الدائرة بسبب انتهاء الوقت أو التحقق أو صلاحية المجموعة.'};
 }catch{return {text:'🔒 تعذّر تنفيذ الطلب من الخاص دون مشاركة أي بيانات.'};}
}
