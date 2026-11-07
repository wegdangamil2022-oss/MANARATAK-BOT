import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';
import {forumTopicGroupAccess,localForumTopics,
 forumTopicRegistrationProof,registerLocalForumTopic,validForumTopicTitle,
 forumTopicNote,forumTopicNoteProof,saveLocalForumTopicNote,validForumTopicNote,
 localForumTopicNoteHistory}
 from './group-forum-topics.js';
import {ownerForumTopicEducationPolicy,forumTopicEducationProof,
 setForumTopicEducationPolicy,forumTopicEducationHistory,
 type ForumTopicEducationMode} from './group-forum-topic-policy.js';
import {ownerForumNotePublication,forumNotePublicationProof,
 changeForumNotePublication,forumNotePublicationHistory,
 type ForumTopicNotePublicationAction} from './group-forum-note-publication.js';
import {previewForumTopicEducationalSources}
 from './group-forum-publication-preflight.js';
import {TelegramForumTopicControl,validForumTopicControlRoute}
 from './telegram-forum-topic-control.js';
import {forumTopicActionHistory} from './group-forum-topic-control.js';
import {TelegramForumTopicBroadcast,validForumBroadcastRoute}
 from './telegram-forum-topic-broadcast.js';

/** 01-05: local-only topic registration with private owner consent.
 * No Bot API send, createForumTopic, closeForumTopic or permission mutation.
 * The owner must confirm existence/permissions later via Telegram.
 */
const PREFIX='group-forum:preview:',NOTE_PREFIX='group-forum:note-preview:',
 POLICY_PREFIX='group-forum:education-preview:',
 PUBLICATION_PREFIX='group-forum:note-publication-preview:',
 TTL=120_000,SIZE=8;
const chat='(-[1-9][0-9]{0,15})',thread='([1-9][0-9]{0,9})',
 page='(0|[1-9][0-9]{0,2})',token='([A-Za-z0-9_-]{24})';
const HOME=new RegExp('^ft:1:h:'+page+'$','u');
const GROUP=new RegExp('^ft:1:g:'+chat+':'+page+'$','u');
const DETAIL=new RegExp('^ft:1:d:'+chat+':'+thread+'$','u');
const LIVE=new RegExp('^ft:1:f:'+chat+':'+thread+'$','u');
const SOURCE_PREVIEW=new RegExp('^ft:1:m:'+chat+':'+thread+'$','u');
const HISTORY=new RegExp('^ft:1:v:'+chat+':'+thread+':'+page+'$','u');
const CONFIRM=new RegExp('^ft:1:c:'+token+'$','u');
const CANCEL=new RegExp('^ft:1:x:'+token+'$','u');
const NOTE_CONFIRM=new RegExp('^ft:1:n:'+token+'$','u');
const NOTE_CANCEL=new RegExp('^ft:1:z:'+token+'$','u');
const POLICY_CHOICE=new RegExp('^ft:1:p:'+chat+':'+thread+':([01])$','u');
const POLICY_CONFIRM=new RegExp('^ft:1:e:'+token+'$','u');
const POLICY_CANCEL=new RegExp('^ft:1:k:'+token+'$','u');
const POLICY_HISTORY=new RegExp('^ft:1:j:'+chat+':'+thread+':'+page+'$','u');
const PUB_CHOICE=new RegExp('^ft:1:q:'+chat+':'+thread+':([01])$','u');
const PUB_CONFIRM=new RegExp('^ft:1:r:'+token+'$','u');
const PUB_CANCEL=new RegExp('^ft:1:s:'+token+'$','u');
const PUB_HISTORY=new RegExp('^ft:1:b:'+chat+':'+thread+':'+page+'$','u');
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
interface PendingPolicy{
 readonly group:string;readonly thread:number;readonly mode:ForumTopicEducationMode;
 readonly proof:string;readonly createdAt:number;readonly version:number;
}
function parsePolicy(value:unknown):PendingPolicy|null{
 if(typeof value!=='string'||!value.startsWith(POLICY_PREFIX))return null;
 let raw:unknown;
 try{raw=JSON.parse(value.slice(POLICY_PREFIX.length));}catch{return null;}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const p=raw as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='createdAt,group,mode,proof,thread,version'||
  !id(p.group)||typeof p.thread!=='number'||!topicId(p.thread)||
  (p.mode!=='INHERIT'&&p.mode!=='PAUSED')||
  typeof p.proof!=='string'||!/^[a-f0-9]{64}$/u.test(p.proof)||
  !clock(p.createdAt)||typeof p.version!=='number'||
  !Number.isSafeInteger(p.version)||p.version<1)return null;
 return p as unknown as PendingPolicy;
}
interface PendingPublication{
 readonly group:string;readonly thread:number;readonly action:ForumTopicNotePublicationAction;
 readonly proof:string;readonly createdAt:number;readonly version:number;
}
function parsePublication(value:unknown):PendingPublication|null{
 if(typeof value!=='string'||!value.startsWith(PUBLICATION_PREFIX))return null;
 let raw:unknown;
 try{raw=JSON.parse(value.slice(PUBLICATION_PREFIX.length));}catch{return null;}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const p=raw as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='action,createdAt,group,proof,thread,version'||
  !id(p.group)||typeof p.thread!=='number'||!topicId(p.thread)||
  (p.action!=='PUBLISH'&&p.action!=='WITHDRAW')||
  typeof p.proof!=='string'||!/^[a-f0-9]{64}$/u.test(p.proof)||
  !clock(p.createdAt)||typeof p.version!=='number'||
  !Number.isSafeInteger(p.version)||p.version<1)return null;
 return p as unknown as PendingPublication;
}
export function validOwnerForumTopicRoute(value:unknown):boolean{
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
  (HOME.test(value)||GROUP.test(value)||DETAIL.test(value)||
   LIVE.test(value)||SOURCE_PREVIEW.test(value)||
   HISTORY.test(value)||
   CONFIRM.test(value)||CANCEL.test(value)||
   NOTE_CONFIRM.test(value)||NOTE_CANCEL.test(value)||
   POLICY_CHOICE.test(value)||POLICY_CONFIRM.test(value)||
   POLICY_CANCEL.test(value)||POLICY_HISTORY.test(value)||
   PUB_CHOICE.test(value)||PUB_CONFIRM.test(value)||
   PUB_CANCEL.test(value)||PUB_HISTORY.test(value)||
   validForumTopicControlRoute(value)||validForumBroadcastRoute(value));
}
export class OwnerForumTopicEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly gateway?:TelegramBotApiModerationGateway,
  private readonly safety:()=>Promise<boolean>=async()=>false){}
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
  const education=ownerForumTopicEducationPolicy(s,this.policy,actor,g,t,now);
  const publication=note?ownerForumNotePublication(s,this.policy,actor,g,t,now):undefined;
  const actions=forumTopicActionHistory(s,this.policy,actor,g,t,now);
  if(!education||note&&publication===null||actions===null)return null;
  const last=actions[0],quarantined=last!==undefined&&
   (last.outcome===undefined||last.outcome==='UNKNOWN_OUTCOME');
  const canClose=!quarantined&&!(last?.action==='CLOSE'&&last.outcome==='CONFIRMED');
  const canReopen=!quarantined&&!(last?.action==='REOPEN'&&last.outcome==='CONFIRMED');
  return ui('<b>🧩 بيانات موضوع محلي</b>\n'+
   'المجموعة: <code>'+g+'</code>\n'+
   'رقم الموضوع: <code>'+topic.threadId+'</code>\n'+
   'العنوان: '+esc(topic.title)+'\n'+
   'إصدار اعتماد المجموعة: '+topic.groupVersion+'\n'+
   'التسجيل (UTC): '+new Date(topic.registeredAt).toISOString().slice(0,16).replace('T',' ')+
   '\nالتصفح التعليمي لهذا الموضوع: '+
   (education.mode==='PAUSED'?'متوقف محليًا':'يتبع سياسة المجموعة')+
   ' · المراجعة '+education.revision+
   '\nحالة تحكم Telegram: '+
   (quarantined?'محجوزة بسبب محاولة بنتيجة غير مؤكدة':
    last?'آخر محاولة مسجلة؛ الحالة الحية تحتاج مراجعة':'لا توجد محاولات محلية')+
   '\nحالة عرض الملاحظة للطلاب: '+
   (publication?.published?
    education.mode==='PAUSED'?'معتمدة لكن التصفح متوقف في هذا الموضوع':
     'معتمدة للعرض عند طلبها من هذا الموضوع':'غير منشورة')+
   '\nالملاحظة التحريرية: '+(note?esc(note.text):'لم تُعتمد ملاحظة بعد.')+
   (note?'\nمراجعة الملاحظة المحلية: '+note.revision:'')+
   '\nلإضافة ملاحظة: <code>/topicnote '+g+' '+t+' النص_التحريري</code>'+
   '\nلا يسمح هذا السجل بإرسال رسائل أو فرض سياسات مستقلة؛ يلزم التأكد من نوع المجموعة وصلاحية الموضوع الحية.',
   [...(canClose?[[btn('🔒 طلب إغلاق الموضوع','ft:1:u:'+g+':'+t+':c')]]:[]),
    ...(canReopen?[[btn('🔓 طلب إعادة فتح الموضوع','ft:1:u:'+g+':'+t+':o')]]:[]),
    [btn('📨 سجل نشرات الموضوع','ft:1:6:'+g+':'+t+':0')],
    [btn('🕘 سجل عمليات Telegram للموضوع','ft:1:9:'+g+':'+t+':0')],
    ...(note?[[btn(publication?.published?
      '🛑 سحب إتاحة الملاحظة':'✅ اعتماد الملاحظة للعرض',
      'ft:1:q:'+g+':'+t+':'+(publication?.published?'0':'1'))]]:[]),
    ...(note?[[btn('🕘 سجل اعتماد نشر الملاحظات',
     'ft:1:b:'+g+':'+t+':0')]]:[]),
    [btn('📚 معاينة مصادر النشر للموضوع','ft:1:m:'+g+':'+t)],
    [btn('🔎 فحص صلاحيات Telegram الحية','ft:1:f:'+g+':'+t)],
    [btn(education.mode==='PAUSED'?'▶️ استئناف تصفح الموضوع':'⏸ إيقاف التصفح في الموضوع',
      'ft:1:p:'+g+':'+t+':'+(education.mode==='PAUSED'?'0':'1'))],
    [btn('🕘 سجل مراجعات سياسة التصفح','ft:1:j:'+g+':'+t+':0')],
    [btn('🕘 سجل مراجعات الملاحظة','ft:1:v:'+g+':'+t+':0')],
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
 /** Local setting affects educational browsing in this thread only. */
 async preparePolicy(actor:string,g:string,t:number,
  mode:ForumTopicEducationMode):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.access(s,actor,now)||!id(g)||!topicId(t))return null;
   const proof=forumTopicEducationProof(s,this.policy,actor,g,t,mode,now);
   const version=forumTopicGroupAccess(s,this.policy,actor,g,now);
   if(!proof||version===null)return null;
   const pending=s.callbacks.filter(c=>c.actorId===actor&&
    c.ref.startsWith(POLICY_PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>now);
   if(pending.length>=100)return null;
   const nonce=randomBytes(18).toString('base64url'),ref=POLICY_PREFIX+nonce;
   if(s.callbacks.some(c=>c.ref===ref))return null;
   for(const c of pending)c.revoked=true;
   const value:PendingPolicy={group:g,thread:t,mode,proof,createdAt:now,version};
   s.callbacks.push({ref,action:POLICY_PREFIX+JSON.stringify(value),
    actorId:actor,chatId:'private',policyVersion:version,oneShot:true,
    used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة سياسة تصفح الموضوع</b>\n'+
    'المجموعة: <code>'+g+'</code>\n'+
    'الموضوع: <code>'+t+'</code>\n'+
    'الإعداد الجديد: '+(mode==='PAUSED'?
     'إيقاف التصفح التعليمي داخل هذا الموضوع':
     'اتباع أذونات التصفح التعليمي الحالية للمجموعة')+'\n'+
    'لا تُغيّر هذه الموافقة قواعد Telegram أو حقوق نشر المالك، ولا توقف أو تفتح الموضوع.'+
    '\nتأكيد خاص لمرة واحدة خلال دقيقتين.',
    [[btn('✅ تأكيد تغيير سياسة الموضوع','ft:1:e:'+nonce)],
     [btn('✖ إلغاء','ft:1:k:'+nonce)],
     [btn('↩️ تفاصيل الموضوع','ft:1:d:'+g+':'+t)]]);
  });
 }
 private async decidePolicy(actor:string,nonce:string,apply:boolean):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),ref=POLICY_PREFIX+nonce,
    rows=s.callbacks.filter(c=>c.ref===ref),c=rows[0];
   if(!this.access(s,actor,now)||rows.length!==1||!c||
    c.actorId!==actor||c.chatId!=='private'||c.used||c.revoked||
    c.oneShot!==true||!clock(c.expiresAt)||
    c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   const p=parsePolicy(c.action);
   if(!p||p.createdAt>now||c.expiresAt!==p.createdAt+TTL||
    c.policyVersion!==p.version)return null;
   if(apply&&!setForumTopicEducationPolicy(s,this.policy,actor,
    p.group,p.thread,p.mode,now,p.proof))return null;
   c.used=true;
   return this.detail(s,actor,now,p.group,p.thread);
  });
 }
 /** Advisory live rights only. No topic-close or Telegram send side effect.
  * The official getChat/getChatMember observations do not prove that the
  * particular message_thread_id exists or is currently open.
  */
 private sourcePreview(s:BotState,actor:string,now:number,g:string,t:number):
 OwnerInlineScreen|null{
  const data=previewForumTopicEducationalSources(s,this.policy,actor,g,t,now);
  if(!data)return null;
  const lines=data.sources.map((source,i)=>
   '▫️ '+(i+1)+'. '+esc(source.title)+
   ' · <code>'+source.id+'</code>'+
   (source.approvedForBroadcast?' · لديه نص منشور مراجَع':' · غير جاهز للنشر'));
  return ui('<b>📚 معاينة مصادر النشر إلى موضوع Forum</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'الاسم المحلي: '+esc(data.topicTitle)+'\n'+
   'حالة التصفح: '+(data.topicPaused?'متوقف':'يتبع سياسة المجموعة')+'\n'+
   'التصنيفات المعتمدة المرئية في الموضوع: '+data.categoryCount+'\n'+
   'الموارد المنشورة المتاحة في المصدر: '+data.resourceCount+'\n'+
   'منها موارد ذات نص نشر مراجَع: '+data.approvedForBroadcastCount+'\n'+
   'أمثلة على المصادر:\n'+(lines.length?lines.join('\n'):'لا توجد موارد مناسبة حاليًا.')+'\n'+
   'هذه معاينة قراءة محلية فقط؛ لا تثبت أن الموضوع موجود أو مفتوح أو أن Telegram يسمح بالنشر إليه.'+
   '\nلا يرسل هذا الفحص أي رسالة. للنشر المستقل بعد موافقتين، اكتب في خاص البوت: '+
   '<code>/topicbroadcast '+g+' '+t+' معرف_المورد</code>.'+
   ' يلزم أن يكون نص المورد المنشور قد تمت مراجعته. فحص حقوق Telegram الحية متاح بصورة مستقلة.',
   [[btn('🔎 فحص صلاحيات Telegram الحية','ft:1:f:'+g+':'+t)],
    [btn('↩️ تفاصيل الموضوع','ft:1:d:'+g+':'+t)]]);
 }

 private async live(actor:string,g:string,t:number):Promise<OwnerInlineScreen|null>{
  const before=await this.store.snapshot(),start=this.clock();
  const topic=localForumTopics(before,this.policy,actor,g,start)?.find(x=>x.threadId===t);
  const settings=ownerForumTopicEducationPolicy(before,this.policy,actor,g,t,start);
  if(!topic||!settings||!this.gateway)return null;
  const proof=JSON.stringify([topic,settings,
   before.chats.filter(c=>c.id===g),
   before.grants.filter(x=>x.chatId===g&&x.actor===actor),
   before.privateFeatures,before.privateSettingsRevision??0]);
  const intact=async()=>{
   const now=this.clock(),state=await this.store.snapshot();
   if(!clock(now)||now<start||now>=start+TTL||
    !this.access(state,actor,now))return false;
   const current=localForumTopics(state,this.policy,actor,g,now)?.find(x=>x.threadId===t);
   const config=ownerForumTopicEducationPolicy(state,this.policy,actor,g,t,now);
   return !!current&&!!config&&JSON.stringify([current,config,
    state.chats.filter(c=>c.id===g),
    state.grants.filter(x=>x.chatId===g&&x.actor===actor),
    state.privateFeatures,state.privateSettingsRevision??0])===proof;
  };
  const safe=async()=>{try{return await this.safety()===true;}catch{return false;}};
  const trusted=()=>this.gateway!==undefined&&
   TelegramBotApiModerationGateway.usesOfficialForumStatusRead(this.gateway)&&
   TelegramBotApiModerationGateway.usesOfficialRightsRead(this.gateway);
  if(!trusted()||!await safe()||!await intact())return null;
  let forum:'FORUM'|'NOT_FORUM'|'UNKNOWN'='UNKNOWN',
      right:'GRANTED'|'DENIED'|'UNKNOWN'='UNKNOWN';
  try{forum=await this.gateway.inspectForumStatus(g);}
  catch{/* unverified */}
  if(!trusted()||!await safe()||!await intact())return null;
  if(forum==='FORUM'){
   try{const grant=await this.gateway.inspectBotAdminRights(g);
    right=grant.manageTopics;}catch{/* unverified */}
  }
  if(!trusted()||!await safe()||!await intact())return null;
  return ui('<b>🔎 فحص صلاحيات مواضيع Telegram</b>\n'+
   'المجموعة: <code>'+g+'</code>\n'+
   'رقم الموضوع المحلي: <code>'+t+'</code>\n'+
   'حالة Forum الرسمية (getChat): '+
   (forum==='FORUM'?'مجموعة Forum مفعلة':
    forum==='NOT_FORUM'?'ليست مجموعة Forum':'غير مؤكدة')+'\n'+
   'حق البوت في إدارة المواضيع (getChatMember): '+
   (right==='GRANTED'?'متاح لحظة الفحص':
    right==='DENIED'?'غير متاح':'غير مؤكد')+'\n'+
   'هذه قراءة لحظية استشارية؛ لا تكشف ما إذا كان الموضوع نفسه موجودًا أو مفتوحًا، ولا تتحقق من صلاحية المشرف البشري، ولا تصرح بتنفيذ الإغلاق أو النشر.',
   [[btn('🔄 إعادة الفحص','ft:1:f:'+g+':'+t)],
    [btn('↩️ تفاصيل الموضوع','ft:1:d:'+g+':'+t)]]);
 }

 private educationHistory(s:BotState,actor:string,now:number,
  g:string,t:number,page:number):OwnerInlineScreen|null{
  const rows=forumTopicEducationHistory(s,this.policy,actor,g,t,now);
  if(!rows)return null;
  const pages=Math.max(1,Math.ceil(rows.length/SIZE));
  if(page>=pages)return null;
  const lines=rows.slice(page*SIZE,(page+1)*SIZE).map(v=>
   '▫️ '+v.revision+' · '+(v.mode==='PAUSED'?'إيقاف التصفح':'اتباع سياسة المجموعة')+
   ' · '+new Date(v.at).toISOString().slice(0,16).replace('T',' ')+' UTC');
  const buttons:{text:string;callback_data:string}[][]=[];
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(btn('⬅️ السابق','ft:1:j:'+g+':'+t+':'+(page-1)));
  if(page+1<pages)nav.push(btn('➡️ التالي','ft:1:j:'+g+':'+t+':'+(page+1)));
  if(nav.length)buttons.push(nav);
  buttons.push([btn('↩️ تفاصيل الموضوع','ft:1:d:'+g+':'+t)]);
  return ui('<b>🕘 سجل سياسات التصفح لكل موضوع</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'إجمالي التغييرات المعتمدة: '+rows.length+' · الصفحة '+(page+1)+'/'+pages+'\n'+
   (lines.length?lines.join('\n'):'لا توجد تغييرات مستقلة؛ الإعداد يتبع سياسة المجموعة.')+
   '\nالتسجيل محلي ولا يغيّر أو يغلق أو يعيد فتح موضوعًا في Telegram.',
   buttons);
 }

 /** TOPIC-004: independent owner approval for displaying the CURRENT note
  * only when a member explicitly requests it from the matching thread.
  */
 async preparePublication(actor:string,g:string,t:number,
  action:ForumTopicNotePublicationAction):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.access(s,actor,now)||!id(g)||!topicId(t))return null;
   const proof=forumNotePublicationProof(s,this.policy,actor,g,t,action,now);
   const version=forumTopicGroupAccess(s,this.policy,actor,g,now);
   const current=ownerForumNotePublication(s,this.policy,actor,g,t,now);
   if(!proof||version===null||!current)return null;
   const pending=s.callbacks.filter(c=>c.actorId===actor&&
    c.ref.startsWith(PUBLICATION_PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>now);
   if(pending.length>=100)return null;
   const nonce=randomBytes(18).toString('base64url'),ref=PUBLICATION_PREFIX+nonce;
   if(s.callbacks.some(c=>c.ref===ref))return null;
   for(const c of pending)c.revoked=true;
   const value:PendingPublication={group:g,thread:t,action,proof,createdAt:now,version};
   s.callbacks.push({ref,action:PUBLICATION_PREFIX+JSON.stringify(value),
    actorId:actor,chatId:'private',policyVersion:version,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 اعتماد نشر الملاحظة داخل موضوع Forum</b>\n'+
    'المجموعة: <code>'+g+'</code>\n'+
    'الموضوع: <code>'+t+'</code>\n'+
    'مراجعة الملاحظة: '+current.note.revision+'\n'+
    'الإجراء: '+(action==='PUBLISH'?
     'السماح بعرضها للأعضاء عند طلب /topicfaq من الموضوع ذاته':
     'سحب اعتماد العرض الحالي')+'\n'+
    'نص الملاحظة:\n'+esc(current.note.text)+'\n'+
    'لن تُنشر تلقائيًا أي رسالة. تغيير نص الملاحظة بعد هذا الإقرار يسحب صلاحية عرض الإصدار القديم.\n'+
    'تأكيد خاص لمرة واحدة، صالح لدقيقتين فقط.',
    [[btn(action==='PUBLISH'?'✅ اعتماد عرض الملاحظة':'🛑 تأكيد سحب الاعتماد',
      'ft:1:r:'+nonce)],
     [btn('✖ إلغاء','ft:1:s:'+nonce)],
     [btn('↩️ الموضوع','ft:1:d:'+g+':'+t)]]);
  });
 }
 private async decidePublication(actor:string,nonce:string,apply:boolean):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),ref=PUBLICATION_PREFIX+nonce,
    rows=s.callbacks.filter(c=>c.ref===ref),c=rows[0];
   if(!this.access(s,actor,now)||rows.length!==1||!c||
    c.actorId!==actor||c.chatId!=='private'||c.oneShot!==true||
    c.used||c.revoked||!clock(c.expiresAt)||
    c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   const action=parsePublication(c.action);
   if(!action||action.createdAt>now||
    c.expiresAt!==action.createdAt+TTL||
    c.policyVersion!==action.version)return null;
   if(apply&&!changeForumNotePublication(s,this.policy,actor,
    action.group,action.thread,action.action,now,action.proof))
    return null;
   c.used=true;
   return this.detail(s,actor,now,action.group,action.thread);
  });
 }
 private publicationHistory(s:BotState,actor:string,now:number,g:string,
  t:number,p:number):OwnerInlineScreen|null{
  const list=forumNotePublicationHistory(s,this.policy,actor,g,t,now);
  // A missing draft has no publication history, but never suppress an
  // invalid or revoked registration silently.
  if(!list)return null;
  const pages=Math.max(1,Math.ceil(list.length/SIZE));
  if(p>=pages)return null;
  const lines=list.slice(p*SIZE,(p+1)*SIZE).map(r=>
   '▫️ مراجعة '+r.eventRevision+' · '+(r.action==='PUBLISH'?
    'اعتماد عرض النص':'سحب العرض')+' · النص '+r.noteRevision+
   ' · '+new Date(r.at).toISOString().slice(0,16).replace('T',' ')+' UTC');
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','ft:1:b:'+g+':'+t+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','ft:1:b:'+g+':'+t+':'+(p+1)));
  return ui('<b>🕘 سجل اعتماد عرض الملاحظات</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'عدد القرارات: '+list.length+' · صفحة '+(p+1)+'/'+pages+'\n'+
   (lines.length?lines.join('\n'):'لا توجد قرارات نشر حتى الآن.')+'\n'+
   'سجل محلي لا يثبت تسليم Telegram، ولا يعيد إتاحة نسخة معدلة دون اعتماد.',
   [...(nav.length?[nav]:[]),[btn('↩️ الموضوع','ft:1:d:'+g+':'+t)]]);
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
  if(validForumTopicControlRoute(data))
   return new TelegramForumTopicControl(this.store,this.policy,
    this.gateway,this.safety,this.clock).handle(actor,data);
  if(validForumBroadcastRoute(data))
   return new TelegramForumTopicBroadcast(this.store,this.policy,
    this.gateway,this.safety,this.clock).handle(actor,data);
  const pub=PUB_CONFIRM.exec(data);
  if(pub)return this.decidePublication(actor,pub[1]!,true);
  const withdraw=PUB_CANCEL.exec(data);
  if(withdraw)return this.decidePublication(actor,withdraw[1]!,false);
  const pubChoice=PUB_CHOICE.exec(data);
  if(pubChoice)return this.preparePublication(actor,pubChoice[1]!,
   Number(pubChoice[2]),pubChoice[3]==='1'?'PUBLISH':'WITHDRAW');
  const pc=POLICY_CONFIRM.exec(data);
  if(pc)return this.decidePolicy(actor,pc[1]!,true);
  const pk=POLICY_CANCEL.exec(data);
  if(pk)return this.decidePolicy(actor,pk[1]!,false);
  const choice=POLICY_CHOICE.exec(data);
  if(choice)return this.preparePolicy(actor,choice[1]!,Number(choice[2]),
   choice[3]==='1'?'PAUSED':'INHERIT');
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
  const sources=SOURCE_PREVIEW.exec(data);
  if(sources)return this.sourcePreview(s,actor,now,sources[1]!,Number(sources[2]));
  const live=LIVE.exec(data);
  if(live)return this.live(actor,live[1]!,Number(live[2]));
  const h=HOME.exec(data);if(h)return this.home(s,actor,now,Number(h[1]));
  const g=GROUP.exec(data);
  if(g)return this.group(s,actor,now,g[1]!,Number(g[2]));
  const d=DETAIL.exec(data);
  if(d)return this.detail(s,actor,now,d[1]!,Number(d[2]));
  const pubHistory=PUB_HISTORY.exec(data);
  if(pubHistory)return this.publicationHistory(s,actor,now,
   pubHistory[1]!,Number(pubHistory[2]),Number(pubHistory[3]));
  const ph=POLICY_HISTORY.exec(data);
  if(ph)return this.educationHistory(s,actor,now,ph[1]!,Number(ph[2]),Number(ph[3]));
  const hst=HISTORY.exec(data);
  return hst?this.history(s,actor,now,hst[1]!,Number(hst[2]),Number(hst[3])):null;
 }
}
