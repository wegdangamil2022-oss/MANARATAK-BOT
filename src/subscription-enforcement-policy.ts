import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {isCanonicalSubscriptionRule} from './subscription-integrity.js';
const ROOT='subscription:enforcement:',PREFIX='SUBSCRIPTION_ENFORCEMENT_CONSENT_V1:';
export function subscriptionEnforcementStamp(s:BotState,p:Policy,chat:string):string|null{
 const rows=s.subscriptionRequirements.filter(r=>r.chatId===chat),rule=rows[0];
 if(rows.length!==1||!rule||!isCanonicalSubscriptionRule(rule)||!p.privateFeature(s,'owner.dashboard',p.ownerId)||!p.canUseChat(s,chat,'moderation')||!p.canUseChat(s,chat,'verification')||rule.channelIds.some(id=>!p.canUseChat(s,id,'verification')))return null;
 return createHash('sha256').update(JSON.stringify([p.ownerId,rule,[chat,...rule.channelIds].map(id=>s.chats.filter(c=>c.id===id)),s.privateSettingsRevision,s.privateFeatures['owner.dashboard']])).digest('hex');
}
export function subscriptionEnforcementConsent(s:BotState,p:Policy,chat:string,now:number=Date.now()):{enabled:boolean;stamp:string;at:number}|null{
 const stamp=subscriptionEnforcementStamp(s,p,chat);if(!stamp)return null;
 const rows=s.audit.filter(a=>a.actorId===p.ownerId&&a.updateKey.startsWith(ROOT+chat+':')&&a.reason.startsWith(PREFIX)).sort((a,b)=>b.at-a.at||b.updateKey.localeCompare(a.updateKey)),a=rows[0];
 if(!Number.isSafeInteger(now)||now<0||!a||a.at>now||rows.length>1&&rows[1]!.at===a.at||s.audit.filter(x=>x.updateKey===a.updateKey).length!==1||a.policyVersion!==p.chatRevision(s,chat)||!Number.isSafeInteger(a.at)||a.at<0||a.decision!=='ALLOW')return null;
 try{const v:unknown=JSON.parse(a.reason.slice(PREFIX.length));if(!v||typeof v!=='object'||Array.isArray(v))return null;const r=v as Record<string,unknown>;return Object.keys(r).sort().join(',')==='enabled,stamp'&&r.stamp===stamp&&typeof r.enabled==='boolean'?{enabled:r.enabled,stamp,at:a.at}:null;}catch{return null;}
}
/** Called only by the confirmed private owner configuration transaction. */
export function recordSubscriptionEnforcementConsent(s:BotState,p:Policy,actor:string,chat:string,enabled:boolean,at:number):boolean{
 const stamp=subscriptionEnforcementStamp(s,p,chat);if(typeof enabled!=='boolean'||!p.isOwner(actor)||!stamp||!Number.isSafeInteger(at)||at<0||at>8640000000000000-5000||s.audit.some(a=>a.updateKey.startsWith(ROOT+chat+':')&&a.at>=at))return false;
 if(enabled&&!s.subscriptionRequirements.find(r=>r.chatId===chat)!.channelIds.length)return false;
 s.audit.push({actorId:actor,updateKey:ROOT+chat+':'+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:PREFIX+JSON.stringify({enabled,stamp}),policyVersion:p.chatRevision(s,chat),at});return true;
}
