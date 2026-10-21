import {createHash} from 'node:crypto';
import type {BotStore,BotState,ImportRun} from './store.js';
import type {Policy} from './policy.js';
import type {EducationService} from './education.js';
import type {EducationAdminFacade,VerifiedAdminContext} from './education-admin.js';
import {menuLabels,type TelegramReplyKeyboard} from './telegram-menu.js';
import {OwnerTelegramGroupMenu,isOwnerGroupText} from './telegram-owner-groups.js';
import {summarizeSubscriptionIntegrity} from './subscription-integrity.js';
import {OwnerTelegramLibraryMenu,isOwnerLibraryText} from './telegram-owner-library.js';
import {OwnerTelegramCategoryMenu,isOwnerCategoryText} from './telegram-owner-categories.js';
import {OwnerTelegramFAQMenu,isOwnerFAQText} from './telegram-owner-faq.js';
import type {PlatformCatalogPreviewService} from './platform-catalog-preview.js';
import {escapeTelegramListPreview} from './telegram-preview.js';

export const ownerMenuLabels={
 imports:'🧾 مراجعة الوارد',
 library:'📚 إدارة المكتبة',
 categories:'🗂️ إدارة الأقسام',
 faq:'🧠 الأسئلة الشائعة',
 groups:'👥 المجموعات المعتمدة',
 subscriptionHealth:'🛡 سلامة الاشتراكات',
 delivery:'📊 حالة الرسائل',
 platformCatalog:'🔎 معاينة بيانات منارتك',
 settings:'⚙️ إعدادات التشغيل',
} as const;
type OwnerMenuAction={
 action:'run'|'candidate'|'category'|'approve'|'previewPublish'|'publish';
 runId:string;index?:number;categoryId?:string;
};
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const refRe=new RegExp('^('+uuid+')$','u');
const two=new RegExp('^('+uuid+'):(0|[1-9][0-9]{0,4})$','u');
const three=new RegExp('^('+uuid+'):(0|[1-9][0-9]{0,4}):([a-zA-Z0-9_-]{1,64}|~[a-f0-9]{16})$','u');
const marks=[
 ['🗃️ الاستيراد · ','run','one'],
 ['📑 مرشح · ','candidate','two'],
 ['📂 اعتماد في · ','category','three'],
 ['✅ تأكيد الاعتماد · ','approve','three'],
 ['📝 معاينة النشر · ','previewPublish','three'],
 ['📤 تأكيد النشر المحلي · ','publish','three']
] as const;
export function parseOwnerMenuAction(text:string):OwnerMenuAction|null{
 if(typeof text!=='string'||text.length>170)return null;
 for(const [prefix,action,shape] of marks){
  if(!text.startsWith(prefix))continue;
  const token=text.slice(prefix.length);
  const m=(shape==='one'?refRe:shape==='two'?two:three).exec(token);
  if(!m)return null;
  return shape==='one'?{action,runId:m[1]!}:
   shape==='two'?{action,runId:m[1]!,index:Number(m[2]!)}:
   {action,runId:m[1]!,index:Number(m[2]!),categoryId:m[3]!};
 }
 return null;
}
/** Short IDs are human-readable; long IDs use a stable fingerprint whose
 * single permitted match is recomputed under freshly authorized state.
 */
export function ownerCategoryToken(id:string):string{
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id))throw Error('INVALID_OWNER_CATEGORY_ID');
 return id.length<=24?id:'~'+createHash('sha256').update(id,'utf8').digest('hex').slice(0,16);
}
export interface OwnerMenuPage{
 type:'imports'|'candidates'|'categories';runId?:string;index?:number;page:number;direction:'next'|'previous';
}
const pageRe=new RegExp('^(➡️ التالي|⬅️ السابق) · o:(i|c|k)(?::('+uuid+'))?(?::(0|[1-9][0-9]{0,4}))?:(0|[1-9][0-9]{0,2})$','u');
export function parseOwnerMenuPageCommand(input:string):OwnerMenuPage|null{
 if(typeof input!=='string'||input.length>96)return null;
 const m=pageRe.exec(input);
 if(!m||m[0]!==input)return null;
 const type=m[2]==='i'?'imports':m[2]==='c'?'candidates':'categories';
 const runId=m[3],index=m[4],page=Number(m[5]);
 if((type==='imports'&&(runId!==undefined||index!==undefined))||
  (type==='candidates'&&(!runId||index!==undefined))||
  (type==='categories'&&(!runId||index===undefined)))return null;
 const direction=m[1]==='➡️ التالي'?'next':'previous';
 if(type==='categories')return {type,runId:runId!,index:Number(index),page,direction};
 if(type==='candidates')return {type,runId:runId!,page,direction};
 return {type,page,direction};
}
function ownerPageButton(type:OwnerMenuPage['type'],page:number,direction:OwnerMenuPage['direction'],runId?:string,index?:number):string{
 if(!Number.isSafeInteger(page)||page<0||page>999)throw Error('INVALID_OWNER_PAGE');
 if(type!=='imports'&&(!runId||!refRe.test(runId)))throw Error('INVALID_OWNER_RUN');
 if(type==='categories'&&(index===undefined||!Number.isSafeInteger(index)||index<0||index>99999))
  throw Error('INVALID_OWNER_ROW');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+' · o:'+
  (type==='imports'?'i':type==='candidates'?'c:'+runId:'k:'+runId+':'+index)+':'+page;
}
const sections=new Set<string>(Object.values(ownerMenuLabels));
/** Distinguish an owner-only choice (even malformed) from an unrelated
 * ordinary student message. Never use text alone to authenticate its sender.
 */
export function isOwnerMenuText(text:string):boolean{
 return text===menuLabels.owner||sections.has(text)||isOwnerGroupText(text)||isOwnerLibraryText(text)||isOwnerCategoryText(text)||isOwnerFAQText(text)||
  text.startsWith('➡️ التالي · o:')||text.startsWith('⬅️ السابق · o:')||
  text.startsWith('➡️ التالي · b5:')||text.startsWith('⬅️ السابق · b5:')||
  text.startsWith('📥 تسجيل مرشح · ')||text.startsWith('✅ تدقيق بيانات · ')||
  text.startsWith('📋 اختيار قسم · ')||text.startsWith('📁 تعيين قسم · ')||
  text.startsWith('✅ تأكيد اعتماد محلي · ')||text.startsWith('📝 معاينة إتاحة · ')||
  text.startsWith('📚 تأكيد إتاحة محلية · ')||
  text.startsWith('➡️ التالي · b5c:')||text.startsWith('⬅️ السابق · b5c:')||
  marks.some(([prefix])=>text.startsWith(prefix));
}
const esc=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const clean=(s:string):string=>s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim();
const line=(s:string,max=100):string=>esc(clean(s).slice(0,max));
export interface OwnerMenuScreen {text:string;keyboard:TelegramReplyKeyboard;}
const buttonRows=(choices:readonly string[],pages:{previous?:string|undefined;next?:string|undefined}={}):TelegramReplyKeyboard=>{
 const rows:{text:string}[][]=[];
 for(let i=0;i<Math.min(choices.length,10);i+=2)
  rows.push(choices.slice(i,i+2).map(text=>({text})));
 const controls=[pages.previous,pages.next].filter((x):x is string=>typeof x==='string');
 if(controls.length)rows.push(controls.map(text=>({text})));
 rows.push([{text:menuLabels.owner},{text:menuLabels.home}]);
 return {keyboard:rows,resize_keyboard:true,is_persistent:true};
};
const screen=(text:string,choices:readonly string[]=[],pages:{previous?:string|undefined;next?:string|undefined}={}):OwnerMenuScreen=>({
 text,keyboard:buttonRows(choices,pages)
});
const reject=():null=>null;
/**
 * A privileged UI facade over the same state and transactional EducationAdmin
 * methods used by the text commands. Not an additional API and not a role
 * grant: verified private sender + configured owner checked for EVERY button.
 */
export class OwnerTelegramMenu{
 constructor(
  private readonly store:BotStore,
  private readonly policy:Policy,
  private readonly education:EducationService,
  private readonly admin:EducationAdminFacade,
  private readonly platformCatalog?:PlatformCatalogPreviewService
 ){}
 private allowedRun(state:BotState,id:string):ImportRun|null{
  const run=state.importRuns.find(x=>x.id===id);
  if(!run)return null;
  if(run.scope==='private')return run;
  return this.policy.canUseChat(state,run.scope,'navigation')?run:null;
 }
 private async permittedCategories(run:ImportRun,actorId:string){
  return this.education.listCategories(actorId,run.scope);
 }
 private validPage(page:number,direction:OwnerMenuPage['direction']|undefined,count:number,size=10):boolean{
  const pages=Math.ceil(count/size);
  return page>=0&&page<pages&&
   (direction!=='next'||page>0)&&
   (direction!=='previous'||page<pages-1);
 }
 private pagedImports(state:BotState,page:number,direction?:OwnerMenuPage['direction']):OwnerMenuScreen|null{
  const visible=state.importRuns.filter(r=>Boolean(this.allowedRun(state,r.id)))
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
  if(!visible.length&&page===0&&!direction)
   return screen('<b>مراجعة الاستيراد 🧾</b>\nلا توجد دفعات محفوظة في النطاقات المصرح بها.');
  if(!this.validPage(page,direction,visible.length))return reject();
  const pages=Math.ceil(visible.length/10);
  const choose=visible.slice(page*10,page*10+10).map(r=>'🗃️ الاستيراد · '+r.id);
  return screen('<b>مراجعة الاستيراد 🧾</b>\n'
   +'الدفعات المتاحة: '+visible.length+'\nصفحة '+(page+1)+' من '+pages+'\n'
   +'اختر دفعة لفحص المرشحين قبل اعتمادهم.\n'
   +'لرفع ملف جديد استخدم /upload داخل الخاص أو /import حسب الصلاحيات.',
   choose,{
    previous:page>0?ownerPageButton('imports',page-1,'previous'):undefined,
    next:page+1<pages?ownerPageButton('imports',page+1,'next'):undefined
   });
 }
 private pagedCandidates(run:ImportRun,page:number,direction?:OwnerMenuPage['direction']):OwnerMenuScreen|null{
  if(!run.candidates.length&&page===0&&!direction)
   return screen('<b>دفعة الاستيراد 🗃️</b>\nلا توجد سجلات مرشحة في هذه الدفعة.');
  if(!this.validPage(page,direction,run.candidates.length))return reject();
  const pages=Math.ceil(run.candidates.length/10);
  const choices=run.candidates.slice(page*10,page*10+10)
   .map((_,i)=>'📑 مرشح · '+run.id+':'+(page*10+i));
  return screen('<b>دفعة الاستيراد 🗃️</b>\n'
   +'النطاق: '+line(run.scope,24)+'\nالسجلات: '+run.candidates.length+'\n'
   +'صفحة '+(page+1)+' من '+pages+'\n'
   +'حالة كل مرشح تُراجع قبل أي اعتماد. لا نشر تلقائي.',
   choices,{
    previous:page>0?ownerPageButton('candidates',page-1,'previous',run.id):undefined,
    next:page+1<pages?ownerPageButton('candidates',page+1,'next',run.id):undefined
   });
 }
 private async categoryPage(run:ImportRun,index:number,actorId:string,
  page:number,direction?:OwnerMenuPage['direction']):Promise<OwnerMenuScreen|null>{
  const candidate=run.candidates[index];
  if(!candidate||candidate.status!=='READY')return reject();
  const categories=await this.permittedCategories(run,actorId);
  if(!categories.length&&page===0&&!direction)
   return screen('<b>معاينة المرشح 📑</b>\n'+line(candidate.title,120)+
    '\nلا توجد أقسام معتمدة متاحة حاليًا.');
  if(!this.validPage(page,direction,categories.length,9))return reject();
  const pages=Math.ceil(categories.length/9);
  const choices=categories.slice(page*9,page*9+9).map(c=>
   '📂 اعتماد في · '+run.id+':'+index+':'+ownerCategoryToken(c.id));
  choices.push('🗃️ الاستيراد · '+run.id);
  return screen('<b>معاينة المرشح 📑</b>\n'
   +'العنوان: '+line(candidate.title,120)+'\n'
   +'الجامعة: '+line(candidate.university,100)+'\n'
   +'الحالة: '+line(candidate.status,30)+'\n'
   +'اختر القسم ثم أكّد الاعتماد بشكل صريح.\n'
   +'صفحة '+(page+1)+' من '+pages,
   choices,{
    previous:page>0?ownerPageButton('categories',page-1,'previous',run.id,index):undefined,
    next:page+1<pages?ownerPageButton('categories',page+1,'next',run.id,index):undefined
   });
 }
 async handle(text:string,ctx:VerifiedAdminContext):Promise<OwnerMenuScreen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return reject();
  if(isOwnerGroupText(text))
   return new OwnerTelegramGroupMenu(this.store,this.policy).handle(text,ctx);
  if(isOwnerLibraryText(text))
   return new OwnerTelegramLibraryMenu(this.store,this.policy,this.education).handle(text,ctx);
  if(isOwnerCategoryText(text))
   return new OwnerTelegramCategoryMenu(this.store,this.policy,this.education).handle(text,ctx);
  if(isOwnerFAQText(text))
   return new OwnerTelegramFAQMenu(this.store,this.policy).handle(text,ctx);
  // Owner-only external source actions never confer B3 import/publish
  // authority. Each button is an untrusted, bounded request for a fresh
  // re-read and an atomic metadata-only quarantine transition.
  const stageAction=/^📥 تسجيل مرشح · ([A-Za-z0-9][A-Za-z0-9_-]{0,63}):(none|[A-Za-z0-9_-]{1,64}):([a-f0-9]{64})$/u.exec(text);
  if(text.startsWith('📥 تسجيل مرشح · ')){
   if(!this.platformCatalog||!stageAction)return reject();
   const staged=await this.platformCatalog.stage(ctx.actorId,
    stageAction[1]!,stageAction[3]!,{
     cursor:stageAction[2]==='none'?null:stageAction[2]!
    });
   if(staged.status!=='STAGED')return reject();
   const entry=staged.entry;
   return screen('<b>تم حفظ المرشح للمراجعة 📥</b>\n'
    +'المصدر: <code>'+entry.sourceId+'</code>\n'
    +'العنوان: '+escapeTelegramListPreview(entry.title,160)+'\n'
    +'الحالة: '+(entry.status==='REVIEWED_METADATA_ONLY'?
       'تم تدقيق البيانات سابقًا.':'خارجية غير متحقق منها؛ يحتاج تدقيقًا مستقلاً.')+'\n'
    +'هذه العملية لا تعتمد منحة للطلاب ولا تنشر أي محتوى.',
    entry.status==='REVIEWED_METADATA_ONLY'?[ownerMenuLabels.platformCatalog]:
    ['✅ تدقيق بيانات · '+entry.sourceId+':'+entry.digest,
     ownerMenuLabels.platformCatalog]);
  }
  const reviewAction=/^✅ تدقيق بيانات · ([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([a-f0-9]{64})$/u.exec(text);
  if(text.startsWith('✅ تدقيق بيانات · ')){
   if(!this.platformCatalog||!reviewAction)return reject();
   const checked=await this.platformCatalog.review(ctx.actorId,reviewAction[1]!,reviewAction[2]!);
   if(checked.status!=='REVIEWED')return reject();
   return screen('<b>تم تدقيق بيانات المرشح ✅</b>\n'
    +'المصدر: <code>'+checked.entry.sourceId+'</code>\n'
    +'راجعتَ نسخة البيانات التي تطابق المصدر عند الطلب.\n'
    +'الحالة: مراجعة بيانات فقط؛ اختر قسمًا لاعتمادها محليًا، ولا نشر تلقائي.',
    ['📋 اختيار قسم · '+checked.entry.sourceId+':'+checked.entry.digest,
      ownerMenuLabels.platformCatalog]);
  }
  // B5 approval requires owner category choice, a separate confirm,
  // and a SECOND preview/confirm for local publication. None is a grant.
  const resourceToken='([A-Za-z0-9][A-Za-z0-9_-]{0,63})';
  const categoryToken='([A-Za-z0-9][A-Za-z0-9_-]{0,63})';
  const digestToken='([a-f0-9]{64})';
  const pickerRe=new RegExp('^📋 اختيار قسم · '+resourceToken+':'+digestToken+' Its cursor
  // is copied through reply-keyboard text and NEVER confers authentication.
  const platformPage=/^➡️ التالي · b5:([A-Za-z0-9_-]{1,64})$/u.exec(text);
  if(text===ownerMenuLabels.platformCatalog||
    text.startsWith('➡️ التالي · b5:')||text.startsWith('⬅️ السابق · b5:')){
   if(!this.platformCatalog||(!platformPage&&text!==ownerMenuLabels.platformCatalog))
    return reject();
   const inspected=await this.platformCatalog.preview(ctx.actorId,
     platformPage?{cursor:platformPage[1]!}:{});
   if(inspected.status==='DENIED')return reject();
   if(inspected.status==='UNAVAILABLE')
    return screen('<b>معاينة بيانات منارتك 🔎</b>\n'
     +'تعذر قراءة السجلات الخارجية بشكل آمن حاليًا.\n'
     +'لم يتم استيراد أو نشر أي مورد.',
     [ownerMenuLabels.settings]);
   if(inspected.status!=='PREVIEW')return reject();
   if(inspected.records.length===0)return screen(
    '<b>معاينة بيانات منارتك 🔎</b>\n'
    +'لا توجد سجلات منشورة في هذه الصفحة بحسب المصدر.\n'
    +'لم يتم اعتماد أي سجل داخل البوت.',
    [ownerMenuLabels.platformCatalog]);
   const pageCursor=platformPage?.[1]??'none';
   const rows=inspected.records.map((r,i)=>
    (i+1)+'. <code>'+r.id+'</code> — '+
    escapeTelegramListPreview(r.title,115)+'\n'
    +'الجامعة: '+escapeTelegramListPreview(r.university,70)).join('\n');
   return screen('<b>معاينة خارجية للمالك 🔎</b>\n'
    +'المصدر يدّعي نشر هذه السجلات، لكن لم يتحقق مالك البوت منها بعد.\n'
    +'الحالة: غير متحقق منها — لا اعتماد أو نشر تلقائي.\n'
    +rows+'\n'
    +'يمكن حفظ سجل للمراجعة فقط؛ ليس منحة معتمدة أو منشورة.',
    inspected.records.map(r=>'📥 تسجيل مرشح · '+r.id+':'+
     pageCursor+':'+inspected.fingerprint),{
     next:inspected.nextCursor?'➡️ التالي · b5:'+inspected.nextCursor:undefined
    });
  }
  const state=await this.store.snapshot();
  const pageRequest=parseOwnerMenuPageCommand(text);
  if(pageRequest){
   if(pageRequest.type==='imports')
    return this.pagedImports(state,pageRequest.page,pageRequest.direction);
   const run=pageRequest.runId?this.allowedRun(state,pageRequest.runId):null;
   if(!run)return reject();
   if(pageRequest.type==='candidates')
    return this.pagedCandidates(run,pageRequest.page,pageRequest.direction);
   if(pageRequest.index===undefined)return reject();
   return this.categoryPage(run,pageRequest.index,ctx.actorId,pageRequest.page,pageRequest.direction);
  }
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels).filter(x=>this.platformCatalog||x!==ownerMenuLabels.platformCatalog));
  }
  if(text===ownerMenuLabels.imports)return this.pagedImports(state,0);
  if(text===ownerMenuLabels.subscriptionHealth){
   // Owner UI is a read-only projection of current saved policy state, not
   // a substitute for the protected SQLite host audit or Telegram rights.
   const report=summarizeSubscriptionIntegrity(state);
   return screen('<b>سلامة قواعد الاشتراك 🛡</b>\n'
    +'النطاق: '+report.stage+'\n'
    +'النتيجة المحلية: '+report.status+'\n'
    +'القواعد المحفوظة: '+report.rules+'\n'
    +'القواعد النشطة: '+report.activeRules+'\n'
    +'القواعد المعلّقة/غير النشطة: '+report.inactiveRules+'\n'
    +'القواعد غير السليمة: '+report.invalidRules+'\n'
    +'مجموعات بلا تصريح تحقق: '+report.invalidGroups+'\n'
    +'قنوات بلا تصريح تحقق: '+report.invalidChannels+'\n'
    +'القنوات المطلوبة المكررة: '+report.duplicateChannels+'\n'
    +'قواعد تتجاوز الحد: '+report.overLimitRules+'\n'
    +(report.reasons.length?'أسباب التنبيه: '+report.reasons.join(', ')+'\n':'')
    +'هذا فحص للحالة المحفوظة فقط، وليس تحققًا حيًا من Telegram.\n'
    +'لا يمكن تفعيل البوت أو تعديل شروط الاشتراك من تقرير الفحص.',
    [ownerMenuLabels.groups,ownerMenuLabels.settings]);
  }
  if(text===ownerMenuLabels.delivery){
   const jobs=state.telegramReplyJobs??[];
   const queued=jobs.filter(x=>x.status==='QUEUED').length;
   const uncertain=jobs.filter(x=>x.status==='UNKNOWN_OUTCOME'||x.status==='SENDING').length;
   const sent=jobs.filter(x=>x.status==='SENT').length;
   const pendingPublication=state.deliveries.filter(x=>
    ['QUEUED','MULTIPART','SENDING','UNKNOWN_OUTCOME'].includes(x.status)).length;
   return screen('<b>حالة الرسائل 📊</b>\n'
    +'ردود مرسلة ومؤكدة محليًا: '+sent+'\n'
    +'ردود في الانتظار: '+queued+'\n'
    +'محاولات مجهولة أو قيد الإرسال: '+uncertain+'\n'
    +'نشر حملات معلّق أو مجهول: '+pendingPublication+'\n'
    +'لا تعيد إرسال UNKNOWN تلقائيًا. فحص البيانات التفصيلي للمشغّل المحلي فقط.'
    );
  }
  if(text===ownerMenuLabels.settings){
   const groupModes=state.chats.filter(c=>c.approved).map(c=>c.groupAI);
   return screen('<b>إعدادات التشغيل ⚙️</b>\n'
    +'وضع AI في الخاص: '+line(state.privateAI,30)+'\n'
    +'مجموعات تستخدم سياسة AI غير OFF: '+groupModes.filter(x=>x!=='OFF').length+'\n'
    +'العمل مع مزود AI الخارجي غير موصل حتى الآن.\n'
    +'حالة مفتاح RUN/STOP الحقيقية ليست ضمن لوحة Telegram، '
    +'ولا يمكن تغيير ملف الطوارئ أو أسرار التشغيل بأزرار البوت.'
    );
  }
  const action=parseOwnerMenuAction(text);
  if(!action)return reject();
  const run=this.allowedRun(state,action.runId);
  if(!run)return reject();
  const button='🗃️ الاستيراد · '+run.id;
  if(action.action==='run')return this.pagedCandidates(run,0);
  const index=action.index!;
  const candidate=run.candidates[index];
  if(!candidate)return reject();
  if(action.action==='candidate'){
   const categories=await this.permittedCategories(run,ctx.actorId);
   const detail='<b>معاينة المرشح 📑</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'الدورة: '+line(candidate.cycle,40)+'\n'
    +'المرحلة: '+line(candidate.degree,40)+'\n'
    +'الحالة: '+line(candidate.status,30)+'\n';
   if(candidate.status==='READY')return this.categoryPage(run,index,ctx.actorId,0);
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+ownerCategoryToken(cat.id)]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const selectedToken=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  const matched=categories.filter(c=>ownerCategoryToken(c.id)===selectedToken);
  if(matched.length!==1)return reject();
  const categoryId=matched[0]!.id;
  if(action.action==='category'){
   if(candidate.status!=='READY')return reject();
   return screen('<b>تأكيد اعتماد مرشح</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'القسم: '+line(categories.find(c=>c.id===categoryId)!.title,100)+'\n'
    +'الاعتماد يسجل الموافقة فقط، ولا ينشر على Telegram.',
    ['✅ تأكيد الاعتماد · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='approve'){
   if(candidate.status!=='READY')return reject();
   try{await this.admin.approve(ctx,run.id,index,categoryId);}
   catch{return reject();}
   return screen('<b>تم اعتماد السجل محليًا ✅</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'لا يوجد نشر تلقائي. افحص معاينة النشر المحلي قبل إتاحته بالمكتبة.',
    ['📝 معاينة النشر · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(candidate.status!=='APPROVED'||candidate.categoryId!==categoryId)return reject();
  if(action.action==='previewPublish'){
   return screen('<b>معاينة النشر المحلي 📝</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'القسم: '+line(categories.find(x=>x.id===categoryId)!.title,100)+'\n'
    +'بالضغط على التأكيد يظهر المورد داخل مكتبة البوت المحلية فقط.\n'
    +'لن تُرسل رسالة إلى أي قناة Telegram.',
    ['📤 تأكيد النشر المحلي · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='publish'){
   try{
    const published=await this.admin.publish(ctx,run.id,index,categoryId);
    return screen('<b>تم النشر في المكتبة المحلية ✅</b>\n'
     +'المورد: '+line(published.title,120)+'\n'
     +'لا إرسال إلى قناة Telegram ولا تشغيل حملة.',
     [button,ownerMenuLabels.library]);
   }catch{return reject();}
  }
  return reject();
 }
}
,'u');
  const categoryRe=new RegExp('^📁 تعيين قسم · '+resourceToken+':'+categoryToken+':'+digestToken+' Its cursor
  // is copied through reply-keyboard text and NEVER confers authentication.
  const platformPage=/^➡️ التالي · b5:([A-Za-z0-9_-]{1,64})$/u.exec(text);
  if(text===ownerMenuLabels.platformCatalog||
    text.startsWith('➡️ التالي · b5:')||text.startsWith('⬅️ السابق · b5:')){
   if(!this.platformCatalog||(!platformPage&&text!==ownerMenuLabels.platformCatalog))
    return reject();
   const inspected=await this.platformCatalog.preview(ctx.actorId,
     platformPage?{cursor:platformPage[1]!}:{});
   if(inspected.status==='DENIED')return reject();
   if(inspected.status==='UNAVAILABLE')
    return screen('<b>معاينة بيانات منارتك 🔎</b>\n'
     +'تعذر قراءة السجلات الخارجية بشكل آمن حاليًا.\n'
     +'لم يتم استيراد أو نشر أي مورد.',
     [ownerMenuLabels.settings]);
   if(inspected.status!=='PREVIEW')return reject();
   if(inspected.records.length===0)return screen(
    '<b>معاينة بيانات منارتك 🔎</b>\n'
    +'لا توجد سجلات منشورة في هذه الصفحة بحسب المصدر.\n'
    +'لم يتم اعتماد أي سجل داخل البوت.',
    [ownerMenuLabels.platformCatalog]);
   const pageCursor=platformPage?.[1]??'none';
   const rows=inspected.records.map((r,i)=>
    (i+1)+'. <code>'+r.id+'</code> — '+
    escapeTelegramListPreview(r.title,115)+'\n'
    +'الجامعة: '+escapeTelegramListPreview(r.university,70)).join('\n');
   return screen('<b>معاينة خارجية للمالك 🔎</b>\n'
    +'المصدر يدّعي نشر هذه السجلات، لكن لم يتحقق مالك البوت منها بعد.\n'
    +'الحالة: غير متحقق منها — لا اعتماد أو نشر تلقائي.\n'
    +rows+'\n'
    +'يمكن حفظ سجل للمراجعة فقط؛ ليس منحة معتمدة أو منشورة.',
    inspected.records.map(r=>'📥 تسجيل مرشح · '+r.id+':'+
     pageCursor+':'+inspected.fingerprint),{
     next:inspected.nextCursor?'➡️ التالي · b5:'+inspected.nextCursor:undefined
    });
  }
  const state=await this.store.snapshot();
  const pageRequest=parseOwnerMenuPageCommand(text);
  if(pageRequest){
   if(pageRequest.type==='imports')
    return this.pagedImports(state,pageRequest.page,pageRequest.direction);
   const run=pageRequest.runId?this.allowedRun(state,pageRequest.runId):null;
   if(!run)return reject();
   if(pageRequest.type==='candidates')
    return this.pagedCandidates(run,pageRequest.page,pageRequest.direction);
   if(pageRequest.index===undefined)return reject();
   return this.categoryPage(run,pageRequest.index,ctx.actorId,pageRequest.page,pageRequest.direction);
  }
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels).filter(x=>this.platformCatalog||x!==ownerMenuLabels.platformCatalog));
  }
  if(text===ownerMenuLabels.imports)return this.pagedImports(state,0);
  if(text===ownerMenuLabels.subscriptionHealth){
   // Owner UI is a read-only projection of current saved policy state, not
   // a substitute for the protected SQLite host audit or Telegram rights.
   const report=summarizeSubscriptionIntegrity(state);
   return screen('<b>سلامة قواعد الاشتراك 🛡</b>\n'
    +'النطاق: '+report.stage+'\n'
    +'النتيجة المحلية: '+report.status+'\n'
    +'القواعد المحفوظة: '+report.rules+'\n'
    +'القواعد النشطة: '+report.activeRules+'\n'
    +'القواعد المعلّقة/غير النشطة: '+report.inactiveRules+'\n'
    +'القواعد غير السليمة: '+report.invalidRules+'\n'
    +'مجموعات بلا تصريح تحقق: '+report.invalidGroups+'\n'
    +'قنوات بلا تصريح تحقق: '+report.invalidChannels+'\n'
    +'القنوات المطلوبة المكررة: '+report.duplicateChannels+'\n'
    +'قواعد تتجاوز الحد: '+report.overLimitRules+'\n'
    +(report.reasons.length?'أسباب التنبيه: '+report.reasons.join(', ')+'\n':'')
    +'هذا فحص للحالة المحفوظة فقط، وليس تحققًا حيًا من Telegram.\n'
    +'لا يمكن تفعيل البوت أو تعديل شروط الاشتراك من تقرير الفحص.',
    [ownerMenuLabels.groups,ownerMenuLabels.settings]);
  }
  if(text===ownerMenuLabels.delivery){
   const jobs=state.telegramReplyJobs??[];
   const queued=jobs.filter(x=>x.status==='QUEUED').length;
   const uncertain=jobs.filter(x=>x.status==='UNKNOWN_OUTCOME'||x.status==='SENDING').length;
   const sent=jobs.filter(x=>x.status==='SENT').length;
   const pendingPublication=state.deliveries.filter(x=>
    ['QUEUED','MULTIPART','SENDING','UNKNOWN_OUTCOME'].includes(x.status)).length;
   return screen('<b>حالة الرسائل 📊</b>\n'
    +'ردود مرسلة ومؤكدة محليًا: '+sent+'\n'
    +'ردود في الانتظار: '+queued+'\n'
    +'محاولات مجهولة أو قيد الإرسال: '+uncertain+'\n'
    +'نشر حملات معلّق أو مجهول: '+pendingPublication+'\n'
    +'لا تعيد إرسال UNKNOWN تلقائيًا. فحص البيانات التفصيلي للمشغّل المحلي فقط.'
    );
  }
  if(text===ownerMenuLabels.settings){
   const groupModes=state.chats.filter(c=>c.approved).map(c=>c.groupAI);
   return screen('<b>إعدادات التشغيل ⚙️</b>\n'
    +'وضع AI في الخاص: '+line(state.privateAI,30)+'\n'
    +'مجموعات تستخدم سياسة AI غير OFF: '+groupModes.filter(x=>x!=='OFF').length+'\n'
    +'العمل مع مزود AI الخارجي غير موصل حتى الآن.\n'
    +'حالة مفتاح RUN/STOP الحقيقية ليست ضمن لوحة Telegram، '
    +'ولا يمكن تغيير ملف الطوارئ أو أسرار التشغيل بأزرار البوت.'
    );
  }
  const action=parseOwnerMenuAction(text);
  if(!action)return reject();
  const run=this.allowedRun(state,action.runId);
  if(!run)return reject();
  const button='🗃️ الاستيراد · '+run.id;
  if(action.action==='run')return this.pagedCandidates(run,0);
  const index=action.index!;
  const candidate=run.candidates[index];
  if(!candidate)return reject();
  if(action.action==='candidate'){
   const categories=await this.permittedCategories(run,ctx.actorId);
   const detail='<b>معاينة المرشح 📑</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'الدورة: '+line(candidate.cycle,40)+'\n'
    +'المرحلة: '+line(candidate.degree,40)+'\n'
    +'الحالة: '+line(candidate.status,30)+'\n';
   if(candidate.status==='READY')return this.categoryPage(run,index,ctx.actorId,0);
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+ownerCategoryToken(cat.id)]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const selectedToken=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  const matched=categories.filter(c=>ownerCategoryToken(c.id)===selectedToken);
  if(matched.length!==1)return reject();
  const categoryId=matched[0]!.id;
  if(action.action==='category'){
   if(candidate.status!=='READY')return reject();
   return screen('<b>تأكيد اعتماد مرشح</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'القسم: '+line(categories.find(c=>c.id===categoryId)!.title,100)+'\n'
    +'الاعتماد يسجل الموافقة فقط، ولا ينشر على Telegram.',
    ['✅ تأكيد الاعتماد · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='approve'){
   if(candidate.status!=='READY')return reject();
   try{await this.admin.approve(ctx,run.id,index,categoryId);}
   catch{return reject();}
   return screen('<b>تم اعتماد السجل محليًا ✅</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'لا يوجد نشر تلقائي. افحص معاينة النشر المحلي قبل إتاحته بالمكتبة.',
    ['📝 معاينة النشر · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(candidate.status!=='APPROVED'||candidate.categoryId!==categoryId)return reject();
  if(action.action==='previewPublish'){
   return screen('<b>معاينة النشر المحلي 📝</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'القسم: '+line(categories.find(x=>x.id===categoryId)!.title,100)+'\n'
    +'بالضغط على التأكيد يظهر المورد داخل مكتبة البوت المحلية فقط.\n'
    +'لن تُرسل رسالة إلى أي قناة Telegram.',
    ['📤 تأكيد النشر المحلي · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='publish'){
   try{
    const published=await this.admin.publish(ctx,run.id,index,categoryId);
    return screen('<b>تم النشر في المكتبة المحلية ✅</b>\n'
     +'المورد: '+line(published.title,120)+'\n'
     +'لا إرسال إلى قناة Telegram ولا تشغيل حملة.',
     [button,ownerMenuLabels.library]);
   }catch{return reject();}
  }
  return reject();
 }
}
,'u');
  const approveRe=new RegExp('^✅ تأكيد اعتماد محلي · '+resourceToken+':'+categoryToken+':'+digestToken+' Its cursor
  // is copied through reply-keyboard text and NEVER confers authentication.
  const platformPage=/^➡️ التالي · b5:([A-Za-z0-9_-]{1,64})$/u.exec(text);
  if(text===ownerMenuLabels.platformCatalog||
    text.startsWith('➡️ التالي · b5:')||text.startsWith('⬅️ السابق · b5:')){
   if(!this.platformCatalog||(!platformPage&&text!==ownerMenuLabels.platformCatalog))
    return reject();
   const inspected=await this.platformCatalog.preview(ctx.actorId,
     platformPage?{cursor:platformPage[1]!}:{});
   if(inspected.status==='DENIED')return reject();
   if(inspected.status==='UNAVAILABLE')
    return screen('<b>معاينة بيانات منارتك 🔎</b>\n'
     +'تعذر قراءة السجلات الخارجية بشكل آمن حاليًا.\n'
     +'لم يتم استيراد أو نشر أي مورد.',
     [ownerMenuLabels.settings]);
   if(inspected.status!=='PREVIEW')return reject();
   if(inspected.records.length===0)return screen(
    '<b>معاينة بيانات منارتك 🔎</b>\n'
    +'لا توجد سجلات منشورة في هذه الصفحة بحسب المصدر.\n'
    +'لم يتم اعتماد أي سجل داخل البوت.',
    [ownerMenuLabels.platformCatalog]);
   const pageCursor=platformPage?.[1]??'none';
   const rows=inspected.records.map((r,i)=>
    (i+1)+'. <code>'+r.id+'</code> — '+
    escapeTelegramListPreview(r.title,115)+'\n'
    +'الجامعة: '+escapeTelegramListPreview(r.university,70)).join('\n');
   return screen('<b>معاينة خارجية للمالك 🔎</b>\n'
    +'المصدر يدّعي نشر هذه السجلات، لكن لم يتحقق مالك البوت منها بعد.\n'
    +'الحالة: غير متحقق منها — لا اعتماد أو نشر تلقائي.\n'
    +rows+'\n'
    +'يمكن حفظ سجل للمراجعة فقط؛ ليس منحة معتمدة أو منشورة.',
    inspected.records.map(r=>'📥 تسجيل مرشح · '+r.id+':'+
     pageCursor+':'+inspected.fingerprint),{
     next:inspected.nextCursor?'➡️ التالي · b5:'+inspected.nextCursor:undefined
    });
  }
  const state=await this.store.snapshot();
  const pageRequest=parseOwnerMenuPageCommand(text);
  if(pageRequest){
   if(pageRequest.type==='imports')
    return this.pagedImports(state,pageRequest.page,pageRequest.direction);
   const run=pageRequest.runId?this.allowedRun(state,pageRequest.runId):null;
   if(!run)return reject();
   if(pageRequest.type==='candidates')
    return this.pagedCandidates(run,pageRequest.page,pageRequest.direction);
   if(pageRequest.index===undefined)return reject();
   return this.categoryPage(run,pageRequest.index,ctx.actorId,pageRequest.page,pageRequest.direction);
  }
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels).filter(x=>this.platformCatalog||x!==ownerMenuLabels.platformCatalog));
  }
  if(text===ownerMenuLabels.imports)return this.pagedImports(state,0);
  if(text===ownerMenuLabels.subscriptionHealth){
   // Owner UI is a read-only projection of current saved policy state, not
   // a substitute for the protected SQLite host audit or Telegram rights.
   const report=summarizeSubscriptionIntegrity(state);
   return screen('<b>سلامة قواعد الاشتراك 🛡</b>\n'
    +'النطاق: '+report.stage+'\n'
    +'النتيجة المحلية: '+report.status+'\n'
    +'القواعد المحفوظة: '+report.rules+'\n'
    +'القواعد النشطة: '+report.activeRules+'\n'
    +'القواعد المعلّقة/غير النشطة: '+report.inactiveRules+'\n'
    +'القواعد غير السليمة: '+report.invalidRules+'\n'
    +'مجموعات بلا تصريح تحقق: '+report.invalidGroups+'\n'
    +'قنوات بلا تصريح تحقق: '+report.invalidChannels+'\n'
    +'القنوات المطلوبة المكررة: '+report.duplicateChannels+'\n'
    +'قواعد تتجاوز الحد: '+report.overLimitRules+'\n'
    +(report.reasons.length?'أسباب التنبيه: '+report.reasons.join(', ')+'\n':'')
    +'هذا فحص للحالة المحفوظة فقط، وليس تحققًا حيًا من Telegram.\n'
    +'لا يمكن تفعيل البوت أو تعديل شروط الاشتراك من تقرير الفحص.',
    [ownerMenuLabels.groups,ownerMenuLabels.settings]);
  }
  if(text===ownerMenuLabels.delivery){
   const jobs=state.telegramReplyJobs??[];
   const queued=jobs.filter(x=>x.status==='QUEUED').length;
   const uncertain=jobs.filter(x=>x.status==='UNKNOWN_OUTCOME'||x.status==='SENDING').length;
   const sent=jobs.filter(x=>x.status==='SENT').length;
   const pendingPublication=state.deliveries.filter(x=>
    ['QUEUED','MULTIPART','SENDING','UNKNOWN_OUTCOME'].includes(x.status)).length;
   return screen('<b>حالة الرسائل 📊</b>\n'
    +'ردود مرسلة ومؤكدة محليًا: '+sent+'\n'
    +'ردود في الانتظار: '+queued+'\n'
    +'محاولات مجهولة أو قيد الإرسال: '+uncertain+'\n'
    +'نشر حملات معلّق أو مجهول: '+pendingPublication+'\n'
    +'لا تعيد إرسال UNKNOWN تلقائيًا. فحص البيانات التفصيلي للمشغّل المحلي فقط.'
    );
  }
  if(text===ownerMenuLabels.settings){
   const groupModes=state.chats.filter(c=>c.approved).map(c=>c.groupAI);
   return screen('<b>إعدادات التشغيل ⚙️</b>\n'
    +'وضع AI في الخاص: '+line(state.privateAI,30)+'\n'
    +'مجموعات تستخدم سياسة AI غير OFF: '+groupModes.filter(x=>x!=='OFF').length+'\n'
    +'العمل مع مزود AI الخارجي غير موصل حتى الآن.\n'
    +'حالة مفتاح RUN/STOP الحقيقية ليست ضمن لوحة Telegram، '
    +'ولا يمكن تغيير ملف الطوارئ أو أسرار التشغيل بأزرار البوت.'
    );
  }
  const action=parseOwnerMenuAction(text);
  if(!action)return reject();
  const run=this.allowedRun(state,action.runId);
  if(!run)return reject();
  const button='🗃️ الاستيراد · '+run.id;
  if(action.action==='run')return this.pagedCandidates(run,0);
  const index=action.index!;
  const candidate=run.candidates[index];
  if(!candidate)return reject();
  if(action.action==='candidate'){
   const categories=await this.permittedCategories(run,ctx.actorId);
   const detail='<b>معاينة المرشح 📑</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'الدورة: '+line(candidate.cycle,40)+'\n'
    +'المرحلة: '+line(candidate.degree,40)+'\n'
    +'الحالة: '+line(candidate.status,30)+'\n';
   if(candidate.status==='READY')return this.categoryPage(run,index,ctx.actorId,0);
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+ownerCategoryToken(cat.id)]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const selectedToken=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  const matched=categories.filter(c=>ownerCategoryToken(c.id)===selectedToken);
  if(matched.length!==1)return reject();
  const categoryId=matched[0]!.id;
  if(action.action==='category'){
   if(candidate.status!=='READY')return reject();
   return screen('<b>تأكيد اعتماد مرشح</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'القسم: '+line(categories.find(c=>c.id===categoryId)!.title,100)+'\n'
    +'الاعتماد يسجل الموافقة فقط، ولا ينشر على Telegram.',
    ['✅ تأكيد الاعتماد · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='approve'){
   if(candidate.status!=='READY')return reject();
   try{await this.admin.approve(ctx,run.id,index,categoryId);}
   catch{return reject();}
   return screen('<b>تم اعتماد السجل محليًا ✅</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'لا يوجد نشر تلقائي. افحص معاينة النشر المحلي قبل إتاحته بالمكتبة.',
    ['📝 معاينة النشر · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(candidate.status!=='APPROVED'||candidate.categoryId!==categoryId)return reject();
  if(action.action==='previewPublish'){
   return screen('<b>معاينة النشر المحلي 📝</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'القسم: '+line(categories.find(x=>x.id===categoryId)!.title,100)+'\n'
    +'بالضغط على التأكيد يظهر المورد داخل مكتبة البوت المحلية فقط.\n'
    +'لن تُرسل رسالة إلى أي قناة Telegram.',
    ['📤 تأكيد النشر المحلي · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='publish'){
   try{
    const published=await this.admin.publish(ctx,run.id,index,categoryId);
    return screen('<b>تم النشر في المكتبة المحلية ✅</b>\n'
     +'المورد: '+line(published.title,120)+'\n'
     +'لا إرسال إلى قناة Telegram ولا تشغيل حملة.',
     [button,ownerMenuLabels.library]);
   }catch{return reject();}
  }
  return reject();
 }
}
,'u');
  const previewRe=new RegExp('^📝 معاينة إتاحة · '+resourceToken+':'+categoryToken+':'+digestToken+' Its cursor
  // is copied through reply-keyboard text and NEVER confers authentication.
  const platformPage=/^➡️ التالي · b5:([A-Za-z0-9_-]{1,64})$/u.exec(text);
  if(text===ownerMenuLabels.platformCatalog||
    text.startsWith('➡️ التالي · b5:')||text.startsWith('⬅️ السابق · b5:')){
   if(!this.platformCatalog||(!platformPage&&text!==ownerMenuLabels.platformCatalog))
    return reject();
   const inspected=await this.platformCatalog.preview(ctx.actorId,
     platformPage?{cursor:platformPage[1]!}:{});
   if(inspected.status==='DENIED')return reject();
   if(inspected.status==='UNAVAILABLE')
    return screen('<b>معاينة بيانات منارتك 🔎</b>\n'
     +'تعذر قراءة السجلات الخارجية بشكل آمن حاليًا.\n'
     +'لم يتم استيراد أو نشر أي مورد.',
     [ownerMenuLabels.settings]);
   if(inspected.status!=='PREVIEW')return reject();
   if(inspected.records.length===0)return screen(
    '<b>معاينة بيانات منارتك 🔎</b>\n'
    +'لا توجد سجلات منشورة في هذه الصفحة بحسب المصدر.\n'
    +'لم يتم اعتماد أي سجل داخل البوت.',
    [ownerMenuLabels.platformCatalog]);
   const pageCursor=platformPage?.[1]??'none';
   const rows=inspected.records.map((r,i)=>
    (i+1)+'. <code>'+r.id+'</code> — '+
    escapeTelegramListPreview(r.title,115)+'\n'
    +'الجامعة: '+escapeTelegramListPreview(r.university,70)).join('\n');
   return screen('<b>معاينة خارجية للمالك 🔎</b>\n'
    +'المصدر يدّعي نشر هذه السجلات، لكن لم يتحقق مالك البوت منها بعد.\n'
    +'الحالة: غير متحقق منها — لا اعتماد أو نشر تلقائي.\n'
    +rows+'\n'
    +'يمكن حفظ سجل للمراجعة فقط؛ ليس منحة معتمدة أو منشورة.',
    inspected.records.map(r=>'📥 تسجيل مرشح · '+r.id+':'+
     pageCursor+':'+inspected.fingerprint),{
     next:inspected.nextCursor?'➡️ التالي · b5:'+inspected.nextCursor:undefined
    });
  }
  const state=await this.store.snapshot();
  const pageRequest=parseOwnerMenuPageCommand(text);
  if(pageRequest){
   if(pageRequest.type==='imports')
    return this.pagedImports(state,pageRequest.page,pageRequest.direction);
   const run=pageRequest.runId?this.allowedRun(state,pageRequest.runId):null;
   if(!run)return reject();
   if(pageRequest.type==='candidates')
    return this.pagedCandidates(run,pageRequest.page,pageRequest.direction);
   if(pageRequest.index===undefined)return reject();
   return this.categoryPage(run,pageRequest.index,ctx.actorId,pageRequest.page,pageRequest.direction);
  }
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels).filter(x=>this.platformCatalog||x!==ownerMenuLabels.platformCatalog));
  }
  if(text===ownerMenuLabels.imports)return this.pagedImports(state,0);
  if(text===ownerMenuLabels.subscriptionHealth){
   // Owner UI is a read-only projection of current saved policy state, not
   // a substitute for the protected SQLite host audit or Telegram rights.
   const report=summarizeSubscriptionIntegrity(state);
   return screen('<b>سلامة قواعد الاشتراك 🛡</b>\n'
    +'النطاق: '+report.stage+'\n'
    +'النتيجة المحلية: '+report.status+'\n'
    +'القواعد المحفوظة: '+report.rules+'\n'
    +'القواعد النشطة: '+report.activeRules+'\n'
    +'القواعد المعلّقة/غير النشطة: '+report.inactiveRules+'\n'
    +'القواعد غير السليمة: '+report.invalidRules+'\n'
    +'مجموعات بلا تصريح تحقق: '+report.invalidGroups+'\n'
    +'قنوات بلا تصريح تحقق: '+report.invalidChannels+'\n'
    +'القنوات المطلوبة المكررة: '+report.duplicateChannels+'\n'
    +'قواعد تتجاوز الحد: '+report.overLimitRules+'\n'
    +(report.reasons.length?'أسباب التنبيه: '+report.reasons.join(', ')+'\n':'')
    +'هذا فحص للحالة المحفوظة فقط، وليس تحققًا حيًا من Telegram.\n'
    +'لا يمكن تفعيل البوت أو تعديل شروط الاشتراك من تقرير الفحص.',
    [ownerMenuLabels.groups,ownerMenuLabels.settings]);
  }
  if(text===ownerMenuLabels.delivery){
   const jobs=state.telegramReplyJobs??[];
   const queued=jobs.filter(x=>x.status==='QUEUED').length;
   const uncertain=jobs.filter(x=>x.status==='UNKNOWN_OUTCOME'||x.status==='SENDING').length;
   const sent=jobs.filter(x=>x.status==='SENT').length;
   const pendingPublication=state.deliveries.filter(x=>
    ['QUEUED','MULTIPART','SENDING','UNKNOWN_OUTCOME'].includes(x.status)).length;
   return screen('<b>حالة الرسائل 📊</b>\n'
    +'ردود مرسلة ومؤكدة محليًا: '+sent+'\n'
    +'ردود في الانتظار: '+queued+'\n'
    +'محاولات مجهولة أو قيد الإرسال: '+uncertain+'\n'
    +'نشر حملات معلّق أو مجهول: '+pendingPublication+'\n'
    +'لا تعيد إرسال UNKNOWN تلقائيًا. فحص البيانات التفصيلي للمشغّل المحلي فقط.'
    );
  }
  if(text===ownerMenuLabels.settings){
   const groupModes=state.chats.filter(c=>c.approved).map(c=>c.groupAI);
   return screen('<b>إعدادات التشغيل ⚙️</b>\n'
    +'وضع AI في الخاص: '+line(state.privateAI,30)+'\n'
    +'مجموعات تستخدم سياسة AI غير OFF: '+groupModes.filter(x=>x!=='OFF').length+'\n'
    +'العمل مع مزود AI الخارجي غير موصل حتى الآن.\n'
    +'حالة مفتاح RUN/STOP الحقيقية ليست ضمن لوحة Telegram، '
    +'ولا يمكن تغيير ملف الطوارئ أو أسرار التشغيل بأزرار البوت.'
    );
  }
  const action=parseOwnerMenuAction(text);
  if(!action)return reject();
  const run=this.allowedRun(state,action.runId);
  if(!run)return reject();
  const button='🗃️ الاستيراد · '+run.id;
  if(action.action==='run')return this.pagedCandidates(run,0);
  const index=action.index!;
  const candidate=run.candidates[index];
  if(!candidate)return reject();
  if(action.action==='candidate'){
   const categories=await this.permittedCategories(run,ctx.actorId);
   const detail='<b>معاينة المرشح 📑</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'الدورة: '+line(candidate.cycle,40)+'\n'
    +'المرحلة: '+line(candidate.degree,40)+'\n'
    +'الحالة: '+line(candidate.status,30)+'\n';
   if(candidate.status==='READY')return this.categoryPage(run,index,ctx.actorId,0);
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+ownerCategoryToken(cat.id)]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const selectedToken=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  const matched=categories.filter(c=>ownerCategoryToken(c.id)===selectedToken);
  if(matched.length!==1)return reject();
  const categoryId=matched[0]!.id;
  if(action.action==='category'){
   if(candidate.status!=='READY')return reject();
   return screen('<b>تأكيد اعتماد مرشح</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'القسم: '+line(categories.find(c=>c.id===categoryId)!.title,100)+'\n'
    +'الاعتماد يسجل الموافقة فقط، ولا ينشر على Telegram.',
    ['✅ تأكيد الاعتماد · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='approve'){
   if(candidate.status!=='READY')return reject();
   try{await this.admin.approve(ctx,run.id,index,categoryId);}
   catch{return reject();}
   return screen('<b>تم اعتماد السجل محليًا ✅</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'لا يوجد نشر تلقائي. افحص معاينة النشر المحلي قبل إتاحته بالمكتبة.',
    ['📝 معاينة النشر · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(candidate.status!=='APPROVED'||candidate.categoryId!==categoryId)return reject();
  if(action.action==='previewPublish'){
   return screen('<b>معاينة النشر المحلي 📝</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'القسم: '+line(categories.find(x=>x.id===categoryId)!.title,100)+'\n'
    +'بالضغط على التأكيد يظهر المورد داخل مكتبة البوت المحلية فقط.\n'
    +'لن تُرسل رسالة إلى أي قناة Telegram.',
    ['📤 تأكيد النشر المحلي · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='publish'){
   try{
    const published=await this.admin.publish(ctx,run.id,index,categoryId);
    return screen('<b>تم النشر في المكتبة المحلية ✅</b>\n'
     +'المورد: '+line(published.title,120)+'\n'
     +'لا إرسال إلى قناة Telegram ولا تشغيل حملة.',
     [button,ownerMenuLabels.library]);
   }catch{return reject();}
  }
  return reject();
 }
}
,'u');
  const publishRe=new RegExp('^📚 تأكيد إتاحة محلية · '+resourceToken+':'+categoryToken+':'+digestToken+' Its cursor
  // is copied through reply-keyboard text and NEVER confers authentication.
  const platformPage=/^➡️ التالي · b5:([A-Za-z0-9_-]{1,64})$/u.exec(text);
  if(text===ownerMenuLabels.platformCatalog||
    text.startsWith('➡️ التالي · b5:')||text.startsWith('⬅️ السابق · b5:')){
   if(!this.platformCatalog||(!platformPage&&text!==ownerMenuLabels.platformCatalog))
    return reject();
   const inspected=await this.platformCatalog.preview(ctx.actorId,
     platformPage?{cursor:platformPage[1]!}:{});
   if(inspected.status==='DENIED')return reject();
   if(inspected.status==='UNAVAILABLE')
    return screen('<b>معاينة بيانات منارتك 🔎</b>\n'
     +'تعذر قراءة السجلات الخارجية بشكل آمن حاليًا.\n'
     +'لم يتم استيراد أو نشر أي مورد.',
     [ownerMenuLabels.settings]);
   if(inspected.status!=='PREVIEW')return reject();
   if(inspected.records.length===0)return screen(
    '<b>معاينة بيانات منارتك 🔎</b>\n'
    +'لا توجد سجلات منشورة في هذه الصفحة بحسب المصدر.\n'
    +'لم يتم اعتماد أي سجل داخل البوت.',
    [ownerMenuLabels.platformCatalog]);
   const pageCursor=platformPage?.[1]??'none';
   const rows=inspected.records.map((r,i)=>
    (i+1)+'. <code>'+r.id+'</code> — '+
    escapeTelegramListPreview(r.title,115)+'\n'
    +'الجامعة: '+escapeTelegramListPreview(r.university,70)).join('\n');
   return screen('<b>معاينة خارجية للمالك 🔎</b>\n'
    +'المصدر يدّعي نشر هذه السجلات، لكن لم يتحقق مالك البوت منها بعد.\n'
    +'الحالة: غير متحقق منها — لا اعتماد أو نشر تلقائي.\n'
    +rows+'\n'
    +'يمكن حفظ سجل للمراجعة فقط؛ ليس منحة معتمدة أو منشورة.',
    inspected.records.map(r=>'📥 تسجيل مرشح · '+r.id+':'+
     pageCursor+':'+inspected.fingerprint),{
     next:inspected.nextCursor?'➡️ التالي · b5:'+inspected.nextCursor:undefined
    });
  }
  const state=await this.store.snapshot();
  const pageRequest=parseOwnerMenuPageCommand(text);
  if(pageRequest){
   if(pageRequest.type==='imports')
    return this.pagedImports(state,pageRequest.page,pageRequest.direction);
   const run=pageRequest.runId?this.allowedRun(state,pageRequest.runId):null;
   if(!run)return reject();
   if(pageRequest.type==='candidates')
    return this.pagedCandidates(run,pageRequest.page,pageRequest.direction);
   if(pageRequest.index===undefined)return reject();
   return this.categoryPage(run,pageRequest.index,ctx.actorId,pageRequest.page,pageRequest.direction);
  }
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels).filter(x=>this.platformCatalog||x!==ownerMenuLabels.platformCatalog));
  }
  if(text===ownerMenuLabels.imports)return this.pagedImports(state,0);
  if(text===ownerMenuLabels.subscriptionHealth){
   // Owner UI is a read-only projection of current saved policy state, not
   // a substitute for the protected SQLite host audit or Telegram rights.
   const report=summarizeSubscriptionIntegrity(state);
   return screen('<b>سلامة قواعد الاشتراك 🛡</b>\n'
    +'النطاق: '+report.stage+'\n'
    +'النتيجة المحلية: '+report.status+'\n'
    +'القواعد المحفوظة: '+report.rules+'\n'
    +'القواعد النشطة: '+report.activeRules+'\n'
    +'القواعد المعلّقة/غير النشطة: '+report.inactiveRules+'\n'
    +'القواعد غير السليمة: '+report.invalidRules+'\n'
    +'مجموعات بلا تصريح تحقق: '+report.invalidGroups+'\n'
    +'قنوات بلا تصريح تحقق: '+report.invalidChannels+'\n'
    +'القنوات المطلوبة المكررة: '+report.duplicateChannels+'\n'
    +'قواعد تتجاوز الحد: '+report.overLimitRules+'\n'
    +(report.reasons.length?'أسباب التنبيه: '+report.reasons.join(', ')+'\n':'')
    +'هذا فحص للحالة المحفوظة فقط، وليس تحققًا حيًا من Telegram.\n'
    +'لا يمكن تفعيل البوت أو تعديل شروط الاشتراك من تقرير الفحص.',
    [ownerMenuLabels.groups,ownerMenuLabels.settings]);
  }
  if(text===ownerMenuLabels.delivery){
   const jobs=state.telegramReplyJobs??[];
   const queued=jobs.filter(x=>x.status==='QUEUED').length;
   const uncertain=jobs.filter(x=>x.status==='UNKNOWN_OUTCOME'||x.status==='SENDING').length;
   const sent=jobs.filter(x=>x.status==='SENT').length;
   const pendingPublication=state.deliveries.filter(x=>
    ['QUEUED','MULTIPART','SENDING','UNKNOWN_OUTCOME'].includes(x.status)).length;
   return screen('<b>حالة الرسائل 📊</b>\n'
    +'ردود مرسلة ومؤكدة محليًا: '+sent+'\n'
    +'ردود في الانتظار: '+queued+'\n'
    +'محاولات مجهولة أو قيد الإرسال: '+uncertain+'\n'
    +'نشر حملات معلّق أو مجهول: '+pendingPublication+'\n'
    +'لا تعيد إرسال UNKNOWN تلقائيًا. فحص البيانات التفصيلي للمشغّل المحلي فقط.'
    );
  }
  if(text===ownerMenuLabels.settings){
   const groupModes=state.chats.filter(c=>c.approved).map(c=>c.groupAI);
   return screen('<b>إعدادات التشغيل ⚙️</b>\n'
    +'وضع AI في الخاص: '+line(state.privateAI,30)+'\n'
    +'مجموعات تستخدم سياسة AI غير OFF: '+groupModes.filter(x=>x!=='OFF').length+'\n'
    +'العمل مع مزود AI الخارجي غير موصل حتى الآن.\n'
    +'حالة مفتاح RUN/STOP الحقيقية ليست ضمن لوحة Telegram، '
    +'ولا يمكن تغيير ملف الطوارئ أو أسرار التشغيل بأزرار البوت.'
    );
  }
  const action=parseOwnerMenuAction(text);
  if(!action)return reject();
  const run=this.allowedRun(state,action.runId);
  if(!run)return reject();
  const button='🗃️ الاستيراد · '+run.id;
  if(action.action==='run')return this.pagedCandidates(run,0);
  const index=action.index!;
  const candidate=run.candidates[index];
  if(!candidate)return reject();
  if(action.action==='candidate'){
   const categories=await this.permittedCategories(run,ctx.actorId);
   const detail='<b>معاينة المرشح 📑</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'الدورة: '+line(candidate.cycle,40)+'\n'
    +'المرحلة: '+line(candidate.degree,40)+'\n'
    +'الحالة: '+line(candidate.status,30)+'\n';
   if(candidate.status==='READY')return this.categoryPage(run,index,ctx.actorId,0);
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+ownerCategoryToken(cat.id)]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const selectedToken=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  const matched=categories.filter(c=>ownerCategoryToken(c.id)===selectedToken);
  if(matched.length!==1)return reject();
  const categoryId=matched[0]!.id;
  if(action.action==='category'){
   if(candidate.status!=='READY')return reject();
   return screen('<b>تأكيد اعتماد مرشح</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'القسم: '+line(categories.find(c=>c.id===categoryId)!.title,100)+'\n'
    +'الاعتماد يسجل الموافقة فقط، ولا ينشر على Telegram.',
    ['✅ تأكيد الاعتماد · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='approve'){
   if(candidate.status!=='READY')return reject();
   try{await this.admin.approve(ctx,run.id,index,categoryId);}
   catch{return reject();}
   return screen('<b>تم اعتماد السجل محليًا ✅</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'لا يوجد نشر تلقائي. افحص معاينة النشر المحلي قبل إتاحته بالمكتبة.',
    ['📝 معاينة النشر · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(candidate.status!=='APPROVED'||candidate.categoryId!==categoryId)return reject();
  if(action.action==='previewPublish'){
   return screen('<b>معاينة النشر المحلي 📝</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'القسم: '+line(categories.find(x=>x.id===categoryId)!.title,100)+'\n'
    +'بالضغط على التأكيد يظهر المورد داخل مكتبة البوت المحلية فقط.\n'
    +'لن تُرسل رسالة إلى أي قناة Telegram.',
    ['📤 تأكيد النشر المحلي · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='publish'){
   try{
    const published=await this.admin.publish(ctx,run.id,index,categoryId);
    return screen('<b>تم النشر في المكتبة المحلية ✅</b>\n'
     +'المورد: '+line(published.title,120)+'\n'
     +'لا إرسال إلى قناة Telegram ولا تشغيل حملة.',
     [button,ownerMenuLabels.library]);
   }catch{return reject();}
  }
  return reject();
 }
}
,'u');
  const categoryPageRe=new RegExp('^(➡️ التالي|⬅️ السابق) · b5c:'+resourceToken+':'+digestToken+':(0|[1-9][0-9]{0,2}) Its cursor
  // is copied through reply-keyboard text and NEVER confers authentication.
  const platformPage=/^➡️ التالي · b5:([A-Za-z0-9_-]{1,64})$/u.exec(text);
  if(text===ownerMenuLabels.platformCatalog||
    text.startsWith('➡️ التالي · b5:')||text.startsWith('⬅️ السابق · b5:')){
   if(!this.platformCatalog||(!platformPage&&text!==ownerMenuLabels.platformCatalog))
    return reject();
   const inspected=await this.platformCatalog.preview(ctx.actorId,
     platformPage?{cursor:platformPage[1]!}:{});
   if(inspected.status==='DENIED')return reject();
   if(inspected.status==='UNAVAILABLE')
    return screen('<b>معاينة بيانات منارتك 🔎</b>\n'
     +'تعذر قراءة السجلات الخارجية بشكل آمن حاليًا.\n'
     +'لم يتم استيراد أو نشر أي مورد.',
     [ownerMenuLabels.settings]);
   if(inspected.status!=='PREVIEW')return reject();
   if(inspected.records.length===0)return screen(
    '<b>معاينة بيانات منارتك 🔎</b>\n'
    +'لا توجد سجلات منشورة في هذه الصفحة بحسب المصدر.\n'
    +'لم يتم اعتماد أي سجل داخل البوت.',
    [ownerMenuLabels.platformCatalog]);
   const pageCursor=platformPage?.[1]??'none';
   const rows=inspected.records.map((r,i)=>
    (i+1)+'. <code>'+r.id+'</code> — '+
    escapeTelegramListPreview(r.title,115)+'\n'
    +'الجامعة: '+escapeTelegramListPreview(r.university,70)).join('\n');
   return screen('<b>معاينة خارجية للمالك 🔎</b>\n'
    +'المصدر يدّعي نشر هذه السجلات، لكن لم يتحقق مالك البوت منها بعد.\n'
    +'الحالة: غير متحقق منها — لا اعتماد أو نشر تلقائي.\n'
    +rows+'\n'
    +'يمكن حفظ سجل للمراجعة فقط؛ ليس منحة معتمدة أو منشورة.',
    inspected.records.map(r=>'📥 تسجيل مرشح · '+r.id+':'+
     pageCursor+':'+inspected.fingerprint),{
     next:inspected.nextCursor?'➡️ التالي · b5:'+inspected.nextCursor:undefined
    });
  }
  const state=await this.store.snapshot();
  const pageRequest=parseOwnerMenuPageCommand(text);
  if(pageRequest){
   if(pageRequest.type==='imports')
    return this.pagedImports(state,pageRequest.page,pageRequest.direction);
   const run=pageRequest.runId?this.allowedRun(state,pageRequest.runId):null;
   if(!run)return reject();
   if(pageRequest.type==='candidates')
    return this.pagedCandidates(run,pageRequest.page,pageRequest.direction);
   if(pageRequest.index===undefined)return reject();
   return this.categoryPage(run,pageRequest.index,ctx.actorId,pageRequest.page,pageRequest.direction);
  }
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels).filter(x=>this.platformCatalog||x!==ownerMenuLabels.platformCatalog));
  }
  if(text===ownerMenuLabels.imports)return this.pagedImports(state,0);
  if(text===ownerMenuLabels.subscriptionHealth){
   // Owner UI is a read-only projection of current saved policy state, not
   // a substitute for the protected SQLite host audit or Telegram rights.
   const report=summarizeSubscriptionIntegrity(state);
   return screen('<b>سلامة قواعد الاشتراك 🛡</b>\n'
    +'النطاق: '+report.stage+'\n'
    +'النتيجة المحلية: '+report.status+'\n'
    +'القواعد المحفوظة: '+report.rules+'\n'
    +'القواعد النشطة: '+report.activeRules+'\n'
    +'القواعد المعلّقة/غير النشطة: '+report.inactiveRules+'\n'
    +'القواعد غير السليمة: '+report.invalidRules+'\n'
    +'مجموعات بلا تصريح تحقق: '+report.invalidGroups+'\n'
    +'قنوات بلا تصريح تحقق: '+report.invalidChannels+'\n'
    +'القنوات المطلوبة المكررة: '+report.duplicateChannels+'\n'
    +'قواعد تتجاوز الحد: '+report.overLimitRules+'\n'
    +(report.reasons.length?'أسباب التنبيه: '+report.reasons.join(', ')+'\n':'')
    +'هذا فحص للحالة المحفوظة فقط، وليس تحققًا حيًا من Telegram.\n'
    +'لا يمكن تفعيل البوت أو تعديل شروط الاشتراك من تقرير الفحص.',
    [ownerMenuLabels.groups,ownerMenuLabels.settings]);
  }
  if(text===ownerMenuLabels.delivery){
   const jobs=state.telegramReplyJobs??[];
   const queued=jobs.filter(x=>x.status==='QUEUED').length;
   const uncertain=jobs.filter(x=>x.status==='UNKNOWN_OUTCOME'||x.status==='SENDING').length;
   const sent=jobs.filter(x=>x.status==='SENT').length;
   const pendingPublication=state.deliveries.filter(x=>
    ['QUEUED','MULTIPART','SENDING','UNKNOWN_OUTCOME'].includes(x.status)).length;
   return screen('<b>حالة الرسائل 📊</b>\n'
    +'ردود مرسلة ومؤكدة محليًا: '+sent+'\n'
    +'ردود في الانتظار: '+queued+'\n'
    +'محاولات مجهولة أو قيد الإرسال: '+uncertain+'\n'
    +'نشر حملات معلّق أو مجهول: '+pendingPublication+'\n'
    +'لا تعيد إرسال UNKNOWN تلقائيًا. فحص البيانات التفصيلي للمشغّل المحلي فقط.'
    );
  }
  if(text===ownerMenuLabels.settings){
   const groupModes=state.chats.filter(c=>c.approved).map(c=>c.groupAI);
   return screen('<b>إعدادات التشغيل ⚙️</b>\n'
    +'وضع AI في الخاص: '+line(state.privateAI,30)+'\n'
    +'مجموعات تستخدم سياسة AI غير OFF: '+groupModes.filter(x=>x!=='OFF').length+'\n'
    +'العمل مع مزود AI الخارجي غير موصل حتى الآن.\n'
    +'حالة مفتاح RUN/STOP الحقيقية ليست ضمن لوحة Telegram، '
    +'ولا يمكن تغيير ملف الطوارئ أو أسرار التشغيل بأزرار البوت.'
    );
  }
  const action=parseOwnerMenuAction(text);
  if(!action)return reject();
  const run=this.allowedRun(state,action.runId);
  if(!run)return reject();
  const button='🗃️ الاستيراد · '+run.id;
  if(action.action==='run')return this.pagedCandidates(run,0);
  const index=action.index!;
  const candidate=run.candidates[index];
  if(!candidate)return reject();
  if(action.action==='candidate'){
   const categories=await this.permittedCategories(run,ctx.actorId);
   const detail='<b>معاينة المرشح 📑</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'الدورة: '+line(candidate.cycle,40)+'\n'
    +'المرحلة: '+line(candidate.degree,40)+'\n'
    +'الحالة: '+line(candidate.status,30)+'\n';
   if(candidate.status==='READY')return this.categoryPage(run,index,ctx.actorId,0);
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+ownerCategoryToken(cat.id)]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const selectedToken=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  const matched=categories.filter(c=>ownerCategoryToken(c.id)===selectedToken);
  if(matched.length!==1)return reject();
  const categoryId=matched[0]!.id;
  if(action.action==='category'){
   if(candidate.status!=='READY')return reject();
   return screen('<b>تأكيد اعتماد مرشح</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'القسم: '+line(categories.find(c=>c.id===categoryId)!.title,100)+'\n'
    +'الاعتماد يسجل الموافقة فقط، ولا ينشر على Telegram.',
    ['✅ تأكيد الاعتماد · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='approve'){
   if(candidate.status!=='READY')return reject();
   try{await this.admin.approve(ctx,run.id,index,categoryId);}
   catch{return reject();}
   return screen('<b>تم اعتماد السجل محليًا ✅</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'لا يوجد نشر تلقائي. افحص معاينة النشر المحلي قبل إتاحته بالمكتبة.',
    ['📝 معاينة النشر · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(candidate.status!=='APPROVED'||candidate.categoryId!==categoryId)return reject();
  if(action.action==='previewPublish'){
   return screen('<b>معاينة النشر المحلي 📝</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'القسم: '+line(categories.find(x=>x.id===categoryId)!.title,100)+'\n'
    +'بالضغط على التأكيد يظهر المورد داخل مكتبة البوت المحلية فقط.\n'
    +'لن تُرسل رسالة إلى أي قناة Telegram.',
    ['📤 تأكيد النشر المحلي · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='publish'){
   try{
    const published=await this.admin.publish(ctx,run.id,index,categoryId);
    return screen('<b>تم النشر في المكتبة المحلية ✅</b>\n'
     +'المورد: '+line(published.title,120)+'\n'
     +'لا إرسال إلى قناة Telegram ولا تشغيل حملة.',
     [button,ownerMenuLabels.library]);
   }catch{return reject();}
  }
  return reject();
 }
}
,'u');
  const picker=pickerRe.exec(text),category=categoryRe.exec(text),
   approval=approveRe.exec(text),publicationPreview=previewRe.exec(text),
   publication=publishRe.exec(text),categoryPage=categoryPageRe.exec(text);
  const isLocalAction=text.startsWith('📋 اختيار قسم · ')||
   text.startsWith('📁 تعيين قسم · ')||
   text.startsWith('✅ تأكيد اعتماد محلي · ')||
   text.startsWith('📝 معاينة إتاحة · ')||
   text.startsWith('📚 تأكيد إتاحة محلية · ')||
   text.startsWith('➡️ التالي · b5c:')||text.startsWith('⬅️ السابق · b5c:');
  if(isLocalAction){
   if(!this.platformCatalog||!(picker||category||approval||
     publicationPreview||publication||categoryPage))return reject();
   const sourceId=(picker?.[1]??category?.[1]??approval?.[1]??
     publicationPreview?.[1]??publication?.[1]??categoryPage?.[2])!;
   const digest=(picker?.[2]??category?.[3]??approval?.[3]??
     publicationPreview?.[3]??publication?.[3]??categoryPage?.[3])!;
   const saved=(await this.store.snapshot()).platformReviewQueue?.find(q=>
     q.sourceId===sourceId&&q.digest===digest);
   if(!saved)return reject();
   const categories=await this.education.listCategories(ctx.actorId,'private');
   if(picker||categoryPage){
    if(saved.status!=='REVIEWED_METADATA_ONLY')return reject();
    const page=categoryPage?Number(categoryPage[4]):0;
    const count=Math.ceil(categories.length/8);
    if(!count||page>=count||
      (categoryPage?.[1]==='➡️ التالي'&&page===0)||
      (categoryPage?.[1]==='⬅️ السابق'&&page===count-1))return reject();
    const items=categories.slice(page*8,page*8+8);
    return screen('<b>اختيار قسم اعتماد المرشح 📋</b>\n'
     +'المصدر: <code>'+sourceId+'</code>\n'
     +'العنوان: '+escapeTelegramListPreview(saved.title,150)+'\n'
     +'الاعتماد خطوة منفصلة ولا يجعل المورد منشورًا.\n'
     +'صفحة '+(page+1)+' من '+count,
     items.map(cat=>'📁 تعيين قسم · '+sourceId+':'+cat.id+':'+digest),{
      previous:page>0?'⬅️ السابق · b5c:'+sourceId+':'+digest+':'+(page-1):undefined,
      next:page+1<count?'➡️ التالي · b5c:'+sourceId+':'+digest+':'+(page+1):undefined
     });
   }
   const categoryId=(category?.[2]??approval?.[2]??
     publicationPreview?.[2]??publication?.[2])!;
   const currentCategory=categories.find(c=>c.id===categoryId);
   if(!currentCategory)return reject();
   if(category){
    if(saved.status!=='REVIEWED_METADATA_ONLY')return reject();
    return screen('<b>معاينة اعتماد مرشح خارجي 📁</b>\n'
     +'العنوان: '+escapeTelegramListPreview(saved.title,160)+'\n'
     +'القسم: '+escapeTelegramListPreview(currentCategory.title,160)+'\n'
     +'هل تؤكد اعتماد البيانات لهذا القسم فقط؟ لن تُنشر للطلاب بعد.',
     ['✅ تأكيد اعتماد محلي · '+sourceId+':'+categoryId+':'+digest,
      ownerMenuLabels.platformCatalog]);
   }
   if(approval){
    const response=await this.platformCatalog.approveForLocal(ctx.actorId,
      sourceId,digest,categoryId);
    if(response.status!=='APPROVED')return reject();
    return screen('<b>تم اعتماد المرشح محليًا ✅</b>\n'
     +'القسم: '+escapeTelegramListPreview(currentCategory.title,150)+'\n'
     +'لم يُنشر للطلاب بعد. راجع خطوة الإتاحة المنفصلة.',
     ['📝 معاينة إتاحة · '+sourceId+':'+categoryId+':'+digest,
      ownerMenuLabels.platformCatalog]);
   }
   if(publicationPreview){
    if(saved.status!=='APPROVED_FOR_LOCAL'||
       saved.approvedCategoryId!==categoryId)return reject();
    return screen('<b>معاينة الإتاحة بالمكتبة المحلية 📝</b>\n'
     +'العنوان: '+escapeTelegramListPreview(saved.title,160)+'\n'
     +'الجامعة: '+escapeTelegramListPreview(saved.university,110)+'\n'
     +'القسم: '+escapeTelegramListPreview(currentCategory.title,140)+'\n'
     +'المقاعد: غير محددة. هذه بيانات مراجعة وليست ضمان قبول.\n'
     +'هذا التأكيد يتيح المورد داخل مكتبة الخاص فقط؛ لا إرسال إلى قناة Telegram.',
     ['📚 تأكيد إتاحة محلية · '+sourceId+':'+categoryId+':'+digest,
      ownerMenuLabels.platformCatalog]);
   }
   if(publication){
    const response=await this.platformCatalog.publishLocally(ctx.actorId,
      sourceId,digest,categoryId);
    if(response.status!=='PUBLISHED')return reject();
    return screen('<b>تم نشر المورد في المكتبة المحلية ✅</b>\n'
     +'العنوان: '+escapeTelegramListPreview(response.resource.title,160)+'\n'
     +'المعرف: <code>'+response.resource.id+'</code>\n'
     +'لا إرسال لقنوات Telegram ولا إطلاق حملات تلقائيًا.',
     [ownerMenuLabels.library,ownerMenuLabels.platformCatalog]);
   }
   return reject();
  }
  // A platform catalogue page is only a read-only owner request. Its cursor
  // is copied through reply-keyboard text and NEVER confers authentication.
  const platformPage=/^➡️ التالي · b5:([A-Za-z0-9_-]{1,64})$/u.exec(text);
  if(text===ownerMenuLabels.platformCatalog||
    text.startsWith('➡️ التالي · b5:')||text.startsWith('⬅️ السابق · b5:')){
   if(!this.platformCatalog||(!platformPage&&text!==ownerMenuLabels.platformCatalog))
    return reject();
   const inspected=await this.platformCatalog.preview(ctx.actorId,
     platformPage?{cursor:platformPage[1]!}:{});
   if(inspected.status==='DENIED')return reject();
   if(inspected.status==='UNAVAILABLE')
    return screen('<b>معاينة بيانات منارتك 🔎</b>\n'
     +'تعذر قراءة السجلات الخارجية بشكل آمن حاليًا.\n'
     +'لم يتم استيراد أو نشر أي مورد.',
     [ownerMenuLabels.settings]);
   if(inspected.status!=='PREVIEW')return reject();
   if(inspected.records.length===0)return screen(
    '<b>معاينة بيانات منارتك 🔎</b>\n'
    +'لا توجد سجلات منشورة في هذه الصفحة بحسب المصدر.\n'
    +'لم يتم اعتماد أي سجل داخل البوت.',
    [ownerMenuLabels.platformCatalog]);
   const pageCursor=platformPage?.[1]??'none';
   const rows=inspected.records.map((r,i)=>
    (i+1)+'. <code>'+r.id+'</code> — '+
    escapeTelegramListPreview(r.title,115)+'\n'
    +'الجامعة: '+escapeTelegramListPreview(r.university,70)).join('\n');
   return screen('<b>معاينة خارجية للمالك 🔎</b>\n'
    +'المصدر يدّعي نشر هذه السجلات، لكن لم يتحقق مالك البوت منها بعد.\n'
    +'الحالة: غير متحقق منها — لا اعتماد أو نشر تلقائي.\n'
    +rows+'\n'
    +'يمكن حفظ سجل للمراجعة فقط؛ ليس منحة معتمدة أو منشورة.',
    inspected.records.map(r=>'📥 تسجيل مرشح · '+r.id+':'+
     pageCursor+':'+inspected.fingerprint),{
     next:inspected.nextCursor?'➡️ التالي · b5:'+inspected.nextCursor:undefined
    });
  }
  const state=await this.store.snapshot();
  const pageRequest=parseOwnerMenuPageCommand(text);
  if(pageRequest){
   if(pageRequest.type==='imports')
    return this.pagedImports(state,pageRequest.page,pageRequest.direction);
   const run=pageRequest.runId?this.allowedRun(state,pageRequest.runId):null;
   if(!run)return reject();
   if(pageRequest.type==='candidates')
    return this.pagedCandidates(run,pageRequest.page,pageRequest.direction);
   if(pageRequest.index===undefined)return reject();
   return this.categoryPage(run,pageRequest.index,ctx.actorId,pageRequest.page,pageRequest.direction);
  }
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels).filter(x=>this.platformCatalog||x!==ownerMenuLabels.platformCatalog));
  }
  if(text===ownerMenuLabels.imports)return this.pagedImports(state,0);
  if(text===ownerMenuLabels.subscriptionHealth){
   // Owner UI is a read-only projection of current saved policy state, not
   // a substitute for the protected SQLite host audit or Telegram rights.
   const report=summarizeSubscriptionIntegrity(state);
   return screen('<b>سلامة قواعد الاشتراك 🛡</b>\n'
    +'النطاق: '+report.stage+'\n'
    +'النتيجة المحلية: '+report.status+'\n'
    +'القواعد المحفوظة: '+report.rules+'\n'
    +'القواعد النشطة: '+report.activeRules+'\n'
    +'القواعد المعلّقة/غير النشطة: '+report.inactiveRules+'\n'
    +'القواعد غير السليمة: '+report.invalidRules+'\n'
    +'مجموعات بلا تصريح تحقق: '+report.invalidGroups+'\n'
    +'قنوات بلا تصريح تحقق: '+report.invalidChannels+'\n'
    +'القنوات المطلوبة المكررة: '+report.duplicateChannels+'\n'
    +'قواعد تتجاوز الحد: '+report.overLimitRules+'\n'
    +(report.reasons.length?'أسباب التنبيه: '+report.reasons.join(', ')+'\n':'')
    +'هذا فحص للحالة المحفوظة فقط، وليس تحققًا حيًا من Telegram.\n'
    +'لا يمكن تفعيل البوت أو تعديل شروط الاشتراك من تقرير الفحص.',
    [ownerMenuLabels.groups,ownerMenuLabels.settings]);
  }
  if(text===ownerMenuLabels.delivery){
   const jobs=state.telegramReplyJobs??[];
   const queued=jobs.filter(x=>x.status==='QUEUED').length;
   const uncertain=jobs.filter(x=>x.status==='UNKNOWN_OUTCOME'||x.status==='SENDING').length;
   const sent=jobs.filter(x=>x.status==='SENT').length;
   const pendingPublication=state.deliveries.filter(x=>
    ['QUEUED','MULTIPART','SENDING','UNKNOWN_OUTCOME'].includes(x.status)).length;
   return screen('<b>حالة الرسائل 📊</b>\n'
    +'ردود مرسلة ومؤكدة محليًا: '+sent+'\n'
    +'ردود في الانتظار: '+queued+'\n'
    +'محاولات مجهولة أو قيد الإرسال: '+uncertain+'\n'
    +'نشر حملات معلّق أو مجهول: '+pendingPublication+'\n'
    +'لا تعيد إرسال UNKNOWN تلقائيًا. فحص البيانات التفصيلي للمشغّل المحلي فقط.'
    );
  }
  if(text===ownerMenuLabels.settings){
   const groupModes=state.chats.filter(c=>c.approved).map(c=>c.groupAI);
   return screen('<b>إعدادات التشغيل ⚙️</b>\n'
    +'وضع AI في الخاص: '+line(state.privateAI,30)+'\n'
    +'مجموعات تستخدم سياسة AI غير OFF: '+groupModes.filter(x=>x!=='OFF').length+'\n'
    +'العمل مع مزود AI الخارجي غير موصل حتى الآن.\n'
    +'حالة مفتاح RUN/STOP الحقيقية ليست ضمن لوحة Telegram، '
    +'ولا يمكن تغيير ملف الطوارئ أو أسرار التشغيل بأزرار البوت.'
    );
  }
  const action=parseOwnerMenuAction(text);
  if(!action)return reject();
  const run=this.allowedRun(state,action.runId);
  if(!run)return reject();
  const button='🗃️ الاستيراد · '+run.id;
  if(action.action==='run')return this.pagedCandidates(run,0);
  const index=action.index!;
  const candidate=run.candidates[index];
  if(!candidate)return reject();
  if(action.action==='candidate'){
   const categories=await this.permittedCategories(run,ctx.actorId);
   const detail='<b>معاينة المرشح 📑</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'الدورة: '+line(candidate.cycle,40)+'\n'
    +'المرحلة: '+line(candidate.degree,40)+'\n'
    +'الحالة: '+line(candidate.status,30)+'\n';
   if(candidate.status==='READY')return this.categoryPage(run,index,ctx.actorId,0);
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+ownerCategoryToken(cat.id)]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const selectedToken=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  const matched=categories.filter(c=>ownerCategoryToken(c.id)===selectedToken);
  if(matched.length!==1)return reject();
  const categoryId=matched[0]!.id;
  if(action.action==='category'){
   if(candidate.status!=='READY')return reject();
   return screen('<b>تأكيد اعتماد مرشح</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'القسم: '+line(categories.find(c=>c.id===categoryId)!.title,100)+'\n'
    +'الاعتماد يسجل الموافقة فقط، ولا ينشر على Telegram.',
    ['✅ تأكيد الاعتماد · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='approve'){
   if(candidate.status!=='READY')return reject();
   try{await this.admin.approve(ctx,run.id,index,categoryId);}
   catch{return reject();}
   return screen('<b>تم اعتماد السجل محليًا ✅</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'لا يوجد نشر تلقائي. افحص معاينة النشر المحلي قبل إتاحته بالمكتبة.',
    ['📝 معاينة النشر · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(candidate.status!=='APPROVED'||candidate.categoryId!==categoryId)return reject();
  if(action.action==='previewPublish'){
   return screen('<b>معاينة النشر المحلي 📝</b>\n'
    +'العنوان: '+line(candidate.title,120)+'\n'
    +'الجامعة: '+line(candidate.university,100)+'\n'
    +'القسم: '+line(categories.find(x=>x.id===categoryId)!.title,100)+'\n'
    +'بالضغط على التأكيد يظهر المورد داخل مكتبة البوت المحلية فقط.\n'
    +'لن تُرسل رسالة إلى أي قناة Telegram.',
    ['📤 تأكيد النشر المحلي · '+run.id+':'+index+':'+selectedToken,button]);
  }
  if(action.action==='publish'){
   try{
    const published=await this.admin.publish(ctx,run.id,index,categoryId);
    return screen('<b>تم النشر في المكتبة المحلية ✅</b>\n'
     +'المورد: '+line(published.title,120)+'\n'
     +'لا إرسال إلى قناة Telegram ولا تشغيل حملة.',
     [button,ownerMenuLabels.library]);
   }catch{return reject();}
  }
  return reject();
 }
}
