import type {NetworkWatchCase} from './network-watchlist-model.js';

/** NETWORK-003: one target group's *human review*, not a Telegram API action.
 * REVIEWED_ONLY deliberately does not mean authorization for ban/mute. */
export type NetworkSanctionKind='MUTE'|'BAN';
export type NetworkSanctionReviewStatus='PENDING'|'REVIEWED_ONLY'|'REJECTED'|'CLOSED';
export type NetworkSanctionReviewDecision='REVIEWED_ONLY'|'REJECTED'|'CLOSED';
export interface NetworkSanctionReview{
 id:string;caseId:string;caseRevision:2;networkId:string;networkRevision:number;
 sourceChatId:string;sourceChatVersion:number;
 targetChatId:string;targetChatVersion:number;subjectId:string;
 kind:NetworkSanctionKind;revision:number;status:NetworkSanctionReviewStatus;
 requestedBy:string;requestedAt:number;reviewedBy?:string;reviewedAt?:number;
 closedBy?:string;closedAt?:number;
}
const object=(x:unknown):x is Record<string,unknown>=>
 x!==null&&typeof x==='object'&&!Array.isArray(x);
const hex=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{12}$/u.test(x);
const group=(x:unknown)=>typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.test(x)&&
 Number.isSafeInteger(Number(x));
const member=(x:unknown)=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/u.test(x)&&
 Number.isSafeInteger(Number(x));
const rev=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&
 x>=1&&x<=9_999_999_999;
const clock=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&
 x>=0&&x<=8_640_000_000_000_000;
export function validNetworkSanctionReview(x:unknown):x is NetworkSanctionReview{
 if(!object(x))return false;
 const base=['id','caseId','caseRevision','networkId','networkRevision',
  'sourceChatId','sourceChatVersion','targetChatId','targetChatVersion','subjectId',
  'kind','revision','status','requestedBy','requestedAt'];
 const reviewed=['reviewedBy','reviewedAt'],closed=['closedBy','closedAt'];
 if(Object.keys(x).some(k=>![...base,...reviewed,...closed].includes(k))||
  base.some(k=>!Object.hasOwn(x,k)))return false;
 if(!hex(x.id)||!hex(x.caseId)||x.caseRevision!==2||
  !hex(x.networkId)||!rev(x.networkRevision)||
  !group(x.sourceChatId)||!group(x.targetChatId)||
  x.sourceChatId===x.targetChatId||
  !rev(x.sourceChatVersion)||!rev(x.targetChatVersion)||
  !member(x.subjectId)||!['MUTE','BAN'].includes(String(x.kind))||
  !rev(x.revision)||!['PENDING','REVIEWED_ONLY','REJECTED','CLOSED'].includes(String(x.status))||
  !member(x.requestedBy)||!clock(x.requestedAt))return false;
 const hasReview=reviewed.every(k=>Object.hasOwn(x,k)),
  hasClose=closed.every(k=>Object.hasOwn(x,k));
 if(reviewed.some(k=>Object.hasOwn(x,k))&&!hasReview||
  closed.some(k=>Object.hasOwn(x,k))&&!hasClose)return false;
 if(x.status==='PENDING')return x.revision===1&&!hasReview&&!hasClose;
 if(x.revision!==(x.status==='CLOSED'?3:2)||
  !hasReview||!member(x.reviewedBy)||!clock(x.reviewedAt)||
  (x.reviewedAt as number)<(x.requestedAt as number))return false;
 if(x.status==='CLOSED')return hasClose&&member(x.closedBy)&&clock(x.closedAt)&&
  (x.closedAt as number)>=(x.reviewedAt as number);
 return !hasClose;
}
/** Per-network subject+target has at most one *unresolved* recommendation.
 * The decision to review BAN/MUTE is historical metadata, not enforcement. */
export function validNetworkSanctionReviews(v:unknown):v is NetworkSanctionReview[]{
 if(!Array.isArray(v)||v.length>500||v.some(x=>!validNetworkSanctionReview(x)))return false;
 const rows=v as NetworkSanctionReview[];
 if(new Set(rows.map(x=>x.id)).size!==rows.length)return false;
 const live=rows.filter(x=>x.status==='PENDING'||x.status==='REVIEWED_ONLY');
 return new Set(live.map(x=>x.caseId+':'+x.targetChatId))
  .size===live.length;
}
/** Immutable case identity link must survive JSON and SQLite restoration.
 * A dismissed case or a pending allegation cannot be used to forge a review. */
export function validNetworkSanctionReviewReferences(
 reviews:readonly NetworkSanctionReview[],cases:readonly NetworkWatchCase[]
):boolean {
 return reviews.every(row=>{
  const matches=cases.filter(c=>c.id===row.caseId),source=matches[0];
  return matches.length===1&&!!source&&
   ['WATCHED','CLEARED'].includes(source.status)&&
   source.networkId===row.networkId&&source.networkRevision===row.networkRevision&&
   source.sourceChatId===row.sourceChatId&&
   source.sourceChatVersion===row.sourceChatVersion&&
   source.subjectId===row.subjectId&&source.revision>=row.caseRevision&&
   source.reviewedAt!==undefined&&row.requestedAt>=source.reviewedAt&&
   (source.clearedAt===undefined||
    (row.requestedAt<=source.clearedAt&&
     (row.reviewedAt===undefined||row.reviewedAt<=source.clearedAt)&&
     (row.closedAt===undefined||row.closedAt<=source.clearedAt)));
 });
}
