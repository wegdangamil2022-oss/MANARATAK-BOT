import {Phase4EngagementReportsService,
 REPORT_WINDOWS,type EngagementWindow,type EngagementReport,
 type EngagementMetric} from './phase4-engagement-reports.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
const ROUTE=/^er:1:(?:h|p:[0-9]|g:-[1-9][0-9]{0,15}:(?:DAY|WEEK|MONTH))$/u;
const CHAT=/^-[1-9][0-9]{0,15}$/u;
export const validEngagementOwnerRoute=(v:unknown):v is string=>
 typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&ROUTE.test(v);
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
export type EngagementOwnerCommand={kind:'HOME'}|{
 kind:'VIEW';chatId:string;period:EngagementWindow
};
export function parseEngagementOwnerCommand(v:string):EngagementOwnerCommand|null{
 if(v==='/engagement')return {kind:'HOME'};
 if(typeof v!=='string'||v.length>100)return null;
 const m=/^\/engagement (-[1-9][0-9]{0,15}) (DAY|WEEK|MONTH)$/u.exec(v);
 if(!m||!Number.isSafeInteger(Number(m[1]))||
  !Object.hasOwn(REPORT_WINDOWS,m[2]!))return null;
 return {kind:'VIEW',chatId:m[1]!,period:m[2]! as EngagementWindow};
}
const privacyCount=(m:EngagementMetric):string=>
 m.privacyFloor===5&&m.count>0&&m.count<5?'أقل من 5':
 String(m.count);
const labelWindow={DAY:'آخر 24 ساعة',WEEK:'آخر 7 أيام',MONTH:'آخر 30 يومًا'};
const evidence={LOCAL_RESERVATION:'حجز محلي',
 LOCAL_RECORD:'سجل محلي',OPTIONAL_LOG:'سجل اختياري'};
const home=btn('📈 اختيار مجموعة','er:1:h');
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:1');
function reportScreen(report:EngagementReport):OwnerInlineScreen{
 const buttons:(typeof home)[][]=[
  [btn('اليوم','er:1:g:'+report.chatId+':DAY'),
   btn('الأسبوع','er:1:g:'+report.chatId+':WEEK'),
   btn('30 يومًا','er:1:g:'+report.chatId+':MONTH')],
  [home],[back]
 ];
 const lines=report.metrics.map(x=>
  '◾ '+x.label+': <b>'+privacyCount(x)+'</b> ('+evidence[x.evidence]+')');
 return ui('<b>📈 تقارير التفاعل — 09:15</b>\n'+
  'المجموعة: <code>'+report.chatId+'</code>\n'+
  'الفترة: '+labelWindow[report.window]+'\n'+
  'من UTC: '+new Date(report.from).toISOString()+'\n'+
  'إلى UTC: '+new Date(report.to).toISOString()+'\n\n'+
  lines.join('\n')+'\n\n'+
  '<b>ضوابط قراءة الأرقام</b>\n'+
  '• الرقم 0 يعني عدم وجود سجل محفوظ ضمن المدة، وليس انعدام التفاعل.\n'+
  '• «أقل من 5» نتيجة منقّحة لحماية الخصوصية.\n'+
  '• حجوزات رسائل البوت لا تثبت تسليم Telegram؛ والتسجيلات لا تثبت الحضور.\n'+
  '• سجل كتم المحاضرات اختياري، والسجلات القديمة قد تُحذف تلقائيًا.\n'+
  '• لا توجد أرقام مشاهدة/وصول، أو حساب أشخاص فريدين، أو ترتيب للطلاب.\n'+
  '• إيصالات الترحيب/الردود قد تشمل فترات سابقة لاعتماد المجموعة.\n'+
  '• البيانات من حالة منارتك المحلية فقط دون استدعاء Telegram.',
  buttons);
}
async function groupList(service:Phase4EngagementReportsService,
 actor:string,page:number):Promise<OwnerInlineScreen|null>{
 const groups=await service.groups(actor),pages=Math.max(1,Math.ceil(groups.length/10));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows:(typeof home)[][]=groups.slice(page*10,page*10+10).map(x=>
  [btn('📈 المجموعة '+x.chatId,'er:1:g:'+x.chatId+':WEEK')]);
 if(pages>1){
  const nav:(typeof home)[]=[];
  if(page>0)nav.push(btn('⬅️ السابق','er:1:p:'+(page-1)));
  if(page+1<pages)nav.push(btn('التالي ➡️','er:1:p:'+(page+1)));
  if(nav.length)rows.push(nav);
 }
 rows.push([back]);
 return ui('<b>📈 تقارير التفاعل — 09:15</b>\n'+
  'اختر مجموعة لإظهار إحصاء محلي في نافذة محددة.\n'+
  'الحقول لا تكشف أسماء الطلاب، ولا تعتبر المحاولة وصولًا مؤكدًا أو تسجيل الفعالية حضورًا.\n'+
  'لعرض تقرير أسبوعي مباشر:\n'+
  '<code>/engagement -1001234 WEEK</code>\n'+
  'الفترات المتاحة: DAY (24 ساعة)، WEEK (7 أيام)، MONTH (30 يومًا).\n'+
  'قد تكون النتائج جزئية بسبب عمر السجلات أو عدم تفعيل سجل قرارات الأتمتة.\n'+
  'الصفحة '+(page+1)+' من '+pages+' — المجموعات المعتمدة '+groups.length,
  rows);
}
export async function engagementOwnerScreen(
 service:Phase4EngagementReportsService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  const parsed=parseEngagementOwnerCommand(input);
  if(parsed?.kind==='HOME'||input==='mi:1:i:09:15'||input==='er:1:h')
   return groupList(service,actor,0);
  if(parsed?.kind==='VIEW'){
   const report=await service.report(actor,parsed.chatId,parsed.period);
   return report?reportScreen(report):null;
  }
  if(!validEngagementOwnerRoute(input))return null;
  const page=/^er:1:p:([0-9])$/u.exec(input);
  if(page)return groupList(service,actor,Number(page[1]));
  const view=/^er:1:g:(-[1-9][0-9]{0,15}):(DAY|WEEK|MONTH)$/u.exec(input);
  if(view&&CHAT.test(view[1]!)){
   const report=await service.report(actor,view[1]!,view[2]! as EngagementWindow);
   return report?reportScreen(report):null;
  }
  return null;
 }catch{return null;}
}
