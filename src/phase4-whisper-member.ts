import {Phase4WhisperService} from './phase4-whispers.js';

/** Private-only recipient portal. A public link or a reservation is never
 * authorization: open() requires provider membership, opt-in and a current
 * reservation. The resulting private reply still gets a send-time witness.
 * This helper NEVER exposes content to group chats or to other members. */
export type WhisperMemberCommand=
 |{kind:'ON'|'OFF';chatId:string}
 |{kind:'RESERVE';id:string}
 |{kind:'OPEN'|'ANSWER';id:string}
 |{kind:'BLOCK';id:string}
 |{kind:'UNBLOCK';chatId:string;senderId:string}
 |{kind:'BLOCKS';page:number}
 |{kind:'UNBLOCK_TOKEN';id:string}
 |{kind:'REPORT';id:string;reason:'SPAM'|'HARASSMENT'|'PERSONAL_DATA'|'OTHER'}
 |{kind:'SUBMIT';chatId:string;mode:'FIRST_N'|'DIRECT';seats:number;
   recipientId?:string;durationMinutes:number;text:string}
 |{kind:'WITHDRAW';id:string}
 |{kind:'STATUS';id:string};
const chat=/^-[1-9][0-9]{0,15}$/u;
const canChat=(value:string)=>chat.test(value)&&Number.isSafeInteger(Number(value));
export function parseWhisperMemberCommand(value:string):WhisperMemberCommand|null{
 if(typeof value!=='string'||value.length>750)return null;
 const memberFirst=/^\/whisperfirstsend (-[1-9][0-9]{0,15}) ([1-3]) (10|[1-9]) ([^\r\n]{1,500})$/u.exec(value);
 if(memberFirst&&canChat(memberFirst[1]!))
  return {kind:'SUBMIT',chatId:memberFirst[1]!,mode:'FIRST_N',
   seats:Number(memberFirst[2]),durationMinutes:Number(memberFirst[3]),
   text:memberFirst[4]!};
 const memberDirect=/^\/whispersend (-[1-9][0-9]{0,15}) ([1-9][0-9]{0,15}) (10|[1-9]) ([^\r\n]{1,500})$/u.exec(value);
 if(memberDirect&&canChat(memberDirect[1]!)&&
    Number.isSafeInteger(Number(memberDirect[2])))
  return {kind:'SUBMIT',chatId:memberDirect[1]!,mode:'DIRECT',
   seats:1,recipientId:memberDirect[2]!,durationMinutes:Number(memberDirect[3]),
   text:memberDirect[4]!};
 const memberStatus=/^\/whisperstatus ([a-f0-9]{24})$/u.exec(value);
 if(memberStatus)return {kind:'STATUS',id:memberStatus[1]!};
 const memberWithdraw=/^\/whisperrevoke ([a-f0-9]{24})$/u.exec(value);
 if(memberWithdraw)return {kind:'WITHDRAW',id:memberWithdraw[1]!};
 const consent=/^\/whisper(on|off) (-[1-9][0-9]{0,15})$/u.exec(value);
 if(consent&&canChat(consent[2]!))
  return {kind:consent[1]==='on'?'ON':'OFF',chatId:consent[2]!};
 const block=/^\/whisperblockid ([a-f0-9]{24})$/u.exec(value);
 if(block)return {kind:'BLOCK',id:block[1]!};
 const blocks=/^\/whisperblocks(?: (1|[1-9][0-9]{1,2}))?$/u.exec(value);
 if(blocks)return {kind:'BLOCKS',page:Number(blocks[1]??'1')-1};
 const unblockToken=/^\/whisperunblockid ([a-f0-9]{24})$/u.exec(value);
 if(unblockToken)return {kind:'UNBLOCK_TOKEN',id:unblockToken[1]!};
 const unblock=/^\/whisperunblock (-[1-9][0-9]{0,15}) ([1-9][0-9]{0,15})$/u.exec(value);
 if(unblock&&canChat(unblock[1]!)&&Number.isSafeInteger(Number(unblock[2])))
  return {kind:'UNBLOCK',chatId:unblock[1]!,senderId:unblock[2]!};
 const report=/^\/whisperreport ([a-f0-9]{24}) (SPAM|HARASSMENT|PERSONAL_DATA|OTHER)$/u.exec(value);
 if(report)return {kind:'REPORT',id:report[1]!,
  reason:report[2]! as 'SPAM'|'HARASSMENT'|'PERSONAL_DATA'|'OTHER'};
 const open=/^(?:\/start wh_|\/whisperopen )([a-f0-9]{24})$/u.exec(value);
 if(open)return {kind:'OPEN',id:open[1]!};
 const answer=/^\/whisperanswer ([a-f0-9]{24})$/u.exec(value);
 if(answer)return {kind:'ANSWER',id:answer[1]!};
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
  view:'CONTENT'|'ANSWER';
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
  if(request.kind==='SUBMIT'){
   const id=await service.submitMemberDraft(actor,request.chatId,{
    kind:request.mode,seats:request.seats,
    ...(request.recipientId?{recipientId:request.recipientId}:{}),
    durationMinutes:request.durationMinutes,text:request.text});
   return {text:id?
    '📝 سُجلت مسودة همستك للمراجعة الخاصة من إدارة المجموعة. لم تُنشر، ولا يوجد تسليم للمستلم.\n'+
    'معرف المسودة لإلغائها: <code>'+id+'</code>\n'+
    'للإلغاء: <code>/whisperrevoke '+id+'</code>\n'+
    'لمعرفة الحالة: <code>/whisperstatus '+id+'</code>\n'+
    'مدة الصلاحية تشمل وقت انتظار الإدارة، وقد تنتهي قبل الاعتماد.':
    '🔒 تعذر قبول المسودة. يجب أن يفتح مالك المجموعة هذه الميزة، وتثبت عضويتك، وتكون حدود الإنشاء متاحة. لم تُنشر رسالة.'};
  }
  if(request.kind==='STATUS'){
   const state=await service.ownStatus(actor,request.id);
   if(!state)return {text:'🔒 لا توجد مسودة همسة تخص حسابك بهذا المعرف.'};
   const status=state.status==='DRAFT'?'📝 تنتظر مراجعة إدارة المجموعة':
    state.status==='OPEN'?'✅ اعتمدتها الإدارة محليًا':'🔒 أُغلقت أو انتهت';
   const poster=state.announcement==='CONFIRMED'?
    '✅ أكد Telegram إعلان المجموعة':state.announcement==='QUEUED'?
    '⏳ إعلان بانتظار Telegram':state.announcement==='NOT_POSTED'?
    'لم يُطلب نشرها':state.announcement==='SENDING'||
    state.announcement==='UNKNOWN_OUTCOME'?
    '⚠️ إعلان غير مؤكد؛ لا إعادة تلقائية':
    'لم يؤكد Telegram نشر الإعلان';
   return {text:'💌 حالة مسودتك فقط\n'+status+'\nالإعلان: '+poster+
    '\nتنتهي: '+new Date(state.expiresAt).toISOString()+
    '\nلا يكشف هذا التقرير هويات من حاولوا فتح الهمسة أو قرأوها.'};
  }
  if(request.kind==='WITHDRAW'){
   const closed=await service.withdrawOwn(actor,request.id);
   return {text:closed?
    '🔒 أُلغيت الهمسة وسُحب نصها من التخزين النشط. لا يمكن استرجاع نسخة سبق أن وصلت إلى Telegram.':
    'تعذّر إلغاء الهمسة؛ قد لا تكون مسودتك، أو أنها أغلقت مسبقًا.'};
  }
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
    '🔒 حُظر مرسل هذه الهمسة لديك في المجموعة، وحُررت حجوزاتك غير المرسلة منه.'+
    '\nلعرض الحظر وفكه لاحقًا دون كشف هوية المرسل: <code>/whisperblocks</code>':
    'تعذّر إثبات أنك حجزت هذه الهمسة أو أن مرسلها متاح للحظر. لم تتغير القائمة.'};
  }
  if(request.kind==='BLOCKS'){
   const result=await service.myBlocks(actor,request.page);
   if(!result)return {text:'🔒 لا يمكن عرض هذه الصفحة من قائمة الحظر.'};
   const pages=Math.max(1,Math.ceil(result.total/5));
   if(request.page>=pages)return {text:'🔒 رقم الصفحة خارج نطاق قائمة حظرك.'};
   const items=result.entries.map((row,i)=>
    (request.page*5+i+1)+'. مجموعة <code>'+row.chatId+'</code>؛ حظر منذ '+
    new Date(row.updatedAt).toISOString().slice(0,10)+
    '\nلفك الحظر: <code>/whisperunblockid '+row.id+'</code>');
   return {text:'<b>🔒 محظورو الهمسات لديك فقط</b>\n'+
    'العدد: '+result.total+' · صفحة '+(request.page+1)+'/'+pages+
    '\nلا تُعرض حسابات المرسلين أو محتوى الهمسات.\n\n'+
    (items.length?items.join('\n\n'):'لا يوجد مرسلون محظورون.')+
    (request.page+1<pages?
     '\n\nالصفحة التالية: <code>/whisperblocks '+(request.page+2)+'</code>':'')};
  }
  if(request.kind==='UNBLOCK_TOKEN'){
   const ok=await service.unblockOwn(actor,request.id);
   return {text:ok?
    '✅ أُلغي حظرك لهذا المرسل، دون كشف هويته. لا يتم حجز أي مقعد تلقائيًا.':
    '🔒 هذا المعرّف غير موجود ضمن حظرك الحالي أو سبق إلغاء الحظر.'};
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
  if(request.kind==='OPEN'||request.kind==='ANSWER'){
   const opened=await service.open(actor,request.id,
    request.kind==='ANSWER'?'ANSWER':'CONTENT');
   if(opened.status!=='READY'){
    const consentGroup=opened.status==='CONSENT_REQUIRED'?
     await service.consentHint(actor,request.id):null;
    const errors:Record<string,string>={
     NOT_ANNOUNCED:'إعلان الهمسة لم يؤكده Telegram؛ لا يمكن فتح المحتوى حتى النشر المؤكد.',
     QUESTION_NOT_SENT:'يجب إرسال نص السؤال إلى خاصك أولًا. افتح همسة السؤال، ثم اطلب الإجابة. لا نعتبر رسالة غامضة النتيجة مُسلّمة.',
     FULL:'انتهت المقاعد المحددة أو بلغت الخدمة حدود السعة التشغيلية.',
     CONSENT_REQUIRED:'يلزم تفعيل موافقتك على همسات المجموعة في الخاص أولًا.',
     VERIFICATION_REQUIRED:'تعذّر التحقق من عضويتك واشتراكاتك المطلوبة حاليًا.',
     EXPIRED:'انتهت صلاحية الهمسة.',CLOSED:'أغلقت الهمسة.'
    };
    return {text:'🔒 '+(errors[opened.status]??'هذه الهمسة غير متاحة لك حاليًا أو تغيّرت صلاحياتها.')+
     (consentGroup?
      '\n✅ ثبتت عضويتك. لتفعيل استقبال همسات المجموعة أرسل في الخاص:'+
      '\n<code>/whisperon '+consentGroup+'</code>'+
      '\nثم أعد فتح الهمسة. لا تُفعّل الموافقة تلقائيًا.':'')+
     '\nلا يكفي امتلاك رابطها لإثبات الأهلية.'};
   }
   const escaped=opened.text.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
    .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
   const heading=opened.view==='ANSWER'?'💡 إجابة السؤال التعليمية':
    opened.purpose==='QUESTION'?'❓ همسة سؤال تعليمي':
    opened.purpose==='GIFT'?'🎁 هدية مورد تعليمي':'💌 محتوى الهمسة في الخاص فقط';
   const answerHint=opened.purpose==='QUESTION'&&opened.view==='CONTENT'?
    '\n\nلعرض نموذج الإجابة بعد تأكيد Telegram إرسال السؤال إلى خاصك (لا يثبت القراءة): <code>/whisperanswer '+
      request.id+'</code>':'';
   const body='<b>'+heading+'</b>\n'+escaped+answerHint+
    '\n\n🔐 لا يضمن هذا العرض منع النسخ أو لقطة الشاشة، وليس مشفّرًا طرفيًا.'+
    '\nللبلاغ: <code>/whisperreport '+request.id+' SPAM</code>'+
    '\nلحظر المرسل: <code>/whisperblockid '+request.id+'</code>';
   if(Buffer.byteLength(body,'utf8')>4096)
    return {text:'🔒 تعذر عرض الهمسة ضمن حد Telegram؛ لم نرسل محتوى جزئيًا.'};
   return {text:body,privateSecret:{
    scope:opened.scope,whisperId:request.id,
    reservationId:opened.reservationId,messageRevision:opened.messageRevision,
    consentRevision:opened.consentRevision,chatVersion:opened.chatVersion,
    expiresAt:opened.expiresAt,view:opened.view
   }};
  }
  if(request.kind!=='RESERVE')return null;
  const reservation=await service.reserve(actor,request.id);
  switch(reservation.status){
   case 'HELD':return {text:'💌 تم حجز مقعد مبدئي لك. لا يعني ذلك إرسال الهمسة أو قراءة محتواها. هذه الوظيفة لا تكشف محتوى الرسالة بعد.'};
   case 'ALREADY_HELD':return {text:'💌 سبق حجز مقعد مبدئي لهذا الحساب. لا توجد رسالة خاصة تم تسليمها.'};
   case 'FULL':return {text:'⏳ لا توجد مقاعد أو سعة حفظ متاحة حاليًا، ولم يُكشف أي محتوى.'};
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
