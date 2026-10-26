import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,ModerationOperation} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {ambiguousModerationOperationIds,uniqueModerationReviewNonce} from './moderation-review-integrity.js';

/** Owner-private annotation of UNKNOWN_OUTCOME. An annotation is NEVER
 * proof of delivery and MUST NOT update operation.status or permit retry.
 * It does not query Telegram or change a restriction.
 */
type Decision='ACKNOWLEDGED_UNRESOLVED'|'ESCALATED';
export type ModerationOwnerReviewRoute={kind:'list';page:number}|
 {kind:'details';page:number;slot:number;digest:string}|
 {kind:'preview';page:number;slot:number;digest:string;decision:Decision};
const page='(0|[1-9][0-9]{0,2})',slot='([1-8])',digest='([a-f0-9]{12})';
const listRe=new RegExp('^mr:1:p:'+page+'$','u');
const detailsRe=new RegExp('^mr:1:d:'+page+':'+slot+':'+digest+'$','u');
const previewRe=new RegExp('^mr:1:v:'+page+':'+slot+':'+digest+':([ae])$','u');
export function parseModerationOwnerReviewRoute(data:string):ModerationOwnerReviewRoute|null{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 if(data==='mr:1:h')return {kind:'list',page:0};
 const l=listRe.exec(data);
 if(l&&l[0]===data)return {kind:'list',page:Number(l[1])};
 const d=detailsRe.exec(data);
 if(d&&d[0]===data)return {kind:'details',page:Number(d[1]),slot:Number(d[2]),digest:d[3]!};
 const p=previewRe.exec(data);
 if(p&&p[0]===data)return {kind:'preview',page:Number(p[1]),slot:Number(p[2]),
  digest:p[3]!,decision:p[4]==='a'?'ACKNOWLEDGED_UNRESOLVED':'ESCALATED'};
 return null;
}
const BUTTON_LIMIT=8;
const button=(text:string,callback_data:string)=>({text,callback_data});
const menu=(text:string,rows:readonly (readonly {text:string;callback_data:string}[])[]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const safe=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
/** Every callback selector must be bound to the CURRENT group approval
 * epoch, not only the immutable sanction record. A revoked/reapproved chat
 * must not grant fresh review capabilities to a button from an older epoch.
 * Local transport provenance also affects whether this evidence is current.
 * This digest is a freshness hint, not authorization or Telegram proof.
 */
const opDigest=(o:ModerationOperation,s:BotState)=>createHash('sha256')
 .update('MANARATAK:UNKNOWN:OWNER:REVIEW:V2:')
 .update(JSON.stringify([
  o.id,o.chatId,o.memberId,o.actorId,o.kind,o.reasonFingerprint,
  o.policyVersion,o.createdAt,o.status,o.attemptGateway??null,o.review??null,
  ...(()=>{
   const chat=s.chats.find(c=>c.id===o.chatId);
   return [chat?.id??null,chat?.approved??null,
    chat?.version??null,chat?.scopes??null];
  })()
 ]))
 .digest('hex').slice(0,12);
/** Collision in any group or terminal status blocks review of that ID.
 * Ambiguous rows remain durable and visible as a redacted warning count.
 */
const opList=(s:BotState)=>{
 const ambiguous=ambiguousModerationOperationIds(s);
 return s.moderationOperations.filter(o=>
  o.status==='UNKNOWN_OUTCOME'&&!ambiguous.has(o.id)&&
  s.chats.some(c=>c.id===o.chatId&&c.approved&&c.scopes.includes('moderation')))
  .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
};
const detailKey=(page:number,slot:number,d:string)=>'mr:1:d:'+page+':'+slot+':'+d;
const previewKey=(page:number,slot:number,d:string,action:'a'|'e')=>
 'mr:1:v:'+page+':'+slot+':'+d+':'+action;
type Selected={op:ModerationOperation;page:number;slot:number;digest:string};
function select(s:BotState,route:Extract<ModerationOwnerReviewRoute,{slot:number}>):Selected|null{
 const all=opList(s),op=all[route.page*BUTTON_LIMIT+route.slot-1];
 if(!op||opDigest(op,s)!==route.digest)return null;
 return {op,page:route.page,slot:route.slot,digest:route.digest};
}
export class ModerationUnknownOwnerReview {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private validOwner(actor:string):boolean{return this.policy.isOwner(actor);}
 /** Returns null for not-our-token and invalid/replayed tokens alike. */
 async handle(data:string,actor:string):Promise<OwnerInlineScreen|null>{
  if(!this.validOwner(actor))return null;
  if(data==='mi:1:i:02:01'||data.startsWith('mr:1:'))
   return this.navigate(data,actor);
  if(/^c_[A-Za-z0-9_-]{24}$/u.test(data))
   return this.confirm(data,actor);
  return null;
 }
 private async navigate(data:string,actor:string):Promise<OwnerInlineScreen|null>{
  const route=data==='mi:1:i:02:01'?{kind:'list' as const,page:0}:
   parseModerationOwnerReviewRoute(data);
  if(!route)return null;
  const s=await this.store.snapshot();
  if(!this.validOwner(actor))return null;
  const all=opList(s);
  if(route.kind==='list'){
   const pages=Math.max(1,Math.ceil(all.length/BUTTON_LIMIT));
   if(route.page>=pages)return null;
   const current=all.slice(route.page*BUTTON_LIMIT,(route.page+1)*BUTTON_LIMIT);
   const rows:{text:string;callback_data:string}[][]=[];
   for(let i=0;i<current.length;i+=2)rows.push(current.slice(i,i+2).map((o,j)=>
    button((o.review?'✅ مراجعة':'⚠️ بحاجة لمراجعة')+' · '+o.kind,
      detailKey(route.page,i+j+1,opDigest(o,s)))));
   const nav:{text:string;callback_data:string}[]=[];
   if(route.page>0)nav.push(button('⬅️ السابق','mr:1:p:'+(route.page-1)));
   if(route.page+1<pages)nav.push(button('➡️ التالي','mr:1:p:'+(route.page+1)));
   if(nav.length)rows.push(nav);
   // Pending INTENT/STARTED rows have a separate read-only, owner-private
   // inventory. Do not offer a resolution, retry or sanction action here.
   rows.push([button('⏳ عرض العمليات المعلقة','mp:1:h')]);
   rows.push([button('↩️ قسم الحماية','mi:1:s:02:0'),button('🏠 لوحة المالك','mi:1:h')]);
   const pending=all.filter(o=>!o.review).length;
   const ambiguousIds=ambiguousModerationOperationIds(s);
   const conflicting=s.moderationOperations.filter(o=>
    o.status==='UNKNOWN_OUTCOME'&&ambiguousIds.has(o.id)&&
    s.chats.some(c=>c.id===o.chatId&&c.approved&&c.scopes.includes('moderation'))).length;
   return menu('<b>مراجعة العمليات مجهولة النتيجة 🛡️</b>\n'
    +'الإجمالي القابل للعرض: '+all.length+' · بحاجة لمراجعة: '+pending+
    ' · تمت مراجعتها: '+(all.length-pending)+
    ' · سجلات متعارضة محجوبة: '+conflicting+'\n'
    +(all.length?'صفحة '+(route.page+1)+' من '+pages+'\n':'لا توجد عمليات مجهولة مرئية في المجموعات المعتمدة.\n')
    +'الإقرار والتصعيد توثيق محلي فقط: لا يثبتان نجاح العقوبة، ولا يزيلان منع إعادة الإرسال، ولا يفكان حظرًا أو كتمًا.',rows);
  }
  const chosen=select(s,route);
  if(!chosen)return null;
  const {op,page,slot,digest}=chosen;
  if(route.kind==='details'){
   const rows=op.review?
    [[button('↩️ قائمة المراجعة','mr:1:p:'+page),button('🏠 لوحة المالك','mi:1:h')]]:
    [[button('📌 إقرار دون حسم',previewKey(page,slot,digest,'a')),
      button('🚨 تصعيد للمراجعة',previewKey(page,slot,digest,'e'))],
     [button('↩️ قائمة المراجعة','mr:1:p:'+page),button('🏠 لوحة المالك','mi:1:h')]];
   return menu('<b>عملية عقوبة مجهولة — سجل محلي</b>\n'
    +'المجموعة: <code>'+safe(op.chatId)+'</code>\n'
    +'الإجراء المسجل: '+(op.kind==='BAN'?'حظر':op.kind==='MUTE'?'كتم':'رفع قيد')+'\n'
    +'النتيجة: UNKNOWN_OUTCOME (غير محسومة)\n'
    +'المراجعة: '+(op.review?
     op.review.decision==='ESCALATED'?'تم التصعيد':'إقرار بالمراجعة دون حسم':
     'لم تراجع بعد')+'\n'
    +'هوية المستهدف والدليل لا يعرضان هنا. لا تُعدّل حالة العقوبة ولا تعيد إرسالها.',rows);
  }
  if(op.review)return null;
  const now=this.clock();
  if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000-120000)return null;
  const chat=s.chats.find(c=>c.id===op.chatId);
  if(!chat?.approved||!chat.scopes.includes('moderation'))return null;
  const ref='c_'+randomBytes(18).toString('base64url');
  const action=route.decision==='ESCALATED'?'owner.moderation.review.escalate':
   'owner.moderation.review.ack';
  const issued=await this.store.transaction(state=>{
   if(!this.validOwner(actor))return false;
   if(ambiguousModerationOperationIds(state).has(op.id))return false;
   const c=state.chats.find(x=>x.id===op.chatId);
   const found=state.moderationOperations.find(x=>x.id===op.id&&x.chatId===op.chatId);
   if(!c?.approved||!c.scopes.includes('moderation')||c.version!==chat.version||
    !found||found.status!=='UNKNOWN_OUTCOME'||found.review||
    opDigest(found,state)!==digest)return false;
   state.callbacks.push({ref,action,actorId:actor,chatId:op.chatId,
    policyVersion:c.version,moderationOperationId:op.id,
    moderationOperationDigest:digest,expiresAt:now+120000,
    oneShot:true,revoked:false,used:false});
   return true;
  });
  if(!issued)return null;
  return menu('<b>معاينة مراجعة مجهولة النتيجة</b>\n'
   +'الإجراء: '+(route.decision==='ESCALATED'?'تصعيد':'إقرار بالمراجعة دون حسم')+'\n'
   +'المجموعة: <code>'+safe(op.chatId)+'</code>\n'
   +'لا يتغير سجل العقوبة UNKNOWN_OUTCOME ولا يرفع حظر إعادة الإرسال.\n'
   +'تأكيد صالح لدقيقتين ولمرة واحدة فقط، مرتبط بالمالك والمجموعة والعملية الحالية.',
   [[button('✅ تأكيد المراجعة المحلية',ref)],
    [button('↩️ إلغاء',detailKey(page,slot,digest)),button('🏠 لوحة المالك','mi:1:h')]]);
 }
 private async confirm(token:string,actor:string):Promise<OwnerInlineScreen|null>{
  const now=this.clock();
  if(!Number.isSafeInteger(now)||now<0||!this.validOwner(actor))return null;
  const completed=await this.store.transaction(state=>{
   if(!uniqueModerationReviewNonce(state,token))return null;
   const c=state.callbacks.find(x=>x.ref===token);
   if(!c||c.revoked||c.used||!c.oneShot||c.actorId!==actor||
    c.expiresAt<=now||!c.moderationOperationId||!c.moderationOperationDigest||
    !['owner.moderation.review.ack','owner.moderation.review.escalate'].includes(c.action))
    return null;
   const chat=state.chats.find(x=>x.id===c.chatId);
   const operation=state.moderationOperations.find(x=>
    x.id===c.moderationOperationId&&x.chatId===c.chatId);
   if(ambiguousModerationOperationIds(state).has(c.moderationOperationId))
    return null;
   if(!chat?.approved||!chat.scopes.includes('moderation')||chat.version!==c.policyVersion||
     !operation||operation.status!=='UNKNOWN_OUTCOME'||operation.review||
     opDigest(operation,state)!==c.moderationOperationDigest||!this.validOwner(actor))return null;
   const decision:Decision=c.action==='owner.moderation.review.escalate'?
    'ESCALATED':'ACKNOWLEDGED_UNRESOLVED';
   // Atomic annotation + nonce consumption. No change to operation.status.
   operation.review={decision,reviewedBy:actor,reviewedAt:now};
   c.used=true;
   const auditKey=createHash('sha256').update('MODERATION:REVIEW:'+operation.id)
    .digest('hex').slice(0,32);
   state.audit.push({actorId:actor,updateKey:'owner:moderation:review:'+auditKey,
    decision:'ALLOW',reason:decision==='ESCALATED'?
     'MODERATION_UNKNOWN_OWNER_ESCALATED':'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
    policyVersion:chat.version,at:now});
   return {chatId:chat.id,decision};
  });
  if(!completed)return null;
  return menu('<b>تم حفظ مراجعة العقوبة ✅</b>\n'
   +'المجموعة: <code>'+safe(completed.chatId)+'</code>\n'
   +(completed.decision==='ESCALATED'?'تم التصعيد للمراجعة البشرية.':
     'تم الإقرار بالمراجعة دون حسم نتيجة العقوبة.')+'\n'
   +'حالة العملية لا تزال UNKNOWN_OUTCOME ولا يجوز إعادة إرسال العقوبة آليًا. '
   +'لم يحدث فك حظر أو كتم أو طلب إلى Telegram.',
   [[button('🛡️ قائمة الحالات المجهولة','mr:1:h'),button('🏠 لوحة المالك','mi:1:h')]]);
 }
}
