import type {BotStore,BotState,FAQEntry} from './store.js';
import type {Policy} from './policy.js';
import type {VerifiedAdminContext} from './education-admin.js';
import {ApprovedAnswerService} from './education-interactions.js';
import {faqReviewFingerprint,faqApprovalConflicts} from './faq-review.js';
import {menuLabels,type TelegramReplyKeyboard} from './telegram-menu.js';

export const ownerFAQLabel='🧠 الأسئلة الشائعة';
type FAQAction={kind:'detail'|'approveReview'|'approveConfirm'|'archiveReview'|'archiveConfirm';
 id:string;proof?:string;scopeVersion?:number};
export type FAQPage={page:number;direction:'next'|'previous'};
const id='([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
const proof='(~[a-f0-9]{16})',revision='(0|[1-9][0-9]{0,9})';
const detailRe=new RegExp('^❓ سؤال · '+id+'$','u');
const actions=[
 ['🧾 معاينة اعتماد FAQ · ','approveReview'],
 ['✅ تأكيد اعتماد FAQ · ','approveConfirm'],
 ['🗃️ معاينة أرشفة FAQ · ','archiveReview'],
 ['⛔ تأكيد أرشفة FAQ · ','archiveConfirm']
] as const;
const parsedActions=actions.map(([prefix,kind])=>({
 kind,re:new RegExp('^'+prefix+id+':'+proof+':'+revision+'$','u')
}));
const pageRe=/^(➡️ التالي|⬅️ السابق) · o:f:(0|[1-9][0-9]{0,2})$/u;
export function parseOwnerFAQAction(text:string):FAQAction|null{
 if(typeof text!=='string'||text.length>145)return null;
 let m=detailRe.exec(text);
 if(m)return {kind:'detail',id:m[1]!};
 for(const {kind,re} of parsedActions){
  m=re.exec(text);
  if(m)return {kind,id:m[1]!,proof:m[2]!,scopeVersion:Number(m[3]!)};
 }
 return null;
}
export function parseOwnerFAQPage(text:string):FAQPage|null{
 if(typeof text!=='string'||text.length>48)return null;
 const m=pageRe.exec(text);
 if(!m)return null;
 return {page:Number(m[2]!),direction:m[1]==='➡️ التالي'?'next':'previous'};
}
export function isOwnerFAQText(text:string):boolean{
 return text===ownerFAQLabel||text.startsWith('❓ سؤال · ')||
  actions.some(([prefix])=>text.startsWith(prefix))||
  text.startsWith('➡️ التالي · o:f:')||text.startsWith('⬅️ السابق · o:f:');
}
type Screen={text:string;keyboard:TelegramReplyKeyboard};
const safe=(s:string,max=160)=>s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ')
 .trim().slice(0,max).replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const screen=(text:string,choices:readonly string[]=[],page:readonly string[]=[]):Screen=>{
 const rows:{text:string}[][]=[];
 for(let i=0;i<Math.min(choices.length,10);i+=2)
  rows.push(choices.slice(i,i+2).map(text=>({text})));
 if(page.length)rows.push(page.slice(0,2).map(text=>({text})));
 rows.push([{text:menuLabels.owner},{text:menuLabels.home}]);
 return {text,keyboard:{keyboard:rows,resize_keyboard:true,is_persistent:true}};
};
const pageLabel=(page:number,dir:FAQPage['direction']):string=>
 (dir==='next'?'➡️ التالي':'⬅️ السابق')+' · o:f:'+page;
function sourceAvailable(s:BotState,q:FAQEntry):boolean{
 const r=s.educationResources.find(r=>r.id===q.sourceResourceId&&
  r.scope===q.scope&&r.status==='PUBLISHED');
 if(!r)return false;
 let id:string|null=r.categoryId;
 const seen=new Set<string>();
 while(id){
  if(seen.has(id))return false;
  seen.add(id);
  const c=s.educationCategories.find(c=>c.id===id&&c.scope===q.scope);
  if(!c?.enabled)return false;
  id=c.parentId;
 }
 return true;
}
export class OwnerTelegramFAQMenu{
 private readonly faq:ApprovedAnswerService;
 constructor(private readonly store:BotStore,private readonly policy:Policy){
  this.faq=new ApprovedAnswerService(store,policy);
 }
 private accessible(s:BotState,q:FAQEntry):boolean{
  return q.scope==='private'||this.policy.canUseChat(s,q.scope,'navigation');
 }
 async handle(text:string,ctx:VerifiedAdminContext):Promise<Screen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return null;
  const state=await this.store.snapshot(),page=parseOwnerFAQPage(text);
  const all=state.faqEntries.filter(q=>this.accessible(state,q))
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
  if(text===ownerFAQLabel||page){
   const current=page?.page??0,count=Math.ceil(all.length/10);
   if(page&&(!count||current>=count||
     (page.direction==='next'&&current===0)||
     (page.direction==='previous'&&current===count-1)))return null;
   return screen('<b>مراجعة الأسئلة الشائعة 🧠</b>\n'
    +'السجلات في النطاقات المصرح بها: '+all.length+'\n'
    +'مسودات: '+all.filter(q=>q.status==='DRAFT').length+'\n'
    +'معتمدة: '+all.filter(q=>q.status==='APPROVED').length+'\n'
    +'مؤرشفة: '+all.filter(q=>q.status==='ARCHIVED').length+'\n'
    +(count?'صفحة '+(current+1)+' من '+count+'\n':'')
    +'اختر سجلًا لمراجعة الإجابة ومصدرها. لا اعتماد أو نشر آلي.',
    all.slice(current*10,current*10+10).map(q=>'❓ سؤال · '+q.id),[
     ...(current>0?[pageLabel(current-1,'previous')]:[]),
     ...(current+1<count?[pageLabel(current+1,'next')]:[])
    ]);
  }
  const action=parseOwnerFAQAction(text);
  if(!action)return null;
  const q=all.find(q=>q.id===action.id);
  if(!q)return null;
  const epoch=q.scope==='private'?0:this.policy.chatRevision(state,q.scope);
  const fp=faqReviewFingerprint(state,q);
  const suffix=' · '+q.id+':'+fp+':'+epoch;
  const isSourceValid=sourceAvailable(state,q);
  const collisionCount=faqApprovalConflicts(state,q);
  if(action.kind==='detail'){
   const choices=[
    ...(q.status==='DRAFT'&&isSourceValid&&collisionCount===0?
      ['🧾 معاينة اعتماد FAQ'+suffix]:[]),
    ...(q.status==='DRAFT'||q.status==='APPROVED'?
      ['🗃️ معاينة أرشفة FAQ'+suffix]:[])
   ];
   return screen('<b>تفاصيل الإجابة المعتمدة على مصدر 📋</b>\n'
    +'السؤال: '+safe(q.question,200)+'\n'
    +'الإجابة: '+safe(q.answer,310)+'\n'
    +'النطاق: '+safe(q.scope,35)+'\n'
    +'الحالة: '+q.status+'\n'
    +'المصدر المنشور والمصرح به محليًا: '+(isSourceValid?'نعم':'غير متاح')+'\n'
    +'تعارض مع إجابات معتمدة: '+collisionCount+'\n'
    +'وجود تعارض يمنع اعتماد مسودة جديدة حتى تُعالج الإجابات القديمة؛ الأرشفة محلية فقط.',
    [...choices,ownerFAQLabel]);
  }
  if(action.proof!==fp||action.scopeVersion!==epoch)return null;
  const approve=action.kind.startsWith('approve');
  if(approve?(q.status!=='DRAFT'||!isSourceValid||collisionCount>0):
    (q.status!=='APPROVED'&&q.status!=='DRAFT'))return null;
  if(action.kind==='approveReview'||action.kind==='archiveReview'){
   return screen('<b>مراجعة قرار FAQ</b>\n'
    +'السؤال: '+safe(q.question,200)+'\n'
    +'الإجابة: '+safe(q.answer,310)+'\n'
    +'القرار: '+(approve?'اعتماد الإجابة للنطاق الحالي':'أرشفة الإجابة ومنع استخدامها مستقبلًا')+'\n'
    +'المصدر الحالي: '+(isSourceValid?'منشور محليًا':'غير متاح')+'\n'    +'تعارض مع الإجابات المعتمدة الأخرى: '+collisionCount+'\n'
    +'لا اتصال بTelegram أو إرسال رسائل.',
    [approve?'✅ تأكيد اعتماد FAQ'+suffix:'⛔ تأكيد أرشفة FAQ'+suffix,
     '❓ سؤال · '+q.id]);
  }
  try{
   await this.faq.transitionIfCurrent(ctx.actorId,q.id,approve?'APPROVED':'ARCHIVED',fp,epoch);
  }catch{return null;}
  return screen('<b>تم حفظ قرار FAQ محليًا ✅</b>\n'
   +'الحالة الجديدة: '+(approve?'APPROVED':'ARCHIVED')+'\n'
   +'لا توجد رسائل إلى القنوات أو تشغيل لمساعد AI خارجي.',
   [ownerFAQLabel]);
 }
}
