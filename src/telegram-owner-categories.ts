import type {BotStore,BotState,EducationCategory} from './store.js';
import type {Policy} from './policy.js';
import type {EducationService} from './education.js';
import type {VerifiedAdminContext} from './education-admin.js';
import {categoryVisibilityFingerprint,categoryOrderFingerprint,categoryOrderPeers,ownerCategoryChoiceToken} from './education-category-policy.js';
import {menuLabels,type TelegramReplyKeyboard} from './telegram-menu.js';

export const ownerCategoryMenuLabel='🗂️ إدارة الأقسام';
type CategoryAction={kind:'detail'|'disableReview'|'disableConfirm'|'enableReview'|'enableConfirm'|
 'raiseReview'|'raiseConfirm'|'lowerReview'|'lowerConfirm';
 token:string;proof?:string;scopeRevision?:number;categoryRevision?:number};
export type CategoryPage={page:number;direction:'next'|'previous'};
const token='([A-Za-z0-9_-]{1,24}|~[a-f0-9]{16})';
const proof='(~[a-f0-9]{16})';
const number='(0|[1-9][0-9]{0,9})';
const detailRe=new RegExp('^🗂️ القسم · '+token+'$','u');
const patterns=[
 ['🔴 مراجعة التعطيل · ','disableReview'],
 ['⛔ تأكيد التعطيل · ','disableConfirm'],
 ['🟢 مراجعة التفعيل · ','enableReview'],
 ['✅ تأكيد التفعيل · ','enableConfirm'],
 ['⬆️ مراجعة الرفع · ','raiseReview'],
 ['✅ تأكيد الرفع · ','raiseConfirm'],
 ['⬇️ مراجعة الخفض · ','lowerReview'],
 ['✅ تأكيد الخفض · ','lowerConfirm']
] as const;
const actionRe=patterns.map(([prefix,kind])=>({
 kind,regex:new RegExp('^'+prefix+token+':'+proof+':'+number+':'+number+'$','u')
}));
const pageRe=/^(➡️ التالي|⬅️ السابق) · o:d:(0|[1-9][0-9]{0,2})$/u;
export function parseOwnerCategoryAction(input:string):CategoryAction|null{
 if(typeof input!=='string'||input.length>123)return null;
 let m=detailRe.exec(input);
 if(m)return {kind:'detail',token:m[1]!};
 for(const {kind,regex} of actionRe){
  m=regex.exec(input);
  if(m)return {kind,token:m[1]!,proof:m[2]!,
    scopeRevision:Number(m[3]!),categoryRevision:Number(m[4]!)};
 }
 return null;
}
export function parseOwnerCategoryPage(input:string):CategoryPage|null{
 if(typeof input!=='string'||input.length>48)return null;
 const m=pageRe.exec(input);
 if(!m)return null;
 return {page:Number(m[2]!),direction:m[1]==='➡️ التالي'?'next':'previous'};
}
export function isOwnerCategoryText(text:string):boolean{
 return text===ownerCategoryMenuLabel||text.startsWith('🗂️ القسم · ')||
  patterns.some(([prefix])=>text.startsWith(prefix))||
  text.startsWith('➡️ التالي · o:d:')||text.startsWith('⬅️ السابق · o:d:');
}
type Screen={text:string;keyboard:TelegramReplyKeyboard};
const safe=(x:string,max=105)=>x.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ')
 .trim().slice(0,max).replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
function screen(text:string,options:readonly string[]=[],pages:readonly string[]=[]):Screen{
 const rows:{text:string}[][]=[];
 for(let i=0;i<Math.min(options.length,10);i+=2)
  rows.push(options.slice(i,i+2).map(text=>({text})));
 if(pages.length)rows.push(pages.slice(0,2).map(text=>({text})));
 rows.push([{text:menuLabels.owner},{text:menuLabels.home}]);
 return {text,keyboard:{keyboard:rows,resize_keyboard:true,is_persistent:true}};
}
function pageText(page:number,direction:CategoryPage['direction']):string{
 if(!Number.isSafeInteger(page)||page<0||page>999)throw Error('INVALID_OWNER_CATEGORY_PAGE');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+' · o:d:'+page;
}
export class OwnerTelegramCategoryMenu{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly education:EducationService){}
 private authorized(s:BotState,c:EducationCategory):boolean{
  return c.scope==='private'||this.policy.canUseChat(s,c.scope,'navigation');
 }
 private scopeRevision(s:BotState,c:EducationCategory):number{
  return c.scope==='private'?0:this.policy.chatRevision(s,c.scope);
 }
 private parentVisible(s:BotState,c:EducationCategory,seen=new Set<string>()):boolean{
  if(!c.parentId)return true;
  if(seen.has(c.id))return false;seen.add(c.id);
  const parent=s.educationCategories.find(x=>x.id===c.parentId&&x.scope===c.scope);
  return Boolean(parent?.enabled&&this.parentVisible(s,parent,seen));
 }
 async handle(text:string,ctx:VerifiedAdminContext):Promise<Screen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return null;
  const state=await this.store.snapshot();
  const page=parseOwnerCategoryPage(text);
  const options=state.educationCategories.filter(c=>this.authorized(state,c))
   .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
  if(text===ownerCategoryMenuLabel||page){
   const pages=Math.ceil(options.length/10),current=page?.page??0;
   if(page&&(!pages||current>=pages||
    (page.direction==='next'&&current===0)||
    (page.direction==='previous'&&current===pages-1)))return null;
   return screen('<b>إدارة الأقسام التعليمية 🗂️</b>\n'
    +'الأقسام الموجودة في النطاقات المصرح بها: '+options.length+'\n'
    +'الأقسام المفعّلة مباشرة: '+options.filter(c=>c.enabled).length+'\n'
    +(pages?'صفحة '+(current+1)+' من '+pages+'\n':'')
    +'اختر قسمًا لمراجعة إظهاره أو تعطيله. لا نشر تلقائي ولا حذف للقنوات.',
    options.slice(current*10,current*10+10)
     .map(c=>'🗂️ القسم · '+ownerCategoryChoiceToken(c.id)),[
      ...(current>0?[pageText(current-1,'previous')]:[]),
      ...(current+1<pages?[pageText(current+1,'next')]:[])
     ]);
  }
  const action=parseOwnerCategoryAction(text);
  if(!action)return null;
  const matches=options.filter(c=>ownerCategoryChoiceToken(c.id)===action.token);
  if(matches.length!==1)return null;
  const cat=matches[0]!;
  const fp=categoryVisibilityFingerprint(cat),scopeRev=this.scopeRevision(state,cat);
  const categoryRev=cat.revision??0;
  const suffix=' · '+action.token+':'+fp+':'+scopeRev+':'+categoryRev;
  const parentsReady=this.parentVisible(state,cat);
  const enabling=!cat.enabled;
  const peers=categoryOrderPeers(state,cat);
  const peerIndex=peers.findIndex(c=>c.id===cat.id);
  const orderProof=categoryOrderFingerprint(state,cat);
  const moveSuffix=' · '+action.token+':'+orderProof+':'+scopeRev+':'+categoryRev;
  if(action.kind==='detail'){
   const currentStatus=cat.enabled?(parentsReady?'مفعّل':'مفعّل لكن الأب مخفي'):'معطّل';
   const impacts=state.educationResources.filter(r=>
    r.scope===cat.scope&&r.categoryId===cat.id&&r.status==='PUBLISHED').length;
   const choice=cat.enabled?'🔴 مراجعة التعطيل'+suffix:
    parentsReady?'🟢 مراجعة التفعيل'+suffix:null;
   const moves=[
    ...(peerIndex>0?['⬆️ مراجعة الرفع'+moveSuffix]:[]),
    ...(peerIndex>=0&&peerIndex<peers.length-1?['⬇️ مراجعة الخفض'+moveSuffix]:[])
   ];
   return screen('<b>تفاصيل القسم التعليمي 🗂️</b>\n'
    +'القسم: '+safe(cat.title)+'\n'
    +'المعرّف: '+safe(cat.id,64)+'\n'
    +'النطاق: '+safe(cat.scope,32)+'\n'
    +'الحالة المحلية: '+currentStatus+'\n'
    +'الترتيب الحالي بين الأقسام الشقيقة: '+(peerIndex+1)+' من '+peers.length+'\n'
    +'الموارد المنشورة مباشرة في هذا القسم: '+impacts+'\n'
    +'ترتيب الأقسام يُحدّث المكتبة المحلية فقط، ولا يُنشئ منشورات Telegram.\n'
    +'تعطيل الأب يخفي الأقسام التابعة أيضًا؛ يتطلب تفعيل الابن ظهور أبيه أولًا.',
    [...(choice?[choice]:[]),...moves,ownerCategoryMenuLabel]);
  }
  if(action.kind==='raiseReview'||action.kind==='raiseConfirm'||
    action.kind==='lowerReview'||action.kind==='lowerConfirm'){
   if(action.proof!==orderProof||action.scopeRevision!==scopeRev||
      action.categoryRevision!==categoryRev)return null;
   const up=action.kind.startsWith('raise');
   const direction=up?'up':'down';
   const index=peerIndex+(up?-1:1);
   const neighbor=peers[index];
   if(!neighbor)return null;
   if(action.kind==='raiseReview'||action.kind==='lowerReview'){
    const confirm=up?'✅ تأكيد الرفع'+moveSuffix:'✅ تأكيد الخفض'+moveSuffix;
    return screen('<b>مراجعة تغيير ترتيب القسم</b>\n'
     +'القسم المختار: '+safe(cat.title)+'\n'
     +'تبديل الموضع مع: '+safe(neighbor.title)+'\n'
     +'الاتجاه: '+(up?'رفع خطوة':'خفض خطوة')+'\n'
     +'التبديل يشمل الأشقاء في نفس النطاق والأب فقط.\n'
     +'المواد المعطّلة والمؤرشفة لا تُفعّل؛ لا نشر إلى Telegram.',
     [confirm,'🗂️ القسم · '+action.token]);
   }
   try{
    await this.education.moveCategoryIfCurrent(ctx.actorId,cat.id,direction,
     orderProof,scopeRev,categoryRev);
   }catch{return null;}
   return screen('<b>تم تحديث ترتيب القسم محليًا ✅</b>\n'
    +'القسم: '+safe(cat.title)+'\n'
    +'الحركة: '+(up?'رفع خطوة':'خفض خطوة')+'\n'
    +'لم تُعدّل منشورات Telegram، ولم تتغير صلاحيات القسم.',
    [ownerCategoryMenuLabel]);
  }
  const target=action.kind.startsWith('enable');
  if(target!==enabling||action.proof!==fp||
    action.scopeRevision!==scopeRev||action.categoryRevision!==categoryRev)return null;
  if(target&&!parentsReady)return null;
  if(action.kind==='disableReview'||action.kind==='enableReview'){
   const confirm=target?'✅ تأكيد التفعيل'+suffix:'⛔ تأكيد التعطيل'+suffix;
   return screen('<b>معاينة تغيير ظهور القسم</b>\n'
    +'القسم: '+safe(cat.title)+'\n'
    +'الإجراء: '+(target?'إظهار الموارد المنشورة المسموح بها':'إخفاء القسم وفروعه من التصفح')+'\n'
    +'المنشورات المؤرشفة لا تُعاد تلقائيًا.\n'
    +'لا تُرسل رسائل إلى Telegram ولا تعديلات لقنوات حية.',
    [confirm,'🗂️ القسم · '+action.token]);
  }
  try{
   await this.education.setCategoryEnabledIfCurrent(ctx.actorId,cat.id,target,
    fp,scopeRev,categoryRev);
  }catch{return null;}
  return screen('<b>تم تحديث ظهور القسم محليًا ✅</b>\n'
   +'القسم: '+safe(cat.title)+'\n'
   +'الحالة الجديدة: '+(target?'مفعّل':'معطّل')+'\n'
   +'لم يُنشر أي محتوى جديد ولم تُرسل رسائل إلى Telegram.',
   [ownerCategoryMenuLabel]);
 }
}
