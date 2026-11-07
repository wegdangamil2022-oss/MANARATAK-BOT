import {randomBytes} from 'node:crypto';
import type {BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import {networkWatchCaseAccessible} from './network-watchlist.js';
import {validGroupNetwork} from './group-network-model.js';
import {networkEmergencyStopped,validNetworkEmergencyControls}
 from './network-emergency-stop.js';
import {validNetworkSanctionReview,
 type NetworkSanctionReview,type NetworkSanctionKind,
 type NetworkSanctionReviewDecision} from './network-sanction-review-model.js';

const clockValid=(now:number)=>Number.isSafeInteger(now)&&now>=0&&
 now<=8_640_000_000_000_000-600_000;
const validId=(v:string)=>/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
function targetGroup(s:BotState,policy:Policy,actor:string,now:number,
 networkId:string,targetChatId:string):Chat|null{
 if(!clockValid(now)||!policy.isOwner(actor)||
  !policy.privateFeature(s,'owner.dashboard',actor)||!validId(targetChatId))return null;
 const network=(s.groupNetworks??[]).filter(n=>n.id===networkId);
 if(network.length!==1||!network[0]||!validGroupNetwork(network[0])||
  network[0].updatedAt>now)return null;
 const chatRows=s.chats.filter(c=>c.id===targetChatId),chat=chatRows[0];
 if(chatRows.length!==1||!chat||!chat.approved||chat.version<1||
  !chat.scopes.includes('moderation')||!policy.canUseChat(s,targetChatId,'moderation')||
  !policy.has(s,actor,'chat.manage',targetChatId,now)||
  network[0].members.filter(m=>m.chatId===targetChatId&&m.version===chat.version).length!==1)return null;
 return chat;
}
/** Historical recommendation detail is readable only within the still-current
 * scope of its OWN source watch case and its OWN target group. No inheritance. */
export function networkSanctionReviewAccessible(
 s:BotState,policy:Policy,actor:string,now:number,id:string
):NetworkSanctionReview|null{
 if(!/^[a-f0-9]{12}$/u.test(id))return null;
 const rows=(s.networkSanctionReviews??[]).filter(x=>x.id===id),row=rows[0];
 if(rows.length!==1||!row||!validNetworkSanctionReview(row))return null;
 const watch=networkWatchCaseAccessible(s,policy,actor,now,row.caseId);
 if(!watch||watch.status!=='WATCHED'||watch.revision!==row.caseRevision||
  watch.networkId!==row.networkId||watch.networkRevision!==row.networkRevision||
  watch.sourceChatId!==row.sourceChatId||
  watch.sourceChatVersion!==row.sourceChatVersion||
  watch.subjectId!==row.subjectId)return null;
 const target=targetGroup(s,policy,actor,now,row.networkId,row.targetChatId);
 return target?.version===row.targetChatVersion?row:null;
}
/** Only a WATCHED, independently human-reviewed case can be considered.
 * A possible BAN/MUTE is NEVER issued by this service. */
export function prepareNetworkSanctionReview(
 s:BotState,policy:Policy,actor:string,now:number,caseId:string,
 targetId:string,kind:NetworkSanctionKind
):NetworkSanctionReview|null{
 const watch=networkWatchCaseAccessible(s,policy,actor,now,caseId);
 if(!clockValid(now)||!watch||watch.status!=='WATCHED'||watch.revision!==2||
  watch.reviewedAt===undefined||now<watch.reviewedAt||
  !['MUTE','BAN'].includes(kind)||targetId===watch.sourceChatId||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  networkEmergencyStopped(s,watch.networkId)||
  (s.networkSanctionReviews??[]).length>=500)return null;
 const target=targetGroup(s,policy,actor,now,watch.networkId,targetId);
 const network=(s.groupNetworks??[]).find(n=>n.id===watch.networkId);
 if(!target||!network||network.revision!==watch.networkRevision||
  (s.networkSanctionReviews??[]).some(x=>x.caseId===watch.id&&
   x.targetChatId===targetId&&
   (x.status==='PENDING'||x.status==='REVIEWED_ONLY')))return null;
 const id=randomBytes(6).toString('hex');
 if((s.networkSanctionReviews??[]).some(x=>x.id===id))return null;
 const row:NetworkSanctionReview={id,caseId:watch.id,caseRevision:2,
  networkId:watch.networkId,networkRevision:watch.networkRevision,
  sourceChatId:watch.sourceChatId,sourceChatVersion:watch.sourceChatVersion,
  targetChatId:targetId,targetChatVersion:target.version,
  subjectId:watch.subjectId,kind,revision:1,status:'PENDING',
  requestedBy:actor,requestedAt:now};
 return validNetworkSanctionReview(row)?row:null;
}
/** Review is explicit and unique to ONE target. No sanction receipt or Telegram
 * job can be produced by this method, even after REVIEWED_ONLY. */
export function decideNetworkSanctionReview(
 s:BotState,policy:Policy,actor:string,now:number,reviewId:string,
 expectedRevision:number,decision:NetworkSanctionReviewDecision
):boolean{
 if(!clockValid(now)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[]))return false;
 const row=networkSanctionReviewAccessible(s,policy,actor,now,reviewId);
 if(!row||row.revision!==expectedRevision||now<row.requestedAt)return false;
 // During a network STOP only restrictive review clean-up (reject / close)
 // is available. REVIEWED_ONLY must not be granted by a stale callback.
 if(decision==='REVIEWED_ONLY'&&networkEmergencyStopped(s,row.networkId))
  return false;
 const next:NetworkSanctionReview={...row};
 if(next.status==='PENDING'&&(decision==='REVIEWED_ONLY'||decision==='REJECTED')){
  next.status=decision;next.revision=2;next.reviewedBy=actor;next.reviewedAt=now;
 }else if(next.status==='REVIEWED_ONLY'&&decision==='CLOSED'&&
  next.reviewedAt!==undefined&&now>=next.reviewedAt){
  next.status='CLOSED';next.revision=3;next.closedBy=actor;next.closedAt=now;
 }else return false;
 if(!validNetworkSanctionReview(next))return false;
 Object.assign(row,next);
 return true;
}
