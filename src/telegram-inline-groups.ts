import type {BotStore,BotState,Chat,SubscriptionRequirement} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {reversalInventoryDigest,renderReversalInventory} from './moderation-reversal-inventory.js';
import {ambiguousModerationChatIds} from './moderation-review-integrity.js';
import {delegationGroupEntry} from './telegram-inline-delegation-edit.js';
import {isValidGroupProtectionRecord} from './protection-rules.js';

/** Read-only owner group browser. The selector is NEVER a permission token.
 * All screens are rebuilt from current durable state after checking the owner.
 * No Telegram rights, group title or live membership is inferred from storage.
 */
export type OwnerInlineGroupRoute={kind:'list';page:number}|{kind:'summary';page:number}|
 {kind:'alerts';page:number}|{kind:'modes';page:number}|
 {kind:'details'|'subscription'|'access';chatId:string;version:number;page:number}|
 {kind:'reversal';chatId:string;version:number;page:number;digest:string};
const id='(-[1-9][0-9]{0,18})';
const ver='([1-9][0-9]{0,9})';
const page='(0|[1-9][0-9]{0,2})';
const groupRoute=new RegExp('^mi:1:g:(d|u|a):'+id+':'+ver+':'+page+'$','u');
const pageRoute=new RegExp('^mi:1:g:p:'+page+'$','u');
const summaryRoute=new RegExp('^mi:1:g:s:'+page+'$','u');
const alertsRoute=new RegExp('^mi:1:g:n:'+page+'$','u');
const modesRoute=new RegExp('^mi:1:g:o:'+page+'$','u');
const reversalRoute=new RegExp('^mi:1:g:r:'+id+':'+ver+':'+page+':([a-f0-9]{12})$','u');
export function parseOwnerInlineGroupRoute(input:string):OwnerInlineGroupRoute|null{
 if(typeof input!=='string'||Buffer.byteLength(input,'utf8')>64)return null;
 const p=pageRoute.exec(input);
 if(p&&p[0]===input)return {kind:'list',page:Number(p[1])};
 const summary=summaryRoute.exec(input);
 if(summary&&summary[0]===input)return {kind:'summary',page:Number(summary[1])};
 const alerts=alertsRoute.exec(input);
 if(alerts&&alerts[0]===input)return {kind:'alerts',page:Number(alerts[1])};
 const modes=modesRoute.exec(input);
 if(modes&&modes[0]===input)return {kind:'modes',page:Number(modes[1])};
 const r=reversalRoute.exec(input);
 if(r&&r[0]===input)return {kind:'reversal',chatId:r[1]!,version:Number(r[2]),
  page:Number(r[3]),digest:r[4]!};
 const m=groupRoute.exec(input);
 if(!m||m[0]!==input)return null;
 const kind=m[1]==='d'?'details':m[1]==='u'?'subscription':'access';
 return {kind,chatId:m[2]!,version:Number(m[3]),page:Number(m[4])};
}
type Button={readonly text:string;readonly callback_data:string};
const button=(text:string,callback_data:string):Button=>({text,callback_data});
const markup=(rows:readonly (readonly Button[])[]):TelegramInlineKeyboard=>({inline_keyboard:rows});
const safe=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const listKey=(p:number)=>'mi:1:g:p:'+p;
const summaryKey=(p:number)=>'mi:1:g:s:'+p;
const alertsKey=(p:number)=>'mi:1:g:n:'+p;
const modesKey=(p:number)=>'mi:1:g:o:'+p;
const detailKey=(chat:Chat,p:number)=>'mi:1:g:d:'+chat.id+':'+chat.version+':'+p;
const accessKey=(chat:Chat,p:number)=>'mi:1:g:a:'+chat.id+':'+chat.version+':'+p;
const subKey=(chat:Chat,p:number)=>'mi:1:g:u:'+chat.id+':'+chat.version+':'+p;
const reversalKey=(chat:Chat,p:number,digest:string)=>
 'mi:1:g:r:'+chat.id+':'+chat.version+':'+p+':'+digest;
const reviewKey=(chat:Chat,p:number,action:'x'|'a'|'p'|'s'|'r')=>
 'mi:1:g:v:'+chat.id+':'+chat.version+':'+p+':'+action;
const footer=(back:string):Button[]=>[
 button('↩️ رجوع',back),button('🏠 لوحة المالك','mi:1:h')
];
const PAGE_SIZE=8;
/** Saved local policy labels are not proof of Telegram rights or enforcement. */
const localProtection=(state:BotState,chat:Chat,now=Date.now()):string=>{
 if(!chat.scopes.includes('moderation'))return 'نطاق الحماية غير مصرح';
 const entries=(state.protectionPolicies??[]).filter(r=>r.policy.chatId===chat.id);
 if(!entries.length)return 'غير مضبوطة';
 const record=entries[0]!;
 if(entries.length!==1||!isValidGroupProtectionRecord(record)||
  record.chatPolicyVersion!==chat.version||record.updatedAt>now)return 'تحتاج مراجعة';
 return record.policy.mode==='MONITOR'?'مراقبة فقط':
  record.policy.mode==='OFF'?'متوقفة':'تحتاج مراجعة';
};

/** Advisory observations from locally saved state only. No message delivery,
 * Telegram rights probe, or moderation effects are performed by these views. */
const localGroupAlerts=(state:BotState,chat:Chat):string[]=>{
 const alerts:string[]=[];
 if(!chat.present)alerts.push('وجود البوت غير مؤكد');
 if(chat.scopes.includes('moderation')){
  const status=localProtection(state,chat);
  if(status==='غير مضبوطة')alerts.push('سياسة الحماية غير مضبوطة');
  else if(status==='تحتاج مراجعة')alerts.push('سياسة الحماية تحتاج مراجعة');
 }
 const subscriptions=state.subscriptionRequirements.filter(x=>x.chatId===chat.id);
 if(subscriptions.length>1)alerts.push('متطلبات اشتراك متعارضة');
 else if(chat.scopes.includes('verification')&&(!subscriptions.length||!subscriptions[0]!.channelIds.length))
  alerts.push('لا توجد قنوات اشتراك محفوظة');
 else if(!chat.scopes.includes('verification')&&subscriptions.length)
  alerts.push('اشتراك محفوظ بلا نطاق تحقق');
 if(chat.groupAI!=='OFF'&&!chat.scopes.includes('assistant'))
  alerts.push('المساعد مهيأ خارج نطاقه');
 return alerts;
};
const approvedGroups=(state:BotState,conflicts:ReadonlySet<string>):Chat[]=>
 [...state.chats].filter(c=>c.approved&&!conflicts.has(c.id)&&
  /^-[1-9][0-9]{0,18}$/u.test(c.id)&&Number.isSafeInteger(c.version)&&
  c.version>=1&&c.version<=9_999_999_999)
  .sort((a,b)=>a.id.localeCompare(b.id));

/** Return to the exact approved owner group card, not merely an arbitrary
 * group-list page. This is a locator only: callbacks still recheck the owner,
 * policy revision, approval and current list membership when tapped. */
export function ownerGroupCardLink(state:BotState,chatId:string):string|null{
 const all=approvedGroups(state,ambiguousModerationChatIds(state));
 const index=all.findIndex(c=>c.id===chatId);
 return index<0?null:detailKey(all[index]!,Math.floor(index/PAGE_SIZE));
}

/** The catalogue's "مجموعاتي" entry opens the first group page, not a fake
 * implementation panel. Other inherited owner callbacks keep their routes.
 */
export async function renderOwnerInlineGroups(store:BotStore,policy:Policy,actorId:string,
 data:string):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actorId))return null;
 const route=data==='mi:1:i:01:01'?{kind:'list' as const,page:0}:
  data==='mi:1:i:01:09'?{kind:'alerts' as const,page:0}:
  data==='mi:1:i:01:10'?{kind:'summary' as const,page:0}:
  data==='mi:1:i:01:11'?{kind:'modes' as const,page:0}:parseOwnerInlineGroupRoute(data);
 if(!route)return null;
 const state=await store.snapshot();
 // This defensive second check follows the durable await; it is not the sole
 // authorization gate (Telegram's private identity check lives upstream).
 if(!policy.isOwner(actorId))return null;
 // Owner selectors are never group authority. A restored duplicate ID,
 // including an identical or revoked copy, cannot be shown as an approved
 // distinct group or used by an existing detail/reversal callback.
 const conflictingChats=ambiguousModerationChatIds(state);
 const approved=approvedGroups(state,conflictingChats);
 const pages=Math.ceil(approved.length/PAGE_SIZE);
 if(route.kind==='list'){
  if(route.page>(pages?pages-1:0))return null;
  const current=approved.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE);
  const rows:Button[][]=[];
  for(let i=0;i<current.length;i+=2){
   rows.push(current.slice(i,i+2).map(chat=>
    button('👥 '+chat.id,detailKey(chat,route.page))));
  }
  const nav:Button[]=[];
  if(route.page>0)nav.push(button('⬅️ السابق',listKey(route.page-1)));
  if(route.page+1<pages)nav.push(button('➡️ التالي',listKey(route.page+1)));
  if(nav.length)rows.push(nav);
  rows.push([button('🔔 تنبيهات الشبكة المحلية',alertsKey(0)),button('🔍 فحص الصلاحيات المحلية',summaryKey(0))]);
  rows.push([button('🚦 أوضاع التشغيل المحلية',modesKey(0))]);
  rows.push(footer('mi:1:s:01:0'));
  return {text:'<b>المجموعات المعتمدة 👥</b>\n'
   +'عدد المجموعات المصرح لها محليًا: '+approved.length+'\n'
   +'مجموعات متعارضة محجوبة: '+conflictingChats.size+'\n'
   +(pages?'صفحة '+(route.page+1)+' من '+pages+'\n':'لا توجد مجموعات معتمدة حاليًا.\n')
   +'اختر مجموعة لعرض النطاقات والإعدادات المحفوظة.\n'
   +'هذا ليس فحصًا حيًا من Telegram؛ لا تُنفّذ أي تعديلات أو عقوبات من هنا.',
   keyboard:markup(rows)};
 }
 if(route.kind==='summary'){
  const pageCount=Math.max(1,Math.ceil(approved.length/PAGE_SIZE));
  if(route.page>=pageCount)return null;
  const selected=approved.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE);
  const lines:string[]=[],rows:Button[][]=[];
  for(const item of selected){
   const names=[
    item.scopes.includes('moderation')?'حماية':'',
    item.scopes.includes('verification')?'اشتراك':'',
    item.scopes.includes('assistant')?'مساعد':'',
    item.scopes.includes('publishing')?'نشر':''
   ].filter(Boolean).join('، ')||'لا توجد خدمات إضافية';
   lines.push('• <code>'+safe(item.id)+'</code> · '+names+' · الحماية: '+localProtection(state,item));
   rows.push([button('👥 '+item.id,detailKey(item,route.page))]);
  }
  const nav:Button[]=[];
  if(route.page>0)nav.push(button('⬅️ السابق',summaryKey(route.page-1)));
  if(route.page+1<pageCount)nav.push(button('➡️ التالي',summaryKey(route.page+1)));
  if(nav.length)rows.push(nav);
  rows.push([button('📋 مجموعاتي',listKey(0))]);
  rows.push(footer('mi:1:s:01:1'));
  return {text:'<b>🔍 فحص الصلاحيات المحلية</b>\n'
   +'المجموعات المعتمدة: '+approved.length+' · المتعارضة المحجوبة: '+conflictingChats.size+'\n'
   +'صفحة '+(route.page+1)+' من '+pageCount+'\n'
   +(lines.length?lines.join('\n')+'\n':'لا توجد مجموعات معتمدة لعرضها.\n')
   +'لا يتحقق هذا العرض من حقوق Telegram الحية، ولا يمنح أي صلاحية أو ينفذ أي إجراء.',
   keyboard:markup(rows)};
 }
 if(route.kind==='alerts'||route.kind==='modes'){
  // Only approved, non-conflicting chats are available, even when a callback
  // is copied from another owner session or points to a stale page.
  const items=route.kind==='alerts'?
   approved.map(chat=>({chat,alerts:localGroupAlerts(state,chat)})).filter(x=>x.alerts.length>0):
   approved.map(chat=>({chat,alerts:[] as string[]}));
  const maxPage=Math.max(1,Math.ceil(items.length/PAGE_SIZE));
  if(route.page>=maxPage)return null;
  const current=items.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE);
  const rows:Button[][]=[],lines:string[]=[];
  for(const {chat:entry,alerts} of current){
   const approvedIndex=approved.indexOf(entry);
   // A diagnostic page is not necessarily the same as the group-browser page.
   // Reuse the group's actual page and version for the card shortcut.
   rows.push([button('👥 '+entry.id,detailKey(entry,Math.floor(approvedIndex/PAGE_SIZE)))]);
   if(route.kind==='alerts'){
    lines.push('• <code>'+safe(entry.id)+'</code>: '+alerts.join('؛ '));
   }else{
    lines.push('• <code>'+safe(entry.id)+'</code>: الحماية: '+localProtection(state,entry)+
     ' · المساعد: '+safe(entry.groupAI)+
     ' · النشر: '+(entry.scopes.includes('publishing')?'مصرح محليًا':'غير مصرح'));
   }
  }
  const nav:Button[]=[];
  const key=route.kind==='alerts'?alertsKey:modesKey;
  if(route.page>0)nav.push(button('⬅️ السابق',key(route.page-1)));
  if(route.page+1<maxPage)nav.push(button('➡️ التالي',key(route.page+1)));
  if(nav.length)rows.push(nav);
  rows.push([button('📋 مجموعاتي',listKey(0))]);
  rows.push(footer('mi:1:s:01:1'));
  const alertsView=route.kind==='alerts';
  return {
   text:(alertsView?'<b>🔔 تنبيهات الشبكة المحلية</b>\n':'<b>🚦 أوضاع التشغيل المحلية</b>\n')+
    'المجموعات المعتمدة: '+approved.length+' · المتعارضة المحجوبة: '+conflictingChats.size+'\n'+
    (alertsView?'مجموعات تحتاج مراجعة محلية: '+items.length+'\n':'')+
    'صفحة '+(route.page+1)+' من '+maxPage+'\n'+
    (lines.length?lines.join('\n')+'\n':alertsView?'لا توجد تنبيهات محلية من السجلات الحالية.\n':'لا توجد مجموعات معتمدة.\n')+
    (alertsView?'هذا ليس تنبيهًا مرسلًا من Telegram؛ لم تُفحص حقوق البوت الحية ولا تُرسل إشعارات.':
     'هذه إعدادات محفوظة محليًا فقط؛ لا تنفذ عقوبات Telegram ولا تفعّل الحماية الحية.'),
   keyboard:markup(rows)
  };
 }
 const chat=approved.find(c=>c.id===route.chatId);
 // A copied ID/version, an old revoked group or a group shifted to another
 // list page never provides a valid detail screen.
 if(!chat||chat.version!==route.version||
  !approved.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE)
   .some(c=>c.id===chat.id))return null;
 const subs=state.subscriptionRequirements.filter(r=>r.chatId===chat.id);
 if(subs.length>1)return null; // fail closed on invalid conflicting configuration
 const subscription:SubscriptionRequirement|undefined=subs[0];
 const enabled=chat.scopes.includes('verification') && Boolean(subscription?.channelIds.length);
 if(route.kind==='details'){
  const protectionRows=(state.protectionPolicies??[]).filter(r=>r.policy.chatId===chat.id);
  const protection=protectionRows[0];
  const currentPolicy=chat.scopes.includes('moderation')&&protectionRows.length===1&&protection!==undefined&&
   isValidGroupProtectionRecord(protection)&&protection.chatPolicyVersion===chat.version&&
   protection.updatedAt<=Date.now();
  const protectionLabel=!chat.scopes.includes('moderation')?'نطاق الحماية غير مصرح':
   protectionRows.length===0?'غير مضبوطة':
   !currentPolicy?'تحتاج مراجعة':
   protection!.policy.mode==='MONITOR'?'مراقبة فقط':
   protection!.policy.mode==='OFF'?'متوقفة':'تحتاج مراجعة';
  const activeRules=currentPolicy?protection!.policy.rules.filter(r=>r.enabled).length:0;
  const protectionCounts=currentPolicy?'قواعد مفعلة للمراقبة: '+activeRules+' من '+protection!.policy.rules.length+'\n':'';
  const body='<b>بطاقة المجموعة المحفوظة 👥</b>\n'
   +'معرف المحادثة: <code>'+safe(chat.id)+'</code>\n'
   +'الاعتماد المحلي: '+(chat.approved?'معتمد':'ملغى')+'\n'
   +'وجود البوت المحفوظ: '+(chat.present?'مسجل كموجود':'غير مؤكد')+'\n'
   +'النطاقات المحلية: '+(chat.scopes.join(', ')||'بلا نطاقات')+'\n'
   +'وضع المساعد المحفوظ: '+chat.groupAI+'\n'
   +'الاشتراك المحفوظ: '+(enabled?'لديه '+subscription!.channelIds.length+' قناة مطلوبة':'غير مفعل')+'\n'
   +'إصدار سياسة المجموعة: '+chat.version+'\n'
   +'حالة الحماية المحلية: '+protectionLabel+'\n'
   +protectionCounts
   +'لا يوجد تحقق حي من Telegram. لا توجد أوامر حظر أو نشر في هذه الشاشة.';
  const actionRows:Button[][]=[];
  const delegation=delegationGroupEntry(state,chat.id,chat.version);
  if(delegation)actionRows.push([button('➕ تفويض في هذه المجموعة',delegation)]);
  if(chat.scopes.includes('moderation')&&Number.isSafeInteger(Number(chat.id))&&chat.id.length<=17)
   actionRows.push([button('🛡️ إدارة حماية هذه المجموعة','gp:1:p:'+chat.id+':'+chat.version)]);
  if(chat.scopes.includes('moderation')&&Number.isSafeInteger(Number(chat.id))&&chat.id.length<=17&&!state.protectionPolicies?.some(r=>r.policy.chatId===chat.id))
   actionRows.push([button('🧭 معالج إعداد المجموعة','gw:1:b:'+chat.id+':'+chat.version+':'+route.page)]);
  if(chat.groupAI!=='OFF')
   actionRows.push([button('🛑 معاينة إيقاف AI محليًا',reviewKey(chat,route.page,'x'))]);
  const restrictions:Button[]=[];
  if(chat.scopes.includes('assistant'))
   restrictions.push(button('🔐 معاينة تقييد المساعد',reviewKey(chat,route.page,'a')));
  if(chat.scopes.includes('publishing'))
   restrictions.push(button('📢 معاينة تعطيل النشر',reviewKey(chat,route.page,'p')));
  if(restrictions.length)actionRows.push(restrictions);
  if(enabled){
   actionRows.push([button('🧊 معاينة تعليق الاشتراك',reviewKey(chat,route.page,'s'))]);
  }
  if(chat.scopes.includes('moderation'))
   actionRows.push([button('🧭 عوائق التراجع المحلية',reversalKey(chat,route.page,
    reversalInventoryDigest(state,chat)))]);
  actionRows.push([button('⛔ معاينة إلغاء تصريح المجموعة',reviewKey(chat,route.page,'r'))]);
  return {text:body,keyboard:markup([
   [button('🔐 نطاقات الصلاحيات',accessKey(chat,route.page)),
    button('📋 اشتراكات المجموعة',subKey(chat,route.page))],
   ...actionRows,
   footer(listKey(route.page))
  ])};
 }
 if(route.kind==='reversal'){
  if(!chat.scopes.includes('moderation')||
   reversalInventoryDigest(state,chat)!==route.digest)return null;
  return {text:renderReversalInventory(state,policy,chat),
   keyboard:markup([footer(detailKey(chat,route.page))])};
 }
 if(route.kind==='access'){
  const scopeNames=['navigation','assistant','moderation','verification','publishing'];
  return {text:'<b>النطاقات المحلية المحفوظة 🔐</b>\n'
   +'المجموعة: <code>'+safe(chat.id)+'</code>\n'
   +scopeNames.map(s=>'• '+s+': '+(chat.scopes.includes(s)?'مصرح محليًا':'غير مصرح')).join('\n')
   +'\nوضع المساعد: '+chat.groupAI+'\n'
   +'هذه حالة سياسة داخلية وليست قياسًا لحقوق البوت الحية في Telegram.\n'
   +'لا يمكن تعديل النطاقات من هذه الصفحة.',
   keyboard:markup([footer(detailKey(chat,route.page))])};
 }
 // The rule is described as local-only. Display a bounded set of IDs; never
 // promise external verification or release previous moderation restrictions.
 const channels=enabled?subscription!.channelIds:[];
 return {text:'<b>الاشتراك المحفوظ 📋</b>\n'
  +'المجموعة: <code>'+safe(chat.id)+'</code>\n'
  +'صلاحية التحقق المحلية: '+(chat.scopes.includes('verification')?'متاحة':'معطلة')+'\n'
  +'نمط الاشتراك: '+(enabled?subscription!.mode:'غير مفعل')+'\n'
  +'عدد القنوات المطلوبة: '+channels.length+'\n'
  +(channels.length?'القنوات (حد العرض 12):\n'+channels.slice(0,12)
   .map(c=>'• <code>'+safe(c)+'</code>').join('\n')+'\n':'')
  +(channels.length>12?'المزيد: '+(channels.length-12)+' قناة أخرى.\n':'')
  +'البيانات محلية فقط؛ لا تُثبت عضوية فعلية ولا تُحرر كتمًا سابقًا.',
  keyboard:markup([footer(detailKey(chat,route.page))])};
}
