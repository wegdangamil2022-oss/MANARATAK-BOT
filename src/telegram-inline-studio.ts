import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {ButtonStudioService,studioInputFields} from './button-studio.js';
import {studioId,type StudioSettings,type StudioTemplate,type StudioButton,type StudioAction} from './button-studio-model.js';
import type {StudioNativeKeyboard,StudioNativeButton} from './telegram-studio-rich.js';
import {renderStudentInline} from './telegram-inline-student.js';
import {studioPresets} from './button-studio-presets.js';
export interface OwnerStudioScreen extends OwnerInlineScreen{nativeKeyboard?:StudioNativeKeyboard;}
const n='(0|[1-9][0-9]{0,5})',rev='([1-9][0-9]{0,6})',id='([a-f0-9]{12})',mode='(0[1-9]|1[0-6])';
const patterns=[new RegExp('^st:1:l:'+mode+':'+n+'$','u'),/^st:1:n$/u,/^st:1:g:(?:education|welcome)$/u,/^st:1:c:[A-Za-z0-9_-]{24}$/u,
 new RegExp('^st:1:[dsvhj]:'+id+':'+rev+'$','u'),new RegExp('^st:1:v:'+id+':'+rev+':'+n+'$','u'),new RegExp('^st:1:e:'+mode+':'+id+':'+rev+'$','u'),
 new RegExp('^st:1:E:(?:01|02|04|06):'+id+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:i:'+id+':'+rev+':(?:NAME|TEXT|ADD_BUTTON|LAYOUT|TIMEZONE|(?:BUTTON_TITLE|TARGET|OPENS_AT|CLOSES_AT|SEATS):'+id+')$','u'),
 new RegExp('^st:1:[boxt]:'+id+':'+rev+':'+id+'$','u'),new RegExp('^st:1:k:'+id+':'+rev+':'+id+':(?:URL|COPY|INLINE|SERVICE|MINI_APP)$','u'),
 new RegExp('^st:1:u:'+id+':'+rev+':'+id+'$','u'),new RegExp('^st:1:w:'+id+':'+rev+':'+id+':'+n+'$','u'),new RegExp('^st:1:L:'+id+':'+rev+':'+id+':'+id+'$','u'),
 new RegExp('^st:1:y:'+id+':'+rev+':'+id+':(?:default|primary|success|danger)$','u'),new RegExp('^st:1:r:'+id+':'+rev+':'+rev+'$','u'),
 new RegExp('^st:1:f:'+id+':'+rev+':(?:12|24|gregory|islamic)$','u'),new RegExp('^st:1:a:'+id+':'+rev+':'+id+':(?:ANY|OWNER)$','u'),
 new RegExp('^st:1:m:'+id+':'+rev+':'+n+':'+n+'$','u'),new RegExp('^st:1:q:'+id+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:R:'+id+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:h:'+id+':'+rev+':'+n+'$','u'),new RegExp('^st:1:z:'+id+':'+rev+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:P:'+id+':'+rev+':[1-8]$','u'),new RegExp('^st:1:v:'+id+':'+rev+':'+n+':'+n+'$','u'),/^st:1:C$/u,
 new RegExp('^st:1:t:'+id+':'+rev+':'+id+':'+n+':'+n+'$','u'),
 new RegExp('^st:1:T:'+id+':'+rev+':'+id+':'+n+'$','u'),
 new RegExp('^st:1:D:'+rev+':'+n+'$','u'),new RegExp('^st:1:S:'+rev+':(?:defaultTemplateId:(?:none|'+id+')|(?:buttonLimit|rowsPerPage|inputSeconds|confirmationSeconds):'+n+'|colorsByFunction:[01])$','u')];
export function validStudioInlineRoute(data:string):boolean{return typeof data==='string'&&Buffer.byteLength(data)<=64&&patterns.some(re=>{const m=re.exec(data);return m?.[0]===data;});}
export const studioOwnerEntry=(data:string)=>/^mi:1:i:07:(?:0[1-9]|1[1256])$/u.test(data);
const b=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
export const studioEscape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const root=[b('↩️ الاستوديو','mi:1:s:07:0'),b('🏠 لوحة المالك','mi:1:h')];
const key=(action:string,t:StudioTemplate,tail='')=>'st:1:'+action+':'+t.id+':'+t.revision+(tail?':'+tail:'');
const edit=(t:StudioTemplate,field:string)=>key('i',t,field);
export function studioDraftScreen(t:StudioTemplate):OwnerInlineScreen{
 return ui('<b>مسودة القالب</b>\n'+studioEscape(t.draft.name)+'\nالنسخة الحالية: '+t.revision+'\nالأزرار: '+t.draft.buttons.length+'\nالصفوف: '+(t.draft.layout.join('-')||'فارغة')+'\nالإصدارات المحفوظة: '+t.versions.length,
 [[b('✏️ الاسم',edit(t,'NAME')),b('📝 النص',edit(t,'TEXT'))],[b('🔘 إضافة زر',edit(t,'ADD_BUTTON')),b('📐 الصفوف',edit(t,'LAYOUT'))],
 [b('🎛️ تحرير الأزرار',key('e',t).replace('st:1:e:','st:1:e:01:')),b('👁️ المعاينة',key('v',t))],
 [b('💾 حفظ إصدار',key('s',t)),b('📜 النسخ',key('h',t))],[b('📋 نسخ القالب',key('j',t))],[b('↩️ القوالب','st:1:l:09:0')],root]);
}
function buttonScreen(t:StudioTemplate,button:StudioButton):OwnerInlineScreen{
 const suffix=button.id,index=t.draft.buttons.findIndex(b=>b.id===button.id);
 const moves=[];if(index>0)moves.push(b('⬆️ تقديم الزر',key('m',t,(index)+':'+(index-1))));if(index+1<t.draft.buttons.length)moves.push(b('⬇️ تأخير الزر',key('m',t,index+':'+(index+1))));
 const target=Array.from(button.action.target),domain=button.action.kind==='URL'||button.action.kind==='MINI_APP'?new URL(button.action.target).hostname:'';
 return ui('<b>تحرير الزر</b>\nالاسم: '+studioEscape(button.title)+'\nالنوع: '+button.action.kind+(domain?'\nالنطاق: <code>'+studioEscape(domain)+'</code>':'')+'\nالهدف: '+studioEscape(target.slice(0,160).join(''))+(target.length>160?'…':'')+'\nالنمط: '+button.style+'\nالجمهور: '+button.condition.role+'\nالفتح: '+(button.condition.opensAt?new Date(button.condition.opensAt).toISOString():'دون حد')+'\nالإغلاق: '+(button.condition.closesAt?new Date(button.condition.closesAt).toISOString():'دون حد')+'\nالمقاعد: '+(button.condition.seats||'دون حد'),
 [[b('✏️ عنوان الزر',edit(t,'BUTTON_TITLE:'+suffix)),b('🎯 تعديل الهدف',edit(t,'TARGET:'+suffix))],[b('🔎 عرض الهدف كاملًا',key('T',t,suffix+':0'))],
 ...(['URL','COPY','INLINE','SERVICE','MINI_APP'] as const).map(k=>[b('النوع: '+k,key('k',t,suffix+':'+k))]),
 [b('🧭 فتح قائمة أخرى',key('u',t,suffix))],
 [b('افتراضي',key('y',t,suffix+':default')),b('🔵',key('y',t,suffix+':primary')),b('🟢',key('y',t,suffix+':success')),b('🔴',key('y',t,suffix+':danger'))],
 [b('للجميع',key('a',t,suffix+':ANY')),b('للمالك',key('a',t,suffix+':OWNER'))],
 [b('موعد الفتح',edit(t,'OPENS_AT:'+suffix)),b('موعد الإغلاق',edit(t,'CLOSES_AT:'+suffix)),b('المقاعد',edit(t,'SEATS:'+suffix))],
 ...(moves.length?[moves]:[]),
 [b('نسخ الزر',key('o',t,suffix)),b('حذف الزر',key('x',t,suffix))],[b('↩️ قائمة الأزرار','st:1:E:01:'+t.id+':'+t.revision+':'+Math.floor(index/8))],[b('↩️ المسودة',key('d',t))],root]);
}
export async function renderOwnerInlineStudio(store:BotStore,policy:Policy,actor:string,data:string,clock:()=>number):Promise<OwnerStudioScreen|null>{
 if(!policy.isOwner(actor))return null;
 const svc=new ButtonStudioService(store,policy,clock);let all:StudioTemplate[];try{all=await svc.list(actor);}catch{return null;}
 const main=studioOwnerEntry(data),parts=data.split(':');
 if(!main&&!validStudioInlineRoute(data))return null;
 if(main&&parts[4]==='16'||['C','S','D'].includes(parts[2]!)){
  try{
   await svc.cancelInput(actor);let settings=await svc.settings(actor);
   if(parts[2]==='S'){
    const field=parts[4] as Exclude<keyof StudioSettings,'revision'>,value=field==='defaultTemplateId'?(parts[5]==='none'?'':parts[5]!):field==='colorsByFunction'?parts[5]==='1':Number(parts[5]);
    settings=await svc.configure(actor,Number(parts[3]),field,value);
   }
   const set=(field:string,value:string|number)=>'st:1:S:'+settings.revision+':'+field+':'+value;
   if(parts[2]==='D'){
    const page=Number(parts[4]),pages=Math.max(1,Math.ceil(all.length/8));if(Number(parts[3])!==settings.revision||page>=pages)return null;
    const rows=all.slice(page*8,page*8+8).map(t=>[b(t.draft.name,set('defaultTemplateId',t.id))]);const nav=[];
    if(page)nav.push(b('السابق','st:1:D:'+settings.revision+':'+(page-1)));if(page+1<pages)nav.push(b('التالي','st:1:D:'+settings.revision+':'+(page+1)));if(nav.length)rows.push(nav);
    rows.push([b('دون قالب افتراضي',set('defaultTemplateId','none'))],[b('↩️ الإعدادات','st:1:C')],root);return ui('<b>القالب الافتراضي</b>\nتُنسخ مسودته عند إنشاء قالب جديد، دون نقل اعتماد أو سجل سابق.\nالصفحة '+(page+1)+' من '+pages,rows);
   }
   return ui('<b>إعدادات الاستوديو المحلية</b>\nنسخة الإعدادات: '+settings.revision+'\nالقالب الافتراضي: '+studioEscape(all.find(t=>t.id===settings.defaultTemplateId)?.draft.name??'دون قالب')+'\nحد الأزرار: '+settings.buttonLimit+'\nصفوف الصفحة الجديدة: '+settings.rowsPerPage+'\nألوان حسب الوظيفة: '+(settings.colorsByFunction?'مفعلة':'معطلة')+'\nالإدخال: '+settings.inputSeconds+' ثانية\nالتأكيد: '+settings.confirmationSeconds+' ثانية\nالتغييرات للعمليات الجديدة؛ النسخ المحفوظة لا تتغير.',[
    [b('القالب الافتراضي','st:1:D:'+settings.revision+':0')],
    [b('تبديل الألوان الوظيفية',set('colorsByFunction',settings.colorsByFunction?0:1))],
    ...(['buttonLimit','rowsPerPage','inputSeconds','confirmationSeconds'] as const).map(field=>
     (field==='buttonLimit'?[8,16,24]:field==='rowsPerPage'?[2,4,8]:field==='inputSeconds'?[60,300,600]:[30,60,120]).map(value=>b((field==='buttonLimit'?'أزرار ':field==='rowsPerPage'?'صفوف ':field==='inputSeconds'?'إدخال ':'تأكيد ')+value,set(field,value)))),root]);
  }catch{return null;}
 }
 if(main||parts[2]==='l'){
  await svc.cancelInput(actor);const m=main?parts[4]!:parts[3]!,page=main?0:Number(parts[4]),pages=Math.max(1,Math.ceil(all.length/8));if(page>=pages)return null;
  const rows=all.slice(page*8,page*8+8).map(t=>[b(t.draft.name,'st:1:e:'+m+':'+t.id+':'+t.revision)]);
  if(m==='07'&&page===0)rows.unshift(...studioPresets.map(p=>[b('➕ '+p.name+' · نموذج '+p.version,'st:1:g:'+p.id)]));
  rows.push([b('➕ إنشاء قالب','st:1:n')]);const nav=[];if(page)nav.push(b('السابق','st:1:l:'+m+':'+(page-1)));if(page+1<pages)nav.push(b('التالي','st:1:l:'+m+':'+(page+1)));if(nav.length)rows.push(nav);rows.push(root);
  return ui('<b>استوديو الأزرار والقوالب</b>\nاختر قالبًا لتحريره أو أنشئ قالبًا جديدًا.\nالصفحة '+(page+1)+' من '+pages+'\nالحفظ ينشئ إصدارًا محليًا؛ النشر يحتاج مساره المخوّل.',rows);
 }
 try{
  await svc.cancelInput(actor);
  if(parts[2]==='n')return studioDraftScreen(await svc.create(actor,'قالب جديد'));
  if(parts[2]==='g')return studioDraftScreen(await svc.create(actor,'نموذج',parts[3]!));
  if(parts[2]==='c'){const t=await svc.confirmDecision(actor,'c_'+parts[3]);return t?studioDraftScreen(t):null;}
  const mode=parts[2]==='e'||parts[2]==='E'?parts[3]:undefined,id=parts[mode?4:3]!,revision=Number(parts[mode?5:4]),t=all.find(t=>t.id===id&&t.revision===revision);if(!t||!studioId(id))return null;
  const action=parts[2],button=parts[5]?t.draft.buttons.find(b=>b.id===parts[5]):undefined;
  if(action==='d')return studioDraftScreen(t);
  if(action==='j')return studioDraftScreen(await svc.duplicate(actor,id,revision));
  if(action==='s')return studioDraftScreen(await svc.save(actor,id,revision));
  if(action==='i'){
   const field=parts[5] as typeof studioInputFields[number];await svc.beginInput(actor,id,revision,field,parts[6]??'');
   const help=field==='OPENS_AT'||field==='CLOSES_AT'?'اكتب الموعد بهذا الشكل: 2026-10-30T14:00:00+03:00، أو 0 لإلغاء حد الوقت.':field==='SEATS'?'اكتب عدد المقاعد من 1 إلى 1000000، أو 0 لعدد غير محدود. حجز المعاينة منفصل عن النشر.':field==='LAYOUT'?'اكتب توزيع الصفوف مثل 1-2 أو 2-2-1؛ يجب أن يساوي مجموعها عدد الأزرار.':field==='TIMEZONE'?'اكتب المنطقة الزمنية مثل Asia/Aden.':field==='TARGET'?'اكتب الهدف المناسب لنوع الزر: رابط HTTPS كامل، أو نص، أو مسار خدمة معتمد.':'اكتب القيمة الجديدة في رسالة. المتغيرات المسموحة: {العضو}، {اسم_المجموعة}، {التاريخ}، {الوقت}، {رابط_القوانين}.';
   return ui(help+'\nتنتهي خطوة الإدخال بعد '+(await svc.settings(actor)).inputSeconds+' ثانية.',[[b('إلغاء الإدخال والعودة',key('d',t))],root]);
  }
  if(action==='h'||mode==='15'){
   const page=action==='h'?Number(parts[5]??0):0,pages=Math.max(1,Math.ceil(t.versions.length/8));if(page>=pages)return null;
   const rows=[...t.versions].reverse().slice(page*8,page*8+8).map(v=>[b('نسخة '+v.revision+' · '+new Date(v.at).toISOString().slice(0,16),key('z',t,v.revision+':0'))]);
   const nav=[];if(page)nav.push(b('السابق',key('h',t,String(page-1))));if(page+1<pages)nav.push(b('التالي',key('h',t,String(page+1))));if(nav.length)rows.push(nav);rows.push([b('↩️ المسودة',key('d',t))],root);
   return ui('<b>سجل النسخ</b>\nالصفحة '+(page+1)+' من '+pages+'\nاختر نسخة لمقارنتها بالمسودة قبل الاستعادة. كل استعادة تحفظ إصدارًا جديدًا وتُسجل صاحب التغيير.',rows);
  }
  if(action==='z'){
   const v=t.versions.find(v=>v.revision===Number(parts[5])),page=Number(parts[6]);if(!v)return null;
   const describe=(c:StudioTemplate['draft'])=>JSON.stringify(c,null,2);
   const full='المسودة الحالية:\n'+describe(t.draft)+'\n\nالنسخة '+v.revision+'، صاحب الحفظ: '+v.by+'\n'+describe(v.content);
   const chars=Array.from(full),pages=Math.ceil(chars.length/240);if(page>=pages)return null;
   const nav=[];if(page)nav.push(b('السابق',key('z',t,v.revision+':'+(page-1))));if(page+1<pages)nav.push(b('التالي',key('z',t,v.revision+':'+(page+1))));
   return ui('<b>مقارنة النسخة والمسودة</b>\nالصفحة '+(page+1)+' من '+pages+'\n<pre>'+studioEscape(chars.slice(page*240,page*240+240).join(''))+'</pre>',[...(nav.length?[nav]:[]),[b('استعادة هذه النسخة',key('r',t,String(v.revision)))],[b('↩️ سجل النسخ',key('h',t,String(Math.floor((t.versions.length-1-t.versions.indexOf(v))/8))))],root]);
  }
  if(action==='r'||action==='x'){
   const target=parts[5]!,v=action==='r'?t.versions.find(v=>v.revision===Number(target)):undefined;if(action==='r'?!v:!button)return null;
   const ref=await svc.issueDecision(actor,id,revision,action==='r'?'RESTORE':'DELETE_BUTTON',target);
   return ui(action==='r'?'<b>معاينة الاستعادة</b>\nالقالب الحالي: '+studioEscape(t.draft.name)+'\nاسم النسخة المختارة: '+studioEscape(v!.content.name)+'\nعدد الأزرار: '+v!.content.buttons.length+'\nسيُحفظ إصدار جديد ولن تُمسح الإصدارات القديمة.':'<b>معاينة حذف الزر</b>\nسيُحذف من المسودة: '+studioEscape(button!.title),[[b('✅ تأكيد','st:1:c:'+ref.slice(2))],[b('إلغاء',key('d',t))],root]);
  }
  if(action==='b')return button?buttonScreen(t,button):null;
  if(action==='T'&&button){
   const chars=Array.from(button.action.target),page=Number(parts[6]),pages=Math.max(1,Math.ceil(chars.length/160));if(page>=pages)return null;
   const nav=[];if(page)nav.push(b('السابق',key('T',t,button.id+':'+(page-1))));if(page+1<pages)nav.push(b('التالي',key('T',t,button.id+':'+(page+1))));
   const url=button.action.kind==='URL'||button.action.kind==='MINI_APP',domain=url?new URL(button.action.target).hostname:'';
   return ui('<b>مراجعة هدف الزر</b>\n'+(domain?'النطاق: <code>'+studioEscape(domain)+'</code>\n':'')+'الصفحة '+(page+1)+' من '+pages+'\n<pre>'+studioEscape(chars.slice(page*160,page*160+160).join(''))+'</pre>'+(url?'\nفحص إعادة التوجيه واعتماد الرابط مطلوبان قبل النشر.':''),[...(nav.length?[nav]:[]),[b('↩️ تحرير الزر',key('b',t,button.id))],root]);
  }
  if((action==='u'||action==='w')&&button){
   const targets=all.filter(x=>x.id!==t.id),page=action==='w'?Number(parts[6]):0,pages=Math.max(1,Math.ceil(targets.length/8));if(page>=pages)return null;
   const rows=targets.slice(page*8,page*8+8).map(x=>[b(x.draft.name,key('L',t,button.id+':'+x.id))]);
   const nav=[];if(page)nav.push(b('السابق',key('w',t,button.id+':'+(page-1))));if(page+1<pages)nav.push(b('التالي',key('w',t,button.id+':'+(page+1))));if(nav.length)rows.push(nav);
   rows.push([b('↩️ الزر',key('b',t,button.id))],root);
   return ui('<b>ربط الزر بقائمة</b>\nاختر قالبًا آخر؛ يُفتح بإصداره الحالي وقت الضغط.\nالصفحة '+(page+1)+' من '+pages+(targets.length?'':'\nأنشئ قالبًا ثانيًا أولًا.'),rows);
  }
  if(action==='L'&&button){const next=await svc.edit(actor,id,revision,{kind:'ACTION',buttonId:button.id,action:{kind:'MENU',target:parts[6]!}});return buttonScreen(next,next.draft.buttons.find(b=>b.id===button.id)!);}
  if(action==='t'&&button){
   const textPage=Number(parts[6]??0),buttonPage=Number(parts[7]??0),backRoute=key('v',t,textPage+':'+buttonPage);
   const preview=await renderOwnerInlineStudio(store,policy,actor,backRoute,clock);
   if(!preview?.nativeKeyboard?.inline_keyboard.some(row=>row.some(item=>'callback_data' in item&&item.callback_data===data)))return null;
   await svc.pressPreview(actor,id,revision,button.id);
   if(button.action.kind==='MENU'){
    const target=(await svc.list(actor)).find(x=>x.id===button.action.target);if(!target)return null;
    const screen=await renderOwnerInlineStudio(store,policy,actor,key('v',target),clock);if(!screen)return null;
    const back=[b('↩️ القائمة السابقة',backRoute)];
    return {...screen,keyboard:{inline_keyboard:[...screen.keyboard.inline_keyboard,back]},...(screen.nativeKeyboard?{nativeKeyboard:{inline_keyboard:[...screen.nativeKeyboard.inline_keyboard,back]}}:{})};
   }
   if(button.action.kind==='SERVICE'){const screen=await renderStudentInline(store,policy,actor,button.action.target);return screen?{...screen,keyboard:{inline_keyboard:[...screen.keyboard.inline_keyboard,[b('↩️ المعاينة',backRoute)]]}}:null;}
   const text=button.action.kind==='URL'?'<a href="'+studioEscape(button.action.target)+'">'+studioEscape(button.title)+'</a>':button.action.kind==='MINI_APP'?'وجهة Mini App تحتاج اعتمادًا في مرحلة ربطها قبل فتحها.':studioEscape(button.action.target);
   return ui(text,[[b('↩️ المعاينة',backRoute)],root]);
  }
  if(action==='k'&&button){const kind=parts[6] as StudioAction['kind'];const target=kind==='URL'||kind==='MINI_APP'?'https://t.me/ManaratakEduBot':kind==='SERVICE'?'student:open':kind==='INLINE'?'منارتك':'نص الزر';const next=await svc.edit(actor,id,revision,{kind:'ACTION',buttonId:button.id,action:{kind,target}});return buttonScreen(next,next.draft.buttons.find(b=>b.id===button.id)!);}
  if(action==='y'&&button){const next=await svc.edit(actor,id,revision,{kind:'STYLE',buttonId:button.id,style:parts[6] as StudioButton['style']});return buttonScreen(next,next.draft.buttons.find(b=>b.id===button.id)!);}
  if(action==='a'&&button){const next=await svc.edit(actor,id,revision,{kind:'CONDITION',buttonId:button.id,condition:{...button.condition,role:parts[6] as 'ANY'|'OWNER'}});return buttonScreen(next,next.draft.buttons.find(b=>b.id===button.id)!);}
  if(action==='o'&&button)return studioDraftScreen(await svc.edit(actor,id,revision,{kind:'COPY_BUTTON',buttonId:button.id}));
  if(action==='m')return studioDraftScreen(await svc.edit(actor,id,revision,{kind:'MOVE_BUTTON',from:Number(parts[5]),to:Number(parts[6])}));
  if(action==='q')return studioDraftScreen(await svc.edit(actor,id,revision,{kind:'COPY_ROW',row:Number(parts[5])}));
  if(action==='P')return studioDraftScreen(await svc.edit(actor,id,revision,{kind:'PAGE_SIZE',rows:Number(parts[5])}));
  if(mode==='05')return ui('<b>القوائم والصفحات</b>\nعدد الصفوف في الصفحة: '+(t.draft.rowsPerPage??8)+'\nاختر كثافة الصفحة؛ تبقى الأزرار في صفوفها المرتبة.',[
   [b('تحرير روابط القوائم',key('e',t).replace('st:1:e:','st:1:e:04:'))],
   ...[1,2,3,4,5,6,7,8].map(size=>[b(size+' صفوف في الصفحة',key('P',t,String(size)))]),[b('👁️ اختبار الصفحات',key('v',t))],[b('↩️ المسودة',key('d',t))],root]);
  if(action==='f'){const v=parts[5]!;return studioDraftScreen(await svc.edit(actor,id,revision,{kind:'FORMAT',hour12:v==='12'?true:v==='24'?false:t.draft.hour12,calendar:v==='gregory'||v==='islamic'?v:t.draft.calendar}));}
  if(mode==='12')return ui('<b>التاريخ والوقت</b>\nالمنطقة: '+studioEscape(t.draft.timezone)+'\nالتوقيت: '+(t.draft.hour12?'12':'24')+'\nالتقويم: '+t.draft.calendar,[[b('12 ساعة',key('f',t,'12')),b('24 ساعة',key('f',t,'24'))],[b('ميلادي',key('f',t,'gregory')),b('هجري',key('f',t,'islamic'))],[b('المنطقة الزمنية',edit(t,'TIMEZONE'))],[b('↩️ المسودة',key('d',t))],root]);
  if(mode==='03'||action==='R'){
   const page=action==='R'?Number(parts[5]):0,pages=Math.max(1,Math.ceil(t.draft.layout.length/8));if(page>=pages)return null;
   const rows=[[b('كتابة توزيع الصفوف',edit(t,'LAYOUT'))],...t.draft.layout.slice(page*8,page*8+8).map((_,i)=>[b('نسخ الصف '+(page*8+i+1),key('q',t,String(page*8+i)))]),],nav=[];
   if(page)nav.push(b('السابق',key('R',t,String(page-1))));if(page+1<pages)nav.push(b('التالي',key('R',t,String(page+1))));if(nav.length)rows.push(nav);
   rows.push([b('↩️ المسودة',key('d',t))],root);
   return ui('<b>ترتيب الصفوف</b>\nالتوزيع الحالي: '+(t.draft.layout.join('-')||'فارغ')+'\nالصفحة '+(page+1)+' من '+pages,rows);
  }
  if((action==='e'||action==='E')&&['01','02','04','06'].includes(mode!)){
   const page=action==='E'?Number(parts[6]):0,pages=Math.max(1,Math.ceil(t.draft.buttons.length/8));if(page>=pages)return null;
   const rows=t.draft.buttons.slice(page*8,page*8+8).map(bt=>[b(bt.title,key('b',t,bt.id))]);
   const route=(p:number)=>'st:1:E:'+mode+':'+t.id+':'+t.revision+':'+p,nav=[];
   if(page)nav.push(b('السابق',route(page-1)));if(page+1<pages)nav.push(b('التالي',route(page+1)));if(nav.length)rows.push(nav);
   rows.push([b('إضافة زر',edit(t,'ADD_BUTTON'))],[b('↩️ المسودة',key('d',t))],root);
   return ui('<b>أزرار القالب</b>\nالصفحة '+(page+1)+' من '+pages+'\nاختر زرًا لتحرير عنوانه ووظيفته ونمطه وشرطه.',rows);
  }
  if(mode==='11')return ui('<b>المتغيرات المسموحة</b>\n{العضو}\n{اسم_المجموعة}\n{التاريخ}\n{الوقت}\n{رابط_القوانين}\nتُستبدل وفق النطاق أثناء العرض؛ لا تُنفذ تعبيرات برمجية.',[[b('تحرير نص القالب',edit(t,'TEXT'))],[b('↩️ المسودة',key('d',t))],root]);
  if(action==='v'||mode==='08'){
   const d=t.draft,fmt=(options:Intl.DateTimeFormatOptions)=>new Intl.DateTimeFormat('ar',{timeZone:d.timezone,calendar:d.calendar,...options}).format(clock());
   const text=d.text.replace(/\{العضو\}/gu,actor).replace(/\{اسم_المجموعة\}/gu,'معاينة خاصة').replace(/\{التاريخ\}/gu,fmt({year:'numeric',month:'2-digit',day:'2-digit'})).replace(/\{الوقت\}/gu,fmt({hour:'2-digit',minute:'2-digit',hour12:d.hour12})).replace(/\{رابط_القوانين\}/gu,'[يُحدد حسب المجموعة]');
   const chars=Array.from(text),page=action==='v'?Number(parts[5]??0):0,pages=Math.max(1,Math.ceil(chars.length/200));if(page>=pages)return null;
   const rowsPerPage=d.rowsPerPage??8,buttonPage=action==='v'?Number(parts[6]??0):0,buttonPages=Math.max(1,Math.ceil(d.layout.length/rowsPerPage));if(buttonPage>=buttonPages)return null;
   const route=(textPage:number,buttonsPage:number)=>key('v',t,textPage+':'+buttonsPage);
   const nav=[];if(page>0)nav.push(b('⬅️ النص السابق',route(page-1,buttonPage)));if(page+1<pages)nav.push(b('➡️ بقية النص',route(page+1,buttonPage)));
   const buttonNav=[];if(buttonPage)buttonNav.push(b('◀️ الأزرار السابقة',route(page,buttonPage-1)));if(buttonPage+1<buttonPages)buttonNav.push(b('▶️ الأزرار التالية',route(page,buttonPage+1)));
   const screen=ui('<b>معاينة القالب الخاصة</b>\nالنص ('+(page+1)+' من '+pages+'):\n'+studioEscape(chars.slice(page*200,page*200+200).join(''))+'\n\nعدد الأزرار: '+d.buttons.length+'\nالتوزيع: '+d.layout.join('-')+'\nالأنماط تُستخدم حيث يدعمها العميل؛ الشكل الاحتياطي قياسي.',[...(nav.length?[nav]:[]),[b('↩️ المسودة',key('d',t))],root]);
   const rows:StudioNativeButton[][]=[];let offset=0;
   for(const size of d.layout){rows.push(d.buttons.slice(offset,offset+size).map(bt=>{
    const base={text:bt.title,...(bt.style==='default'?{}:{style:bt.style})},c=bt.condition,conditional=c.role!=='ANY'||c.opensAt!==0||c.closesAt!==0||c.seats!==0;
    if(!conditional&&bt.action.kind==='URL')return {...base,url:bt.action.target};
    if(!conditional&&bt.action.kind==='COPY')return {...base,copy_text:{text:bt.action.target}};
    if(!conditional&&bt.action.kind==='INLINE')return {...base,switch_inline_query:bt.action.target};
    return {...base,callback_data:key('t',t,bt.id+':'+page+':'+buttonPage)};
   }));offset+=size;}
   const visible=rows.slice(buttonPage*rowsPerPage,(buttonPage+1)*rowsPerPage);
   const keyboard={inline_keyboard:[...(buttonNav.length?[buttonNav]:[]),...screen.keyboard.inline_keyboard]};
   visible.push(...keyboard.inline_keyboard.map(row=>row.map(bt=>({...bt}))));
   return {...screen,text:screen.text+'\nصفحة الأزرار '+(buttonPage+1)+' من '+buttonPages,keyboard,nativeKeyboard:{inline_keyboard:visible}};
  }
  return studioDraftScreen(t);
 }catch{return null;}
}
