import {createHash} from 'node:crypto';
import type {BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import {inspectLocalReversal} from './moderation-reversal-preflight.js';

/** The owner dashboard may see only counts of distinct targets, never
 * member IDs, fingerprints, operator identities, references or evidence.
 * This is LOCAL policy information, not live Telegram status or authorship.
 */
export interface ReversalInventory {
 readonly total:number;
 readonly unknown:number;
 readonly pending:number;
 readonly activeReasons:number;
 readonly unproven:number;
 readonly stale:number;
 readonly inspect:number;
}
const zero=():ReversalInventory=>({
 total:0,unknown:0,pending:0,activeReasons:0,unproven:0,stale:0,inspect:0
});
/** The displayed Chat must be the current uniquely stored approval. Do not
 * treat an old caller-supplied Chat object as permission after a restore.
 * Keep this read-only and fail closed for even identical duplicate IDs.
 */
function currentApprovedModerationGroup(s:BotState,policy:Policy,chat:Chat):boolean{
 const current=s.chats.filter(c=>c.id===chat.id);
 return current.length===1&&
  JSON.stringify(current[0])===JSON.stringify(chat)&&
  policy.canUseChat(s,chat.id,'moderation');
}
export function groupReversalInventory(s:BotState,policy:Policy,chat:Chat):ReversalInventory{
 if(!currentApprovedModerationGroup(s,policy,chat))return zero();
 const actors=new Set<string>();
 for(const operation of s.moderationOperations)
  if(operation.chatId===chat.id)actors.add(operation.memberId);
 for(const reason of s.moderationReasons)
  if(reason.chatId===chat.id)actors.add(reason.memberId);
 let unknown=0,pending=0,activeReasons=0,unproven=0,stale=0,inspect=0;
 for(const member of actors){
  const result=inspectLocalReversal(s,policy,chat.id,member);
  switch(result.status){
   case 'BLOCKED_UNKNOWN':unknown++;break;
   case 'BLOCKED_PENDING':pending++;break;
   case 'BLOCKED_ACTIVE_REASON':activeReasons++;break;
   case 'BLOCKED_STALE':stale++;break;
   case 'MAY_INSPECT':inspect++;break;
   default:unproven++;break;
  }
 }
 return {total:actors.size,unknown,pending,activeReasons,unproven,stale,inspect};
}
/** A change in ANY current local reason or operation invalidates old buttons,
 * without disclosing even a stable truncated member identity to Telegram.
 * SHA-256 truncation is a freshness hint, never an authorization token.
 */
export function reversalInventoryDigest(s:BotState,chat:Chat):string{
 const operations=s.moderationOperations.filter(o=>o.chatId===chat.id);
 const reasons=s.moderationReasons.filter(r=>r.chatId===chat.id);
 return createHash('sha256').update('MANARATAK:REVERSAL:GROUP:V1:')
  .update(JSON.stringify([chat.id,chat.version,chat.approved,chat.scopes,
   operations,reasons])).digest('hex').slice(0,12);
}
export function renderReversalInventory(s:BotState,policy:Policy,chat:Chat):string{
 if(!currentApprovedModerationGroup(s,policy,chat))
  return '<b>🧭 عوائق التراجع — فحص محلي محجوب</b>\n'
   +'⚠️ تعذر فحص هذه المجموعة بسبب غياب تصريح فريد موثوق '
   +'أو تعارض بيانات صلاحيات المجموعة المستعادة.\n'
   +'لن تُعرض أعداد الأعضاء أو العقوبات من بيانات ملتبسة.\n'
   +'لا يوجد أي إجراء لفك الحظر أو الكتم؛ لم يُجر اتصال بـTelegram.';
 const v=groupReversalInventory(s,policy,chat);
 return '<b>🧭 عوائق التراجع عن العقوبات — بيانات محلية</b>\n'
  +'المجموعة: <code>'+chat.id+'</code>\n'
  +(v.total===0?'لا توجد سجلات عقوبات أو أسباب مرتبطة بأعضاء هذه المجموعة.\n':
   'عدد الحالات المسجلة: '+v.total+'\n')
  +'نتيجة مجهولة: '+v.unknown+'\n'
  +'معلقة: '+v.pending+'\n'
  +'أسباب نشطة: '+v.activeReasons+'\n'
  +'نقص أدلة: '+v.unproven+'\n'
  +'اختلاف إصدار: '+v.stale+'\n'
  +'مرشحة لفحص خارجي: '+v.inspect+'\n'
  +'مرشحة لفحص خارجي لا تعني السماح بفك الحظر أو الكتم؛ '
  +'لا تثبت بيانات Telegram من فرض العقوبة.\n'
  +'لا يوجد زر لفك القيد أو إعادة تنفيذ العقوبة في هذه الشاشة.\n'
  +'لم يُجر أي اتصال حي بـTelegram، والأرقام تستند إلى السجلات المحلية فقط.';
}
