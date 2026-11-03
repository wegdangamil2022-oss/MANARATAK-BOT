import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {subscriptionRequirementMode} from './subscription-integrity.js';
import {subscriptionEnforcementConsent} from './subscription-enforcement-policy.js';
import {subscriptionGracePolicy} from './subscription-leave-grace.js';
/** Group membership is checked separately by the dispatcher. This witness
 * permits only a private verification result, never access to group resources. */
export function subscriptionVerificationEpoch(s:BotState,p:Policy,actor:string,chat:string,now:number):string|null{
 if(!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor))||!/^-[1-9][0-9]{0,15}$/u.test(chat)||!Number.isSafeInteger(Number(chat))||!Number.isSafeInteger(now)||now<0||!p.canUseChat(s,chat,'navigation')||!p.canUseChat(s,chat,'verification')||subscriptionRequirementMode(s,chat)==='INVALID')return null;
 const rule=s.subscriptionRequirements.filter(r=>r.chatId===chat),ids=[chat,...(rule[0]?.channelIds??[])];
 return createHash('sha256').update('MANARATAK:SUBSCRIPTION-VERIFICATION:V1:').update(JSON.stringify([actor,chat,ids.map(id=>s.chats.filter(c=>c.id===id)),rule,s.privateFeatures['support.use'],s.privateSettingsRevision,subscriptionEnforcementConsent(s,p,chat,now),...(s.audit.some(a=>a.updateKey.startsWith('subscription:leave-grace:'))?[subscriptionGracePolicy(s,p,chat,now),s.subscriptionGraceMembers?.filter(r=>r.chatId===chat&&r.memberId===actor)??[]]:[]),s.moderationReasons.filter(r=>r.chatId===chat&&r.memberId===actor),s.moderationOperations.filter(o=>o.chatId===chat&&o.memberId===actor)])).digest('hex');
}

export function validSubscriptionVerificationRoute(data:string):boolean{const m=/^sv:1:(-[1-9][0-9]{0,15}):([1-9][0-9]{0,14})$/u.exec(data);return !!m&&m[0]===data&&Number.isSafeInteger(Number(m[1]))&&Number.isSafeInteger(Number(m[2]))&&Buffer.byteLength(data)<=64;}
