import {Phase4GuidanceService,validGuidanceGroup,
 guidanceEscape,renderGuidanceWelcome,renderGuidanceRules,
 type GuidanceData} from './phase4-guidance.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const ID='-[1-9][0-9]{0,15}',PAGE='(?:0|[1-9][0-9]?)';
const UUID='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const ROUTE=new RegExp('^gd:1:(?:[23]:(?:h|p:'+PAGE+'|g:'+ID+
 ')|3:[rf]:'+ID+':'+PAGE+'|3:d:'+ID+':'+UUID+')$','u');
export const validPhase4GuidanceOwnerRoute=(v:unknown):v is string=>
 typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&ROUTE.test(v)&&
 !/:[grfd]:-(?:0|[1-9][0-9]{15})/u.test('');
export type GuidanceOwnerCommand=
 {section:'GUIDE'|'FIXED';kind:'HOME'}|
 {section:'GUIDE'|'FIXED';kind:'GROUP';chatId:string};
export function parseGuidanceOwnerCommand(input:string):GuidanceOwnerCommand|null{
 if(input==='/newmemberguide')return {section:'GUIDE',kind:'HOME'};
 if(input==='/groupfixed')return {section:'FIXED',kind:'HOME'};
 if(typeof input!=='string'||input.length>90)return null;
 const match=/^\/(newmemberguide|groupfixed) (-[1-9][0-9]{0,15})$/u.exec(input);
 return match&&validGuidanceGroup(match[2]!)?
  {section:match[1]==='newmemberguide'?'GUIDE':'FIXED',
   kind:'GROUP',chatId:match[2]!}:null;
}
type Button={text:string;callback_data:string};
const btn=(text:string,callback_data:string):Button=>({text,callback_data});
const ui=(text:string,rows:Button[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const root=(section:'2'|'3')=>'gd:1:'+section+':h';
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:0');
const group=(section:'2'|'3',id:string)=>'gd:1:'+section+':g:'+id;
async function groups(service:Phase4GuidanceService,actor:string,
 section:'2'|'3',page:number):Promise<OwnerInlineScreen|null>{
 const all=await service.groups(actor),pages=Math.max(1,Math.ceil(all.length/8));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows:Button[][]=all.slice(page*8,page*8+8).map(x=>
  [btn('👥 '+x.chatId+(x.configured?' • لها إعداد':' • افتراضية'),
   group(section,x.chatId))]);
 const pager:Button[]=[];
 if(page>0)pager.push(btn('⬅️ السابق','gd:1:'+section+':p:'+(page-1)));
 if(page+1<pages)pager.push(btn('التالي ➡️','gd:1:'+section+':p:'+(page+1)));
 if(pager.length)rows.push(pager);
 rows.push([back,btn('🏠 لوحة المالك','mi:1:h')]);
 return ui('<b>'+(section==='2'?'🧭 دليل العضو الجديد — 09:02':
  '📜 القوانين والرسائل الثابتة — 09:03')+'</b>\n'+
  'اختر مجموعة معتمدة لمراجعة المواد المرئية فيها.\n'+
  'هذه شاشة معاينة، ولا تنشر تلقائيًا أي رسالة أو تعدل حقوق المجموعة.\n'+
  'الصفحة '+(page+1)+' من '+pages+' • عدد المجموعات: '+all.length+'\n'+
  'الأمر المباشر: <code>/'+(section==='2'?'newmemberguide':'groupfixed')+
  ' -1001234</code>',rows);
}
function welcome(d:GuidanceData):OwnerInlineScreen{
 return ui('<b>👁️ معاينة المالك — دليل العضو الجديد 09:02</b>\n\n'+
  renderGuidanceWelcome(d)+'\n\n'+
  'هذا الدليل للعرض عند طلب الطالب المتحقق من عضويته، ولا يُرسل عند الانضمام تلقائيًا.',
  [[btn('📜 القوانين والرسائل الثابتة',group('3',d.chatId))],
   [btn('✏️ إعدادات الترحيب والروابط','p4c:1:g:'+d.chatId)],
   [btn('📁 إعداد مجلد المجتمع','cf:1:h')],
   [btn('↩️ اختيار المجموعة',root('2')),back]]);
}
function fixed(d:GuidanceData):OwnerInlineScreen{
 return ui('<b>👁️ معاينة المالك — القوانين والرسائل الثابتة 09:03</b>\n\n'+
  renderGuidanceRules(d)+'\n\n'+
  'يمكن تعديل رابط القوانين والملاحظات وربط FAQ بمحرر الردود الحالي بعد المعاينة والتأكيد.',
  [[btn('📜 المصادر والردود ('+d.config.rules.length+')','gd:1:3:r:'+d.chatId+':0')],
   [btn('📚 فهرس FAQ المعتمد ('+d.faqs.length+')','gd:1:3:f:'+d.chatId+':0')],
   [btn('✏️ محرر القوانين والردود','p4c:1:g:'+d.chatId)],
   [btn('🧭 دليل الطالب',group('2',d.chatId))],
   [btn('↩️ اختيار المجموعة',root('3')),back]]);
}
function ruleList(d:GuidanceData,page:number):OwnerInlineScreen|null{
 const all=d.config.rules, pages=Math.max(1,Math.ceil(all.length/6));
 if(page>=pages)return null;
 const lines=all.slice(page*6,page*6+6).map((x,i)=>{
  const source=x.source??'NOTE',enabled=x.enabled?'مفعّل':'معطّل';
  return '◾ '+(page*6+i+1)+'. '+guidanceEscape(x.trigger.slice(0,80))+
   ' — '+source+' / '+enabled+
   (source==='FAQ'?'\n    FAQ: '+(x.sourceFaqId??'غير متاح'):
    source==='RULES'?'\n    المصدر: رابط القوانين المعتمد':
    '\n    الرد: '+guidanceEscape(x.response.slice(0,120)));
 });
 const rows:Button[][]=[];
 const nav:Button[]=[];
 if(page>0)nav.push(btn('⬅️ السابق','gd:1:3:r:'+d.chatId+':'+(page-1)));
 if(page+1<pages)nav.push(btn('التالي ➡️','gd:1:3:r:'+d.chatId+':'+(page+1)));
 if(nav.length)rows.push(nav);
 rows.push([btn('✏️ إدارة قواعد الرد','p4c:1:r:'+d.chatId+':0')],
  [btn('↩️ القوانين المعتمدة',group('3',d.chatId))]);
 return ui('<b>📝 فهرس المصادر والردود — 09:03</b>\n'+
  'المجموعة: <code>'+d.chatId+'</code> • '+(page+1)+'/'+pages+'\n'+
  (lines.join('\n')||'لا توجد قواعد معتمدة حاليًا.')+'\n\n'+
  'تعطيل القاعدة أو فقد مصدر FAQ يمنع الرد الآلي ولا يغيّر قانون الإشراف.',rows);
}
function faqList(d:GuidanceData,page:number):OwnerInlineScreen|null{
 const all=d.faqs,pages=Math.max(1,Math.ceil(all.length/6));
 if(page>=pages)return null;
 const rows:Button[][]=all.slice(page*6,page*6+6).map(x=>[
  btn('📚 '+x.question.slice(0,55),'gd:1:3:d:'+d.chatId+':'+x.id)]);
 const nav:Button[]=[];
 if(page>0)nav.push(btn('⬅️ السابق','gd:1:3:f:'+d.chatId+':'+(page-1)));
 if(page+1<pages)nav.push(btn('التالي ➡️','gd:1:3:f:'+d.chatId+':'+(page+1)));
 if(nav.length)rows.push(nav);
 rows.push([btn('↩️ القوانين المعتمدة',group('3',d.chatId))]);
 return ui('<b>📚 الأسئلة المعتمدة وذات مصدر منشور — 09:03</b>\n'+
  'المجموعة: <code>'+d.chatId+'</code> • '+(page+1)+'/'+pages+
  '\nالعدد: '+all.length+
  '\nلا تظهر الأسئلة المؤرشفة أو المصادر غير المنشورة أو التصنيفات المحجوبة.',rows);
}
export async function phase4GuidanceOwnerScreen(service:Phase4GuidanceService,
 actor:string,input:string):Promise<OwnerInlineScreen|null>{
 try{
  const cmd=parseGuidanceOwnerCommand(input);
  if(cmd?.kind==='HOME')return groups(service,actor,cmd.section==='GUIDE'?'2':'3',0);
  if(cmd?.kind==='GROUP'){
   const d=await service.ownerGroup(actor,cmd.chatId);
   return d?(cmd.section==='GUIDE'?welcome(d):fixed(d)):null;
  }
  if(input==='mi:1:i:09:02'||input==='gd:1:2:h')
   return groups(service,actor,'2',0);
  if(input==='mi:1:i:09:03'||input==='gd:1:3:h')
   return groups(service,actor,'3',0);
  if(!validPhase4GuidanceOwnerRoute(input))return null;
  const list=/^gd:1:([23]):p:(0|[1-9][0-9]?)$/u.exec(input);
  if(list)return groups(service,actor,list[1]! as '2'|'3',Number(list[2]));
  const detail=/^gd:1:([23]):g:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(detail){
   const d=await service.ownerGroup(actor,detail[2]!);
   return d?(detail[1]==='2'?welcome(d):fixed(d)):null;
  }
  const page=/^gd:1:3:([rf]):(-[1-9][0-9]{0,15}):(0|[1-9][0-9]?)$/u.exec(input);
  if(page){
   const d=await service.ownerGroup(actor,page[2]!);
   return d?(page[1]==='r'?ruleList(d,Number(page[3])):
    faqList(d,Number(page[3]))):null;
  }
  const faq=/^gd:1:3:d:(-[1-9][0-9]{0,15}):([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.exec(input);
  if(!faq)return null;
  const answer=await service.ownerFAQ(actor,faq[1]!,faq[2]!);
  return answer?ui(answer,[[btn('📚 قائمة الأسئلة','gd:1:3:f:'+faq[1]+':0')],
   [btn('↩️ القوانين والرسائل',group('3',faq[1]!))]]):null;
 }catch{return null;}
}
