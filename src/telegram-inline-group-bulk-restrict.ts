import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {isValidGroupProtectionRecord,type GroupProtectionRecord} from './protection-rules.js';

/** Restrictive bulk owner actions. Deliberately OFF-only: no grant of rights,
 * enabling of AI, monitor, or Telegram enforcement. Each preview represents
 * at most 8 current groups and is re-evaluated under a single store lock. */
const PAGESIZE=8,TTL=120_000,PREFIX='owner-group-bulk-restrict:';
const pagePattern='(0|[1-9][0-9]{0,2})';
const home=/^gb:1:h$/u;
const page=new RegExp('^gb:1:p:([am]):'+pagePattern+'$','u');
const preview=new RegExp('^gb:1:v:([am]):'+pagePattern+'$','u');
const confirm=/^gb:1:c:([A-Za-z0-9_-]{24})$/u;
const cancel=/^gb:1:k:([A-Za-z0-9_-]{24})$/u;
const logPage=new RegExp('^gb:1:r:p:'+pagePattern+'$','u');
const logView=/^gb:1:r:v:([A-Za-z0-9_-]{24})$/u;
type Mode='a'|'m';
type Selection={
 all:Chat[];visible:Chat[];eligible:Chat[];records:GroupProtectionRecord[];
 maxPage:number;digest:string
};
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const validTime=(now:number)=>Number.isSafeInteger(now)&&now>=0&&now<=8_640_000_000_000_000-TTL;
const validId=(id:string)=>/^-[1-9][0-9]{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
export function validOwnerGroupBulkRestrictRoute(data:unknown):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return false;
 return home.test(data)||[page,preview,confirm,cancel,logPage,logView].some(regex=>regex.test(data));
}
function approved(s:BotState):Chat[]{
 const counts=new Map<string,number>();
 for(const c of s.chats)counts.set(c.id,(counts.get(c.id)??0)+1);
 return s.chats.filter(c=>c.approved&&counts.get(c.id)===1&&validId(c.id)&&
  Number.isSafeInteger(c.version)&&c.version>=1&&c.version<=9_999_999_999)
  .sort((a,b)=>a.id.localeCompare(b.id));
}
function currentMonitor(s:BotState,c:Chat,now:number):GroupProtectionRecord|null{
 if(!c.scopes.includes('moderation'))return null;
 const rows=(s.protectionPolicies??[]).filter(r=>r.policy.chatId===c.id);
 if(rows.length!==1||!isValidGroupProtectionRecord(rows[0])||
  rows[0]!.chatPolicyVersion!==c.version||rows[0]!.updatedAt>now||
  rows[0]!.policy.mode!=='MONITOR'||rows[0]!.policy.revision>=Number.MAX_SAFE_INTEGER-1)
  return null;
 return rows[0]!;
}
export class OwnerGroupBulkRestrict {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private allowed(s:BotState,actor:string,now:number):boolean{
  return validTime(now)&&this.policy.isOwner(actor)&&this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 /** Current page and ALL relevant owner approvals are included in the hash:
  * adding/removing or altering any approved group invalidates a pending batch,
  * including a restored duplicate that vanishes from the visible picker. */
 private selection(s:BotState,actor:string,now:number,mode:Mode,p:number):Selection|null{
  if(!this.allowed(s,actor,now)||!Number.isSafeInteger(p)||p<0||p>999)return null;
  const all=approved(s),maxPage=Math.max(1,Math.ceil(all.length/PAGESIZE));
  if(p>=maxPage)return null;
  const visible=all.slice(p*PAGESIZE,(p+1)*PAGESIZE);
  const eligible:Chat[]=[],records:GroupProtectionRecord[]=[];
  for(const chat of visible){
   if(!this.policy.has(s,actor,'chat.manage',chat.id,now))continue;
   if(mode==='a'){
    if(chat.groupAI!=='OFF'&&chat.version<9_999_999_999)eligible.push(chat);
   }else{
    const record=currentMonitor(s,chat,now);
    if(record){eligible.push(chat);records.push(record);}
   }
  }
  const digest=createHash('sha256').update(JSON.stringify([
   mode,p,s.chats,
   visible.map(c=>[(s.protectionPolicies??[]).filter(row=>row.policy.chatId===c.id)]),
   eligible.map(c=>c.id),s.privateSettingsRevision??0,
   s.privateFeatures['owner.dashboard']
  ])).digest('hex');
  return {all,visible,eligible,records,maxPage,digest};
 }
 private section():OwnerInlineScreen{
  return ui('<b>🛑 إيقاف خدمات المجموعات جماعيًا</b>\n'+
   'إجراءات تقليل صلاحيات الخدمات المحلية فقط، دون تمكين أو رفع أذونات.\n'+
   'اختر الإيقاف الجماعي للمساعد أو للمراقبة، ثم عاين المجموعة المستهدفة وأكد.\n'+
   'الحد 8 مجموعات في الدفعة. لا تُنفذ أوامر Telegram ولا عقوبات حية.',
   [[btn('🤖 إيقاف المساعد جماعيًا','gb:1:p:a:0')],
    [btn('⏹ إيقاف المراقبة جماعيًا','gb:1:p:m:0')],
    [btn('🕘 سجل الإيقاف الجماعي','gb:1:r:p:0')],
    [btn('↩️ الإجراءات الجماعية','gt:1:b:h'),btn('🏠 لوحة المالك','mi:1:h')]]);
 }
 private list(actor:string,s:BotState,kind:Mode,p:number):OwnerInlineScreen|null{
  const row=this.selection(s,actor,this.clock(),kind,p);
  if(!row)return null;
  const desc=kind==='a'?'إيقاف المساعد':'إيقاف مراقبة الحماية';
  const rows=row.visible.map(c=>[btn(
   (row.eligible.some(r=>r.id===c.id)?'✅ جاهزة: ':'🔒 غير مؤهلة: ')+c.id,
   'gb:1:p:'+kind+':'+p)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','gb:1:p:'+kind+':'+(p-1)));
  if(p+1<row.maxPage)nav.push(btn('➡️ التالي','gb:1:p:'+kind+':'+(p+1)));
  if(nav.length)rows.push(nav);
  if(row.eligible.length)rows.push([btn('🔎 معاينة الإيقاف المحلي','gb:1:v:'+kind+':'+p)]);
  rows.push([btn('↩️ إيقاف الخدمات','gb:1:h'),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>👥 صفحة الإجراء الجماعي التقييدي</b>\n'+
   'العملية: '+desc+'\n'+
   'صفحة '+(p+1)+' من '+row.maxPage+'\n'+
   'المستهدفة: '+row.eligible.length+' مجموعات من '+row.visible.length+' في الصفحة.\n'+
   'المجموعات غير المؤهلة لن تتغير، والمعاينة لا تحفظ أي تعديلات.\n'+
   'هذا إجراء محلي ولا يمثل إرسالًا إلى Telegram.',rows);
 }
 private async review(actor:string,kind:Mode,p:number):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),picked=this.selection(s,actor,now,kind,p);
   if(!picked||!picked.eligible.length)return null;
   if(s.callbacks.filter(c=>c.actorId===actor&&c.action.startsWith(PREFIX)&&
    !c.used&&!c.revoked&&c.expiresAt>now).length>=100)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+JSON.stringify([
    kind,p,picked.digest,picked.eligible.map(c=>c.id)]),
    chatId:'private',actorId:actor,policyVersion:0,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   const targets=picked.eligible.map(c=>'• <code>'+escape(c.id)+'</code>').join('\n');
   return ui('<b>🔎 معاينة إيقاف الخدمات جماعيًا</b>\n'+
    'العملية: '+(kind==='a'?'إيقاف المساعد المحلي':'إيقاف مراقبة الحماية المحلية')+'\n'+
    'المجموعات المشمولة: '+picked.eligible.length+' مجموعات (8 كحد أقصى)\n'+targets+'\n'+
    (kind==='a'?'تنبيه: تغيير إصدار المجموعة قد يجعل سياسة الحماية بحاجة إلى مراجعة.\n':
     'ستبقى القواعد والاستثناءات محفوظة، مع مسح نوافذ الفلود القديمة.\n')+
    'لا تشغيل لميزات جديدة ولا حذف ولا كتم ولا حظر عبر Telegram.\n'+
    'أي تغير في الصلاحيات أو الإعدادات يرفض الدفعة كاملة. التأكيد صالح لدقيقتين ولمرة واحدة.',
    [[btn('✅ تأكيد الإيقاف الجماعي','gb:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','gb:1:k:'+ref.slice(2)),
      btn('↩️ العودة للصفحة','gb:1:p:'+kind+':'+p)]]);
  });
 }
 private async apply(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.allowed(s,actor,now))return null;
   const matches=s.callbacks.filter(c=>c.ref==='c_'+nonce),receipt=matches[0];
   if(matches.length!==1||!receipt||!receipt.action.startsWith(PREFIX)||
    receipt.chatId!=='private'||receipt.actorId!==actor||receipt.policyVersion!==0||
    receipt.oneShot!==true||receipt.used!==false||receipt.revoked!==false||
    !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=now||
    receipt.expiresAt>now+TTL)return null;
   let data:unknown;
   try{data=JSON.parse(receipt.action.slice(PREFIX.length));}catch{return null;}
   if(!Array.isArray(data)||data.length!==4||!['a','m'].includes(data[0])||
    !Number.isSafeInteger(data[1])||data[1]<0||data[1]>999||
    typeof data[2]!=='string'||!/^[a-f0-9]{64}$/u.test(data[2])||
    !Array.isArray(data[3])||data[3].length<1||data[3].length>PAGESIZE||
    data[3].some((id:unknown)=>typeof id!=='string'||!validId(id))||
    new Set(data[3]).size!==data[3].length)return null;
   const [kind,p,digest,ids]=data as [Mode,number,string,string[]];
   const current=this.selection(s,actor,now,kind,p);
   if(!current||!current.eligible.length||current.digest!==digest||
    JSON.stringify(current.eligible.map(c=>c.id))!==JSON.stringify(ids))return null;
   const targets=new Set(ids);
   if(kind==='a'){
    for(const chat of current.eligible){
     chat.groupAI='OFF';
     chat.version++;
    }
   }else{
    for(const row of current.records){
     const idx=(s.protectionPolicies??[]).indexOf(row);
     if(idx<0)return null;
     s.protectionPolicies![idx]={
      policy:{...structuredClone(row.policy),mode:'OFF',revision:row.policy.revision+1},
      chatPolicyVersion:row.chatPolicyVersion,updatedBy:actor,updatedAt:now};
    }
    if(s.protectionFloodWindows)
     s.protectionFloodWindows=s.protectionFloodWindows.filter(w=>!targets.has(w.chatId));
   }
   receipt.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-group-bulk:'+nonce,decision:'ALLOW',
    reason:kind==='a'?'GROUP_BULK_AI_DISABLED_LOCAL':'GROUP_BULK_MONITOR_DISABLED_LOCAL',
    policyVersion:0,at:now});
   return ui('<b>✅ تم الإيقاف الجماعي المحلي</b>\n'+
    'المجموعات المعدلة: '+ids.length+'\n'+
    (kind==='a'?'المساعد: OFF':'الحماية: OFF (لا مراقبة)')+'\n'+
    'حفظت التغييرات في معاملة واحدة مع تدقيق، ولم يتم الاتصال بـTelegram.',
    [[btn('👥 إجراءات جماعية أخرى','gb:1:h'),
      btn('📋 مجموعاتي','mi:1:i:01:01')],
     [btn('🏠 لوحة المالك','mi:1:h')]]);
  });
 }
 private async revoke(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.allowed(s,actor,now))return null;
   const matches=s.callbacks.filter(c=>c.ref==='c_'+nonce),c=matches[0];
   if(matches.length!==1||!c||!c.action.startsWith(PREFIX)||
    c.chatId!=='private'||c.actorId!==actor||c.policyVersion!==0||
    c.oneShot!==true||c.used!==false||c.revoked!==false||
    !Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   c.revoked=true;
   s.audit.push({actorId:actor,updateKey:'owner-group-bulk-cancel:'+nonce,decision:'NOOP',
    reason:'GROUP_BULK_PREVIEW_CANCELLED',policyVersion:0,at:now});
   return ui('<b>✖ أُلغيت المعاينة</b>\n'+
    'أُبطل رمز التأكيد في قاعدة البيانات ولا يمكن استخدامه مجددًا.\n'+
    'لم تتغير أي سياسة للمجموعات.',
    [[btn('↩️ إيقاف خدمات المجموعات','gb:1:h'),btn('🏠 لوحة المالك','mi:1:h')]]);
  });
 }

 /** Verify both durable evidence halves. An audit event alone or callback
  * receipt alone is never a reliable group-change claim. Duplicate restored
  * audit keys or callback refs quarantine the entry rather than picking one. */
 private entries(s:BotState,actor:string,now:number):{
  nonce:string;kind:Mode;ids:string[];at:number
 }[]{
  const events=s.audit.filter(a=>a.reason==='GROUP_BULK_AI_DISABLED_LOCAL'||
   a.reason==='GROUP_BULK_MONITOR_DISABLED_LOCAL');
  const result:{nonce:string;kind:Mode;ids:string[];at:number}[]=[];
  for(const a of events){
   const match=/^owner-group-bulk:([A-Za-z0-9_-]{24})$/u.exec(a.updateKey);
   if(!match||a.actorId!==actor||a.decision!=='ALLOW'||a.policyVersion!==0||
    !Number.isSafeInteger(a.at)||a.at<0||a.at>now||
    events.filter(x=>x.updateKey===a.updateKey).length!==1)continue;
   const records=s.callbacks.filter(c=>c.ref==='c_'+match[1]),receipt=records[0];
   if(records.length!==1||!receipt||receipt.actorId!==actor||
    receipt.chatId!=='private'||receipt.policyVersion!==0||
    receipt.oneShot!==true||receipt.used!==true||receipt.revoked!==false||
    !receipt.action.startsWith(PREFIX)||!Number.isSafeInteger(receipt.expiresAt)||
    receipt.expiresAt<=a.at||receipt.expiresAt>a.at+TTL)continue;
   let payload:unknown;
   try{payload=JSON.parse(receipt.action.slice(PREFIX.length));}catch{continue;}
   if(!Array.isArray(payload)||payload.length!==4||!['a','m'].includes(payload[0])||
    !Number.isSafeInteger(payload[1])||payload[1]<0||payload[1]>999||
    typeof payload[2]!=='string'||!/^[a-f0-9]{64}$/u.test(payload[2])||
    !Array.isArray(payload[3])||payload[3].length<1||payload[3].length>PAGESIZE||
    payload[3].some((id:unknown)=>typeof id!=='string'||!validId(id))||
    new Set(payload[3]).size!==payload[3].length||
    (a.reason==='GROUP_BULK_AI_DISABLED_LOCAL')!==(payload[0]==='a'))continue;
   result.push({nonce:match[1]!,kind:payload[0] as Mode,ids:payload[3] as string[],at:a.at});
  }
  result.sort((a,b)=>b.at-a.at||b.nonce.localeCompare(a.nonce));
  return result;
 }
 private history(actor:string,s:BotState,now:number,p:number):OwnerInlineScreen|null{
  if(!Number.isSafeInteger(p)||p<0||p>999)return null;
  const events=this.entries(s,actor,now),maxPage=Math.max(1,Math.ceil(events.length/PAGESIZE));
  if(p>=maxPage)return null;
  const rows=events.slice(p*PAGESIZE,(p+1)*PAGESIZE).map(event=>
   [btn((event.kind==='a'?'🤖 ':'⏹ ')+event.ids.length+' مجموعة · '+
     new Date(event.at).toISOString().slice(0,16).replace('T',' '),
    'gb:1:r:v:'+event.nonce)]);
  const navigation:{text:string;callback_data:string}[]=[];
  if(p)navigation.push(btn('⬅️ السابق','gb:1:r:p:'+(p-1)));
  if(p+1<maxPage)navigation.push(btn('➡️ التالي','gb:1:r:p:'+(p+1)));
  if(navigation.length)rows.push(navigation);
  rows.push([btn('↩️ الإيقاف الجماعي','gb:1:h'),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>🕘 سجل الإيقاف الجماعي المحلي</b>\n'+
   'العمليات الموثقة: '+(events.length===1?'عملية واحدة':events.length+' عمليات')+'\n'+
   'صفحة '+(p+1)+' من '+maxPage+'\n'+
   (events.length?'اختر عملية لعرض تفاصيل المجموعات والوقت.':
    'لا توجد عمليات موثقة حاليًا.')+'\n'+
   'البيانات سجلات إعدادات محلية، ولا تثبت أي تغيير في Telegram.',rows);
 }
 private detail(actor:string,s:BotState,now:number,nonce:string):OwnerInlineScreen|null{
  const records=this.entries(s,actor,now).filter(a=>a.nonce===nonce),event=records[0];
  if(records.length!==1||!event)return null;
  return ui('<b>🕘 تفاصيل الإيقاف الجماعي المحلي</b>\n'+
   'العملية: '+(event.kind==='a'?'إيقاف المساعد':'إيقاف المراقبة')+'\n'+
   'المجموعات المستهدفة: '+event.ids.length+'\n'+
   event.ids.map(id=>'• <code>'+escape(id)+'</code>').join('\n')+'\n'+
   'التوقيت (UTC): '+new Date(event.at).toISOString().replace('T',' ').slice(0,19)+'\n'+
   'هذا عرض تاريخي للقراءة فقط؛ لم تُنشأ أي موافقة جديدة أو أوامر Telegram.',
   [[btn('↩️ سجل الإيقاف الجماعي','gb:1:r:p:0'),
     btn('🏠 لوحة المالك','mi:1:h')]]);
 }

 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!validOwnerGroupBulkRestrictRoute(data)||!this.policy.isOwner(actor))return null;
  const c=confirm.exec(data);
  if(c)return this.apply(actor,c[1]!);
  const k=cancel.exec(data);
  if(k)return this.revoke(actor,k[1]!);
  const state=await this.store.snapshot(),now=this.clock();
  if(!this.allowed(state,actor,now))return null;
  if(home.test(data))return this.section();
  const lp=logPage.exec(data);
  if(lp)return this.history(actor,state,now,Number(lp[1]));
  const lv=logView.exec(data);
  if(lv)return this.detail(actor,state,now,lv[1]!);
  const p=page.exec(data);
  if(p)return this.list(actor,state,p[1] as Mode,Number(p[2]));
  const v=preview.exec(data);
  if(v)return this.review(actor,v[1] as Mode,Number(v[2]));
  return null;
 }
}
