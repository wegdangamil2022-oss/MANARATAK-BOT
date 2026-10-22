import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {VerifiedAdminContext} from './education-admin.js';
import {B6OwnerBudgetReview} from './b6-owner-budget-review.js';
import type {TelegramReplyKeyboard} from './telegram-menu.js';

export const b6BudgetMenuLabel='🧮 ميزانية المساعد التجريبية';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const chooseRe=new RegExp('^⚠️ مراجعة محاولة · ('+uuid+')$','u');
const confirmRe=new RegExp('^✅ إقرار المراجعة · ('+uuid+')$','u');
const pageRe=/^(➡️ التالي|⬅️ السابق) · b6b:(0|[1-9][0-9]{0,2})$/u;
const recoverLabel='🧯 عزل المحاولات المنتهية';

export const isOwnerB6BudgetText=(text:string):boolean=>
 text===b6BudgetMenuLabel||text===recoverLabel||
 text.startsWith('⚠️ مراجعة محاولة · ')||
 text.startsWith('✅ إقرار المراجعة · ')||
 text.startsWith('➡️ التالي · b6b:')||
 text.startsWith('⬅️ السابق · b6b:');

const screen=(text:string,buttons:readonly string[]=[],paging:{previous?:string|undefined;next?:string|undefined}={})=>{
 const rows:{text:string}[][]=[];
 for(let i=0;i<buttons.length;i+=2)
  rows.push(buttons.slice(i,i+2).map(x=>({text:x})));
 const next=[paging.previous,paging.next].filter((x):x is string=>Boolean(x));
 if(next.length)rows.push(next.map(text=>({text})));
 rows.push([{text:b6BudgetMenuLabel},{text:'🔐 لوحة المالك'}]);
 const keyboard:TelegramReplyKeyboard={keyboard:rows,resize_keyboard:true,is_persistent:true};
 return {text,keyboard};
};
const den=():null=>null;
/** No live provider calls, token receipts, refunds, or retry actions. */
export class OwnerB6BudgetMenu{
 private readonly review:B6OwnerBudgetReview;
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  clock:()=>number=Date.now){
  this.review=new B6OwnerBudgetReview(store,policy,clock);
 }
 async handle(text:string,ctx:VerifiedAdminContext){
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return den();
  const page=pageRe.exec(text),choose=chooseRe.exec(text),confirm=confirmRe.exec(text);
  const known=text===b6BudgetMenuLabel||text===recoverLabel||
   Boolean(page||choose||confirm);
  if(!known)return den();
  if(choose||confirm){
   const state=await this.store.snapshot();
   if(!this.policy.privateFeature(state,'owner.dashboard',ctx.actorId))return den();
   const attemptId=(choose?.[1]??confirm?.[1])!;
   const match=state.b6BudgetAttempts?.find(r=>r.attemptId===attemptId);
   if(!match||match.status!=='UNKNOWN_OUTCOME'||match.operatorReview)return den();
   if(choose){
    return screen('<b>مراجعة محاولة AI ذات نتيجة مجهولة ⚠️</b>\n'
     +'معرّف المحاولة: <code>'+attemptId+'</code>\n'
     +'الوحدات المحجوزة: '+match.reservedTokens+'\n'
     +'لا يؤكد هذا الفحص أن مزود AI نفّذ الطلب أو فشل.\n'
     +'الإقرار لا يعيد المحاولة، ولا يرد الوحدات المحجوزة ولا يسدد فاتورة مزود خارجي.\n'
     +'هل تؤكد أنك راجعت التحذير؟',
     ['✅ إقرار المراجعة · '+attemptId]);
   }
   const outcome=await this.review.acknowledge(ctx.actorId,attemptId);
   if(outcome.status!=='ACKNOWLEDGED')return den();
   return screen('<b>تم توثيق مراجعة النتيجة المجهولة ✅</b>\n'
    +'حالة المحاولة لا تزال UNKNOWN_OUTCOME.\n'
    +'لا إعادة استدعاء، ولا استرداد حصة، ولا إثبات لتكلفة مزود حقيقي.');
  }
  if(text===recoverLabel){
   const result=await this.review.quarantineExpired(ctx.actorId);
   if(result.status!=='QUARANTINED')return den();
   return screen('<b>عزل المحاولات المنتهية 🧯</b>\n'
    +'محاولات أصبحت مجهولة: '+result.count+'\n'
    +'لم تُكرر الطلبات ولم تُرد أي وحدات محجوزة.');
  }
  const pageNumber=page?Number(page[2]):0;
  const report=await this.review.report(ctx.actorId,pageNumber);
  if(report.status!=='REPORT')return den();
  if(page&&((page[1]==='➡️ التالي'&&pageNumber===0)||
    (page[1]==='⬅️ السابق'&&pageNumber===report.pages-1)))return den();
  const rows=report.rows.map((a,i)=>
    (report.page*8+i+1)+'. <code>'+a.attemptId.slice(0,8)+'</code> — '+
    (a.status==='EXPIRED_UNRESOLVED'?'انتهت المدة؛ لم تُعزل':
     a.status==='UNKNOWN_OUTCOME'?'نتيجة مجهولة':
     a.status==='RESERVED'?'محاولة جارية':'مكتملة')+
    (a.reviewed?' (تم الاطلاع)':'')+' — '+a.reservedTokens+' وحدة');
  return screen('<b>مراقبة حجوزات AI التجريبية 🧮</b>\n'
   +'اليوم (UTC): '+report.day+'\n'
   +'محاولات اليوم: '+report.attemptsToday+'\n'
   +'الوحدات المحجوزة اليوم: '+report.reservedTokensToday+'\n'
   +'قيد التنفيذ: '+report.active+'\n'
   +'المجهولة أو المنتهية: '+report.unknown+'\n'
   +'إجمالي السجلات: '+report.total+'\n'
   +'صفحة '+(report.page+1)+' من '+Math.max(report.pages,1)+'\n'
   +rows.join('\n')+'\n'
   +'هذه وحدات محاكاة، وليست تكاليف فعلية. لا إعادة تلقائية.',
   [...report.rows.filter(r=>r.status==='UNKNOWN_OUTCOME'&&!r.reviewed)
    .map(r=>'⚠️ مراجعة محاولة · '+r.attemptId),
    ...(report.unknown>0?[recoverLabel]:[])],{
    previous:pageNumber>0?'⬅️ السابق · b6b:'+(pageNumber-1):undefined,
    next:pageNumber+1<report.pages?'➡️ التالي · b6b:'+(pageNumber+1):undefined
   });
 }
}
