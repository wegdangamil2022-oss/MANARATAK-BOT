import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validGroupNetwork} from './group-network-model.js';
import {networkEmergencyStopped,validNetworkEmergencyControls}
 from './network-emergency-stop.js';
import {adminRoomNotificationTarget,adminRoomModeWitness}
 from './admin-room-links.js';

/** NETWORK-006 -> ADMIN-ROOM: A separate OWNER opt-in beyond both original
 * NOTIFICATIONS link approvals. Neither network membership nor a local
 * notification link is permission to transmit network review events.
 */
const PREFIX='network:room:pref:',REASON='NETWORK_ROOM_RELAY_PREF:';
const KEY=/^network:room:pref:([A-Za-z0-9_-]{24})$/u;
const id=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const network=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
const actor=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&
 v>=0&&v<=8_640_000_000_000_000-120_000;
const rev=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&
 v>0&&v<=9_999_999_999;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

export interface NetworkRoomRelayScope{
 readonly networkRevision:number;readonly groupVersion:number;
 readonly room:string;readonly roomVersion:number;
 readonly linkId:string;readonly setting:string;readonly authority:string;
}
export interface NetworkRoomRelayPreference extends NetworkRoomRelayScope{
 readonly key:string;readonly actor:string;readonly network:string;readonly group:string;
 readonly enabled:boolean;readonly at:number;
}
/** Requires existing, unique NOTIFICATIONS link (not CENTRAL / CONTROL),
 * owner chat.manage on group AND room, current network membership and no STOP.
 * This is strictly local rights evidence; dispatcher separately probes Telegram
 * private-room status immediately before each remote send.
 */
export function networkRoomRelayScope(s:BotState,p:Policy,owner:string,
 netId:string,groupId:string,now:number):NetworkRoomRelayScope|null{
 if(!time(now)||!actor(owner)||!p.isOwner(owner)||
  !p.privateFeature(s,'owner.dashboard',owner)||!network(netId)||!id(groupId)||
  !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  networkEmergencyStopped(s,netId))return null;
 const nets=(s.groupNetworks??[]).filter(n=>n.id===netId),n=nets[0];
 if(nets.length!==1||!n||!validGroupNetwork(n)||n.updatedAt>now)return null;
 const memberships=n.members.filter(m=>m.chatId===groupId),m=memberships[0];
 const chats=s.chats.filter(c=>c.id===groupId),group=chats[0];
 if(memberships.length!==1||!m||chats.length!==1||!group||!group.approved||
  group.version!==m.version||!group.scopes.includes('moderation')||
  !p.canUseChat(s,groupId,'moderation')||
  !p.has(s,owner,'chat.manage',groupId,now))return null;
 // A muted room can still revoke consent; delivery checks quiet separately.
 const target=adminRoomNotificationTarget(s,p,groupId,now,true);
 if(!target||!id(target.room)||target.room===groupId)return null;
 const rooms=s.chats.filter(c=>c.id===target.room),room=rooms[0];
 if(rooms.length!==1||!room||!room.approved||
  !room.scopes.includes('moderation')||
  !p.canUseChat(s,target.room,'moderation')||
  !p.has(s,owner,'chat.manage',target.room,now))return null;
 const witness=adminRoomModeWitness(s,p,owner,groupId,target.room,'NOTIFICATIONS',now);
 if(!witness)return null;
 return {networkRevision:n.revision,groupVersion:group.version,
  room:target.room,roomVersion:room.version,
  linkId:target.id,setting:target.setting,
  authority:hash([netId,groupId,n,group,room,target,witness,
   s.grants.filter(g=>g.actor===owner&&(g.chatId===groupId||g.chatId===target.room)),
   s.privateFeatures,s.privateSettingsRevision??0])};
}
function all(s:BotState):NetworkRoomRelayPreference[]|null{
 const audit=s.audit.filter(a=>a.updateKey.startsWith(PREFIX));
 if(audit.length>2000)return null;
 const keys=new Set<string>(),result:NetworkRoomRelayPreference[]=[];
 for(const row of audit){
  if(!KEY.test(row.updateKey)||keys.has(row.updateKey)||row.decision!=='ALLOW'||
   !actor(row.actorId)||!time(row.at)||!rev(row.policyVersion)||
   !row.reason.startsWith(REASON))return null;
  keys.add(row.updateKey);
  let payload:unknown;
  try{payload=JSON.parse(row.reason.slice(REASON.length));}catch{return null;}
  if(!obj(payload)||Object.keys(payload).sort().join(',')!==
    'authority,enabled,group,groupVersion,linkId,network,networkRevision,room,roomVersion,setting'||
   !network(payload.network)||!id(payload.group)||!id(payload.room)||
   payload.group===payload.room||
   !rev(payload.networkRevision)||!rev(payload.groupVersion)||!rev(payload.roomVersion)||
   !/^[A-Za-z0-9_-]{24}$/u.test(String(payload.linkId))||
   (payload.setting!=='0'&&!hex(payload.setting))||
   !hex(payload.authority)||typeof payload.enabled!=='boolean'||
   row.policyVersion!==payload.groupVersion)return null;
  result.push({key:row.updateKey,actor:row.actorId,at:row.at,
   network:payload.network,group:payload.group,room:payload.room,
   networkRevision:payload.networkRevision as number,
   groupVersion:payload.groupVersion as number,
   roomVersion:payload.roomVersion as number,linkId:payload.linkId as string,
   setting:payload.setting as string,authority:payload.authority,
   enabled:payload.enabled as boolean});
 }
 return result;
}
function records(rows:NetworkRoomRelayPreference[],owner:string,netId:string,groupId:string){
 return rows.filter(x=>x.actor===owner&&x.network===netId&&x.group===groupId)
  .sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key));
}
function latest(rows:NetworkRoomRelayPreference[]){
 if(rows.length>1&&rows[0]!.at===rows[1]!.at)return null;
 return rows[0]??null;
}
const equivalent=(a:NetworkRoomRelayScope,b:NetworkRoomRelayScope):boolean=>
 a.networkRevision===b.networkRevision&&a.groupVersion===b.groupVersion&&
 a.room===b.room&&a.roomVersion===b.roomVersion&&a.linkId===b.linkId&&
 a.setting===b.setting&&a.authority===b.authority;

export function networkRoomRelayEnabled(s:BotState,p:Policy,owner:string,
 netId:string,groupId:string,now:number):boolean|null{
 const scope=networkRoomRelayScope(s,p,owner,netId,groupId,now),
  rows=all(s);
 if(!scope||!rows)return null;
 const history=records(rows,owner,netId,groupId),last=latest(history);
 if(history.length>0&&!last||last&&last.at>now)return null;
 return !!last&&last.enabled&&equivalent(last,scope);
}
export function networkRoomRelayProof(s:BotState,p:Policy,owner:string,
 netId:string,groupId:string,now:number):string|null{
 const scope=networkRoomRelayScope(s,p,owner,netId,groupId,now),
  rows=all(s);
 if(!scope||!rows||rows.length>=2000)return null;
 const history=records(rows,owner,netId,groupId),last=latest(history);
 if(history.length>0&&!last||last&&last.at>now)return null;
 return hash([owner,netId,groupId,scope,last]);
}
/** Commit only from an independent, expiring one-shot PRIVATE callback. */
export function setNetworkRoomRelay(s:BotState,p:Policy,owner:string,
 netId:string,groupId:string,enabled:boolean,now:number):boolean{
 if(typeof enabled!=='boolean'||!time(now))return false;
 const scope=networkRoomRelayScope(s,p,owner,netId,groupId,now),
  rows=all(s),current=networkRoomRelayEnabled(s,p,owner,netId,groupId,now);
 if(!scope||!rows||rows.length>=2000||current===null||current===enabled)return false;
 const history=records(rows,owner,netId,groupId),last=latest(history);
 if(history.length>0&&!last||last&&last.at>=now)return false;
 const key=PREFIX+randomBytes(18).toString('base64url');
 if(rows.some(x=>x.key===key))return false;
 s.audit.push({actorId:owner,updateKey:key,decision:'ALLOW',
  reason:REASON+JSON.stringify({
   network:netId,group:groupId,enabled,
   networkRevision:scope.networkRevision,groupVersion:scope.groupVersion,
   room:scope.room,roomVersion:scope.roomVersion,linkId:scope.linkId,
   setting:scope.setting,authority:scope.authority
  }),policyVersion:scope.groupVersion,at:now});
 return true;
}
/** Current confirmed, non-ambiguous subscriptions. No chat action here. */
export function currentNetworkRoomRelays(s:BotState,p:Policy,now:number):
 NetworkRoomRelayPreference[]|null{
 if(!time(now))return null;
 const allRows=all(s);if(!allRows)return null;
 const grouped=new Map<string,NetworkRoomRelayPreference[]>();
 for(const row of allRows){
  const k=JSON.stringify([row.actor,row.network,row.group]);
  const previous=grouped.get(k)??[];
  previous.push(row);grouped.set(k,previous);
 }
 const enabled:NetworkRoomRelayPreference[]=[];
 for(const rows of grouped.values()){
  const row=latest(rows.sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key)));
  if(!row||!row.enabled||row.at>now||!p.isOwner(row.actor))continue;
  const current=networkRoomRelayScope(s,p,row.actor,row.network,row.group,now);
  if(current&&equivalent(row,current))enabled.push(row);
 }
 return enabled.sort((a,b)=>a.actor.localeCompare(b.actor)||
  a.network.localeCompare(b.network)||a.group.localeCompare(b.group));
}
