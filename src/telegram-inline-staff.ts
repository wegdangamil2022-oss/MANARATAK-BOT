import type {BotStore,Chat,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {groupModerationOperations,moderationAuditDigest,moderationAuditKey,renderStaffModerationAudit} from './telegram-moderation-audit.js';

/** Read-only staff view over locally approved groups, not Telegram's actual
 * administrator roster or permissions. Routes are selectors, never grants.
 * The caller must prove private chat identity independently on every tap.
 */
export type StaffInlineRoute={kind:'list';page:number}|
 {kind:'detail';chatId:string;version:number;page:number}|
 {kind:'operations';chatId:string;version:number;page:number;operationPage:number;digest:string};
export interface StaffInlineScreen {readonly text:string;readonly keyboard:TelegramInlineKeyboard;}
const pageToken='(0|[1-9][0-9]{0,2})';
const listRe=new RegExp('^ms:1:p:'+pageToken+'$','u');
const detailRe=new RegExp('^ms:1:g:(-[1-9][0-9]{0,18}):([1-9][0-9]{0,9}):'+pageToken+'
export function staffInlineRoute(data:string):StaffInlineRoute|null{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 if(data==='ms:1:h')return {kind:'list',page:0};
 const l=listRe.exec(data);
 if(l&&l[0]===data)return {kind:'list',page:Number(l[1])};
 const m=detailRe.exec(data);
 if(m&&m[0]===data)return {kind:'detail',chatId:m[1]!,version:Number(m[2]),page:Number(m[3])};
 const o=operationsRe.exec(data);
 if(o&&o[0]===data)return {kind:'operations',chatId:o[1]!,version:Number(o[2]),
  page:Number(o[3]),operationPage:Number(o[4]),digest:o[5]!};
 return null;
}
const safe=(v:string):string=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
type Button={readonly text:string;readonly callback_data:string};
const btn=(text:string,callback_data:string):Button=>({text,callback_data});
const menu=(text:string,rows:readonly (readonly Button[])[]):StaffInlineScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
const pageKey=(page:number):string=>'ms:1:p:'+page;
const itemKey=(c:Chat,page:number):string=>
 'ms:1:g:'+c.id+':'+c.version+':'+page;
const PAGE_SIZE=8;
/** An internal delegation is NOT a Telegram admin entitlement.
 * In addition to the unexpired non-revoked chat.manage grant, the group must
 * currently be locally approved for 'moderation'. An owner gets ordinary
 * owner policy privilege but still only sees approved moderation groups.
 */
function visibleGroups(state:BotState,policy:Policy,actor:string,now:number):Chat[]{
 return [...state.chats].filter(c=>c.approved&&c.scopes.includes('moderation')&&
  /^-[1-9][0-9]{0,18}$/u.test(c.id)&&Number.isSafeInteger(c.version)&&
  c.version>=1&&c.version<=9_999_999_999&&
  policy.has(state,actor,'chat.manage',c.id,now))
  .sort((a,b)=>a.id.localeCompare(b.id));
}
export async function renderStaffInline(store:BotStore,policy:Policy,actor:string,
 data:string,now:number):Promise<StaffInlineScreen|null>{
 const route=data==='staff:open'?{kind:'list' as const,page:0}:staffInlineRoute(data);
 if(!route||!(/^[1-9][0-9]{0,19}$/u.test(actor))||
  !Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)return null;
 const state=await store.snapshot();
 const all=visibleGroups(state,policy,actor,now);
 if(all.length===0)return null; // no empty admin area for undelegated users
 const pages=Math.ceil(all.length/PAGE_SIZE);
 if(route.page>=pages)return null;
 if(route.kind==='list'){
  const current=all.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE);
  const rows:Button[][]=[];
  for(let i=0;i<current.length;i+=2)
   rows.push(current.slice(i,i+2).map(c=>btn('🛡️ '+c.id,itemKey(c,route.page))));
  const nav:Button[]=[];
  if(route.page>0)nav.push(btn('⬅️ السابق',pageKey(route.page-1)));
  if(route.page+1<pages)nav.push(btn('➡️ التالي',pageKey(route.page+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🏠 مجموعاتي الإشرافية','ms:1:h')]);
  return menu('<b>لوحة المشرف — مجموعات منارتك 🛡️</b>\n'
    +'المجموعات المخولة محليًا: '+all.length+'\n'
    +'الصفحة '+(route.page+1)+' من '+pages+'\n'
    +'هذه تفويضات داخل منارتك فقط. لا تثبت حقوق Telegram الحية '
    +'ولا تُنفّذ من هنا عمليات كتم أو حظر أو حذف.',rows);
 }
 const chat=all.find(c=>c.id===route.chatId);
 if(!chat||chat.version!==route.version||
    !all.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE).some(c=>c.id===chat.id))
  return null;
 const warnings=state.warnings.filter(w=>w.chatId===chat.id&&w.active).length;
 const moderation=state.moderationReasons.filter(m=>m.chatId===chat.id&&m.active).length;
 // No student IDs, complaints, media content or private subscription channels
 // are included: aggregate counts only for an authorized staff member.
 return menu('<b>بطاقة إشراف محلية 🛡️</b>\n'
  +'المجموعة: <code>'+safe(chat.id)+'</code>\n'
  +'التفويض: chat.manage (ساري محليًا)\n'
  +'نطاق الحماية: moderation\n'
  +'إصدار السياسة: '+chat.version+'\n'
  +'تحذيرات نشطة محفوظة: '+warnings+'\n'
  +'أسباب تقييد نشطة محفوظة: '+moderation+'\n'
  +'الأرقام محلية وليست حالة Telegram الحية.\n'
  +'لا يمكن تنفيذ العقوبات أو تغيير الأذونات من هذه الشاشة.',
  [[btn('↩️ مجموعات الصفحة',pageKey(route.page)),btn('🏠 الرئيسية','ms:1:h')]]);
}
,'u');
const operationsRe=new RegExp('^ms:1:o:(-[1-9][0-9]{0,18}):([1-9][0-9]{0,9}):'+pageToken+':'+pageToken+':([a-f0-9]{12})
export function staffInlineRoute(data:string):StaffInlineRoute|null{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 if(data==='ms:1:h')return {kind:'list',page:0};
 const l=listRe.exec(data);
 if(l&&l[0]===data)return {kind:'list',page:Number(l[1])};
 const m=detailRe.exec(data);
 if(!m||m[0]!==data)return null;
 return {kind:'detail',chatId:m[1]!,version:Number(m[2]),page:Number(m[3])};
}
const safe=(v:string):string=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
type Button={readonly text:string;readonly callback_data:string};
const btn=(text:string,callback_data:string):Button=>({text,callback_data});
const menu=(text:string,rows:readonly (readonly Button[])[]):StaffInlineScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
const pageKey=(page:number):string=>'ms:1:p:'+page;
const itemKey=(c:Chat,page:number):string=>
 'ms:1:g:'+c.id+':'+c.version+':'+page;
const PAGE_SIZE=8;
/** An internal delegation is NOT a Telegram admin entitlement.
 * In addition to the unexpired non-revoked chat.manage grant, the group must
 * currently be locally approved for 'moderation'. An owner gets ordinary
 * owner policy privilege but still only sees approved moderation groups.
 */
function visibleGroups(state:BotState,policy:Policy,actor:string,now:number):Chat[]{
 return [...state.chats].filter(c=>c.approved&&c.scopes.includes('moderation')&&
  /^-[1-9][0-9]{0,18}$/u.test(c.id)&&Number.isSafeInteger(c.version)&&
  c.version>=1&&c.version<=9_999_999_999&&
  policy.has(state,actor,'chat.manage',c.id,now))
  .sort((a,b)=>a.id.localeCompare(b.id));
}
export async function renderStaffInline(store:BotStore,policy:Policy,actor:string,
 data:string,now:number):Promise<StaffInlineScreen|null>{
 const route=data==='staff:open'?{kind:'list' as const,page:0}:staffInlineRoute(data);
 if(!route||!(/^[1-9][0-9]{0,19}$/u.test(actor))||
  !Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)return null;
 const state=await store.snapshot();
 const all=visibleGroups(state,policy,actor,now);
 if(all.length===0)return null; // no empty admin area for undelegated users
 const pages=Math.ceil(all.length/PAGE_SIZE);
 if(route.page>=pages)return null;
 if(route.kind==='list'){
  const current=all.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE);
  const rows:Button[][]=[];
  for(let i=0;i<current.length;i+=2)
   rows.push(current.slice(i,i+2).map(c=>btn('🛡️ '+c.id,itemKey(c,route.page))));
  const nav:Button[]=[];
  if(route.page>0)nav.push(btn('⬅️ السابق',pageKey(route.page-1)));
  if(route.page+1<pages)nav.push(btn('➡️ التالي',pageKey(route.page+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🏠 مجموعاتي الإشرافية','ms:1:h')]);
  return menu('<b>لوحة المشرف — مجموعات منارتك 🛡️</b>\n'
    +'المجموعات المخولة محليًا: '+all.length+'\n'
    +'الصفحة '+(route.page+1)+' من '+pages+'\n'
    +'هذه تفويضات داخل منارتك فقط. لا تثبت حقوق Telegram الحية '
    +'ولا تُنفّذ من هنا عمليات كتم أو حظر أو حذف.',rows);
 }
 const chat=all.find(c=>c.id===route.chatId);
 if(!chat||chat.version!==route.version||
    !all.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE).some(c=>c.id===chat.id))
  return null;
 const warnings=state.warnings.filter(w=>w.chatId===chat.id&&w.active).length;
 const moderation=state.moderationReasons.filter(m=>m.chatId===chat.id&&m.active).length;
 // No student IDs, complaints, media content or private subscription channels
 // are included: aggregate counts only for an authorized staff member.
 return menu('<b>بطاقة إشراف محلية 🛡️</b>\n'
  +'المجموعة: <code>'+safe(chat.id)+'</code>\n'
  +'التفويض: chat.manage (ساري محليًا)\n'
  +'نطاق الحماية: moderation\n'
  +'إصدار السياسة: '+chat.version+'\n'
  +'تحذيرات نشطة محفوظة: '+warnings+'\n'
  +'أسباب تقييد نشطة محفوظة: '+moderation+'\n'
  +'الأرقام محلية وليست حالة Telegram الحية.\n'
  +'لا يمكن تنفيذ العقوبات أو تغيير الأذونات من هذه الشاشة.',
  [[btn('↩️ مجموعات الصفحة',pageKey(route.page)),btn('🏠 الرئيسية','ms:1:h')]]);
}
,'u');
export function staffInlineRoute(data:string):StaffInlineRoute|null{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 if(data==='ms:1:h')return {kind:'list',page:0};
 const l=listRe.exec(data);
 if(l&&l[0]===data)return {kind:'list',page:Number(l[1])};
 const m=detailRe.exec(data);
 if(!m||m[0]!==data)return null;
 return {kind:'detail',chatId:m[1]!,version:Number(m[2]),page:Number(m[3])};
}
const safe=(v:string):string=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
type Button={readonly text:string;readonly callback_data:string};
const btn=(text:string,callback_data:string):Button=>({text,callback_data});
const menu=(text:string,rows:readonly (readonly Button[])[]):StaffInlineScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
const pageKey=(page:number):string=>'ms:1:p:'+page;
const itemKey=(c:Chat,page:number):string=>
 'ms:1:g:'+c.id+':'+c.version+':'+page;
const PAGE_SIZE=8;
/** An internal delegation is NOT a Telegram admin entitlement.
 * In addition to the unexpired non-revoked chat.manage grant, the group must
 * currently be locally approved for 'moderation'. An owner gets ordinary
 * owner policy privilege but still only sees approved moderation groups.
 */
function visibleGroups(state:BotState,policy:Policy,actor:string,now:number):Chat[]{
 return [...state.chats].filter(c=>c.approved&&c.scopes.includes('moderation')&&
  /^-[1-9][0-9]{0,18}$/u.test(c.id)&&Number.isSafeInteger(c.version)&&
  c.version>=1&&c.version<=9_999_999_999&&
  policy.has(state,actor,'chat.manage',c.id,now))
  .sort((a,b)=>a.id.localeCompare(b.id));
}
export async function renderStaffInline(store:BotStore,policy:Policy,actor:string,
 data:string,now:number):Promise<StaffInlineScreen|null>{
 const route=data==='staff:open'?{kind:'list' as const,page:0}:staffInlineRoute(data);
 if(!route||!(/^[1-9][0-9]{0,19}$/u.test(actor))||
  !Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)return null;
 const state=await store.snapshot();
 const all=visibleGroups(state,policy,actor,now);
 if(all.length===0)return null; // no empty admin area for undelegated users
 const pages=Math.ceil(all.length/PAGE_SIZE);
 if(route.page>=pages)return null;
 if(route.kind==='list'){
  const current=all.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE);
  const rows:Button[][]=[];
  for(let i=0;i<current.length;i+=2)
   rows.push(current.slice(i,i+2).map(c=>btn('🛡️ '+c.id,itemKey(c,route.page))));
  const nav:Button[]=[];
  if(route.page>0)nav.push(btn('⬅️ السابق',pageKey(route.page-1)));
  if(route.page+1<pages)nav.push(btn('➡️ التالي',pageKey(route.page+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🏠 مجموعاتي الإشرافية','ms:1:h')]);
  return menu('<b>لوحة المشرف — مجموعات منارتك 🛡️</b>\n'
    +'المجموعات المخولة محليًا: '+all.length+'\n'
    +'الصفحة '+(route.page+1)+' من '+pages+'\n'
    +'هذه تفويضات داخل منارتك فقط. لا تثبت حقوق Telegram الحية '
    +'ولا تُنفّذ من هنا عمليات كتم أو حظر أو حذف.',rows);
 }
 const chat=all.find(c=>c.id===route.chatId);
 if(!chat||chat.version!==route.version||
    !all.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE).some(c=>c.id===chat.id))
  return null;
 const warnings=state.warnings.filter(w=>w.chatId===chat.id&&w.active).length;
 const moderation=state.moderationReasons.filter(m=>m.chatId===chat.id&&m.active).length;
 // No student IDs, complaints, media content or private subscription channels
 // are included: aggregate counts only for an authorized staff member.
 return menu('<b>بطاقة إشراف محلية 🛡️</b>\n'
  +'المجموعة: <code>'+safe(chat.id)+'</code>\n'
  +'التفويض: chat.manage (ساري محليًا)\n'
  +'نطاق الحماية: moderation\n'
  +'إصدار السياسة: '+chat.version+'\n'
  +'تحذيرات نشطة محفوظة: '+warnings+'\n'
  +'أسباب تقييد نشطة محفوظة: '+moderation+'\n'
  +'الأرقام محلية وليست حالة Telegram الحية.\n'
  +'لا يمكن تنفيذ العقوبات أو تغيير الأذونات من هذه الشاشة.',
  [[btn('↩️ مجموعات الصفحة',pageKey(route.page)),btn('🏠 الرئيسية','ms:1:h')]]);
}
