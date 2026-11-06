import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {Phase4CommunityService} from './phase4-community.js';
import type {CommunityConfig,CommunityDraftKind} from './phase4-community-model.js';

/** 09:16: owner-private, group-scoped settings over the existing reviewed config. */
const ID='-[1-9][0-9]{0,15}';
const ROUTE=new RegExp('^p4s:1:(?:h|p:[0-9]{1,3}|g:'+ID+
 '|v:'+ID+':[aplesm]|t:'+ID+':[0-9]{1,10}:[wfrpdscbjktgn]:[01])$','u');
export const validPhase4SettingsRoute=(v:unknown):v is string=>
 typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&ROUTE.test(v);
const safeId=(v:string)=>new RegExp('^'+ID+'$','u').test(v)&&Number.isSafeInteger(Number(v));
export type SettingsCommand={kind:'HOME'}|{kind:'GROUP';chatId:string};
export function parsePhase4SettingsCommand(v:string):SettingsCommand|null{
 if(v==='/communitysettings')return {kind:'HOME'};
 if(typeof v!=='string'||v.length>85)return null;
 const m=/^\/communitysettings (-[1-9][0-9]{0,15})$/u.exec(v);
 return m&&safeId(m[1]!)?{kind:'GROUP',chatId:m[1]!}:null;
}
type Btn={text:string;callback_data:string};
const b=(text:string,callback_data:string):Btn=>({text,callback_data});
const ui=(text:string,rows:Btn[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const home=b('👥 اختيار المجموعة','p4s:1:h');
const back=b('↩️ التفاعل والترحيب','mi:1:s:09:1');
const status=(x:boolean)=>x?'✅ مفعّل':'⛔ متوقف';
const fmt=(n:number)=>String(Math.floor(n/60)).padStart(2,'0')+':'+
 String(n%60).padStart(2,'0');
type Flag={code:string;name:string;panel:'a'|'p'|'s'|'e';
 on:CommunityDraftKind;off:CommunityDraftKind;get:(x:CommunityConfig)=>boolean};
const flags:Flag[]=[
 {code:'w',name:'الترحيب',panel:'a',on:'WELCOME_ON',off:'WELCOME_OFF',get:x=>x.welcome.enabled},
 {code:'f',name:'الوداع',panel:'a',on:'FAREWELL_ON',off:'FAREWELL_OFF',get:x=>x.farewell.enabled},
 {code:'r',name:'الردود التلقائية',panel:'a',on:'REPLIES_ON',off:'REPLIES_OFF',get:x=>x.repliesEnabled},
 {code:'p',name:'الترحيب الخاص باختيار الطالب',panel:'a',
  on:'PRIVATE_WELCOME_ON',off:'PRIVATE_WELCOME_OFF',get:x=>x.privateWelcomeEnabled===true},
 {code:'d',name:'سجل قرارات الردود',panel:'p',
  on:'DECISION_LOG_ON',off:'DECISION_LOG_OFF',get:x=>x.decisionLogEnabled===true},
 {code:'s',name:'تنظيف رسائل الخدمة',panel:'p',
  on:'SERVICE_CLEANUP_ON',off:'SERVICE_CLEANUP_OFF',get:x=>x.serviceCleanup?.enabled===true},
 {code:'b',name:'حذف الردود المؤقتة',panel:'p',
  on:'REPLY_CLEANUP_ON',off:'REPLY_CLEANUP_OFF',get:x=>x.replyCleanup?.enabled===true},
 {code:'c',name:'سجل تغييرات المجموعة',panel:'p',
  on:'CHANGE_LOG_ON',off:'CHANGE_LOG_OFF',get:x=>x.changeLogEnabled===true},
 {code:'j',name:'رسائل الانضمام (ضمن التنظيف)',panel:'s',
  on:'SERVICE_JOIN_ON',off:'SERVICE_JOIN_OFF',get:x=>x.serviceCleanup?.joinEnabled!==false},
 {code:'k',name:'رسائل المغادرة (ضمن التنظيف)',panel:'s',
  on:'SERVICE_LEAVE_ON',off:'SERVICE_LEAVE_OFF',get:x=>x.serviceCleanup?.leaveEnabled!==false},
 {code:'t',name:'رسائل تغيير الاسم والصورة (ضمن التنظيف)',panel:'s',
  on:'SERVICE_PROFILE_ON',off:'SERVICE_PROFILE_OFF',get:x=>x.serviceCleanup?.profileEnabled!==false},
 {code:'g',name:'السماح بتعديل اسم وصورة المجموعة',panel:'e',
  on:'GROUP_PROFILE_ON',off:'GROUP_PROFILE_OFF',get:x=>x.profileEditingEnabled===true},
 {code:'n',name:'رسالة وداع للعضو المحذوف',panel:'e',
  on:'FAREWELL_REMOVED_ON',off:'FAREWELL_REMOVED_OFF',get:x=>x.farewellOnRemoval===true}
];
const group=(x:string)=>'p4s:1:g:'+x;
const panelLink=(x:string,p:string)=>'p4s:1:v:'+x+':'+p;
function overview(c:CommunityConfig):OwnerInlineScreen{
 return ui('<b>⚙️ إعدادات القسم — 09:16</b>\n'+
  'المجموعة: <code>'+c.chatId+'</code>\nإصدار السياسة: '+c.version+'\n\n'+
  'الترحيب: '+status(c.welcome.enabled)+'\n'+
  'الوداع: '+status(c.farewell.enabled)+'\n'+
  'الردود: '+status(c.repliesEnabled)+'\n'+
  'الترحيب الخاص الاختياري: '+status(c.privateWelcomeEnabled===true)+'\n'+
  'اللغة: '+(c.language??'ar')+'\n'+
  'الحد الأعلى: '+(c.autoMessagesPerMinute??8)+' رسائل في الدقيقة\n'+
  'ساعات الهدوء: '+(c.quietHours?fmt(c.quietHours.startMinute)+'–'+fmt(c.quietHours.endMinute):'غير محددة')+'\n'+
  'سجل القرارات: '+status(c.decisionLogEnabled===true)+'\n'+
  'تنظيف رسائل الخدمة: '+status(c.serviceCleanup?.enabled===true)+'\n'+
  'تعديل الاسم والصورة: '+status(c.profileEditingEnabled===true)+'\n'+
  'وداع الأعضاء المحذوفين: '+status(c.farewellOnRemoval===true)+'\n\n'+
  'كل تعديل يمر بمعاينة وتأكيد مستقل. الفعاليات والنقاشات والاستطلاعات تُدار في أقسامها ولا تُفعّل عالميًا هنا.',
  [[b('👋 تشغيل الميزات',panelLink(c.chatId,'a'))],
   [b('🔒 الخصوصية والتنظيف',panelLink(c.chatId,'p'))],
   [b('🧹 أنواع رسائل الخدمة والاستثناءات',panelLink(c.chatId,'s'))],
   [b('🛡️ إشعارات المغادرة وصلاحيات التعديل',panelLink(c.chatId,'e'))],
   [b('🌍 اللغة والتوقيت والحدود',panelLink(c.chatId,'l'))],
   [b('🗂️ أقسام المرحلة الرابعة المستقلة',panelLink(c.chatId,'m'))],
   [b('📋 محرر الترحيب التفصيلي','p4c:1:g:'+c.chatId)],[home,back]]);
}
function panel(c:CommunityConfig,k:'a'|'p'|'l'|'s'|'e'|'m'):OwnerInlineScreen{
 const rows:Btn[][]=[];
 let body='';
 if(k==='m'){
  body='انتقال إلى محركات التفاعل المستقلة. الإعدادات التالية ليست مفاتيح تشغيل شاملة للمجموعة؛ كل محرك يدير موافقاته وسجلاته بنفسه. إذا لم يفعّل مسؤول النظام محركًا فستبقى صفحته غير متاحة.';
  rows.push(
   [b('💌 الهمسات','wh:1:h'),b('💬 النقاشات','dq:1:h')],
   [b('📊 الاستطلاعات','po:1:h'),b('🗓️ الفعاليات','ev:1:h')],
   [b('🎤 جلسات الخبير','xa:1:h'),b('👥 زملاء الدراسة','sp:1:h')],
   [b('🏅 الشارات','bg:1:h'),b('❤️ التفاعلات','rc:1:h')],
   [b('🌙 المحاضرة','lc:1:h'),b('📈 التقارير','er:1:h')]
  );
 }else if(k!=='l'){
  body=k==='a'?'الميزات الأساسية (كل واحدة مستقلة):':
   k==='p'?'خيارات الخصوصية والتنظيف الاختيارية:':
   k==='s'?'السماح بتنظيف أنواع رسائل الخدمة:':
   'استثناءات حساسة واختيارات المالك:';
  if(k==='s')body+='\n⚠️ هذه السماحات لا تحذف أي رسالة إذا كان تنظيف رسائل الخدمة العام متوقفًا. حالة النوع غير المحدد محفوظة من الإصدارات القديمة وتعني السماح به عند تفعيل التنظيف.';
  if(k==='e')body+='\n⚠️ تعديل المجموعة لا يمنح البوت صلاحيات Telegram جديدة؛ يتطلب كل تغيير فعلي مراجعة خاصة. رسائل وداع الأعضاء المحذوفين تتطلب تشغيل الوداع العام.';
  for(const f of flags.filter(f=>f.panel===k)){
   const on=f.get(c);
   body+='\n• '+f.name+': '+status(on);
   rows.push([b((on?'⛔ إيقاف ':'✅ تفعيل ')+f.name,
    'p4s:1:t:'+c.chatId+':'+c.version+':'+f.code+':'+(on?'1':'0'))]);
  }
  if(k==='p')rows.push([b('🧹 أنواع رسائل الخدمة','p4c:1:s:'+c.chatId)],
   [b('🕘 تغييرات الاسم والصورة','p4c:1:h:'+c.chatId)]);
 }else{
  body='اللغة: '+(c.language??'ar')+'\nالساعة: '+(c.clockFormat??'24')+
   '\nالتقويم: '+(c.calendar??'gregorian')+
   '\nالمنطقة الزمنية: '+(c.timeZone??'إزاحة UTC احتياطية')+
   '\nالفاصل العام: '+Math.floor(c.groupCooldownMs/1000)+' ثانية'+
   '\nالحد الآلي: '+(c.autoMessagesPerMinute??8)+'/دقيقة'+
   '\nساعات الهدوء: '+(c.quietHours?fmt(c.quietHours.startMinute)+'–'+fmt(c.quietHours.endMinute):'غير محددة')+
   '\nحدود موضوعات Forum: '+(c.topicCooldowns?.length??0);
  rows.push([b('🌐 تغيير اللغة','p4c:1:u:'+c.chatId+':'+((c.language??'ar')==='ar'?'en':'ar'))],
   [b('🕒 تغيير الساعة','p4c:1:o:'+c.chatId+':'+((c.clockFormat??'24')==='24'?'12':'24')+
    ':'+((c.calendar??'gregorian')==='hijri'?'h':'g'))],
   [b('📅 تغيير التقويم','p4c:1:o:'+c.chatId+':'+(c.clockFormat??'24')+
    ':'+((c.calendar??'gregorian')==='hijri'?'g':'h'))],
   [b('🌍 المنطقة الزمنية','p4c:1:n:'+c.chatId)],
   [b('🚦 سقف الرسائل الآلية','p4c:1:i:'+c.chatId)],
   [b('🌙 ساعات الهدوء','p4c:1:q:'+c.chatId)],
   [b('🧵 حدود موضوعات Forum','p4c:1:y:'+c.chatId)]);
 }
 rows.push([b('↩️ إعدادات المجموعة',group(c.chatId))],[home,back]);
 return ui('<b>⚙️ إعدادات القسم — 09:16</b>\nالمجموعة: <code>'+c.chatId+
  '</code>\nإصدار السياسة: '+c.version+'\n\n'+body+
  '\n\nلا يُطبّق أي تغيير دون مراجعة واعتماد مستقل.',rows);
}
async function groups(service:Phase4CommunityService,actor:string,p:number):
 Promise<OwnerInlineScreen|null>{
 const all=(await service.listGroups(actor)).filter(x=>safeId(x.chatId));
 const pages=Math.max(1,Math.ceil(all.length/8));
 if(!Number.isSafeInteger(p)||p<0||p>=pages)return null;
 const rows:Btn[][]=all.slice(p*8,p*8+8).map(x=>[
  b('⚙️ '+x.chatId+(x.configured?' • مهيأة':' • افتراضية'),group(x.chatId))]);
 const nav:Btn[]=[];
 if(p>0)nav.push(b('⬅️ السابق','p4s:1:p:'+(p-1)));
 if(p+1<pages)nav.push(b('التالي ➡️','p4s:1:p:'+(p+1)));
 if(nav.length)rows.push(nav);
 rows.push([back,b('🏠 لوحة المالك','mi:1:h')]);
 return ui('<b>⚙️ إعدادات القسم — 09:16</b>\n'+
  'اختر مجموعة معتمدة، ثم حدد فئة الإعدادات.\n'+
  'الصفحة '+(p+1)+' من '+pages+' — العدد '+all.length+
  '\nأمر مباشر: <code>/communitysettings -1001234</code>',rows);
}
export async function phase4SettingsOwnerScreen(
 service:Phase4CommunityService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  const cmd=parsePhase4SettingsCommand(input);
  if(input==='mi:1:i:09:16'||input==='p4s:1:h'||cmd?.kind==='HOME')
   return groups(service,actor,0);
  if(cmd?.kind==='GROUP')return overview(await service.view(actor,cmd.chatId));
  if(!validPhase4SettingsRoute(input))return null;
  const page=/^p4s:1:p:([0-9]{1,3})$/u.exec(input);
  if(page)return groups(service,actor,Number(page[1]));
  const g=/^p4s:1:g:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(g&&safeId(g[1]!))return overview(await service.view(actor,g[1]!));
  const v=/^p4s:1:v:(-[1-9][0-9]{0,15}):([aplesm])$/u.exec(input);
  if(v&&safeId(v[1]!))return panel(await service.view(actor,v[1]!),v[2]! as 'a'|'p'|'l'|'s'|'e'|'m');
  const t=/^p4s:1:t:(-[1-9][0-9]{0,15}):([0-9]{1,10}):([wfrpdscbjktgn]):([01])$/u.exec(input);
  if(!t||!safeId(t[1]!))return null;
  const c=await service.view(actor,t[1]!);
  if(String(c.version)!==t[2])return null;
  const f=flags.find(x=>x.code===t[3]);
  if(!f||Number(f.get(c))!==Number(t[4]))return null;
  const draft=await service.pending(actor,{kind:f.get(c)?f.off:f.on},c.chatId);
  return ui('<b>⚙️ معاينة تغيير الإعداد</b>\nالمجموعة: <code>'+c.chatId+
   '</code>\nالخاصية: '+f.name+'\n\n'+service.preview(draft)+
   '\n\nلن يُنفذ التعديل قبل اعتماد المالك. المهلة دقيقتان.',
   [[b('✅ اعتماد','p4c:1:c:'+draft.id)],
    [b('❌ إلغاء','p4c:1:x:'+draft.id)],
    [b('↩️ رجوع',panelLink(c.chatId,f.panel))]]);
 }catch{return null;}
}
