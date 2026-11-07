import {Phase4PollService} from './phase4-polls.js';

/** Student voting is private and is always bound to the authenticated
 * Telegram user at ingress. Poll IDs alone grant no voting privileges. */
export type PollMemberCommand=
 |{kind:'VOTE';pollId:string;option:number}
 |{kind:'WITHDRAW'|'STATUS';pollId:string};
export function parsePollMemberCommand(raw:string):PollMemberCommand|null{
 if(typeof raw!=='string'||raw.length>100)return null;
 const vote=/^\/pollvote ([a-f0-9]{24}) ([1-8])$/u.exec(raw);
 if(vote)return {kind:'VOTE',pollId:vote[1]!,option:Number(vote[2])};
 const action=/^\/poll(withdraw|status) ([a-f0-9]{24})$/u.exec(raw);
 if(action)return {kind:action[1]==='withdraw'?'WITHDRAW':'STATUS',pollId:action[2]!};
 return null;
}
export interface PollMemberScreen{readonly text:string;}
export async function pollMemberScreen(
 service:Phase4PollService,actor:string,raw:string
):Promise<PollMemberScreen|null>{
 const cmd=parsePollMemberCommand(raw);if(!cmd)return null;
 try{
  if(cmd.kind==='VOTE'){
   const answer=await service.vote(actor,cmd.pollId,cmd.option-1);
   switch(answer.status){
    case 'CAST':return {text:'📊 تم تسجيل اختيارك محليًا. لم يُنشر تصويت في مجموعة Telegram. يمكنك سحبه باستخدام:\n<code>/pollwithdraw '+cmd.pollId+'</code>'};
    case 'ALREADY_VOTED':return {text:'ℹ️ يوجد تصويت سابق لهذا الحساب في الاستطلاع، أو سبق سحبه. لا يُسمح بتكرار التصويت.'};
    case 'VERIFICATION_REQUIRED':return {text:'🔒 تعذّر التحقق من عضويتك أو اشتراكاتك المطلوبة. لم يُسجّل صوت.'};
    case 'EXPIRED':case 'CLOSED':return {text:'🔒 انتهى التصويت أو لم يبدأ بعد. لم يُسجّل صوت.'};
    case 'INVALID':return {text:'🔒 الاختيار غير صالح لهذا الاستطلاع.'};
    case 'CAPACITY':return {text:'⏳ بلغ الاستطلاع الحد المسموح من الأصوات محليًا.'};
    default:return {text:'🔒 الاستطلاع غير متاح أو تغير تفويض المجموعة. لم يُسجّل صوت.'};
   }
  }
  if(cmd.kind==='WITHDRAW'){
   const revoked=await service.withdraw(actor,cmd.pollId);
   return {text:revoked?
    '✅ سُحب صوتك وحُذف اختيارك من التخزين النشط. لا يمكن إعادة التصويت في هذا الاستطلاع.':
    '🔒 لا يوجد صوت نشط لهذا الحساب يمكن سحبه.'};
  }
  const result=await service.myVote(actor,cmd.pollId);
  return {text:result?
   (result.status==='CAST'?'📋 صوتك مسجل محليًا دون كشف اختيارك في هذه الشاشة.':
    '📋 تم سحب صوتك ولن يُحتسب.'):
   '🔒 لا يوجد تصويت مسجل لهذا الحساب.'};
 }catch{return {text:'🔒 تعذّر تنفيذ الطلب دون نشر أي تصويت.'};}
}
