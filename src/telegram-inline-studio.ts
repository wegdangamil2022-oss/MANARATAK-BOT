import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {ButtonStudioService,studioInputFields} from './button-studio.js';
import {studioId,type StudioSettings,type StudioTemplate,type StudioButton,type StudioAction} from './button-studio-model.js';
import type {StudioNativeKeyboard,StudioNativeButton} from './telegram-studio-rich.js';
import {renderStudentInline} from './telegram-inline-student.js';
import {studioPresets} from './button-studio-presets.js';
import {ownerPreviewCancelData} from './telegram-owner-preview-cancel.js';
import {randomBytes} from 'node:crypto';
import {studioComparisonText} from './studio-version-comparison.js';
export interface OwnerStudioScreen extends OwnerInlineScreen{nativeKeyboard?:StudioNativeKeyboard;}
const n='(0|[1-9][0-9]{0,5})',rev='([1-9][0-9]{0,6})',id='([a-f0-9]{12})',mode='(0[1-9]|1[0-6])';
const patterns=[/^st:1:N:[A-Za-z0-9_-]{24}$/u,new RegExp('^st:1:l:'+mode+':'+n+'$','u'),/^st:1:n$/u,/^st:1:g:(?:education|welcome)$/u,/^st:1:c:[A-Za-z0-9_-]{24}$/u,
 new RegExp('^st:1:A:'+rev+':'+n+'$','u'),new RegExp('^st:1:K:'+rev+':[A-Za-z0-9_-]{24}:'+n+'$','u'),/^st:1:F:[A-Za-z0-9_-]{24}$/u,
 new RegExp('^st:1:[dsvhj]:'+id+':'+rev+'$','u'),new RegExp('^st:1:v:'+id+':'+rev+':'+n+'$','u'),new RegExp('^st:1:e:'+mode+':'+id+':'+rev+'$','u'),
 new RegExp('^st:1:E:(?:01|02|04|06):'+id+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:i:'+id+':'+rev+':(?:NAME|TEXT|ADD_BUTTON|LAYOUT|TIMEZONE|(?:BUTTON_TITLE|TARGET|OPENS_AT|CLOSES_AT|SEATS):'+id+')$','u'),
 new RegExp('^st:1:[boxt]:'+id+':'+rev+':'+id+'$','u'),new RegExp('^st:1:k:'+id+':'+rev+':'+id+':(?:URL|COPY|INLINE|SERVICE|MINI_APP)$','u'),
 new RegExp('^st:1:H:'+id+':'+rev+':'+id+'$','u'),new RegExp('^st:1:J:'+id+':'+rev+':'+id+':[ascuef]$','u'),
 new RegExp('^st:1:[BV]:'+id+':'+rev+':'+id+':'+n+'$','u'),
 new RegExp('^st:1:u:'+id+':'+rev+':'+id+'$','u'),new RegExp('^st:1:w:'+id+':'+rev+':'+id+':'+n+'$','u'),new RegExp('^st:1:L:'+id+':'+rev+':'+id+':'+id+'$','u'),
 new RegExp('^st:1:y:'+id+':'+rev+':'+id+':(?:default|primary|success|danger)$','u'),new RegExp('^st:1:r:'+id+':'+rev+':'+rev+'$','u'),
 new RegExp('^st:1:f:'+id+':'+rev+':(?:12|24|gregory|islamic)$','u'),new RegExp('^st:1:a:'+id+':'+rev+':'+id+':(?:ANY|OWNER)$','u'),
 new RegExp('^st:1:m:'+id+':'+rev+':'+n+':'+n+'$','u'),new RegExp('^st:1:q:'+id+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:R:'+id+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:h:'+id+':'+rev+':'+n+'$','u'),new RegExp('^st:1:z:'+id+':'+rev+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:W:'+id+':'+rev+':'+rev+':'+n+'$','u'),new RegExp('^st:1:Q:'+id+':'+rev+':'+rev+':'+rev+':'+n+'$','u'),
 new RegExp('^st:1:P:'+id+':'+rev+':[1-8]$','u'),new RegExp('^st:1:v:'+id+':'+rev+':'+n+':'+n+'$','u'),/^st:1:C$/u,
 new RegExp('^st:1:t:'+id+':'+rev+':'+id+':'+n+':'+n+'$','u'),
 new RegExp('^st:1:T:'+id+':'+rev+':'+id+':'+n+'$','u'),
 new RegExp('^st:1:D:'+rev+':'+n+'$','u'),new RegExp('^st:1:S:'+rev+':(?:defaultTemplateId:(?:none|'+id+')|(?:buttonLimit|rowsPerPage|inputSeconds|confirmationSeconds):'+n+'|colorsByFunction:[01])$','u')];
export function validStudioInlineRoute(data:string):boolean{return typeof data==='string'&&Buffer.byteLength(data)<=64&&patterns.some(re=>{const m=re.exec(data);return m?.[0]===data;});}
export const studioOwnerEntry=(data:string)=>/^mi:1:i:07:(?:0[1-9]|1[1256])$/u.exec(data)?.[0]===data;
/** These selectors explicitly retain their catalogue mode. No actor or
 * permissions are inferred from it; the transport still authorizes first. */
export function studioCatalogueReturn(data:string):string|null{
 if(!validStudioInlineRoute(data))return null;const parts=data.split(':');
 if(['C','S','D','A','K','F'].includes(parts[2]!))return 'mi:1:s:07:1';
 if(['l','e','E'].includes(parts[2]!))return 'mi:1:s:07:'+(Number(parts[3])<=8?0:1);
 return null;
}
const b=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
export const studioEscape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const root=[b('↩️ الاستوديو','mi:1:s:07:0'),b('🏠 لوحة المالك','mi:1:h')];
const key=(action:string,t:StudioTemplate,tail='')=>'st:1:'+action+':'+t.id+':'+t.revision+(tail?':'+tail:'');
const edit=(t:StudioTemplate,field:string)=>key('i',t,field);
const previewRoute=(route:unknown):route is string=>typeof route==='string'&&/^st:1:[vt]:/u.test(route)&&validStudioInlineRoute(route);
/** Context is stored server-side, bounded and actor-owned; callbacks never contain a client-supplied path. */
async function withTrail(store:BotStore,actor:string,screen:OwnerStudioScreen,trail:string[],clock:()=>number,previous=true):Promise<OwnerStudioScreen|null>{
 if(!trail.length)return screen;
 if(trail.length>8)return null;
 return store.transaction(s=>{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)return null;
  s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith('studio-nav:')||c.expiresAt>now);
  const owned=s.callbacks.filter(c=>c.ref.startsWith('studio-nav:')&&c.actorId===actor);
  const routes=new Map<string,string>();
  const wrap=(route:string,path:string[])=>{
   const identity=JSON.stringify({route,trail:path});let value=routes.get(identity);if(value)return value;
   const nonce=randomBytes(18).toString('base64url');value='st:1:N:'+nonce;routes.set(identity,value);
   s.callbacks.push({ref:'studio-nav:'+nonce,action:'studio.navigation:'+identity,actorId:actor,chatId:'private',policyVersion:0,expiresAt:now+120000,oneShot:false,used:false,revoked:false});return value;
  };
  const transform=<T extends {text:string}>(rows:readonly (readonly T[])[]):T[][]=>rows.map(row=>row.map(item=>'callback_data' in item&&typeof item.callback_data==='string'&&previewRoute(item.callback_data)?{...item,callback_data:wrap(item.callback_data,trail)}:item));
  const back=previous?[[b('↩️ القائمة السابقة',wrap(trail.at(-1)!,trail.slice(0,-1)))]]:[];
  const result={...screen,keyboard:{inline_keyboard:[...transform(screen.keyboard.inline_keyboard),...back]},...(screen.nativeKeyboard?{nativeKeyboard:{inline_keyboard:[...transform(screen.nativeKeyboard.inline_keyboard),...back]}}:{})};
  const excess=owned.length+routes.size-128;if(excess>0){const remove=new Set(owned.slice(0,excess).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));}
  return result;
 });
}
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
 [b('🎓 اختيار خدمة تعليمية',key('H',t,suffix))],
 [b('🧭 فتح قائمة أخرى',key('u',t,suffix))],
 [b('افتراضي',key('y',t,suffix+':default')),b('🔵',key('y',t,suffix+':primary')),b('🟢',key('y',t,suffix+':success')),b('🔴',key('y',t,suffix+':danger'))],
 [b('للجميع',key('a',t,suffix+':ANY')),b('للمالك',key('a',t,suffix+':OWNER'))],
 [b('موعد الفتح',edit(t,'OPENS_AT:'+suffix)),b('موعد الإغلاق',edit(t,'CLOSES_AT:'+suffix)),b('المقاعد',edit(t,'SEATS:'+suffix))],
 [b('↔️ نقل إلى صف',key('B',t,suffix+':0'))],
 ...(moves.length?[moves]:[]),
 [b('نسخ الزر',key('o',t,suffix)),b('حذف الزر',key('x',t,suffix))],[b('↩️ قائمة الأزرار','st:1:E:01:'+t.id+':'+t.revision+':'+Math.floor(index/8))],[b('↩️ المسودة',key('d',t))],root]);
}
export async function renderOwnerInlineStudio(store:BotStore,policy:Policy,actor:string,data:string,clock:()=>number,trail:string[]=[]):Promise<OwnerStudioScreen|null>{
 if(!policy.isOwner(actor))return null;
 if(/^st:1:N:/u.test(data)){
  if(!validStudioInlineRoute(data))return null;
  const state=await store.snapshot(),matches=state.callbacks.filter(c=>c.ref==='studio-nav:'+data.slice(7)),c=matches[0],now=clock();
  if(matches.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.oneShot!==false||c.used!==false||c.revoked!==false||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000||!c.action.startsWith('studio.navigation:'))return null;
  try{const path=JSON.parse(c.action.slice('studio.navigation:'.length)) as {route:unknown;trail:unknown};
   if(!previewRoute(path.route)||!Array.isArray(path.trail)||path.trail.length>8||!path.trail.every(r=>previewRoute(r)&&r.startsWith('st:1:v:')))return null;
   if(!path.trail.every(r=>{const p=r.split(':');return state.buttonStudio?.templates.some(t=>t.id===p[3]&&t.revision===Number(p[4]));}))return null;
   return renderOwnerInlineStudio(store,policy,actor,path.route,clock,path.trail);
  }catch{return null;}
 }
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
    [b('📜 سجل الإعدادات واستعادتها','st:1:A:'+settings.revision+':0')],
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
  if(parts[2]==='F'){const restored=await svc.confirmSettingsRestore(actor,'c_'+parts[3]);if(!restored)return null;const screen=await renderOwnerInlineStudio(store,policy,actor,'st:1:C',clock);return screen?{...screen,text:'استُعيدت إعدادات الاستوديو بإصدار جديد.\n'+screen.text}:null;}
  if(parts[2]==='A'||parts[2]==='K'){
   const revision=Number(parts[3]),page=Number(parts[parts[2]==='A'?4:5]),history=await svc.settingsHistory(actor,revision),pages=Math.max(1,Math.ceil(history.length/8));if(page>=pages)return null;
   const route=(p:number)=>'st:1:A:'+revision+':'+p;
   if(parts[2]==='A'){
    const rows=history.slice(page*8,page*8+8).map(h=>[b('إعدادات ما قبل الإصدار '+h.after.revision,'st:1:K:'+revision+':'+h.nonce+':'+page)]),nav=[];
    if(page)nav.push(b('السابق',route(page-1)));if(page+1<pages)nav.push(b('التالي',route(page+1)));if(nav.length)rows.push(nav);rows.push([b('↩️ الإعدادات','st:1:C')],root);
    return ui('<b>سجل إعدادات الاستوديو</b>\nالإصدار الحالي: '+revision+'\nالصفحة '+(page+1)+' من '+pages+'\nتُعرض التغييرات ذات القيم السابقة الموثقة فقط؛ لا يمكن استعادة تغييرات قديمة بلا هذا السجل.'+(history.length?'':'\nلا يوجد تغيير موثق قابل للاستعادة.'),rows);
   }
   const source=history.slice(page*8,page*8+8).find(h=>h.nonce===parts[4]);if(!source)return null;
   const decision=await svc.issueSettingsRestore(actor,revision,source.nonce),describe=(settings:StudioSettings)=>
    'القالب الافتراضي: '+studioEscape(settings.defaultTemplateId?(all.find(t=>t.id===settings.defaultTemplateId)?.draft.name??'غير متاح'):'دون قالب')+'\nحد الأزرار: '+settings.buttonLimit+'\nصفوف الصفحة الجديدة: '+settings.rowsPerPage+'\nالألوان الوظيفية: '+(settings.colorsByFunction?'مفعلة':'معطلة')+'\nالإدخال: '+settings.inputSeconds+' ثانية\nالتأكيد: '+settings.confirmationSeconds+' ثانية';
   return ui('<b>معاينة استعادة إعدادات الاستوديو</b>\nالقيم السابقة قبل الإصدار '+source.after.revision+'\nالمعدّل: '+studioEscape(source.by)+'\nالتاريخ: '+new Date(source.at).toISOString()+'\n\n<b>الحالي</b>\n'+describe(decision.current)+'\n\n<b>بعد الاستعادة</b>\n'+describe(decision.next)+'\n\nتُحفظ الاستعادة بإصدار جديد دون تعديل القوالب أو حذف السجل. يتوقف التأكيد إذا تغيرت الإعدادات أو القوالب.\nالتأكيد صالح '+decision.current.confirmationSeconds+' ثانية.',[
    [b('✅ تأكيد الاستعادة','st:1:F:'+decision.ref.slice(2)),b('إلغاء الاستعادة',ownerPreviewCancelData(decision.ref))],[b('↩️ السجل',route(page))],root]);
  }
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
  if(action==='W'){
   const selected=t.versions.find(v=>v.revision===Number(parts[5])),page=Number(parts[6]);if(!selected)return null;
   const others=[...t.versions].reverse().filter(v=>v!==selected),pages=Math.max(1,Math.ceil(others.length/8));if(page>=pages)return null;
   const rows=others.slice(page*8,page*8+8).map(v=>[b('نسخة '+v.revision+' · '+new Date(v.at).toISOString().slice(0,16),key('Q',t,selected.revision+':'+v.revision+':0'))]),nav=[];
   if(page)nav.push(b('السابق',key('W',t,selected.revision+':'+(page-1))));if(page+1<pages)nav.push(b('التالي',key('W',t,selected.revision+':'+(page+1))));if(nav.length)rows.push(nav);
   rows.push([b('↩️ مقارنة المسودة',key('z',t,selected.revision+':0'))],root);
   return ui('<b>اختيار نسخة للمقارنة</b>\nالنسخة الأولى: '+selected.revision+'\nاختر النسخة الثانية.\nالصفحة '+(page+1)+' من '+pages+(others.length?'':'\nلا توجد نسخة محفوظة أخرى بعد.'),rows);
  }
  if(action==='Q'){
   const first=t.versions.find(v=>v.revision===Number(parts[5])),second=t.versions.find(v=>v.revision===Number(parts[6])),page=Number(parts[7]);if(!first||!second||first===second)return null;
   const label=(v:typeof first)=>'النسخة '+v.revision+'، صاحب الحفظ: '+v.by+'، التاريخ: '+new Date(v.at).toISOString();
   const chars=Array.from(studioComparisonText(first.content,second.content,label(first),label(second))),pages=Math.ceil(chars.length/600);if(page>=pages)return null;
   const route=(p:number)=>key('Q',t,first.revision+':'+second.revision+':'+p),nav=[];
   if(page)nav.push(b('السابق',route(page-1)));if(page+1<pages)nav.push(b('التالي',route(page+1)));
   return ui('<b>مقارنة نسختين محفوظتين</b>\nالنسخة '+first.revision+' ← النسخة '+second.revision+'\nالصفحة '+(page+1)+' من '+pages+'\n<pre>'+studioEscape(chars.slice(page*600,page*600+600).join(''))+'</pre>',[
    ...(nav.length?[nav]:[]),[b('استعادة النسخة '+first.revision,key('r',t,String(first.revision))),b('استعادة النسخة '+second.revision,key('r',t,String(second.revision)))],
    [b('↩️ اختيار النسخة الثانية',key('W',t,first.revision+':'+Math.floor(([...t.versions].reverse().filter(v=>v!==first).indexOf(second))/8)))],root]);
  }
  if(action==='z'){
   const v=t.versions.find(v=>v.revision===Number(parts[5])),page=Number(parts[6]);if(!v)return null;
   const full=studioComparisonText(v.content,t.draft,'النسخة '+v.revision+'، صاحب الحفظ: '+v.by+'، التاريخ: '+new Date(v.at).toISOString(),'المسودة الحالية:');
   const chars=Array.from(full),pages=Math.ceil(chars.length/600);if(page>=pages)return null;
   const nav=[];if(page)nav.push(b('السابق',key('z',t,v.revision+':'+(page-1))));if(page+1<pages)nav.push(b('التالي',key('z',t,v.revision+':'+(page+1))));
   return ui('<b>مقارنة النسخة والمسودة</b>\nالصفحة '+(page+1)+' من '+pages+'\n<pre>'+studioEscape(chars.slice(page*600,page*600+600).join(''))+'</pre>',[...(nav.length?[nav]:[]),[b('🔎 مقارنة بنسخة محفوظة',key('W',t,v.revision+':0'))],[b('استعادة هذه النسخة',key('r',t,String(v.revision)))],[b('↩️ سجل النسخ',key('h',t,String(Math.floor((t.versions.length-1-t.versions.indexOf(v))/8))))],root]);
  }
  if(action==='r'||action==='x'){
   const target=parts[5]!,v=action==='r'?t.versions.find(v=>v.revision===Number(target)):undefined;if(action==='r'?!v:!button)return null;
   const ref=await svc.issueDecision(actor,id,revision,action==='r'?'RESTORE':'DELETE_BUTTON',target);
   return ui(action==='r'?'<b>معاينة الاستعادة</b>\nالقالب الحالي: '+studioEscape(t.draft.name)+'\nاسم النسخة المختارة: '+studioEscape(v!.content.name)+'\nعدد الأزرار: '+v!.content.buttons.length+'\nسيُحفظ إصدار جديد ولن تُمسح الإصدارات القديمة.':'<b>معاينة حذف الزر</b>\nسيُحذف من المسودة: '+studioEscape(button!.title),[[b('✅ تأكيد','st:1:c:'+ref.slice(2))],[b('إلغاء',ownerPreviewCancelData(ref))],root]);
  }
  if(action==='b')return button?buttonScreen(t,button):null;
  if(action==='H'&&button){
   const options=[['a','مكتبة الطالب'],['s','المنح الدراسية'],['u','الجامعات والتخصصات'],['c','الدورات التعليمية'],['e','الاختبارات'],['f','الملفات والنماذج']] as const;
   return ui('<b>اختيار الخدمة التعليمية</b>\nاختر الوجهة من مكتبة الطالب المحلية. لا يُنشأ نشر ولا اتصال بمنصة الإنتاج.',[...options.map(([code,title])=>[b(title,key('J',t,button.id+':'+code))]),[b('↩️ تحرير الزر',key('b',t,button.id))],root]);
  }
  if(action==='J'&&button){
   const code=parts[6]!,target=code==='a'?'student:open':'si:2:'+code+':h';
   const next=await svc.edit(actor,id,revision,{kind:'ACTION',buttonId:button.id,action:{kind:'SERVICE',target}});
   return buttonScreen(next,next.draft.buttons.find(item=>item.id===button.id)!);
  }
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
   if(button.action.kind==='MENU'&&trail.length>=8)return null;
   await svc.pressPreview(actor,id,revision,button.id);
   if(button.action.kind==='MENU'){
    const target=(await svc.list(actor)).find(x=>x.id===button.action.target);if(!target)return null;
    return renderOwnerInlineStudio(store,policy,actor,key('v',target),clock,[...trail,backRoute]);
   }
   if(button.action.kind==='SERVICE'){const screen=await renderStudentInline(store,policy,actor,button.action.target);return screen?withTrail(store,actor,{...screen,keyboard:{inline_keyboard:[...screen.keyboard.inline_keyboard,[b('↩️ المعاينة',backRoute)]]}},trail,clock,false):null;}
   const text=button.action.kind==='URL'?'<a href="'+studioEscape(button.action.target)+'">'+studioEscape(button.title)+'</a>':button.action.kind==='MINI_APP'?'وجهة Mini App تحتاج اعتمادًا في مرحلة ربطها قبل فتحها.':studioEscape(button.action.target);
   return withTrail(store,actor,ui(text,[[b('↩️ المعاينة',backRoute)],root]),trail,clock,false);
  }
  if(action==='B'&&button){
   const page=Number(parts[6]),rows:StudioButton[][]=[];let offset=0;
   for(const size of t.draft.layout){rows.push(t.draft.buttons.slice(offset,offset+size));offset+=size;}
   const source=rows.findIndex(row=>row.some(b=>b.id===button.id)),targets=rows.flatMap((row,i)=>i!==source&&row.length<3?[{row:i,title:'الصف '+(i+1)+' ('+row.length+'/3): '+Array.from(row.map(b=>b.title).join(' · ')).slice(0,40).join('')}]:[]);
   if(source!==rows.length-1||rows[source]!.length>1)targets.push({row:rows.length,title:'➕ صف جديد في النهاية'});
   const pages=Math.max(1,Math.ceil(targets.length/8));if(page>=pages)return null;
   const choices=targets.slice(page*8,page*8+8).map(target=>[b(target.title,key('V',t,button.id+':'+target.row))]),nav=[];
   if(page)nav.push(b('السابق',key('B',t,button.id+':'+(page-1))));if(page+1<pages)nav.push(b('التالي',key('B',t,button.id+':'+(page+1))));if(nav.length)choices.push(nav);
   choices.push([b('↩️ تحرير الزر',key('b',t,button.id))],root);
   return ui('<b>نقل الزر إلى صف</b>\nالزر: '+studioEscape(button.title)+'\nالصف الحالي: '+(source+1)+'\nيُنقل إلى نهاية الصف المختار. يُحذف صفه السابق إذا أصبح فارغًا؛ تبقى بقية الصفوف بترتيبها.\nالصفحة '+(page+1)+' من '+pages+(targets.length?'':'\nلا يوجد صف آخر متاح؛ الحد ثلاثة أزرار لكل صف.'),choices);
  }
  if(action==='V'&&button){const next=await svc.edit(actor,id,revision,{kind:'PLACE_BUTTON',buttonId:button.id,row:Number(parts[6])});const screen=buttonScreen(next,next.draft.buttons.find(b=>b.id===button.id)!);return {...screen,text:'نُقل الزر إلى الصف المطلوب.\n'+screen.text};}
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
   const rows=[[b('كتابة توزيع الصفوف',edit(t,'LAYOUT'))],[b('↔️ اختيار زر لنقله',key('e',t).replace('st:1:e:','st:1:e:01:'))],...t.draft.layout.slice(page*8,page*8+8).map((_,i)=>[b('نسخ الصف '+(page*8+i+1),key('q',t,String(page*8+i)))]),],nav=[];
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
   return withTrail(store,actor,{...screen,text:screen.text+'\nصفحة الأزرار '+(buttonPage+1)+' من '+buttonPages,keyboard,nativeKeyboard:{inline_keyboard:visible}},trail,clock);
  }
  return studioDraftScreen(t);
 }catch{return null;}
}
