import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat,GroupAIMode} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {isValidGroupProtectionRecord,type GroupProtectionRecord} from './protection-rules.js';

/** Owner-only section group settings. These are local policy changes, never
 * Telegram administrative actions. Every confirmation rechecks its chat,
 * current page, owner-dashboard epoch and policy digest in one transaction. */
const PAGE_SIZE=8,TTL=120_000,PREFIX='owner-group-settings:';
const id='(-[1-9][0-9]{0,15})',version='([1-9][0-9]{0,9})',page='(0|[1-9][0-9]{0,2})';
const home=/^gs:1:h$/u;
const pages=new RegExp('^gs:1:p:'+page+'$','u');
const group=new RegExp('^gs:1:g:'+id+':'+version+':'+page+'$','u');
const preview=new RegExp('^gs:1:v:'+id+':'+version+':'+page+':([xosamf])$','u');
const history=new RegExp('^gs:1:l:'+id+':'+version+':'+page+'$','u');
const confirm=/^gs:1:c:([A-Za-z0-9_-]{24})$/u;
const cancel=/^gs:1:k:([A-Za-z0-9_-]{24})$/u;
type Change='x'|'o'|'s'|'a'|'m'|'f';
type Context={s:BotState;items:Chat[];chat:Chat;page:number;record:GroupProtectionRecord|null;
 change:Change;target:GroupAIMode|'MONITOR';evidence:string};
const button=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const escape=(text:string)=>text.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const time=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000-TTL;
const groupId=(value:string)=>/^-[1-9][0-9]{0,15}$/u.test(value)&&Number.isSafeInteger(Number(value));
const validVersion=(n:number)=>Number.isSafeInteger(n)&&n>=1&&n<=9_999_999_999;
const targetAI:Record<'x'|'o'|'s'|'a',GroupAIMode>={
 x:'OFF',o:'OWNER_MENTION',s:'STAFF_MENTION',a:'ALL_MENTION'
};
export function validOwnerGroupSettingsRoute(data:unknown):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return false;
 return data==='mi:1:i:01:12'||home.test(data)||[pages,group,preview,history,confirm,cancel].some(re=>re.test(data));
}
/** Restore-safe approved group list. Reject duplicates instead of selecting
 * the first copy of an approval with conflicting rights. */
function approved(state:BotState):Chat[]{
 const counts=new Map<string,number>();
 for(const chat of state.chats)counts.set(chat.id,(counts.get(chat.id)??0)+1);
 return state.chats.filter(c=>c.approved&&counts.get(c.id)===1&&groupId(c.id)&&validVersion(c.version))
  .sort((a,b)=>a.id.localeCompare(b.id));
}
function policyRecord(s:BotState,c:Chat,now:number):{
 status:'UNSET'|'STALE'|'OFF'|'MONITOR';record:GroupProtectionRecord|null
}{
 const rows=(s.protectionPolicies??[]).filter(r=>r.policy.chatId===c.id);
 if(!rows.length)return {status:'UNSET',record:null};
 if(rows.length!==1||!c.scopes.includes('moderation')||
  !isValidGroupProtectionRecord(rows[0])||
  rows[0]!.chatPolicyVersion!==c.version||rows[0]!.updatedAt>now)
  return {status:'STALE',record:null};
 return rows[0]!.policy.mode==='OFF'?{status:'OFF',record:rows[0]!}:
  rows[0]!.policy.mode==='MONITOR'?{status:'MONITOR',record:rows[0]!}:
  {status:'STALE',record:null};
}
const policyLabel=(status:'UNSET'|'STALE'|'OFF'|'MONITOR')=>
 status==='UNSET'?'غير مضبوطة':status==='STALE'?'تحتاج مراجعة':
 status==='OFF'?'متوقفة':'مراقبة فقط';
const fingerprint=(s:BotState,items:Chat[],chat:Chat,record:GroupProtectionRecord|null,change:Change)=>
 createHash('sha256').update(JSON.stringify([
  items.map(c=>[c.id,c.version,c.approved,c.scopes,c.groupAI]),
  chat,record,change,
  s.privateSettingsRevision??0,s.privateFeatures['owner.dashboard']
 ])).digest('hex');

export class OwnerGroupSettings{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private access(s:BotState,actor:string,now:number):boolean{
  return this.policy.isOwner(actor)&&time(now)&&this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private details(s:BotState,actor:string,now:number,chatId:string,
  expected:number,p:number):{items:Chat[];chat:Chat;recordStatus:ReturnType<typeof policyRecord>}|null{
  if(!this.access(s,actor,now)||!groupId(chatId)||!validVersion(expected))return null;
  const items=approved(s),index=items.findIndex(c=>c.id===chatId),chat=items[index];
  if(index<0||!chat||chat.version!==expected||p!==Math.floor(index/PAGE_SIZE)||
   p<0||p>999||!this.policy.has(s,actor,'chat.manage',chatId,now))return null;
  return {items,chat,recordStatus:policyRecord(s,chat,now)};
 }
 private context(s:BotState,actor:string,now:number,chatId:string,
  expected:number,p:number,change:Change):Context|null{
  const current=this.details(s,actor,now,chatId,expected,p);
  if(!current)return null;
  const {chat,items,recordStatus}=current;
  if(change==='m'||change==='f'){
   if(!chat.scopes.includes('moderation')||!recordStatus.record||
    (change==='m'&&recordStatus.status!=='OFF')||
    (change==='f'&&recordStatus.status!=='MONITOR')||
    recordStatus.record.policy.revision>=Number.MAX_SAFE_INTEGER-1)return null;
  }else{
   const target=targetAI[change];
   if(target===undefined||target===chat.groupAI||
    (target!=='OFF'&&!chat.scopes.includes('assistant'))||
    chat.version>=9_999_999_999)return null;
  }
  const record=recordStatus.record;
  return {s,items,chat,page:p,record,change,
   target:change==='m'?'MONITOR':change==='f'?'OFF':targetAI[change as keyof typeof targetAI],
   evidence:fingerprint(s,items,chat,record,change)};
 }
 private homeScreen():OwnerInlineScreen{
  return ui('<b>⚙️ إعدادات قسم المجموعات</b>\n'+
   'تحرير أوضاع المساعد الذكي والمراقبة المحلية للمجموعات المعتمدة.\n'+
   'كل تغيير يحتاج معاينة وتأكيدًا لمرة واحدة، مع تحقق جديد من الصلاحيات.\n'+
   'لا توجد هنا عقوبات أو تعديلات فعلية في Telegram.',
   [[button('📋 اختيار المجموعة','gs:1:p:0')],
    [button('👥 مجموعاتي','mi:1:i:01:01'),button('🏠 لوحة المالك','mi:1:h')]]);
 }
 private groupList(s:BotState,p:number):OwnerInlineScreen|null{
  const items=approved(s),pages=Math.max(1,Math.ceil(items.length/PAGE_SIZE));
  if(p<0||p>=pages)return null;
  const rows=items.slice(p*PAGE_SIZE,(p+1)*PAGE_SIZE)
   .map(c=>[button('👥 '+c.id,'gs:1:g:'+c.id+':'+c.version+':'+p)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(button('⬅️ السابق','gs:1:p:'+(p-1)));
  if(p+1<pages)nav.push(button('➡️ التالي','gs:1:p:'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([button('↩️ إعدادات القسم','gs:1:h'),button('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>📋 مجموعات إعدادات القسم</b>\n'+
   'المجموعات المعتمدة: '+items.length+' · صفحة '+(p+1)+' من '+pages+'\n'+
   (items.length?'اختر مجموعة لعرض إعداداتها المحفوظة.':'لا توجد مجموعات معتمدة حاليًا.')+'\n'+
   'المصدر محلي ولا يمثل فحصًا حيًا لحقوق Telegram.',rows);
 }
 private card(s:BotState,actor:string,now:number,id:string,version:number,p:number):OwnerInlineScreen|null{
  const current=this.details(s,actor,now,id,version,p);
  if(!current)return null;
  const {chat,recordStatus}=current,rows:{text:string;callback_data:string}[][]=[];
  const make=(label:string,mode:Change)=>button(label,'gs:1:v:'+id+':'+version+':'+p+':'+mode);
  if(chat.scopes.includes('assistant')){
   const aiOptions:[GroupAIMode,string,Change][]=[
    ['OFF','🤖 إيقاف المساعد','x'],['OWNER_MENTION','👑 المالك فقط','o'],
    ['STAFF_MENTION','🛡️ المشرفون عند المنشن','s'],
    ['ALL_MENTION','🌍 الجميع عند المنشن','a']
   ];
   for(let i=0;i<aiOptions.length;i+=2){
    const line=aiOptions.slice(i,i+2).filter(([mode])=>mode!==chat.groupAI)
     .map(([,label,code])=>make(label,code));
    if(line.length)rows.push(line);
   }
  }else if(chat.groupAI!=='OFF')rows.push([make('🤖 إيقاف المساعد','x')]);
  if(chat.scopes.includes('moderation')){
   if(recordStatus.status==='OFF')rows.push([make('👁️ تشغيل المراقبة','m')]);
   if(recordStatus.status==='MONITOR')rows.push([make('⏹ إيقاف المراقبة','f')]);
  }
  rows.push([button('🕘 سجل تغييرات إعدادات المجموعة','gs:1:l:'+id+':'+version+':0')]);
  rows.push([button('👥 بطاقة المجموعة','mi:1:g:d:'+id+':'+version+':'+p),
   button('↩️ كل المجموعات','gs:1:p:'+p)]);
  const help=recordStatus.status==='STALE'?
   'سياسة الحماية تحتاج مراجعة، لذلك لا يمكن تبديل وضعها من هذه الشاشة.\n':
   recordStatus.status==='UNSET'?'لا توجد سياسة حماية محفوظة؛ أضفها أولًا من محرر الحماية.\n':'';
  return ui('<b>⚙️ إعدادات المجموعة المحلية</b>\n'+
   'المجموعة: <code>'+escape(id)+'</code>\n'+
   'إصدار اعتماد المجموعة: '+version+'\n'+
   'المساعد المحلي: '+chat.groupAI+'\n'+
   'الحماية المحلية: '+policyLabel(recordStatus.status)+'\n'+help+
   'لن يُفعَّل وضع الإنفاذ ENFORCE أو أي إجراء حقيقي في Telegram.',rows);
 }

 /** An audit row is shown only when paired with its unique, consumed preview
  * receipt. Duplicate audit keys, ambiguous callback refs and malformed
  * restored evidence are quarantined rather than treated as genuine changes. */
 private auditHistory(s:BotState,actor:string,now:number,id:string,version:number,p:number):OwnerInlineScreen|null{
  const selected=this.details(s,actor,now,id,version,Math.floor(approved(s).findIndex(c=>c.id===id)/PAGE_SIZE));
  if(!selected||p<0||p>999)return null;
  type Entry={at:number;reason:string;change:Change};
  const changes:Entry[]=[];
  const candidate=s.audit.filter(a=>a.reason==='GROUP_SETTINGS_AI_MODE_SAVED'||
   a.reason==='GROUP_SETTINGS_MONITOR_ENABLED'||a.reason==='GROUP_SETTINGS_MONITOR_DISABLED');
  for(const a of candidate){
   const m=/^owner-group-settings:([A-Za-z0-9_-]{24})$/u.exec(a.updateKey);
   if(!m||a.decision!=='ALLOW'||a.actorId!==actor||
    !Number.isSafeInteger(a.at)||a.at<0||a.at>now||
    candidate.filter(x=>x.updateKey===a.updateKey).length!==1)continue;
   const receipts=s.callbacks.filter(c=>c.ref==='c_'+m[1]),receipt=receipts[0];
   if(receipts.length!==1||!receipt||receipt.actorId!==actor||
    receipt.chatId!=='private'||receipt.policyVersion!==0||receipt.oneShot!==true||
    receipt.used!==true||receipt.revoked!==false||!receipt.action.startsWith(PREFIX)||
    !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=a.at||
    receipt.expiresAt>a.at+TTL)continue;
   let payload:unknown;
   try{payload=JSON.parse(receipt.action.slice(PREFIX.length));}catch{continue;}
   if(!Array.isArray(payload)||payload.length!==5||payload[0]!==id||
    !validVersion(payload[1])||!Number.isSafeInteger(payload[2])||
    payload[2]<0||payload[2]>999||!['x','o','s','a','m','f'].includes(payload[3])||
    typeof payload[4]!=='string'||!/^[a-f0-9]{64}$/u.test(payload[4]))continue;
   const change=payload[3] as Change,isAI=!['m','f'].includes(change);
   if(a.reason!==(isAI?'GROUP_SETTINGS_AI_MODE_SAVED':
    change==='m'?'GROUP_SETTINGS_MONITOR_ENABLED':'GROUP_SETTINGS_MONITOR_DISABLED')||
    a.policyVersion!==payload[1]+(isAI?1:0))continue;
   changes.push({at:a.at,reason:a.reason,change});
  }
  changes.reverse();
  const count=changes.length,pagesTotal=Math.max(1,Math.ceil(count/PAGE_SIZE));
  if(p>=pagesTotal)return null;
  const current=changes.slice(p*PAGE_SIZE,(p+1)*PAGE_SIZE);
  const lines=current.map(item=>'• '+new Date(item.at).toISOString().slice(0,16).replace('T',' ')+
   ' UTC — '+item.reason).join('\n');
  const rows:{text:string;callback_data:string}[][]=[];
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(button('⬅️ السابق','gs:1:l:'+id+':'+version+':'+(p-1)));
  if(p+1<pagesTotal)nav.push(button('➡️ التالي','gs:1:l:'+id+':'+version+':'+(p+1)));
  if(nav.length)rows.push(nav);
  const index=approved(s).findIndex(c=>c.id===id);
  rows.push([button('↩️ إعدادات المجموعة','gs:1:g:'+id+':'+version+':'+Math.floor(index/PAGE_SIZE)),
   button('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>🕘 سجل تغييرات إعدادات المجموعة</b>\n'+
   'المجموعة: <code>'+escape(id)+'</code>\n'+
   'العمليات الموثقة: '+count+' · صفحة '+(p+1)+' من '+pagesTotal+'\n'+
   (lines?lines:'لا توجد تغييرات موثقة لهذه المجموعة.')+'\n'+
   'هذا سجل محلي للقراءة فقط، لا يثبت تنفيذ إجراءات Telegram.',rows);
 }

 private async preview(actor:string,id:string,version:number,p:number,mode:Change):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),ctx=this.context(s,actor,now,id,version,p,mode);
   if(!ctx||s.callbacks.filter(c=>c.action.startsWith(PREFIX)&&c.actorId===actor&&
    !c.used&&!c.revoked&&c.expiresAt>now).length>=100)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+JSON.stringify([id,version,p,mode,ctx.evidence]),
    chatId:'private',actorId:actor,policyVersion:0,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   const isAI=mode!=='m'&&mode!=='f';
   const stale=Boolean(isAI&&(s.protectionPolicies??[]).some(r=>r.policy.chatId===id));
   return ui('<b>🔎 معاينة تغيير إعداد المجموعة</b>\n'+
    'المجموعة: <code>'+escape(id)+'</code>\n'+
    'الإجراء: '+(isAI?'تغيير وضع المساعد المحلي':'تغيير وضع مراقبة الحماية')+'\n'+
    'القيمة الجديدة: '+ctx.target+'\n'+
    (stale?'تنبيه: تغيير إصدار المجموعة سيجعل سياسة الحماية الحالية بحاجة إلى مراجعة.\n':'')+
    'لن تُنفّذ أي عمليات Telegram: لا حذف ولا كتم ولا حظر.\n'+
    'التأكيد صالح لدقيقتين وضغطة واحدة فقط.',
    [[button('✅ تأكيد التعديل المحلي','gs:1:c:'+ref.slice(2))],
     [button('✖ إلغاء المعاينة','gs:1:k:'+ref.slice(2)),
      button('↩️ العودة للإعدادات','gs:1:g:'+id+':'+version+':'+p)]]);
  });
 }
 private async confirm(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.access(s,actor,now))return null;
   const rows=s.callbacks.filter(c=>c.ref==='c_'+nonce),receipt=rows[0];
   if(rows.length!==1||!receipt||!receipt.action.startsWith(PREFIX)||
    receipt.chatId!=='private'||receipt.actorId!==actor||receipt.policyVersion!==0||
    receipt.oneShot!==true||receipt.used!==false||receipt.revoked!==false||
    !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=now||
    receipt.expiresAt>now+TTL)return null;
   let data:unknown;
   try{data=JSON.parse(receipt.action.slice(PREFIX.length));}catch{return null;}
   if(!Array.isArray(data)||data.length!==5||
    typeof data[0]!=='string'||!groupId(data[0])||
    !validVersion(data[1])||!Number.isSafeInteger(data[2])||
    data[2]<0||data[2]>999||!['x','o','s','a','m','f'].includes(data[3])||
    typeof data[4]!=='string'||!/^[a-f0-9]{64}$/u.test(data[4]))return null;
   const [id,version,p,change,fingerprintValue]=data as [string,number,number,Change,string];
   const ctx=this.context(s,actor,now,id,version,p,change);
   if(!ctx||ctx.evidence!==fingerprintValue)return null;
   if(change==='m'||change==='f'){
    const old=ctx.record!;
    s.protectionPolicies??=[];
    const index=s.protectionPolicies.findIndex(r=>r.policy.chatId===id);
    if(index<0)return null;
    s.protectionPolicies[index]={
     policy:{...structuredClone(old.policy),revision:old.policy.revision+1,mode:change==='m'?'MONITOR':'OFF'},
     chatPolicyVersion:old.chatPolicyVersion,updatedBy:actor,updatedAt:now};
    if(s.protectionFloodWindows)s.protectionFloodWindows=s.protectionFloodWindows.filter(w=>w.chatId!==id);
   }else{
    ctx.chat.groupAI=targetAI[change as keyof typeof targetAI];
    ctx.chat.version++;
   }
   receipt.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-group-settings:'+nonce,decision:'ALLOW',
    reason:change==='m'?'GROUP_SETTINGS_MONITOR_ENABLED':
     change==='f'?'GROUP_SETTINGS_MONITOR_DISABLED':'GROUP_SETTINGS_AI_MODE_SAVED',
    policyVersion:ctx.chat.version,at:now});
   return ui('<b>✅ تم حفظ الإعداد المحلي</b>\n'+
    'المجموعة: <code>'+escape(id)+'</code>\n'+
    'القيمة المحفوظة: '+ctx.target+'\n'+
    'تغيّر الإعداد في قاعدة البيانات فقط؛ لم تُنفذ عقوبات أو تغييرات Telegram.',
    [[button('⚙️ إعدادات المجموعة','gs:1:g:'+id+':'+ctx.chat.version+':'+p)],
     [button('👥 مجموعاتي','mi:1:i:01:01'),button('🏠 لوحة المالك','mi:1:h')]]);
  });
 }
 private async cancel(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.access(s,actor,now))return null;
   const rows=s.callbacks.filter(c=>c.ref==='c_'+nonce),receipt=rows[0];
   if(rows.length!==1||!receipt||!receipt.action.startsWith(PREFIX)||
    receipt.actorId!==actor||receipt.chatId!=='private'||receipt.policyVersion!==0||
    receipt.oneShot!==true||receipt.used!==false||receipt.revoked!==false||
    !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=now||
    receipt.expiresAt>now+TTL)return null;
   receipt.revoked=true;
   s.audit.push({actorId:actor,updateKey:'owner-group-settings:cancel:'+nonce,
    decision:'NOOP',reason:'GROUP_SETTINGS_PREVIEW_CANCELLED',policyVersion:0,at:now});
   return ui('<b>✖ أُلغيت المعاينة</b>\n'+
    'أُبطل رمز التأكيد، ولا يمكن تنفيذ التعديل من الرسالة القديمة.\n'+
    'لم تتغير سياسات أي مجموعة.',
    [[button('⚙️ إعدادات القسم','gs:1:h'),button('🏠 لوحة المالك','mi:1:h')]]);
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!validOwnerGroupSettingsRoute(data)||!this.policy.isOwner(actor))return null;
  const c=confirm.exec(data);
  if(c)return this.confirm(actor,c[1]!);
  const k=cancel.exec(data);
  if(k)return this.cancel(actor,k[1]!);
  const state=await this.store.snapshot(),now=this.clock();
  if(!this.access(state,actor,now))return null;
  if(data==='mi:1:i:01:12'||home.test(data))return this.homeScreen();
  const p=pages.exec(data);
  if(p)return this.groupList(state,Number(p[1]));
  const g=group.exec(data);
  if(g)return this.card(state,actor,now,g[1]!,Number(g[2]),Number(g[3]));
  const log=history.exec(data);
  if(log)return this.auditHistory(state,actor,now,log[1]!,Number(log[2]),Number(log[3]));
  const v=preview.exec(data);
  if(v)return this.preview(actor,v[1]!,Number(v[2]),Number(v[3]),v[4] as Change);
  return null;
 }
}
