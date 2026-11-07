import type {BotState} from './store.js';
import {groupRuleDescription} from './group-rules-model.js';
const ROOT='moderation:report:',PREFIX='MODERATION_REPORT:';
export type Report={id:string;actor:string;chat:string;member:string;message:number;at:number;version:number;closed:boolean;reference?:string};
export function records(s:BotState,now=Date.now()):Report[]{
 const keyed=new Map<string,typeof s.audit>();for(const a of s.audit){const rows=keyed.get(a.updateKey)??[];rows.push(a);keyed.set(a.updateKey,rows);}
 const rows:Report[]=[];
 for(const a of s.audit){
  if(!/^moderation:report:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)||keyed.get(a.updateKey)?.length!==1||!a.reason.startsWith(PREFIX)||!a.actorId)continue;
  try{const v:unknown=JSON.parse(Buffer.from(a.reason.slice(PREFIX.length),'base64url').toString('utf8'));
   if(!v||typeof v!=='object'||Array.isArray(v))continue;const r=v as Record<string,unknown>;
   const law=Object.hasOwn(r,'reference');
   if(Object.keys(r).sort().join(',')!==(law?'chat,member,message,reference':'chat,member,message')||typeof r.chat!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(r.chat)||typeof r.member!=='string'||!/^[1-9][0-9]{0,15}$/u.test(r.member)||!Number.isSafeInteger(r.message)||Number(r.message)<=0||!Number.isSafeInteger(a.at)||a.at<0)continue;
   if(law&&(a.decision!=='ALLOW'||!Number.isSafeInteger(Number(r.chat))||!Number.isSafeInteger(Number(r.member))||!Number.isSafeInteger(Number(a.actorId))||!/^[1-9][0-9]{0,15}$/u.test(a.actorId)||typeof r.reference!=='string'||!groupRuleDescription(s,r.chat,r.reference)||Number(/_m([1-9][0-9]{0,15})$/u.exec(r.reference)?.[1])!==r.message))continue;
   const decisions=keyed.get(a.updateKey+':closed')??[];if(decisions.length>1)continue;
   const closed=decisions.length===1&&decisions[0]!.reason==='MODERATION_REPORT_CLOSED'&&(!law||decisions[0]!.decision==='ALLOW'&&decisions[0]!.policyVersion===a.policyVersion&&Number.isSafeInteger(decisions[0]!.at)&&decisions[0]!.at>=a.at&&decisions[0]!.at<=now&&/^[1-9][0-9]{0,15}$/u.test(decisions[0]!.actorId??'')&&Number.isSafeInteger(Number(decisions[0]!.actorId)));
   if(law&&decisions.length===1&&!closed)continue;
   rows.push({id:a.updateKey.slice(ROOT.length),actor:a.actorId,chat:r.chat,member:r.member,message:Number(r.message),at:a.at,version:a.policyVersion,closed,...(law?{reference:r.reference as string}:{})});
  }catch{/* untrusted journal rows never become reports */}
 }
 return rows.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id));
}
export function ruleReviewReports(s:BotState,now=Date.now()){return records(s,now).filter((r):r is Report&{reference:string}=>r.reference!==undefined);}
