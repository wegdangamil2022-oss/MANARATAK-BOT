import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {networkAlertScope,networkAlertEnabled,type NetworkAlertKind}
 from './network-event-alerts.js';
import {networkAlertSilenceUntil} from './network-alert-silence.js';
import {networkAdministrativeEvents} from './network-administrative-events.js';

/** NETWORK-006: strictly scoped, read-only 6/24h administrative summaries.
 * This is an on-demand snapshot, not automatic delivery, moderation authority
 * or a complete historical event ledger. No subject identity is returned.
 */
export type NetworkDigestHours=6|24;
export interface NetworkManagerDigest{
 readonly networkId:string;readonly chatId:string;readonly hours:NetworkDigestHours;
 readonly at:number;readonly since:number;
 readonly watch:number;readonly sanction:number;readonly snapshots:number;
 readonly total:number;readonly truncated:boolean;
 readonly subscriptions:Readonly<Record<NetworkAlertKind,boolean>>;
 readonly silenceUntil:number;
}
const clock=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&
 v>=86_400_000&&v<=8_640_000_000_000_000;
const id=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const network=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{12}$/u.test(v);

/** Read only the current group the actor can manage. Source projection is
 * capped to 200 already, so full-cap summaries are labeled as incomplete.
 * Do not use the counts as billing, evidence of a specific person or proof
 * that no earlier event occurred.
 */
export function networkManagerDigest(s:BotState,p:Policy,actor:string,
 net:string,group:string,now:number,hours:NetworkDigestHours):NetworkManagerDigest|null{
 if(!clock(now)||!network(net)||!id(group)||(hours!==6&&hours!==24)||
  !networkAlertScope(s,p,actor,net,group,now)||
  !p.privateFeature(s,'owner.dashboard',p.ownerId))return null;
 const silence=networkAlertSilenceUntil(s,p,actor,net,group,now);
 if(silence===null)return null;
 const results=networkAdministrativeEvents(s,p,p.ownerId,now,net,{chatId:group});
 if(!results)return null;
 const since=now-hours*3_600_000;
 const accepted=results.filter(e=>e.at>since&&e.at<=now&&e.chatId===group);
 if(new Set(accepted.map(e=>e.id)).size!==accepted.length)return null;
 const watch=accepted.filter(e=>e.kind==='WATCH_CASE').length;
 const sanction=accepted.filter(e=>e.kind==='SANCTION_REVIEW').length;
 const snapshots=accepted.filter(e=>e.kind==='SNAPSHOT').length;
 if(watch+sanction+snapshots!==accepted.length)return null;
 return {networkId:net,chatId:group,hours,at:now,since,
  watch,sanction,snapshots,total:accepted.length,truncated:results.length===200,
  subscriptions:{
   w:networkAlertEnabled(s,p,actor,net,group,'w',now),
   r:networkAlertEnabled(s,p,actor,net,group,'r',now),
   s:networkAlertEnabled(s,p,actor,net,group,'s',now)
  },silenceUntil:silence};
}
