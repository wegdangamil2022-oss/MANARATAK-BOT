import {createHash} from 'node:crypto';
import type {BotStore,BotState,ImportRun} from './store.js';
import type {Policy} from './policy.js';
import type {EducationService} from './education.js';
import type {EducationAdminFacade,VerifiedAdminContext} from './education-admin.js';
import {menuLabels,type TelegramReplyKeyboard} from './telegram-menu.js';

export const ownerMenuLabels={
 imports:'🧾 مراجعة الوارد',
 library:'📚 إدارة المكتبة',
 groups:'👥 المجموعات المعتمدة',
 delivery:'📊 حالة الرسائل',
 settings:'⚙️ إعدادات التشغيل',
} as const;
type OwnerMenuAction={
 action:'run'|'candidate'|'category'|'approve'|'previewPublish'|'publish';
 runId:string;index?:number;categoryId?:string;
};
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const refRe=new RegExp('^('+uuid+')$','u');
const two=new RegExp('^('+uuid+'):(0|[1-9][0-9]{0,4})$','u');
const three=new RegExp('^('+uuid+'):(0|[1-9][0-9]{0,4}):([a-zA-Z0-9_-]{1,64}|~[a-f0-9]{16})
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
/** Short text selectors use full IDs. Lengthy IDs become disjoint, fixed-size
 * fingerprints. These are NOT tokens of authorization: the handler resolves
 * them among newly authorized categories and denies ambiguous matches.
 */
export function ownerCategoryToken(id:string):string{
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id))throw Error('INVALID_OWNER_CATEGORY_ID');
 return id.length<=24?id:'~'+createHash('sha256').update(id,'utf8').digest('hex').slice(0,16);
}
export interface OwnerMenuPage{
 type:'imports'|'candidates';runId?:string;page:number;direction:'next'|'previous';
}
const pageRe=new RegExp('^(➡️ التالي|⬅️ السابق) · o:(i|c)(?::('+uuid+'))?:(0|[1-9][0-9]{0,2})
/** Distinguish an owner-only choice (even malformed) from an unrelated
 * ordinary student message. Never use text alone to authenticate its sender.
 */
export function isOwnerMenuText(text:string):boolean{
 return text===menuLabels.owner||sections.has(text)||
  text.startsWith('➡️ التالي · o:')||text.startsWith('⬅️ السابق · o:')||
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
  private readonly admin:EducationAdminFacade
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
 private validPage(page:number,direction:OwnerMenuPage['direction']|undefined,count:number):boolean{
  const pages=Math.ceil(count/10);
  if(page<0||page>=pages)return false;
  if(direction==='next'&&page===0)return false;
  if(direction==='previous'&&page>=pages-1)return false;
  return true;
 }
 private pagedImports(state:BotState,page:number,direction?:OwnerMenuPage['direction']):OwnerMenuScreen|null{
  const visible=state.importRuns.filter(r=>Boolean(this.allowedRun(state,r.id)))
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
  if(!visible.length&&page===0&&!direction)
   return screen('<b>مراجعة الاستيراد 🧾</b>\nلا توجد دفعات محتوى محفوظة في النطاقات المصرح بها.\nلرفع ملف جديد استخدم /import.');
  if(!this.validPage(page,direction,visible.length))return reject();
  const pages=Math.ceil(visible.length/10);
  const choose=visible.slice(page*10,page*10+10).map(r=>'🗃️ الاستيراد · '+r.id);
  return screen('<b>مراجعة الاستيراد 🧾</b>\n'
   +'الدفعات المتاحة: '+visible.length+'\n'
   +'صفحة '+(page+1)+' من '+pages+'\n'
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
   +'النطاق: '+line(run.scope,24)+'\n'
   +'السجلات: '+run.candidates.length+'\n'
   +'صفحة '+(page+1)+' من '+pages+'\n'
   +'حالة كل مرشح تُراجع قبل أي اعتماد. لا نشر تلقائي.',
   choices,{
    previous:page>0?ownerPageButton('candidates',page-1,'previous',run.id):undefined,
    next:page+1<pages?ownerPageButton('candidates',page+1,'next',run.id):undefined
   });
 }
 async handle(text:string,ctx:VerifiedAdminContext):Promise<OwnerMenuScreen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return reject();
  const state=await this.store.snapshot();
  const pageRequest=parseOwnerMenuPageCommand(text);
  if(pageRequest){
   if(pageRequest.type==='imports')
    return this.pagedImports(state,pageRequest.page,pageRequest.direction);
   const run=pageRequest.runId?this.allowedRun(state,pageRequest.runId):null;
   return run?this.pagedCandidates(run,pageRequest.page,pageRequest.direction):reject();
  }
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels));
  }
  if(text===ownerMenuLabels.imports)return this.pagedImports(state,0);
  if(text===ownerMenuLabels.library){
   const published=state.educationResources.filter(r=>r.status==='PUBLISHED').length;
   const archived=state.educationResources.filter(r=>r.status==='ARCHIVED').length;
   const enabled=state.educationCategories.filter(c=>c.enabled).length;
   return screen('<b>إدارة المكتبة 📚</b>\n'
    +'الأقسام المفعلة: '+enabled+'\n'
    +'الموارد المنشورة محليًا: '+published+'\n'
    +'الموارد المؤرشفة: '+archived+'\n'
    +'تغيير ترتيب الأقسام وأرشفة الملفات ما زال عبر وظائف الإدارة المعتمدة.\n'
    +'يمكنك مراجعة الوارد قبل نشره في المكتبة المحلية.',
    [ownerMenuLabels.imports]);
  }
  if(text===ownerMenuLabels.groups){
   const approved=state.chats.filter(x=>x.approved);
   const available=approved.filter(x=>x.present);
   return screen('<b>المجموعات المعتمدة 👥</b>\n'
    +'مجموعات معتمدة: '+approved.length+'\n'
    +'الموجود بها البوت حسب الحالة المحفوظة: '+available.length+'\n'
    +'المجموعات غير المفعلة: '+(state.chats.length-approved.length)+'\n'
    +'هذه الحالة محلية، ولا تُثبت عضوية Telegram الحية.'
    );
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
   if(candidate.status==='READY'){
    const choices=categories.slice(0,9).map(c=>
     '📂 اعتماد في · '+run.id+':'+index+':'+ownerCategoryToken(c.id));
    return screen(detail+'اختر القسم ثم أكّد الاعتماد بشكل صريح.',
     choices.length?choices:[button]);
   }
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
  // On fingerprint collisions (or disabled/removed categories), never guess.
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
const sections=new Set<string>(Object.values(ownerMenuLabels));
/** Distinguish an owner-only choice (even malformed) from an unrelated
 * ordinary student message. Never use text alone to authenticate its sender.
 */
export function isOwnerMenuText(text:string):boolean{
 return text===menuLabels.owner||sections.has(text)||
  marks.some(([prefix])=>text.startsWith(prefix));
}
const esc=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const clean=(s:string):string=>s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim();
const line=(s:string,max=100):string=>esc(clean(s).slice(0,max));
export interface OwnerMenuScreen {text:string;keyboard:TelegramReplyKeyboard;}
const buttonRows=(choices:readonly string[]):TelegramReplyKeyboard=>{
 const rows:{text:string}[][]=[];
 for(let i=0;i<Math.min(choices.length,10);i+=2)
  rows.push(choices.slice(i,i+2).map(text=>({text})));
 rows.push([{text:menuLabels.owner},{text:menuLabels.home}]);
 return {keyboard:rows,resize_keyboard:true,is_persistent:true};
};
const screen=(text:string,choices:readonly string[]=[]):OwnerMenuScreen=>({
 text,keyboard:buttonRows(choices)
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
  private readonly admin:EducationAdminFacade
 ){}
 private allowedRun(state:BotState,id:string):ImportRun|null{
  const run=state.importRuns.find(x=>x.id===id);
  if(!run)return null;
  if(run.scope==='private')return run;
  return this.policy.canUseChat(state,run.scope,'navigation')?run:null;
 }
 private async permittedCategories(run:ImportRun){
  return this.education.listCategories(this.ownerId,run.scope);
 }
 private ownerId='';
 async handle(text:string,ctx:VerifiedAdminContext):Promise<OwnerMenuScreen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return reject();
  this.ownerId=ctx.actorId;
  const state=await this.store.snapshot();
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels));
  }
  if(text===ownerMenuLabels.imports){
   const visible=state.importRuns.filter(r=>Boolean(this.allowedRun(state,r.id)))
    .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
   const choose=visible.slice(0,10).map(r=>'🗃️ الاستيراد · '+r.id);
   return screen('<b>مراجعة الاستيراد 🧾</b>\n'
    +'الدفعات المتاحة: '+visible.length+'\n'
    +(visible.length?'اختر دفعة لفحص المرشحين قبل اعتمادهم.':
      'لا توجد دفعات محتوى محفوظة في النطاقات المصرح بها.')+'\n'
    +'لرفع ملف جديد استخدم /upload داخل الخاص أو /import حسب الصلاحيات.',
    choose);
  }
  if(text===ownerMenuLabels.library){
   const published=state.educationResources.filter(r=>r.status==='PUBLISHED').length;
   const archived=state.educationResources.filter(r=>r.status==='ARCHIVED').length;
   const enabled=state.educationCategories.filter(c=>c.enabled).length;
   return screen('<b>إدارة المكتبة 📚</b>\n'
    +'الأقسام المفعلة: '+enabled+'\n'
    +'الموارد المنشورة محليًا: '+published+'\n'
    +'الموارد المؤرشفة: '+archived+'\n'
    +'تغيير ترتيب الأقسام وأرشفة الملفات ما زال عبر وظائف الإدارة المعتمدة.\n'
    +'يمكنك مراجعة الوارد قبل نشره في المكتبة المحلية.',
    [ownerMenuLabels.imports]);
  }
  if(text===ownerMenuLabels.groups){
   const approved=state.chats.filter(x=>x.approved);
   const available=approved.filter(x=>x.present);
   return screen('<b>المجموعات المعتمدة 👥</b>\n'
    +'مجموعات معتمدة: '+approved.length+'\n'
    +'الموجود بها البوت حسب الحالة المحفوظة: '+available.length+'\n'
    +'المجموعات غير المفعلة: '+(state.chats.length-approved.length)+'\n'
    +'هذه الحالة محلية، ولا تُثبت عضوية Telegram الحية.'
    );
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
  if(action.action==='run'){
   const choices=run.candidates.slice(0,10).map((c,i)=>'📑 مرشح · '+run.id+':'+i);
   return screen('<b>دفعة الاستيراد 🗃️</b>\n'
    +'النطاق: '+line(run.scope,24)+'\n'
    +'السجلات: '+run.candidates.length+'\n'
    +'حالة كل مرشح تُراجع قبل أي اعتماد. لا نشر تلقائي.\n'
    +(run.candidates.length>10?'تظهر أول عشرة عناصر فقط في هذه الشاشة.':''),
    choices);
  }
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
   if(candidate.status==='READY'){
    const choices=categories.slice(0,9).map(c=>
     '📂 اعتماد في · '+run.id+':'+index+':'+c.id);
    return screen(detail+'اختر القسم ثم أكّد الاعتماد بشكل صريح.',
     choices.length?choices:[button]);
   }
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+cat.id]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const categoryId=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  if(!categories.some(c=>c.id===categoryId))return reject();
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
export function parseOwnerMenuPageCommand(input:string):OwnerMenuPage|null{
 if(typeof input!=='string'||input.length>96)return null;
 const m=pageRe.exec(input);
 if(!m||m[0]!==input)return null;
 const type=m[2]==='i'?'imports':'candidates';
 if((type==='imports'&&m[3]!==undefined)||(type==='candidates'&&!m[3]))return null;
 const direction=m[1]==='➡️ التالي'?'next':'previous';
 return m[3]?{type,runId:m[3],page:Number(m[4]),direction}:
  {type,page:Number(m[4]),direction};
}
function ownerPageButton(type:OwnerMenuPage['type'],page:number,direction:OwnerMenuPage['direction'],runId?:string):string{
 if(!Number.isSafeInteger(page)||page<0||page>999)throw Error('INVALID_OWNER_PAGE');
 if(type==='candidates'&&(!runId||!refRe.test(runId)))throw Error('INVALID_OWNER_RUN');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+
  ' · o:'+(type==='imports'?'i':'c:'+runId)+':'+page;
}
const sections=new Set<string>(Object.values(ownerMenuLabels));
/** Distinguish an owner-only choice (even malformed) from an unrelated
 * ordinary student message. Never use text alone to authenticate its sender.
 */
export function isOwnerMenuText(text:string):boolean{
 return text===menuLabels.owner||sections.has(text)||
  marks.some(([prefix])=>text.startsWith(prefix));
}
const esc=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const clean=(s:string):string=>s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim();
const line=(s:string,max=100):string=>esc(clean(s).slice(0,max));
export interface OwnerMenuScreen {text:string;keyboard:TelegramReplyKeyboard;}
const buttonRows=(choices:readonly string[]):TelegramReplyKeyboard=>{
 const rows:{text:string}[][]=[];
 for(let i=0;i<Math.min(choices.length,10);i+=2)
  rows.push(choices.slice(i,i+2).map(text=>({text})));
 rows.push([{text:menuLabels.owner},{text:menuLabels.home}]);
 return {keyboard:rows,resize_keyboard:true,is_persistent:true};
};
const screen=(text:string,choices:readonly string[]=[]):OwnerMenuScreen=>({
 text,keyboard:buttonRows(choices)
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
  private readonly admin:EducationAdminFacade
 ){}
 private allowedRun(state:BotState,id:string):ImportRun|null{
  const run=state.importRuns.find(x=>x.id===id);
  if(!run)return null;
  if(run.scope==='private')return run;
  return this.policy.canUseChat(state,run.scope,'navigation')?run:null;
 }
 private async permittedCategories(run:ImportRun){
  return this.education.listCategories(this.ownerId,run.scope);
 }
 private ownerId='';
 async handle(text:string,ctx:VerifiedAdminContext):Promise<OwnerMenuScreen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return reject();
  this.ownerId=ctx.actorId;
  const state=await this.store.snapshot();
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels));
  }
  if(text===ownerMenuLabels.imports){
   const visible=state.importRuns.filter(r=>Boolean(this.allowedRun(state,r.id)))
    .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
   const choose=visible.slice(0,10).map(r=>'🗃️ الاستيراد · '+r.id);
   return screen('<b>مراجعة الاستيراد 🧾</b>\n'
    +'الدفعات المتاحة: '+visible.length+'\n'
    +(visible.length?'اختر دفعة لفحص المرشحين قبل اعتمادهم.':
      'لا توجد دفعات محتوى محفوظة في النطاقات المصرح بها.')+'\n'
    +'لرفع ملف جديد استخدم /upload داخل الخاص أو /import حسب الصلاحيات.',
    choose);
  }
  if(text===ownerMenuLabels.library){
   const published=state.educationResources.filter(r=>r.status==='PUBLISHED').length;
   const archived=state.educationResources.filter(r=>r.status==='ARCHIVED').length;
   const enabled=state.educationCategories.filter(c=>c.enabled).length;
   return screen('<b>إدارة المكتبة 📚</b>\n'
    +'الأقسام المفعلة: '+enabled+'\n'
    +'الموارد المنشورة محليًا: '+published+'\n'
    +'الموارد المؤرشفة: '+archived+'\n'
    +'تغيير ترتيب الأقسام وأرشفة الملفات ما زال عبر وظائف الإدارة المعتمدة.\n'
    +'يمكنك مراجعة الوارد قبل نشره في المكتبة المحلية.',
    [ownerMenuLabels.imports]);
  }
  if(text===ownerMenuLabels.groups){
   const approved=state.chats.filter(x=>x.approved);
   const available=approved.filter(x=>x.present);
   return screen('<b>المجموعات المعتمدة 👥</b>\n'
    +'مجموعات معتمدة: '+approved.length+'\n'
    +'الموجود بها البوت حسب الحالة المحفوظة: '+available.length+'\n'
    +'المجموعات غير المفعلة: '+(state.chats.length-approved.length)+'\n'
    +'هذه الحالة محلية، ولا تُثبت عضوية Telegram الحية.'
    );
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
  if(action.action==='run'){
   const choices=run.candidates.slice(0,10).map((c,i)=>'📑 مرشح · '+run.id+':'+i);
   return screen('<b>دفعة الاستيراد 🗃️</b>\n'
    +'النطاق: '+line(run.scope,24)+'\n'
    +'السجلات: '+run.candidates.length+'\n'
    +'حالة كل مرشح تُراجع قبل أي اعتماد. لا نشر تلقائي.\n'
    +(run.candidates.length>10?'تظهر أول عشرة عناصر فقط في هذه الشاشة.':''),
    choices);
  }
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
   if(candidate.status==='READY'){
    const choices=categories.slice(0,9).map(c=>
     '📂 اعتماد في · '+run.id+':'+index+':'+c.id);
    return screen(detail+'اختر القسم ثم أكّد الاعتماد بشكل صريح.',
     choices.length?choices:[button]);
   }
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+cat.id]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const categoryId=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  if(!categories.some(c=>c.id===categoryId))return reject();
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
const sections=new Set<string>(Object.values(ownerMenuLabels));
/** Distinguish an owner-only choice (even malformed) from an unrelated
 * ordinary student message. Never use text alone to authenticate its sender.
 */
export function isOwnerMenuText(text:string):boolean{
 return text===menuLabels.owner||sections.has(text)||
  marks.some(([prefix])=>text.startsWith(prefix));
}
const esc=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const clean=(s:string):string=>s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim();
const line=(s:string,max=100):string=>esc(clean(s).slice(0,max));
export interface OwnerMenuScreen {text:string;keyboard:TelegramReplyKeyboard;}
const buttonRows=(choices:readonly string[]):TelegramReplyKeyboard=>{
 const rows:{text:string}[][]=[];
 for(let i=0;i<Math.min(choices.length,10);i+=2)
  rows.push(choices.slice(i,i+2).map(text=>({text})));
 rows.push([{text:menuLabels.owner},{text:menuLabels.home}]);
 return {keyboard:rows,resize_keyboard:true,is_persistent:true};
};
const screen=(text:string,choices:readonly string[]=[]):OwnerMenuScreen=>({
 text,keyboard:buttonRows(choices)
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
  private readonly admin:EducationAdminFacade
 ){}
 private allowedRun(state:BotState,id:string):ImportRun|null{
  const run=state.importRuns.find(x=>x.id===id);
  if(!run)return null;
  if(run.scope==='private')return run;
  return this.policy.canUseChat(state,run.scope,'navigation')?run:null;
 }
 private async permittedCategories(run:ImportRun){
  return this.education.listCategories(this.ownerId,run.scope);
 }
 private ownerId='';
 async handle(text:string,ctx:VerifiedAdminContext):Promise<OwnerMenuScreen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return reject();
  this.ownerId=ctx.actorId;
  const state=await this.store.snapshot();
  if(text===menuLabels.owner){
   const panel=await this.admin.panel(ctx,'private');
   return screen('<b>لوحة المالك 🔐</b>\n'
    +'إدارة المحتوى والمراجعات تتم داخل المكتبة المحلية فقط.\n'
    +'رفع المحتوى في الخاص: '+(panel.canUpload?'مسموح':'مقيد')+'\n'
    +'نشر المحتوى إلى قنوات Telegram لم يُفعّل.\n'
    +'اختر وظيفة الإدارة من الأزرار أدناه.',
    Object.values(ownerMenuLabels));
  }
  if(text===ownerMenuLabels.imports){
   const visible=state.importRuns.filter(r=>Boolean(this.allowedRun(state,r.id)))
    .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
   const choose=visible.slice(0,10).map(r=>'🗃️ الاستيراد · '+r.id);
   return screen('<b>مراجعة الاستيراد 🧾</b>\n'
    +'الدفعات المتاحة: '+visible.length+'\n'
    +(visible.length?'اختر دفعة لفحص المرشحين قبل اعتمادهم.':
      'لا توجد دفعات محتوى محفوظة في النطاقات المصرح بها.')+'\n'
    +'لرفع ملف جديد استخدم /upload داخل الخاص أو /import حسب الصلاحيات.',
    choose);
  }
  if(text===ownerMenuLabels.library){
   const published=state.educationResources.filter(r=>r.status==='PUBLISHED').length;
   const archived=state.educationResources.filter(r=>r.status==='ARCHIVED').length;
   const enabled=state.educationCategories.filter(c=>c.enabled).length;
   return screen('<b>إدارة المكتبة 📚</b>\n'
    +'الأقسام المفعلة: '+enabled+'\n'
    +'الموارد المنشورة محليًا: '+published+'\n'
    +'الموارد المؤرشفة: '+archived+'\n'
    +'تغيير ترتيب الأقسام وأرشفة الملفات ما زال عبر وظائف الإدارة المعتمدة.\n'
    +'يمكنك مراجعة الوارد قبل نشره في المكتبة المحلية.',
    [ownerMenuLabels.imports]);
  }
  if(text===ownerMenuLabels.groups){
   const approved=state.chats.filter(x=>x.approved);
   const available=approved.filter(x=>x.present);
   return screen('<b>المجموعات المعتمدة 👥</b>\n'
    +'مجموعات معتمدة: '+approved.length+'\n'
    +'الموجود بها البوت حسب الحالة المحفوظة: '+available.length+'\n'
    +'المجموعات غير المفعلة: '+(state.chats.length-approved.length)+'\n'
    +'هذه الحالة محلية، ولا تُثبت عضوية Telegram الحية.'
    );
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
  if(action.action==='run'){
   const choices=run.candidates.slice(0,10).map((c,i)=>'📑 مرشح · '+run.id+':'+i);
   return screen('<b>دفعة الاستيراد 🗃️</b>\n'
    +'النطاق: '+line(run.scope,24)+'\n'
    +'السجلات: '+run.candidates.length+'\n'
    +'حالة كل مرشح تُراجع قبل أي اعتماد. لا نشر تلقائي.\n'
    +(run.candidates.length>10?'تظهر أول عشرة عناصر فقط في هذه الشاشة.':''),
    choices);
  }
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
   if(candidate.status==='READY'){
    const choices=categories.slice(0,9).map(c=>
     '📂 اعتماد في · '+run.id+':'+index+':'+c.id);
    return screen(detail+'اختر القسم ثم أكّد الاعتماد بشكل صريح.',
     choices.length?choices:[button]);
   }
   if(candidate.status==='APPROVED'&&candidate.categoryId){
    const cat=categories.find(x=>x.id===candidate.categoryId);
    if(!cat)return screen(detail+'قسم الاعتماد غير متاح حاليًا.',[button]);
    return screen(detail+'مُعتمد محليًا؛ يتطلب النشر موافقة منفصلة.',
     ['📝 معاينة النشر · '+run.id+':'+index+':'+cat.id]);
   }
   return screen(detail+'يتطلب مراجعة خارج هذه الأزرار ولا يمكن اعتماده تلقائيًا.',
    [button]);
  }
  const categoryId=action.categoryId!;
  const categories=await this.permittedCategories(run,ctx.actorId);
  if(!categories.some(c=>c.id===categoryId))return reject();
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
