import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {TelegramReplySender} from './telegram-replies.js';
import {isCanonicalSubscriptionRule} from './subscription-integrity.js';

const ROOT='subscription:change-alert:',DAY=86400000,ATTEMPT=30000;
const groupId=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const person=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const time=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=8640000000000000;
type Delivery='PENDING'|'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED';
export type SubscriptionChangeAlert={id:string;actor:string;group:string;removed:string[];added:string[];ruleVersion:number;scopeVersion:number;at:number;delivery:Delivery;lostChannel?:string;identityChannel?:string;identityChange?:string};
const digest=(v:SubscriptionChangeAlert)=>createHash('sha256').update(JSON.stringify([v.id,v.actor,v.group,v.removed,v.added,v.ruleVersion,v.scopeVersion,v.at,...(v.lostChannel?[v.lostChannel]:[]),...(v.identityChannel?[v.identityChannel,v.identityChange]:[])])).digest('hex');
const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=10&&v.every(groupId)&&new Set(v).size===v.length;

/** Call from the same transaction as the confirmed configuration change. */
export function recordSubscriptionChannelChange(s:BotState,actor:string,group:string,before:string[],after:string[],ruleVersion:number,scopeVersion:number,at:number):void{
 if(!person(actor)||!groupId(group)||!ids(before)||!ids(after)||!Number.isSafeInteger(ruleVersion)||ruleVersion<2||!Number.isSafeInteger(scopeVersion)||scopeVersion<1||!time(at))return;
 const removed=before.filter(id=>!after.includes(id)),added=after.filter(id=>!before.includes(id));if(!removed.length&&!added.length)return;
 const key=ROOT+group+':'+ruleVersion;if(s.audit.some(a=>a.updateKey===key))return;
 s.audit.push({actorId:actor,updateKey:key,decision:'ALLOW',reason:'SUBSCRIPTION_CHANGE_ALERT:'+JSON.stringify({group,removed,added,ruleVersion}),policyVersion:scopeVersion,at});
}
export function recordSubscriptionRightsLoss(s:BotState,actor:string,group:string,channel:string,ruleVersion:number,scopeVersion:number,at:number):void{
 if(!person(actor)||!groupId(group)||!groupId(channel)||!Number.isSafeInteger(ruleVersion)||ruleVersion<1||!Number.isSafeInteger(scopeVersion)||scopeVersion<1||!time(at))return;
 const slot=Math.floor(at/3600000),key=ROOT+'rights:'+createHash('sha256').update(JSON.stringify([group,channel,ruleVersion,scopeVersion,slot])).digest('hex');
 if(s.audit.some(a=>a.updateKey===key))return;
 s.audit.push({actorId:actor,updateKey:key,decision:'ALLOW',reason:'SUBSCRIPTION_RIGHTS_ALERT:'+JSON.stringify({group,channel,ruleVersion,slot}),policyVersion:scopeVersion,at});
}
export function recordSubscriptionIdentityChange(s:BotState,actor:string,group:string,channel:string,ruleVersion:number,scopeVersion:number,from:string,to:string,at:number):void{
 if(!person(actor)||!groupId(group)||!groupId(channel)||!Number.isSafeInteger(ruleVersion)||ruleVersion<1||!Number.isSafeInteger(scopeVersion)||scopeVersion<1||!time(at)||!/^[a-f0-9]{64}$/u.test(from)||!/^[a-f0-9]{64}$/u.test(to)||from===to)return;
 const slot=Math.floor(at/3600000),key=ROOT+'identity:'+createHash('sha256').update(JSON.stringify([group,channel,ruleVersion,scopeVersion,from,to,slot])).digest('hex');if(s.audit.some(a=>a.updateKey===key))return;
 s.audit.push({actorId:actor,updateKey:key,decision:'ALLOW',reason:'SUBSCRIPTION_IDENTITY_ALERT:'+JSON.stringify({group,channel,ruleVersion,from,to,slot}),policyVersion:scopeVersion,at});
}

export function subscriptionChangeAlerts(s:BotState,now:number):SubscriptionChangeAlert[]{
 if(!time(now))return [];const keyed=new Map<string,typeof s.audit>();for(const a of s.audit){const rows=keyed.get(a.updateKey)??[];rows.push(a);keyed.set(a.updateKey,rows);}
 const out:SubscriptionChangeAlert[]=[];
 for(const a of s.audit){
  const identity=/^subscription:change-alert:identity:[a-f0-9]{64}$/u.test(a.updateKey),rights=/^subscription:change-alert:rights:[a-f0-9]{64}$/u.test(a.updateKey),change=/^subscription:change-alert:-[1-9][0-9]{0,15}:[1-9][0-9]{0,15}$/u.test(a.updateKey),prefix=identity?'SUBSCRIPTION_IDENTITY_ALERT:':rights?'SUBSCRIPTION_RIGHTS_ALERT:':'SUBSCRIPTION_CHANGE_ALERT:';
  if((!identity&&!rights&&!change)||keyed.get(a.updateKey)?.length!==1||a.decision!=='ALLOW'||!person(a.actorId)||!Number.isSafeInteger(a.policyVersion)||a.policyVersion<1||!time(a.at)||a.at>now||!a.reason.startsWith(prefix))continue;
  try{const raw:unknown=JSON.parse(a.reason.slice(prefix.length));if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;const v=raw as Record<string,unknown>;
   if(!groupId(v.group)||!Number.isSafeInteger(v.ruleVersion)||Number(v.ruleVersion)<(rights||identity?1:2))continue;
   let removed:string[]=[],added:string[]=[],lostChannel:string|undefined,identityChannel:string|undefined,identityChange:string|undefined;
   if(identity){if(Object.keys(v).sort().join(',')!=='channel,from,group,ruleVersion,slot,to'||!groupId(v.channel)||typeof v.from!=='string'||typeof v.to!=='string'||!/^[a-f0-9]{64}$/u.test(v.from)||!/^[a-f0-9]{64}$/u.test(v.to)||v.from===v.to||v.slot!==Math.floor(a.at/3600000)||a.updateKey!==ROOT+'identity:'+createHash('sha256').update(JSON.stringify([v.group,v.channel,v.ruleVersion,a.policyVersion,v.from,v.to,v.slot])).digest('hex'))continue;identityChannel=v.channel;identityChange=v.from+':'+v.to;}
   else if(rights){if(Object.keys(v).sort().join(',')!=='channel,group,ruleVersion,slot'||!groupId(v.channel)||v.slot!==Math.floor(a.at/3600000)||a.updateKey!==ROOT+'rights:'+createHash('sha256').update(JSON.stringify([v.group,v.channel,v.ruleVersion,a.policyVersion,v.slot])).digest('hex'))continue;lostChannel=v.channel;}
   else{if(Object.keys(v).sort().join(',')!=='added,group,removed,ruleVersion'||!ids(v.removed)||!ids(v.added)||!v.removed.length&&!v.added.length||a.updateKey!==ROOT+v.group+':'+v.ruleVersion)continue;removed=v.removed;added=v.added;if(removed.some(x=>added.includes(x)))continue;}
   const alert:SubscriptionChangeAlert={id:a.updateKey,actor:a.actorId,group:v.group,removed,added,ruleVersion:Number(v.ruleVersion),scopeVersion:a.policyVersion,at:a.at,delivery:'PENDING',...(lostChannel?{lostChannel}:{}),...(identityChannel?{identityChannel,identityChange:identityChange!}:{})};
   const outcomes=keyed.get(a.updateKey+':outcome')??[],o=outcomes[0];if(outcomes.length)alert.delivery=outcomes.length===1&&o?.actorId===a.actorId&&o.decision==='NOOP'&&o.policyVersion===a.policyVersion&&time(o.at)&&o.at>=a.at&&o.at<=now&&/^SUBSCRIPTION_CHANGE_ALERT_(CONFIRMED|FAILED_CONFIRMED|UNKNOWN_OUTCOME|CANCELLED)$/u.test(o.reason)?o.reason.slice('SUBSCRIPTION_CHANGE_ALERT_'.length) as Delivery:'UNKNOWN_OUTCOME';
   if(alert.delivery==='CONFIRMED'){
    const starts=keyed.get(a.updateKey+':started')??[],start=starts[0],receipts=keyed.get(a.updateKey+':receipt')??[],receipt=receipts[0],m=/^SUBSCRIPTION_CHANGE_RECEIPT:([1-9][0-9]{0,15}):([a-f0-9]{64})$/u.exec(receipt?.reason??'');
    if(starts.length!==1||!start||start.actorId!==a.actorId||start.decision!=='ALLOW'||start.reason!=='SUBSCRIPTION_CHANGE_ALERT_STARTED'||start.policyVersion!==a.policyVersion||!time(start.at)||start.at<a.at||receipts.length!==1||!receipt||receipt.actorId!==a.actorId||receipt.decision!=='ALLOW'||receipt.policyVersion!==a.policyVersion||receipt.at!==o?.at||receipt.at<start.at||receipt.at>=start.at+ATTEMPT||!m||!Number.isSafeInteger(Number(m[1]))||m[2]!==digest(alert))alert.delivery='UNKNOWN_OUTCOME';
   }
   out.push(alert);
  }catch{/* malformed records are never sent */}
 }
 const claims=new Map<string,Set<string>>();for(const a of out)for(const r of keyed.get(a.id+':receipt')??[]){const m=/^SUBSCRIPTION_CHANGE_RECEIPT:([1-9][0-9]{0,15}):[a-f0-9]{64}$/u.exec(r.reason);if(m){const owners=claims.get(m[1]!)??new Set<string>();owners.add(a.id);claims.set(m[1]!,owners);}}
 for(const a of out){if(a.delivery!=='CONFIRMED')continue;const m=/^SUBSCRIPTION_CHANGE_RECEIPT:([1-9][0-9]{0,15}):/u.exec(keyed.get(a.id+':receipt')?.[0]?.reason??'');if(m&&(claims.get(m[1]!)?.size??0)>1)a.delivery='UNKNOWN_OUTCOME';}
 return out;
}

export class SubscriptionChangeAlertDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly sender:TelegramReplySender,private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 private eligible(s:BotState,a:SubscriptionChangeAlert,now:number):boolean{const rules=s.subscriptionRequirements.filter(r=>r.chatId===a.group),rule=rules[0],channel=a.lostChannel??a.identityChannel;return time(now)&&now>=a.at&&now<a.at+DAY&&this.policy.isOwner(a.actor)&&this.policy.privateFeature(s,'owner.dashboard',a.actor)&&this.policy.canUseChat(s,a.group,'verification')&&this.policy.chatRevision(s,a.group)===a.scopeVersion&&(!channel||rules.length===1&&isCanonicalSubscriptionRule(rule)&&rule.version===a.ruleVersion&&rule.channelIds.includes(channel)&&this.policy.canUseChat(s,channel,'verification'))&&subscriptionChangeAlerts(s,now).some(v=>v.id===a.id&&v.delivery==='PENDING'&&digest(v)===digest(a));}
 private started(s:BotState,a:SubscriptionChangeAlert,now:number):boolean{const rows=s.audit.filter(v=>v.updateKey===a.id+':started'),v=rows[0];return rows.length===1&&v?.actorId===a.actor&&v.decision==='ALLOW'&&v.reason==='SUBSCRIPTION_CHANGE_ALERT_STARTED'&&v.policyVersion===a.scopeVersion&&time(v.at)&&v.at>=a.at&&now>=v.at&&now<v.at+ATTEMPT&&!s.audit.some(x=>x.updateKey===a.id+':outcome');}
 private record(s:BotState,a:SubscriptionChangeAlert,status:Exclude<Delivery,'PENDING'>,now:number):void{if(!s.audit.some(v=>v.updateKey===a.id+':outcome'))s.audit.push({actorId:a.actor,updateKey:a.id+':outcome',decision:'NOOP',reason:'SUBSCRIPTION_CHANGE_ALERT_'+status,policyVersion:a.scopeVersion,at:time(now)&&now>=a.at?now:a.at});}
 private defer(s:BotState,a:SubscriptionChangeAlert,now:number):void{if(this.started(s,a,now)&&this.eligible(s,a,now)){s.audit=s.audit.filter(v=>v.updateKey!==a.id+':started');s.audit.push({actorId:a.actor,updateKey:a.id+':deferred:'+randomBytes(12).toString('hex'),decision:'NOOP',reason:'SUBSCRIPTION_CHANGE_ALERT_DEFERRED',policyVersion:a.scopeVersion,at:now});}else this.record(s,a,'CANCELLED',now);}
 async drain(limit=5):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('SUBSCRIPTION_CHANGE_ALERT_LIMIT_INVALID');if(!this.sender.sendTemporaryPrivate)return 0;let sent=0;const running=async()=>{try{return await this.safety()===true;}catch{return false;}};
  for(let i=0;i<limit;i++){
   if(!await running())break;
   const a=await this.store.transaction(s=>{const now=this.clock();if(!time(now))return null;const item=subscriptionChangeAlerts(s,now).find(v=>v.delivery==='PENDING');if(!item)return null;
    if(s.audit.some(v=>v.updateKey===item.id+':started')){if(this.started(s,item,now))return null;this.record(s,item,'UNKNOWN_OUTCOME',now);return 'SKIP' as const;}
    if(!this.eligible(s,item,now)){this.record(s,item,'CANCELLED',now);return 'SKIP' as const;}s.audit.push({actorId:item.actor,updateKey:item.id+':started',decision:'ALLOW',reason:'SUBSCRIPTION_CHANGE_ALERT_STARTED',policyVersion:item.scopeVersion,at:now});return item;});
   if(!a)break;if(a==='SKIP')continue;
   if(!await running()){
    await this.store.transaction(s=>this.defer(s,a,this.clock()));break;
   }
   const snapshot=await this.store.snapshot(),now=this.clock();if(!this.started(snapshot,a,now)||!this.eligible(snapshot,a,now)){await this.store.transaction(s=>this.record(s,a,'CANCELLED',this.clock()));continue;}
   let status:Exclude<Delivery,'PENDING'>='UNKNOWN_OUTCOME',messageId:number|undefined,authorizedAtSend=false,notSent=false;
   try{const result=await this.sender.sendTemporaryPrivate({chatId:a.actor,parseMode:'HTML',text:a.identityChannel?'<b>تغير المعرف العام أو الأسماء البديلة لقناة الاشتراك</b>\nالمجموعة: '+a.group+'\nالقناة: '+a.identityChannel+'\nرُصد تغير المعرّف العام أو أحد أسمائه البديلة من بيانات القناة ذات المعرّف الرقمي نفسه. راجع روابط الاشتراك؛ لا تتغير القائمة أو قيود الأعضاء تلقائيًا.':a.lostChannel?'<b>صلاحية قناة الاشتراك</b>\nالمجموعة: '+a.group+'\nالقناة: '+a.lostChannel+'\nرُصد أن البوت ليس مشرفًا فيها. تحقق من الصلاحيات؛ لا يعني ذلك أن أي عضو مخالف.':'<b>تغيير قنوات الاشتراك</b>\nالمجموعة: '+a.group+'\nإصدار القاعدة: '+a.ruleVersion+(a.removed.length?'\nأزيلت: '+a.removed.join('، '):'')+(a.added.length?'\nأضيفت: '+a.added.join('، '):'')+'\nهذا سجل تغيير للقائمة؛ لا يثبت أن الجهتين قناة واحدة ولا يغير قيود الأعضاء.'},async()=>{if(!await running())return false;const state=await this.store.snapshot(),at=this.clock();const ok=this.started(state,a,at)&&this.eligible(state,a,at)&&await running();if(ok)authorizedAtSend=true;return ok;});if(result.status==='CONFIRMED'&&authorizedAtSend&&Number.isSafeInteger(result.messageId)&&result.messageId>0){status='CONFIRMED';messageId=result.messageId;}else if(result.status==='FAILED_CONFIRMED'&&!authorizedAtSend)notSent=true;else if(result.status==='FAILED_CONFIRMED'||result.status==='PRIVATE_UNAVAILABLE')status='FAILED_CONFIRMED';}catch{/* unknown send outcome is not retried */}
   if(notSent){await this.store.transaction(s=>this.defer(s,a,this.clock()));break;}
   await this.store.transaction(s=>{const at=this.clock(),safe=this.started(s,a,at)&&this.eligible(s,a,at),reused=status==='CONFIRMED'&&messageId!==undefined&&subscriptionChangeAlerts(s,at).some(x=>x.id!==a.id&&s.audit.some(r=>r.updateKey===x.id+':receipt'&&r.reason.startsWith('SUBSCRIPTION_CHANGE_RECEIPT:'+messageId+':')));if(safe&&!reused&&status==='CONFIRMED'&&messageId!==undefined)s.audit.push({actorId:a.actor,updateKey:a.id+':receipt',decision:'ALLOW',reason:'SUBSCRIPTION_CHANGE_RECEIPT:'+messageId+':'+digest(a),policyVersion:a.scopeVersion,at});this.record(s,a,safe&&!reused?status:'UNKNOWN_OUTCOME',at);});sent++;
  }return sent;
 }
}
