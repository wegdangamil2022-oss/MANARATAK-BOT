import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
export const RULE_EXEMPTION_PREFIX='moderation:rule-exemption:';
export type RuleExemption={id:string;chat:string;member:string;version:number;paragraph:number;until:number;actor:string;at:number;policyVersion:number};
const person=(x:unknown):x is string=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/u.exec(x)?.[0]===x&&Number.isSafeInteger(Number(x));
const group=(x:unknown):x is string=>typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(x)?.[0]===x&&Number.isSafeInteger(Number(x));
export const ruleExemptionDigest=(e:RuleExemption)=>createHash('sha256').update(JSON.stringify(e)).digest('hex');
export function ruleReference(value:string):{version:number;paragraph:number}|null{
 const m=/^law_v([1-9][0-9]{0,14})_p([1-9][0-9]?)_m([1-9][0-9]{0,15})$/u.exec(value);
 return m&&m[0]===value&&Number.isSafeInteger(Number(m[1]))&&Number.isSafeInteger(Number(m[3]))?{version:Number(m[1]),paragraph:Number(m[2])}:null;
}
/** Ambiguous, future or malformed revocations never terminate an exemption. */
export function activeRuleExemptions(s:BotState,now:number):RuleExemption[]{
 if(!Number.isSafeInteger(now)||now<0)return [];
 const keys=new Map<string,typeof s.audit>();for(const row of s.audit){const a=keys.get(row.updateKey)??[];a.push(row);keys.set(row.updateKey,a);}
 const result:RuleExemption[]=[];
 for(const a of s.audit){
  if(!/^moderation:rule-exemption:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)||a.decision!=='ALLOW'||!person(a.actorId)||!Number.isSafeInteger(a.at)||a.at<0||a.at>8640000000000000||!Number.isSafeInteger(a.policyVersion)||a.policyVersion<0||keys.get(a.updateKey)?.length!==1||!a.reason.startsWith('RULE_EXEMPTION:'))continue;
  try{const v:unknown=JSON.parse(a.reason.slice('RULE_EXEMPTION:'.length));if(!v||typeof v!=='object'||Array.isArray(v))continue;const x=v as Record<string,unknown>;
   if(Object.keys(x).sort().join(',')!=='chat,member,paragraph,until,version'||!group(x.chat)||!person(x.member)||!Number.isSafeInteger(x.version)||Number(x.version)<1||!Number.isSafeInteger(x.paragraph)||Number(x.paragraph)<1||Number(x.paragraph)>99||!Number.isSafeInteger(x.until)||Number(x.until)<=now||Number(x.until)<=a.at||Number(x.until)>8640000000000000||Number(x.until)>a.at+86400000)continue;
   const entry:RuleExemption={id:a.updateKey,chat:x.chat,member:x.member,version:Number(x.version),paragraph:Number(x.paragraph),until:Number(x.until),actor:a.actorId,at:a.at,policyVersion:a.policyVersion};
   const revoked=keys.get(a.updateKey+':revoked')??[],r=revoked[0];if(revoked.length===1&&r&&r.decision==='ALLOW'&&person(r.actorId)&&Number.isSafeInteger(r.at)&&r.at>=a.at&&r.at<=now&&r.policyVersion===a.policyVersion&&r.reason==='RULE_EXEMPTION_REVOKED:'+ruleExemptionDigest(entry))continue;
   result.push(entry);
  }catch{/* Untrusted entries cannot authorize an exemption. */}
 }
 return result.sort((a,b)=>a.until-b.until||a.id.localeCompare(b.id));
}
export function exemptFromRule(s:BotState,chat:string,member:string,reference:string,now:number):boolean{
 const ref=ruleReference(reference);return !!ref&&activeRuleExemptions(s,now).some(e=>e.chat===chat&&e.member===member&&e.version===ref.version&&e.paragraph===ref.paragraph);
}
