import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {validGroupNetwork} from './group-network-model.js';
import {validNetworkWatchCases} from './network-watchlist-model.js';
import {validNetworkSanctionReviews,validNetworkSanctionReviewReferences}
 from './network-sanction-review-model.js';

/** NETWORK-003: owner-only administrative backlog, never a ban/mute queue.
 * No member IDs, allegation text or Telegram API calls leave this renderer. */
const net='([a-f0-9]{12})',page='(0|[1-9][0-9]{0,2})',
 group='(-[1-9][0-9]{0,15})';
const HOME=new RegExp('^nw:1:iq:'+net+':'+page+'$','u');
const DETAIL=new RegExp('^nw:1:ig:'+net+':'+group+'$','u');
const SIZE=8;
const time=(t:number)=>Number.isSafeInteger(t)&&t>=0&&t<=8_640_000_000_000_000;
const validGroupId=(s:unknown):s is string=>typeof s==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
export interface NetworkReviewGroupCounts{
 chatId:string;watchPending:number;watchWatched:number;watchClosed:number;
 sanctionsPending:number;sanctionsReviewed:number;sanctionsClosed:number;
}
export interface NetworkReviewOverview{
 networkId:string;networkName:string;groups:NetworkReviewGroupCounts[];
 watchPending:number;watchWatched:number;watchClosed:number;
 sanctionsPending:number;sanctionsReviewed:number;sanctionsClosed:number;
}
/** All status counters are limited to the currently approved group revisions.
 * Source and destination must both be authorized: network membership alone
 * never grants an administrator visibility into third-party cases.
 */
export function networkReviewOverview(s:BotState,policy:Policy,actor:string,
 id:string,now:number):NetworkReviewOverview|null{
 if(!time(now)||!policy.isOwner(actor)||
  !policy.privateFeature(s,'owner.dashboard',actor)||
  !/^[a-f0-9]{12}$/u.test(id)||
  !validNetworkWatchCases(s.networkWatchCases??[])||
  !validNetworkSanctionReviews(s.networkSanctionReviews??[])||
  !validNetworkSanctionReviewReferences(
   s.networkSanctionReviews??[],s.networkWatchCases??[]))return null;
 const networks=(s.groupNetworks??[]).filter(x=>x.id===id),n=networks[0];
 if(networks.length!==1||!n||!validGroupNetwork(n)||n.updatedAt>now)return null;
 const approved=new Map<string,number>();
 for(const member of n.members){
  if(!validGroupId(member.chatId))return null;
  const chats=s.chats.filter(x=>x.id===member.chatId),chat=chats[0];
  if(chats.length!==1||!chat||!chat.approved||chat.version!==member.version||
   !chat.scopes.includes('moderation')||
   !policy.canUseChat(s,chat.id,'moderation')||
   !policy.has(s,actor,'chat.manage',chat.id,now))continue;
  approved.set(chat.id,chat.version);
 }
 const groups:NetworkReviewGroupCounts[]=[...approved.keys()]
  .sort((a,b)=>a.localeCompare(b)).map(chatId=>({
   chatId,watchPending:0,watchWatched:0,watchClosed:0,
   sanctionsPending:0,sanctionsReviewed:0,sanctionsClosed:0
  }));
 const mapped=new Map<string,NetworkReviewGroupCounts>(groups.map(x=>[x.chatId,x]));
 for(const c of s.networkWatchCases??[]){
  const target=mapped.get(c.sourceChatId);
  if(!target||c.networkId!==id||c.sourceChatVersion!==approved.get(c.sourceChatId)||
   c.submittedAt>now||
   (c.reviewedAt!==undefined&&c.reviewedAt>now)||
   (c.clearedAt!==undefined&&c.clearedAt>now))continue;
  if(c.status==='PENDING')target.watchPending++;
  else if(c.status==='WATCHED')target.watchWatched++;
  else target.watchClosed++;
 }
 for(const row of s.networkSanctionReviews??[]){
  const target=mapped.get(row.targetChatId);
  if(!target||row.networkId!==id||
   row.targetChatVersion!==approved.get(row.targetChatId)||
   row.sourceChatVersion!==approved.get(row.sourceChatId)||
   row.requestedAt>now||
   (row.reviewedAt!==undefined&&row.reviewedAt>now)||
   (row.closedAt!==undefined&&row.closedAt>now))continue;
  if(row.status==='PENDING')target.sanctionsPending++;
  else if(row.status==='REVIEWED_ONLY')target.sanctionsReviewed++;
  else target.sanctionsClosed++;
 }
 return {networkId:id,networkName:n.name,groups,
  watchPending:groups.reduce((t,x)=>t+x.watchPending,0),
  watchWatched:groups.reduce((t,x)=>t+x.watchWatched,0),
  watchClosed:groups.reduce((t,x)=>t+x.watchClosed,0),
  sanctionsPending:groups.reduce((t,x)=>t+x.sanctionsPending,0),
  sanctionsReviewed:groups.reduce((t,x)=>t+x.sanctionsReviewed,0),
  sanctionsClosed:groups.reduce((t,x)=>t+x.sanctionsClosed,0)
 };
}
export function validNetworkReviewInboxRoute(v:unknown):boolean{
 return typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&
  (HOME.test(v)||DETAIL.test(v));
}
export class OwnerNetworkReviewInbox{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!validNetworkReviewInboxRoute(data)||!this.policy.isOwner(actor))return null;
  const snapshot=await this.store.snapshot(),now=this.clock();
  const home=HOME.exec(data),detail=DETAIL.exec(data),id=(home??detail)?.[1];
  if(!id)return null;
  const view=networkReviewOverview(snapshot,this.policy,actor,id,now);
  if(!view)return null;
  if(detail){
   const g=view.groups.find(x=>x.chatId===detail[2]);if(!g)return null;
   return ui('<b>🧭 مراجعات مجموعة داخل الشبكة</b>\n'+
    'الشبكة: '+esc(view.networkName)+'\n'+
    'المجموعة: <code>'+g.chatId+'</code>\n'+
    'بلاغات تنتظر مراجعة بشرية: '+g.watchPending+'\n'+
    'بلاغات مراجَعة معلوماتيًا: '+g.watchWatched+'\n'+
    'بلاغات مرفوضة أو مغلقة: '+g.watchClosed+'\n'+
    'اقتراحات عقوبات تنتظر قرارًا: '+g.sanctionsPending+'\n'+
    'اقتراحات راجعها إنسان دون تنفيذ: '+g.sanctionsReviewed+'\n'+
    'اقتراحات مرفوضة أو مغلقة: '+g.sanctionsClosed+'\n'+
    'هذا عرض إجمالي لمجموعة معتمدة حاليًا، ولا يمثل ترخيصًا بعقوبة.\n'+
    'فتح البلاغات يخضع لفحص الأذونات مرة أخرى.',
    [[btn('🛡️ البلاغات المركزية','nw:1:w:'+id+':0')],
     [btn('↩️ ملخص مراجعات الشبكة','nw:1:iq:'+id+':0)],
     [btn('🌐 بطاقة الشبكة','nw:1:d:'+id)]]);
  }
  const p=Number(home![2]),pages=Math.max(1,Math.ceil(view.groups.length/SIZE));
  if(p>=pages)return null;
  const rows=view.groups.slice(p*SIZE,(p+1)*SIZE)
   .map(g=>[btn('👥 '+g.chatId+' · انتظار '+(g.watchPending+g.sanctionsPending),
    'nw:1:ig:'+id+':'+g.chatId)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:iq:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:iq:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🛡️ فتح البلاغات','nw:1:w:'+id+':0')],
   [btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]);
  return ui('<b>🧭 صندوق مراجعات الشبكة — للمالك</b>\n'+
   'الشبكة: '+esc(view.networkName)+'\n'+
   'مجموعات مخوّلة حاليًا: '+view.groups.length+
   ' · صفحة '+(p+1)+'/'+pages+'\n'+
   'بلاغات تنتظر: '+view.watchPending+
   ' · تحت متابعة معلوماتية: '+view.watchWatched+
   ' · مغلقة: '+view.watchClosed+'\n'+
   'اقتراحات إجراءات تنتظر: '+view.sanctionsPending+
   ' · روجعت دون تنفيذ: '+view.sanctionsReviewed+
   ' · مغلقة: '+view.sanctionsClosed+'\n'+
   'كل عدد يعكس الحالة الحالية لسجل مؤهل، وليس دليلًا على مخالفة.\n'+
   'لا تعرض هذه الشاشة أي هوية طالب أو نص بلاغ أو صلاحية تنفيذ.',
   rows);
 }
}
