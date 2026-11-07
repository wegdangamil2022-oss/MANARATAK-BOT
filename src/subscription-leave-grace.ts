import {createHash,randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {subscriptionEnforcementStamp} from './subscription-enforcement-policy.js';

const ROOT='subscription:leave-grace:',REASON='SUBSCRIPTION_LEAVE_GRACE:';
export type SubscriptionGracePolicy={seconds:number;stamp:string;at:number};
export type SubscriptionGraceMember={chatId:string;memberId:string;stamp:string;verifiedAt:number;missingSince?:number;nextCheckAt?:number};
export function subscriptionGracePolicy(s:BotState,p:Policy,chat:string,now:number):SubscriptionGracePolicy|null{
 const stamp=subscriptionEnforcementStamp(s,p,chat);if(!stamp||!Number.isSafeInteger(now)||now<0)return null;
 const rows=s.audit.filter(a=>a.updateKey.startsWith(ROOT+chat+':')).sort((a,b)=>b.at-a.at||a.updateKey.localeCompare(b.updateKey)),row=rows[0];
 if(!row)return {seconds:0,stamp,at:0};
 if(rows.length>1&&rows[1]!.at===row.at||s.audit.filter(a=>a.updateKey===row.updateKey).length!==1||row.actorId!==p.ownerId||row.decision!=='ALLOW'||row.policyVersion!==p.chatRevision(s,chat)||!Number.isSafeInteger(row.at)||row.at<0||row.at>now||!row.reason.startsWith(REASON))return null;
 try{const v:unknown=JSON.parse(row.reason.slice(REASON.length));if(!v||typeof v!=='object'||Array.isArray(v))return null;const data=v as Record<string,unknown>;return Object.keys(data).sort().join(',')==='seconds,stamp'&&data.stamp===stamp&&[0,3600,86400].includes(Number(data.seconds))&&typeof data.seconds==='number'?{seconds:data.seconds,stamp,at:row.at}:null;}catch{return null;}
}
export function recordSubscriptionGracePolicy(s:BotState,p:Policy,actor:string,chat:string,seconds:number,now:number):boolean{
 const stamp=subscriptionEnforcementStamp(s,p,chat);if(!p.isOwner(actor)||!stamp||![0,3600,86400].includes(seconds)||!Number.isSafeInteger(now)||now<0||s.audit.some(a=>a.updateKey.startsWith(ROOT+chat+':')&&a.at>=now))return false;
 s.audit.push({actorId:actor,updateKey:ROOT+chat+':'+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:REASON+JSON.stringify({seconds,stamp}),policyVersion:p.chatRevision(s,chat),at:now});return true;
}
export const subscriptionGraceStamp=(policy:SubscriptionGracePolicy,consent:unknown)=>createHash('sha256').update(JSON.stringify([policy,consent])).digest('hex');
export function validSubscriptionGraceMember(v:unknown):v is SubscriptionGraceMember{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const r=v as Record<string,unknown>;
 return Object.keys(r).every(k=>['chatId','memberId','stamp','verifiedAt','missingSince','nextCheckAt'].includes(k))&&typeof r.chatId==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(r.chatId)?.[0]===r.chatId&&Number.isSafeInteger(Number(r.chatId))&&typeof r.memberId==='string'&&/^[1-9][0-9]{0,15}$/u.exec(r.memberId)?.[0]===r.memberId&&Number.isSafeInteger(Number(r.memberId))&&typeof r.stamp==='string'&&/^[a-f0-9]{64}$/u.exec(r.stamp)?.[0]===r.stamp&&Number.isSafeInteger(r.verifiedAt)&&Number(r.verifiedAt)>=0&&Number(r.verifiedAt)<=8640000000000000&&(r.missingSince===undefined||Number.isSafeInteger(r.missingSince)&&Number(r.missingSince)>=Number(r.verifiedAt)&&Number(r.missingSince)<=8640000000000000)&&(r.nextCheckAt===undefined||Number.isSafeInteger(r.nextCheckAt)&&Number(r.nextCheckAt)>=Number(r.verifiedAt)&&Number(r.nextCheckAt)<=8640000000000000);
}
