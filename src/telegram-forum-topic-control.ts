import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';
import {forumTopicActionProof,startForumTopicAction,
 stillAuthorizedForumTopicAction,finishForumTopicAction,
 forumTopicActionHistory,type ForumTopicAction,type ForumTopicActionOutcome,
 type ForumTopicControlRecord} from './group-forum-topic-control.js';
import {forumTopicGroupAccess,localForumTopics} from './group-forum-topics.js';

/** TOPIC-005: a private owner review with TWO distinct approvals.
 * No action is attempted unless Telegram confirms both bot and human
 * manage_topics rights and the local durable start receipt is committed.
 * A crashed/unknown attempt is never re-queued.
 */
const PREFIX='group-forum:control-preview:',TTL=120_000;
const GROUP='(-[1-9][0-9]{0,15})',THREAD='([1-9][0-9]{0,9})',
 TOKEN='([A-Za-z0-9_-]{24})',PAGE='(0|[1-9][0-9]{0,2})';
export const TOPIC_CONTROL_CHOICE=
 new RegExp('^ft:1:u:'+GROUP+':'+THREAD+':([co])$','u');
export const TOPIC_CONTROL_FIRST=new RegExp('^ft:1:1:'+TOKEN+'$','u');
export const TOPIC_CONTROL_FINAL=new RegExp('^ft:1:2:'+TOKEN+'$','u');
export const TOPIC_CONTROL_CANCEL=new RegExp('^ft:1:0:'+TOKEN+'$','u');
export const TOPIC_CONTROL_HISTORY=
 new RegExp('^ft:1:9:'+GROUP+':'+THREAD+':'+PAGE+'$','u');
export const validForumTopicControlRoute=(d:unknown):d is string=>
 typeof d==='string'&&Buffer.byteLength(d,'utf8')<=64&&
 (TOPIC_CONTROL_CHOICE.test(d)||TOPIC_CONTROL_FIRST.test(d)||
  TOPIC_CONTROL_FINAL.test(d)||TOPIC_CONTROL_CANCEL.test(d)||
  TOPIC_CONTROL_HISTORY.test(d));
const id=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const person=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const thread=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>1&&v<=2147483647;
const clock=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-TTL;
const action=(v:unknown):v is ForumTopicAction=>v==='CLOSE'||v==='REOPEN';
const b=(text:string,callback_data:string)=>({text,callback_data});
const screen=(text:string,rows:{text:string;callback_data:string}[][]):
 OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
type Pending={group:string;thread:number;action:ForumTopicAction;
 proof:string;createdAt:number;version:number;stage:1|2};
function parse(raw:unknown):Pending|null{
 if(typeof raw!=='string'||!raw.startsWith(PREFIX))return null;
 let value:unknown;
 try{value=JSON.parse(raw.slice(PREFIX.length));}catch{return null;}
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='action,createdAt,group,proof,stage,thread,version'||
  !id(v.group)||!thread(v.thread)||!action(v.action)||
  (v.stage!==1&&v.stage!==2)||!clock(v.createdAt)||
  typeof v.proof!=='string'||!/^[a-f0-9]{64}$/u.test(v.proof)||
  typeof v.version!=='number'||!Number.isSafeInteger(v.version)||
  v.version<1)return null;
 return v as unknown as Pending;
}
const label=(x:ForumTopicAction)=>x==='CLOSE'?'إغلاق الموضوع':'إعادة فتح الموضوع';
const state=(x:ForumTopicActionOutcome|undefined):string=>
 x==='CONFIRMED'?'أكد Telegram تنفيذ الطلب':
 x==='FAILED_CONFIRMED'?'رفض التنفيذ دون نجاح مؤكد':
 x==='UNKNOWN_OUTCOME'?'نتيجة مجهولة — ممنوع تكرار الطلب':
 'لم تسجل نتيجة نهائية — ممنوع تكرار الطلب';

export class TelegramForumTopicControl{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway?:TelegramBotApiModerationGateway,
  private readonly safety:()=>Promise<boolean>=async()=>false,
  private readonly now:()=>number=Date.now){}
 private local(s:BotState,actor:string,g:string,t:number,at:number):number|null{
  if(!person(actor)||!this.policy.isOwner(actor)||!clock(at)||
   !id(g)||!thread(t))return null;
  const revision=forumTopicGroupAccess(s,this.policy,actor,g,at);
  const items=localForumTopics(s,this.policy,actor,g,at);
  if(revision===null||!items?.some(x=>x.threadId===t))return null;
  return revision;
 }
 private authentic():boolean{
  return this.gateway!==undefined&&
   TelegramBotApiModerationGateway.usesOfficialTopicControl(this.gateway);
 }
 private async safe():Promise<boolean>{
  try{return await this.safety()===true;}catch{return false;}
 }
 /** This is advisory before both private approvals and mandatory again
  * inside the official gateway immediately before writing to Telegram. */
 private async remote(g:string,actor:string):Promise<boolean>{
  if(!this.authentic()||!await this.safe())return false;
  try{
   if(await this.gateway!.inspectForumStatus(g)!=='FORUM'||
    !this.authentic()||!await this.safe())return false;
   if((await this.gateway!.inspectBotAdminRights(g)).manageTopics!=='GRANTED'||
    !this.authentic()||!await this.safe())return false;
   return await this.gateway!.inspectForumActorRights(g,actor)==='GRANTED'&&
    this.authentic()&&await this.safe();
  }catch{return false;}
 }
 private pending(s:BotState,actor:string,nonce:string,step:1|2,now:number):
 {callback:BotState['callbacks'][number];value:Pending}|null{
  const key=PREFIX+nonce,rows=s.callbacks.filter(c=>c.ref===key),c=rows[0];
  if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||
   !c.oneShot||c.used||c.revoked||!clock(c.expiresAt)||
   c.expiresAt<=now||c.expiresAt>now+TTL)return null;
  const value=parse(c.action);
  if(!value||value.stage!==step||value.createdAt>now||
   c.expiresAt!==value.createdAt+TTL||
   c.policyVersion!==value.version||
   this.local(s,actor,value.group,value.thread,now)!==value.version||
   forumTopicActionProof(s,this.policy,actor,value.group,value.thread,
    value.action,now)!==value.proof)return null;
  return {callback:c,value};
 }
 private add(s:BotState,actor:string,payload:Pending,at:number):string|null{
  if(!clock(at))return null;
  const active=s.callbacks.filter(c=>c.actorId===actor&&
   c.ref.startsWith(PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>at);
  if(active.length>=64)return null;
  const nonce=randomBytes(18).toString('base64url'),ref=PREFIX+nonce;
  if(s.callbacks.some(c=>c.ref===ref))return null;
  s.callbacks.push({ref,action:PREFIX+JSON.stringify(payload),
   actorId:actor,chatId:'private',policyVersion:payload.version,
   oneShot:true,used:false,revoked:false,expiresAt:at+TTL});
  for(const old of active)old.revoked=true;
  return nonce;
 }
 async prepare(actor:string,g:string,t:number,next:ForumTopicAction):
 Promise<OwnerInlineScreen|null>{
  const before=await this.store.snapshot(),at=this.now();
  const version=this.local(before,actor,g,t,at),
   proof=forumTopicActionProof(before,this.policy,actor,g,t,next,at);
  if(version===null||!proof||!await this.remote(g,actor))return null;
  const fresh=await this.store.snapshot(),current=this.now();
  if(!clock(current)||current<at||current>=at+TTL||
   forumTopicActionProof(fresh,this.policy,actor,g,t,next,current)!==proof)
   return null;
  return this.store.transaction(s=>{
   const now=this.now();
   if(!clock(now)||now<at||now>=at+TTL||
    this.local(s,actor,g,t,now)!==version||
    forumTopicActionProof(s,this.policy,actor,g,t,next,now)!==proof)
    return null;
   const nonce=this.add(s,actor,{group:g,thread:t,action:next,
    proof,version,createdAt:now,stage:1},now);
   if(!nonce)return null;
   return screen('<b>⚠️ معاينة عملية '+label(next)+'</b>\n'+
    'المجموعة: <code>'+g+'</code>\n'+
    'رقم الموضوع: <code>'+t+'</code>\n'+
    'Telegram يؤكد صلاحية البوت والمالك لحظة الفحص فقط.\n'+
    'لا توجد واجهة تحقق موثوقة من الحالة الحالية للموضوع نفسه؛ لذلك قد يرفض Telegram الطلب.\n'+
    'بعد الموافقة الأولى ستظهر موافقة نهائية مستقلة.\n'+
    'العمليات ذات النتيجة المجهولة تُحجز للمراجعة دون إعادة محاولة.',
    [[b('1️⃣ الموافقة الأولى على '+label(next),'ft:1:1:'+nonce)],
     [b('✖ إلغاء','ft:1:0:'+nonce)],
     [b('↩️ الموضوع','ft:1:d:'+g+':'+t)]]);
  });
 }
 private async first(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.now(),pending=this.pending(s,actor,nonce,1,now);
   if(!pending)return null;
   const p=pending.value;
   pending.callback.used=true;
   const token=this.add(s,actor,{...p,stage:2,createdAt:now},now);
   if(!token)return null;
   return screen('<b>🔐 الموافقة النهائية على '+label(p.action)+'</b>\n'+
    'المجموعة: <code>'+p.group+'</code>\n'+
    'الموضوع: <code>'+p.thread+'</code>\n'+
    'التأكيد سيُنشئ إيصال محاولة دائمًا قبل طلب Telegram.\n'+
    'قد تبقى النتيجة مجهولة إذا انقطع الاتصال، ولا تُكرر العملية تلقائيًا.',
    [[b('2️⃣ تنفيذ '+label(p.action)+' نهائيًا','ft:1:2:'+token)],
     [b('✖ إلغاء','ft:1:0:'+token)],
     [b('↩️ الموضوع','ft:1:d:'+p.group+':'+p.thread)]]);
  });
 }
 private async final(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  const first=await this.store.snapshot(),at=this.now();
  const preview=this.pending(first,actor,nonce,2,at);
  if(!preview||!await this.remote(preview.value.group,actor))return null;
  const record=await this.store.transaction(s=>{
   const now=this.now(),found=this.pending(s,actor,nonce,2,now);
   if(!found)return null;
   const p=found.value;
   const start=startForumTopicAction(s,this.policy,actor,p.group,p.thread,
    p.action,now,p.proof);
   if(!start)return null;
   found.callback.used=true;
   return start;
  });
  if(!record)return null;
  let outcome:ForumTopicActionOutcome='UNKNOWN_OUTCOME';
  try{
   if(this.authentic()){
    outcome=await this.gateway!.applyForumTopicAction(record.group,
     record.thread,record.actor,record.action,async()=>{
      if(!this.authentic()||!await this.safe())return false;
      const s=await this.store.snapshot();
      return stillAuthorizedForumTopicAction(s,this.policy,record,this.now());
     });
   }
  }catch{/* An interrupted post might have reached Telegram. Do not retry. */}
  let recorded=false;
  try{
   recorded=await this.store.transaction(s=>
    finishForumTopicAction(s,record,outcome,this.now()));
  }catch{/* Leave START as unresolved: never retry on next callback. */}
  return screen('<b>📌 نتيجة طلب '+label(record.action)+'</b>\n'+
   'المجموعة: <code>'+record.group+'</code>\n'+
   'الموضوع: <code>'+record.thread+'</code>\n'+
   'رقم محاولة محلية: <code>'+record.id+'</code>\n'+
   (recorded?state(outcome):
    'تعذر حفظ النتيجة؛ المحاولة محجوزة للمراجعة ولا تُكرر.')+'\n'+
   'لا يعني هذا الإثبات أن Telegram سيظل في الحالة نفسها لاحقًا.',
   [[b('🕘 سجل عمليات الموضوع','ft:1:9:'+record.group+':'+record.thread+':0')],
    [b('↩️ الموضوع','ft:1:d:'+record.group+':'+record.thread)]]);
 }
 private async cancel(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  const item=await this.store.transaction(s=>{
   const at=this.now(),rows=s.callbacks.filter(c=>c.ref===PREFIX+nonce),c=rows[0];
   if(!clock(at)||rows.length!==1||!c||c.actorId!==actor||
    c.chatId!=='private'||!c.oneShot||c.used||c.revoked||
    !clock(c.expiresAt)||c.expiresAt<=at)return null;
   const p=parse(c.action);
   if(!p||this.local(s,actor,p.group,p.thread,at)===null)return null;
   c.used=true;return p;
  });
  if(!item)return null;
  const snapshot=await this.store.snapshot();
  const history=forumTopicActionHistory(snapshot,this.policy,actor,
   item.group,item.thread,this.now());
  if(history===null)return null;
  return screen('<b>✖ أُلغي الطلب قبل التنفيذ</b>\n'+
   'لم تُرسل أي عملية جديدة إلى Telegram من هذه الموافقة.',
   [[b('↩️ الموضوع','ft:1:d:'+item.group+':'+item.thread)]]);
 }
 async history(actor:string,g:string,t:number,page:number):
 Promise<OwnerInlineScreen|null>{
  const s=await this.store.snapshot(),now=this.now();
  if(!clock(now)||!Number.isSafeInteger(page)||page<0||page>999)return null;
  const items=forumTopicActionHistory(s,this.policy,actor,g,t,now);
  if(!items)return null;
  const pages=Math.max(1,Math.ceil(items.length/8));
  if(page>=pages)return null;
  const rows=items.slice(page*8,(page+1)*8).map(item=>
   '▫️ '+(item.action==='CLOSE'?'إغلاق':'إعادة فتح')+' · '+
   state(item.outcome)+' · <code>'+item.id+'</code> · '+new Date(item.startedAt).toISOString()
    .slice(0,16).replace('T',' ')+' UTC');
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(b('⬅️ السابق','ft:1:9:'+g+':'+t+':'+(page-1)));
  if(page+1<pages)nav.push(b('➡️ التالي','ft:1:9:'+g+':'+t+':'+(page+1)));
  return screen('<b>🕘 محاولات إدارة مواضيع Telegram</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'محاولات مسجلة: '+items.length+' · صفحة '+(page+1)+'/'+pages+'\n'+
   (rows.length?rows.join('\n'):'لا توجد محاولات مسجلة.')+'\n'+
   'الإيصال المجهول يمنع إجراءً جديدًا حتى المراجعة اليدوية؛ لا يوجد زر إعادة محاولة.',
   [...(nav.length?[nav]:[]),[b('↩️ الموضوع','ft:1:d:'+g+':'+t)]]);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!person(actor)||!this.policy.isOwner(actor)||
   !validForumTopicControlRoute(data))return null;
  const choice=TOPIC_CONTROL_CHOICE.exec(data);
  if(choice)return this.prepare(actor,choice[1]!,Number(choice[2]),
   choice[3]==='c'?'CLOSE':'REOPEN');
  const first=TOPIC_CONTROL_FIRST.exec(data);
  if(first)return this.first(actor,first[1]!);
  const fin=TOPIC_CONTROL_FINAL.exec(data);
  if(fin)return this.final(actor,fin[1]!);
  const cancel=TOPIC_CONTROL_CANCEL.exec(data);
  if(cancel)return this.cancel(actor,cancel[1]!);
  const hist=TOPIC_CONTROL_HISTORY.exec(data);
  return hist?this.history(actor,hist[1]!,Number(hist[2]),Number(hist[3])):null;
 }
}
