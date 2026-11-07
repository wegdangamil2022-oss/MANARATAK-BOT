import {Phase4ReactionsService} from './phase4-reactions.js';
import {validReactionInput,type ReactionKind} from './phase4-reaction-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
const HEX='[a-f0-9]{24}';
const ROUTE=new RegExp('^rc:1:(?:h|p:[0-4]|[vr]:'+HEX+'|[okc]:'+HEX+':[123])$','u');
export const validReactionOwnerRoute=(x:unknown):x is string=>
 typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&ROUTE.test(x);
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/'/gu,'&#39;').replace(/"/gu,'&quot;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const home=btn('❤️ قائمة المنشورات','rc:1:h');
const back=btn('↩️ قسم التفاعل','mi:1:s:09:1');
const names={BOT_POST:'منشور البوت (تصنيف المالك)',COMMUNITY_QUESTION:'سؤال مجتمع',
 STUDY_EXPERIENCE:'تجربة دراسية'};
export type ReactionOwnerCommand={kind:'LIST'}|{kind:'CREATE';chatId:string;
 input:{kind:ReactionKind;messageId:number;description:string;durationMinutes:number}};
export function parseReactionOwnerCommand(input:string):ReactionOwnerCommand|null{
 if(input==='/reactions')return {kind:'LIST'};
 if(typeof input!=='string'||input.length>350||/[\r\n]/u.test(input))return null;
 const m=/^\/reactnew (-[1-9][0-9]{0,15}) ([1-9][0-9]{0,9}) ([0-9]{2,4}) (BOT_POST|COMMUNITY_QUESTION|STUDY_EXPERIENCE) \| (.{8,120})$/u.exec(input);
 if(!m||!Number.isSafeInteger(Number(m[1])))return null;
 const fields={kind:m[4]! as ReactionKind,messageId:Number(m[2]),
  description:m[5]!,durationMinutes:Number(m[3])};
 if(!validReactionInput(fields))return null;
 return {kind:'CREATE',chatId:m[1]!,input:fields};
}
async function detail(service:Phase4ReactionsService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const target=await service.view(actor,id);if(!target)return null;
 const count=await service.ownerCount(actor,id);
 const actions:{text:string;callback_data:string}[][]=[];
 if(target.status==='DRAFT')actions.push([btn('✅ تأكيد فتح الإعجابات','rc:1:o:'+id+':1')]);
 if(target.status==='OPEN')actions.push([btn('🔒 مراجعة إغلاق التفاعل','rc:1:k:'+id+':2')]);
 if(target.status==='CLOSED')actions.push([btn('📊 نتيجة إجمالية إن كانت كافية','rc:1:r:'+id)]);
 actions.push([home],[back]);
 return ui('<b>❤️ تفاعل المنشورات — 09:13</b>\n'+
  'المجموعة: <code>'+target.chatId+'</code>\n'+
  'رقم رسالة Telegram الذي أدخله المالك: '+target.messageId+'\n'+
  'نوع المحتوى: '+names[target.kind]+'\n'+
  'الوصف: '+esc(target.description)+'\n'+
  'التحقق من المصدر: غير مثبت آليًا، أدرجه المالك يدويًا.\n'+
  'الحالة: '+target.status+'\n'+
  'النهاية UTC: '+new Date(target.expiresAt).toISOString()+'\n'+
  'معرّف التفاعل: <code>'+id+'</code>\n'+
  (count!==null&&count>=5?'إشارات الإعجاب النشطة للمالك فقط: '+count+'\n':
   'إحصاء الإعجابات: محجوب حتى الحد الأدنى للخصوصية (5 حسابات).\n')+
  'للتفاعل يدويًا من خاص الطالب: <code>/reactlike '+id+'</code>\n'+
  '⚠️ التسجيل محلي؛ لا يضغط زر إعجاب Telegram الأصلي ولا يفتح تصويت جوائز أو مسابقات.',
  actions);
}
async function listing(service:Phase4ReactionsService,actor:string,page:number):
 Promise<OwnerInlineScreen|null>{
 const all=await service.list(actor),pages=Math.max(1,Math.ceil(all.length/10));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows=all.slice(page*10,page*10+10).map(x=>[btn(
  (x.status==='DRAFT'?'📝 ':x.status==='OPEN'?'❤️ ':'🔒 ')+
   x.description.slice(0,28),'rc:1:v:'+x.id)]);
 if(pages>1){
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(btn('⬅️ السابق','rc:1:p:'+(page-1)));
  if(page+1<pages)nav.push(btn('التالي ➡️','rc:1:p:'+(page+1)));
  if(nav.length)rows.push(nav);
 }
 rows.push([back]);
 return ui('<b>❤️ تفاعل المنشورات — 09:13</b>\n'+
  'أدرج رسالة تعليمية موجودة بعد مراجعتها يدويًا:\n'+
  '<code>/reactnew -1001234 42 60 BOT_POST | إعلان مصادر القبول الجامعي</code>\n'+
  'البيانات: المجموعة، رقم الرسالة، المدة بالدقائق (10–1440)، النوع، وصف المحتوى.\n'+
  'الأنواع: BOT_POST منشور بوت بحسب المالك، COMMUNITY_QUESTION سؤال مجتمع، STUDY_EXPERIENCE تجربة دراسية.\n'+
  'الإنشاء محلي فقط. لا يستطيع البوت بهذا المسار إثبات أن الرسالة أصلًا منشورة أو من مؤلف معين.\n'+
  'يُفتح الإعجاب بعد مراجعة المالك؛ لا تظهر أسماء الطلاب ولا يتكرر إعجاب الحساب.\n'+
  'ليست هذه الأصوات جزءًا من مسابقات أو منح أو جوائز.\n'+
  'صفحة '+(page+1)+' من '+pages+' · عدد المنشورات '+all.length,
  rows);
}
async function result(service:Phase4ReactionsService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const target=await service.view(actor,id);
 if(!target||target.status!=='CLOSED')return null;
 const aggregate=await service.results(actor,id);
 return ui('<b>📊 خلاصة إعجابات محلية</b>\n'+esc(target.description)+'\n'+
  (aggregate?'الحسابات التي أبقت الإعجاب نشطًا: '+aggregate.likes:
   '🔒 النتيجة الإجمالية محجوبة: لم تصل إلى خمسة إعجابات أو انتهت صلاحية الاحتفاظ.')+
  '\nلا أسماء أو حسابات فردية. هذا ليس عدد مشاهدات Telegram أو أصوات مسابقات.',
  [[btn('↩️ تفاصيل المنشور','rc:1:v:'+id)],[home]]);
}
export async function reactionOwnerScreen(
 service:Phase4ReactionsService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const parsed=parseReactionOwnerCommand(input);
  if(parsed?.kind==='CREATE'){
   const t=await service.draft(actor,parsed.chatId,parsed.input);
   return detail(service,actor,t.id);
  }
  if(parsed?.kind==='LIST'||input==='mi:1:i:09:13'||input==='rc:1:h')
   return listing(service,actor,0);
  if(!validReactionOwnerRoute(input))return null;
  const page=/^rc:1:p:([0-4])$/u.exec(input);
  if(page)return listing(service,actor,Number(page[1]));
  const view=/^rc:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const stats=/^rc:1:r:([a-f0-9]{24})$/u.exec(input);
  if(stats)return result(service,actor,stats[1]!);
  const open=/^rc:1:o:([a-f0-9]{24}):([123])$/u.exec(input);
  if(open){
   if(!await service.open(actor,open[1]!,Number(open[2])))return null;
   return detail(service,actor,open[1]!);
  }
  const review=/^rc:1:k:([a-f0-9]{24}):([123])$/u.exec(input);
  if(review){
   const t=await service.view(actor,review[1]!);
   if(!t||t.status!=='OPEN'||t.revision!==Number(review[2]))return null;
   return ui('<b>⚠️ تأكيد إغلاق إعجابات المنشور</b>\n'+
    esc(t.description)+'\n'+'الإغلاق يمنع أصواتًا جديدة. تُحذف معرّفات المشاركين بعد مهلة الخصوصية، ولا يوجد تراجع.',
    [[btn('🔒 نعم، أغلق التفاعل','rc:1:c:'+t.id+':'+t.revision)],
     [btn('↩️ إلغاء','rc:1:v:'+t.id)]]);
  }
  const close=/^rc:1:c:([a-f0-9]{24}):([123])$/u.exec(input);
  if(close){
   if(!await service.close(actor,close[1]!,Number(close[2])))return null;
   return detail(service,actor,close[1]!);
  }
  return null;
 }catch{return null;}
}
