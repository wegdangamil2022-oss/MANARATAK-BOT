import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {forumUnresolvedReviewProof,acknowledgeUnresolvedForumAttempt,
 forumUnresolvedReviewHistory,type ForumUnresolvedKind,
 type ForumUnresolvedDisposition} from './group-forum-unresolved-review.js';

const PREFIX='group-forum:unresolved-preview:',TTL=120000;
const TOKEN='([A-Za-z0-9_-]{24})',G='(-[1-9][0-9]{0,15})',
 T='([1-9][0-9]{0,9})',PAGE='(0|[1-9][0-9]{0,2})';
export const FORUM_REVIEW_CONFIRM=new RegExp('^ft:1:A:'+TOKEN+'$','u');
export const FORUM_REVIEW_CANCEL=new RegExp('^ft:1:B:'+TOKEN+'$','u');
export const FORUM_REVIEW_HISTORY=new RegExp('^ft:1:C:'+G+':'+T+':'+PAGE+'$','u');
export function validOwnerForumReviewRoute(x:unknown):x is string{
 return typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&
  (FORUM_REVIEW_CONFIRM.test(x)||FORUM_REVIEW_CANCEL.test(x)||
   FORUM_REVIEW_HISTORY.test(x));
}
const user=(s:unknown):s is string=>typeof s==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const group=(s:unknown):s is string=>typeof s==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const topic=(n:unknown):n is number=>typeof n==='number'&&
 Number.isSafeInteger(n)&&n>1&&n<=2147483647;
const time=(n:unknown):n is number=>typeof n==='number'&&
 Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000-TTL;
const kind=(v:unknown):v is ForumUnresolvedKind=>
 v==='CONTROL'||v==='BROADCAST';
const disposition=(v:unknown):v is ForumUnresolvedDisposition=>
 v==='ACKNOWLEDGED_UNRESOLVED'||v==='ESCALATED';
const b=(text:string,callback_data:string)=>({text,callback_data});
const screen=(text:string,rows:{text:string;callback_data:string}[][]):
 OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
type Pending={group:string;thread:number;kind:ForumUnresolvedKind;
 attempt:string;decision:ForumUnresolvedDisposition;
 proof:string;version:number;createdAt:number};
function parse(raw:unknown):Pending|null{
 if(typeof raw!=='string'||!raw.startsWith(PREFIX))return null;
 let x:unknown;
 try{x=JSON.parse(raw.slice(PREFIX.length));}catch{return null;}
 if(!x||typeof x!=='object'||Array.isArray(x))return null;
 const v=x as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!==
  'attempt,createdAt,decision,group,kind,proof,thread,version'||
  !group(v.group)||!topic(v.thread)||!kind(v.kind)||!disposition(v.decision)||
  typeof v.attempt!=='string'||!/^[A-Za-z0-9_-]{24}$/u.test(v.attempt)||
  typeof v.proof!=='string'||!/^[a-f0-9]{64}$/u.test(v.proof)||
  !Number.isSafeInteger(v.version)||Number(v.version)<1||
  !time(v.createdAt))return null;
 return v as unknown as Pending;
}
const label=(x:ForumUnresolvedDisposition)=>x==='ESCALATED'?
 'تصعيد للمراجعة اليدوية':'إقرار الاطلاع دون حسم النتيجة';

export class TelegramOwnerForumReview{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly now:()=>number=Date.now){}
 async prepare(actor:string,g:string,t:number,
  k:ForumUnresolvedKind,attempt:string,decision:ForumUnresolvedDisposition):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const at=this.now();
   if(!user(actor)||!this.policy.isOwner(actor)||!group(g)||!topic(t)||
    !time(at)||!kind(k)||!disposition(decision))return null;
   const proof=forumUnresolvedReviewProof(s,this.policy,actor,g,t,k,
    attempt,decision,at);
   if(!proof)return null;
   const groupRecord=s.chats.filter(c=>c.id===g),current=groupRecord[0];
   if(groupRecord.length!==1||!current||!current.approved||
    !current.present||!Number.isSafeInteger(current.version))return null;
   const pending=s.callbacks.filter(c=>c.actorId===actor&&
    c.ref.startsWith(PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>at);
   if(pending.length>=64)return null;
   const token=randomBytes(18).toString('base64url'),ref=PREFIX+token;
   if(s.callbacks.some(c=>c.ref===ref))return null;
   for(const c of pending)c.revoked=true;
   const value:Pending={group:g,thread:t,kind:k,attempt,decision,proof,
    version:current.version,createdAt:at};
   s.callbacks.push({ref,action:PREFIX+JSON.stringify(value),
    actorId:actor,chatId:'private',policyVersion:current.version,
    expiresAt:at+TTL,oneShot:true,used:false,revoked:false});
   return screen('<b>🔎 مراجعة محاولة Telegram غير المحسومة</b>\n'+
    'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
    'نوع العملية: '+(k==='CONTROL'?'إغلاق أو إعادة فتح':'نشر تعليمي')+'\n'+
    'رقم المحاولة: <code>'+attempt+'</code>\n'+
    'الإجراء الإداري: '+label(decision)+'\n'+
    '⚠️ هذا قرار توثيق إداري، **لا** يغير النتيجة المسجلة، **ولا** يفك الحجر، '+
    'ولا يجيز إعادة الإرسال أو تنفيذ الإجراء مرة أخرى.\n'+
    'الموافقة خاصة ولمرة واحدة وصالحة لدقيقتين.',
    [[b('✅ حفظ قرار المراجعة دون إعادة التنفيذ','ft:1:A:'+token)],
     [b('✖ إلغاء','ft:1:B:'+token)],
     [b('↩️ سجل المراجعات','ft:1:C:'+g+':'+t+':0)]]);
  });
 }
 private async decide(actor:string,token:string,apply:boolean):
 Promise<OwnerInlineScreen|null>{
  const outcome=await this.store.transaction(s=>{
   const at=this.now(),ref=PREFIX+token,
    matches=s.callbacks.filter(c=>c.ref===ref),callback=matches[0];
   if(!time(at)||!user(actor)||!this.policy.isOwner(actor)||
    matches.length!==1||!callback||callback.actorId!==actor||
    callback.chatId!=='private'||!callback.oneShot||callback.used||
    callback.revoked||!time(callback.expiresAt)||
    callback.expiresAt<=at||callback.expiresAt>at+TTL)return null;
   const p=parse(callback.action),chats=p?s.chats.filter(c=>c.id===p.group):[];
   if(!p||p.createdAt>at||callback.expiresAt!==p.createdAt+TTL||
    callback.policyVersion!==p.version||
    chats.length!==1||chats[0]!.version!==p.version)return null;
   if(apply&&!acknowledgeUnresolvedForumAttempt(s,this.policy,actor,
    p.group,p.thread,p.kind,p.attempt,p.decision,at,p.proof))return null;
   callback.used=true;
   return {group:p.group,thread:p.thread};
  });
  if(!outcome)return null;
  return this.history(actor,outcome.group,outcome.thread,0);
 }
 async history(actor:string,g:string,t:number,page:number):
 Promise<OwnerInlineScreen|null>{
  const s=await this.store.snapshot(),now=this.now();
  if(!time(now)||!Number.isSafeInteger(page)||page<0||page>999)return null;
  const list=forumUnresolvedReviewHistory(s,this.policy,actor,g,t,now);
  if(!list)return null;
  const pages=Math.max(1,Math.ceil(list.length/8));
  if(page>=pages)return null;
  const lines=list.slice(page*8,(page+1)*8).map(x=>
   '▫️ '+(x.kind==='CONTROL'?'إدارة موضوع':'نشر تعليمي')+
   ' · <code>'+x.attempt+'</code> · '+label(x.decision)+' · '+
   new Date(x.at).toISOString().slice(0,16).replace('T',' ')+' UTC');
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(b('⬅️ السابق','ft:1:C:'+g+':'+t+':'+(page-1)));
  if(page+1<pages)nav.push(b('➡️ التالي','ft:1:C:'+g+':'+t+':'+(page+1)));
  return screen('<b>📋 مراجعات المحاولات غير المحسومة</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'إجمالي المراجعات الإدارية: '+list.length+
   ' · صفحة '+(page+1)+'/'+pages+'\n'+
   (lines.length?lines.join('\n'):'لا توجد مراجعات محفوظة.')+'\n'+
   'لإقرار الاطلاع على محاولة مجهولة دون إعادة تنفيذها:\n'+
   '<code>/topicreview '+g+' '+t+' control|broadcast ATTEMPT acknowledge|escalate</code>\n'+
   'الإقرار لا يزيل الحجر؛ التدقيق في سجل العمليات منفصل.',
   [...(nav.length?[nav]:[]),[b('↩️ الموضوع','ft:1:d:'+g+':'+t)]]);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!user(actor)||!this.policy.isOwner(actor)||
   !validOwnerForumReviewRoute(data))return null;
  const confirmed=FORUM_REVIEW_CONFIRM.exec(data);
  if(confirmed)return this.decide(actor,confirmed[1]!,true);
  const cancelled=FORUM_REVIEW_CANCEL.exec(data);
  if(cancelled)return this.decide(actor,cancelled[1]!,false);
  const list=FORUM_REVIEW_HISTORY.exec(data);
  return list?this.history(actor,list[1]!,Number(list[2]),Number(list[3])):null;
 }
}
