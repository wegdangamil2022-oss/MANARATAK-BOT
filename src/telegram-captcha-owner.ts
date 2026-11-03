import {randomBytes} from 'node:crypto';
import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import {CaptchaService,captchaSource,type CaptchaSettings} from './captcha.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
const PREFIX='captcha-owner:';
export const validCaptchaOwnerRoute=(data:string)=>/^ca:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
type Step={kind:'groups'|'edit'|'review'|'confirm'|'queue'|'case';page:number;group:string;settings:CaptchaSettings};
const defaults:CaptchaSettings={enabled:false,timeout:120,attempts:3};
export class TelegramCaptchaOwner{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly captcha:CaptchaService,private readonly clock:()=>number){}
 async cancel(actor:string):Promise<void>{const s=await this.store.snapshot();if(!s.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.revoked))return;await this.store.transaction(s=>{for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX))c.revoked=true;});}
 async handle(actor:string,data:string):Promise<(OwnerInlineScreen&{access:AdminUIAccess})|null>{
  if(!this.policy.isOwner(actor))return null;const root=data==='mi:1:i:04:07'||data==='mi:1:i:04:10';if(!root&&!validCaptchaOwnerRoute(data))return null;
  const selected=await this.store.transaction(s=>{const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!this.policy.privateFeature(s,'owner.dashboard',actor))return null;const epoch=captchaSource(s);let confirmationRef:string|undefined;let step:Step={kind:'groups',group:'',page:0,settings:defaults};
   if(!root){const rows=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(5)),c=rows[0];if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||!c.oneShot||c.used||c.revoked||!Number.isSafeInteger(c.expiresAt)||now>=c.expiresAt||c.expiresAt>now+120000)return null;let values:unknown;try{values=JSON.parse(c.action);}catch{return null;}if(!Array.isArray(values)||values.length!==2||values[1]!==epoch)return null;const v=values[0] as Step;if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='group,kind,page,settings'||!['groups','edit','review','confirm','queue','case'].includes(v.kind)||!Number.isSafeInteger(v.page)||v.page<0||v.page>999||typeof v.group!=='string'||!v.settings||typeof v.settings!=='object'||Object.keys(v.settings).sort().join(',')!=='attempts,enabled,timeout'||typeof v.settings.enabled!=='boolean'||![60,120,300].includes(v.settings.timeout)||![1,3,5].includes(v.settings.attempts))return null;step=v;c.used=true;confirmationRef=c.ref;}
   for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&c.ref!==confirmationRef)c.revoked=true;return {step,epoch,confirmationRef};
  });if(!selected)return null;let step=selected.step;
  if(step.kind==='confirm'){if(!await this.captcha.configure(actor,step.group,step.settings,selected.epoch,selected.confirmationRef))return null;step={...step,kind:'edit'};}
  return this.store.transaction(s=>{const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!this.policy.privateFeature(s,'owner.dashboard',actor)||selected.step.kind!=='confirm'&&captchaSource(s)!==selected.epoch)return null;
   const epoch=captchaSource(s),groups=s.chats.filter(c=>/^-[1-9][0-9]{0,15}$/u.exec(c.id)?.[0]===c.id&&Number.isSafeInteger(Number(c.id))&&s.chats.filter(x=>x.id===c.id).length===1&&this.policy.canUseChat(s,c.id,'moderation')).sort((a,b)=>a.id.localeCompare(b.id));
   const b=(text:string,next:Step)=>{const nonce=randomBytes(18).toString('base64url');s.callbacks.push({ref:PREFIX+nonce,action:JSON.stringify([next,epoch]),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+120000});return {text,callback_data:'ca:1:'+nonce};};
   let text='',rows:{text:string;callback_data:string}[][]=[];
   if(step.kind==='groups'){if(step.page>=Math.max(1,Math.ceil(groups.length/8)))return null;text='<b>اختبار CAPTCHA</b>\nاختر مجموعة. هذا الإصدار يختبر جلسة العضو فقط؛ لا يمنع الكتابة أو يفرض عقوبات.';for(const group of groups.slice(step.page*8,step.page*8+8))rows.push([b(group.id,{...step,kind:'edit',group:group.id})]);if(step.page>0)rows.push([b('السابق',{...step,page:step.page-1})]);if((step.page+1)*8<groups.length)rows.push([b('التالي',{...step,page:step.page+1})]);}
   else if(step.kind==='queue'){
    const cases=this.captcha.reviewCases(s,actor);if(step.page>=Math.max(1,Math.ceil(cases.length/8)))return null;
    text='<b>حالات CAPTCHA للمراجعة البشرية</b>\nالحالات النهائية: '+cases.length+'\nهذه القائمة للعرض؛ لا تفك قيدًا ولا تعيد محاولة عقابية.';
    rows=cases.slice(step.page*8,step.page*8+8).map(c=>[b(c.actor+' · '+c.group,{...step,kind:'case',group:c.nonce})]);
    if(step.page>0)rows.push([b('السابق',{...step,page:step.page-1})]);if((step.page+1)*8<cases.length)rows.push([b('التالي',{...step,page:step.page+1})]);
    rows.push([b('↩️ إعداد الاختبار',{...step,kind:'groups',page:0,group:''})]);
   }
   else if(step.kind==='case'){
    const cases=this.captcha.reviewCases(s,actor).filter(c=>c.nonce===step.group),c=cases[0];if(cases.length!==1||!c)return null;
    text='<b>تفاصيل حالة CAPTCHA</b>\nالمجموعة: '+c.group+'\nالعضو: '+c.actor+'\nالجولة: '+c.round+'\nالمحاولات المستخدمة: '+c.tries+'\nالحالة: '+(c.phase==='FAILED'?'استنفاد المحاولات':'انتهاء المهلة')+'\nنهاية المهلة: '+new Date(c.deadline).toISOString()+'\nلا يغيّر عرض الحالة أي قيد أو دليل محاولة. قرارات الإنفاذ والاستعادة ما زالت بحاجة إلى استكمال.';
    rows=[[b('↩️ قائمة الحالات',{...step,kind:'queue',group:''})]];
   }
   else if(step.kind==='review'){if(!groups.some(c=>c.id===step.group))return null;text='<b>معاينة إعداد CAPTCHA</b>\nالمجموعة: '+step.group+'\nالاختبار: '+(step.settings.enabled?'مفعل':'متوقف')+'\nالمهلة: '+step.settings.timeout+' ثانية\nالمحاولات: '+step.settings.attempts+'\nالتغيير يخص الاختبار فقط ولا يغير قيود Telegram.';rows=[[b('✅ تأكيد الإعداد',{...step,kind:'confirm'})],[b('↩️ إلغاء المعاينة',{...step,kind:'edit'})]];}
   else{if(!groups.some(c=>c.id===step.group))return null;const settings=this.captcha.settings(s,step.group);if(!settings)return null;const {revision:_,...current}=settings;text='<b>إعداد اختبار CAPTCHA</b>\nالمجموعة: '+step.group+'\nاختبار الجدد: '+(settings.enabled?'مفعل':'متوقف')+'\nالمهلة: '+settings.timeout+' ثانية\nالمحاولات: '+settings.attempts+'\nسؤال بسيط مع زر بديل متاح. لا يدعي هذا الاختبار منع كل الحسابات الآلية، ولا يغير قيود Telegram.';
    rows=[[b(settings.enabled?'إيقاف الاختبار':'تفعيل الاختبار للجدد',{...step,kind:'review',settings:{...current,enabled:!settings.enabled}})],...([60,120,300] as const).map(timeout=>[b('⏳ '+timeout+' ثانية',{...step,kind:'review',settings:{...current,timeout}})]),...([1,3,5] as const).map(attempts=>[b('المحاولات: '+attempts,{...step,kind:'review',settings:{...current,attempts}})]),[b('↩️ المجموعات',{kind:'groups',page:step.page,group:'',settings:defaults})]];
   }
   // Confirm intent is a separate screen, never the setting-selection button.
   if(selected.step.kind!=='confirm'&&step.kind==='confirm')return null;
   if(groups.length>0&&(step.kind==='groups'||step.kind==='edit'))rows.push([b('🧑 مراجعة الحالات',{kind:'queue',page:0,group:'',settings:defaults})]);
   rows.push([{text:'↩️ قسم الانضمام',callback_data:'mi:1:s:04:0'},{text:'🏠 لوحة المالك',callback_data:'mi:1:h'}]);const access=protectionUIEpoch(s,this.policy,actor,now);return access?{text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch:access,expiresAt:now+120000}}:null;
  });
 }
}
