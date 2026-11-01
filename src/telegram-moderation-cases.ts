import {createHash} from 'node:crypto';
import type {BotState,BotStore,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {ModerationService} from './moderation.js';
import {ModerationCommandReview,type ModerationCommandScreen} from './telegram-moderation-command-review.js';
import {protectionUIEpoch} from './protection-ui-access.js';
import type {ReplyModerationCommand} from './telegram-moderation-commands.js';

const n='(0|[1-9][0-9]{0,2})',slot='([1-8])',digest='([a-f0-9]{16})';
const home=new RegExp('^cs:1:h:([bw]):'+n+'$','u');
const selection=new RegExp('^cs:1:([glda]):([bw]):'+n+':'+slot+':'+digest+'(?::'+n+')?(?::'+slot+')?$','u');
export function validModerationCaseRoute(data:string):boolean{
 if(home.exec(data)?.[0]===data)return true;
 const m=selection.exec(data);return m?.[0]===data&&(m[1]==='g'?m[6]===undefined:m[1]==='l'?m[6]!==undefined&&m[7]===undefined:m[6]!==undefined&&m[7]!==undefined);
}
type Mode='b'|'w';
type Case={member:string;reference:string;kind:'BAN'|'MUTE'|'WARNING'|'SUBSCRIPTION'|'KICK';active:boolean;expiresAt?:number;result?:string};
const b=(text:string,callback_data:string)=>({text,callback_data});
const escape=(s:string)=>s.replace(/\p{Cf}/gu,'').replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;');
function cases(s:BotState,chat:string,mode:Mode):Case[]{
 const rows:Case[]=mode==='w'?s.warnings.filter(w=>w.chatId===chat).map(w=>({member:w.memberId,reference:w.reference,kind:'WARNING',active:w.active})):
  s.moderationReasons.filter(r=>r.chatId===chat).map(r=>({member:r.memberId,reference:r.reference,kind:r.source==='SUBSCRIPTION'?'SUBSCRIPTION':r.kind,active:r.active,...(r.expiresAt===undefined?{}:{expiresAt:r.expiresAt})}));
 if(mode==='b')for(const o of s.moderationOperations.filter(o=>o.chatId===chat&&o.action==='KICK'&&typeof o.caseReference==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.exec(o.caseReference)?.[0]===o.caseReference))rows.push({member:o.memberId,reference:o.caseReference!,kind:'KICK',active:false,result:String(o.status).slice(0,32)+' · '+(o.attemptGateway==='SIMULATION'?'محاكاة':o.attemptGateway==='TELEGRAM_API'?'محول Telegram':'مصدر غير مؤكد')});
 return rows.sort((a,b)=>Number(b.active)-Number(a.active)||a.member.localeCompare(b.member)||a.reference.localeCompare(b.reference)||a.kind.localeCompare(b.kind));
}
export class TelegramModerationCases{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly service:ModerationService|undefined,private readonly clock:()=>number){}
 private groups(s:BotState,actor:string):Chat[]{return s.chats.filter(c=>/^-[1-9][0-9]{0,15}$/u.exec(c.id)?.[0]===c.id&&Number.isSafeInteger(Number(c.id))&&s.chats.filter(x=>x.id===c.id).length===1&&this.policy.canUseChat(s,c.id,'moderation')&&this.policy.has(s,actor,'chat.manage',c.id,this.clock())).sort((a,b)=>a.id.localeCompare(b.id));}
 private digest(s:BotState,actor:string,c:Chat,mode:Mode):string{return createHash('sha256').update(JSON.stringify([actor,c,mode,cases(s,c.id,mode),s.grants,s.privateFeatures,s.privateSettingsRevision,s.moderationOperations])).digest('hex').slice(0,16);}
 private screen(s:BotState,actor:string,text:string,rows:{text:string;callback_data:string}[][]):ModerationCommandScreen|null{
  const now=this.clock(),epoch=protectionUIEpoch(s,this.policy,actor,now);return epoch?{text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch,expiresAt:now+120000},status:'APPLIED',reason:'MODERATION_CASE_VIEW'}:null;
 }
 async handle(actor:string,data:string):Promise<ModerationCommandScreen|null>{
  if(data==='mi:1:i:02:02'||data==='mi:1:i:02:03'){
   if(!this.policy.isOwner(actor))return null;data=data.endsWith(':03')?'cs:1:h:w:0':'cs:1:h:b:0';
  }
  if(!validModerationCaseRoute(data))return null;
  const s=await this.store.snapshot(),all=this.groups(s,actor),root=home.exec(data);
  if(root){
   const mode=root[1] as Mode,page=Number(root[2]),pages=Math.max(1,Math.ceil(all.length/8));if(page>=pages)return null;
   const rows=all.slice(page*8,page*8+8).map((c,i)=>[b('👥 '+c.id,'cs:1:g:'+mode+':'+page+':'+(i+1)+':'+this.digest(s,actor,c,mode))]);
   const nav=[];if(page>0)nav.push(b('⬅️ السابق','cs:1:h:'+mode+':'+(page-1)));if(page+1<pages)nav.push(b('➡️ التالي','cs:1:h:'+mode+':'+(page+1)));if(nav.length)rows.push(nav);
   rows.push([b('📨 بلاغات الأعضاء','rp:1:r:0')]);
   if(mode==='w')rows.push([b('📨 مراجعة الاعتراضات','ap:1:r:0')]);
   rows.push([b('↩️ '+(this.policy.isOwner(actor)?'قسم الحماية':'الرئيسية'),this.policy.isOwner(actor)?'mi:1:s:02:0':'pn:1:h')]);
   return this.screen(s,actor,'<b>'+(mode==='w'?'التحذيرات المسجلة':'العقوبات والأعضاء')+'</b>\nاختر المجموعة المخولة · صفحة '+(page+1)+' من '+pages+'\n'+(!this.service?'منفذ الإشراف غير موصول؛ العرض فقط.':'كل إلغاء يبدأ بمعاينة وتأكيد خاصين.'),rows);
  }
  const m=selection.exec(data)!,kind=m[1]!,mode=m[2] as Mode,page=Number(m[3]),groupSlot=Number(m[4]),c=all[page*8+groupSlot-1];
  if(!c||this.digest(s,actor,c,mode)!==m[5])return null;
  const stem=mode+':'+page+':'+groupSlot+':'+m[5],entries=cases(s,c.id,mode),casePage=Number(m[6]??0),pages=Math.max(1,Math.ceil(entries.length/8));if(casePage>=pages)return null;
  if(kind==='g'||kind==='l'){
   const rows=entries.slice(casePage*8,casePage*8+8).map((e,i)=>[b((e.active?'🟠 ':'⚪ ')+e.member+' · '+(e.kind==='KICK'?'طرد':e.kind==='WARNING'?'تحذير':e.kind==='SUBSCRIPTION'?'اشتراك':e.kind==='BAN'?'حظر':'كتم'),'cs:1:d:'+stem+':'+casePage+':'+(i+1))]);
   const nav=[];if(casePage>0)nav.push(b('⬅️ السابق','cs:1:l:'+stem+':'+(casePage-1)));if(casePage+1<pages)nav.push(b('➡️ التالي','cs:1:l:'+stem+':'+(casePage+1)));if(nav.length)rows.push(nav);rows.push([b('↩️ المجموعات','cs:1:h:'+mode+':'+page)]);
   return this.screen(s,actor,'<b>المجموعة '+c.id+'</b>\n'+entries.length+' حالة مسجلة · صفحة '+(casePage+1)+' من '+pages+'\nلبدء إجراء جديد، رد داخل المجموعة على رسالة العضو:\n<code>/'+(mode==='w'?'warn case-id':'ban case-id 1h')+'</code>\n'+(mode==='w'?'إلغاء التحذير: /unwarn case-id.':'الكتم: /mute case-id 10m؛ إزالة السبب: /unban أو /unmute case-id؛ حذف الرسالة: /delete بالرد.')+'\nالحالات المحلية لا تثبت حالة Telegram الحالية، والطرد: /kick case-id بالرد؛ استعادة قيد قائم تحتاج قرار المالك ومصدرًا مطابقًا من المحول الرسمي.',rows);
  }
  const e=entries[casePage*8+Number(m[7])-1];if(!e)return null;
  const removable=e.active&&e.kind!=='SUBSCRIPTION'&&e.kind!=='KICK'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.exec(e.reference)?.[0]===e.reference;
  if(kind==='a'){
   if(!removable||!this.service)return null;
   const command:ReplyModerationCommand={memberId:e.member,reference:e.reference,kind:e.kind==='WARNING'?'unwarn':e.kind==='BAN'?'unban':'unmute'};
   return new ModerationCommandReview(this.store,this.policy,this.service,this.clock).preview(actor,c.id,command);
  }
  const count=s.warnings.filter(w=>w.chatId===c.id&&w.memberId===e.member&&w.active).length;
  const rows=[];if(removable&&this.service)rows.push([b('🔍 مراجعة الإلغاء','cs:1:a:'+stem+':'+casePage+':'+m[7])]);rows.push([b('↩️ الحالات','cs:1:l:'+stem+':'+casePage)]);
  return this.screen(s,actor,'<b>تفاصيل الحالة</b>\nالمجموعة: <code>'+c.id+'</code>\nالعضو: <code>'+escape(e.member)+'</code>\nالنوع: '+(e.kind==='KICK'?'طرد':e.kind==='WARNING'?'تحذير':e.kind==='SUBSCRIPTION'?'اشتراك':e.kind==='BAN'?'حظر':'كتم')+'\nالمرجع: <code>'+escape(e.reference)+'</code>\nالحالة: '+(e.kind==='KICK'?escape(e.result??'غير مؤكد'):e.active?'نشطة محليًا':'ملغاة محليًا')+'\nتحذيرات العضو النشطة: '+count+(e.expiresAt===undefined?'':'\nموعد انتهاء السبب: '+new Date(e.expiresAt).toISOString())+'\n'+(e.kind==='KICK'?'سجل طرد لمرة واحدة؛ لا سبب تقييد دائمًا ولا زر استعادة تلقائي.':e.kind==='SUBSCRIPTION'?'سبب اشتراك مستقل؛ لا يلغى من العقوبات اليدوية.':'الإلغاء يزيل السبب المحدد وحده، ويحافظ على الأسباب المستقلة. لا نجاح قبل نتيجة الخدمة الحالية.')+'\nلصاحب الحالة: /appeals في الخاص. المراجعة الخاصة متاحة من قائمة التحذيرات؛ قبولها لا يرفع عقوبة تلقائيًا.',rows);
 }
}
