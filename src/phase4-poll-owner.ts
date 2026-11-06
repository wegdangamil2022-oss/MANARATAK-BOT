import {Phase4PollService} from './phase4-polls.js';
import {validPollInput,type PollKind} from './phase4-poll-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const HEX='[a-f0-9]{24}';
const ROUTE=new RegExp('^po:1:(?:h|p:(?:0|[1-9][0-9]?)|[vr]:'+HEX+
 '|[oxc]:'+HEX+':[123])
export const validPollOwnerRoute=(x:unknown):x is string=>
 typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&ROUTE.test(x);
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:0');
const home=btn('📋 قائمة الاستطلاعات','po:1:h');
export type PollOwnerCommand={kind:'LIST'}|{kind:'CREATE';chatId:string;
 input:{kind:PollKind;question:string;options:string[];durationMinutes:number}};
export function parsePollOwnerCommand(raw:string):PollOwnerCommand|null{
 if(raw==='/polls')return {kind:'LIST'};
 if(typeof raw!=='string'||raw.length>1000||/[\r\n]/u.test(raw))return null;
 const match=/^\/(pollnew|pollinterests|pollfeedback) (-[1-9][0-9]{0,15}) ([0-9]{2,4}) (.+)$/u.exec(raw);
 if(!match||!Number.isSafeInteger(Number(match[2])))return null;
 const fields=match[4]!.split(' | ');
 const input={kind:(match[1]==='pollinterests'?'INTERESTS':
  match[1]==='pollfeedback'?'SESSION_FEEDBACK':'NEEDS') as PollKind,
  question:fields[0]??'',options:fields.slice(1),
  durationMinutes:Number(match[3])};
 if(!validPollInput(input))return null;
 return {kind:'CREATE',chatId:match[2]!,input};
}
async function detail(service:Phase4PollService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const poll=await service.view(actor,id);if(!poll)return null;
 const names={DRAFT:'📝 مسودة محلية',OPEN:'✅ استقبال أصوات محلي',
  CLOSED:'🔒 مغلق'} as const;
 const rows:{text:string;callback_data:string}[][]=[];
 if(poll.status==='DRAFT')rows.push([btn('✅ فتح الاستطلاع محليًا','po:1:o:'+id+':1')]);
 if(poll.status==='OPEN')rows.push([btn('🔒 مراجعة إغلاق الاستطلاع','po:1:x:'+id+':2')]);
 if(poll.status==='CLOSED')rows.push([btn('📊 النتائج المجمعة','po:1:r:'+id)]);
 rows.push([home],[back]);
 const labels=poll.options.map((o,i)=>(i+1)+'. '+esc(o)).join('\n');
 return ui('<b>📊 استطلاع رأي — 09:08</b>\n'+
  'المجموعة: <code>'+poll.chatId+'</code>\n'+
  'النوع: '+poll.kind+'\n'+
  'السؤال: '+esc(poll.question)+'\n'+
  'الخيارات:\n'+labels+'\n'+
  'الحالة: '+names[poll.status]+'\n'+
  'الانتهاء: '+new Date(poll.expiresAt).toISOString()+'\n'+
  'معرّف الاستطلاع: <code>'+poll.id+'</code>\n'+
  'للمشاركة يدويًا في الخاص: <code>/pollvote '+id+' 1</code> (رقم الخيار).\n'+
  '🔐 لا يوجد نشر أو إرسال Poll إلى المجموعة. ليست هذه أصوات مسابقات.',
  rows);
}
async function list(service:Phase4PollService,actor:string,page:number):
 Promise<OwnerInlineScreen|null>{
 const polls=await service.list(actor),perPage=10;
 const pages=Math.max(1,Math.ceil(polls.length/perPage));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows=polls.slice(page*perPage,(page+1)*perPage).map(p=>[btn(
  (p.status==='DRAFT'?'📝 ':p.status==='OPEN'?'✅ ':'🔒 ')+
   p.question.slice(0,29),'po:1:v:'+p.id)]);
 if(pages>1){
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(btn('⬅️ السابق','po:1:p:'+(page-1)));
  if(page+1<pages)nav.push(btn('التالي ➡️','po:1:p:'+(page+1)));
  if(nav.length)rows.push(nav);
 }
 rows.push([back]);
 return ui('<b>📊 استطلاعات الرأي — 09:08</b>\n'+
  'إنشاء استطلاع الاحتياجات:\n'+
  '<code>/pollnew -1001234 60 ما مجال دراستك المفضل؟ | الطب | الهندسة | الحاسوب</code>\n'+
  'للاهتمامات: <code>/pollinterests</code> ولتقييم الجلسة: <code>/pollfeedback</code> بنفس الصيغة.\n'+
  'المدة 10–1440 دقيقة، والخيارات 2–8. يُفتح الاستطلاع بعد معاينة المالك فقط.\n'+
  'التصويت في خاص البوت وبعضوية موثقة؛ النتائج بعد الإغلاق ولخمسة أصوات على الأقل.\n'+
  'التسجيل محلي فقط ولا يشغّل استطلاع Telegram الأصلي.\n'+
  'صفحة '+(page+1)+' من '+pages+' · المجموع '+polls.length,
  rows);
}
async function results(service:Phase4PollService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const poll=await service.view(actor,id);
 if(!poll||poll.status!=='CLOSED')return null;
 const result=await service.results(actor,id);
 return ui('<b>📊 النتائج الإجمالية</b>\n'+esc(poll.question)+'\n'+
  (result?result.options.map((o,i)=>esc(o)+' — '+result.counts[i]).join('\n')+
   '\nالأصوات المحتسبة: '+result.total:
   '🔒 النتائج غير متاحة: يتطلب العرض خمسة أصوات نشطة على الأقل أو صلاحية حالية.')+
  '\nلا أسماء أو اختيارات فردية، ولا إثبات نشر Telegram.',
  [[btn('↩️ الاستطلاع','po:1:v:'+id)],[home]]);
}
export async function pollOwnerScreen(service:Phase4PollService,actor:string,input:string):
 Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const parsed=parsePollOwnerCommand(input);
  if(parsed?.kind==='CREATE'){
   const poll=await service.draft(actor,parsed.chatId,parsed.input);
   return detail(service,actor,poll.id);
  }
  if(parsed?.kind==='LIST'||input==='mi:1:i:09:08'||input==='po:1:h')return list(service,actor,0);
  if(!validPollOwnerRoute(input))return null;
  const page=/^po:1:p:(0|[1-9][0-9]?)$/u.exec(input);
  if(page)return list(service,actor,Number(page[1]));
  const view=/^po:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const summary=/^po:1:r:([a-f0-9]{24})$/u.exec(input);
  if(summary)return results(service,actor,summary[1]!);
  const open=/^po:1:o:([a-f0-9]{24}):([123])$/u.exec(input);
  if(open){
   if(!await service.open(actor,open[1]!,Number(open[2])))return null;
   return detail(service,actor,open[1]!);
  }
  const check=/^po:1:x:([a-f0-9]{24}):([123])$/u.exec(input);
  if(check){
   const poll=await service.view(actor,check[1]!);
   if(!poll||poll.status!=='OPEN'||poll.revision!==Number(check[2]))return null;
   return ui('<b>⚠️ إغلاق الاستطلاع؟</b>\n'+esc(poll.question)+
    '\nبعد الإغلاق لا تُقبل أصوات جديدة، ولا يُنشر شيء في المجموعة.',
    [[btn('🔒 تأكيد الإغلاق','po:1:c:'+poll.id+':'+poll.revision)],
     [btn('↩️ إلغاء','po:1:v:'+poll.id)]]);
  }
  const close=/^po:1:c:([a-f0-9]{24}):([123])$/u.exec(input);
  if(close){
   if(!await service.close(actor,close[1]!,Number(close[2])))return null;
   return detail(service,actor,close[1]!);
  }
  return null;
 }catch{return null;}
}
,'u');
export const validPollOwnerRoute=(x:unknown):x is string=>
 typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&ROUTE.test(x);
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:0');
const home=btn('📋 قائمة الاستطلاعات','po:1:h');
export type PollOwnerCommand={kind:'LIST'}|{kind:'CREATE';chatId:string;
 input:{kind:PollKind;question:string;options:string[];durationMinutes:number}};
export function parsePollOwnerCommand(raw:string):PollOwnerCommand|null{
 if(raw==='/polls')return {kind:'LIST'};
 if(typeof raw!=='string'||raw.length>1000||/[\r\n]/u.test(raw))return null;
 const match=/^\/(pollnew|pollinterests|pollfeedback) (-[1-9][0-9]{0,15}) ([0-9]{2,4}) (.+)$/u.exec(raw);
 if(!match||!Number.isSafeInteger(Number(match[2])))return null;
 const fields=match[4]!.split(' | ');
 const input={kind:(match[1]==='pollinterests'?'INTERESTS':
  match[1]==='pollfeedback'?'SESSION_FEEDBACK':'NEEDS') as PollKind,
  question:fields[0]??'',options:fields.slice(1),
  durationMinutes:Number(match[3])};
 if(!validPollInput(input))return null;
 return {kind:'CREATE',chatId:match[2]!,input};
}
async function detail(service:Phase4PollService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const poll=await service.view(actor,id);if(!poll)return null;
 const names={DRAFT:'📝 مسودة محلية',OPEN:'✅ استقبال أصوات محلي',
  CLOSED:'🔒 مغلق'} as const;
 const rows:{text:string;callback_data:string}[][]=[];
 if(poll.status==='DRAFT')rows.push([btn('✅ فتح الاستطلاع محليًا','po:1:o:'+id+':1')]);
 if(poll.status==='OPEN')rows.push([btn('🔒 مراجعة إغلاق الاستطلاع','po:1:x:'+id+':2')]);
 if(poll.status==='CLOSED')rows.push([btn('📊 النتائج المجمعة','po:1:r:'+id)]);
 rows.push([home],[back]);
 const labels=poll.options.map((o,i)=>(i+1)+'. '+esc(o)).join('\n');
 return ui('<b>📊 استطلاع رأي — 09:08</b>\n'+
  'المجموعة: <code>'+poll.chatId+'</code>\n'+
  'النوع: '+poll.kind+'\n'+
  'السؤال: '+esc(poll.question)+'\n'+
  'الخيارات:\n'+labels+'\n'+
  'الحالة: '+names[poll.status]+'\n'+
  'الانتهاء: '+new Date(poll.expiresAt).toISOString()+'\n'+
  'معرّف الاستطلاع: <code>'+poll.id+'</code>\n'+
  'للمشاركة يدويًا في الخاص: <code>/pollvote '+id+' 1</code> (رقم الخيار).\n'+
  '🔐 لا يوجد نشر أو إرسال Poll إلى المجموعة. ليست هذه أصوات مسابقات.',
  rows);
}
async function list(service:Phase4PollService,actor:string,page:number):
 Promise<OwnerInlineScreen|null>{
 const polls=await service.list(actor),perPage=10;
 const pages=Math.max(1,Math.ceil(polls.length/perPage));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows=polls.slice(page*perPage,(page+1)*perPage).map(p=>[btn(
  (p.status==='DRAFT'?'📝 ':p.status==='OPEN'?'✅ ':'🔒 ')+
   p.question.slice(0,29),'po:1:v:'+p.id)]);
 if(pages>1){
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(btn('⬅️ السابق','po:1:p:'+(page-1)));
  if(page+1<pages)nav.push(btn('التالي ➡️','po:1:p:'+(page+1)));
  if(nav.length)rows.push(nav);
 }
 rows.push([back]);
 return ui('<b>📊 استطلاعات الرأي — 09:08</b>\n'+
  'إنشاء استطلاع الاحتياجات:\n'+
  '<code>/pollnew -1001234 60 ما مجال دراستك المفضل؟ | الطب | الهندسة | الحاسوب</code>\n'+
  'للاهتمامات: <code>/pollinterests</code> ولتقييم الجلسة: <code>/pollfeedback</code> بنفس الصيغة.\n'+
  'المدة 10–1440 دقيقة، والخيارات 2–8. يُفتح الاستطلاع بعد معاينة المالك فقط.\n'+
  'التصويت في خاص البوت وبعضوية موثقة؛ النتائج بعد الإغلاق ولخمسة أصوات على الأقل.\n'+
  'التسجيل محلي فقط ولا يشغّل استطلاع Telegram الأصلي.\n'+
  'صفحة '+(page+1)+' من '+pages+' · المجموع '+polls.length,
  rows);
}
async function results(service:Phase4PollService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const poll=await service.view(actor,id);
 if(!poll||poll.status!=='CLOSED')return null;
 const result=await service.results(actor,id);
 return ui('<b>📊 النتائج الإجمالية</b>\n'+esc(poll.question)+'\n'+
  (result?result.options.map((o,i)=>esc(o)+' — '+result.counts[i]).join('\n')+
   '\nالأصوات المحتسبة: '+result.total:
   '🔒 النتائج غير متاحة: يتطلب العرض خمسة أصوات نشطة على الأقل أو صلاحية حالية.')+
  '\nلا أسماء أو اختيارات فردية، ولا إثبات نشر Telegram.',
  [[btn('↩️ الاستطلاع','po:1:v:'+id)],[home]]);
}
export async function pollOwnerScreen(service:Phase4PollService,actor:string,input:string):
 Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const parsed=parsePollOwnerCommand(input);
  if(parsed?.kind==='CREATE'){
   const poll=await service.draft(actor,parsed.chatId,parsed.input);
   return detail(service,actor,poll.id);
  }
  if(parsed?.kind==='LIST'||input==='mi:1:i:09:08'||input==='po:1:h')return list(service,actor,0);
  if(!validPollOwnerRoute(input))return null;
  const page=/^po:1:p:(0|[1-9][0-9]?)$/u.exec(input);
  if(page)return list(service,actor,Number(page[1]));
  const view=/^po:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const summary=/^po:1:r:([a-f0-9]{24})$/u.exec(input);
  if(summary)return results(service,actor,summary[1]!);
  const open=/^po:1:o:([a-f0-9]{24}):([123])$/u.exec(input);
  if(open){
   if(!await service.open(actor,open[1]!,Number(open[2])))return null;
   return detail(service,actor,open[1]!);
  }
  const check=/^po:1:x:([a-f0-9]{24}):([123])$/u.exec(input);
  if(check){
   const poll=await service.view(actor,check[1]!);
   if(!poll||poll.status!=='OPEN'||poll.revision!==Number(check[2]))return null;
   return ui('<b>⚠️ إغلاق الاستطلاع؟</b>\n'+esc(poll.question)+
    '\nبعد الإغلاق لا تُقبل أصوات جديدة، ولا يُنشر شيء في المجموعة.',
    [[btn('🔒 تأكيد الإغلاق','po:1:c:'+poll.id+':'+poll.revision)],
     [btn('↩️ إلغاء','po:1:v:'+poll.id)]]);
  }
  const close=/^po:1:c:([a-f0-9]{24}):([123])$/u.exec(input);
  if(close){
   if(!await service.close(actor,close[1]!,Number(close[2])))return null;
   return detail(service,actor,close[1]!);
  }
  return null;
 }catch{return null;}
}
