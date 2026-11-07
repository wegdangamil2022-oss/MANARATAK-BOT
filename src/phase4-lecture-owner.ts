import {Phase4LectureService} from './phase4-lectures.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const ID='[a-f0-9]{24}';
const ROUTE=new RegExp('^lc:1:(?:h|v:'+ID+'|[aks]:'+ID+':[123])$','u');
export const validLectureOwnerRoute=(v:unknown):v is string=>
 typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&ROUTE.test(v);
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const home=btn('🌙 أوضاع المحاضرات','lc:1:h');
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:1');
export type LectureOwnerCommand={kind:'LIST'}|{kind:'DRAFT';chatId:string;minutes:number};
export function parseLectureOwnerCommand(v:string):LectureOwnerCommand|null{
 if(v==='/lectures')return {kind:'LIST'};
 if(typeof v!=='string'||v.length>85||/[\r\n]/u.test(v))return null;
 const m=/^\/lecturenew (-[1-9][0-9]{0,15}) ([0-9]{2,3})$/u.exec(v);
 if(!m||!Number.isSafeInteger(Number(m[1]))||
  Number(m[2])<15||Number(m[2])>240)return null;
 return {kind:'DRAFT',chatId:m[1]!,minutes:Number(m[2])};
}
async function detail(service:Phase4LectureService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const mode=await service.view(actor,id);if(!mode)return null;
 const rows:{text:string;callback_data:string}[][]=[];
 if(mode.status==='DRAFT')rows.push([btn('✅ بدء المحاضرة المؤقتة','lc:1:a:'+id+':1')]);
 if(mode.status==='ACTIVE')rows.push([btn('⚠️ مراجعة الإنهاء المبكر','lc:1:k:'+id+':2')]);
 rows.push([home],[back]);
 return ui('<b>🌙 وضع المحاضرة — 09:14</b>\n'+
  'المجموعة: <code>'+mode.chatId+'</code>\n'+
  'الحالة: '+(mode.status==='ACTIVE'?'مفعّل مؤقتًا':mode.status==='DRAFT'?'بانتظار موافقة المالك':'منتهي')+'\n'+
  'المدة: '+mode.durationMinutes+' دقيقة\n'+
  (mode.startedAt!==undefined?
   'بدأ UTC: '+new Date(mode.startedAt).toISOString()+'\n':'')+
  (mode.endsAt!==undefined?
   'الانتهاء الآلي UTC: '+new Date(mode.endsAt).toISOString()+'\n':'')+
  'معرّف الوضع: <code>'+mode.id+'</code>\n'+
  'أثناء التفعيل: تُكتم فقط رسائل الترحيب والوداع والردود التلقائية الاختيارية عبر بوابة منارتك.\n'+
  'التحقق من العضوية والحماية والعقوبات وقواعد المجموعة وطلبات الطلاب الخاصة لا تتغير.\n'+
  'لا نعدّل الإعدادات السابقة أو نخزن نسخة قابلة للاستعادة؛ بانتهاء الفترة تعود القواعد الحالية تلقائيًا.\n'+
  '⚠️ لا يغيّر هذا الإعداد صلاحيات Telegram أو يمنع رسائل المستخدمين مباشرة.',
  rows);
}
async function listing(service:Phase4LectureService,actor:string):
 Promise<OwnerInlineScreen|null>{
 const all=await service.list(actor);
 const rows=all.slice(0,12).map(x=>[btn(
  (x.status==='ACTIVE'?'🌙 ':x.status==='DRAFT'?'📝 ':'✅ ')+
  x.chatId+' · '+x.durationMinutes+' دقيقة',
  'lc:1:v:'+x.id)]);
 rows.push([back]);
 return ui('<b>🌙 وضع المحاضرة — 09:14</b>\n'+
  'تفعيل مؤقت حسب المجموعة (بموافقة المالك من خاص البوت):\n'+
  '<code>/lecturenew -1001234 60</code>\n'+
  'المدة المسموحة 15–240 دقيقة؛ تنتهي معاينة المسودة خلال 15 دقيقة.\n'+
  'القسم لا يغيّر سياسة المجموعة الأصلية أو الحماية، ويمنع إرسال الأتمتة غير الضرورية أثناء المحاضرة، حتى إن كانت بالانتظار.\n'+
  'التفعيل والإيقاف لا يستدعيان API لحظر الأعضاء أو تعديل حقوق Telegram.\n'+
  'الوضع غير مسؤول عن تعطيل ألعاب أو أنظمة خارج مسارات أتمتة منارتك المرتبطة به.\n'+
  'السجلات المتاحة للمالك: '+all.length,rows);
}
export async function lectureOwnerScreen(
 service:Phase4LectureService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const cmd=parseLectureOwnerCommand(input);
  if(cmd?.kind==='DRAFT'){
   const s=await service.draft(actor,cmd.chatId,cmd.minutes);
   return detail(service,actor,s.id);
  }
  if(cmd?.kind==='LIST'||input==='mi:1:i:09:14'||input==='lc:1:h')
   return listing(service,actor);
  if(!validLectureOwnerRoute(input))return null;
  const view=/^lc:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const open=/^lc:1:a:([a-f0-9]{24}):([123])$/u.exec(input);
  if(open){
   if(!await service.start(actor,open[1]!,Number(open[2])))return null;
   return detail(service,actor,open[1]!);
  }
  const preview=/^lc:1:k:([a-f0-9]{24}):([123])$/u.exec(input);
  if(preview){
   const s=await service.view(actor,preview[1]!);
   if(!s||s.status!=='ACTIVE'||s.revision!==Number(preview[2]))return null;
   return ui('<b>⚠️ تأكيد إيقاف وضع المحاضرة</b>\n'+
    'المجموعة: <code>'+s.chatId+'</code>\n'+
    'ستنتهي فترة إسكات الردود غير الضرورية. لن تتغير سياسات الحماية أو الاشتراكات، ولن يُعاد تفعيل قاعدة أوقفها المالك أصلًا.',
    [[btn('✅ تأكيد الإيقاف','lc:1:s:'+s.id+':'+s.revision)],
     [btn('↩️ إلغاء','lc:1:v:'+s.id)]]);
  }
  const stop=/^lc:1:s:([a-f0-9]{24}):([123])$/u.exec(input);
  if(stop){
   if(!await service.stop(actor,stop[1]!,Number(stop[2])))return null;
   return detail(service,actor,stop[1]!);
  }
  return null;
 }catch{return null;}
}
