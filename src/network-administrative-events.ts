import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';
import {validNetworkWatchCases} from './network-watchlist-model.js';
import {validNetworkEmergencyControls} from './network-emergency-stop.js';
import {validNetworkSanctionReviews,validNetworkSanctionReviewReferences} from './network-sanction-review-model.js';

/** NETWORK-006: an intentionally read-only, per-network administrative event
 * projection. This is NOT a notification outbox or a moderation permission.
 * No subject identities, reports, rule texts or Telegram content are exposed. */
export interface NetworkAdministrativeEvent {
 id:string;
 kind:'WATCH_CASE'|'SANCTION_REVIEW'|'EMERGENCY';
 at:number;
 chatId?:string;
 label:string;
}
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000;
export function networkAdministrativeEvents(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string
):NetworkAdministrativeEvent[]|null{
 if(!policy.isOwner(actor)||!policy.privateFeature(s,'owner.dashboard',actor)||
  !validTime(now)||typeof networkId!=='string'||!/^[a-f0-9]{12}$/u.test(networkId)||
  !validNetworkWatchCases(s.networkWatchCases??[])||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  !validNetworkSanctionReviews(s.networkSanctionReviews??[])||
  !validNetworkSanctionReviewReferences(s.networkSanctionReviews??[],s.networkWatchCases??[]))return null;
 const matches=(s.groupNetworks??[]).filter(n=>n.id===networkId);
 const network=matches[0];
 if(matches.length!==1||!network||!validGroupNetwork(network)||network.updatedAt>now)return null;
 const allowed=new Set(network.members.filter(member=>{
  const chats=s.chats.filter(c=>c.id===member.chatId);
  return chats.length===1&&chats[0]!.approved&&chats[0]!.version===member.version&&
   chats[0]!.scopes.includes('moderation')&&
   policy.has(s,actor,'chat.manage',member.chatId,now);
 }).map(x=>x.chatId));
 const result:NetworkAdministrativeEvent[]=[];
 for(const c of s.networkWatchCases??[]){
  if(c.networkId!==networkId||!allowed.has(c.sourceChatId)||c.submittedAt>now||
   !network.members.some(m=>m.chatId===c.sourceChatId&&m.version===c.sourceChatVersion))continue;
  const labels={PENDING:'بلاغ ينتظر المراجعة',WATCHED:'بلاغ تمت مراجعته',DISMISSED:'بلاغ مرفوض',CLEARED:'بلاغ أُغلق'};
  result.push({id:'w:'+c.id,kind:'WATCH_CASE',at:c.reviewedAt??c.submittedAt,
   chatId:c.sourceChatId,label:labels[c.status]});
 }
 for(const c of s.networkSanctionReviews??[]){
  if(c.networkId!==networkId||!allowed.has(c.sourceChatId)||
   !allowed.has(c.targetChatId)||c.requestedAt>now||
   !network.members.some(m=>m.chatId===c.sourceChatId&&m.version===c.sourceChatVersion)||
   !network.members.some(m=>m.chatId===c.targetChatId&&m.version===c.targetChatVersion))continue;
  const labels={PENDING:'مقترح إجراء ينتظر المراجعة',REVIEWED_ONLY:'مقترح تمت مراجعته دون تنفيذ',REJECTED:'مقترح مرفوض',CLOSED:'مقترح مغلق'};
  result.push({id:'r:'+c.id,kind:'SANCTION_REVIEW',at:c.reviewedAt??c.requestedAt,
   chatId:c.targetChatId,label:labels[c.status]});
 }
 for(const c of s.networkEmergencyControls??[]){
  if(c.networkId!==networkId||c.changedAt>now)continue;
  result.push({id:'e:'+c.networkId+':'+c.revision,kind:'EMERGENCY',at:c.changedAt,
   label:c.status==='STOPPED'?'إيقاف طوارئ الشبكة':'رفع إيقاف طوارئ الشبكة'});
 }
 return result.filter(e=>validTime(e.at)&&e.at<=now)
  .sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)).slice(0,200);
}
