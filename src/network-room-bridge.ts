import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';
import {adminRoomModeWitness,adminRoomNotificationTarget} from './admin-room-links.js';
import {networkAdministrativeEvents} from './network-administrative-events.js';
import {networkReviewOverview} from './telegram-network-review-inbox.js';
import {networkEmergencyStopped,validNetworkEmergencyControls}
 from './network-emergency-stop.js';

/** NETWORK-006 and ADMIN-ROOM read-only integration:
 * organizational membership NEVER implies an admin-room link or visibility.
 * This projection requires current per-group authorization, AND for a room
 * identifier to be disclosed the caller must manage BOTH ends of a current
 * independently approved NOTIFICATIONS room link.
 */
export type NetworkRoomBridgeStatus=
 'ACTIVE'|'QUIET'|'UNLINKED'|'ROOM_NOT_AUTHORIZED';
export interface NetworkRoomBridgeRow{
 readonly groupId:string;readonly groupVersion:number;
 readonly status:NetworkRoomBridgeStatus;
 readonly roomId:string|null;
 readonly events24h:number|null;readonly pendingReviews:number|null;
 readonly truncated:boolean;
}
export interface NetworkRoomBridgeSummary{
 readonly networkId:string;readonly networkName:string;
 readonly networkRevision:number;readonly at:number;
 readonly networkStopped:boolean;
 readonly rows:readonly NetworkRoomBridgeRow[];
 readonly eligibleGroups:number;readonly linked:number;readonly quiet:number;
 readonly unauthorizedRooms:number;readonly unlinked:number;
}
const validClock=(now:number)=>Number.isSafeInteger(now)&&
 now>=86_400_000&&now<=8_640_000_000_000_000-120_000;
export function networkRoomBridgeSummary(
 s:BotState,p:Policy,actor:string,networkId:string,now:number
):NetworkRoomBridgeSummary|null{
 if(!validClock(now)||!p.isOwner(actor)||
  !p.privateFeature(s,'owner.dashboard',actor)||
  !/^[a-f0-9]{12}$/u.test(networkId))return null;
 const nets=(s.groupNetworks??[]).filter(n=>n.id===networkId),network=nets[0];
 if(nets.length!==1||!network||!validGroupNetwork(network)||
  network.updatedAt>now)return null;
 if(!validNetworkEmergencyControls(s.networkEmergencyControls??[]))return null;
 const reviews=networkReviewOverview(s,p,actor,networkId,now);
 if(!reviews)return null;
 const pendingByGroup=new Map(reviews.groups.map(g=>
  [g.chatId,g.watchPending+g.sanctionsPending]));
 const rows:NetworkRoomBridgeRow[]=[];
 for(const member of network.members){
  const matches=s.chats.filter(c=>c.id===member.chatId),c=matches[0];
  if(matches.length!==1||!c||!c.approved||c.version!==member.version||
   !c.scopes.includes('moderation')||
   !p.canUseChat(s,c.id,'moderation')||
   !p.has(s,actor,'chat.manage',c.id,now))continue;
  const link=adminRoomNotificationTarget(s,p,c.id,now,true);
  if(!link){
   rows.push({groupId:c.id,groupVersion:c.version,
    status:'UNLINKED',roomId:null,events24h:null,
    pendingReviews:pendingByGroup.get(c.id)??null,truncated:false});
   continue;
  }
  // Read-only proof also binds the current owner's rights over the ROOM.
  // In particular an owner who manages the source network but not a room
  // never sees the room ID or the room's settings through this dashboard.
  const witness=adminRoomModeWitness(s,p,actor,c.id,link.room,'NOTIFICATIONS',now);
  if(!witness){
   rows.push({groupId:c.id,groupVersion:c.version,
    status:'ROOM_NOT_AUTHORIZED',roomId:null,events24h:null,
    pendingReviews:pendingByGroup.get(c.id)??null,truncated:false});
   continue;
  }
  const events=networkAdministrativeEvents(s,p,actor,now,networkId,{chatId:c.id});
  if(!events)return null;
  const active=adminRoomNotificationTarget(s,p,c.id,now,false);
  const quiet=active===null;
  rows.push({groupId:c.id,groupVersion:c.version,
   status:quiet?'QUIET':'ACTIVE',roomId:link.room,
   events24h:events.filter(e=>e.at>now-86_400_000&&e.at<=now).length,
   pendingReviews:pendingByGroup.get(c.id)??null,truncated:events.length===200});
 }
 rows.sort((a,b)=>a.groupId.localeCompare(b.groupId));
 return {networkId,networkName:network.name,
  networkRevision:network.revision,at:now,rows,
  networkStopped:networkEmergencyStopped(s,networkId),
  eligibleGroups:rows.length,
  linked:rows.filter(x=>x.status==='ACTIVE').length,
  quiet:rows.filter(x=>x.status==='QUIET').length,
  unauthorizedRooms:rows.filter(x=>x.status==='ROOM_NOT_AUTHORIZED').length,
  unlinked:rows.filter(x=>x.status==='UNLINKED').length};
}
