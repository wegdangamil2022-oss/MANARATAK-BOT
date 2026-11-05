/** An owner-opted, purely local dependency from one approved network group to
 * another. The record grants neither Telegram permissions nor enforcement. */
export type NetworkInheritanceKind='POLICY'|'GREETING';
export type NetworkInheritancePauseReason=
 'LOCAL_OVERRIDE'|'OWNER_REQUIRED'|'NETWORK_STALE'|'GROUP_STALE'|
 'SOURCE_STALE'|'TARGET_STALE'|'CAP_EXCEEDED'|'OWNER_PAUSED';
export interface NetworkInheritanceLink {
 id:string;kind:NetworkInheritanceKind;networkId:string;networkRevision:number;
 sourceChatId:string;sourceChatVersion:number;sourceRevision:number;
 targetChatId:string;targetChatVersion:number;targetRevision:number;
 targetDigest:string;createdAt:number;lastSyncedAt:number;
 status:'ACTIVE'|'PAUSED';pausedReason?:NetworkInheritancePauseReason;
}
const obj=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
const rev=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1&&v<=9_999_999_999;
const clock=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000;
const pauseReasons=new Set<string>(['LOCAL_OVERRIDE','OWNER_REQUIRED','NETWORK_STALE',
 'GROUP_STALE','SOURCE_STALE','TARGET_STALE','CAP_EXCEEDED','OWNER_PAUSED']);
export function validNetworkInheritanceLink(v:unknown):v is NetworkInheritanceLink{
 if(!obj(v))return false;
 const required=['id','kind','networkId','networkRevision','sourceChatId','sourceChatVersion',
  'sourceRevision','targetChatId','targetChatVersion','targetRevision','targetDigest',
  'createdAt','lastSyncedAt','status'];
 const allowed=[...required,'pausedReason'];
 if(Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k)))return false;
 if(!id(v.id)||!id(v.networkId)||!['POLICY','GREETING'].includes(String(v.kind))||
  !rev(v.networkRevision)||!group(v.sourceChatId)||!group(v.targetChatId)||
  v.sourceChatId===v.targetChatId||!rev(v.sourceChatVersion)||!rev(v.targetChatVersion)||
  !rev(v.sourceRevision)||!rev(v.targetRevision)||
  typeof v.targetDigest!=='string'||!/^[a-f0-9]{64}$/u.test(v.targetDigest)||
  !clock(v.createdAt)||!clock(v.lastSyncedAt)||
  (v.lastSyncedAt as number)<(v.createdAt as number)||!['ACTIVE','PAUSED'].includes(String(v.status)))return false;
 return v.status==='ACTIVE'?!Object.hasOwn(v,'pausedReason'):
  Object.hasOwn(v,'pausedReason')&&typeof v.pausedReason==='string'&&
  pauseReasons.has(v.pausedReason);
}
export function validNetworkInheritanceLinks(v:unknown):v is NetworkInheritanceLink[]{
 if(!Array.isArray(v)||v.length>500||v.some(x=>!validNetworkInheritanceLink(x)))return false;
 const ids=v.map(x=>(x as NetworkInheritanceLink).id);
 const destinations=v.map(x=>[(x as NetworkInheritanceLink).kind,
  (x as NetworkInheritanceLink).targetChatId].join(':'));
 if(new Set(ids).size!==ids.length||new Set(destinations).size!==destinations.length)return false;
 // Never form an active dependency chain or cycle, even in a restored snapshot.
 const active=v.filter((x:NetworkInheritanceLink)=>x.status==='ACTIVE');
 return !active.some((a:NetworkInheritanceLink)=>active.some((b:NetworkInheritanceLink)=>
  a.kind===b.kind&&a.sourceChatId===b.targetChatId));
}
