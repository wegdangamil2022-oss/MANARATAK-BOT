import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {readTelegramSafetySwitch} from './telegram-safety-switch.js';
import {moderationLedgerSafeForDispatch} from './moderation-review-integrity.js';

/** Owner-private read-only view over the real emergency file and local
 * moderation ledger. This cannot arm/reconfigure the Telegram gateway or
 * grant moderation rights. When the file is missing/untrusted, NEVER
 * represent its absence as RUN or STOP.
 */
export async function renderOwnerModerationEmergencyStatus(
 store:BotStore,policy:Policy,actorId:string,now:number,
 safetyFile?:string
):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actorId)||!Number.isSafeInteger(now)||now<0||
   now>8_640_000_000_000_000)return null;

 // Fail closed for unreadable/invalid operator evidence. The filesystem
 // helper independently rejects symlinks, hardlinks and races.
 const switchRead=async():Promise<'RUN'|'STOP'|'UNTRUSTED'|'UNCONFIGURED'>=>{
  if(!safetyFile)return 'UNCONFIGURED';
  try{return await readTelegramSafetySwitch(safetyFile);}
  catch{return 'UNTRUSTED';}
 };
 const first=await switchRead();
 const state=await store.snapshot();
 const last=await switchRead();
 if(!policy.isOwner(actorId))return null;
 const safety=first===last?last:'UNTRUSTED';

 // Display only aggregates from current durable state; do not include IDs,
 // reasons, content, chat names, file paths, tokens or operation evidence.
 const ops=Array.isArray(state.moderationOperations)?state.moderationOperations:[];
 const validRows=ops.every(o=>Boolean(o)&&typeof o==='object'&&
  typeof o.status==='string');
 const unknown=validRows?ops.filter(o=>o.status==='UNKNOWN_OUTCOME').length:null;
 const pending=validRows?ops.filter(o=>o.status==='INTENT'||o.status==='STARTED').length:null;
 const approved=Array.isArray(state.chats)?
  state.chats.filter(c=>c?.approved&&c.scopes?.includes('moderation')).length:null;
 const safeLedger=moderationLedgerSafeForDispatch(state,now);
 const needsReview=(unknown??0)>0||(pending??0)>0;

 const switchLabel=safety==='STOP'?'STOP — إيقاف الحركة عبر مفتاح الطوارئ':
  safety==='RUN'?'RUN — المفتاح يسمح بالتشغيل المشروط، ولا يفعّل العقوبات':
  safety==='UNCONFIGURED'?'غير مهيأ في هذه الجلسة':'غير موثوق — تعذرت قراءة المفتاح بأمان';
 const count=(value:number|null)=>value===null?'غير متاح':String(value);

 const text='<b>📋 السجلات والطوارئ — إشراف منارتك</b>\n'
  +'حالة المفتاح: '+switchLabel+'\n'
  +'سجل العقوبات: '+(!safeLedger?'غير سليم؛ بحاجة إلى مراجعة قبل أي إرسال':
   needsReview?'سليم بنيويًا؛ توجد عمليات بحاجة إلى مراجعة':'سليم للفحص المحلي')+'\n'
  +'المجموعات ذات نطاق الإشراف المعتمد محليًا: '+count(approved)+'\n'
  +'مجهولة النتيجة: '+count(unknown)+'\n'
  +'معلقة: '+count(pending)+'\n\n'
  +'العقوبات الحية غير موصولة بخادم منارتك الحالي.\n'
  +'هذه قراءة لحظية محلية فقط: RUN لا يعني تشغيل الحظر والكتم، '
  +'وSTOP لا يغيّر بيانات Telegram التي سبق إرسالها.\n'
  +'أي عملية مجهولة أو معلقة تتطلب مراجعة مستقلة ولا يُعاد إرسالها تلقائيًا.\n'
  +'لا يمكن تغيير ملف الطوارئ أو تنفيذ عقوبة من هذه الشاشة.';
 return {text,keyboard:{inline_keyboard:[
  [{text:'⚠️ الحالات مجهولة النتيجة',callback_data:'mr:1:h'},
   {text:'⏳ العمليات المعلقة',callback_data:'mp:1:h'}],
  [{text:'⚙️ حدود العقوبات',callback_data:'mi:1:i:02:15'}],
  [{text:'↩️ قسم الحماية',callback_data:'mi:1:s:02:1'},
   {text:'🏠 لوحة المالك',callback_data:'mi:1:h'}]
 ]}};
}
