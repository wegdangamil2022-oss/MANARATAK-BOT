import {Phase4WhisperService,type WhisperDraftInput} from './phase4-whispers.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const hex='[a-f0-9]{24}';
const route=new RegExp('^wh:1:(?:h|l:(?:0|[1-9][0-9]?)|[vax]:'+hex+'|c:'+hex+':[12]|r:-[1-9][0-9]{0,15}|[zy]:'+hex+')$','u');
export const validWhisperOwnerRoute=(s:unknown):s is string=>
 typeof s==='string'&&Buffer.byteLength(s,'utf8')<=64&&route.test(s);
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const home=btn('↩️ التفاعل والترحيب','mi:1:s:09:0');
const list=btn('📋 قائمة الهمسات','wh:1:h');
export type WhisperOwnerCommand=
 |{kind:'CREATE';chatId:string;input:WhisperDraftInput}
 |{kind:'LIST'}
 |{kind:'REPORTS';chatId:string};
const user=(value:string)=>/^[1-9][0-9]{0,15}$/u.test(value)&&
 Number.isSafeInteger(Number(value));
const group=(value:string)=>/^-[1-9][0-9]{0,15}$/u.test(value)&&
 Number.isSafeInteger(Number(value));
export function parseWhisperOwnerCommand(text:string):WhisperOwnerCommand|null{
 if(text==='/whispers')return {kind:'LIST'};
 const reports=/^\/whisperreports (-[1-9][0-9]{0,15})$/u.exec(text);
 if(reports&&group(reports[1]!))return {kind:'REPORTS',chatId:reports[1]!};
 const first=/^\/whisperfirst (-[1-9][0-9]{0,15}) ([0-9]{1,2}) ([0-9]{1,2}) ([^\r\n]{1,800})$/u.exec(text);
 if(first&&group(first[1]!)&&Number(first[2])>=1&&Number(first[2])<=20&&
  Number(first[3])>=1&&Number(first[3])<=60)
  return {kind:'CREATE',chatId:first[1]!,input:{
   kind:'FIRST_N',seats:Number(first[2]),durationMinutes:Number(first[3]),text:first[4]!
  }};
 const direct=/^\/whisperdirect (-[1-9][0-9]{0,15}) ([1-9][0-9]{0,15}) ([0-9]{1,2}) ([^\r\n]{1,800})$/u.exec(text);
 if(direct&&group(direct[1]!)&&user(direct[2]!)&&
  Number(direct[3])>=1&&Number(direct[3])<=60)
  return {kind:'CREATE',chatId:direct[1]!,input:{
   kind:'DIRECT',recipientId:direct[2]!,durationMinutes:Number(direct[3]),text:direct[4]!
  }};
 return null;
}
async function detail(service:Phase4WhisperService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const row=await service.ownerView(actor,id);
 if(!row)return null;
 const names={DRAFT:'📝 مسودة تنتظر اعتمادك',OPEN:'✅ معتمدة محليًا، لم تُنشر',
  CLOSED:'🔒 مغلقة ومحذوف محتواها'} as const;
 const type=row.kind==='FIRST_N'?'أول '+row.seats+' مستلمين مؤهلين':
  'إلى مستلم واحد مُحدد';
 const text='<b>💌 معاينة همسة خاصة للمالك فقط</b>\n'+
  'المجموعة: <code>'+row.chatId+'</code>\n'+
  'الوضع: '+type+'\n'+
  'الحالة: '+names[row.status]+'\n'+
  'تاريخ الانتهاء: '+new Date(row.expiresAt).toISOString()+'\n'+
  (row.status==='DRAFT'?
   '\n<b>نص المسودة:</b>\n'+escape(row.text??'')+'\n':
   '\nتم إخفاء النص عن صفحات الحالة؛ لا يظهر في رسالة مجموعة.\n')+
  '\n⚠️ هذه الوحدة لا تنشر همسة في Telegram، ولا تعرض محتواها للأعضاء، ولا تدعي تسليمًا.';
 const actions:{text:string;callback_data:string}[][]=[];
 if(row.status==='DRAFT')actions.push([btn('✅ اعتماد المسودة محليًا','wh:1:a:'+id)]);
 if(row.status!=='CLOSED')actions.push([btn('🔒 إغلاق وحذف النص','wh:1:x:'+id)]);
 actions.push([list],[home]);
 return ui(text,actions);
}
export async function whisperOwnerScreen(
 service:Phase4WhisperService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  // A private owner interaction also opportunistically redacts expired
  // content; this is NOT a substitute for a separate scheduled sweeper.
  await service.expire();
  const cmd=parseWhisperOwnerCommand(input);
  if(cmd?.kind==='CREATE'){
   const d=await service.draft(actor,cmd.chatId,cmd.input);
   return detail(service,actor,d.id);
  }
  if(cmd?.kind==='REPORTS')input='wh:1:r:'+cmd.chatId;
  const reportsInput=/^wh:1:r:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(reportsInput){
   const reports=await service.reports(actor,reportsInput[1]!);
   const rows=reports.slice(0,10).map(r=>[
    btn((r.status==='OPEN'?'🚩 ':'✅ ')+r.reason+
     ' · '+new Date(r.reportedAt).toISOString().slice(0,10),
     'wh:1:z:'+r.id)]);
   rows.push([list],[home]);
   return ui('<b>🚩 مراجعات الهمسات الخاصة</b>\n'+
    'المجموعة: <code>'+reportsInput[1]+'</code>\n'+
    'بلاغات محفوظة: '+reports.length+'\n'+
    'يظهر نوع الإساءة وتاريخها دون نص الهمسة أو هوية المُبلّغ. '+ 
    'المراجعة لا تثبت وصول المحتوى إلى المستلم.',rows);
  }
  const reviewPreview=/^wh:1:z:([a-f0-9]{24})$/u.exec(input);
  if(reviewPreview){
   const rows=await service.list(actor);
   // The report service itself enforces the group permission; never reveal
   // whether an unrelated private report ID exists.
   for(const m of rows){
    const found=(await service.reports(actor,m.chatId)).find(r=>r.id===reviewPreview[1]);
    if(found){
     if(found.status!=='OPEN')return ui('هذا البلاغ سبق أن تمت مراجعته.',[[list]]);
     return ui('<b>🚩 معاينة إغلاق بلاغ همسة</b>\n'+
      'نوع البلاغ: '+found.reason+'\n'+
      'تاريخ الإبلاغ: '+new Date(found.reportedAt).toISOString()+
      '\nمعرّف الحالة: <code>'+found.id+'</code>\n'+
      'لن يُعرض متن الهمسة أو بيانات المُبلّغ. هذا تسجيل مراجعة فقط.',
      [[btn('✅ تأكيد المراجعة','wh:1:y:'+found.id)],[list]]);
    }
   }
   return null;
  }
  const reviewConfirm=/^wh:1:y:([a-f0-9]{24})$/u.exec(input);
  if(reviewConfirm){
   if(!await service.reviewReport(actor,reviewConfirm[1]!))return null;
   return ui('✅ اعتُمدت مراجعة البلاغ دون نسخ نص الهمسة.',
    [[list],[home]]);
  }
  const listing=/^wh:1:l:(0|[1-9][0-9]?)$/u.exec(input);
  if(cmd?.kind==='LIST'||input==='mi:1:i:09:06'||input==='wh:1:h'||listing){
   const rows=await service.list(actor);
   const page=listing?Number(listing[1]):0;
   const pages=Math.max(1,Math.ceil(rows.length/8));
   if(page>=pages)return null;
   const buttons=rows.slice(page*8,page*8+8).map(m=>[btn(
    (m.status==='DRAFT'?'📝 ':m.status==='OPEN'?'✅ ':'🔒 ')+
     (m.kind==='FIRST_N'?'أول '+m.seats:'شخص محدد')+' · '+m.chatId,
    'wh:1:v:'+m.id
   )]);
   const nav:{text:string;callback_data:string}[]=[];
   if(page>0)nav.push(btn('⬅️ السابق','wh:1:l:'+(page-1)));
   if(page+1<pages)nav.push(btn('التالي ➡️','wh:1:l:'+(page+1)));
   if(nav.length)buttons.push(nav);
   buttons.push([home]);
   return ui('<b>💌 الهمسات الخاصة — القسم 09:06</b>\n'+
    'إنشاء المسودة من خاص المالك فقط:\n'+
    '<code>/whisperfirst -1001234 3 10 نص الهمسة</code>\n'+
    '<code>/whisperdirect -1001234 200 10 نص الهمسة</code>\n'+
    'الأرقام: معرّف مجموعة · عدد المقاعد أو المستلم · مدة بالدقائق (1–60).\n'+
    '🔐 الحفظ والمراجعة محليان فقط. لا يوجد إرسال أو منشور عام في Telegram بعد.\n'+
    'الهمسات المخزنة: '+rows.length+' · صفحة '+(page+1)+'/'+pages+' (8 بكل صفحة).'+
    '\nبلاغات المجموعة: <code>/whisperreports GROUP_ID</code>',buttons);
  }
  if(!validWhisperOwnerRoute(input))return null;
  const view=/^wh:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const approve=/^wh:1:a:([a-f0-9]{24})$/u.exec(input);
  if(approve){
   await service.approve(actor,approve[1]!);
   return detail(service,actor,approve[1]!);
  }
  const check=/^wh:1:x:([a-f0-9]{24})$/u.exec(input);
  if(check){
   const row=await service.ownerView(actor,check[1]!);
   if(!row||row.status==='CLOSED')return null;
   return ui('<b>⚠️ تأكيد إغلاق الهمسة وحذف محتواها</b>\n'+
    'سيتوقف حجز المقاعد الجديدة، ولن يُعاد محتوى الرسالة بعد هذا الإجراء.\n'+
    'المجموعة: <code>'+row.chatId+'</code>\n'+
    'هذه المراجعة لا تُجري عملية Telegram.',
    [[btn('🔒 تأكيد الإغلاق','wh:1:c:'+row.id+':'+row.revision)],
     [btn('↩️ إلغاء الإغلاق','wh:1:v:'+row.id)]]);
  }
  const close=/^wh:1:c:([a-f0-9]{24}):([12])$/u.exec(input);
  if(close){
   if(!await service.close(actor,close[1]!,Number(close[2])))return null;
   return detail(service,actor,close[1]!);
  }
  return null;
 }catch{return null;}
}
