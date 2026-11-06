import {Phase4StudyPeersService} from './phase4-study-peers.js';
import type {StudyLevel} from './phase4-study-peer-model.js';
import {validStudyInput} from './phase4-study-peer-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
const ID='[a-f0-9]{24}';
const ROUTE=new RegExp('^sp:1:(?:h|p:[0-4]|v:'+ID+'|[okc]:'+ID+':[12])$','u');
export const validStudyPeerOwnerRoute=(x:unknown):x is string=>
 typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&ROUTE.test(x);
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:1');
const home=btn('👥 جميع دوائر المذاكرة','sp:1:h');
export type StudyPeerOwnerCommand={kind:'LIST'}|{kind:'CREATE';chatId:string;input:{
 topic:string;level:StudyLevel;startsAt:number;durationMinutes:number;capacity:number;
}};
export function parseStudyPeerOwnerCommand(v:string):StudyPeerOwnerCommand|null{
 if(v==='/studies')return {kind:'LIST'};
 if(typeof v!=='string'||v.length>250||/[\r\n]/u.test(v))return null;
 const m=/^\/studynew (-[1-9][0-9]{0,15}) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) ([0-9]{2,3}) ([0-9]{1,2}) (BEGINNER|INTERMEDIATE|ADVANCED) \| (.{5,80})$/u.exec(v);
 if(!m||!Number.isSafeInteger(Number(m[1])))return null;
 const startsAt=Date.parse(m[2]!);
 if(!Number.isSafeInteger(startsAt)||new Date(startsAt).toISOString()!==m[2])return null;
 const input={topic:m[6]!,level:m[5]! as StudyLevel,startsAt,
  durationMinutes:Number(m[3]),capacity:Number(m[4])};
 if(!validStudyInput(input))return null;
 return {kind:'CREATE',chatId:m[1]!,input};
}
async function detail(service:Phase4StudyPeersService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const circle=await service.ownerView(actor,id);if(!circle)return null;
 const joined=await service.ownerCounts(actor,id);
 const flags=await service.ownerReports(actor,id);
 const rows:{text:string;callback_data:string}[][]=[];
 if(circle.status==='DRAFT')rows.push([btn('✅ فتح باب الانضمام بعد المراجعة','sp:1:o:'+id+':1')]);
 if(circle.status==='OPEN')rows.push([btn('⚠️ مراجعة إلغاء الدائرة','sp:1:k:'+id+':2')]);
 rows.push([home],[back]);
 return ui('<b>👥 زملاء الدراسة — دوائر جماعية 09:11</b>\n'+
  'المجموعة: <code>'+circle.chatId+'</code>\n'+
  'المادة: '+esc(circle.topic)+'\n'+
  'المستوى: '+circle.level+'\n'+
  'البداية UTC: '+new Date(circle.startsAt).toISOString()+'\n'+
  'النهاية UTC: '+new Date(circle.endsAt).toISOString()+'\n'+
  'السعة: '+circle.capacity+' | أماكن مسجلة محليًا: '+joined+'\n'+
  'الحالة: '+circle.status+'\n'+
  'معرّف الدائرة: <code>'+circle.id+'</code>\n'+
  (circle.status==='OPEN'?'للانضمام من خاص الطالب: <code>/studyjoin '+id+'</code>\n':'')+
  (flags?'البلاغات: طلب اتصال '+flags.CONTACT_REQUEST+
   ' | مطابقة غير آمنة '+flags.UNSAFE_MATCH+
   ' | إساءة '+flags.HARASSMENT+'\n':'')+
  '🔒 لا توجد مطابقة 1:1 أو كشف لقائمة الأشخاص أو إرسال دعوات مباشرة. القاصرون غير معرّضين لمطابقة مع بالغين غرباء.',
  rows);
}
async function listing(service:Phase4StudyPeersService,actor:string,page:number):
 Promise<OwnerInlineScreen|null>{
 const all=await service.list(actor),pages=Math.max(1,Math.ceil(all.length/10));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows=all.slice(page*10,page*10+10).map(x=>[btn(
  (x.status==='DRAFT'?'📝 ':x.status==='OPEN'?'✅ ':'🔒 ')+
  x.topic.slice(0,28),'sp:1:v:'+x.id)]);
 if(pages>1){
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(btn('⬅️ السابق','sp:1:p:'+(page-1)));
  if(page+1<pages)nav.push(btn('التالي ➡️','sp:1:p:'+(page+1)));
  if(nav.length)rows.push(nav);
 }
 rows.push([back]);
 return ui('<b>👥 زملاء الدراسة — 09:11</b>\n'+
  'هذه دوائر مذاكرة جماعية يشرف عليها المالك، وليست مطابقة فردية مع غرباء.\n'+
  'أنشئ دائرة:\n'+
  '<code>/studynew -1001234 2026-12-01T15:00:00.000Z 60 12 BEGINNER | رياضيات القبول الجامعي</code>\n'+
  'المستوى: BEGINNER / INTERMEDIATE / ADVANCED، المدة 15–240 دقيقة، السعة 2–30.\n'+
  'تتطلب المعاينة والموافقة، ويتحقق من عضوية الطلاب عند الانضمام من الخاص.\n'+
  'الانسحاب والبلاغ متاحان، دون كشف حسابات المشاركين أو أرقامهم.\n'+
  'صفحة '+(page+1)+' من '+pages+' | الدوائر '+all.length,
  rows);
}
export async function studyPeerOwnerScreen(
 service:Phase4StudyPeersService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const command=parseStudyPeerOwnerCommand(input);
  if(command?.kind==='CREATE'){
   const circle=await service.draft(actor,command.chatId,command.input);
   return detail(service,actor,circle.id);
  }
  if(command?.kind==='LIST'||input==='mi:1:i:09:11'||input==='sp:1:h')
   return listing(service,actor,0);
  if(!validStudyPeerOwnerRoute(input))return null;
  const page=/^sp:1:p:([0-4])$/u.exec(input);
  if(page)return listing(service,actor,Number(page[1]));
  const view=/^sp:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const opening=/^sp:1:o:([a-f0-9]{24}):([12])$/u.exec(input);
  if(opening){
   if(!await service.open(actor,opening[1]!,Number(opening[2])))return null;
   return detail(service,actor,opening[1]!);
  }
  const confirm=/^sp:1:k:([a-f0-9]{24}):([12])$/u.exec(input);
  if(confirm){
   const circle=await service.ownerView(actor,confirm[1]!);
   if(!circle||circle.status!=='OPEN'||circle.revision!==Number(confirm[2]))return null;
   return ui('<b>⚠️ تأكيد إلغاء دائرة المذاكرة</b>\n'+
    'المادة: '+esc(circle.topic)+'\n'+
    'سيُلغى كل تسجيل ويُحذف المحتوى الحساس الخاص بالأعضاء من الحالة النشطة.\n'+
    'لن تُرسل إشعارات جماعية أو محادثات خاصة تلقائية.',
    [[btn('🔒 نعم، ألغِ الدائرة','sp:1:c:'+circle.id+':'+circle.revision)],
     [btn('↩️ تراجع','sp:1:v:'+circle.id)]]);
  }
  const cancel=/^sp:1:c:([a-f0-9]{24}):([12])$/u.exec(input);
  if(cancel){
   if(!await service.cancel(actor,cancel[1]!,Number(cancel[2])))return null;
   return detail(service,actor,cancel[1]!);
  }
  return null;
 }catch{return null;}
}
