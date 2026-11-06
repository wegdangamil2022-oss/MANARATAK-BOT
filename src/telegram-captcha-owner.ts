import type {CaptchaEnforcement} from './captcha-enforcement.js';
import type {CaptchaJoinNotices} from './captcha-join-notices.js';
import type {GroupServiceMessageCleanup} from './group-service-message-cleanup.js';
import type {GroupCleanupAudit} from './group-cleanup-audit.js';
import type {CaptchaEscalationPolicy} from './captcha-escalation-policy.js';
import {randomBytes} from 'node:crypto';
import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import {CaptchaService,captchaSource,type CaptchaSettings} from './captcha.js';
import {CaptchaRuleGate} from './captcha-rules.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
const PREFIX='captcha-owner:';
export const validCaptchaOwnerRoute=(data:string)=>/^ca:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
type Step={kind:'groups'|'edit'|'review'|'confirm'|'queue'|'case'|'accept'|'reject'|'accept-confirm'|'reject-confirm'|'enforce-on'|'enforce-off'|'enforce-on-confirm'|'enforce-off-confirm'|'rules-on'|'rules-off'|'rules-on-confirm'|'rules-off-confirm'|'notice-on'|'notice-off'|'notice-on-confirm'|'notice-off-confirm'|'service-on'|'service-off'|'service-on-confirm'|'service-off-confirm'|'pin-on'|'pin-off'|'pin-on-confirm'|'pin-off-confirm'|'meta-on'|'meta-off'|'meta-on-confirm'|'meta-off-confirm'|'forum-on'|'forum-off'|'forum-on-confirm'|'forum-off-confirm'|'audit-on'|'audit-off'|'audit-on-confirm'|'audit-off-confirm'|'escalation-on'|'escalation-off'|'escalation-on-confirm'|'escalation-off-confirm';page:number;group:string;settings:CaptchaSettings};
const defaults:CaptchaSettings={enabled:false,timeout:120,attempts:3};
export class TelegramCaptchaOwner{
 private readonly rules:CaptchaRuleGate;
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly captcha:CaptchaService,private readonly clock:()=>number,private readonly enforcement?:CaptchaEnforcement,private readonly joinNotices?:CaptchaJoinNotices,private readonly serviceCleanup?:GroupServiceMessageCleanup,private readonly escalation?:CaptchaEscalationPolicy,private readonly cleanupAudit?:GroupCleanupAudit){this.rules=new CaptchaRuleGate(store,policy,captcha,async()=> 'UNKNOWN',clock);}
 async cancel(actor:string):Promise<void>{const s=await this.store.snapshot();if(!s.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.revoked))return;await this.store.transaction(s=>{for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX))c.revoked=true;});}
 async handle(actor:string,data:string):Promise<(OwnerInlineScreen&{access:AdminUIAccess})|null>{
  if(!this.policy.isOwner(actor))return null;const root=data==='mi:1:i:04:07'||data==='mi:1:i:04:10'||data==='mi:1:i:09:01'||data==='mi:1:i:09:04';if(!root&&!validCaptchaOwnerRoute(data))return null;
  const selected=await this.store.transaction(s=>{const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!this.policy.privateFeature(s,'owner.dashboard',actor))return null;const epoch=captchaSource(s);let confirmationRef:string|undefined;let evidence:string|null=null;let step:Step={kind:'groups',group:'',page:0,settings:defaults};
   if(!root){const rows=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(5)),c=rows[0];if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||!c.oneShot||c.used||c.revoked||!Number.isSafeInteger(c.expiresAt)||now>=c.expiresAt||c.expiresAt>now+120000)return null;let values:unknown;try{values=JSON.parse(c.action);}catch{return null;}if(!Array.isArray(values)||![2,3].includes(values.length)||values[1]!==epoch)return null;const v=values[0] as Step;if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='group,kind,page,settings'||!['groups','edit','review','confirm','queue','case','accept','reject','accept-confirm','reject-confirm','enforce-on','enforce-off','enforce-on-confirm','enforce-off-confirm','rules-on','rules-off','rules-on-confirm','rules-off-confirm','notice-on','notice-off','notice-on-confirm','notice-off-confirm','service-on','service-off','service-on-confirm','service-off-confirm','pin-on','pin-off','pin-on-confirm','pin-off-confirm','meta-on','meta-off','meta-on-confirm','meta-off-confirm','forum-on','forum-off','forum-on-confirm','forum-off-confirm','audit-on','audit-off','audit-on-confirm','audit-off-confirm','escalation-on','escalation-off','escalation-on-confirm','escalation-off-confirm'].includes(v.kind)||!Number.isSafeInteger(v.page)||v.page<0||v.page>999||typeof v.group!=='string'||!v.settings||typeof v.settings!=='object'||Object.keys(v.settings).sort().join(',')!=='attempts,enabled,timeout'||typeof v.settings.enabled!=='boolean'||![60,120,300].includes(v.settings.timeout)||![1,3,5].includes(v.settings.attempts))return null;step=v;evidence=typeof values[2]==='string'?values[2]:null;if(['accept','reject','accept-confirm','reject-confirm'].includes(step.kind)&&(!evidence||this.captcha.caseEvidence(s,actor,step.group)!==evidence))return null;if(step.kind.startsWith('rules-')&&(!evidence||this.rules.epoch(s,step.group)!==evidence))return null;if(step.kind.startsWith('notice-')&&(!evidence||this.joinNotices?.epoch(s,step.group)!==evidence))return null;if(step.kind.startsWith('service-')&&(!evidence||this.serviceCleanup?.epoch(s,step.group)!==evidence))return null;if(step.kind.startsWith('pin-')&&(!evidence||this.serviceCleanup?.epochPin(s,step.group)!==evidence))return null;
   if(step.kind.startsWith('meta-')&&(!evidence||this.serviceCleanup?.epochGroupChanges(s,step.group)!==evidence))return null;
   if(step.kind.startsWith('forum-')&&(!evidence||this.serviceCleanup?.epochForum(s,step.group)!==evidence))return null;
   if(step.kind.startsWith('audit-')&&(!evidence||this.cleanupAudit?.epoch(s,step.group)!==evidence))return null;if(step.kind.startsWith('escalation-')&&(!evidence||this.escalation?.epoch(s,step.group)!==evidence))return null;c.used=true;confirmationRef=c.ref;}
   for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&c.ref!==confirmationRef)c.revoked=true;return {step,epoch,confirmationRef,evidence};
  });if(!selected)return null;let step=selected.step;
  if(step.kind==='confirm'){if(!await this.captcha.configure(actor,step.group,step.settings,selected.epoch,selected.confirmationRef))return null;step={...step,kind:'edit'};}
  let decided=false;if(step.kind==='accept-confirm'||step.kind==='reject-confirm'){if(!selected.confirmationRef||!selected.evidence||!await this.captcha.reviewCase(actor,step.group,step.kind==='accept-confirm'?'APPROVED':'REJECTED',selected.evidence,selected.confirmationRef))return null;decided=true;step={...step,kind:'queue',group:'',page:0};}
  if(step.kind==='enforce-on-confirm'||step.kind==='enforce-off-confirm'){if(!this.enforcement||!selected.evidence||!selected.confirmationRef||!await this.enforcement.configure(actor,step.group,step.kind==='enforce-on-confirm',selected.evidence,selected.confirmationRef))return null;step={...step,kind:'edit'};}
  if(step.kind==='rules-on-confirm'||step.kind==='rules-off-confirm'){if(!selected.evidence||!selected.confirmationRef||!await this.rules.configure(actor,step.group,step.kind==='rules-on-confirm',selected.evidence,selected.confirmationRef))return null;step={...step,kind:'edit'};}
  if(step.kind==='notice-on-confirm'||step.kind==='notice-off-confirm'){if(!selected.evidence||!selected.confirmationRef||!this.joinNotices||!await this.joinNotices.configure(actor,step.group,step.kind==='notice-on-confirm',selected.evidence,selected.confirmationRef))return null;step={...step,kind:'edit'};}
  if(step.kind==='service-on-confirm'||step.kind==='service-off-confirm'){
   if(!this.serviceCleanup||!selected.evidence||!selected.confirmationRef||
      !await this.serviceCleanup.configure(actor,step.group,step.kind==='service-on-confirm',selected.evidence,selected.confirmationRef))return null;
   step={...step,kind:'edit'};
  }
  if(step.kind==='pin-on-confirm'||step.kind==='pin-off-confirm'){
   if(!this.serviceCleanup||!selected.evidence||!selected.confirmationRef||
      !await this.serviceCleanup.configurePin(actor,step.group,step.kind==='pin-on-confirm',selected.evidence,selected.confirmationRef))return null;
   step={...step,kind:'edit'};
  }
  if(step.kind==='meta-on-confirm'||step.kind==='meta-off-confirm'){
   if(!this.serviceCleanup||!selected.evidence||!selected.confirmationRef||
      !await this.serviceCleanup.configureGroupChanges(actor,step.group,step.kind==='meta-on-confirm',selected.evidence,selected.confirmationRef))return null;
   step={...step,kind:'edit'};
  }
  if(step.kind==='forum-on-confirm'||step.kind==='forum-off-confirm'){
   if(!this.serviceCleanup||!selected.evidence||!selected.confirmationRef||
      !await this.serviceCleanup.configureForum(actor,step.group,step.kind==='forum-on-confirm',selected.evidence,selected.confirmationRef))return null;
   step={...step,kind:'edit'};
  }
  if(step.kind==='audit-on-confirm'||step.kind==='audit-off-confirm'){
   if(!this.cleanupAudit||!selected.evidence||!selected.confirmationRef||
      !await this.cleanupAudit.configure(actor,step.group,step.kind==='audit-on-confirm',selected.evidence,selected.confirmationRef))return null;
   step={...step,kind:'edit'};
  }
  if(step.kind==='escalation-on-confirm'||step.kind==='escalation-off-confirm'){
   if(!this.escalation||!selected.evidence||!selected.confirmationRef||
      !await this.escalation.configure(actor,step.group,step.kind==='escalation-on-confirm'?'EXTENDED':'STANDARD',selected.evidence,selected.confirmationRef))return null;
   step={...step,kind:'edit'};
  }
  return this.store.transaction(s=>{const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!this.policy.privateFeature(s,'owner.dashboard',actor)||selected.step.kind!=='confirm'&&captchaSource(s)!==selected.epoch)return null;
   const epoch=captchaSource(s),groups=s.chats.filter(c=>/^-[1-9][0-9]{0,15}$/u.exec(c.id)?.[0]===c.id&&Number.isSafeInteger(Number(c.id))&&s.chats.filter(x=>x.id===c.id).length===1&&this.policy.canUseChat(s,c.id,'moderation')).sort((a,b)=>a.id.localeCompare(b.id));
   const b=(text:string,next:Step)=>{const nonce=randomBytes(18).toString('base64url');s.callbacks.push({ref:PREFIX+nonce,action:JSON.stringify([next,epoch,next.kind.startsWith('enforce-')?this.enforcement?.epoch(s,next.group)??null:next.kind.startsWith('rules-')?this.rules.epoch(s,next.group):next.kind.startsWith('notice-')?this.joinNotices?.epoch(s,next.group)??null:next.kind.startsWith('service-')?this.serviceCleanup?.epoch(s,next.group)??null:next.kind.startsWith('pin-')?this.serviceCleanup?.epochPin(s,next.group)??null:next.kind.startsWith('meta-')?this.serviceCleanup?.epochGroupChanges(s,next.group)??null:next.kind.startsWith('forum-')?this.serviceCleanup?.epochForum(s,next.group)??null:next.kind.startsWith('audit-')?this.cleanupAudit?.epoch(s,next.group)??null:next.kind.startsWith('escalation-')?this.escalation?.epoch(s,next.group)??null:this.captcha.caseEvidence(s,actor,next.group)]),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+120000});return {text,callback_data:'ca:1:'+nonce};};
   let text='',rows:{text:string;callback_data:string}[][]=[];
   if(step.kind==='groups'){if(step.page>=Math.max(1,Math.ceil(groups.length/8)))return null;text='<b>إعدادات الانضمام والدخول والخروج</b>\nاختر مجموعة لإدارة CAPTCHA، ورسائل الدخول والخروج والتثبيت وتغييرات المجموعة وإشعارات المنتدى الأصلية، وروابط فتح البوت. كل وظيفة تحتاج موافقة مستقلة.';for(const group of groups.slice(step.page*8,step.page*8+8))rows.push([b(group.id,{...step,kind:'edit',group:group.id})]);if(step.page>0)rows.push([b('السابق',{...step,page:step.page-1})]);if((step.page+1)*8<groups.length)rows.push([b('التالي',{...step,page:step.page+1})]);}
   else if(step.kind==='queue'){
    const cases=this.captcha.reviewCases(s,actor);if(step.page>=Math.max(1,Math.ceil(cases.length/8)))return null;
    text=(decided?'✅ حُفظ القرار البشري.\n':'')+'<b>حالات CAPTCHA للمراجعة البشرية</b>\nالحالات النهائية: '+cases.length+'\nالقرارات تخص خطوة CAPTCHA فقط؛ لا تفك قيدًا ولا تعيد محاولة عقابية.';
    rows=cases.slice(step.page*8,step.page*8+8).map(c=>[b(c.actor+' · '+c.group,{...step,kind:'case',group:c.nonce})]);
    if(step.page>0)rows.push([b('السابق',{...step,page:step.page-1})]);if((step.page+1)*8<cases.length)rows.push([b('التالي',{...step,page:step.page+1})]);
    rows.push([b('↩️ إعداد الاختبار',{...step,kind:'groups',page:0,group:''})]);
   }
   else if(step.kind==='case'){
    const cases=this.captcha.reviewCases(s,actor).filter(c=>c.nonce===step.group),c=cases[0];if(cases.length!==1||!c)return null;
    text='<b>تفاصيل حالة CAPTCHA</b>\nالمجموعة: '+c.group+'\nالعضو: '+c.actor+'\nالجولة: '+c.round+'\nالمحاولات المستخدمة: '+c.tries+'\nالحالة: '+(c.phase==='FAILED'?'استنفاد المحاولات':'انتهاء المهلة')+'\nنهاية المهلة: '+new Date(c.deadline).toISOString()+'\nلا يغيّر عرض الحالة أي قيد أو دليل محاولة. اختر قرارًا ثم راجع المعاينة قبل التأكيد. الإنفاذ والاستعادة مستقلان عن القرار.';
    rows=[[b('✅ قبول التحقق',{...step,kind:'accept'}),b('رفض التحقق',{...step,kind:'reject'})],[b('↩️ قائمة الحالات',{...step,kind:'queue',group:''})]];
   }
   else if(step.kind==='accept'||step.kind==='reject'){
    const c=this.captcha.reviewCases(s,actor).find(c=>c.nonce===step.group);if(!c||this.captcha.caseEvidence(s,actor,step.group)!==selected.evidence)return null;
    text='<b>معاينة القرار البشري</b>\nالمجموعة: '+c.group+'\nالعضو: '+c.actor+'\nالقرار: '+(step.kind==='accept'?'قبول التحقق':'رفض التحقق')+'\nالقرار نهائي لهذه الجلسة. يخص خطوة CAPTCHA فقط ولا يمنح عضوية قناة أو موافقة على القوانين، ولا يرفع أي قيد مستقل.';
    rows=[[b('✅ تأكيد القرار',{...step,kind:step.kind==='accept'?'accept-confirm':'reject-confirm'})],[b('↩️ إلغاء القرار',{...step,kind:'case'})]];
   }
   else if(step.kind==='enforce-on'||step.kind==='enforce-off'){
    if(!this.enforcement?.available()||!groups.some(c=>c.id===step.group)||!this.captcha.settings(s,step.group)?.enabled)return null;
    text='<b>معاينة إنفاذ CAPTCHA</b>\nالمجموعة: '+step.group+'\n'+(step.kind==='enforce-on'?'سيُمنع العضو الجديد من الكتابة بعد رصد انضمامه حتى نجاح CAPTCHA أو قبوله بشريًا. لا تنتهي هذه الوقفة تلقائيًا بانتهاء مهلة السؤال. يلزم فتح العضو خاص البوت لحل الاختبار. القيود الموجودة تحتاج مراجعتها المستقلة.':'سيتوقف إنشاء قيود جديدة وفكها آليًا عبر CAPTCHA. القيود السابقة تحتاج مراجعة صريحة قبل فكها.')+'\nعند وجود اشتراك إجباري فعال، لا تكتمل الاستعادة قبل اجتياز CAPTCHA وقبول القوانين المطلوبة وإثبات القنوات، مع استمرار كل عقوبة مستقلة.'+'\nالموافقة تخص هذه النسخة من إعدادات المجموعة؛ تغييرها يتطلب إعادة اعتماد الإنفاذ.';
    rows=[[b('✅ تأكيد الإنفاذ',{...step,kind:step.kind==='enforce-on'?'enforce-on-confirm':'enforce-off-confirm'})],[b('↩️ إلغاء الإنفاذ',{...step,kind:'edit'})]];
   }
   else if(step.kind==='rules-on'||step.kind==='rules-off'){
    if(!groups.some(c=>c.id===step.group)||!this.captcha.settings(s,step.group)?.enabled||step.kind==='rules-on'&&(!this.rules.hasRules(s,step.group)||!this.policy.canUseChat(s,step.group,'navigation')||!this.policy.canUseChat(s,step.group,'verification')))return null;
    text='<b>معاينة موافقة القوانين</b>\nالمجموعة: '+step.group+'\n'+(step.kind==='rules-on'?'بعد نجاح CAPTCHA يُعرض إصدار القوانين الحالي. إذا كان إنفاذ منع الكتابة مفعلًا، يبقى قيد CAPTCHA حتى موافقة العضو. تغيير القوانين يتطلب قبول الإصدار الجديد.':'لن تُطلب موافقة القوانين ضمن تسوية CAPTCHA بعد التأكيد. القيود المستقلة وشروط الاشتراك تبقى بحسب إعداداتها.');
    rows=[[b('✅ تأكيد إعداد القوانين',{...step,kind:step.kind==='rules-on'?'rules-on-confirm':'rules-off-confirm'})],[b('↩️ إلغاء',{...step,kind:'edit'})]];
   }
   else if(step.kind==='notice-on'||step.kind==='notice-off'){
    if(!this.joinNotices||!groups.some(c=>c.id===step.group))return null;
    if(step.kind==='notice-on'&&!this.captcha.settings(s,step.group)?.enabled)return null;
    text='<b>معاينة رابط فتح البوت عند الانضمام</b>\nالمجموعة: '+step.group+'\n'+
     (step.kind==='notice-on'?
      'بعد رصد انضمام موثوق وجلسة CAPTCHA جديدة، تُعرض رسالة عامة موجزة فيها زر فتح خاص البوت، دون ذكر اسم العضو أو بياناته أو نتيجة التحقق. تحذف الآلة رسالتها المؤكدة بعد دقيقة فقط، إذا استمر الاعتماد والأذونات. قد تظل رسالة الانضمام الأصلية ظاهرة؛ هذا الإعداد لا يحذفها.':
      'تُوقف الإشعارات الجديدة. الإشعارات المنشورة سابقًا لا تُحذف إلا بإيصال إرسالها المؤكد وبحدود السلامة.')+
     '\nلا يُرسل البوت رسالة خاصة إلى العضو قبل أن يفتح الخاص بنفسه. نتيجة Telegram المجهولة لا تُعاد تلقائيًا.';
    rows=[[b('✅ تأكيد رابط البوت',{...step,kind:step.kind==='notice-on'?'notice-on-confirm':'notice-off-confirm'})],[b('↩️ إلغاء',{...step,kind:'edit'})]];
   }
   else if(step.kind==='service-on'||step.kind==='service-off'){
    if(!this.serviceCleanup||!groups.some(c=>c.id===step.group))return null;
    text='<b>معاينة حذف رسائل الدخول والخروج</b>\nالمجموعة: '+step.group+'\n'+
     (step.kind==='service-on'?
      'بعد رصد حدث دخول أو خروج أصلي موثوق من Telegram، يستطيع البوت حذف رسالة الخدمة الأصلية بعد دقيقة عند توفر صلاحية حذف الرسائل وتفعيل خيار المالك. لن تُمس رسائل الطلاب أو رسائل أخرى.':
      'سيتوقف حذف رسائل الخدمة الأصلية. الرسائل السابقة التي لم تُحذف تتطلب قرارًا جديدًا، ولن تُعاد تفعيل موافقة قديمة.')+
     '\nالمعالجة لا تعيد الحذف تلقائيًا عند غموض نتيجة Telegram، ولا تتجاوز STOP أو اختلاف نسخة الإعداد.';
    rows=[[b('✅ تأكيد الحذف التلقائي',{...step,kind:step.kind==='service-on'?'service-on-confirm':'service-off-confirm'})],[b('↩️ إلغاء',{...step,kind:'edit'})]];
   }
   else if(step.kind==='pin-on'||step.kind==='pin-off'){
    if(!this.serviceCleanup||!groups.some(c=>c.id===step.group))return null;
    text='<b>معاينة حذف إشعارات التثبيت</b>\nالمجموعة: '+step.group+'\n'+
     (step.kind==='pin-on'?
      'سيُحذف إشعار Telegram الأصلي الذي يُعلن تثبيت رسالة بعد مرور دقيقة، وليس الرسالة المثبتة نفسها. هذا إعداد مستقل عن حذف رسائل الدخول والخروج ولا يُفعّل تلقائيًا عند تشغيلها.':
      'سيتوقف تنظيف إشعارات التثبيت. لن يستأنف البوت حذف الإشعارات القديمة حتى لو فُعّل لاحقًا.')+
     '\nيتطلب التنفيذ صلاحية الحذف الحالية وRUN وإيصال Telegram موثوقًا. النتيجة الغامضة لا تعاد تلقائيًا.';
    rows=[[b('✅ تأكيد حذف إشعارات التثبيت',{...step,kind:step.kind==='pin-on'?'pin-on-confirm':'pin-off-confirm'})],[b('↩️ إلغاء',{...step,kind:'edit'})]];
   }
   else if(step.kind==='meta-on'||step.kind==='meta-off'){
    if(!this.serviceCleanup||!groups.some(c=>c.id===step.group))return null;
    text='<b>معاينة تنظيف تغييرات المجموعة</b>\nالمجموعة: '+step.group+'\n'+
     (step.kind==='meta-on'?
      'سيحذف البوت بعد دقيقة إشعارات Telegram الأصلية الخاصة بتغيير اسم المجموعة أو صورتها أو إزالة صورتها فقط. لا يعيد الاسم القديم، ولا يحذف الصورة الجديدة، ولا يمس رسائل الطلاب.':
      'سيتوقف تنظيف إشعارات تغييرات المجموعة، ولن تُستأنف الإشعارات القديمة من تلقاء نفسها.')+
     '\nيلزم إذن حذف الرسائل وSTOP آمن؛ القرار مستقل عن تنظيف الدخول والخروج والتثبيت والمنتدى. لا تعاد النتائج الغامضة تلقائيًا.';
    rows=[[b('✅ تأكيد تنظيف تغييرات المجموعة',{...step,kind:step.kind==='meta-on'?'meta-on-confirm':'meta-off-confirm'})],[b('↩️ إلغاء',{...step,kind:'edit'})]];
   }
   else if(step.kind==='forum-on'||step.kind==='forum-off'){
    if(!this.serviceCleanup||!groups.some(c=>c.id===step.group))return null;
    text='<b>معاينة تنظيف إشعارات المواضيع</b>\nالمجموعة: '+step.group+'\n'+
     (step.kind==='forum-on'?
      'سيحذف البوت بعد دقيقة إشعارات Telegram الأصلية عن إنشاء موضوع أو تغيير عنوانه أو إغلاقه أو إعادة فتحه أو إخفاء الموضوع العام وإظهاره. لا يحذف أي موضوع أو محتواه ولا يغير صلاحياته.':
      'سيُوقف تنظيف إشعارات مواضيع المنتدى دون حذف أي حدث قديم بعد الإيقاف.')+
     '\nيلزم إذن حذف الرسائل وSTOP آمن؛ هذا التفويض مستقل عن بقية إشعارات Telegram. لا تعاد النتائج الغامضة.';
    rows=[[b('✅ تأكيد تنظيف إشعارات المواضيع',{...step,kind:step.kind==='forum-on'?'forum-on-confirm':'forum-off-confirm'})],[b('↩️ إلغاء',{...step,kind:'edit'})]];
   }
   else if(step.kind==='audit-on'||step.kind==='audit-off'){
    if(!this.cleanupAudit||!groups.some(c=>c.id===step.group))return null;
    const consent=this.cleanupAudit.policy(s,step.group);
    if(!consent)return null;
    text='<b>معاينة تدقيق الحذف في وجهة خاصة معتمدة</b>\nالمجموعة: '+step.group+'\n'+
     (step.kind==='audit-on'?
      (this.cleanupAudit.channel(s,step.group)?.channel?'سيُرسل ملخص واحد بحد أقصى لكل دقيقة إلى قناة التدقيق الخاصة التي اعتمدها المالك، بعد تحقق Telegram من خصوصية القناة وحق البوت في نشر الرسائل.':'سيُرسل ملخص واحد بحد أقصى لكل دقيقة مكتملة إلى غرفة الإشعارات المخوّلة رسميًا بموافقتي المجموعة والغرفة، بشرط أن يؤكد Telegram أنها ليست عامة.')+' لا تتضمن الرسالة أسماء الطلاب ولا نصوص الأوامر ولا أرقام رسائل الحذف. إن تعذر إثبات الخصوصية فلن يُرسل أي ملخص.':
      'سيُوقف إرسال ملخصات تدقيق الحذف فورًا؛ تبقى السجلات المحلية ولا تُستأنف الملخصات القديمة بعد إعادة التفعيل.')+
     '\nهذا التفويض مستقل عن موافقات حذف رسائل الخدمة وأوامر المشرفين؛ ولا يفعّل الحذف أو إنشاء غرفة جديدة. تغيير الغرفة أو الصلاحيات يلغي التفويض القديم.';
    rows=[[b('✅ تأكيد تدقيق الحذف',{...step,kind:step.kind==='audit-on'?'audit-on-confirm':'audit-off-confirm'})],[b('↩️ إلغاء',{...step,kind:'edit'})]];
   }
   else if(step.kind==='escalation-on'||step.kind==='escalation-off'){
    if(!this.escalation||!groups.some(c=>c.id===step.group)||!this.captcha.settings(s,step.group)?.enabled)return null;
    text='<b>معاينة التدرج المتقدم لعقوبة CAPTCHA</b>\nالمجموعة: '+step.group+'\n'+
     (step.kind==='escalation-on'?
      'سيصبح انتظار إعادة المحاولة بعد فشل الجولة الأولى 3 دقائق، وبعد الثانية 10 دقائق، وفي الثالثة تُحال الحالة للمراجعة البشرية.':
      'سيعود انتظار إعادة المحاولة إلى 1 و2 و3 دقائق، دون تقصير الجولات القديمة التي بدأت بالفعل.')+
     '\nلا حظر دائم أو طرد تلقائي؛ يبقى قيد CAPTCHA المملوك كما هو حتى اجتياز جميع الشروط. موافقة مستقلة لازمة.';
    rows=[[b('✅ تأكيد التدرج',{...step,kind:step.kind==='escalation-on'?'escalation-on-confirm':'escalation-off-confirm'})],[b('↩️ إلغاء',{...step,kind:'edit'})]];
   }
   else if(step.kind==='review'){if(!groups.some(c=>c.id===step.group))return null;text='<b>معاينة إعداد CAPTCHA</b>\nالمجموعة: '+step.group+'\nالاختبار: '+(step.settings.enabled?'مفعل':'متوقف')+'\nالمهلة: '+step.settings.timeout+' ثانية\nالمحاولات: '+step.settings.attempts+'\nالتغيير يخص الاختبار ويبطل اعتماد الإنفاذ السابق؛ القيود القائمة تحتاج مراجعة مستقلة.';rows=[[b('✅ تأكيد الإعداد',{...step,kind:'confirm'})],[b('↩️ إلغاء المعاينة',{...step,kind:'edit'})]];}
   else{if(!groups.some(c=>c.id===step.group))return null;const settings=this.captcha.settings(s,step.group);if(!settings)return null;const {revision:_,...current}=settings;text='<b>إعداد اختبار CAPTCHA</b>\nالمجموعة: '+step.group+'\nاختبار الجدد: '+(settings.enabled?'مفعل':'متوقف')+'\nالمهلة: '+settings.timeout+' ثانية\nالمحاولات: '+settings.attempts+'\nسؤال بسيط مع زر بديل متاح. لا يدعي هذا الاختبار منع كل الحسابات الآلية، ولا يغير قيود Telegram.';
    rows=[[b(settings.enabled?'إيقاف الاختبار':'تفعيل الاختبار للجدد',{...step,kind:'review',settings:{...current,enabled:!settings.enabled}})],...([60,120,300] as const).map(timeout=>[b('⏳ '+timeout+' ثانية',{...step,kind:'review',settings:{...current,timeout}})]),...([1,3,5] as const).map(attempts=>[b('المحاولات: '+attempts,{...step,kind:'review',settings:{...current,attempts}})]),[b('↩️ المجموعات',{kind:'groups',page:step.page,group:'',settings:defaults})]];
   }
   if(step.kind==='edit'&&this.enforcement?.available()&&this.captcha.settings(s,step.group)?.enabled){if(!this.enforcement.standalone(s,step.group))text+='\nإنفاذ CAPTCHA المشترك غير جاهز: يلزم تفعيل إنفاذ الاشتراك أولًا بموافقة مستقلة، وتحقق من صلاحية قاعدة القنوات وسياسة المهلة؛ القاعدة غير الصالحة تحتاج تصحيحًا قبل التشغيل.';else{const enabled=this.enforcement.consent(s,step.group)?.enabled===true;text+='\nإنفاذ CAPTCHA: '+(enabled?'مفعل بالموافقة المستقلة':'متوقف');rows.push([b(enabled?'إيقاف إنفاذ CAPTCHA':'تفعيل إنفاذ CAPTCHA بالموافقة',{...step,kind:enabled?'enforce-off':'enforce-on'})]);}}
   if(step.kind==='edit'&&this.captcha.settings(s,step.group)?.enabled){const mode=this.rules.mode(s,step.group),ready=this.rules.hasRules(s,step.group)&&this.policy.canUseChat(s,step.group,'navigation')&&this.policy.canUseChat(s,step.group,'verification');text+='\nموافقة القوانين: '+(mode==='ON'?'مطلوبة':mode==='OFF'?'غير مطلوبة':'تحتاج إعادة اعتماد');if(mode==='ON'||ready)rows.push([b(mode==='ON'?'إيقاف موافقة القوانين':'تفعيل موافقة القوانين',{...step,kind:mode==='ON'?'rules-off':'rules-on'})]);else text+='\nلا بد من نشر القوانين واعتماد نطاقي التصفح والتحقق لعرضها للعضو.';}
   if(step.kind==='edit'&&this.joinNotices&&this.captcha.settings(s,step.group)?.enabled){
    const state=this.joinNotices.policy(s,step.group),enabled=state?.enabled===true;
    text+='\nرابط فتح البوت عند الانضمام: '+(enabled?'مفعل مع تنظيف رسالة البوت بعد دقيقة':'متوقف');
    rows.push([b(enabled?'إيقاف رابط البوت':'تفعيل رابط البوت',{...step,kind:enabled?'notice-off':'notice-on'})]);
   }
   if(step.kind==='edit'&&this.serviceCleanup){
    const service=this.serviceCleanup.policy(s,step.group),enabled=service?.enabled===true;
    text+='\nحذف رسائل الدخول والخروج الأصلية: '+(enabled?'مفعل بعد دقيقة':'متوقف');
    if(service)rows.push([b(enabled?'إيقاف حذف رسائل الدخول والخروج':'تفعيل حذف رسائل الدخول والخروج',
     {...step,kind:enabled?'service-off':'service-on'})]);
   }
   if(step.kind==='edit'&&this.serviceCleanup){
    const pin=this.serviceCleanup.policyPin(s,step.group),enabled=pin?.enabled===true;
    text+='\nحذف إشعارات التثبيت الأصلية: '+(enabled?'مفعّل بموافقة مستقلة':'متوقف');
    if(pin)rows.push([b(enabled?'إيقاف حذف إشعارات التثبيت':'تفعيل حذف إشعارات التثبيت',{...step,kind:enabled?'pin-off':'pin-on'})]);
   }
   if(step.kind==='edit'&&this.serviceCleanup){
    const changes=this.serviceCleanup.policyGroupChanges(s,step.group),enabled=changes?.enabled===true;
    text+='\nتنظيف إشعارات تغييرات المجموعة: '+(enabled?'مفعل بموافقة مستقلة':'متوقف');
    if(changes)rows.push([b(enabled?'إيقاف تنظيف تغييرات المجموعة':'تفعيل تنظيف تغييرات المجموعة',
     {...step,kind:enabled?'meta-off':'meta-on'})]);
   }
   if(step.kind==='edit'&&this.serviceCleanup){
    const forum=this.serviceCleanup.policyForum(s,step.group),enabled=forum?.enabled===true;
    text+='\nتنظيف إشعارات مواضيع المنتدى: '+(enabled?'مفعل بموافقة مستقلة':'متوقف');
    if(forum)rows.push([b(enabled?'إيقاف تنظيف إشعارات المواضيع':'تفعيل تنظيف إشعارات المواضيع',
     {...step,kind:enabled?'forum-off':'forum-on'})]);
   }
   if(step.kind==='edit'&&this.cleanupAudit){
    const audit=this.cleanupAudit.policy(s,step.group),enabled=audit?.enabled===true,ready=this.cleanupAudit.ready(s,step.group),channel=this.cleanupAudit.channel(s,step.group)?.channel;
    text+='\nتدقيق الحذف إلى '+(channel?'قناة Telegram الخاصة '+channel:'غرفة إشعارات خاصة')+': '+(enabled?'مفعل ومشروط بفحص Telegram الحالي':'متوقف');
    if(!ready)text+='\nيتطلب تفعيل التدقيق اعتماد قناة Telegram خاصة أو ربط غرفة إشعارات إدارة معتمدة بموافقتَي المجموعة والغرفة.';
    rows.push([{text:'📢 إعداد قناة Telegram الخاصة للتدقيق',callback_data:'cu:1:h'}]);
    if(audit&&ready)rows.push([b(enabled?'إيقاف تدقيق الحذف':'تفعيل تدقيق الحذف',
     {...step,kind:enabled?'audit-off':'audit-on'})]);
   }
   if(step.kind==='edit'&&this.serviceCleanup)rows.push([{text:'🧹 تنظيف أوامر المشرفين (موافقة مستقلة)',callback_data:'ac:1:h'}]);
   if(step.kind==='edit'&&this.escalation&&this.captcha.settings(s,step.group)?.enabled){
    const mode=this.escalation.mode(s,step.group);
    text+='\nتدرج انتظار CAPTCHA: '+(mode==='EXTENDED'?'مفعل (3 ثم 10 دقائق، ثم مراجعة بشرية)':'اعتيادي (1، 2، 3 دقائق)');
    if(mode)rows.push([b(mode==='EXTENDED'?'إيقاف التدرج المتقدم':'تفعيل التدرج المتقدم',
     {...step,kind:mode==='EXTENDED'?'escalation-off':'escalation-on'})]);
   }
   // Confirm intent is a separate screen, never the setting-selection button.
   if(selected.step.kind!=='confirm'&&step.kind==='confirm')return null;
   if(groups.length>0&&(step.kind==='groups'||step.kind==='edit'))rows.push([b('🧑 مراجعة الحالات',{kind:'queue',page:0,group:'',settings:defaults})]);
   rows.push([{text:'↩️ قسم الانضمام',callback_data:'mi:1:s:04:0'},{text:'👋 التفاعل والترحيب',callback_data:'mi:1:s:09:0'}]);rows.push([{text:'🏠 لوحة المالك',callback_data:'mi:1:h'}]);const access=protectionUIEpoch(s,this.policy,actor,now);return access?{text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch:access,expiresAt:now+120000}}:null;
  });
 }
}
