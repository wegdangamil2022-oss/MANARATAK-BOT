import {groupRuleDescription} from './telegram-group-rules.js';
import {ruleWarningPolicy,paragraphWarningCount,ruleActionAllowed,type RuleAction} from './group-rule-warning-policy.js';
import {randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {ModerationService} from './moderation.js';
import {moderationCommandReviewEpoch} from './moderation-command-review-epoch.js';
import {executeReplyModerationCommand,type ReplyModerationCommand} from './telegram-moderation-commands.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import type {TelegramInlineKeyboard} from './telegram-inline-owner.js';
const PREFIX='moderation-command:',VIEW=PREFIX+'view:',TTL=120000;
export const validModerationCommandReviewRoute=(data:string)=>/^mc:1:[cx]:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
type Review={chat:string;command:ReplyModerationCommand;epoch:string;createdAt:number;expiresAt:number};
export interface ModerationCommandScreen{text:string;keyboard:TelegramInlineKeyboard;access:AdminUIAccess;status:'APPLIED'|'DENIED'|'IGNORED'|'UNKNOWN';reason:string;}
const names:Record<ReplyModerationCommand['kind'],string>={ban:'الحظر',mute:'الكتم',warn:'التحذير',unwarn:'إلغاء التحذير',unban:'إزالة سبب الحظر',unmute:'إزالة سبب الكتم',kick:'الطرد',review:'مراجعة فقرة',notice:'التنبيه الأول'};
const releaseFor=(c:ReplyModerationCommand)=>c.kind==='unban'||c.kind==='unmute'?{reference:c.reference,kind:c.kind==='unban'?'BAN' as const:'MUTE' as const}:undefined;
function valid(v:unknown):v is Review{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const r=v as Review,c=r.command;
 return Object.keys(r).length===5&&typeof r.chat==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(r.chat)?.[0]===r.chat&&Number.isSafeInteger(Number(r.chat))&&!!c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).length===(Object.hasOwn(c,'durationSeconds')?4:3)&&(c.durationSeconds===undefined?!Object.hasOwn(c,'durationSeconds'):(['ban','mute'].includes(c.kind)&&Number.isSafeInteger(c.durationSeconds)&&c.durationSeconds>=60&&c.durationSeconds<=2592000))&&Object.hasOwn(names,c.kind)&&typeof c.reference==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.exec(c.reference)?.[0]===c.reference&&typeof c.memberId==='string'&&/^[1-9][0-9]{0,15}$/u.exec(c.memberId)?.[0]===c.memberId&&Number.isSafeInteger(Number(c.memberId))&&typeof r.epoch==='string'&&/^[a-f0-9]{64}$/u.exec(r.epoch)?.[0]===r.epoch&&Number.isSafeInteger(r.createdAt)&&r.createdAt>=0&&Number.isSafeInteger(r.expiresAt)&&r.expiresAt===r.createdAt+TTL;
}
function cancel(s:BotState,actor:string){for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX))c.revoked=true;for(const w of s.wizards)if(w.key===VIEW+actor)w.status='CANCELLED';}
export async function cancelModerationCommandReview(store:BotStore,actor:string):Promise<void>{await store.transaction(s=>cancel(s,actor));}
function screen(s:BotState,p:Policy,actor:string,now:number,text:string,keyboard:TelegramInlineKeyboard,status:ModerationCommandScreen['status']='APPLIED',reason='MODERATION_PREVIEW_ONLY'):ModerationCommandScreen|null{
 const epoch=protectionUIEpoch(s,p,actor,now);return epoch?{text,keyboard,status,reason,access:{actorId:actor,epoch,expiresAt:now+TTL}}:null;
}
export class ModerationCommandReview{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly service:ModerationService,private readonly clock:()=>number){}
 async preview(actor:string,chat:string,command:ReplyModerationCommand,presentation?:{displayName?:string;botUsername?:string}):Promise<ModerationCommandScreen|null>{
  const now=this.clock();if(!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor))||!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL)return null;
  const before=await this.store.snapshot(),epoch=moderationCommandReviewEpoch(before,this.policy,actor,chat,command.memberId,now);
  const law=['warn','mute','review','notice'].includes(command.kind)&&command.reference.startsWith('law_')?groupRuleDescription(before,chat,command.reference,true):null;if((['warn','mute'].includes(command.kind)&&command.reference.startsWith('law_')||['review','notice'].includes(command.kind))&&!law)return null;
  if(law&&!ruleActionAllowed(before,chat,command.reference,command.kind as RuleAction,now,command.durationSeconds))return null;
  if(command.kind==='review'&&!this.policy.privateFeature(before,'support.use',actor))return null;
  if(!epoch||!valid({chat,command,epoch,createdAt:now,expiresAt:now+TTL})||!(command.kind==='kick'?await this.service.canReviewKick(actor,chat,command.memberId):await this.service.canReviewCommand(actor,chat,command.memberId,releaseFor(command))))return null;
  return this.store.transaction(s=>{
   const at=this.clock();if(at<now||at>=now+TTL||moderationCommandReviewEpoch(s,this.policy,actor,chat,command.memberId,at)!==epoch)return null;
   const warningSettings=command.kind==='warn'&&law?ruleWarningPolicy(s,chat,command.reference,at):{status:'NONE' as const};
   if(warningSettings.status==='INVALID')return null;
   cancel(s,actor);
   const paragraphCount=warningSettings.status==='CONFIGURED'?paragraphWarningCount(s,chat,command.memberId,command.reference,at):0;
   if(warningSettings.status==='CONFIGURED'&&paragraphCount>=warningSettings.policy.cap)return screen(s,this.policy,actor,at,'بلغ العضو سقف إنذارات هذه الفقرة: '+paragraphCount+' من '+warningSettings.policy.cap+'. لم يُنشأ إنذار أو قيد إضافي. التقييد والمراجعة يحتاجان قرارًا مستقلًا؛ لا توجد عقوبة تلقائية عند بلوغ السقف.',{inline_keyboard:[[{text:'↩️ سياسة الفقرة',callback_data:'rw:1:g:'+chat}],[{text:'↩️ القوانين',callback_data:'rl:1:h:0'}]]},'DENIED','RULE_WARNING_CAP_REACHED');
   const warningInfo=warningSettings.status==='CONFIGURED'?'\nإنذارات هذه الفقرة المحتسبة: '+paragraphCount+' من '+warningSettings.policy.cap:'';
   const nonce=randomBytes(18).toString('base64url');
   s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>at);const old=s.callbacks.filter(c=>c.ref.startsWith(PREFIX)&&c.actorId===actor);const remove=new Set(old.slice(0,Math.max(0,old.length-127)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));
   s.callbacks.push({ref:PREFIX+nonce,actorId:actor,chatId:'private',policyVersion:this.policy.chatRevision(s,chat),expiresAt:now+TTL,oneShot:true,used:false,revoked:false,action:PREFIX+JSON.stringify({chat,command,epoch,createdAt:now,expiresAt:now+TTL})});
   s.wizards=s.wizards.filter(w=>w.key!==VIEW+actor);s.wizards.push({key:VIEW+actor,userId:actor,chatId:actor,topicId:'',flow:VIEW+nonce,step:0,version:1,policyVersion:0,expiresAt:now+TTL,status:'ACTIVE'});
   const display=typeof presentation?.displayName==='string'&&presentation.displayName.length>0&&presentation.displayName.length<=128&&!/[\u0000-\u001f\u007f]/u.test(presentation.displayName)?presentation.displayName.replace(/\p{Cf}/gu,''):actor;
   const safeName=(display||actor).replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
   const bot=presentation?.botUsername,lawVersion=/^law_v([1-9][0-9]{0,14})_/u.exec(command.reference)?.[1];
   const lawLink=law&&lawVersion&&typeof bot==='string'&&/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.exec(bot)?.[0]===bot?'\n<a href="https://t.me/'+bot+'?start=law_'+chat.slice(1)+'_'+lawVersion+'">📜 عرض إصدار القانون</a>\nفتح الرابط يلغي المعاينة؛ أعد الأمر إذا أردت تأكيد الإجراء.':'';
   return screen(s,this.policy,actor,at,'<b>معاينة '+names[command.kind]+'</b>\nالمجموعة: <code>'+chat+'</code>\nالعضو: <code>'+command.memberId+'</code>\nمرجع الحالة: <code>'+command.reference+'</code>'+(law?'\nالمنفذ: <a href="tg://user?id='+actor+'">'+safeName+'</a> · <code>'+actor+'</code>\n'+law.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))+lawLink:'')+warningInfo+'\nالمدة: '+(command.kind==='notice'?'تنبيه خاص؛ الحفظ ليس إيصال وصول. لا إنذار محتسب أو تقييد.':command.kind==='review'?'إحالة خاصة للمراجعة دون إنذار أو تقييد؛ تُغلق من بلاغات المجموعات.':command.kind==='kick'?'إخراج العضو دون حظر دائم؛ يمكنه العودة برابط.':warningSettings.status==='CONFIGURED'?warningSettings.policy.seconds+' ثانية من إصدار الإنذار':command.durationSeconds===undefined?'دون انتهاء تلقائي':command.durationSeconds+' ثانية من وقت التأكيد')+((command.kind==='unban'||command.kind==='unmute')?'\nاستعادة قيد قائم في Telegram تحتاج قرار المالك. يعود العضو إلى أذونات المجموعة العامة؛ رفع الحظر لا يعيده تلقائيًا. تطابق الحالة لا يثبت عدم تدخل مشرف آخر؛ راجع ذلك قبل التأكيد.':'')+'\nلم تُنفذ العملية. التأكيد صالح لدقيقتين ويراجع الصلاحيات والقيود من جديد. إزالة سبب لا تلغي أسباب التقييد المستقلة.',{inline_keyboard:[[{text:'✅ تأكيد '+names[command.kind],callback_data:'mc:1:c:'+nonce},{text:'↩️ إلغاء',callback_data:'mc:1:x:'+nonce}],...(law?[[{text:'↩️ قوانين المجموعات',callback_data:'rl:1:h:0'}]]:[])]});
  });
 }
 async handle(actor:string,data:string):Promise<ModerationCommandScreen|null>{
  if(!validModerationCommandReviewRoute(data))return null;
  const request=await this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(7)),c=rows[0];
   if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.oneShot!==true||c.used!==false||c.revoked!==false||!c.action.startsWith(PREFIX))return null;
   let v:unknown;try{v=JSON.parse(c.action.slice(PREFIX.length));}catch{return null;}
   if(!valid(v)||c.expiresAt!==v.expiresAt||now<v.createdAt||now>=v.expiresAt||c.policyVersion!==this.policy.chatRevision(s,v.chat)||moderationCommandReviewEpoch(s,this.policy,actor,v.chat,v.command.memberId,now)!==v.epoch)return null;
   c.used=true;cancel(s,actor);return v;
  });
  if(!request)return null;
  const allowed=data[5]==='x'||(request.command.kind==='kick'?await this.service.canReviewKick(actor,request.chat,request.command.memberId):await this.service.canReviewCommand(actor,request.chat,request.command.memberId,releaseFor(request.command)));
  const result=data[5]==='x'?{status:'APPLIED' as const,reason:'MODERATION_CANCELLED'}:!allowed?{status:'DENIED' as const,reason:'MODERATION_NOT_AUTHORIZED'}:await executeReplyModerationCommand(this.service,actor,request.chat,request.command,s=>{const now=this.clock();return now>=request.createdAt&&now<request.expiresAt&&moderationCommandReviewEpoch(s,this.policy,actor,request.chat,request.command.memberId,now)===request.epoch;},request.expiresAt);
  return this.store.transaction(s=>screen(s,this.policy,actor,this.clock(),result.reason==='MODERATION_CANCELLED'?'أُلغيت العملية قبل تنفيذها.':result.reason==='RULE_NOTICE_ADDED'?'حُفظ التنبيه الأول للإرسال الخاص. الحفظ ليس إيصال وصول؛ راجع تقرير الأسبوع لحالة التسليم.':result.status==='APPLIED'?'سُجل تنفيذ العملية وفق نتيجة البوابة المهيأة.':result.status==='UNKNOWN'?'نتيجة العملية غير مؤكدة؛ لن تُعاد تلقائيًا.':result.status==='IGNORED'?'لا يوجد تغيير إضافي مطلوب؛ بقيت القيود المستقلة محفوظة.':'لم يُعتمد تنفيذ العملية؛ راجع الصلاحيات والحالة الحالية.',{inline_keyboard:[...(['notice','review'].includes(request.command.kind)?[[{text:'↩️ قوانين المجموعة',callback_data:'rl:1:h:0'}]]:[]),...(request.command.kind==='review'?[[{text:'📨 مراجعات الفقرات',callback_data:'rp:1:r:0'}]]:[]),[{text:'🏠 الرئيسية',callback_data:'pn:1:h'}]]},result.status,result.reason));
 }
}
