import {Phase4BadgesService} from './phase4-badges.js';
import {BADGE_LABELS} from './phase4-badge-model.js';

export type BadgeMemberCommand=
 |{kind:'ON'|'OFF'|'VIEW';chatId:string};
export function parseBadgeMemberCommand(input:string):BadgeMemberCommand|null{
 if(typeof input!=='string'||input.length>65)return null;
 const m=/^\/(badgeon|badgeoff|mybadges) (-[1-9][0-9]{0,15})$/u.exec(input);
 if(!m)return null;
 return {kind:m[1]==='badgeon'?'ON':m[1]==='badgeoff'?'OFF':'VIEW',
  chatId:m[2]!};
}
/** Member chooses badge participation. No directory, rankings, public
 * mention, group send, owner/member identity or qualification assertion.
 */
export async function badgeMemberScreen(
 service:Phase4BadgesService,actor:string,input:string
):Promise<{text:string}|null>{
 const cmd=parseBadgeMemberCommand(input);
 if(!cmd)return null;
 try{
  if(cmd.kind==='ON'){
   const r=await service.consent(actor,cmd.chatId,true);
   const messages={
    ENABLED:'✅ وافقت على شارات التقدير الاختيارية في هذه المجموعة. أي شارة تتطلب مراجعة المالك.',
    ALREADY_ENABLED:'ℹ️ سبق تفعيل موافقتك في المجموعة الحالية.',
    DISABLED:'🔒 لم تُفعّل موافقتك.',
    ALREADY_DISABLED:'🔒 لا توجد موافقة.',
    VERIFICATION_REQUIRED:'🔒 تعذّر التحقق من العضوية أو الاشتراكات. لم تُسجل موافقة.',
    STALE:'🔒 تغيّر اعتماد المجموعة أو اشتراكاتها. لم تُسجل موافقة.',
    INVALID:'🔒 طلب الموافقة غير صالح.'
   };
   return {text:messages[r.status]+
    '\nلإلغاء الموافقة ومحو الشارات: <code>/badgeoff '+cmd.chatId+'</code>'};
  }
  if(cmd.kind==='OFF'){
   const r=await service.consent(actor,cmd.chatId,false);
   return {text:r.status==='DISABLED'?
    '✅ سُحبت موافقتك، وحُذفت الشارات والمسودات المرتبطة بحسابك من الحالة النشطة في هذه المجموعة.':
    'ℹ️ لا توجد موافقة أو شارات نشطة لحذفها في هذه المجموعة.'};
  }
  const badges=await service.myBadges(actor,cmd.chatId);
  if(badges===null)return {text:'🔒 لا يوجد إذن فعّال أو تعذّر إثبات العضوية لعرض شاراتك.'};
  if(badges.length===0)return {text:'🏅 شاراتك الشخصية: لم تُمنح لك شارة معتمدة حاليًا.\n'+
   'شارات منارتك تقدير اجتماعي اختياري، وليست شهادة أو أولوية منحة.'};
  return {text:'<b>🏅 شاراتك الاختيارية — للعرض لك وحدك</b>\n'+
   badges.map(x=>'◆ '+BADGE_LABELS[x.code]+' — تاريخ المراجعة UTC: '+
    new Date(x.awardedAt).toISOString()).join('\n')+
   '\n\nهذه شارات مساهمة اجتماعية فقط؛ لا تعطي صلاحيات إشراف أو أهلية أو أولوية قبول منحة.'};
 }catch{return {text:'🔒 تعذّر تنفيذ طلب الشارات بصورة آمنة.'};}
}
