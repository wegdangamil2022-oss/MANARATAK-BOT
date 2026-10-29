import {createHash} from 'node:crypto';
import type {BotStore,Grant,BotState,Capability} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

/** Owner-private view of stored internal grants. Editing routes are separately
 * reviewed and never imply Telegram chat-administrator rights.
 * A route is an untrusted selector; the current sorted ledger is re-read on
 * every press and its fingerprint checked before exposing a specific entry.
 */
export type OwnerInlineDelegationRoute={kind:'list';page:number}|
 {kind:'detail';page:number;ordinal:number;digest:string};
const pg='(0|[1-9][0-9]{0,2})';
const listRe=new RegExp('^mi:1:d:p:'+pg+'$','u');
const detailRe=new RegExp('^mi:1:d:i:'+pg+':([1-8]):([a-f0-9]{12})$','u');
export function parseOwnerInlineDelegationRoute(input:string):OwnerInlineDelegationRoute|null {
 if(typeof input!=='string'||Buffer.byteLength(input,'utf8')>64)return null;
 const p=listRe.exec(input);
 if(p&&p[0]===input)return {kind:'list',page:Number(p[1])};
 const d=detailRe.exec(input);
 if(d&&d[0]===input)return {kind:'detail',page:Number(d[1]),ordinal:Number(d[2]),digest:d[3]!};
 return null;
}
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const b=(text:string,callback_data:string)=>({text,callback_data});
const keyboard=(rows:readonly (readonly {text:string;callback_data:string}[])[]):TelegramInlineKeyboard=>
 ({inline_keyboard:rows});
const safeId=/^(?:[1-9][0-9]{0,19}|-[1-9][0-9]{0,18})$/u;
const capabilities=new Set<Capability>([
 'ai.ask','ai.settings.manage','content.publish','content.upload','chat.manage',
 'education.navigate','owner.dashboard','subscription.verify','support.use'
]);
const PAGE_SIZE=8;
const sortGrants=(a:Grant,b:Grant)=>a.actor.localeCompare(b.actor)||
 a.chatId.localeCompare(b.chatId)||a.capability.localeCompare(b.capability)||
 a.expiresAt-b.expiresAt;
const validGrant=(g:Grant):boolean=>safeId.test(g.actor)&&!g.actor.startsWith('-')&&
 safeId.test(g.chatId)&&safeId.test(g.grantedBy)&&!g.grantedBy.startsWith('-')&&
 capabilities.has(g.capability)&&Number.isSafeInteger(g.expiresAt)&&g.expiresAt>=0&&
 typeof g.revoked==='boolean';
function localStatus(g:Grant,s:BotState,now:number):string {
 if(g.revoked)return 'ملغى';
 if(g.expiresAt<=now)return 'منتهي';
 if(g.chatId.startsWith('-')&&!s.chats.some(x=>x.id===g.chatId&&x.approved))
  return 'مجموعة غير معتمدة';
 return 'ساري زمنيًا';
}
const digest=(g:Grant,status:string):string=>
 createHash('sha256').update('MANARATAK:OWNER:DELEGATION:V1:').update(JSON.stringify([
  g.actor,g.capability,g.chatId,g.expiresAt,g.grantedBy,g.revoked,status,g.chatPolicyVersion??null,g.grantId??null
 ])).digest('hex').slice(0,12);
const allGrants=(s:BotState)=>s.grants.filter(validGrant).sort(sortGrants);
export function selectedOwnerDelegation(s:BotState,now:number,route:Extract<OwnerInlineDelegationRoute,{kind:'detail'}>):Grant|null{
 const all=allGrants(s),grant=all[route.page*PAGE_SIZE+route.ordinal-1];
 if(!grant||route.ordinal>Math.min(PAGE_SIZE,all.length-route.page*PAGE_SIZE)||digest(grant,localStatus(grant,s,now))!==route.digest)return null;
 return grant;
}
function listScreen(s:BotState,now:number,page:number):OwnerInlineScreen|null {
 const all=allGrants(s),pages=Math.ceil(all.length/PAGE_SIZE);
 if(page>(pages?pages-1:0))return null;
 const shown=all.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
 const rows:{text:string;callback_data:string}[][]=[];
 for(let i=0;i<shown.length;i+=2){
  rows.push(shown.slice(i,i+2).map((grant,offset)=>{
   const status=localStatus(grant,s,now);
   const data='mi:1:d:i:'+page+':'+(i+offset+1)+':'+digest(grant,status);
   return b('👤 '+grant.actor+' · '+(status==='ملغى'?'ملغى':status==='منتهي'?'منتهي':'محفوظ'),data);
  }));
 }
 const nav=[] as {text:string;callback_data:string}[];
 if(page>0)nav.push(b('⬅️ السابق','mi:1:d:p:'+(page-1)));
 if(page+1<pages)nav.push(b('➡️ التالي','mi:1:d:p:'+(page+1)));
 if(nav.length)rows.push(nav);
 rows.push([b('➕ إنشاء تفويض داخلي','od:1:g:0')]);
 rows.push([b('↩️ قسم المشرفين','mi:1:s:03:0'),b('🏠 لوحة المالك','mi:1:h')]);
 const tally={current:0,expired:0,revoked:0,unapproved:0};
 for(const g of all){
  const state=localStatus(g,s,now);
  if(state==='ساري زمنيًا')tally.current++;
  else if(state==='منتهي')tally.expired++;
  else if(state==='ملغى')tally.revoked++;
  else tally.unapproved++;
 }
 return {
  text:'<b>التفويضات الداخلية المحفوظة 👑</b>\n'
   +'الإجمالي: '+all.length+' · السارية زمنيًا: '+tally.current+' · المنتهية: '+tally.expired+
    ' · الملغاة: '+tally.revoked+' · مجموعات غير معتمدة: '+tally.unapproved+'\n'
   +(pages?'صفحة '+(page+1)+' من '+pages+'\n':'لا توجد تفويضات داخلية محفوظة.\n')
   +'هذه قائمة قدرات داخل منارتك فقط. لا تثبت صلاحيات Telegram ولا عضوية المشرفين الحية.\n'
   +'يمكن إنشاء تفويض محلي للمجموعة أو سحبه بعد مراجعة وتأكيد.',
  keyboard:keyboard(rows)
 };
}
function detailScreen(s:BotState,now:number,route:Extract<OwnerInlineDelegationRoute,{kind:'detail'}>,policy:Policy):OwnerInlineScreen|null {
 const grant=selectedOwnerDelegation(s,now,route);if(!grant)return null;
 const status=localStatus(grant,s,now);
 const matchingChats=s.chats.filter(c=>c.id===grant.chatId),canReview=status==='ساري زمنيًا'&&matchingChats.length===1&&matchingChats[0]!.approved&&grant.chatPolicyVersion===matchingChats[0]!.version&&policy.has(s,grant.actor,grant.capability,grant.chatId,now);
 return {text:'<b>تفاصيل التفويض الداخلي 👑</b>\n'
  +'معرف المفوض: <code>'+esc(grant.actor)+'</code>\n'
  +'القدرة المحلية: <code>'+esc(grant.capability)+'</code>\n'
  +'النطاق: <code>'+esc(grant.chatId)+'</code>\n'
  +'المانح المحفوظ: <code>'+esc(grant.grantedBy)+'</code>\n'
  +'الحالة: '+status+'\n'
  +'انتهاء الصلاحية (Unix ms): <code>'+grant.expiresAt+'</code>\n'
  +'لا تمثل هذه السجلات صلاحيات Telegram الفعلية، ولا تسمح برفع الصلاحيات.',
  keyboard:keyboard([...(canReview&&grant.chatId.startsWith('-')?[[b('🔴 مراجعة سحب التفويض','od:1:r:'+route.page+':'+route.ordinal+':'+route.digest)]]:[]),[b('↩️ صفحة التفويضات','mi:1:d:p:'+route.page),
   b('🏠 لوحة المالك','mi:1:h')]])};
}
export async function renderOwnerInlineDelegations(store:BotStore,policy:Policy,
 actorId:string,data:string,now:number):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actorId)||!Number.isSafeInteger(now)||now<0)return null;
 const route=data==='mi:1:i:03:01'?{kind:'list' as const,page:0}:
  parseOwnerInlineDelegationRoute(data);
 if(!route)return null;
 const state=await store.snapshot();
 if(!policy.isOwner(actorId)||!policy.privateFeature(state,'owner.dashboard',actorId))return null;
 return route.kind==='list'?listScreen(state,now,route.page):detailScreen(state,now,route,policy);
}
