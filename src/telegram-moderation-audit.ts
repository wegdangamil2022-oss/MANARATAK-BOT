import {createHash} from 'node:crypto';
import type {BotState,Chat,ModerationOperation,OperationStatus} from './store.js';
import type {TelegramInlineKeyboard} from './telegram-inline-owner.js';

/** Only operation OUTCOME/TYPE and total counts may appear in an authorized
 * scoped staff view. Member identities, actors, reason IDs and proofs are
 * incorporated solely into a one-way stale-route digest, never printed.
 */
type Button={readonly text:string;readonly callback_data:string};
export interface ModerationAuditScreen {readonly text:string;readonly keyboard:TelegramInlineKeyboard;}
const btn=(text:string,callback_data:string):Button=>({text,callback_data});
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const statusLabels:Readonly<Record<OperationStatus,string>>={
 INTENT:'قيد التجهيز',STARTED:'بدأ الإرسال — النتيجة غير محسومة',
 CONFIRMED:'مؤكدة محليًا من الرد',FAILED_CONFIRMED:'فاشلة برد مؤكد',
 UNKNOWN_OUTCOME:'نتيجة مجهولة — يمنع إعادة الإرسال تلقائيًا',
 CANCELLED:'ملغاة قبل التنفيذ'
};
export function groupModerationOperations(s:BotState,id:string):ModerationOperation[]{
 return s.moderationOperations.filter(o=>o.chatId===id)
  .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
}
export function moderationAuditDigest(ops:readonly ModerationOperation[]):string{
 return createHash('sha256').update('MANARATAK:MODERATION:STATUS:V1:')
  .update(JSON.stringify(ops.map(o=>[o.id,o.chatId,o.memberId,o.actorId,o.kind,
   o.reasonFingerprint,o.policyVersion,o.status,o.createdAt])))
  .digest('hex').slice(0,12);
}
export const moderationAuditKey=(chat:Chat,page:number,opPage:number,digest:string)=>
 'ms:1:o:'+chat.id+':'+chat.version+':'+page+':'+opPage+':'+digest;
export function renderStaffModerationAudit(chat:Chat,groupPage:number,opPage:number,
 ops:readonly ModerationOperation[],digest:string):ModerationAuditScreen|null{
 const pages=Math.max(1,Math.ceil(ops.length/8));
 if(opPage<0||opPage>=pages)return null;
 const counters:Record<OperationStatus,number>={
  INTENT:0,STARTED:0,CONFIRMED:0,FAILED_CONFIRMED:0,UNKNOWN_OUTCOME:0,CANCELLED:0};
 for(const o of ops){if(Object.hasOwn(counters,o.status))counters[o.status]++;}
 const visible=ops.slice(opPage*8,(opPage+1)*8);
 const lines=visible.map((o,index)=>{
  const kind=o.kind==='BAN'?'حظر':o.kind==='MUTE'?'كتم':'رفع قيد (سجل محلي)';
  return '• '+(opPage*8+index+1)+'. '+kind+' — '+
   (statusLabels[o.status]??'حالة غير معروفة');
 });
 const nav:Button[]=[];
 if(opPage>0)nav.push(btn('⬅️ السابق',moderationAuditKey(chat,groupPage,opPage-1,digest)));
 if(opPage+1<pages)nav.push(btn('➡️ التالي',moderationAuditKey(chat,groupPage,opPage+1,digest)));
 const rows:Button[][]=nav.length?[nav]:[];
 rows.push([btn('↩️ بطاقة المجموعة','ms:1:g:'+chat.id+':'+chat.version+':'+groupPage),
  btn('🏠 مجموعاتي الإشرافية','ms:1:h')]);
 return {
  text:'<b>متابعة حالات العقوبات المحلية 🛡️</b>\n'
   +'المجموعة: <code>'+esc(chat.id)+'</code>\n'
   +'الإجمالي: '+ops.length+' · مؤكدة: '+counters.CONFIRMED+
   ' · فاشلة: '+counters.FAILED_CONFIRMED+' · مجهولة: '+counters.UNKNOWN_OUTCOME+
   ' · معلقة: '+(counters.INTENT+counters.STARTED)+' · ملغاة: '+counters.CANCELLED+'\n'
   +'صفحة '+(opPage+1)+' من '+pages+'\n'
   +(lines.length?lines.join('\n'):'لا توجد محاولات عقوبات محفوظة لهذه المجموعة.')+'\n'
   +'النتيجة مجهولة تعني الحاجة لمراجعة بشرية؛ لا يوجد زر لإعادة إرسال '
   +'أو إعادة تنفيذ عقوبة من هذه الشاشة. هذه سجلات محلية فقط، '
   +'ولا تؤكد الوضع الحالي داخل Telegram.',
  keyboard:{inline_keyboard:rows}
 };
}
