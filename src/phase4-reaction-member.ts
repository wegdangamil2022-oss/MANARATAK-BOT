import {Phase4ReactionsService} from './phase4-reactions.js';
export type ReactionMemberCommand=
 |{kind:'LIKE'|'UNLIKE'|'STATUS'|'INFO';targetId:string};
export function parseReactionMemberCommand(input:string):ReactionMemberCommand|null{
 if(typeof input!=='string'||input.length>95)return null;
 const m=/^\/react(like|unlike|status|info) ([a-f0-9]{24})$/u.exec(input);
 if(!m)return null;
 return {kind:m[1]!.toUpperCase() as ReactionMemberCommand['kind'],
  targetId:m[2]!};
}
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const names={BOT_POST:'منشور بوت',COMMUNITY_QUESTION:'سؤال مجتمع',
 STUDY_EXPERIENCE:'تجربة دراسية'};
/** Telegram private self-service. Never sends a group reaction or creates
 * a reply-job for a published message; it only records a local signal. */
export async function reactionMemberScreen(
 service:Phase4ReactionsService,actor:string,input:string
):Promise<{text:string}|null>{
 const cmd=parseReactionMemberCommand(input);if(!cmd)return null;
 try{
  if(cmd.kind==='LIKE'){
   const response=await service.like(actor,cmd.targetId);
   const messages={
    LIKED:'❤️ سُجّل إعجابك محليًا بالمحتوى الذي راجعه المالك، دون إرسال تفاعل إلى مجموعة Telegram.',
    ALREADY_REACTED:'ℹ️ سبق تسجيل إعجابك بهذا المحتوى أو سحبته؛ لا يمكن تكراره.',
    VERIFICATION_REQUIRED:'🔒 تعذّر التحقق من عضويتك أو الاشتراكات المطلوبة. لم يُسجّل إعجاب.',
    NOT_FOUND:'🔒 المحتوى غير معروف أو أُزيل.',
    CLOSED:'🔒 نافذة التفاعل غير مفتوحة.',
    EXPIRED:'⌛ انتهى وقت التفاعل.',
    STALE:'🔒 تغيّر اعتماد المجموعة أو شروط الاشتراك. لم يُسجّل إعجاب.',
    INVALID:'🔒 معرّف التفاعل أو الحساب غير صالح.',
    CAPACITY:'⏳ بلغ التفاعل الحد المسموح.',
    RATE_LIMIT:'⏳ تجاوزت الحد اليومي للتفاعلات. حاول لاحقًا.'
   };
   return {text:messages[response.status]+
    (response.status==='LIKED'?'\nلسحب إعجابك: <code>/reactunlike '+cmd.targetId+'</code>':'')};
  }
  if(cmd.kind==='UNLIKE'){
   const yes=await service.unlike(actor,cmd.targetId);
   return {text:yes?'✅ سُحب إعجابك، ولن يُحتسب ضمن التفاعلات النشطة.':
    '🔒 لا يوجد إعجاب نشط لهذا الحساب يمكن سحبه.'};
  }
  if(cmd.kind==='STATUS'){
   const reaction=await service.myReaction(actor,cmd.targetId);
   return {text:reaction?
    (reaction.status==='ACTIVE'?'❤️ تفاعلك مع هذا المحتوى: إعجاب مسجّل محليًا.':
     '📋 إعجابك بهذا المحتوى مسحوب ولا يُحتسب.'):
    '🔒 لا يوجد تفاعل محفوظ لهذا الحساب في هذا المحتوى.'};
  }
  const info=await service.memberInfo(actor,cmd.targetId);
  return {text:info?'<b>❤️ تفاعل منشور — 09:13</b>\n'+
   'الصنف: '+names[info.kind]+'\n'+
   'الوصف الذي راجعه المالك: '+esc(info.description)+'\n'+
   'الحالة: '+(info.status==='OPEN'?'يقبل الإعجاب':'مغلق')+'\n'+
   '⚠️ المنشور مُدرج يدويًا، ولم يتحقق النظام من مؤلف رسالة Telegram. لا توجد جوائز أو أصوات مسابقات.':
   '🔒 المحتوى غير متاح أو تغيّرت صلاحية المجموعة أو العضوية.'};
 }catch{return {text:'🔒 تعذّر تسجيل التفاعل دون إجراء نشر أو اتصال بالمجموعة.'};}
}
