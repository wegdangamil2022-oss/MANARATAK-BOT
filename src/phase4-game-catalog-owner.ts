import {Phase4GameCatalogService,type GameCatalogView}
 from './phase4-game-catalog.js';
import type {GameCatalogChange} from './phase4-game-catalog-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
const GROUP='-[1-9][0-9]{0,15}',REV='(?:0|[1-9][0-9]{0,8})';
const ACTION='(?:on|off|d1|d2|d3|d5|d10|qoff|q[0-9]{1,4}\\.[0-9]{1,4})';
const ROUTE=new RegExp('^gc:1:(?:h|g:'+GROUP+'|[pc]:'+GROUP+':'+REV+':'+ACTION+')$','u');
export const validGameCatalogOwnerRoute=(x:unknown):x is string=>
 typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&ROUTE.test(x);
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/'/gu,'&#39;').replace(/"/gu,'&quot;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const screen=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard});
const back=btn('↩️ قسم الألعاب','mi:1:s:08:0');
const home=btn('🎮 مكتبة الألعاب','gc:1:h');
export type GameCatalogOwnerCommand={kind:'HOME'|'VIEW';chatId?:string}|
 {kind:'PREVIEW';chatId:string;revision:number;action:string};
export function parseGameCatalogOwnerCommand(input:string):GameCatalogOwnerCommand|null{
 if(input==='/games'||input==='gc:1:h'||input==='mi:1:i:08:01')
  return {kind:'HOME'};
 if(typeof input!=='string'||input.length>100||/[\r\n]/u.test(input))return null;
 const one=/^\/games (-[1-9][0-9]{0,15})$/u.exec(input);
 if(one&&Number.isSafeInteger(Number(one[1])))return {kind:'VIEW',chatId:one[1]!};
 const view=new RegExp('^gc:1:g:('+GROUP+')$','u').exec(input);
 if(view&&Number.isSafeInteger(Number(view[1])))return {kind:'VIEW',chatId:view[1]!};
 const quiet=new RegExp('^\\/gamequiet ('+GROUP+') ([0-9]{1,2}):([0-9]{2})-([0-9]{1,2}):([0-9]{2})$','u').exec(input);
 if(quiet&&Number.isSafeInteger(Number(quiet[1]))){
  const a=Number(quiet[2])*60+Number(quiet[3]);
  const b=Number(quiet[4])*60+Number(quiet[5]);
  if(Number(quiet[2])<24&&Number(quiet[3])<60&&
   Number(quiet[4])<24&&Number(quiet[5])<60&&a!==b)
   return {kind:'PREVIEW',chatId:quiet[1]!,revision:-1,action:'q'+a+'.'+b};
 }
 return null;
}
const changes=(v:GameCatalogView,action:string):GameCatalogChange|null=>{
 const change:GameCatalogChange={quizEnabled:v.quizEnabled,dailyLimit:v.dailyLimit,
  ...(v.quietStartUtcMinute!==undefined?
   {quietStartUtcMinute:v.quietStartUtcMinute,
    quietEndUtcMinute:v.quietEndUtcMinute}: {})};
 if(action==='on')change.quizEnabled=true;
 else if(action==='off')change.quizEnabled=false;
 else if(/^d(?:1|2|3|5|10)$/u.test(action))change.dailyLimit=Number(action.slice(1));
 else if(action==='qoff'){
  delete change.quietStartUtcMinute;delete change.quietEndUtcMinute;
 }else{
  const t=/^q([0-9]{1,4})\.([0-9]{1,4})$/u.exec(action);
  if(!t||Number(t[1])>1439||Number(t[2])>1439||
   Number(t[1])===Number(t[2]))return null;
  change.quietStartUtcMinute=Number(t[1]);
  change.quietEndUtcMinute=Number(t[2]);
 }
 return change;
};
const format=(value:number):string=>
 String(Math.floor(value/60)).padStart(2,'0')+':'+
 String(value%60).padStart(2,'0');
async function listing(service:Phase4GameCatalogService,actor:string):
 Promise<OwnerInlineScreen|null>{
 const groups=await service.groups(actor);
 const rows=groups.map(g=>[btn('👥 '+g.chatId,'gc:1:g:'+g.chatId)]);
 rows.push([back]);
 return screen('<b>🎮 مكتبة الألعاب — 08:01</b>\n'+
  'اختر مجموعة معتمدة لتشغيل أو إيقاف الألعاب المدعومة وضبط الحدود.\n'+
  '🧠 أسئلة متعددة الخيارات: مبرمجة (08:03).\n'+
  'الألغاز، صح/خطأ، الأعلام، الكلمات والجولات المباشرة: قيد التطوير، لا يمكن تفعيلها من هنا.\n'+
  'السؤال لا يُنشر تلقائيًا في مجموعة Telegram؛ التغييرات تخضع لمراجعة مالك المجموعة.\n'+
  'المجموعات المخولة: '+groups.length,rows);
}
async function detail(service:Phase4GameCatalogService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const v=await service.view(actor,id);if(!v)return null;
 const a=(action:string)=>'gc:1:p:'+id+':'+v.revision+':'+action;
 const rows:{text:string;callback_data:string}[][]=[
  [btn(v.quizEnabled?'⛔ إيقاف الأسئلة':'✅ تشغيل الأسئلة',a(v.quizEnabled?'off':'on'))],
  [btn('1 جولة / يوم',a('d1')),btn('3 جولات / يوم',a('d3'))],
  [btn('5 جولات / يوم',a('d5')),btn('10 جولات / يوم',a('d10'))],
  [btn('🌙 هدوء 20:00–08:00 UTC',a('q1200.480'))],
  [btn('☀️ إلغاء فترة الهدوء',a('qoff'))],
  [home],[back]
 ];
 return screen('<b>🎮 مكتبة الألعاب — إعداد مجموعة</b>\n'+
  'المجموعة: <code>'+id+'</code>\n'+
  '🧠 الأسئلة: '+(v.quizEnabled?'✅ مفعلة':'⛔ موقوفة')+
  '\nسقف جولات الأسئلة المفتوحة يوميًا: '+v.dailyLimit+
  '\nفترة الهدوء UTC: '+(v.quietStartUtcMinute===undefined?
   'غير مضبوطة':format(v.quietStartUtcMinute)+' – '+format(v.quietEndUtcMinute!))+
  '\nالإصدار: '+v.revision+'؛ كل إجراء يحتاج معاينة ثم تأكيد صريح.\n'+
  'تعطيل الأسئلة يمنع فتح أسئلة جديدة أو استقبال إجابات لجولات سابقة.\n'+
  'الحد اليومي يتعلق بفتح الأسئلة، وليس بحقوق المشرف أو عقوبات المجموعة.\n'+
  v.games.map(x=>(x.available?'✅ ':'⌛ ')+esc(x.label)+(x.available?'':' — غير مبرمج')).join('\n')+
  '\nلتحديد فترة UTC مخصصة: <code>/gamequiet '+id+' 21:00-07:00</code>\n'+
  'هذه ساعات UTC يحددها المالك؛ لا ادعاء بكشف توقيت الطالب.',
  rows);
}
export async function gameCatalogOwnerScreen(service:Phase4GameCatalogService,
 actor:string,input:string):Promise<OwnerInlineScreen|null>{
 try{
  const cmd=parseGameCatalogOwnerCommand(input);
  if(cmd?.kind==='HOME')return listing(service,actor);
  if(cmd?.kind==='VIEW')return detail(service,actor,cmd.chatId!);
  let op:'p'|'c'='p',chatId='',rev=-1,action='';
  if(cmd?.kind==='PREVIEW'){
   chatId=cmd.chatId;action=cmd.action;
   const current=await service.view(actor,chatId);
   if(!current)return null;
   rev=current.revision;
  }else if(validGameCatalogOwnerRoute(input)){
   const match=new RegExp('^gc:1:([pc]):('+GROUP+'):('+REV+'):('+ACTION+')$','u').exec(input);
   if(!match)return null;
   op=match[1] as 'p'|'c';chatId=match[2]!;
   rev=Number(match[3]);action=match[4]!;
  }else return null;
  const current=await service.view(actor,chatId);
  if(!current||current.revision!==rev)return null;
  const next=changes(current,action);if(!next)return null;
  if(op==='p'){
   const confirm='gc:1:c:'+chatId+':'+rev+':'+action;
   if(!validGameCatalogOwnerRoute(confirm))return null;
   return screen('<b>⚠️ مراجعة إعدادات الألعاب</b>\n'+
    'المجموعة: <code>'+chatId+'</code>\n'+
    'تشغيل الأسئلة: '+(next.quizEnabled?'نعم':'لا')+'\n'+
    'سقف الجولات اليومي: '+next.dailyLimit+'\n'+
    'هدوء UTC: '+(next.quietStartUtcMinute===undefined?'غير مضبوط':
     format(next.quietStartUtcMinute)+' – '+format(next.quietEndUtcMinute!))+
    '\nالتعديل لا يمنح أي صلاحيات إضافية ولا ينشر رسائل تلقائيًا.\n'+
    'إذا تغير إصدار المجموعة أو السياسة فسيُرفض التأكيد القديم.',
    [[btn('✅ تأكيد الإعداد',confirm)],
     [btn('↩️ إلغاء','gc:1:g:'+chatId)]]);
  }
  const done=await service.update(actor,chatId,rev,next);
  return done?detail(service,actor,chatId):null;
 }catch{return null;}
}
