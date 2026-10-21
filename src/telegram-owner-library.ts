import type {BotStore,BotState,EducationResource} from './store.js';
import type {Policy} from './policy.js';
import type {EducationService} from './education.js';
import type {VerifiedAdminContext} from './education-admin.js';
import {resourceArchiveFingerprint} from './education-archive.js';
import {menuLabels,type TelegramReplyKeyboard} from './telegram-menu.js';

export const ownerLibraryLabel='📚 إدارة المكتبة';
type LibraryAction={kind:'detail'|'review'|'confirm';id:string;token?:string;policyVersion?:number};
export type LibraryPage={page:number;direction:'next'|'previous'};
const uuid='([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
const hash='(~[a-f0-9]{16})';
const rev='(0|[1-9][0-9]{0,9})';
const detailRe=new RegExp('^📚 المورد · '+uuid+'$','u');
const reviewRe=new RegExp('^🗃️ معاينة الأرشفة · '+uuid+':'+hash+':'+rev+'$','u');
const confirmRe=new RegExp('^⛔ تأكيد الأرشفة · '+uuid+':'+hash+':'+rev+'$','u');
const pageRe=/^(➡️ التالي|⬅️ السابق) · o:l:(0|[1-9][0-9]{0,2})$/u;
export function parseOwnerLibraryAction(text:string):LibraryAction|null{
 if(typeof text!=='string'||text.length>130)return null;
 let m=detailRe.exec(text);
 if(m)return {kind:'detail',id:m[1]!};
 for(const [re,kind] of [[reviewRe,'review'],[confirmRe,'confirm']] as const){
  m=re.exec(text);
  if(m)return {kind,id:m[1]!,token:m[2]!,policyVersion:Number(m[3]!)};
 }
 return null;
}
export function parseOwnerLibraryPage(text:string):LibraryPage|null{
 if(typeof text!=='string'||text.length>45)return null;
 const m=pageRe.exec(text);
 if(!m)return null;
 return {page:Number(m[2]!),direction:m[1]==='➡️ التالي'?'next':'previous'};
}
export function isOwnerLibraryText(text:string):boolean{
 return text===ownerLibraryLabel||text.startsWith('📚 المورد · ')||
  text.startsWith('🗃️ معاينة الأرشفة · ')||text.startsWith('⛔ تأكيد الأرشفة · ')||
  text.startsWith('➡️ التالي · o:l:')||text.startsWith('⬅️ السابق · o:l:');
}
const escape=(text:string)=>text.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const visible=(s:string,max:number)=>escape(s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim().slice(0,max));
type Screen={text:string;keyboard:TelegramReplyKeyboard};
function screen(text:string,options:readonly string[]=[],nav:readonly string[]=[]):Screen{
 const rows:{text:string}[][]=[];
 for(let i=0;i<Math.min(options.length,10);i+=2)
  rows.push(options.slice(i,i+2).map(text=>({text})));
 if(nav.length)rows.push(nav.slice(0,2).map(text=>({text})));
 rows.push([{text:menuLabels.owner},{text:menuLabels.home}]);
 return {text,keyboard:{keyboard:rows,resize_keyboard:true,is_persistent:true}};
}
function pageText(page:number,direction:LibraryPage['direction']):string{
 if(page<0||page>999)throw Error('OWNER_LIBRARY_INVALID_PAGE');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+' · o:l:'+page;
}
export class OwnerTelegramLibraryMenu{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly education:EducationService){}
 private accessible(s:BotState,r:EducationResource):boolean{
  return r.status==='PUBLISHED'&&(r.scope==='private'||this.policy.canUseChat(s,r.scope,'navigation'));
 }
 private scopeRevision(s:BotState,r:EducationResource):number{
  return r.scope==='private'?0:this.policy.chatRevision(s,r.scope);
 }
 async handle(text:string,ctx:VerifiedAdminContext):Promise<Screen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return null;
  const state=await this.store.snapshot();
  const page=parseOwnerLibraryPage(text);
  if(text===ownerLibraryLabel||page){
   const published=state.educationResources.filter(r=>this.accessible(state,r))
    .sort((a,b)=>a.title.localeCompare(b.title,'ar')||a.id.localeCompare(b.id));
   const totalPages=Math.ceil(published.length/10),i=page?.page??0;
   if(page&&(!totalPages||i>=totalPages||
      (page.direction==='next'&&i===0)||
      (page.direction==='previous'&&i===totalPages-1)))return null;
   const current=published.slice(i*10,i*10+10);
   const nav=[
    ...(i>0?[pageText(i-1,'previous')]:[]),
    ...(i+1<totalPages?[pageText(i+1,'next')]:[])
   ];
   return screen('<b>إدارة المكتبة 📚</b>\n'
    +'الموارد المنشورة داخل النطاقات المصرح بها: '+published.length+'\n'
    +'الموارد المؤرشفة محليًا: '+state.educationResources.filter(r=>r.status==='ARCHIVED').length+'\n'
    +'الأقسام المفعلة: '+state.educationCategories.filter(c=>c.enabled).length+'\n'
    +(totalPages?'صفحة '+(i+1)+' من '+totalPages+'\n':'')
    +'اختر موردًا لمراجعة أرشفته. لا تُحذف الملفات ولا تُرسل رسائل للقنوات.',
    current.map(r=>'📚 المورد · '+r.id),nav);
  }
  const action=parseOwnerLibraryAction(text);
  if(!action)return null;
  const resource=state.educationResources.find(r=>r.id===action.id);
  if(!resource||!this.accessible(state,resource))return null;
  const epoch=this.scopeRevision(state,resource);
  const fingerprint=resourceArchiveFingerprint(resource);
  const archiveCommand='🗃️ معاينة الأرشفة · '+resource.id+':'+fingerprint+':'+epoch;
  const confirmedCommand='⛔ تأكيد الأرشفة · '+resource.id+':'+fingerprint+':'+epoch;
  if(action.kind==='detail')
   return screen('<b>المورد المنشور 📚</b>\n'
    +'العنوان: '+visible(resource.title,110)+'\n'
    +'الجامعة: '+visible(resource.university,90)+'\n'
    +'القسم: '+visible(resource.categoryId,64)+'\n'
    +'النطاق: '+visible(resource.scope,24)+'\n'
    +'الحالة: منشور في المكتبة المحلية فقط.\n'
    +'لن يؤدي اختيار الأرشفة إلى حذف منشور قديم من Telegram.',
    [archiveCommand,ownerLibraryLabel]);
  if(action.token!==fingerprint||action.policyVersion!==epoch)return null;
  if(action.kind==='review')
   return screen('<b>مراجعة أرشفة المورد 🗃️</b>\n'
    +'العنوان: '+visible(resource.title,110)+'\n'
    +'القسم: '+visible(resource.categoryId,64)+'\n'
    +'تأكيد الأرشفة سيخفي المورد من قائمة المنشورات المحلية للطلاب.\n'
    +'لا حذف أو تعديل للقنوات الحية. لن تُكرر الأرشفة بزر قديم.',
    [confirmedCommand,'📚 المورد · '+resource.id]);
  if(action.kind==='confirm'){
   try{await this.education.archiveResourceIfCurrent(ctx.actorId,resource.id,fingerprint,epoch);}
   catch{return null;}
   return screen('<b>اكتملت الأرشفة المحلية ✅</b>\n'
    +'تم إخفاء المورد من مكتبة المحتوى المنشور محليًا.\n'
    +'لا توجد أوامر حذف أو تحرير مرسلة إلى Telegram.',
    [ownerLibraryLabel]);
  }
  return null;
 }
}
