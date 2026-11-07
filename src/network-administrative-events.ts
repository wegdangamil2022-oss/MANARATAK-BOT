import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';
import {validNetworkWatchCases} from './network-watchlist-model.js';
import {validNetworkEmergencyControls} from './network-emergency-stop.js';
import {validNetworkSanctionReviews,validNetworkSanctionReviewReferences} from './network-sanction-review-model.js';
import {isValidNetworkPolicySnapshots} from './network-policy-snapshots.js';
import {networkGroupCopyHistory} from './network-group-copy-history.js';
import {networkSelectedFollowHistory} from './network-selected-follow-history.js';

/** NETWORK-006 read-only owner events. Never a moderation grant or outbox.
 * No subject identities, rule text, report detail or stored snapshot policy is rendered. */
export type NetworkAdministrativeEventKind =
 'WATCH_CASE'|'SANCTION_REVIEW'|'EMERGENCY'|'SNAPSHOT'|'SETTINGS_COPY'|'POLICY_FOLLOW';
export interface NetworkAdministrativeEvent {
 id:string;kind:NetworkAdministrativeEventKind;at:number;
 chatId?:string;label:string;
}
export interface NetworkAdministrativeEventFilter {
 kind?:NetworkAdministrativeEventKind;
 /** Require a *currently* approved and manageable network group. */
 chatId?:string;
}
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000;
const kinds:readonly NetworkAdministrativeEventKind[]=[
 'WATCH_CASE','SANCTION_REVIEW','EMERGENCY','SNAPSHOT','SETTINGS_COPY','POLICY_FOLLOW'
];
/** Filters precede the bounded 200-event projection so older selected-type
 * events cannot disappear behind unselected events. */
export function networkAdministrativeEvents(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string,
 filter:NetworkAdministrativeEventFilter={}
):NetworkAdministrativeEvent[]|null{
 if(!policy.isOwner(actor)||!policy.privateFeature(s,'owner.dashboard',actor)||
  !validTime(now)||typeof networkId!=='string'||!/^[a-f0-9]{12}$/u.test(networkId)||
  !filter||typeof filter!=='object'||Array.isArray(filter)||
  Object.keys(filter).some(k=>k!=='kind'&&k!=='chatId')||
  (filter.kind!==undefined&&!kinds.includes(filter.kind))||
  (filter.chatId!==undefined&&(typeof filter.chatId!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(filter.chatId)||
   !Number.isSafeInteger(Number(filter.chatId))))||
  !validNetworkWatchCases(s.networkWatchCases??[])||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  !validNetworkSanctionReviews(s.networkSanctionReviews??[])||
  !validNetworkSanctionReviewReferences(s.networkSanctionReviews??[],s.networkWatchCases??[])||
  !isValidNetworkPolicySnapshots(s.networkPolicySnapshots??[]))return null;
 const matches=(s.groupNetworks??[]).filter(n=>n.id===networkId);
 const network=matches[0];
 if(matches.length!==1||!network||!validGroupNetwork(network)||network.updatedAt>now)return null;
 const allowed=new Set(network.members.filter(member=>{
  const chats=s.chats.filter(c=>c.id===member.chatId);
  return chats.length===1&&chats[0]!.approved&&chats[0]!.version===member.version&&
   chats[0]!.scopes.includes('moderation')&&
   policy.has(s,actor,'chat.manage',member.chatId,now);
 }).map(x=>x.chatId));
 if(filter.chatId!==undefined&&!allowed.has(filter.chatId))return null;
 const target=(kind:NetworkAdministrativeEventKind,chatId?:string)=>
  (filter.kind===undefined||filter.kind===kind)&&
  (filter.chatId===undefined||filter.chatId===chatId);
 const result:NetworkAdministrativeEvent[]=[];
 if(filter.kind===undefined||filter.kind==='WATCH_CASE')
 for(const c of s.networkWatchCases??[]){
  if(c.networkId!==networkId||!allowed.has(c.sourceChatId)||c.submittedAt>now||
   !network.members.some(m=>m.chatId===c.sourceChatId&&m.version===c.sourceChatVersion)||
   !target('WATCH_CASE',c.sourceChatId))continue;
  const labels={PENDING:'بلاغ ينتظر المراجعة',WATCHED:'بلاغ تمت مراجعته',
   DISMISSED:'بلاغ مرفوض',CLEARED:'بلاغ أُغلق'};
  result.push({id:'w:'+c.id,kind:'WATCH_CASE',at:c.clearedAt??c.reviewedAt??c.submittedAt,
   chatId:c.sourceChatId,label:labels[c.status]});
 }
 if(filter.kind===undefined||filter.kind==='SANCTION_REVIEW')
 for(const c of s.networkSanctionReviews??[]){
  if(c.networkId!==networkId||!allowed.has(c.sourceChatId)||
   !allowed.has(c.targetChatId)||c.requestedAt>now||
   !network.members.some(m=>m.chatId===c.sourceChatId&&m.version===c.sourceChatVersion)||
   !network.members.some(m=>m.chatId===c.targetChatId&&m.version===c.targetChatVersion)||
   !target('SANCTION_REVIEW',c.targetChatId))continue;
  const labels={PENDING:'مقترح إجراء ينتظر المراجعة',
   REVIEWED_ONLY:'مقترح تمت مراجعته دون تنفيذ',
   REJECTED:'مقترح مرفوض',CLOSED:'مقترح مغلق'};
  result.push({id:'r:'+c.id,kind:'SANCTION_REVIEW',at:c.closedAt??c.reviewedAt??c.requestedAt,
   chatId:c.targetChatId,label:labels[c.status]});
 }
 if(target('EMERGENCY'))
 for(const c of s.networkEmergencyControls??[]){
  if(c.networkId!==networkId||c.changedAt>now)continue;
  result.push({id:'e:'+c.networkId+':'+c.revision,kind:'EMERGENCY',at:c.changedAt,
   label:c.status==='STOPPED'?'إيقاف طوارئ الشبكة':'رفع إيقاف طوارئ الشبكة'});
 }
 if(filter.kind===undefined||filter.kind==='SNAPSHOT')
 for(const c of s.networkPolicySnapshots??[]){
  if(c.networkId!==networkId||!allowed.has(c.chatId)||c.capturedAt>now||
   c.networkRevision>network.revision||
   !network.members.some(m=>m.chatId===c.chatId&&m.version===c.chatVersion)||
   !target('SNAPSHOT',c.chatId))continue;
  result.push({id:'s:'+c.id,kind:'SNAPSHOT',at:c.capturedAt,
   chatId:c.chatId,label:'نسخة سياسة محفوظة'});
 }
 if(filter.kind===undefined||filter.kind==='SETTINGS_COPY'){
  // Confirmed local copy receipts only. A log line is not proof by itself;
  // keep the target and source inside the current authorized network.
  const copy=networkGroupCopyHistory(s,policy,actor,networkId,now);
  if(copy===null)return null;
  for(const row of copy){
   if(!allowed.has(row.sourceId)||!allowed.has(row.targetId)||
    !target('SETTINGS_COPY',row.targetId))continue;
   result.push({id:'c:'+row.nonce,kind:'SETTINGS_COPY',at:row.at,
    chatId:row.targetId,label:'نسخ إعدادات حماية محلية بعد موافقة المالك'});
  }
 }
 if(filter.kind===undefined||filter.kind==='POLICY_FOLLOW'){
  const follows=networkSelectedFollowHistory(s,policy,actor,networkId,now);
  if(follows===null)return null;
  for(const row of follows){
   // Never reveal a decision for a group no longer managed by this owner
   // or outside the currently approved network membership.
   if(!allowed.has(row.sourceId)||!allowed.has(row.targetId)||
    !network.members.some(m=>m.chatId===row.targetId&&m.version===row.targetVersion)||
    !target('POLICY_FOLLOW',row.targetId))continue;
   result.push({id:'f:'+row.nonce,kind:'POLICY_FOLLOW',at:row.at,
    chatId:row.targetId,label:'اختيار متابعة سياسة مراقبة بعد موافقة المالك'});
  }
 }
 return result.filter(e=>validTime(e.at)&&e.at<=now)
  .sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)).slice(0,200);
}
