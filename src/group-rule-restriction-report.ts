import type {BotState} from './store.js';
import {ruleReference} from './group-rule-exemption-model.js';
/** Aggregate linked restriction receipts, never infer successful delivery from
 * a local reason alone. Simulations are counted separately from Telegram. */
export function groupRuleRestrictionCounts(s:BotState,chat:string,now:number,referenceValid:(reference:string)=>boolean):{telegram:number;simulation:number;unresolved:number}{
 const counts={telegram:0,simulation:0,unresolved:0};
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)return counts;
 for(const op of s.moderationOperations){
  if(op.chatId!==chat||op.kind!=='MUTE'||!Number.isSafeInteger(op.createdAt)||op.createdAt<Math.max(0,now-7*86400000)||op.createdAt>now||s.moderationOperations.filter(o=>o.id===op.id).length!==1)continue;
  let reasons:unknown;try{reasons=JSON.parse(op.reasonFingerprint);}catch{continue;}
  if(!Array.isArray(reasons)||!reasons.some(r=>Array.isArray(r)&&r.length===4&&r[0]==='MANUAL'&&typeof r[1]==='string'&&!!ruleReference(r[1])&&referenceValid(r[1])&&r[2]==='MUTE'&&r[3]&&typeof r[3]==='object'&&!Array.isArray(r[3])&&Object.keys(r[3]).join(',')==='expiresAt'&&Number.isSafeInteger(r[3].expiresAt)&&r[3].expiresAt>op.createdAt&&r[3].expiresAt<=8640000000000000))continue;
  if(['INTENT','STARTED','UNKNOWN_OUTCOME'].includes(op.status)){counts.unresolved++;continue;}
  if(op.status!=='CONFIRMED')continue;
  if(op.attemptGateway==='SIMULATION'){counts.simulation++;continue;}
  const rows=s.audit.filter(a=>a.updateKey==='moderation-outcome:'+op.id),a=rows[0];
  if(op.attemptGateway==='TELEGRAM_API'&&rows.length===1&&a?.decision==='ALLOW'&&a.actorId===op.actorId&&a.policyVersion===op.policyVersion&&a.reason==='MODERATION_OUTCOME:CONFIRMED'&&a.at>=op.createdAt&&a.at<=now)counts.telegram++;
 }
 return counts;
}
