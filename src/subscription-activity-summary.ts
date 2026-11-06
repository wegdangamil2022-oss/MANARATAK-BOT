import {createHash} from 'node:crypto';
import type {BotState,TelegramReplyJob} from './store.js';

type DeliveryKind='MESSAGE'|'EPHEMERAL';
const validTime=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=8640000000000000;
const outcome=(v:string)=>/^SUBSCRIPTION_METRIC_(MEMBER|NOT_MEMBER|UNAVAILABLE|NOT_REQUIRED|DENIED)$/u.test(v);
const deliveryProof=(job:TelegramReplyJob,kind:DeliveryKind)=>createHash('sha256').update(JSON.stringify([job.updateKey,job.attemptId,job.startedAt,kind,job.messageId??null])).digest('hex');
const deliveryValid=(job:TelegramReplyJob,kind:DeliveryKind)=>job.status==='SENT'&&typeof job.attemptId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(job.attemptId)&&validTime(job.startedAt)&&(kind==='MESSAGE'?Number.isSafeInteger(job.messageId)&&Number(job.messageId)>0:job.messageId===undefined);
/** Call only in the transaction that persists a confirmed provider response. */
export function recordSubscriptionDelivery(s:BotState,job:TelegramReplyJob,kind:DeliveryKind,at:number):void{
 if(!validTime(at)||!deliveryValid(job,kind)||at<job.startedAt!||s.audit.some(a=>a.updateKey===job.updateKey+':subscription-delivered'))return;
 const metrics=s.audit.filter(a=>a.updateKey===job.updateKey+':subscription-metric'),metric=metrics[0];
 if(metrics.length!==1||!metric||metric.actorId!==undefined||metric.decision!=='ALLOW'||metric.policyVersion!==0||!outcome(metric.reason)||!validTime(metric.at)||metric.at>job.startedAt!)return;
 s.audit.push({updateKey:job.updateKey+':subscription-delivered',decision:'ALLOW',reason:'SUBSCRIPTION_DELIVERY_'+kind+':'+deliveryProof(job,kind),policyVersion:0,at});
}

/** Aggregate only retained, uniquely witnessed results. No member or chat IDs. */
export function summarizeSubscriptionActivity(s:BotState,now:number):{member:number;notMember:number;unavailable:number;notRequired:number;denied:number;deliveryConfirmed:number;deliveryUnresolved:number;available:boolean}{
 const result={member:0,notMember:0,unavailable:0,notRequired:0,denied:0,deliveryConfirmed:0,deliveryUnresolved:0,available:Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000};
 if(!result.available)return result;
 const byKey=new Map<string,typeof s.audit>();for(const row of s.audit){const rows=byKey.get(row.updateKey)??[];rows.push(row);byKey.set(row.updateKey,rows);}
 const jobsByKey=new Map<string,TelegramReplyJob[]>();for(const job of s.telegramReplyJobs??[]){const rows=jobsByKey.get(job.updateKey)??[];rows.push(job);jobsByKey.set(job.updateKey,rows);}
 for(const row of s.audit){
  const match=/^(b3-webhook:[a-zA-Z0-9_-]{1,80}:\d+):subscription-metric$/u.exec(row.updateKey);
  if(!match||byKey.get(row.updateKey)?.length!==1||row.actorId!==undefined||row.decision!=='ALLOW'||row.policyVersion!==0||!Number.isSafeInteger(row.at)||row.at<0||row.at>now||row.at<now-86400000)continue;
  const source=byKey.get(match[1]!)??[],parent=source[0];if(source.length!==1||!parent||parent.reason!=='SUBSCRIPTION_VERIFICATION_VIEW'||parent.decision!=='ALLOW'||parent.at!==row.at)continue;
  if(!outcome(row.reason))continue;
  switch(row.reason){case 'SUBSCRIPTION_METRIC_MEMBER':result.member++;break;case 'SUBSCRIPTION_METRIC_NOT_MEMBER':result.notMember++;break;case 'SUBSCRIPTION_METRIC_UNAVAILABLE':result.unavailable++;break;case 'SUBSCRIPTION_METRIC_NOT_REQUIRED':result.notRequired++;break;case 'SUBSCRIPTION_METRIC_DENIED':result.denied++;break;}
  const jobs=jobsByKey.get(match[1]!)??[],job=jobs[0],receipts=byKey.get(match[1]+':subscription-delivered')??[],receipt=receipts[0],m=/^SUBSCRIPTION_DELIVERY_(MESSAGE|EPHEMERAL):([a-f0-9]{64})$/u.exec(receipt?.reason??'');
  if(jobs.length===1&&job&&receipts.length===1&&receipt&&receipt.actorId===undefined&&receipt.decision==='ALLOW'&&receipt.policyVersion===0&&validTime(receipt.at)&&receipt.at<=now&&m&&deliveryValid(job,m[1] as DeliveryKind)&&job.startedAt!>=row.at&&receipt.at>=job.startedAt!&&m[2]===deliveryProof(job,m[1] as DeliveryKind))result.deliveryConfirmed++;else result.deliveryUnresolved++;
 }
 return result;
}
