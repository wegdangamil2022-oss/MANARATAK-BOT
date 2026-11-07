import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {topicMonitorProof,saveTopicMonitor,ownerTopicMonitor,
 topicMonitorHistory,type TopicMonitorChange,type TopicMonitorRule}
 from './group-forum-topic-monitor.js';

/** Owner-private, two-minute, one-shot approval for editorial rule edits.
 * Changing a topic rule never overrides group moderation or enforces a
 * Telegram sanction: all topic-specific rules are MONITOR only.
 */
const PREFIX='group-forum:monitor-preview:',TTL=120000;
const G='(-[1-9][0-9]{0,15})',T='([1-9][0-9]{0,9})',
 PAGE='(0|[1-9][0-9]{0,2})',TOKEN='([A-Za-z0-9_-]{24})';
export const FORUM_MONITOR_HOME=new RegExp('^ft:1:t:'+G+':'+T+'$','u');
export const FORUM_MONITOR_CHOICE=new RegExp('^ft:1:w:'+G+':'+T+':([01])$','u');
export const FORUM_MONITOR_CONFIRM=new RegExp('^ft:1:a:'+TOKEN+'$','u');
export const FORUM_MONITOR_CANCEL=new RegExp('^ft:1:l:'+TOKEN+'$','u');
export const FORUM_MONITOR_HISTORY=new RegExp('^ft:1:7:'+G+':'+T+':'+PAGE+'$','u');
export function validOwnerForumMonitorRoute(x:unknown):x is string{
 return typeof x==='string'&&Buffer.byteLength(x,'utf8')<=64&&
  (FORUM_MONITOR_HOME.test(x)||FORUM_MONITOR_CHOICE.test(x)||
   FORUM_MONITOR_CONFIRM.test(x)||FORUM_MONITOR_CANCEL.test(x)||
   FORUM_MONITOR_HISTORY.test(x));
}
const id=(x:unknown):x is string=>typeof x==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const user=(x:unknown):x is string=>typeof x==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const topic=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=1&&x<=2147483647;
const clock=(x:unknown):x is number=>typeof x==='number'&&
 Number.isSafeInteger(x)&&x>=0&&x<=8640000000000000-TTL;
const b=(text:string,callback_data:string)=>({text,callback_data});
const screen=(text:string,keyboard:{text:string;callback_data:string}[][]):
 OwnerInlineScreen=>({text,keyboard:{inline_keyboard:keyboard}});
const escape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').
 replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const describe=(r:TopicMonitorRule)=>r.kind==='WORD'?'كلمة: '+r.value:
 r.kind==='PHRASE'?'عبارة: '+r.value:
 r.kind==='LINK'?'روابط الإنترنت':'رسائل معاد توجيهها';
type Pending={group:string;thread:number;change:TopicMonitorChange;
 proof:string;createdAt:number;version:number};
function validChange(x:unknown):x is TopicMonitorChange{
 if(!x||typeof x!=='object'||Array.isArray(x))return false;
 const v=x as Record<string,unknown>;
 if(v.kind==='MODE')return Object.keys(v).sort().join(',')==='kind,mode'&&
  (v.mode==='OFF'||v.mode==='MONITOR');
 if(v.kind==='REMOVE')return Object.keys(v).sort().join(',')==='index,kind'&&
  Number.isSafeInteger(v.index)&&Number(v.index)>=0&&Number(v.index)<24;
 if(v.kind!=='ADD'||Object.keys(v).sort().join(',')!=='kind,rule'||
  !v.rule||typeof v.rule!=='object'||Array.isArray(v.rule))return false;
 const r=v.rule as Record<string,unknown>;
 if(Object.keys(r).sort().join(',')!=='kind,value'||
  !['WORD','PHRASE','LINK','FORWARD'].includes(String(r.kind))||
  typeof r.value!=='string')return false;
 return r.value.length<=240&&
  (r.kind==='LINK'||r.kind==='FORWARD'?r.value==='':
   r.value.length>=2);
}
function parse(value:unknown):Pending|null{
 if(typeof value!=='string'||!value.startsWith(PREFIX))return null;
 let v:unknown;
 try{v=JSON.parse(value.slice(PREFIX.length));}catch{return null;}
 if(!v||typeof v!=='object'||Array.isArray(v))return null;
 const x=v as Record<string,unknown>;
 if(Object.keys(x).sort().join(',')!=='change,createdAt,group,proof,thread,version'||
  !id(x.group)||!topic(x.thread)||!validChange(x.change)||
  typeof x.proof!=='string'||!/^[a-f0-9]{64}$/u.test(x.proof)||
  !clock(x.createdAt)||!Number.isSafeInteger(x.version)||
  Number(x.version)<1)return null;
 return x as unknown as Pending;
}
const label=(x:TopicMonitorChange)=>x.kind==='MODE'?
 x.mode==='MONITOR'?'تفعيل مراقبة الموضوع':'إيقاف مراقبة الموضوع':
 x.kind==='ADD'?'إضافة قاعدة '+describe(x.rule):
 'حذف القاعدة رقم '+(x.index+1);
export class TelegramOwnerForumMonitor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly now:()=>number=Date.now){}
 private allowed(s:BotState,owner:string,g:string,t:number,now:number){
  return user(owner)&&this.policy.isOwner(owner)&&id(g)&&topic(t)&&
   clock(now)&&!!ownerTopicMonitor(s,this.policy,owner,g,t,now);
 }
 async detail(owner:string,g:string,t:number):Promise<OwnerInlineScreen|null>{
  const state=await this.store.snapshot(),at=this.now();
  if(!this.allowed(state,owner,g,t,at))return null;
  const current=ownerTopicMonitor(state,this.policy,owner,g,t,at);
  if(!current)return null;
  const rules=current.rules.map((r,i)=>
   '▫️ '+(i+1)+'. '+escape(describe(r)));
  return screen('<b>🛡 مراقبة المحتوى لهذا الموضوع</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'الوضع: '+(current.mode==='MONITOR'?'مراقبة وتدقيق فقط':'متوقف')+
   ' · المراجعة '+current.revision+'\n'+
   'القواعد الخاصة: '+current.rules.length+'/24\n'+
   (rules.length?rules.join('\n'):'لا توجد قواعد خاصة.')+'\n'+
   'أوامر الإضافة من خاص المالك:\n'+
   '<code>/topicguard '+g+' '+t+' word كلمة</code>\n'+
   '<code>/topicguard '+g+' '+t+' phrase عبارة</code>\n'+
   '<code>/topicguard '+g+' '+t+' link</code>\n'+
   '<code>/topicguard '+g+' '+t+' forward</code>\n'+
   '<code>/topicguard '+g+' '+t+' remove 1</code>\n'+
   'لا تعدّل هذه الأدوات عقوبات المجموعة. نتائج الموضوع مراجعة فقط، ولا حذف أو كتم أو حظر تلقائي.',
   [[b(current.mode==='OFF'?'▶️ تفعيل المراقبة':'⏹ إيقاف المراقبة',
      'ft:1:w:'+g+':'+t+':'+(current.mode==='OFF'?'1':'0'))],
    [b('🕘 سجل إعدادات المراقبة','ft:1:7:'+g+':'+t+':0')],
    [b('↩️ تفاصيل الموضوع','ft:1:d:'+g+':'+t)]]);
 }
 async prepare(owner:string,g:string,t:number,change:TopicMonitorChange):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.now();
   if(!this.allowed(s,owner,g,t,now))return null;
   const old=ownerTopicMonitor(s,this.policy,owner,g,t,now);
   const proof=topicMonitorProof(s,this.policy,owner,g,t,change,now);
   if(!old||!proof)return null;
   const active=s.callbacks.filter(c=>c.actorId===owner&&
    c.ref.startsWith(PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>now);
   if(active.length>=64)return null;
   const token=randomBytes(18).toString('base64url'),ref=PREFIX+token;
   if(s.callbacks.some(c=>c.ref===ref))return null;
   for(const c of active)c.revoked=true;
   const value:Pending={group:g,thread:t,change,proof,
    version:old.groupVersion,createdAt:now};
   s.callbacks.push({ref,action:PREFIX+JSON.stringify(value),actorId:owner,
    chatId:'private',policyVersion:old.groupVersion,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   return screen('<b>🔎 معاينة تعديل قواعد موضوع Forum</b>\n'+
    'المجموعة: <code>'+g+'</code>\nالموضوع: <code>'+t+'</code>\n'+
    'التغيير: '+escape(label(change))+'\n'+
    'لا تنشأ عقوبة تلقائية من هذه السياسة؛ وتظل سياسات المجموعة العامة مستقلة.\n'+
    'موافقة خاصة لمرة واحدة صالحة لدقيقتين.',
    [[b('✅ اعتماد التعديل','ft:1:a:'+token)],
     [b('✖ إلغاء','ft:1:l:'+token)],
     [b('↩️ إعدادات الموضوع','ft:1:t:'+g+':'+t)]]);
  });
 }
 private async decide(owner:string,token:string,apply:boolean):
 Promise<OwnerInlineScreen|null>{
  const decided=await this.store.transaction(s=>{
   const now=this.now(),ref=PREFIX+token,
    rows=s.callbacks.filter(c=>c.ref===ref),c=rows[0];
   if(!user(owner)||!this.policy.isOwner(owner)||!clock(now)||
    rows.length!==1||!c||c.actorId!==owner||c.chatId!=='private'||
    c.oneShot!==true||c.used||c.revoked||!clock(c.expiresAt)||
    c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   const pending=parse(c.action);
   if(!pending||pending.createdAt>now||
    c.expiresAt!==pending.createdAt+TTL||
    c.policyVersion!==pending.version||
    !this.allowed(s,owner,pending.group,pending.thread,now))return null;
   if(apply&&!saveTopicMonitor(s,this.policy,owner,pending.group,
    pending.thread,pending.change,now,pending.proof))return null;
   c.used=true;return {g:pending.group,t:pending.thread};
  });
  return decided?this.detail(owner,decided.g,decided.t):null;
 }
 async history(owner:string,g:string,t:number,page:number):
 Promise<OwnerInlineScreen|null>{
  const state=await this.store.snapshot(),now=this.now();
  if(!clock(now)||!Number.isSafeInteger(page)||page<0||page>999)return null;
  const records=topicMonitorHistory(state,this.policy,owner,g,t,now);
  if(!records)return null;
  const pages=Math.max(1,Math.ceil(records.length/8));
  if(page>=pages)return null;
  const items=records.slice(page*8,(page+1)*8).map(x=>
   '▫️ مراجعة '+x.revision+' · '+
   (x.mode==='MONITOR'?'مراقبة':'متوقف')+
   ' · القواعد '+x.rules.length+' · '+
   new Date(x.at).toISOString().slice(0,16).replace('T',' ')+' UTC');
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(b('⬅️ السابق','ft:1:7:'+g+':'+t+':'+(page-1)));
  if(page+1<pages)nav.push(b('➡️ التالي','ft:1:7:'+g+':'+t+':'+(page+1)));
  return screen('<b>🕘 سجل مراقبة محتوى الموضوع</b>\n'+
   'المجموعة: <code>'+g+'</code> · الموضوع: <code>'+t+'</code>\n'+
   'عدد المراجعات: '+records.length+' · صفحة '+(page+1)+'/'+pages+'\n'+
   (items.length?items.join('\n'):'لا توجد تعديلات.')+'\n'+
   'السجل معلوماتي ولا يجيز تجاوز أي سياسة حماية للمجموعة.',
   [...(nav.length?[nav]:[]),[b('↩️ إعدادات الموضوع','ft:1:t:'+g+':'+t)]]);
 }
 async handle(owner:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!user(owner)||!this.policy.isOwner(owner)||
   !validOwnerForumMonitorRoute(data))return null;
  const confirm=FORUM_MONITOR_CONFIRM.exec(data);
  if(confirm)return this.decide(owner,confirm[1]!,true);
  const cancel=FORUM_MONITOR_CANCEL.exec(data);
  if(cancel)return this.decide(owner,cancel[1]!,false);
  const choice=FORUM_MONITOR_CHOICE.exec(data);
  if(choice)return this.prepare(owner,choice[1]!,Number(choice[2]),
   {kind:'MODE',mode:choice[3]==='1'?'MONITOR':'OFF'});
  const list=FORUM_MONITOR_HISTORY.exec(data);
  if(list)return this.history(owner,list[1]!,Number(list[2]),Number(list[3]));
  const home=FORUM_MONITOR_HOME.exec(data);
  return home?this.detail(owner,home[1]!,Number(home[2])):null;
 }
}
