import {createHash} from 'node:crypto';
import type {BotStore,BotState,ModerationOperation,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {ambiguousModerationOperationIds,inspectModerationLedgerIntegrity} from './moderation-review-integrity.js';

/** OWNER-PRIVATE READ-ONLY navigation of locally pending moderation attempts.
 * No Telegram rights call, sanction, retry, status transition, new callback
 * nonce, acknowledgement, or persisted "review" status exists on this route.
 * After a crash INTENT is not proof no-send; STARTED may have reached Telegram.
 */
export type ModerationPendingOwnerRoute=
 {kind:'list';page:number}|
 {kind:'details';page:number;slot:number;digest:string};
const page='(0|[1-9][0-9]{0,2})',slot='([1-8])',digest='([a-f0-9]{12})';
const listRe=new RegExp('^mp:1:p:'+page+'$','u');
const detailRe=new RegExp('^mp:1:d:'+page+':'+slot+':'+digest+'$','u');
export function parseModerationPendingOwnerRoute(data:string):
 ModerationPendingOwnerRoute|null{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 if(data==='mp:1:h')return {kind:'list',page:0};
 const l=listRe.exec(data);
 if(l)return {kind:'list',page:Number(l[1])};
 const d=detailRe.exec(data);
 if(d)return {kind:'details',page:Number(d[1]),slot:Number(d[2]),digest:d[3]!};
 return null;
}
const LIMIT=8;
type PendingEntry={op:ModerationOperation;chat:Chat};
/** Never select an ID that collides with ANY persisted attempt, including
 * entries outside the approved group and terminal/unknown evidence. They
 * remain durable, quarantined from actionable case selection.
 */
const pending=(s:BotState):PendingEntry[]=>{
 const chats=new Map(s.chats.filter(c=>c.approved&&
  c.scopes.includes('moderation')).map(c=>[c.id,c]));
 const ambiguous=ambiguousModerationOperationIds(s);
 return s.moderationOperations.flatMap(op=>{
  const chat=chats.get(op.chatId);
  return chat&&!ambiguous.has(op.id)&&
   (op.status==='INTENT'||op.status==='STARTED')?[{op,chat}]:[];
 }).sort((a,b)=>a.op.createdAt-b.op.createdAt||a.op.id.localeCompare(b.op.id));
};
/** Digest is a stale selector guard, not an authorization credential. */
const digestOf=(x:PendingEntry):string=>createHash('sha256')
 .update('MANARATAK:PENDING:OWNER:READONLY:V1:')
 .update(JSON.stringify([x.chat.id,x.chat.approved,x.chat.version,x.chat.scopes,
  x.op.id,x.op.chatId,x.op.memberId,x.op.actorId,x.op.kind,
  x.op.reasonFingerprint,x.op.policyVersion,x.op.createdAt,
  x.op.status,x.op.attemptGateway??null]))
 .digest('hex').slice(0,12);
const label=(op:ModerationOperation)=>op.kind==='BAN'?'حظر':
 op.kind==='MUTE'?'كتم':'رفع قيد (سجل محلي)';
const button=(text:string,callback_data:string)=>({text,callback_data});
const screen=(text:string,rows:readonly (readonly {text:string;callback_data:string}[])[]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const age=(createdAt:number,now:number):'OLD'|'FRESH'|'CLOCK_UNKNOWN'=>
 !Number.isSafeInteger(createdAt)||createdAt<0||createdAt>now||
 !Number.isSafeInteger(now)||now<0?'CLOCK_UNKNOWN':
 now-createdAt>=900_000?'OLD':'FRESH';
const ageLabel=(o:ModerationOperation,now:number):string=>{
 const a=age(o.createdAt,now);
 return a==='OLD'?'قديمة — تستلزم مراجعة بشرية':
  a==='CLOCK_UNKNOWN'?'التوقيت غير موثوق — تستلزم مراجعة بشرية':
  'معلقة حديثًا — لا يُسمح بإعادة الإرسال';
};
export class ModerationPendingOwnerView{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 async handle(data:string,actor:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor))return null;
  const route=parseModerationPendingOwnerRoute(data);
  if(!route)return null;
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor))return null;
  // Restoration anomalies are not permission to interpret a partly valid
  // ledger. A read-only generic alert is safe, case details are not.
  if(!inspectModerationLedgerIntegrity(s).valid)
    return route.kind==='list'
     ?screen('<b>سجلات الإشراف غير سليمة</b>\n'+
       'تم حجب الحالات المعلقة. البيانات تتطلب مراجعة بشرية مستقلة دون أي إعادة إرسال.',
       [[button('🏠 لوحة المالك','mi:1:h')]])
     :null;
  const all=pending(s);
  if(route.kind==='list'){
   const totalPages=Math.max(1,Math.ceil(all.length/LIMIT));
   if(route.page>=totalPages)return null;
   const segment=all.slice(route.page*LIMIT,(route.page+1)*LIMIT);
   const rows:{text:string;callback_data:string}[][]=[];
   for(let i=0;i<segment.length;i+=2){
    rows.push(segment.slice(i,i+2).map((entry,j)=>{
     const {op}=entry;
     const title=(op.status==='STARTED'?'⚠️ بدأت':'⏳ في الانتظار')+
      ' · '+label(op);
     return button(title,'mp:1:d:'+route.page+':'+(i+j+1)+':'+digestOf(entry));
    }));
   }
   const nav:{text:string;callback_data:string}[]=[];
   if(route.page>0)nav.push(button('⬅️ السابق','mp:1:p:'+(route.page-1)));
   if(route.page+1<totalPages)
    nav.push(button('➡️ التالي','mp:1:p:'+(route.page+1)));
   if(nav.length)rows.push(nav);
   rows.push([button('⚠️ مراجعة النتائج المجهولة','mr:1:h'),
    button('🏠 لوحة المالك','mi:1:h')]);
   const stale=all.filter(e=>age(e.op.createdAt,this.clock())!=='FRESH').length;
   const ambiguous=ambiguousModerationOperationIds(s);
   const conflicting=s.moderationOperations.filter(o=>
    ambiguous.has(o.id)&&(o.status==='INTENT'||o.status==='STARTED')&&
    s.chats.some(c=>c.id===o.chatId&&c.approved&&c.scopes.includes('moderation'))).length;
   return screen('<b>⏳ العمليات الإشرافية المعلقة — قراءة فقط</b>\n'
    +'الإجمالي: '+all.length+
    ' · تجهيز INTENT: '+all.filter(e=>e.op.status==='INTENT').length+
    ' · بدأ التنفيذ STARTED: '+all.filter(e=>e.op.status==='STARTED').length+
    ' · قديمة أو بتوقيت غير موثوق: '+stale+
    ' · سجلات متعارضة محجوبة: '+conflicting+'\n'
    +(all.length?'صفحة '+(route.page+1)+' من '+totalPages+'\n':
     'لا توجد عمليات معلقة مرئية في المجموعات المعتمدة للإشراف.\n')
    +'INTENT بعد التعطل لا يثبت عدم الإرسال. STARTED قد تكون وصلت إلى Telegram. '
    +'لا توجد إعادة إرسال أو اعتماد نجاح أو تعديل للسجلات من هذه الشاشة.',rows);
  }
  const entry=all[route.page*LIMIT+route.slot-1];
  if(!entry||digestOf(entry)!==route.digest)return null;
  const {op}=entry;
  return screen('<b>⏳ سجل إشراف معلق — للمالك فقط</b>\n'
   +'نوع الإجراء: '+label(op)+'\n'
   +'المرحلة: '+op.status+'\n'
   +'التقييم: '+ageLabel(op,this.clock())+'\n'
   +(op.status==='STARTED'?
     'ربما وصل الطلب إلى Telegram؛ لا يصح افتراض نجاحه أو فشله.\n':
     'لم تُسجّل بداية الإرسال محليًا؛ بعد تعطل الخادم لا يثبت ذلك أن عقوبة لم تصل مطلقًا.\n')
   +'هويات الأعضاء والمشرفين والأدلة مخفية. لا تتم أي كتابة أو طلب Telegram.',
   [[button('↩️ العمليات المعلقة','mp:1:p:'+route.page),
     button('🏠 لوحة المالك','mi:1:h')]]);
 }
}
