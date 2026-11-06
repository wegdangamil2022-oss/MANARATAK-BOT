import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validNetworkInheritanceLinks} from './network-inheritance-model.js';

/** NETWORK-004: persisted local safety fuse. It can STOP or authorize future
 * configuration after independent RESUME; it cannot restart stopped links,
 * grant Telegram permissions or dispatch a moderation action. */
export interface NetworkEmergencyControl {
 networkId:string;
 revision:number;
 status:'STOPPED'|'RESUMED';
 changedAt:number;
 changedBy:string;
}
const record=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);
const owner=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const rev=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&
 v>=1&&v<=9_999_999_999;
const clock=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&
 v>=0&&v<=8_640_000_000_000_000;
export function validNetworkEmergencyControls(value:unknown):value is NetworkEmergencyControl[]{
 if(!Array.isArray(value)||value.length>32)return false;
 if(value.some(v=>!record(v)||Object.keys(v).length!==5||
  !['networkId','revision','status','changedAt','changedBy'].every(k=>Object.hasOwn(v,k))||
  !id(v.networkId)||!rev(v.revision)||
  !['STOPPED','RESUMED'].includes(String(v.status))||
  !clock(v.changedAt)||!owner(v.changedBy)))return false;
 return new Set(value.map(v=>(v as NetworkEmergencyControl).networkId)).size===value.length;
}
/** Fail closed on corrupted controls; old databases with no controls are open. */
export function networkEmergencyStopped(s:Pick<BotState,'networkEmergencyControls'>,
 networkId:string):boolean{
 if(!id(networkId))return true;
 const controls=s.networkEmergencyControls;
 if(controls===undefined)return false;
 if(!validNetworkEmergencyControls(controls))return true;
 return controls.some(c=>c.networkId===networkId&&c.status==='STOPPED');
}
export interface NetworkEmergencyResult{
 networkId:string;
 status:'STOPPED'|'RESUMED';
 revision:number;
 paused:number;
}
/** Must be invoked inside a BotStore transaction after owner-specific preview.
 * STOP is effective even if all group membership links have gone stale:
 * restoring admin rights cannot silently reactivate yesterday's policies.
 * RESUME opens the configuration gate but NEVER unpauses old links. */
export function decideNetworkEmergency(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string,
 action:'STOP'|'RESUME'
):NetworkEmergencyResult|null{
 if(!clock(now)||now>8_640_000_000_000_000-120_000||
  !policy.isOwner(actor)||!policy.privateFeature(s,'owner.dashboard',actor)||
  !id(networkId)||!validNetworkEmergencyControls(s.networkEmergencyControls??[])||
  !validNetworkInheritanceLinks(s.networkInheritance??[]))return null;
 const networks=(s.groupNetworks??[]).filter(x=>x.id===networkId);
 if(networks.length!==1||networks[0]!.updatedAt>now)return null;
 const rows=(s.networkEmergencyControls??[]).filter(x=>x.networkId===networkId);
 const previous=rows[0];
 if(rows.length>1||action==='STOP'&&previous?.status==='STOPPED'||
  action==='RESUME'&&previous?.status!=='STOPPED'||
  previous&&previous.revision>=9_999_999_999||
  !previous&&(s.networkEmergencyControls??[]).length>=32)return null;
 const nextStatus=action==='STOP'?'STOPPED':'RESUMED';
 const revision=(previous?.revision??0)+1;
 let paused=0;
 if(action==='STOP')for(const link of s.networkInheritance??[]){
  if(link.networkId!==networkId||link.status!=='ACTIVE')continue;
  link.status='PAUSED';link.pausedReason='NETWORK_EMERGENCY';paused++;
 }
 s.networkEmergencyControls??=[];
 if(previous){previous.status=nextStatus;previous.revision=revision;
  previous.changedAt=now;previous.changedBy=actor;}
 else s.networkEmergencyControls.push({networkId,revision,status:nextStatus,
  changedAt:now,changedBy:actor});
 return {networkId,status:nextStatus,revision,paused};
}
