import type {BotStore,Chat,SubscriptionRequirement} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

/** Read-only owner group browser. The selector is NEVER a permission token.
 * All screens are rebuilt from current durable state after checking the owner.
 * No Telegram rights, group title or live membership is inferred from storage.
 */
export type OwnerInlineGroupRoute={kind:'list';page:number}|
 {kind:'details'|'subscription'|'access';chatId:string;version:number;page:number};
const id='(-[1-9][0-9]{0,18})';
const ver='([1-9][0-9]{0,9})';
const page='(0|[1-9][0-9]{0,2})';
const groupRoute=new RegExp('^mi:1:g:(d|u|a):'+id+':'+ver+':'+page+'$','u');
const pageRoute=new RegExp('^mi:1:g:p:'+page+'$','u');
export function parseOwnerInlineGroupRoute(input:string):OwnerInlineGroupRoute|null{
 if(typeof input!=='string'||Buffer.byteLength(input,'utf8')>64)return null;
 const p=pageRoute.exec(input);
 if(p&&p[0]===input)return {kind:'list',page:Number(p[1])};
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
const detailKey=(chat:Chat,p:number)=>'mi:1:g:d:'+chat.id+':'+chat.version+':'+p;
const accessKey=(chat:Chat,p:number)=>'mi:1:g:a:'+chat.id+':'+chat.version+':'+p;
const subKey=(chat:Chat,p:number)=>'mi:1:g:u:'+chat.id+':'+chat.version+':'+p;
const reviewKey=(chat:Chat,p:number,action:'x'|'a'|'p'|'s'|'r')=>
 'mi:1:g:v:'+chat.id+':'+chat.version+':'+p+':'+action;
const footer=(back:string):Button[]=>[
 button('↩️ رجوع',back),button('🏠 لوحة المالك','mi:1:h')
];
const PAGE_SIZE=8;
/** The catalogue's "مجموعاتي" entry opens the first group page, not a fake
 * implementation panel. Other inherited owner callbacks keep their routes.
 */
export async function renderOwnerInlineGroups(store:BotStore,policy:Policy,actorId:string,
 data:string):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actorId))return null;
 const route=data==='mi:1:i:01:01'?{kind:'list' as const,page:0}:parseOwnerInlineGroupRoute(data);
 if(!route)return null;
 const state=await store.snapshot();
 // This defensive second check follows the durable await; it is not the sole
 // authorization gate (Telegram's private identity check lives upstream).
 if(!policy.isOwner(actorId))return null;
 const approved=[...state.chats].filter(c=>c.approved &&
  /^-[1-9][0-9]{0,18}$/u.test(c.id)&&Number.isSafeInteger(c.version)&&
  c.version>=1&&c.version<=9_999_999_999)
  .sort((a,b)=>a.id.localeCompare(b.id));
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
  rows.push(footer('mi:1:s:01:0'));
  return {text:'<b>المجموعات المعتمدة 👥</b>\n'
   +'عدد المجموعات المصرح لها محليًا: '+approved.length+'\n'
   +(pages?'صفحة '+(route.page+1)+' من '+pages+'\n':'لا توجد مجموعات معتمدة حاليًا.\n')
   +'اختر مجموعة لعرض النطاقات والإعدادات المحفوظة.\n'
   +'هذا ليس فحصًا حيًا من Telegram؛ لا تُنفّذ أي تعديلات أو عقوبات من هنا.',
   keyboard:markup(rows)};
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
  const body='<b>بطاقة المجموعة المحفوظة 👥</b>\n'
   +'معرف المحادثة: <code>'+safe(chat.id)+'</code>\n'
   +'الاعتماد المحلي: '+(chat.approved?'معتمد':'ملغى')+'\n'
   +'وجود البوت المحفوظ: '+(chat.present?'مسجل كموجود':'غير مؤكد')+'\n'
   +'النطاقات المحلية: '+(chat.scopes.join(', ')||'بلا نطاقات')+'\n'
   +'وضع المساعد المحفوظ: '+chat.groupAI+'\n'
   +'الاشتراك المحفوظ: '+(enabled?'لديه '+subscription!.channelIds.length+' قناة مطلوبة':'غير مفعل')+'\n'
   +'إصدار سياسة المجموعة: '+chat.version+'\n'
   +'لا يوجد تحقق حي من Telegram. لا توجد أوامر حظر أو نشر في هذه الشاشة.';
  const actionRows:Button[][]=[];
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
  actionRows.push([button('⛔ معاينة إلغاء تصريح المجموعة',reviewKey(chat,route.page,'r'))]);
  return {text:body,keyboard:markup([
   [button('🔐 نطاقات الصلاحيات',accessKey(chat,route.page)),
    button('📋 اشتراكات المجموعة',subKey(chat,route.page))],
   ...actionRows,
   footer(listKey(route.page))
  ])};
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
