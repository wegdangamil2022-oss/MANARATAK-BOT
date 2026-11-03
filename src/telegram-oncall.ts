import {randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {AdminRoomLinks} from './admin-room-links.js';
import {AdminRoomOncall,oncallSetting,oncallPreviewWitness,saveOncall,type OncallOptions} from './admin-room-oncall.js';
import {reportManager} from './moderation-report-notices.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
const PREFIX='oncall-preview:',TTL=120000;
const ROUTE=/^oc:1:g:([A-Za-z0-9_-]{24})$|^oc:1:c:([A-Za-z0-9_-]{24})$|^oc:1:a:([A-Za-z0-9_-]{24}):([a-f0-9]{16})$|^oc:1:o:([A-Za-z0-9_-]{24})$/u;
export const validOncallRoute=(data:string)=>ROUTE.exec(data)?.[0]===data;
type Screen=OwnerInlineScreen&{access:AdminUIAccess};
export class TelegramOncall{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number){ }
 async cancel(actor:string):Promise<void>{const s=await this.store.snapshot();if(!s.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used&&!c.revoked))return;await this.store.transaction(s=>{for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used)c.revoked=true;});}
 private screen(s:BotState,actor:string,text:string,keyboard:OwnerInlineScreen['keyboard'],now:number):Screen|null{const epoch=protectionUIEpoch(s,this.policy,actor,now);return epoch&&Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-TTL?{text,keyboard,access:{actorId:actor,epoch,expiresAt:now+TTL}}:null;}
 async command(actor:string,text:string):Promise<Screen|null>{
  const m=/^\/oncall (-[1-9][0-9]{0,15})(?: ([1-9][0-9]{0,15}) ([1-9][0-9]{0,15}) ([1-9][0-9]{1,3})| (off))?$/u.exec(text);if(!m||m[0]!==text)return null;
  const chat=m[1]!,s=await this.store.snapshot(),now=this.clock();if(!reportManager(s,this.policy,actor,chat,now))return null;const current=oncallSetting(s,this.policy,chat,now),stored=oncallSetting(s,this.policy,chat,now,true);
  const links=await new AdminRoomLinks(this.store,this.policy,this.clock).visible(actor),link=links.find(l=>l.group===chat&&l.mode==='NOTIFICATIONS'&&l.status==='ACTIVE');if(!link)return null;
  const back={text:'↩️ غرفة الإدارة',callback_data:'al:1:d:'+link.id};
  const statusRows=[...(stored?.enabled?[[{text:'🛑 إيقاف المناوبة',callback_data:'oc:1:o:'+link.id}]]:[]),[{text:'🔄 تحديث',callback_data:'oc:1:g:'+link.id}],[back]];
  if(!m[2]&&!m[5])return this.screen(s,actor,'<b>مناوبة البلاغات</b>\nالمجموعة: '+chat+'\n'+(current?('الحالة: '+(current.enabled?'مفعّلة':'متوقفة')+'\nالمناوب: '+current.primary+'\nالبديل: '+current.fallback+'\nالمهلة: '+current.seconds+' ثانية'):current===null?'الإعداد السابق غير صالح حاليًا؛ تحقق من الصلاحيات وربط الغرفة.':'المناوبة غير مهيأة.')+'\nللإعداد: <code>/oncall '+chat+' رقم_المناوب رقم_البديل مدة_بالثواني</code>\nالمدة من 60 إلى 3600 ثانية، ويلزم أن يكون الاثنان مشرفين مخولين.\nللإيقاف: <code>/oncall '+chat+' off</code>\nيُبلَّغ المناوب في الخاص، ثم البديل عند عدم الاستلام. لا تصدر عقوبة تلقائية.',{inline_keyboard:statusRows},now);
  const options:OncallOptions|null=m[5]?stored?{primary:stored.primary,fallback:stored.fallback,seconds:stored.seconds,enabled:false}:null:{primary:m[2]!,fallback:m[3]!,seconds:Number(m[4]),enabled:true};if(!options)return null;
  const witness=oncallPreviewWitness(s,this.policy,actor,chat,options,now);if(!witness)return null;const token=randomBytes(18).toString('base64url');
  return this.store.transaction(state=>{const at=this.clock();if(at<now||at>=now+TTL||oncallPreviewWitness(state,this.policy,actor,chat,options,at)!==witness)return null;
   for(const c of state.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used)c.revoked=true;
   state.callbacks.push({ref:PREFIX+token,action:JSON.stringify({chat,options,witness,expected:stored?.witness??'0',createdAt:at}),chatId:'private',actorId:actor,policyVersion:0,expiresAt:at+TTL,oneShot:true,used:false,revoked:false});
   return this.screen(state,actor,'<b>معاينة إعداد المناوبة</b>\nالمجموعة: '+chat+'\nالمناوب: '+options.primary+'\nالبديل: '+options.fallback+'\nالمهلة: '+options.seconds+' ثانية\nالحالة المطلوبة: '+(options.enabled?'مفعلة':'متوقفة')+'\nيبدأ الإعداد بالبلاغات الجديدة بعد الاعتماد. الرجوع يلغي هذه المعاينة.',{inline_keyboard:[[{text:'✅ اعتماد الإعداد',callback_data:'oc:1:c:'+token}],[back]]},at);
  });
 }
 async handle(actor:string,data:string):Promise<Screen|null>{
  const m=ROUTE.exec(data);if(!m||m[0]!==data)return null;
  if(m[1]||m[5]){const row=(await new AdminRoomLinks(this.store,this.policy,this.clock).visible(actor)).find(r=>r.id===(m[1]??m[5])&&r.mode==='NOTIFICATIONS'&&r.status==='ACTIVE');return row?this.command(actor,'/oncall '+row.group+(m[5]?' off':'')):null;}
  if(m[3]){if(!await new AdminRoomOncall(this.store,this.policy,this.clock).acknowledge(actor,m[3],m[4]!))return null;const s=await this.store.snapshot();return this.screen(s,actor,'تم استلام البلاغ وتوقف التصعيد. افتح صندوق البلاغات لمراجعته؛ الاستلام لا يغلق البلاغ ولا ينفذ عقوبة.',{inline_keyboard:[[{text:'📨 صندوق البلاغات',callback_data:'rp:1:r:0'}]]},this.clock());}
  return this.store.transaction(s=>{const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===PREFIX+m[2]),c=rows[0];if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.oneShot!==true||c.used!==false||c.revoked!==false)return null;
   let v:{chat:string;options:OncallOptions;witness:string;expected:string;createdAt:number};try{v=JSON.parse(c.action);}catch{return null;}
   if(!v||Object.keys(v).sort().join(',')!=='chat,createdAt,expected,options,witness'||!Number.isSafeInteger(v.createdAt)||now<v.createdAt||now>=c.expiresAt||c.expiresAt!==v.createdAt+TTL||!v.options||Object.keys(v.options).sort().join(',')!=='enabled,fallback,primary,seconds'||oncallPreviewWitness(s,this.policy,actor,v.chat,v.options,now)!==v.witness||!saveOncall(s,this.policy,actor,v.chat,v.expected,v.options,now))return null;
   c.used=true;return this.screen(s,actor,'تم اعتماد إعداد المناوبة للبلاغات الجديدة. يمكنك مراجعة البلاغات أو العودة لغرف الإدارة.',{inline_keyboard:[[{text:'📨 صندوق البلاغات',callback_data:'rp:1:r:0'}],[{text:'↩️ غرف الإدارة',callback_data:'al:1:h:0'}]]},now);
  });
 }
}
