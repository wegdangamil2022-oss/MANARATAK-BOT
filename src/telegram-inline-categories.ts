import {randomBytes} from 'node:crypto';
import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {EducationService} from './education.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {OwnerTelegramCategoryMenu,ownerCategoryMenuLabel,parseOwnerCategoryAction,parseOwnerCategoryPage} from './telegram-owner-categories.js';
import {ownerCategoryChoiceToken} from './education-category-policy.js';
import {menuLabels} from './telegram-menu.js';
import {EducationCategoryEditor} from './education-category-editor.js';
export function validOwnerCategoryInlineRoute(data:string):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data)>64)return false;
 const m=/^(?:ec:1:[hn]|ec:1:[rap]:[A-Za-z0-9_-]{24})$/u.exec(data);return m?.[0]===data;
}
const custom=(label:string)=>/^edit:(RENAME|CHILD|LANG|PARENT):([A-Za-z0-9_-]{1,24}|~[a-f0-9]{16})$/u.exec(label);
const prefix='category.ui:';
const button=(text:string,callback_data:string)=>({text,callback_data});
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
/** Reuses the existing category menu and service checks. Callback text is
 * stored server-side, owner-bound, short-lived and consumed before dispatch.
 * The service's metadata/sibling fingerprints still fence the actual write. */
export async function renderOwnerInlineCategories(store:BotStore,policy:Policy,education:EducationService,actor:string,data:string,clock:()=>number):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actor)||data!=='mi:1:i:10:16'&&!validOwnerCategoryInlineRoute(data))return null;
 try{
  const now=clock(),state=await store.snapshot();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!policy.privateFeature(state,'owner.dashboard',actor))return null;
  const editor=new EducationCategoryEditor(store,policy,clock);if(!data.startsWith('ec:1:p:'))await editor.cancel(actor);
  const pickerScreen=(view:{text:string;buttons:{text:string;callback_data:string}[]}):OwnerInlineScreen=>({text:view.text,keyboard:{inline_keyboard:[...view.buttons.map(b=>[b]),[button('إلغاء','ec:1:h')]]}});
  if(data.startsWith('ec:1:p:')){
   const choice=await editor.chooseParent(actor,'c_'+data.slice(7));if(!choice)return null;
   if(choice.kind==='PAGE')return pickerScreen(await editor.parentPicker(actor,choice.id,choice.returnPage,choice.page,choice.proof,choice.epoch));
   return {text:'<b>معاينة تغيير القسم الأب</b>\nالقسم الأب: '+escape(choice.name)+'\nلم يُحفظ التغيير بعد. ينتهي التأكيد بعد دقيقتين.',keyboard:{inline_keyboard:[[button('✅ تأكيد الحفظ','ec:1:a:'+choice.ref.slice(2))],[button('إلغاء','ec:1:h')]]}};
  }
  let label=ownerCategoryMenuLabel,returnPage=0;
  if(data==='ec:1:n')label='edit:ROOT';
  if(data.startsWith('ec:1:a:')){const changed=await editor.confirm(actor,'c_'+data.slice(7));if(!changed)return null;returnPage=changed.page;}
  if(data.startsWith('ec:1:r:')){
   const selected=await store.transaction(s=>{
    if(!policy.isOwner(actor)||!policy.privateFeature(s,'owner.dashboard',actor))return null;
    const rows=s.callbacks.filter(c=>c.ref==='c_'+data.slice(7)),c=rows[0];
    if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.used!==false||c.revoked!==false||c.oneShot!==true||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000||!c.action.startsWith(prefix))return null;
    const v:unknown=JSON.parse(c.action.slice(prefix.length));if(!Array.isArray(v)||v.length!==2||typeof v[0]!=='string'||/[\r\n]/u.test(v[0])||!Number.isSafeInteger(v[1])||v[1]<0||v[1]>999||v[0]!==ownerCategoryMenuLabel&&v[0]!=='edit:ROOT'&&!custom(v[0])&&!parseOwnerCategoryAction(v[0])&&!parseOwnerCategoryPage(v[0]))return null;
    c.used=true;return {label:v[0],page:v[1] as number};
   });if(!selected)return null;label=selected.label;returnPage=selected.page;
  }
  if(label==='edit:ROOT'||custom(label)){
   const m=custom(label),matches=m?state.educationCategories.filter(c=>ownerCategoryChoiceToken(c.id)===m[2]&&(c.scope==='private'||policy.canUseChat(state,c.scope,'navigation'))):[];
   if(m&&matches.length!==1)return null;
   await editor.begin(actor,m?m[1] as 'RENAME'|'CHILD'|'LANG'|'PARENT':'ROOT',matches[0]?.id??'',returnPage);
   if(m?.[1]==='PARENT'){
    try{return pickerScreen(await editor.parentPicker(actor,matches[0]!.id,returnPage));}catch{await editor.cancel(actor);return null;}
   }
   return {text:(m?.[1]==='PARENT'?'اكتب معرّف القسم الأب من بطاقة تفاصيله، أو 0 لجعل هذا القسم رئيسيًا. لا يُسمح بتغيير النطاق أو إنشاء دورة في الشجرة.':m?.[1]==='LANG'?'اكتب رمز اللغة مثل ar أو en أو fr.':'اكتب '+(m?.[1]==='RENAME'?'الاسم الجديد':'اسم القسم الجديد')+' في رسالة واحدة (100 حرف كحد أقصى).')+'\nستظهر معاينة قبل التأكيد، وتنتهي خطوة الإدخال بعد عشر دقائق.\nالقسم الرئيسي الجديد يُنشأ في مكتبة الخاص.',keyboard:{inline_keyboard:[[button('إلغاء الإدخال','ec:1:h')]]}};
  }
  const page=parseOwnerCategoryPage(label);if(page)returnPage=page.page;
  if(label===ownerCategoryMenuLabel&&returnPage>0)label='➡️ التالي · o:d:'+returnPage;
  const screen=await new OwnerTelegramCategoryMenu(store,policy,education).handle(label,{origin:'TELEGRAM_PRIVATE',actorId:actor,chatId:actor,verified:true});if(!screen)return null;
  const rows=await store.transaction(s=>{
   if(!policy.isOwner(actor)||!policy.privateFeature(s,'owner.dashboard',actor))throw Error('CATEGORY_UI_DENIED');
   s.callbacks=s.callbacks.filter(c=>!c.action.startsWith(prefix)||!Number.isSafeInteger(c.expiresAt)||c.expiresAt>now);
   const labels=screen.keyboard.keyboard.flat().map(b=>b.text).filter(t=>t!==menuLabels.owner&&t!==menuLabels.home);
   const chosen=parseOwnerCategoryAction(label);if(chosen?.kind==='detail')labels.push('edit:RENAME:'+chosen.token,'edit:CHILD:'+chosen.token,'edit:LANG:'+chosen.token,'edit:PARENT:'+chosen.token);
   if(s.callbacks.filter(c=>c.action.startsWith(prefix)&&c.expiresAt>now).length+labels.length>200)throw Error('CATEGORY_UI_LIMIT');
   return labels.map(text=>{
    const ref='c_'+randomBytes(18).toString('base64url');s.callbacks.push({ref,actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+120000,action:prefix+JSON.stringify([text,returnPage])});
    const action=parseOwnerCategoryAction(text),category=action?.kind==='detail'?s.educationCategories.find(c=>ownerCategoryChoiceToken(c.id)===action.token&&(c.scope==='private'||policy.canUseChat(s,c.scope,'navigation'))):undefined;
    const title=(text==='edit:ROOT'?'➕ قسم رئيسي في الخاص':custom(text)?.[1]==='PARENT'?'🌳 تغيير القسم الأب':custom(text)?.[1]==='LANG'?'🌐 لغة التصنيف':custom(text)?.[1]==='RENAME'?'✏️ تغيير الاسم':custom(text)?.[1]==='CHILD'?'➕ إضافة فرع':category?'🗂️ '+category.title:text.split(' · ')[0]!).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ');
    return [button(Array.from(title).slice(0,60).join(''),'ec:1:r:'+ref.slice(2))];
   });
  });
  if(label===ownerCategoryMenuLabel||parseOwnerCategoryPage(label))rows.push([button('➕ قسم رئيسي في الخاص','ec:1:n')]);
  rows.push([button('↻ تحديث القائمة','ec:1:h')],[button('↩️ التعليم والمكتبة','mi:1:s:10:1'),button('🏠 لوحة المالك','mi:1:h')]);
  return {text:screen.text+'\nتنتهي أزرار الاختيار بعد دقيقتين؛ يمكن تحديث القائمة.',keyboard:{inline_keyboard:rows}};
 }catch{return null;}
}
