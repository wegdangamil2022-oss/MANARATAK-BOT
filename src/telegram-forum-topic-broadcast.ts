import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';
import {forumTopicGroupAccess} from './group-forum-topics.js';
import {forumBroadcastProof,prepareForumBroadcastSource,
 startForumBroadcast,stillAuthorizedForumBroadcast,finishForumBroadcast,
 forumBroadcastHistory,type ForumBroadcastOutcome}
 from './group-forum-topic-broadcast.js';

/** TOPIC-002: two owner-private confirmations for ONE reviewed resource.
 * Never a mass send, automatic schedule, or general-thread fallback.
 */
const PREFIX='group-forum:broadcast-preview:',TTL=120000;
const TOKEN='([A-Za-z0-9_-]{24})',G='(-[1-9][0-9]{0,15})',
 THREAD='([1-9][0-9]{0,9})',PAGE='(0|[1-9][0-9]{0,2})';
export const FORUM_BROADCAST_FIRST=new RegExp('^ft:1:3:'+TOKEN+'$','u');
export const FORUM_BROADCAST_FINAL=new RegExp('^ft:1:4:'+TOKEN+'$','u');
export const FORUM_BROADCAST_CANCEL=new RegExp('^ft:1:5:'+TOKEN+'$','u');
export const FORUM_BROADCAST_HISTORY=
 new RegExp('^ft:1:6:'+G+':'+THREAD+':'+PAGE+'$','u');
export function validForumBroadcastRoute(value:unknown):value is string{
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
 (FORUM_BROADCAST_FIRST.test(value)||FORUM_BROADCAST_FINAL.test(value)||
  FORUM_BROADCAST_CANCEL.test(value)||FORUM_BROADCAST_HISTORY.test(value));
}
const id=(x:unknown):x is string=>typeof x==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const person=(x:unknown):x is string=>typeof x==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const thread=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>1&&x<=2147483647;
const clock=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=0&&x<=8640000000000000-TTL;
const resource=(x:unknown):x is string=>typeof x==='string'&&
 /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(x);
const b=(text:string,callback_data:string)=>({text,callback_data});
const view=(text:string,rows:{text:string;callback_data:string}[][]):
 OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').
 replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
type Pending={group:string;thread:number;resource:string;proof:string;
 version:number;createdAt:number;stage:1|2};
function parse(value:unknown):Pending|null{
 if(typeof value!=='string'||!value.startsWith(PREFIX))return null;
 let raw:unknown;
 try{raw=JSON.parse(value.slice(PREFIX.length));}catch{return null;}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const v=raw as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='createdAt,group,proof,resource,stage,thread,version'||
  !id(v.group)||!thread(v.thread)||!resource(v.resource)||
  typeof v.proof!=='string'||!/^[a-f0-9]{64}$/u.test(v.proof)||
  (v.stage!==1&&v.stage!==2)||!clock(v.createdAt)||
  typeof v.version!=='number'||!Number.isSafeInteger(v.version)||
  v.version<1)return null;
 return v as unknown as Pending;
}
const status=(o:ForumBroadcastOutcome|undefined)=>o==='CONFIRMED'?
 'أقر Telegram إرسال الرسالة إلى الموضوع المعيّن':
 o==='FAILED_CONFIRMED'?'لم يؤكد Telegram عملية النشر':
 o==='UNKNOWN_OUTCOME'?'نتيجة غير معروفة: مراجعة يدوية، دون تكرار تلقائي':
 'محاولة معلّقة/مفقودة النتيجة: ممنوع تكرار الإرسال';

export class TelegramForumTopicBroadcast{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway?:TelegramBotApiModerationGateway,
  private readonly safety:()=>Promise<boolean>=async()=>false,
  private readonly now:()=>number=Date.now){}
 private official(){
  return this.gateway!==undefined&&
   TelegramBotApiModerationGateway.usesOfficialForumBroadcast(this.gateway);
 }
 private async safe(){
  try{return await this.safety()===true;}catch{return false;}
 }
 private local(s:BotState,actor:string,g:string,t:number,at:number):number|null{
  if(!person(actor)||!this.policy.isOwner(actor)||!id(g)||!thread(t)||!clock(at))
   return null;
  return forumTopicGroupAccess(s,this.policy,actor,g,at);
 }
 private async remote(g:string,actor:string):Promise<boolean>{
  if(!this.official()||!await this.safe())return false;
  try{
   if(await this.gateway!.inspectForumStatus(g)!=='FORUM'||
    !this.official()||!await this.safe())return false;
   if((await this.gateway!.inspectBotAdminRights(g)).manageTopics!=='GRANTED'||
    !this.official()||!await this.safe())return false;
   return await this.gateway!.inspectForumActorRights(g,actor)==='GRANTED'&&
    this.official()&&await this.safe();
  }catch{return false;}
 }
 private pending(s:BotState,actor:string,token:string,stage:1|2,
  now:number):{callback:BotState['callbacks'][number];value:Pending}|null{
  const rows=s.callbacks.filter(c=>c.ref===PREFIX+token),c=rows[0];
  if(!clock(now)||rows.length!==1||!c||c.actorId!==actor||
   c.chatId!=='private'||c.oneShot!==true||c.used||c.revoked||
   !clock(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
  const data=parse(c.action);
  if(!data||data.stage!==stage||data.createdAt>now||
   c.expiresAt!==data.createdAt+TTL||
   c.policyVersion!==data.version||
   this.local(s,actor,data.group,data.thread,now)!==data.version||
   forumBroadcastProof(s,this.policy,actor,data.group,data.thread,
    data.resource,now)!==data.proof)return null;
  return {callback:c,value:data};
 }
 private add(s:BotState,actor:string,data:Pending,at:number):string|null{
  if(!clock(at))return null;
  const existing=s.callbacks.filter(c=>c.actorId===actor&&
   c.ref.startsWith(PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>at);
  if(existing.length>=64)return null;
  const nonce=randomBytes(18).toString('base64url'),ref=PREFIX+nonce;
  if(s.callbacks.some(c=>c.ref===ref))return null;
  s.callbacks.push({ref,action:PREFIX+JSON.stringify(data),
   actorId:actor,chatId:'private',policyVersion:data.version,
   expiresAt:at+TTL,used:false,revoked:false,oneShot:true});
  for(const c of existing)c.revoked=true;
  return nonce;
 }
 async prepare(actor:string,g:string,t:number,r:string):
 Promise<OwnerInlineScreen|null>{
  const s=await this.store.snapshot(),at=this.now();
  const version=this.local(s,actor,g,t,at),
   source=prepareForumBroadcastSource(s,this.policy,actor,g,t,r,at);
  if(version===null||!source||!await this.remote(g,actor))return null;
  const fresh=await this.store.snapshot(),now=this.now();
  if(!clock(now)||now<at||now>=at+TTL||
   forumBroadcastProof(fresh,this.policy,actor,g,t,r,now)!==source.digest)
   return null;
  return this.store.transaction(state=>{
   const now=this.now();
   if(!clock(now)||now<at||now>=at+TTL||
    this.local(state,actor,g,t,now)!==version||
    forumBroadcastProof(state,this.policy,actor,g,t,r,now)!==source.digest)
    return null;
   const token=this.add(state,actor,{group:g,thread:t,resource:r,
    proof:source.digest,version,createdAt:now,stage:1},now);
   if(!token)return null;
   return view('<b>📚 معاينة نشرة تعليمية موجهة</b>\n'+
    'المجموعة: <code>'+g+'</code>\n'+
    'الموضوع: <code>'+t+'</code>\n'+
    'معرّف المورد: <code>'+r+'</code>\n'+
    'النص الكامل الذي سيرسَل عند الموافقة النهائية:\n'+
    esc(source.body)+'\n'+
    'سيُرسل مورد واحد فقط إلى موضوع واحد، دون سقوط إلى «عام» أو إعادة محاولة تلقائية.\n'+
    'تتطلب العملية موافقتين مستقلتين خلال دقيقتين لكل خطوة.',
    [[b('1️⃣ الموافقة الأولى على النشرة','ft:1:3:'+token)],
     [b('✖ إلغاء','ft:1:5:'+token)],
     [b('↩️ تفاصيل الموضوع','ft:1:d:'+g+':'+t)]]);
  });
 }
 private async first(actor:string,token:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.now(),found=this.pending(s,actor,token,1,now);
   if(!found)return null;
   const p=found.value;
   found.callback.used=true;
   const next=this.add(s,actor,{...p,createdAt:now,stage:2},now);
   if(!next)return null;
   return view('<b>🔐 التأكيد النهائي للنشر التعليمي</b>\n'+
    'المجموعة: <code>'+p.group+'</code>\n'+
    'الموضوع: <code>'+p.thread+'</code>\n'+
    'المورد: <code>'+p.resource+'</code>\n'+
    'سيُحجز إيصال المحاولة قبل Telegram. أي نتيجة ملتبسة لا تُكرر.',
    [[b('2️⃣ إرسال المورد إلى الموضوع الآن','ft:1:4:'+next)],
     [b('✖ إلغاء','ft:1:5:'+next)],
     [b('↩️ تفاصيل الموضوع','ft:1:d:'+p.group+':'+p.thread)]]);
  });
 }
 private async final(actor:string,token:string):Promise<OwnerInlineScreen|null>{
  const snap=await this.store.snapshot(),at=this.now();
  const found=this.pending(snap,actor,token,2,at);
  if(!found||!await this.remote(found.value.group,actor))return null;
  const attempt=await this.store.transaction(s=>{
   const now=this.now(),current=this.pending(s,actor,token,2,now);
   if(!current)return null;
   const p=current.value,row=startForumBroadcast(s,this.policy,actor,
    p.group,p.thread,p.resource,now,p.proof);
   if(!row)return null;
   current.callback.used=true;
   return row;
  });
  if(!attempt)return null;
  let outcome:ForumBroadcastOutcome='UNKNOWN_OUTCOME';
  try{
   if(this.official())outcome=await this.gateway!.sendForumEducation(
    attempt.group,attempt.thread,attempt.actor,attempt.body,async()=>{
     if(!this.official()||!await this.safe())return false;
     const fresh=await this.store.snapshot();
     return stillAuthorizedForumBroadcast(fresh,this.policy,attempt,this.now());
    });
  }catch{/* POST may have succeeded. Never retry after a durable start. */}
  let stored=false;
  try{
   stored=await this.store.transaction(s=>finishForumBroadcast(
    s,this.policy,attempt,outcome,this.now()));
  }catch{/* unresolved start is intentionally quarantined */}
  return view('<b>📨 نتيجة نشر المورد إلى موضوع Forum</b>\n'+
   'المجموعة: <code>'+attempt.group+'</code>\n'+
   'الموضوع: <code>'+attempt.thread+'</code>\n'+
   'المورد: <code>'+attempt.resource+'</code>\n'+
   'رقم المحاولة: <code>'+attempt.id+'</code>\n'+
   (stored?status(outcome):
    'لم يمكن حفظ النتيجة؛ المحاولة محجوزة ولا يجوز إعادة الإرسال تلقائيًا.')+
   '\nلا يجوز اعتماد النتيجة على أنها مشاهدة فعلية من جميع الطلاب.',
   [[b('🕘 سجل النشرات','ft:1:6:'+attempt.group+':'+attempt.thread+':0')],
    [b('↩️ تفاصيل الموضوع','ft:1:d:'+attempt.group+':'+attempt.thread)]]);
 }
 private async cancel(actor:string,token:string):Promise<OwnerInlineScreen|null>{
  const data=await this.store.transaction(s=>{
   const now=this.now(),rows=s.callbacks.filter(c=>c.ref===PREFIX+token),
    c=rows[0];
   if(!clock(now)||rows.length!==1||!c||c.actorId!==actor||
    c.chatId!=='private'||c.oneShot!==true||c.used||c.revoked||
    !clock(c.expiresAt)||c.expiresAt<=now)return null;
   const info=parse(c.action);
   if(!info||this.local(s,actor,info.group,info.thread,now)===null)
    return null;
   c.used=true;return info;
  });
  return data?view('<b>✖ ألغيت معاينة النشر</b>\n'+
   'لم تُنفذ محاولة Telegram جديدة لهذه الموافقة.',
   [[b('↩️ الموضوع','ft:1:d:'+data.group+':'+data.thread)]]):null;
 }
 async history(actor:string,g:string,t:number,page:number):
 Promise<OwnerInlineScreen|null>{
  const snap=await this.store.snapshot(),now=this.now();
  if(!clock(now)||!Number.isSafeInteger(page)||page<0||page>999)return null;
  const list=forumBroadcastHistory(snap,this.policy,actor,g,t,now);
  if(!list)return null;
  const pages=Math.max(1,Math.ceil(list.length/8));
  if(page>=pages)return null;
  const items=list.slice(page*8,(page+1)*8).map(x=>
   '▫️ المورد '+x.resource+' · <code>'+x.id+'</code> · '+status(x.outcome)+' · '+
   new Date(x.startedAt).toISOString().slice(0,16).replace('T',' ')+' UTC');
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(b('⬅️ السابق','ft:1:6:'+g+':'+t+':'+(page-1)));
  if(page+1<pages)nav.push(b('➡️ التالي','ft:1:6:'+g+':'+t+':'+(page+1)));
  return view('<b>🕘 نشرات Forum — سجل المحاولات</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'عدد المحاولات: '+list.length+' · صفحة '+(page+1)+'/'+pages+'\n'+
   (items.length?items.join('\n'):'لا يوجد نشر سابق.')+
   '\nالعمليات المجهولة لا تُكرّر. لا يوجد بث تلقائي إلى موضوع عام.',
   [...(nav.length?[nav]:[]),[b('↩️ الموضوع','ft:1:d:'+g+':'+t)]]);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!person(actor)||!this.policy.isOwner(actor)||
   !validForumBroadcastRoute(data))return null;
  const first=FORUM_BROADCAST_FIRST.exec(data);
  if(first)return this.first(actor,first[1]!);
  const fin=FORUM_BROADCAST_FINAL.exec(data);
  if(fin)return this.final(actor,fin[1]!);
  const cancel=FORUM_BROADCAST_CANCEL.exec(data);
  if(cancel)return this.cancel(actor,cancel[1]!);
  const hist=FORUM_BROADCAST_HISTORY.exec(data);
  return hist?this.history(actor,hist[1]!,Number(hist[2]),Number(hist[3])):null;
 }
}
