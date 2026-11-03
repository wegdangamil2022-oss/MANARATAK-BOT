import type {BotState,Warning} from './store.js';
import {ruleReference} from './group-rule-exemption-model.js';
export const RULE_WARNING_POLICY_PREFIX='moderation:rule-warning-policy:';
export type RuleAction='notice'|'warn'|'mute'|'review';
export type RuleWarningPolicy={chat:string;version:number;paragraph:number;revision:number;cap:number;seconds:number;actions?:RuleAction[];muteSeconds?:number};
export function validRuleWarningPolicy(v:unknown):v is RuleWarningPolicy{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const r=v as RuleWarningPolicy;
 const configured=Object.hasOwn(r,'actions')||Object.hasOwn(r,'muteSeconds');
 return Object.keys(r).sort().join(',')===(configured?'actions,cap,chat,muteSeconds,paragraph,revision,seconds,version':'cap,chat,paragraph,revision,seconds,version')&&(!configured||Array.isArray(r.actions)&&r.actions.length>=1&&r.actions.length<=4&&new Set(r.actions).size===r.actions.length&&r.actions.every(a=>['notice','warn','mute','review'].includes(a))&&Number.isSafeInteger(r.muteSeconds)&&r.muteSeconds!>=60&&r.muteSeconds!<=86400)&&typeof r.chat==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(r.chat)?.[0]===r.chat&&Number.isSafeInteger(Number(r.chat))&&Number.isSafeInteger(r.version)&&r.version>=1&&Number.isSafeInteger(r.paragraph)&&r.paragraph>=1&&r.paragraph<=20&&Number.isSafeInteger(r.revision)&&r.revision>=1&&Number.isSafeInteger(r.cap)&&r.cap>=1&&r.cap<=20&&Number.isSafeInteger(r.seconds)&&r.seconds>=60&&r.seconds<=2592000;
}
export function ruleActionAllowed(s:BotState,chat:string,reference:string,action:RuleAction,now:number,duration?:number):boolean{const p=ruleWarningPolicy(s,chat,reference,now);return p.status==='CONFIGURED'?(!p.policy.actions||p.policy.actions.includes(action)&&(action!=='mute'||duration===undefined||duration===p.policy.muteSeconds)):p.status==='NONE';}
export function ruleWarningPolicy(s:BotState,chat:string,reference:string,now:number):{status:'NONE'|'INVALID'}|{status:'CONFIGURED';policy:RuleWarningPolicy}{
 const ref=ruleReference(reference);if(!ref||!Number.isSafeInteger(now)||now<0||now>8640000000000000)return {status:'INVALID'};
 const prefix=RULE_WARNING_POLICY_PREFIX+chat+':'+ref.version+':'+ref.paragraph+':',rows=s.audit.filter(a=>a.updateKey.startsWith(prefix));if(!rows.length)return {status:'NONE'};
 const policies:RuleWarningPolicy[]=[];const groups=s.chats.filter(c=>c.id===chat);if(groups.length!==1)return {status:'INVALID'};
 for(const a of rows){
  if(s.audit.filter(b=>b.updateKey===a.updateKey).length!==1||a.decision!=='ALLOW'||!a.actorId||/^[1-9][0-9]{0,15}$/u.exec(a.actorId)?.[0]!==a.actorId||!Number.isSafeInteger(Number(a.actorId))||!Number.isSafeInteger(a.at)||a.at<0||a.at>now||a.policyVersion!==groups[0]!.version||!a.reason.startsWith('RULE_WARNING_POLICY:'))return {status:'INVALID'};
  let p:unknown;try{p=JSON.parse(a.reason.slice('RULE_WARNING_POLICY:'.length));}catch{return {status:'INVALID'};}
  if(!validRuleWarningPolicy(p)||p.chat!==chat||p.version!==ref.version||p.paragraph!==ref.paragraph||a.updateKey!==prefix+p.revision)return {status:'INVALID'};policies.push(p);
 }
 policies.sort((a,b)=>a.revision-b.revision);if(policies.some((p,i)=>p.revision!==i+1))return {status:'INVALID'};
 return {status:'CONFIGURED',policy:policies.at(-1)!};
}
/** Expiration never rewrites an old warning or erases the appeal history. */
export function warningActive(w:Warning,now:number):boolean{
 if(!w.active||!Number.isSafeInteger(now)||now<0||now>8640000000000000)return false;
 if(w.expiresAt===undefined)return true;
 // Invalid expiration cannot silently forgive an existing warning.
 return !Number.isSafeInteger(w.expiresAt)||w.expiresAt<=w.at||w.expiresAt>8640000000000000||now<w.expiresAt;
}
export function paragraphWarningCount(s:BotState,chat:string,member:string,reference:string,now:number):number{
 const ref=ruleReference(reference);if(!ref)return 0;
 return s.warnings.filter(w=>{const other=ruleReference(w.reference);return w.chatId===chat&&w.memberId===member&&other?.version===ref.version&&other.paragraph===ref.paragraph&&w.at<=now&&warningActive(w,now);}).length;
}
