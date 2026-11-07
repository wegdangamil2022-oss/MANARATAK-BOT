import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {summarizeNetworkSettings,compareNetworkGroupSettings,
 type NetworkSettingsOverview,type ComparisonField,type NetworkSettingsMember}
 from './network-policy-diff.js';

/** NETWORK-005, read-only. No preview approval buttons are required for
 * comparisons: this module never writes or restores protection policies. */
const SIZE=8;
const net='([a-f0-9]{12})',page='(0|[1-9][0-9]{0,2})';
const group='(-[1-9][0-9]{0,15})';
const home=new RegExp('^nw:1:ch:'+net+'$','u');
const sources=new RegExp('^nw:1:cp:'+net+':'+page+'$','u');
const targets=new RegExp('^nw:1:cs:'+net+':'+group+':'+page+'$','u');
const detail=new RegExp('^nw:1:ct:'+net+':'+group+':'+group+'$','u');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(value:string)=>value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const labelPolicy:Record<string,string>={
 CURRENT:'سياسة صالحة',MISSING:'لا توجد سياسة',STALE:'سياسة قديمة',
 DUPLICATE:'سجلات سياسة مكررة',CORRUPT:'سجل سياسة غير سليم',
 UNAVAILABLE:'لا يمكن قراءة السياسة'
};
const labelMember:Record<string,string>={
 CURRENT:'معتمدة',STALE:'ارتباطات قديمة',REVOKED:'اعتماد ملغى',
 DUPLICATE:'سجلات عضوية مكررة',MISSING:'المجموعة غير موجودة'
};
const labelField:Record<ComparisonField,string>={
 groupAI:'وضع المساعد الذكي',scopes:'نطاقات صلاحيات الخدمات',
 policyStatus:'توفر سياسة الحماية',mode:'وضع الحماية',
 rules:'قواعد الحماية',allowedDomains:'النطاقات المسموحة',
 allowedPhrases:'العبارات المستثناة',exemptMemberIds:'الاستثناءات الدائمة',
 flood:'إعدادات مكافحة الفلود',joinRaid:'حماية موجات الانضمام',
 night:'وضع الليل',raid:'حماية الهجمات',escalation:'تصعيد التحذيرات',
 temporaryExemptions:'الاستثناءات المؤقتة',ruleExemptions:'استثناءات القواعد'
};
const goodId=(id:string)=>/^-[1-9][0-9]{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
export function validOwnerNetworkPolicyDiffRoute(data:unknown):boolean{
 return typeof data==='string'&&Buffer.byteLength(data,'utf8')<=64&&
  [home,sources,targets,detail].some(r=>r.test(data));
}
export class OwnerNetworkPolicyDiffEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private overview(s:BotState,actor:string,id:string):NetworkSettingsOverview|null{
  return summarizeNetworkSettings(s,this.policy,actor,this.clock(),id);
 }
 private home(s:BotState,actor:string,id:string):OwnerInlineScreen|null{
  const data=this.overview(s,actor,id);if(!data)return null;
  return ui('<b>🧩 مقارنة إعدادات مجموعات الشبكة</b>\n'+
   'الشبكة: '+escape(data.networkName)+'\n'+
   'المجموعات المرتبطة: '+data.members.length+
   ' · المعتمدة حاليًا: '+data.current+
   ' · ارتباطات قديمة أو ملغاة: '+data.stale+'\n'+
   'السياسات غير الجاهزة للمقارنة: '+data.unavailablePolicies+'\n'+
   (data.emergencyStopped?'⛔ الشبكة في حالة إيقاف طوارئ؛ المقارنة متاحة للقراءة فقط.\n':'')+
   'اختر مجموعة مرجعية ثم مجموعة ثانية لعرض اختلافات الإعدادات دون كشف قيم الكلمات أو الروابط المحظورة.\n'+
   'المقارنة لا تحفظ لقطة ولا تسترجع سياسة ولا تغير عقوبات Telegram.',[
    [btn('📑 اختيار مجموعة مرجعية','nw:1:cp:'+id+':0')],
    [btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]
   ]);
 }
 private memberText(m:NetworkSettingsMember):string{
  return '<code>'+m.chatId+'</code>: '+(labelMember[m.status]??'غير آمنة')+
   (m.status==='CURRENT'?'، '+(labelPolicy[m.policyStatus]??'غير معروفة'):'');
 }
 private sourcePage(s:BotState,actor:string,id:string,p:number):OwnerInlineScreen|null{
  const data=this.overview(s,actor,id);
  if(!data||p>=Math.max(1,Math.ceil(data.members.length/SIZE)))return null;
  const visible=data.members.slice(p*SIZE,(p+1)*SIZE),rows=visible.filter(x=>x.status==='CURRENT')
   .map(x=>[btn('🔎 مرجع: '+x.chatId,'nw:1:cs:'+id+':'+x.chatId+':0')]);
  const pages=Math.max(1,Math.ceil(data.members.length/SIZE));
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:cp:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:cp:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ المقارنة','nw:1:ch:'+id)]);
  return ui('<b>📑 اختيار مجموعة مرجعية للمقارنة</b>\n'+
   'شبكة '+escape(data.networkName)+' · صفحة '+(p+1)+'/'+pages+'\n'+
   visible.map(x=>'• '+this.memberText(x)).join('\n')+'\n'+
   'الارتباطات القديمة والمكررة لا تمنح صلاحية مقارنة، ولا تظهر لها أزرار اختيار.',
   rows);
 }
 private targetPage(s:BotState,actor:string,id:string,source:string,p:number):
 OwnerInlineScreen|null{
  const data=this.overview(s,actor,id);
  if(!data||data.members.find(x=>x.chatId===source)?.status!=='CURRENT')return null;
  const all=data.members.filter(x=>x.chatId!==source),pages=Math.max(1,Math.ceil(all.length/SIZE));
  if(p>=pages)return null;
  const visible=all.slice(p*SIZE,(p+1)*SIZE),rows=visible.filter(x=>x.status==='CURRENT')
   .map(x=>[btn('↔️ قارن مع '+x.chatId,'nw:1:ct:'+id+':'+source+':'+x.chatId)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:cs:'+id+':'+source+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:cs:'+id+':'+source+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ اختيار مرجع آخر','nw:1:cp:'+id+':0')]);
  return ui('<b>🧩 اختر مجموعة للمقارنة</b>\n'+
   'المجموعة المرجعية: <code>'+source+'</code>\n'+
   'الشبكة: '+escape(data.networkName)+' · صفحة '+(p+1)+'/'+pages+'\n'+
   visible.map(x=>'• '+this.memberText(x)).join('\n')+'\n'+
   'تُقرأ الحالات مباشرة من قاعدة البيانات الحالية؛ لن تنشأ نسخة محفوظة.',
   rows);
 }
 private comparison(s:BotState,actor:string,id:string,a:string,b:string):
 OwnerInlineScreen|null{
  if(!goodId(a)||!goodId(b))return null;
  const over=this.overview(s,actor,id);
  const result=compareNetworkGroupSettings(s,this.policy,actor,this.clock(),id,a,b);
  if(!over||!result)return null;
  const lines=result.differences.map(x=>'• '+labelField[x.field]+
   ': المرجع «'+escape(x.source)+'» | المجموعة «'+escape(x.target)+'»');
  return ui('<b>🧩 مقارنة إعدادات مجموعتين</b>\n'+
   'الشبكة: '+escape(over.networkName)+'\n'+
   'المرجع: <code>'+a+'</code> · الهدف: <code>'+b+'</code>\n'+
   (result.emergencyStopped?'⛔ طوارئ الشبكة نشطة؛ القراءة لا تتأثر.\n':'')+
   'سياسة المرجع: '+labelPolicy[result.source.policyStatus]+' · سياسة الهدف: '+
   labelPolicy[result.target.policyStatus]+'\n'+
   (result.equivalent?'✅ الإعدادات متطابقة في الحقول المقارنة.\n':
    result.comparable?'⚠️ الاختلافات: '+lines.length+' حقول\n':
    '⚠️ مقارنة جزئية؛ لا يمكن الجزم بتطابق سياستين مع سجل مفقود أو قديم.\n')+
   (lines.length?lines.join('\n')+'\n':'')+
   'القيم الحساسة للكلمات والنطاقات والاستثناءات لا تُعرض؛ تُقارن قيمها داخليًا فقط.\n'+
   'هذه شاشة في وضع القراءة فقط. لا استرجاع ولا تعديل للسياسة ولا تنفيذ عبر Telegram.',[
    [btn('↩️ اختيار مجموعة أخرى','nw:1:cs:'+id+':'+a+':0')],
    [btn('📑 مجموعة مرجعية أخرى','nw:1:cp:'+id+':0')],
    [btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]
   ]);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!validOwnerNetworkPolicyDiffRoute(data)||!this.policy.isOwner(actor))return null;
  const s=await this.store.snapshot();
  const h=home.exec(data);if(h)return this.home(s,actor,h[1]!);
  const p=sources.exec(data);if(p)return this.sourcePage(s,actor,p[1]!,Number(p[2]));
  const t=targets.exec(data);
  if(t)return this.targetPage(s,actor,t[1]!,t[2]!,Number(t[3]));
  const d=detail.exec(data);
  if(d)return this.comparison(s,actor,d[1]!,d[2]!,d[3]!);
  return null;
 }
}
