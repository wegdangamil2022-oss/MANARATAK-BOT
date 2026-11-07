import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {forumTopicGroupAccess,localForumTopics,
 forumTopicRegistrationProof,registerLocalForumTopic,validForumTopicTitle,
 forumTopicNote,forumTopicNoteProof,saveLocalForumTopicNote,validForumTopicNote,
 localForumTopicNoteHistory}
 from './group-forum-topics.js';

/** 01-05: local-only topic registration with private owner consent.
 * No Bot API send, createForumTopic, closeForumTopic or permission mutation.
 * The owner must confirm existence/permissions later via Telegram.
 */
const PREFIX='group-forum:preview:',NOTE_PREFIX='group-forum:note-preview:',
 TTL=120_000,SIZE=8;
const chat='(-[1-9][0-9]{0,15})',thread='([1-9][0-9]{0,9})',
 page='(0|[1-9][0-9]{0,2})',token='([A-Za-z0-9_-]{24})';
const HOME=new RegExp('^ft:1:h:'+page+'$','u');
const GROUP=new RegExp('^ft:1:g:'+chat+':'+page+'$','u');
const DETAIL=new RegExp('^ft:1:d:'+chat+':'+thread+'$','u');
const HISTORY=new RegExp('^ft:1:v:'+chat+':'+thread+':'+page+'$','u');
const CONFIRM=new RegExp('^ft:1:c:'+token+'$','u');
const CANCEL=new RegExp('^ft:1:x:'+token+'$','u');
const NOTE_CONFIRM=new RegExp('^ft:1:n:'+token+'$','u');
const NOTE_CANCEL=new RegExp('^ft:1:z:'+token+'$','u');
const clock=(t:unknown):t is number=>typeof t==='number'&&
 Number.isSafeInteger(t)&&t>=0&&t<=8_640_000_000_000_000-TTL;
const person=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const id=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const topicId=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<=2_147_483_647;
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
interface Pending{
 readonly group:string;readonly thread:number;readonly title:string;
 readonly proof:string;readonly createdAt:number;readonly version:number;
}
function parse(value:unknown):Pending|null{
 if(typeof value!=='string'||!value.startsWith(PREFIX))return null;
 let decoded:unknown;
 try{decoded=JSON.parse(value.slice(PREFIX.length));}catch{return null;}
 if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))return null;
 const v=decoded as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='createdAt,group,proof,thread,title,version'||
  !id(v.group)||!topicId(Number(v.thread))||typeof v.thread!=='number'||
  !validForumTopicTitle(v.title)||typeof v.proof!=='string'||
  !/^[a-f0-9]{64}$/u.test(v.proof)||!clock(v.createdAt)||
  typeof v.version!=='number'||!Number.isSafeInteger(v.version)||v.version<1)
  return null;
 return v as unknown as Pending;
}
interface PendingNote{
 readonly group:string;readonly thread:number;readonly note:string;
 readonly proof:string;readonly createdAt:number;readonly version:number;
}
function parseNote(value:unknown):PendingNote|null{
 if(typeof value!=='string'||!value.startsWith(NOTE_PREFIX))return null;
 let raw:unknown;
 try{raw=JSON.parse(value.slice(NOTE_PREFIX.length));}catch{return null;}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const p=raw as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='createdAt,group,note,proof,thread,version'||
  !id(p.group)||typeof p.thread!=='number'||!topicId(p.thread)||
  !validForumTopicNote(p.note)||typeof p.proof!=='string'||
  !/^[a-f0-9]{64}$/u.test(p.proof)||!clock(p.createdAt)||
  typeof p.version!=='number'||!Number.isSafeInteger(p.version)||
  p.version<1)return null;
 return p as unknown as PendingNote;
}
export function validOwnerForumTopicRoute(value:unknown):boolean{
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
  (HOME.test(value)||GROUP.test(value)||DETAIL.test(value)||
   HISTORY.test(value)||
   CONFIRM.test(value)||CANCEL.test(value)||
   NOTE_CONFIRM.test(value)||NOTE_CANCEL.test(value));
}
export class OwnerForumTopicEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private access(s:BotState,actor:string,now:number):boolean{
  return clock(now)&&person(actor)&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private groups(s:BotState,actor:string,now:number){
  const ids=[...new Set(s.chats.map(c=>c.id))].filter(x=>
   forumTopicGroupAccess(s,this.policy,actor,x,now)!==null).sort();
  return ids;
 }
 private home(s:BotState,actor:string,now:number,p:number):OwnerInlineScreen|null{
  if(!this.access(s,actor,now))return null;
  const groups=this.groups(s,actor,now),pages=Math.max(1,Math.ceil(groups.length/SIZE));
  if(p>=pages)return null;
  const rows:{text:string;callback_data:string}[][]=[];
  for(const id of groups.slice(p*SIZE,(p+1)*SIZE)){
   const topics=localForumTopics(s,this.policy,actor,id,now);
   if(!topics)return null;
   rows.push([btn('🧩 '+id+' · مسجل '+topics.length,'ft:1:g:'+id+':0')]);
  }
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','ft:1:h:'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','ft:1:h:'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ المجموعات والشبكات','mi:1:s:01:0')]);
  return ui('<b>🧩 مواضيع المجموعات — الجرد المحلي</b>\n'+
   'المجموعات المعتمدة والمسموح للمالك بإدارتها: '+groups.length+
   ' · صفحة '+(p+1)+'/'+pages+'\n'+
   'يمكن تسجيل رقم موضوع وعنوانه من خاص المالك؛ التسجيل لا يثبت وجود الموضوع على Telegram.\n'+
   'لإضافة موضوع: <code>/topicregister رقم_المجموعة رقم_الموضوع العنوان</code>\n'+
   'لن ينشر البوت تلقائيًا، أو ينقل رسالة للموضوع العام، أو يغلق موضوعًا من هذه الشاشة.',
   rows);
 }
 private group(s:BotState,actor:string,now:number,g:string,p:number):
 OwnerInlineScreen|null{
  const topics=localForumTopics(s,this.policy,actor,g,now);
  if(!topics)return null;
  const pages=Math.max(1,Math.ceil(topics.length/SIZE));
  if(p>=pages)return null;
  const rows=topics.slice(p*SIZE,(p+1)*SIZE).map(t=>[
   btn('▫️ '+t.threadId+' · '+t.title,'ft:1:d:'+g+':'+t.threadId)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','ft:1:g:'+g+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','ft:1:g:'+g+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ المجموعات','ft:1:h:0')]);
  return ui('<b>🧩 موضوعات المجموعة المسجلة محليًا</b>\n'+
   'المجموعة: <code>'+g+'</code>\n'+
   'عدد المواضيع المحلية: '+topics.length+' (الحد 64 لكل إصدار اعتماد).\n'+
   'صفحة '+(p+1)+'/'+pages+'\n'+
   'إضافة موضوع: <code>/topicregister '+g+' 123 عنوان_الموضوع</code>\n'+
   'لا تتضمن القائمة إثباتًا بأن Telegram يقبل النشر لهذا الموضوع.',rows);
 }
 private detail(s:BotState,actor:string,now:number,g:string,t:number):
 OwnerInlineScreen|null{
  const topics=localForumTopics(s,this.policy,actor,g,now);
  const topic=topics?.find(x=>x.threadId===t);
  if(!topic)return null;
  const note=forumTopicNote(s,this.policy,actor,g,t,now);
  if(note===null)return null;
  return ui('<b>🧩 بيانات موضوع محلي</b>\n'+
   'المجموعة: <code>'+g+'</code>\n'+
   'رقم الموضوع: <code>'+topic.threadId+'</code>\n'+
   'العنوان: '+esc(topic.title)+'\n'+
   'إصدار اعتماد المجموعة: '+topic.groupVersion+'\n'+
   'التسجيل (UTC): '+new Date(topic.registeredAt).toISOString().slice(0,16).replace('T',' ')+
   '\nالملاحظة التحريرية: '+(note?esc(note.text):'لم تُعتمد ملاحظة بعد.')+
   (note?'\nمراجعة الملاحظة المحلية: '+note.revision:'')+
   '\nلإضافة ملاحظة: <code>/topicnote '+g+' '+t+' النص_التحريري</code>'+
   '\nلا يسمح هذا السجل بإرسال رسائل أو فرض سياسات مستقلة؛ يلزم التأكد من نوع المجموعة وصلاحية الموضوع الحية.',
   [[btn('🕘 سجل مراجعات الملاحظة','ft:1:v:'+g+':'+t+':0')],
    [btn('↩️ مواضيع المجموعة','ft:1:g:'+g+':0)],
    [btn('🏠 لوحة المالك','mi:1:h')]]);
 }
 private history(s:BotState,actor:string,now:number,g:string,t:number,p:number):
 OwnerInlineScreen|null{
  const history=localForumTopicNoteHistory(s,this.policy,actor,g,t,now);
  if(!history)return null;
  const pages=Math.max(1,Math.ceil(history.length/SIZE));
  if(p>=pages)return null;
  const items=history.slice(p*SIZE,(p+1)*SIZE).map(e=>
   '▫️ مراجعة '+e.revision+' · '+
   new Date(e.at).toISOString().slice(0,16).replace('T',' ')+' UTC');
  const rows:{text:string;callback_data:string}[][]=[];
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','ft:1:v:'+g+':'+t+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','ft:1:v:'+g+':'+t+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ تفاصيل الموضوع','ft:1:d:'+g+':'+t)]);
  return ui('<b>🕘 سجل مراجعات ملاحظات الموضوع</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'النسخ المحلية: '+history.length+' · صفحة '+(p+1)+'/'+pages+'\n'+
   (items.length?items.join('\n'):'لا توجد مراجعات للملاحظات حتى الآن.')+
   '\nالسجل للمالك فقط. لا يعتبر إثباتًا بأن الموضوع مفتوح على Telegram ولا يرسل محتوى إلى الطلاب.',rows);
 }
 /** Original private message only; transport checks forwards and edits. */
 async prepare(actor:string,g:string,t:number,title:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.access(s,actor,now)||!id(g)||!topicId(t)||
    !validForumTopicTitle(title))return null;
   const proof=forumTopicRegistrationProof(s,this.policy,actor,g,t,title,now);
   const version=forumTopicGroupAccess(s,this.policy,actor,g,now);
   if(!proof||version===null)return null;
   const pending=s.callbacks.filter(c=>c.actorId===actor&&
    c.ref.startsWith(PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>now);
   if(pending.length>=100)return null;
   const nonce=randomBytes(18).toString('base64url'),ref=PREFIX+nonce;
   if(s.callbacks.some(c=>c.ref===ref))return null;
   for(const c of pending)c.revoked=true;
   const receipt:Pending={group:g,thread:t,title,proof,createdAt:now,version};
   s.callbacks.push({ref,action:PREFIX+JSON.stringify(receipt),
    actorId:actor,chatId:'private',policyVersion:version,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 مراجعة تسجيل رقم موضوع Forum</b>\n'+
    'المجموعة: <code>'+g+'</code>\n'+
    'رقم الموضوع: <code>'+t+'</code>\n'+
    'العنوان: '+esc(title)+'\n'+
    'هذا إثبات محلي بأن المالك كتب الرقم، ولا يثبت وجوده في Telegram.\n'+
    'لن يرسل البوت رسالة أو ينشئ موضوعًا أو يغيّر سياسة الحماية.\n'+
    'التأكيد خاص بالمالك، مرة واحدة خلال دقيقتين.',
    [[btn('✅ اعتماد التسجيل المحلي','ft:1:c:'+nonce)],
     [btn('✖ إلغاء','ft:1:x:'+nonce)],
     [btn('↩️ مواضيع المجموعة','ft:1:g:'+g+':0)]]);
  });
 }
 /** Human-authored topic notes remain owner-private and unpublished. */
 async prepareNote(actor:string,g:string,t:number,note:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.access(s,actor,now)||!id(g)||!topicId(t)||
    !validForumTopicNote(note))return null;
   const proof=forumTopicNoteProof(s,this.policy,actor,g,t,note,now);
   const version=forumTopicGroupAccess(s,this.policy,actor,g,now);
   if(!proof||version===null)return null;
   const pending=s.callbacks.filter(c=>c.actorId===actor&&
    c.ref.startsWith(NOTE_PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>now);
   if(pending.length>=100)return null;
   const nonce=randomBytes(18).toString('base64url'),ref=NOTE_PREFIX+nonce;
   if(s.callbacks.some(c=>c.ref===ref))return null;
   for(const c of pending)c.revoked=true;
   const value:PendingNote={group:g,thread:t,note,proof,createdAt:now,version};
   s.callbacks.push({ref,action:NOTE_PREFIX+JSON.stringify(value),
    actorId:actor,chatId:'private',policyVersion:version,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 مراجعة ملاحظة موضوع محلية</b>\n'+
    'المجموعة: <code>'+g+'</code>\n'+
    'الموضوع: <code>'+t+'</code>\n'+
    'النص: '+esc(note)+'\n'+
    'ملاحظة تحريرية للمالك فقط؛ لا تظهر تلقائيًا للطلاب أو ترسل إلى Telegram.\n'+
    'موافقة خاصة لمرة واحدة، صالحة لدقيقتين.',
    [[btn('✅ حفظ الملاحظة محليًا','ft:1:n:'+nonce)],
     [btn('✖ إلغاء','ft:1:z:'+nonce)],
     [btn('↩️ الموضوع','ft:1:d:'+g+':'+t)]]);
  });
 }
 private async decideNote(actor:string,nonce:string,apply:boolean):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),ref=NOTE_PREFIX+nonce,
    rows=s.callbacks.filter(c=>c.ref===ref),c=rows[0];
   if(!this.access(s,actor,now)||rows.length!==1||!c||
    c.actorId!==actor||c.chatId!=='private'||!c.oneShot||
    c.used||c.revoked||!clock(c.expiresAt)||
    c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   const p=parseNote(c.action);
   if(!p||p.createdAt>now||c.expiresAt!==p.createdAt+TTL||
    c.policyVersion!==p.version)return null;
   if(apply&&!saveLocalForumTopicNote(s,this.policy,actor,
    p.group,p.thread,p.note,now,p.proof))return null;
   c.used=true;
   return this.detail(s,actor,now,p.group,p.thread);
  });
 }

 private async decide(actor:string,nonce:string,apply:boolean):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),ref=PREFIX+nonce,
    rows=s.callbacks.filter(c=>c.ref===ref),c=rows[0];
   if(!this.access(s,actor,now)||rows.length!==1||!c||
    c.actorId!==actor||c.chatId!=='private'||!c.oneShot||
    c.used||c.revoked||!clock(c.expiresAt)||
    c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   const payload=parse(c.action);
   if(!payload||payload.createdAt>now||
    c.expiresAt!==payload.createdAt+TTL||
    c.policyVersion!==payload.version)return null;
   if(apply&&!registerLocalForumTopic(s,this.policy,actor,
    payload.group,payload.thread,payload.title,now,payload.proof))
    return null;
   c.used=true;
   return apply?this.detail(s,actor,now,payload.group,payload.thread):
    this.group(s,actor,now,payload.group,0);
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!person(actor)||!this.policy.isOwner(actor))return null;
  if(data==='mi:1:i:01:05')data='ft:1:h:0';
  if(!validOwnerForumTopicRoute(data))return null;
  const n=NOTE_CONFIRM.exec(data);
  if(n)return this.decideNote(actor,n[1]!,true);
  const z=NOTE_CANCEL.exec(data);
  if(z)return this.decideNote(actor,z[1]!,false);
  const c=CONFIRM.exec(data);
  if(c)return this.decide(actor,c[1]!,true);
  const x=CANCEL.exec(data);
  if(x)return this.decide(actor,x[1]!,false);
  const s=await this.store.snapshot(),now=this.clock();
  if(!this.access(s,actor,now))return null;
  const h=HOME.exec(data);if(h)return this.home(s,actor,now,Number(h[1]));
  const g=GROUP.exec(data);
  if(g)return this.group(s,actor,now,g[1]!,Number(g[2]));
  const d=DETAIL.exec(data);
  if(d)return this.detail(s,actor,now,d[1]!,Number(d[2]));
  const hst=HISTORY.exec(data);
  return hst?this.history(s,actor,now,hst[1]!,Number(hst[2]),Number(hst[3])):null;
 }
}
