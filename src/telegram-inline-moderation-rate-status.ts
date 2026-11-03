import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {MODERATION_RATE_LIMITS} from './moderation-rate-fuse.js';

/** Private-owner status-only view over actual locally approved group attempts.
 * It reports anonymous aggregates, never actor/member IDs or evidence.
 * Changing a rate limit requires the separate owner-only confirmation flow.
 */
export async function renderOwnerModerationRateStatus(store:BotStore,policy:Policy,
 actorId:string,now:number):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actorId)||!Number.isSafeInteger(now)||now<0||
   now>8_640_000_000_000_000)return null;
 const snapshot=await store.snapshot();
 const limits=snapshot.moderationRateConfig??MODERATION_RATE_LIMITS;
 if(!policy.isOwner(actorId))return null;
 const enabled=new Set(snapshot.chats.filter(c=>c.approved&&
  c.scopes.includes('moderation')).map(c=>c.id));
 const considered=snapshot.moderationOperations.filter(o=>
  enabled.has(o.chatId)&&(o.kind==='BAN'||o.kind==='MUTE'||o.action==='KICK')&&
  o.status!=='CANCELLED');
 const ten=considered.filter(o=>o.createdAt>now-MODERATION_RATE_LIMITS.tenMinutesMs).length;
 const day=considered.filter(o=>o.createdAt>now-MODERATION_RATE_LIMITS.dayMs).length;
 const unknown=considered.filter(o=>o.status==='UNKNOWN_OUTCOME').length;
 const pending=considered.filter(o=>o.status==='INTENT'||o.status==='STARTED').length;
 return {text:'<b>⚙️ سياسات العقوبات والاختبار — حدود العقوبات</b>\n'
  +'حالة الضابط: مفعل في منطق تنفيذ العقوبات المحلي.\n'
  +'• '+limits.actorChatTenMinutes+' إجراءات لكل مشرف في كل مجموعة خلال 10 دقائق.\n'
  +'• '+limits.groupTenMinutes+' إجراءًا للمجموعة عبر جميع المخولين خلال 10 دقائق.\n'
  +'• '+limits.actorAllChatsDay+' إجراءًا للحساب عبر المجموعات خلال 24 ساعة.\n'
  +'المجموعات المعتمدة للحماية محليًا: '+enabled.size+'\n'
  +'محاولات العقوبات المسجلة آخر 10 دقائق: '+ten+'\n'
  +'محاولات العقوبات المسجلة آخر 24 ساعة: '+day+'\n'
  +'مجهولة النتيجة: '+unknown+'\n'
  +'معلقة: '+pending+'\n'
  +'الإحصاءات محلية ومجهّلة؛ لا تثبت حالة Telegram الحالية. العمليات المجهولة لا يعاد إرسالها آليًا.\n'
  +'العقوبات الحية معطلة افتراضيًا؛ تغيير الحد يتطلب معاينة وتأكيدًا.',
  keyboard:{inline_keyboard:[[{text:'⚙️ تعديل الحدود',callback_data:'rf:1:e'}],[
   {text:'↩️ قسم الحماية',callback_data:'mi:1:s:02:1'},
   {text:'🏠 لوحة المالك',callback_data:'mi:1:h'}
  ]]}};
}
