import {Phase4EventService} from './phase4-events.js';
export type EventMemberCommand=
 |{kind:'JOIN';eventId:string;remind:boolean}
 |{kind:'REMIND';eventId:string;remind:boolean}
 |{kind:'LEAVE'|'STATUS'|'INFO'|'SUMMARY';eventId:string};
export function parseEventMemberCommand(input:string):EventMemberCommand|null{
 if(typeof input!=='string'||input.length>95)return null;
 const choice=/^\/event(join|remind) ([a-f0-9]{24}) (yes|no)$/u.exec(input);
 if(choice)return {kind:choice[1]==='join'?'JOIN':'REMIND',
  eventId:choice[2]!,remind:choice[3]==='yes'};
 const single=/^\/event(leave|status|info|summary) ([a-f0-9]{24})$/u.exec(input);
 if(single)return {kind:single[1]!.toUpperCase() as 'LEAVE'|'STATUS'|'INFO'|'SUMMARY',
  eventId:single[2]!};
 return null;
}
export interface EventMemberScreen{readonly text:string;}
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
/** Private self-service only. Never sends reminders or contacts accounts
 * that did not choose to initiate a conversation and opt in. */
export async function eventMemberScreen(
 service:Phase4EventService,actor:string,input:string
):Promise<EventMemberScreen|null>{
 const cmd=parseEventMemberCommand(input);if(!cmd)return null;
 try{
  if(cmd.kind==='JOIN'){
   const result=await service.register(actor,cmd.eventId,cmd.remind);
   switch(result.status){
    case 'REGISTERED':return {text:'✅ تم تسجيلك في اللقاء محليًا. التذكير: '+
     (cmd.remind?'موافقة اختيارية مسجلة (لا إرسال آلي حاليًا).':'متوقف')+
     '\nللإلغاء: <code>/eventleave '+cmd.eventId+'</code>\n'+
     'لتغيير الموافقة: <code>/eventremind '+cmd.eventId+' no</code>'};
    case 'ALREADY_REGISTERED':return {text:'ℹ️ سبق تسجيل هذا الحساب أو إلغاء تسجيله في اللقاء؛ لا يُعاد تفعيل التسجيل القديم تلقائيًا.'};
    case 'FULL':return {text:'⏳ اكتملت الأماكن المتاحة لهذا اللقاء.'};
    case 'VERIFICATION_REQUIRED':return {text:'🔒 تعذّر التحقق من عضويتك أو الاشتراكات الإلزامية. لم يتم التسجيل.'};
    case 'EXPIRED':return {text:'⏳ انتهى وقت التسجيل لهذا اللقاء.'};
    case 'INVALID':return {text:'🔒 بيانات الطلب غير صالحة.'};
    default:return {text:'🔒 اللقاء غير متاح للتسجيل حاليًا أو تغيّر تفويض المجموعة.'};
   }
  }
  if(cmd.kind==='LEAVE'){
   const ok=await service.withdraw(actor,cmd.eventId);
   return {text:ok?'✅ أُلغي تسجيلك وموافقتك على التذكير. لا توجد رسالة تلقائية.':
    '🔒 لا يوجد تسجيل نشط قابل للإلغاء لهذا الحساب.'};
  }
  if(cmd.kind==='REMIND'){
   const ok=await service.reminderConsent(actor,cmd.eventId,cmd.remind);
   return {text:ok?'✅ تم تعديل موافقتك الاختيارية على التذكير. لا إرسال تلقائي في هذا الإصدار.':
    '🔒 لم يتغيّر الإعداد؛ قد لا يكون لديك تسجيل نشط أو انتهى وقت التذكير.'};
  }
  if(cmd.kind==='STATUS'){
   const reg=await service.myRegistration(actor,cmd.eventId);
   return {text:reg?(reg.status==='REGISTERED'?
    '📋 تسجيلك نشط. موافقة التذكير: '+(reg.reminderConsent?'نعم':'لا'):
    '📋 تسجيلك ملغى، وموافقة التذكير مسحوبة.'):
    '🔒 لا يوجد تسجيل لهذا الحساب.'};
  }
  if(cmd.kind==='INFO'){
   const info=await service.eventInfo(actor,cmd.eventId);
   return {text:info?'🗓️ <b>'+escape(info.title)+'</b>\n'+
    'موعد البدء (UTC): '+new Date(info.startsAt).toISOString()+'\n'+
    'موعد الانتهاء (UTC): '+new Date(info.endsAt).toISOString()+'\n'+
    'رابط الحضور الذي اعتمده المالك: '+escape(info.link)+'\n'+
    'الحالة: '+info.status+'\n'+
    'هذا رابط معلن من المنظم، وليس إثباتًا للحضور.':
    '🔒 تفاصيل اللقاء غير متاحة في عضويتك الحالية.'};
  }
  const summary=await service.summary(actor,cmd.eventId);
  return {text:summary?'📚 <b>ملخص اللقاء المعتمد</b>\n'+
   escape(summary.text)+(summary.urls.length?'\nروابط الموارد التي راجعها المالك:\n'+
    summary.urls.map(x=>escape(x)).join('\n'):'')+
   '\n⚠️ الملخص لا يعني إثبات حضور أي طالب.':
   '🔒 لا يوجد ملخص معتمد ومتاح بعد، أو لم يعد لديك حق الوصول إليه.'};
 }catch{return {text:'🔒 تعذّر تنفيذ طلب اللقاء دون إجراء أي نشر أو إرسال.'};}
}
