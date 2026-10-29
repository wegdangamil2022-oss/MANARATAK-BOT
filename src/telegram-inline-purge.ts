import {createHash} from 'node:crypto';
import type {BotStore,PurgeJob} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {purgeReviewDigest} from './moderation-purge.js';
const page='(0|[1-9][0-9]{0,2})';
const pages=new RegExp('^pq:1:p:'+page+'$','u');
const detail=new RegExp('^pq:1:v:'+page+':([1-8]):([a-f0-9]{16})$','u');
const digest=(job:PurgeJob)=>createHash('sha256').update(JSON.stringify(job)).digest('hex').slice(0,16);
const button=(text:string,callback_data:string)=>({text,callback_data});
const states:Readonly<Record<PurgeJob['status'],string>>={PREVIEW:'معاينة',READY:'معتمدة',PAUSED:'متوقفة للمراجعة',CANCELLED:'ملغاة',COMPLETED:'مكتملة'};
/** Owner-only aggregate inspection of current authorized deletion plans.
 * Details use current page membership and a snapshot digest; no message text,
 * actor IDs, sender IDs, chat IDs or evidence hashes are projected to the UI. */
export async function renderOwnerPurgeQueue(store:BotStore,policy:Policy,actor:string,
 data:string,now:number,configured:boolean):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actor)||!Number.isSafeInteger(now)||now<0||now>8640000000000000)return null;
 let pageNumber=0,selection:RegExpExecArray|null=null;
 if(data!=='mi:1:i:02:13'&&data!=='pq:1:h'){
  const p=pages.exec(data);selection=detail.exec(data);
  if(p?.[0]===data)pageNumber=Number(p[1]);
  else if(selection?.[0]===data)pageNumber=Number(selection[1]);
  else return null;
 }
 const state=await store.snapshot();
 const counts=new Map<string,number>();
 for(const job of state.purgeJobs)if(job&&typeof job.id==='string')counts.set(job.id,(counts.get(job.id)??0)+1);
 const all=state.purgeJobs.filter(job=>job&&counts.get(job.id)===1&&
  typeof job.id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(job.id)&&
  Number.isSafeInteger(job.createdAt)&&job.createdAt>=0&&job.createdAt<=8640000000000000&&
  Object.hasOwn(states,job.status)&&Array.isArray(job.items)&&job.items.length>=1&&job.items.length<=25&&
  new Set(job.items.map(item=>item?.messageId)).size===job.items.length&&
  job.items.every(item=>item&&Number.isSafeInteger(item.messageId)&&item.messageId>0&&
   ['QUEUED','SENDING','ACKNOWLEDGED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','SKIPPED_UNVERIFIED','CANCELLED'].includes(item.status))&&
  policy.canUseChat(state,job.chatId,'moderation')&&policy.has(state,actor,'chat.manage',job.chatId,now))
  .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
 const totalPages=Math.max(1,Math.ceil(all.length/8));
 if(pageNumber>=totalPages||!policy.isOwner(actor))return null;
 const back=[button('↩️ قسم الحماية','mi:1:s:02:1'),button('🏠 لوحة المالك','mi:1:h')];
 const current=all.slice(pageNumber*8,pageNumber*8+8);
 if(selection){
  const job=current[Number(selection[2])-1];
  if(!job||digest(job)!==selection[3])return null;
  const unknown=job.items.filter(i=>i.status==='UNKNOWN_OUTCOME').length;
  const acknowledged=job.items.filter(i=>i.status==='ACKNOWLEDGED').length;
  const rows:ReturnType<typeof button>[][]=[];
  const canConfirm=configured&&job.status==='PREVIEW'&&job.actorId===actor&&job.items.length===1&&
   now>=job.createdAt&&now<=job.expiresAt&&policy.chatRevision(state,job.chatId)===job.scopeVersion;
  if(canConfirm)rows.push([
   button('✅ تأكيد حذف الرسالة','pd:1:c:'+job.id+':'+purgeReviewDigest(job)),
   button('↩️ إلغاء الحذف','pd:1:x:'+job.id+':'+purgeReviewDigest(job))
  ]);
  rows.push([button('↩️ معاينات الحذف','pq:1:p:'+pageNumber)],back);
  return {text:'<b>🧹 تفاصيل خطة الحذف المحلية</b>\n'
   +'الحالة: '+states[job.status]+'\nالرسائل المحددة: '+job.items.length+'\n'
   +'طلبات مقبولة في السجل: '+acknowledged+'\nمجهولة النتيجة: '+unknown+'\n'
   +(canConfirm?'التأكيد يرسل طلب رسالة واحدة بعد إعادة التحقق من المراجعة والصلاحيات.\n':'هذه الشاشة للعرض؛ لا تأكيد متاح لهذه الخطة في حالتها الحالية.\n')
   +'إقرار الطلب لا يثبت الحذف المادي، ولا تعاد العملية المجهولة تلقائيًا.',keyboard:{inline_keyboard:rows}};
 }
 const rows:ReturnType<typeof button>[][]=[];
 for(let i=0;i<current.length;i++)rows.push([button('📋 '+states[current[i]!.status]+' · '+current[i]!.items.length+' رسالة',
  'pq:1:v:'+pageNumber+':'+(i+1)+':'+digest(current[i]!))]);
 const nav:ReturnType<typeof button>[]=[];
 if(pageNumber>0)nav.push(button('⬅️ السابق','pq:1:p:'+(pageNumber-1)));
 if(pageNumber+1<totalPages)nav.push(button('➡️ التالي','pq:1:p:'+(pageNumber+1)));
 if(nav.length)rows.push(nav);
 rows.push(back);
 return {text:'<b>🧹 تنظيف الرسائل — معاينات الحذف</b>\n'
  +'الخطط المحلية المتاحة: '+all.length+'\nصفحة '+(pageNumber+1)+' من '+totalPages+'\n'
  +'موصل الحذف: '+(configured?'مهيأ في التطبيق؛ التنفيذ يخضع لبوابته وصلاحياته':'غير مهيأ في التطبيق؛ العرض فقط')+'\n'
  +(all.length?'اختر خطة لعرض حالتها.':'لا توجد معاينات متاحة حاليًا.')+'\n'
  +'ينشئ /delete بالرد معاينة خاصة لرسالة ملاحظة مسبقًا، دون جلب تاريخ المجموعة.',keyboard:{inline_keyboard:rows}};
}
