import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';
import {networkCopyFields,type NetworkCopyPart} from './network-group-copy.js';

/** Trusted NETWORK-007 copy history never relies on a free-form audit line
 * alone: every visible entry must match one consumed private confirmation.
 */
export interface NetworkCopyHistoryEntry{
 readonly nonce:string;readonly networkId:string;
 readonly sourceId:string;readonly targetId:string;
 readonly parts:NetworkCopyPart;readonly targetRevision:number;
 readonly committedRevision:number;readonly at:number;
}
const AUDIT='NETWORK_POLICY_PORTABLE_FIELDS_COPIED_LOCAL';
const PREFIX='network-group-copy:';
const key=/^network-group-copy:([A-Za-z0-9_-]{24})$/u;
const id=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const network=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
const rev=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>0&&v<=9_999_999_999;
const clock=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-120_000;
function fields(value:unknown):value is NetworkCopyPart{
 return typeof value==='string'&&
  Object.prototype.hasOwnProperty.call(networkCopyFields,value);
}
function confirmation(raw:unknown):{
 netId:string;sourceId:string;targetId:string;parts:NetworkCopyPart;
 targetRevision:number;
}|null{
 if(typeof raw!=='string'||!raw.startsWith(PREFIX))return null;
 let value:unknown;
 try{value=JSON.parse(raw.slice(PREFIX.length));}catch{return null;}
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const x=value as Record<string,unknown>;
 if(Object.keys(x).sort().join(',')!=='netId,networkRevision,parts,proof,sourceId,sourceRevision,targetId,targetRevision'||
  !network(x.netId)||!id(x.sourceId)||!id(x.targetId)||
  x.sourceId===x.targetId||!fields(x.parts)||
  !rev(x.networkRevision)||!rev(x.sourceRevision)||!rev(x.targetRevision)||
  typeof x.proof!=='string'||!/^[a-f0-9]{64}$/u.test(x.proof))return null;
 return {netId:x.netId,sourceId:x.sourceId,targetId:x.targetId,
  parts:x.parts,targetRevision:x.targetRevision};
}
/** Max 200 most recent verifiable receipts per network. No identity of
 * moderated members, exception lists, policy literals, or Telegram sends. */
export function networkGroupCopyHistory(s:BotState,p:Policy,actor:string,
 netId:string,now:number):NetworkCopyHistoryEntry[]|null{
 if(!clock(now)||!p.isOwner(actor)||!p.privateFeature(s,'owner.dashboard',actor)||
  !network(netId))return null;
 const networks=(s.groupNetworks??[]).filter(n=>n.id===netId);
 if(networks.length!==1||!validGroupNetwork(networks[0])||
  networks[0]!.updatedAt>now)return null;
 // Historical receipts are durable, but displaying a former group ID
 // still requires CURRENT membership, owner scope and approval for BOTH ends.
 const approved=new Set<string>();
 for(const m of networks[0]!.members){
  const chats=s.chats.filter(c=>c.id===m.chatId),c=chats[0];
  if(chats.length===1&&c&&c.approved&&c.version===m.version&&
   c.scopes.includes('moderation')&&p.canUseChat(s,c.id,'moderation')&&
   p.has(s,actor,'chat.manage',c.id,now))approved.add(c.id);
 }
 const out:NetworkCopyHistoryEntry[]=[];
 // Pre-index once: historical review should remain bounded even with large
 // audit journals, while duplicate keys still fail closed.
 const count=new Map<string,number>();
 for(const row of s.audit)if(key.test(row.updateKey))
  count.set(row.updateKey,(count.get(row.updateKey)??0)+1);
 const receiptMap=new Map<string,BotState['callbacks']>();
 for(const c of s.callbacks)if(c.ref.startsWith('c_')){
  const rows=receiptMap.get(c.ref)??[];
  rows.push(c);receiptMap.set(c.ref,rows);
 }
 for(const a of s.audit){
  if(a.reason!==AUDIT)continue;
  const m=key.exec(a.updateKey);if(!m||m[0]!==a.updateKey||
   a.decision!=='ALLOW'||a.actorId!==actor||
   !rev(a.policyVersion)||!clock(a.at)||a.at>now||
   count.get(a.updateKey)!==1)continue;
  // The private one-shot receipt and audit entry must agree exactly.
  const matching=receiptMap.get('c_'+m[1])??[];
  if(matching.length!==1)continue;
  const c=matching[0]!;
  if(!c.oneShot||!c.used||c.revoked||c.actorId!==actor||
   c.chatId!=='private'||c.policyVersion!==0||
   !clock(c.expiresAt)||a.at>=c.expiresAt||a.at<c.expiresAt-120_000)continue;
  const parsed=confirmation(c.action);
  if(!parsed||parsed.netId!==netId||
   !approved.has(parsed.sourceId)||!approved.has(parsed.targetId)||
   a.policyVersion!==parsed.targetRevision+1)continue;
  out.push({nonce:m[1]!,networkId:netId,
   sourceId:parsed.sourceId,targetId:parsed.targetId,
   parts:parsed.parts,targetRevision:parsed.targetRevision,
   committedRevision:a.policyVersion,at:a.at});
 }
 return out.sort((a,b)=>b.at-a.at||a.nonce.localeCompare(b.nonce)).slice(0,200);
}
