import {Phase4WhisperService} from './phase4-whispers.js';

/** The private portal never reveals a secret, direct recipient identity,
 * reservation ID or a Telegram share link. A seat is NOT delivery.
 * Command text is a user-supplied request, not an authorization token. */
export type WhisperMemberCommand=
 |{kind:'ON'|'OFF';chatId:string}
 |{kind:'RESERVE';id:string}
 |{kind:'OPEN';id:string}
 |{kind:'BLOCK';id:string}
 |{kind:'UNBLOCK';chatId:string;senderId:string}
 |{kind:'REPORT';id:string;reason:'SPAM'|'HARASSMENT'|'PERSONAL_DATA'|'OTHER'};
const chat=/^-[1-9][0-9]{0,15}$/u;
const canChat=(value:string)=>chat.test(value)&&Number.isSafeInteger(Number(value));
export function parseWhisperMemberCommand(value:string):WhisperMemberCommand|null{
 if(typeof value!=='string'||value.length>120)return null;
 const consent=/^\/whisper(on|off) (-[1-9][0-9]{0,15})$/u.exec(value);
 if(consent&&canChat(consent[2]!))
  return {kind:consent[1]==='on'?'ON':'OFF',chatId:consent[2]!};
 const block=/^\/whisperblockid ([a-f0-9]{24})$/u.exec(value);
 if(block)return {kind:'BLOCK',id:block[1]!};
 const unblock=/^\/whisperunblock (-[1-9][0-9]{0,15}) ([1-9][0-9]{0,15})$/u.exec(value);
 if(unblock&&canChat(unblock[1]!)&&Number.isSafeInteger(Number(unblock[2])))
  return {kind:'UNBLOCK',chatId:unblock[1]!,senderId:unblock[2]!};
 const report=/^\/whisperreport ([a-f0-9]{24}) (SPAM|HARASSMENT|PERSONAL_DATA|OTHER)$/u.exec(value);
 if(report)return {kind:'REPORT',id:report[1]!,
  reason:report[2]! as 'SPAM'|'HARASSMENT'|'PERSONAL_DATA'|'OTHER'};
 const open=/^(?:\/start wh_|\/whisperopen )([a-f0-9]{24})$/u.exec(value);
 if(open)return {kind:'OPEN',id:open[1]!};
 const reserve=/^\/whisperseat ([a-f0-9]{24})$/u.exec(value);
 if(reserve)return {kind:'RESERVE',id:reserve[1]!};
 return null;
}
export interface WhisperMemberScreen{
 readonly text:string;
 /** Trusted server-side send witness, never serialized into any public reply. */
 readonly privateSecret?:{
  scope:string;whisperId:string;reservationId:string;
  messageRevision:number;consentRevision:number;chatVersion:number;expiresAt:number;
 };
}
/** Called only after Telegram verifies sender === private chat. This helper
 * does not authenticate a sender and MUST NOT be used for group messages.
 * Private membership verification is delegated to the service's trusted
 * injected membership observer; unknown is never granted. */
export async function whisperMemberScreen(
 service:Phase4WhisperService,actor:string,text:string
):Promise<WhisperMemberScreen|null>{
 const request=parseWhisperMemberCommand(text);
 if(!request)return null;
 try{
  if(request.kind==='ON'||request.kind==='OFF'){
   const ok=await service.consent(actor,request.chatId,request.kind==='ON');
   if(request.kind==='ON')
    return {text:ok?
     '✅ تم تفعيل الموافقة على استقبال همسات هذه المجموعة بعد التحقق من عضويتك. لا تُرسل أي همسة تلقائيًا.':
     '🔒 تعذّر التحقق من عضويتك أو إعدادات المجموعة؛ لم تُفعّل الموافقة.'};
   return {text:ok?
    '✅ تم إيقاف استقبال همسات هذه المجموعة. لن يُنشأ حجز جديد دون موافقة لاحقة.':
    '🔒 تعذّر إلغاء الموافقة؛ لا يوجد إذن نشط قابل للتعديل لهذا الحساب.'};
  }
  if(request.kind==='BLOCK'){
   const ok=await service.blockWhisper(actor,request.id);
   return {text:ok?
    '🔒 أُضيف مرسل هذه الهمسة إلى المحظورين لديك في المجموعة. لن يحصل على تصريح مراسلتك بهذه الخدمة، وحُررت الحجوزات غير المرسلة.':
    'تعذّر إثبات أنك حجزت هذه الهمسة أو أن مرسلها متاح للحظر. لم تتغير القائمة.'};
  }
  if(request.kind==='UNBLOCK'){
   const ok=await service.block(actor,request.chatId,request.senderId,false);
   return {text:ok?'✅ أُلغي حظر المرسل المحدد في هذه المجموعة. لا تُنشأ حجوزات تلقائيًا.':
    'تعذّر تغيير حظر هذا المرسل. لم تُنشأ أي همسة.'};
  }
  if(request.kind==='REPORT'){
   const ok=await service.report(actor,request.id,request.reason);
   return {text:ok?'🚩 سُجل البلاغ الخاص للمراجعة. احتفظ النظام بنوع الإساءة فقط، دون نسخ نص الهمسة.':
    'هذا البلاغ غير متاح أو سبق إرساله، أو لا يوجد حجز مثبت باسمك لهذه الهمسة.'};
  }
  if(request.kind==='OPEN'){
   const opened=await service.open(actor,request.id);
   if(opened.status!=='READY'){
    const errors:Record<string,string>={
     NOT_ANNOUNCED:'إعلان الهمسة لم يؤكده Telegram؛ لا يمكن فتح المحتوى حتى النشر المؤكد.',
     FULL:'انتهت المقاعد المحددة لهذه الهمسة.',
     CONSENT_REQUIRED:'يلزم تفعيل موافقتك على همسات المجموعة في الخاص أولًا.',
     VERIFICATION_REQUIRED:'تعذّر التحقق من عضويتك واشتراكاتك المطلوبة حاليًا.',
     EXPIRED:'انتهت صلاحية الهمسة.',CLOSED:'أغلقت الهمسة.'
    };
    return {text:'🔒 '+(errors[opened.status]??'هذه الهمسة غير متاحة لك حاليًا أو تغيّرت صلاحياتها.')+
     '\nلا يكفي امتلاك رابطها لإثبات الأهلية.'};
   }
   const escaped=opened.text.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
    .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
   const body='<b>💌 محتوى الهمسة في الخاص فقط</b>\n'+escaped+
    '\n\n🔐 لا يضمن هذا العرض منع النسخ أو لقطة الشاشة، وليس مشفّرًا طرفيًا.'+
    '\nللبلاغ: <code>/whisperreport '+request.id+' SPAM</code>'+
    '\nلحظر المرسل: <code>/whisperblockid '+request.id+'</code>';
   if(Buffer.byteLength(body,'utf8')>4096)
    return {text:'🔒 تعذر عرض الهمسة ضمن حد Telegram؛ لم نرسل محتوى جزئيًا.'};
   return {text:body,privateSecret:{
    scope:opened.scope,whisperId:request.id,
    reservationId:opened.reservationId,messageRevision:opened.messageRevision,
    consentRevision:opened.consentRevision,chatVersion:opened.chatVersion,
    expiresAt:opened.expiresAt
   }};
  }
  if(request.kind!=='RESERVE')return null;
  const reservation=await service.reserve(actor,request.id);
  switch(reservation.status){
   case 'HELD':return {text:'💌 تم حجز مقعد مبدئي لك. لا يعني ذلك إرسال الهمسة أو قراءة محتواها. هذه الوظيفة لا تكشف محتوى الرسالة بعد.'};
   case 'ALREADY_HELD':return {text:'💌 سبق حجز مقعد مبدئي لهذا الحساب. لا توجد رسالة خاصة تم تسليمها.'};
   case 'FULL':return {text:'⏳ لا توجد مقاعد متاحة حاليًا، ولم تُكشف أي رسالة.'};
   case 'CONSENT_REQUIRED':return {text:'🔒 يلزم تفعيل موافقتك الخاصة على استقبال همسات المجموعة أولًا.'};
   case 'VERIFICATION_REQUIRED':return {text:'🔒 تعذّر التحقق من عضويتك حاليًا. لم يُحجز أي مقعد.'};
   case 'EXPIRED':
   case 'CLOSED':return {text:'🔒 انتهى استقبال الطلبات لهذه الهمسة. لم يُكشف محتواها.'};
   default:return {text:'🔒 هذه الهمسة غير متاحة لهذا الحساب أو تغيّر التفويض. لم يُحجز مقعد ولم يُكشف محتوى.'};
  }
 }catch{
  return {text:'🔒 تعذّر تنفيذ طلب الهمسة. لم تُرسل رسالة خاصة ولم يُكشف محتوى.'};
 }
}
