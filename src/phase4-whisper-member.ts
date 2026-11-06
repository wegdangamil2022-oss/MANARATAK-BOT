import {Phase4WhisperService} from './phase4-whispers.js';

/** The private portal never reveals a secret, direct recipient identity,
 * reservation ID or a Telegram share link. A seat is NOT delivery.
 * Command text is a user-supplied request, not an authorization token. */
export type WhisperMemberCommand=
 |{kind:'ON'|'OFF';chatId:string}
 |{kind:'RESERVE';id:string};
const chat=/^-[1-9][0-9]{0,15}$/u;
const canChat=(value:string)=>chat.test(value)&&Number.isSafeInteger(Number(value));
export function parseWhisperMemberCommand(value:string):WhisperMemberCommand|null{
 if(typeof value!=='string'||value.length>120)return null;
 const consent=/^\/whisper(on|off) (-[1-9][0-9]{0,15})$/u.exec(value);
 if(consent&&canChat(consent[2]!))
  return {kind:consent[1]==='on'?'ON':'OFF',chatId:consent[2]!};
 const reserve=/^\/whisperseat ([a-f0-9]{24})$/u.exec(value);
 if(reserve)return {kind:'RESERVE',id:reserve[1]!};
 return null;
}
export interface WhisperMemberScreen{readonly text:string;}
/** Called only after Telegram verifies sender === private chat. This helper
 * does not authenticate a sender and MUST NOT be used for group messages.
 * Private membership verification is delegated to the service's trusted
 * injected membership observer; unknown is never granted. */
export async function whisperMemberScreen(
 service:Phase4WhisperService,actor:string,text:string
):Promise<WhisperMemberScreen|null>{
 const request=parseWhisperMemberCommand(text);
 if(!request)return null;
 const fixed='<text>غير مستخدم</text>';
 void fixed;
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
