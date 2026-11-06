import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {networkEmergencyStopped} from './network-emergency-stop.js';
import {validNetworkInheritanceLinks} from './network-inheritance-model.js';
import {pauseNetworkInheritanceByOwner} from './network-inheritance.js';

export interface NetworkBulkPauseResult {
 paused:number;
 targetChatIds:string[];
}
/** NETWORK-004: deliberately bounded (<=8) independently selected
 * local policy-follow links. Never alters existing group protection policies,
 * Telegram rights or member sanctions. Requires an outer BotStore transaction. */
export function pauseSelectedNetworkPolicyLinks(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string,
 ids:readonly string[]
):NetworkBulkPauseResult|null{
 if(!policy.isOwner(actor)||!policy.privateFeature(s,'owner.dashboard',actor)||
  !Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000-120_000||
  !/^[a-f0-9]{12}$/u.test(networkId)||
  !Array.isArray(ids)||ids.length===0||ids.length>8||
  ids.some(x=>typeof x!=='string'||!/^[a-f0-9]{12}$/u.test(x))||
  new Set(ids).size!==ids.length||
  !validNetworkInheritanceLinks(s.networkInheritance??[])||
  networkEmergencyStopped(s,networkId))return null;
 const networks=(s.groupNetworks??[]).filter(n=>n.id===networkId);
 if(networks.length!==1||networks[0]!.updatedAt>now)return null;
 const records=ids.map(id=>(s.networkInheritance??[]).filter(x=>x.id===id));
 if(records.some(rows=>rows.length!==1||rows[0]!.kind!=='POLICY'||
  rows[0]!.networkId!==networkId||rows[0]!.status!=='ACTIVE'))return null;
 const targets=records.map(rows=>rows[0]!.targetChatId);
 if(new Set(targets).size!==targets.length)return null;
 // Every row was checked before a single mutation. If any fails,
 // the transaction is rolled back by its caller; no partial pause.
 for(const id of ids)if(!pauseNetworkInheritanceByOwner(s,id))
  throw new Error('NETWORK_BULK_PAUSE_INVARIANT');
 return {paused:ids.length,targetChatIds:targets};
}
