/** NETWORK-003: owner-reviewed, network-scoped advisory only.
 * Neither WATCHED nor any other status grants a Telegram moderation action. */
export type NetworkWatchCategory='SPAM'|'FLOOD'|'IMPERSONATION'|'OTHER';
export type NetworkWatchStatus='PENDING'|'WATCHED'|'DISMISSED'|'CLEARED';
export type NetworkWatchDecision='WATCHED'|'DISMISSED'|'CLEARED';
export interface NetworkWatchCase {
 id:string;networkId:string;networkRevision:number;
 sourceChatId:string;sourceChatVersion:number;subjectId:string;
 category:NetworkWatchCategory;revision:number;status:NetworkWatchStatus;
 submittedBy:string;submittedAt:number;
 reviewedBy?:string;reviewedAt?:number;clearedBy?:string;clearedAt?:number;
}
const object=(x:unknown):x is Record<string,unknown>=>
 x!==null&&typeof x==='object'&&!Array.isArray(x);
const hex=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{12}$/u.test(x);
const group=(x:unknown)=>typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const member=(x:unknown)=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const revision=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=1&&x<=9_999_999_999;
const time=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000;
const categories:NetworkWatchCategory[]=['SPAM','FLOOD','IMPERSONATION','OTHER'];
const statuses:NetworkWatchStatus[]=['PENDING','WATCHED','DISMISSED','CLEARED'];
export function validNetworkWatchCase(value:unknown):value is NetworkWatchCase {
 if(!object(value))return false;
 const required=['id','networkId','networkRevision','sourceChatId','sourceChatVersion',
  'subjectId','category','revision','status','submittedBy','submittedAt'];
 const review=['reviewedBy','reviewedAt'],clear=['clearedBy','clearedAt'];
 const keys=Object.keys(value);
 if(keys.some(k=>![...required,...review,...clear].includes(k))||
  required.some(k=>!Object.hasOwn(value,k)))return false;
 if(!hex(value.id)||!hex(value.networkId)||!revision(value.networkRevision)||
  !group(value.sourceChatId)||!revision(value.sourceChatVersion)||
  !member(value.subjectId)||!categories.includes(value.category as NetworkWatchCategory)||
  !revision(value.revision)||!statuses.includes(value.status as NetworkWatchStatus)||
  !member(value.submittedBy)||!time(value.submittedAt))return false;
 const hasReview=review.every(k=>Object.hasOwn(value,k)),
  hasClear=clear.every(k=>Object.hasOwn(value,k));
 if(review.some(k=>Object.hasOwn(value,k))&&!hasReview||
  clear.some(k=>Object.hasOwn(value,k))&&!hasClear)return false;
 if(value.status==='PENDING')return value.revision===1&&!hasReview&&!hasClear;
 if(value.revision!==(value.status==='CLEARED'?3:2)||!hasReview||
  !member(value.reviewedBy)||!time(value.reviewedAt)||
  (value.reviewedAt as number)<(value.submittedAt as number))return false;
 if(value.status==='CLEARED')return hasClear&&member(value.clearedBy)&&
  time(value.clearedAt)&&(value.clearedAt as number)>=(value.reviewedAt as number);
 return !hasClear;
}
/** Strict restore validation: at most one unresolved case per network+subject.
 * Completed histories are retained, but cannot impersonate a new approval. */
export function validNetworkWatchCases(value:unknown):value is NetworkWatchCase[]{
 if(!Array.isArray(value)||value.length>400||value.some(v=>!validNetworkWatchCase(v)))return false;
 const records=value as NetworkWatchCase[];
 if(new Set(records.map(c=>c.id)).size!==records.length)return false;
 const active=records.filter(c=>c.status==='PENDING'||c.status==='WATCHED');
 return new Set(active.map(c=>c.networkId+':'+c.subjectId)).size===active.length;
}
