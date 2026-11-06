import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {subscriptionEnforcementConsent,subscriptionEnforcementStamp} from './subscription-enforcement-policy.js';
export type SubscriptionObservedMember={chatId:string;memberId:string;stamp:string;observedAt:number;nextCheckAt:number};
export function validSubscriptionObservedMembers(value:unknown):value is SubscriptionObservedMember[]{
 if(!Array.isArray(value)||value.length>1000)return false;const seen=new Set<string>();
 return value.every(r=>{
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='chatId,memberId,nextCheckAt,observedAt,stamp'||typeof r.chatId!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(r.chatId)||!Number.isSafeInteger(Number(r.chatId))||typeof r.memberId!=='string'||!/^[1-9][0-9]{0,15}$/u.test(r.memberId)||!Number.isSafeInteger(Number(r.memberId))||typeof r.stamp!=='string'||!/^[a-f0-9]{64}$/u.test(r.stamp)||!Number.isSafeInteger(r.observedAt)||r.observedAt<0||!Number.isSafeInteger(r.nextCheckAt)||r.nextCheckAt<r.observedAt||r.nextCheckAt>8640000000000000)return false;
  const key=JSON.stringify([r.chatId,r.memberId]);if(seen.has(key))return false;seen.add(key);return true;
 });
}
export function observedSubscriptionStamp(s:BotState,p:Policy,chat:string,now:number):string|null{
 const consent=subscriptionEnforcementConsent(s,p,chat,now),stamp=subscriptionEnforcementStamp(s,p,chat);
 return consent?.enabled&&stamp?createHash('sha256').update(JSON.stringify([stamp,consent])).digest('hex'):null;
}
export function observedSubscriptionDue(s:BotState,p:Policy,chat:string,member:string,now:number):boolean{
 const rows=s.subscriptionObservedMembers?.filter(r=>r.chatId===chat&&r.memberId===member)??[],r=rows[0];
 return Number.isSafeInteger(now)&&rows.length===1&&!!r&&r.observedAt<=now&&r.observedAt>now-30*86400000&&r.nextCheckAt<=now&&r.stamp===observedSubscriptionStamp(s,p,chat,now)&&!p.isOwner(member)&&!p.has(s,member,'chat.manage',chat,now);
}
