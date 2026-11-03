import {createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {ModerationService} from './moderation.js';
import type {TelegramReplySender,TelegramSendResult} from './telegram-replies.js';
import {groupRuleDescription} from './group-rules-model.js';
import {ruleReference,exemptFromRule} from './group-rule-exemption-model.js';
import {ruleActionAllowed,ruleWarningPolicy} from './group-rule-warning-policy.js';
export const RULE_NOTICE='moderation:rule-notice:';
export type RuleNotice={id:string;actor:string;chat:string;member:string;reference:string;expiresAt:number;policyRevision:number;at:number;version:number;delivery:'PENDING'|'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED'};
const person=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
export function ruleNotices(s:BotState,now:number):RuleNotice[]{
 const out:RuleNotice[]=[];if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)return out;
 const keyed=new Map<string,typeof s.audit>();for(const a of s.audit){const rows=keyed.get(a.updateKey)??[];rows.push(a);keyed.set(a.updateKey,rows);}
 const laws=new Map<string,boolean>(),validLaw=(chat:string,reference:string)=>{const r=ruleReference(reference);if(!r)return false;const key=chat+':'+r.version+':'+r.paragraph;if(!laws.has(key))laws.set(key,!!groupRuleDescription(s,chat,'law_v'+r.version+'_p'+r.paragraph+'_m1'));return laws.get(key)!;};
 for(const a of s.audit){
  if(!/^moderation:rule-notice:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)||!a.reason.startsWith('RULE_NOTICE:')||a.decision!=='ALLOW'||!person(a.actorId)||!Number.isSafeInteger(a.policyVersion)||a.policyVersion<1||!Number.isSafeInteger(a.at)||a.at<0||a.at>now||keyed.get(a.updateKey)?.length!==1)continue;
  try{const n=JSON.parse(a.reason.slice('RULE_NOTICE:'.length)) as Record<string,unknown>;
   if(!n||typeof n!=='object'||Array.isArray(n)||Object.keys(n).sort().join(',')!=='chat,expiresAt,member,policyRevision,reference'||!Number.isSafeInteger(n.policyRevision)||Number(n.policyRevision)<0||typeof n.chat!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(n.chat)||!Number.isSafeInteger(Number(n.chat))||!person(n.member)||typeof n.reference!=='string'||!validLaw(n.chat,n.reference)||!Number.isSafeInteger(n.expiresAt)||Number(n.expiresAt)<=a.at||Number(n.expiresAt)>8640000000000000||Number(n.expiresAt)>a.at+2592000000)continue;
   const outcomes=keyed.get(a.updateKey+':outcome')??[],o=outcomes[0];let delivery:RuleNotice['delivery']='PENDING';
   if(outcomes.length){delivery=outcomes.length===1&&o?.actorId===a.actorId&&o.decision==='NOOP'&&o.policyVersion===a.policyVersion&&Number.isSafeInteger(o.at)&&o.at>=a.at&&o.at<=now&&/^RULE_NOTICE_(CONFIRMED|FAILED_CONFIRMED|UNKNOWN_OUTCOME|CANCELLED)$/u.test(o.reason)?o.reason.slice('RULE_NOTICE_'.length) as RuleNotice['delivery']:'UNKNOWN_OUTCOME';}
   const notice:RuleNotice={id:a.updateKey,actor:a.actorId,chat:n.chat,member:n.member,reference:n.reference,expiresAt:Number(n.expiresAt),policyRevision:Number(n.policyRevision),at:a.at,version:a.policyVersion,delivery};
   if(delivery==='CONFIRMED'){
    const receipt=keyed.get(a.updateKey+':receipt')??[],r=receipt[0],starts=keyed.get(a.updateKey+':started')??[],start=starts[0],m=/^RULE_NOTICE_RECEIPT:([1-9][0-9]{0,15}):([a-f0-9]{64})$/u.exec(r?.reason??'');
    if(receipt.length!==1||!r||r.actorId!==a.actorId||r.policyVersion!==a.policyVersion||r.decision!=='ALLOW'||r.at!==o?.at||!m||!Number.isSafeInteger(Number(m[1]))||m[2]!==ruleNoticeDigest(notice)||starts.length!==1||start?.actorId!==a.actorId||start.reason!=='RULE_NOTICE_STARTED'||start.decision!=='ALLOW'||start.policyVersion!==a.policyVersion||!Number.isSafeInteger(start.at)||start.at<a.at||start.at>r.at||r.at>=start.at+30000)notice.delivery='UNKNOWN_OUTCOME';
   }
   out.push(notice);
  }catch{/* An invalid journal entry never authorizes a notification. */}
 }
 // A Telegram message id is scoped to its destination, not to a notice job.
 // Conflicting historical receipts cannot both prove delivery.
 const claims=new Map<string,Set<string>>();
 for(const n of out)for(const r of keyed.get(n.id+':receipt')??[]){const m=/^RULE_NOTICE_RECEIPT:([1-9][0-9]{0,15}):[a-f0-9]{64}$/u.exec(r.reason);if(!m)continue;const key=n.member+':'+m[1],ids=claims.get(key)??new Set<string>();ids.add(n.id);claims.set(key,ids);}
 for(const n of out){if(n.delivery!=='CONFIRMED')continue;const r=keyed.get(n.id+':receipt')?.[0],m=/^RULE_NOTICE_RECEIPT:([1-9][0-9]{0,15}):/u.exec(r?.reason??'');if(m&&(claims.get(n.member+':'+m[1])?.size??0)>1)n.delivery='UNKNOWN_OUTCOME';}
 return out;
}
export const ruleNoticeDigest=(n:RuleNotice)=>createHash('sha256').update(JSON.stringify({...n,delivery:'PENDING'})).digest('hex');
export class RuleNoticeDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly service:ModerationService,private readonly sender:TelegramReplySender,private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 private eligible(s:BotState,n:RuleNotice,now:number):boolean{const p=ruleWarningPolicy(s,n.chat,n.reference,now);return (p.status==='CONFIGURED'?p.policy.revision:p.status==='NONE'?0:-1)===n.policyRevision&&Number.isSafeInteger(now)&&now>=n.at&&now<n.at+120000&&now<n.expiresAt&&n.version===this.policy.chatRevision(s,n.chat)&&this.policy.canUseChat(s,n.chat,'moderation')&&this.policy.has(s,n.actor,'chat.manage',n.chat,now)&&(!this.policy.isOwner(n.actor)||this.policy.privateFeature(s,'owner.dashboard',n.actor))&&n.member!==n.actor&&n.member!==this.policy.ownerId&&!this.policy.has(s,n.member,'chat.manage',n.chat,now)&&!!groupRuleDescription(s,n.chat,n.reference,true)&&!exemptFromRule(s,n.chat,n.member,n.reference,now)&&ruleActionAllowed(s,n.chat,n.reference,'notice',now)&&ruleNotices(s,now).some(r=>r.id===n.id&&r.delivery==='PENDING'&&ruleNoticeDigest(r)===ruleNoticeDigest(n));}
 private started(s:BotState,n:RuleNotice,now:number):boolean{const rows=s.audit.filter(a=>a.updateKey===n.id+':started'),a=rows[0];return rows.length===1&&a?.actorId===n.actor&&a.decision==='ALLOW'&&a.reason==='RULE_NOTICE_STARTED'&&a.policyVersion===n.version&&Number.isSafeInteger(a.at)&&a.at>=n.at&&now>=a.at&&now<a.at+30000&&!s.audit.some(a=>a.updateKey===n.id+':outcome');}
 async drain(limit=5):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('RULE_NOTICE_LIMIT_INVALID');let sent=0;
  for(let i=0;i<limit;i++){
   if(!await this.safety())break;
   const job=await this.store.transaction(s=>{const now=this.clock();if(!Number.isSafeInteger(now)||now<0)return null;
    const n=ruleNotices(s,now).find(n=>n.delivery==='PENDING');if(!n)return null;
    const starts=s.audit.filter(a=>a.updateKey===n.id+':started');
    if(starts.length){if(this.started(s,n,now))return null;this.record(s,n,'UNKNOWN_OUTCOME',now);return 'SKIP' as const;}
    if(!this.eligible(s,n,now)){this.record(s,n,'CANCELLED',now);return 'SKIP' as const;}
    s.audit.push({actorId:n.actor,updateKey:n.id+':started',decision:'ALLOW',reason:'RULE_NOTICE_STARTED',policyVersion:n.version,at:now});return n;
   });if(!job)break;if(job==='SKIP')continue;
   const allowed=await this.service.canReviewCommand(job.actor,job.chat,job.member),running=await this.safety(),s=await this.store.snapshot(),now=this.clock();
   if(!allowed||!running||!this.eligible(s,job,now)||!this.started(s,job,now)){await this.finish(job,'CANCELLED');continue;}
   const description=groupRuleDescription(s,job.chat,job.reference,true)!.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));let result:TelegramSendResult;
   try{result=await this.sender.send({chatId:job.member,parseMode:'HTML',text:'<b>تنبيه أول بخصوص قوانين المجموعة</b>\nالمجموعة: '+job.chat+'\n'+description+'\nمرجع الرسالة: '+job.reference+'\nهذا تنبيه خاص دون إنذار محتسب أو تقييد. راجع الفقرة قبل المشاركة مجددًا.'});}catch{result={status:'UNKNOWN_OUTCOME'};}
   await this.finish(job,result.status==='CONFIRMED'&&Number.isSafeInteger(result.messageId)&&result.messageId>0?'CONFIRMED':result.status==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME',result.status==='CONFIRMED'?result.messageId:undefined);sent++;
  }return sent;
 }
 private record(s:BotState,n:RuleNotice,status:RuleNotice['delivery'],now:number):void{if(s.audit.some(a=>a.updateKey===n.id+':outcome'))return;s.audit.push({actorId:n.actor,updateKey:n.id+':outcome',decision:'NOOP',reason:'RULE_NOTICE_'+status,policyVersion:n.version,at:Number.isSafeInteger(now)&&now>=n.at?now:n.at});}
 private async finish(n:RuleNotice,status:RuleNotice['delivery'],messageId?:number):Promise<void>{await this.store.transaction(s=>{const now=this.clock(),safe=this.started(s,n,now)&&this.eligible(s,n,now);
  const reused=status==='CONFIRMED'&&messageId!==undefined&&ruleNotices(s,now).some(other=>other.id!==n.id&&other.member===n.member&&s.audit.some(a=>a.updateKey===other.id+':receipt'&&a.reason.startsWith('RULE_NOTICE_RECEIPT:'+messageId+':')));
  if(safe&&!reused&&status==='CONFIRMED'&&messageId!==undefined)s.audit.push({actorId:n.actor,updateKey:n.id+':receipt',decision:'ALLOW',reason:'RULE_NOTICE_RECEIPT:'+messageId+':'+ruleNoticeDigest(n),policyVersion:n.version,at:now});this.record(s,n,safe&&!reused?status:'UNKNOWN_OUTCOME',now);});}
}
