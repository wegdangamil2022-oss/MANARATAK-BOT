import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import type {GroupAdminCommandCleanup} from './group-admin-command-cleanup.js';

const PREFIX='admin-cleanup-owner:',TTL=120000;
const validTime=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000-TTL;
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
export const validAdminCleanupOwnerRoute=(route:string):boolean=>
 route==='ac:1:h'||/^ac:1:n:[A-Za-z0-9_-]{24}$/u.test(route);
type Step={kind:'groups'|'group'|'on'|'off'|'confirm-on'|'confirm-off';chat:string;page:number};
const initial:Step={kind:'groups',chat:'',page:0};
const b=(text:string,callback_data:string)=>({text,callback_data});
export class TelegramAdminCommandCleanupOwner{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly service:GroupAdminCommandCleanup,private readonly clock:()=>number=Date.now){}
 private auth(s:BotState,actor:string,now:number):boolean{
  return validTime(now)&&this.policy.isOwner(actor)&&this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 async handle(actor:string,route:string):Promise<OwnerInlineScreen|null>{
  if(!validAdminCleanupOwnerRoute(route)||!this.policy.isOwner(actor))return null;
  const selected=await this.store.transaction(s=>{
   const now=this.clock();if(!this.auth(s,actor,now))return null;
   let step:Step=initial,expected:string|null=null,ref:string|undefined;
   if(route!=='ac:1:h'){
    const matches=s.callbacks.filter(c=>c.ref===PREFIX+route.slice(7)),c=matches[0];
    if(matches.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||
       !c.oneShot||c.used||c.revoked||!validTime(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
    let value:unknown;try{value=JSON.parse(c.action);}catch{return null;}
    if(!Array.isArray(value)||value.length!==2||typeof value[1]!=='string'||!value[0]||typeof value[0]!=='object'||Array.isArray(value[0]))return null;
    const v=value[0] as Record<string,unknown>;
    if(Object.keys(v).sort().join(',')!=='chat,kind,page'||
      !['groups','group','on','off','confirm-on','confirm-off'].includes(String(v.kind))||
      typeof v.chat!=='string'||!Number.isSafeInteger(v.page)||Number(v.page)<0||Number(v.page)>999)return null;
    step=v as Step;expected=value[1];
    if(step.chat!==''&&this.service.epoch(s,step.chat)!==expected)return null;
    c.used=true;ref=c.ref;
   }
   for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&c.ref!==ref&&!c.used)c.revoked=true;
   return {step,expected,ref};
  });
  if(!selected)return null;
  let {step}=selected;
  if(step.kind==='confirm-on'||step.kind==='confirm-off'){
   if(!selected.ref||!selected.expected||
      !await this.service.configure(actor,step.chat,step.kind==='confirm-on',selected.expected,selected.ref))return null;
   step={...step,kind:'group'};
  }
  return this.store.transaction(s=>{
   const now=this.clock();if(!this.auth(s,actor,now))return null;
   const chats=s.chats.filter(c=>group(c.id)&&s.chats.filter(x=>x.id===c.id).length===1&&
    this.policy.canUseChat(s,c.id,'moderation')).map(c=>c.id).sort();
   if(step.kind!=='groups'&&!chats.includes(step.chat))return null;
   const send=(label:string,next:Step)=>{
    const nonce=randomBytes(18).toString('base64url'),key=PREFIX+nonce;
    s.callbacks.push({ref:key,action:JSON.stringify([next,this.service.epoch(s,next.chat)]),
     actorId:actor,chatId:'private',policyVersion:0,expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
    return b(label,'ac:1:n:'+nonce);
   };
   const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
    ({text,keyboard:{inline_keyboard:rows}});
   if(step.kind==='groups'){
    const pages=Math.max(1,Math.ceil(chats.length/8));if(step.page>=pages)return null;
    const rows=chats.slice(step.page*8,step.page*8+8).map(chat=>[send('👥 '+chat,{kind:'group',chat,page:0})]);
    const nav=[];
    if(step.page>0)nav.push(send('⬅️ السابق',{...step,page:step.page-1}));
    if(step.page+1<pages)nav.push(send('التالي ➡️',{...step,page:step.page+1}));
    if(nav.length)rows.push(nav);
    rows.push([b('↩️ الرسائل الخدمية','mi:1:i:09:04'),b('🏠 لوحة المالك','mi:1:h')]);
    return ui('<b>🧹 تنظيف أوامر المشرفين</b>\nاختر مجموعة معتمدة. هذا خيار مستقل عن حذف رسائل دخول الأعضاء وخروجهم.\nيعمل فقط على أوامر الإشراف التي أنتجت معاينة خاصة مصرحًا بها.',rows);
   }
   const consent=this.service.policy(s,step.chat);
   if(!consent)return null;
   if(step.kind==='group')return ui('<b>🧹 تنظيف أوامر المشرفين</b>\nالمجموعة: <code>'+step.chat+'</code>\nالحالة: '+(consent.enabled?'✅ مفعل':'متوقف')+
    '\nالأوامر المدعومة: معاينات الحظر والكتم والتحذير وأوامر قفل/فتح المجموعة؛ لا يمس رسائل الطلاب أو الأوامر المرفوضة.\nشرط الحذف: وصول المعاينة الخاصة للمشرف مؤكد، مرور دقيقتين، صلاحية الحذف الحالية ومفتاح RUN.\nلا تُحذف الرسائل لمجرد أنها تبدأ بـ /.',
    [[send(consent.enabled?'⛔ إيقاف تنظيف الأوامر':'✅ تفعيل تنظيف الأوامر',{...step,kind:consent.enabled?'off':'on'})],
     [send('↩️ المجموعات',{...initial})],[b('👋 التفاعل والترحيب','mi:1:s:09:0'),b('🏠 لوحة المالك','mi:1:h')]]);
   if(step.kind==='on'||step.kind==='off'){
    return ui('<b>معاينة '+(step.kind==='on'?'تفعيل':'إيقاف')+' تنظيف أوامر المشرفين</b>\nالمجموعة: <code>'+step.chat+'</code>\n'+
     (step.kind==='on'?'سيُحذف أمر الإشراف بعد دقيقتين فقط إذا ثبت نجاح تسليم معاينة القرار للمشرف في الخاص، واستمرت صلاحيات البوت والمشرف والمجموعة.':'سيُمنع حذف أي أمر جديد أو معلّق بموافقة هذا الإعداد.')+
     '\nملاحظات: لا حذف عند فشل الإرسال الخاص أو غموضه؛ لا إعادة تلقائية عند غموض حذف Telegram. سجلات التدقيق تبقى محفوظة.',
     [[send('✅ تأكيد '+(step.kind==='on'?'التفعيل':'الإيقاف'),{...step,kind:step.kind==='on'?'confirm-on':'confirm-off'})],
      [send('↩️ إلغاء',{...step,kind:'group'})]]);
   }
   return null;
  });
 }
}
