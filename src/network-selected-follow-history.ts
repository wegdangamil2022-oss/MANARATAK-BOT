import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';

/** Human-reviewed, per-target local follow decisions. Only audit receipts
 * paired with exactly one consumed private confirmation can appear here.
 * There is no Telegram send and no automatic membership or role change. */
export interface SelectedNetworkFollowEvent {
 nonce:string;networkId:string;sourceId:string;targetId:string;
 sourceRevision:number;targetVersion:number;at:number;
}
const PREFIX='network:select-follow:';
const KEY=/^network:select-follow:([A-Za-z0-9_-]{24})$/u;
const clock=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000;
const rev=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>0&&v<=9_999_999_999;
const group=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const net=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
function parsed(raw:string):{
 networkId:string;networkRevision:number;sourceId:string;
 sourceRevision:number;targetId:string;targetVersion:number;at:number;
}|null{
 if(!raw.startsWith(PREFIX))return null;
 let value:unknown;try{value=JSON.parse(raw.slice(PREFIX.length));}catch{return null;}
 if(value===null||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='at,networkId,networkRevision,proof,sourceId,sourceRevision,targetId,targetVersion'||
  !net(v.networkId)||!rev(v.networkRevision)||!group(v.sourceId)||
  !group(v.targetId)||v.sourceId===v.targetId||
  !rev(v.sourceRevision)||!rev(v.targetVersion)||!clock(v.at)||!hash(v.proof))return null;
 return {networkId:v.networkId,networkRevision:v.networkRevision,
  sourceId:v.sourceId,sourceRevision:v.sourceRevision,
  targetId:v.targetId,targetVersion:v.targetVersion,at:v.at};
}
/** Read-only event history. Former targets remain in durable history, but
 * consumers must independently check currently authorized group versions
 * and network membership before presenting an item to a manager. */
export function networkSelectedFollowHistory(
 s:BotState,policy:Policy,actor:string,networkId:string,now:number
):SelectedNetworkFollowEvent[]|null{
 if(!clock(now)||!policy.isOwner(actor)||
  !policy.privateFeature(s,'owner.dashboard',actor)||!net(networkId))return null;
 const nets=(s.groupNetworks??[]).filter(n=>n.id===networkId),n=nets[0];
 if(nets.length!==1||!n||!validGroupNetwork(n)||n.updatedAt>now)return null;
 const journal=new Map<string,number>();
 for(const a of s.audit)if(KEY.test(a.updateKey))
  journal.set(a.updateKey,(journal.get(a.updateKey)??0)+1);
 const receipts=new Map<string,BotState['callbacks']>();
 for(const c of s.callbacks)if(c.ref.startsWith('c_')){
  const current=receipts.get(c.ref)??[];current.push(c);receipts.set(c.ref,current);
 }
 const events:SelectedNetworkFollowEvent[]=[];
 for(const a of s.audit){
  if(a.reason!=='OWNER_NETWORK_POLICY_FOLLOW_SELECTED')continue;
  const k=KEY.exec(a.updateKey);
  if(!k||k[0]!==a.updateKey||journal.get(a.updateKey)!==1||
   a.actorId!==actor||a.decision!=='ALLOW'||!clock(a.at)||a.at>now||
   !rev(a.policyVersion))continue;
  const matches=receipts.get('c_'+k[1])??[],c=matches[0];
  if(matches.length!==1||!c||!c.oneShot||!c.used||c.revoked||
   c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||
   !clock(c.expiresAt)||c.expiresAt<=a.at)continue;
  const v=parsed(c.action);
  if(!v||v.networkId!==networkId||v.networkRevision!==a.policyVersion||
   c.expiresAt!==v.at+120_000||a.at<v.at)continue;
  events.push({nonce:k[1]!,networkId,sourceId:v.sourceId,
   targetId:v.targetId,sourceRevision:v.sourceRevision,
   targetVersion:v.targetVersion,at:a.at});
 }
 return events.sort((a,b)=>b.at-a.at||a.nonce.localeCompare(b.nonce)).slice(0,200);
}
