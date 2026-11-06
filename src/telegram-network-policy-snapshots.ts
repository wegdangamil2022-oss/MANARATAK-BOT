import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {summarizeNetworkSettings} from './network-policy-diff.js';
import {captureNetworkPolicySnapshot,isValidNetworkPolicySnapshots,
 inspectSavedNetworkPolicy,previewNetworkPolicySnapshot,
 type NetworkPolicySnapshotInspection} from './network-policy-snapshots.js';

const TTL=120_000,SIZE=8,PREFIX='owner-network-policy-snapshot:';
const net='([a-f0-9]{12})',page='(0|[1-9][0-9]{0,2})',group='(-[1-9][0-9]{0,15})';
const home=new RegExp('^nw:1:ha:'+net+'$','u');
const picker=new RegExp('^nw:1:hp:'+net+':'+page+'$','u');
const preview=new RegExp('^nw:1:hv:'+net+':'+group+'$','u');
const confirm=/^nw:1:hc:([A-Za-z0-9_-]{24})$/u;
const cancel=/^nw:1:hx:([A-Za-z0-9_-]{24})$/u;
const listing=new RegExp('^nw:1:hl:'+net+':'+page+'$','u');
const detail=/^nw:1:hd:([a-f0-9]{12})$/u;
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const goodClock=(t:number)=>Number.isSafeInteger(t)&&t>=0&&t<=8_640_000_000_000_000-TTL;
const names:Record<string,string>={
 mode:'وضع الحماية',rules:'قواعد الحماية',allowedDomains:'النطاقات المسموحة',
 allowedPhrases:'العبارات المستثناة',exemptMemberIds:'الاستثناءات الدائمة',
 flood:'مكافحة الفلود',joinRaid:'حماية الانضمام',night:'وضع الليل',
 raid:'حماية الهجمات',escalation:'تصعيد التحذيرات',
 temporaryExemptions:'الاستثناءات المؤقتة',ruleExemptions:'استثناءات القواعد'
};
/** All entry points require Telegram private owner context at the transport. */
export function validOwnerNetworkPolicySnapshotRoute(data:unknown):boolean{
 return typeof data==='string'&&Buffer.byteLength(data,'utf8')<=64&&
  [home,picker,preview,confirm,cancel,listing,detail].some(re=>re.test(data));
}
export class OwnerNetworkPolicySnapshots{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private allowed(s:BotState,actor:string,now:number){
  return goodClock(now)&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   isValidNetworkPolicySnapshots(s.networkPolicySnapshots??[]);
 }
 private overview(s:BotState,actor:string,id:string){
  return summarizeNetworkSettings(s,this.policy,actor,this.clock(),id);
 }
 private home(s:BotState,actor:string,id:string):OwnerInlineScreen|null{
  const o=this.overview(s,actor,id);
  if(!o||!this.allowed(s,actor,this.clock()))return null;
  const count=(s.networkPolicySnapshots??[]).filter(x=>x.networkId===id).length;
  return ui('<b>📸 نسخ سياسات الحماية التاريخية</b>\n'+
   'الشبكة: '+esc(o.networkName)+'\nالنسخ المحفوظة: '+count+
   ' · الحد: 5 لكل مجموعة و100 إجمالًا.\n'+
   'يحفظ المالك نسخة محلية بعد معاينة وموافقة مستقلة. النسخ لا تُستعاد ولا تُفعّل تلقائيًا.\n'+
   'لا تعرض هذه الشاشة نصوص القواعد أو بيانات الاستثناءات أو الروابط.',[
    [btn('📸 حفظ نسخة من سياسة مجموعة','nw:1:hp:'+id+':0')],
    [btn('🕘 سجل النسخ التاريخية','nw:1:hl:'+id+':0')],
    [btn('🧩 مقارنة المجموعات','nw:1:ch:'+id)],
    [btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]
   ]);
 }
 private picker(s:BotState,actor:string,id:string,p:number):OwnerInlineScreen|null{
  const overview=this.overview(s,actor,id);
  if(!overview||!this.allowed(s,actor,this.clock()))return null;
  const eligible=overview.members.filter(m=>m.status==='CURRENT'&&m.policyStatus==='CURRENT');
  const pages=Math.max(1,Math.ceil(eligible.length/SIZE));
  if(p<0||p>=pages)return null;
  const rows=eligible.slice(p*SIZE,(p+1)*SIZE).map(m=>[
   btn('📸 نسخة: '+m.chatId,'nw:1:hv:'+id+':'+m.chatId)
  ]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:hp:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:hp:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ النسخ التاريخية','nw:1:ha:'+id)]);
  return ui('<b>📸 اختر سياسة مجموعة للحفظ</b>\n'+
   'الشبكة: '+esc(overview.networkName)+' · صفحة '+(p+1)+'/'+pages+'\n'+
   'سياسات صالحة للحفظ: '+eligible.length+
   ' · سياسات غير صالحة أو ارتباطات قديمة لا تُنسخ.\n'+
   'تحتوي النسخة المحلية على إعدادات الحماية فقط، وليس حقوق Telegram.',rows);
 }
 private async preview(actor:string,networkId:string,chatId:string):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.allowed(s,actor,now))return null;
   const info=previewNetworkPolicySnapshot(s,this.policy,actor,now,networkId,chatId);
   const overview=this.overview(s,actor,networkId);
   if(!info||!overview)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref)||s.callbacks.filter(c=>c.actorId===actor&&
    c.action.startsWith(PREFIX)&&!c.used&&!c.revoked&&c.expiresAt>now).length>=100)return null;
   s.callbacks.push({ref,actorId:actor,chatId:'private',policyVersion:0,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL,
    action:PREFIX+'capture:'+JSON.stringify([
     networkId,chatId,info.chatVersion,info.networkRevision,
     info.policyRevision,info.digest,info.proof])});
   return ui('<b>🔎 معاينة حفظ سياسة الحماية</b>\n'+
    'الشبكة: '+esc(overview.networkName)+'\n'+
    'المجموعة: <code>'+chatId+'</code>\n'+
    'إصدار المجموعة: '+info.chatVersion+' · إصدار السياسة: '+info.policyRevision+'\n'+
    'الوضع: '+info.mode+' · عدد القواعد: '+info.ruleCount+'\n'+
    (overview.emergencyStopped?'⛔ طوارئ الشبكة نشطة؛ الحفظ محلي للقراءة فقط.\n':'')+
    'سيُحفظ محتوى السياسة داخل قاعدة بيانات البوت، دون نشر كلمات أو قواعد حساسة.\n'+
    'التأكيد صالح لدقيقتين ولمرة واحدة ولا يعدّل السياسة الحالية أو صلاحيات Telegram.',[
     [btn('✅ تأكيد حفظ النسخة','nw:1:hc:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:hx:'+ref.slice(2))]
    ]);
  });
 }
 private async decide(actor:string,nonce:string,action:'CONFIRM'|'CANCEL'):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.allowed(s,actor,now))return null;
   const matches=s.callbacks.filter(x=>x.ref==='c_'+nonce),receipt=matches[0];
   if(matches.length!==1||!receipt||receipt.actorId!==actor||
    receipt.chatId!=='private'||receipt.policyVersion!==0||
    !receipt.oneShot||receipt.used||receipt.revoked||
    receipt.expiresAt<=now||receipt.expiresAt>now+TTL||
    !receipt.action.startsWith(PREFIX+'capture:'))return null;
   if(action==='CANCEL'){
    receipt.revoked=true;
    return ui('<b>✖ ألغيت حفظ النسخة</b>\nلم تتغير قاعدة النسخ أو السياسة.',[
     [btn('🌐 الشبكات','nw:1:h')]
    ]);
   }
   let data:unknown;
   try{data=JSON.parse(receipt.action.slice((PREFIX+'capture:').length));}catch{return null;}
   if(!Array.isArray(data)||data.length!==7||
    typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
    typeof data[1]!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(data[1])||
    ![2,3,4].every(i=>Number.isSafeInteger(data[i])&&Number(data[i])>=1)||
    [5,6].some(i=>typeof data[i]!=='string'||!/^[a-f0-9]{64}$/u.test(data[i] as string)))return null;
   const [networkId,chatId,chatVersion,networkRevision,policyRevision,digest,proof]=
    data as [string,string,number,number,number,string,string];
   const current=previewNetworkPolicySnapshot(s,this.policy,actor,now,networkId,chatId);
   if(!current||current.chatVersion!==chatVersion||
    current.networkRevision!==networkRevision||
    current.policyRevision!==policyRevision||
    current.digest!==digest||current.proof!==proof)return null;
   const id=randomBytes(6).toString('hex');
   const snapshot=captureNetworkPolicySnapshot(s,this.policy,actor,now,networkId,chatId,id);
   if(!snapshot)return null;
   receipt.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-network-policy-snapshot:'+nonce,
    decision:'ALLOW',reason:'OWNER_NETWORK_POLICY_SNAPSHOT_CAPTURED',
    policyVersion:policyRevision,at:now});
   return ui('<b>✅ تم حفظ نسخة سياسة الحماية</b>\n'+
    'المجموعة: <code>'+chatId+'</code>\n'+
    'رقم النسخة: <code>'+snapshot.id+'</code>\n'+
    'إصدار السياسة: '+snapshot.policyRevision+'\n'+
    'النسخة للقراءة والمقارنة فقط؛ لم تُعدّل السياسة الحالية.',[
     [btn('🕘 سجل النسخ','nw:1:hl:'+networkId+':0')],
     [btn('↩️ بطاقة الشبكة','nw:1:d:'+networkId)]
    ]);
  });
 }
 private list(s:BotState,actor:string,id:string,p:number):OwnerInlineScreen|null{
  const overview=this.overview(s,actor,id);
  if(!overview||!this.allowed(s,actor,this.clock()))return null;
  const items=(s.networkPolicySnapshots??[]).filter(x=>x.networkId===id)
   .sort((a,b)=>b.capturedAt-a.capturedAt||b.id.localeCompare(a.id));
  const pages=Math.max(1,Math.ceil(items.length/SIZE));
  if(p<0||p>=pages)return null;
  const rows=items.slice(p*SIZE,(p+1)*SIZE).map(item=>[
   btn('📸 نسخة '+item.id+' · '+item.chatId,'nw:1:hd:'+item.id)
  ]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:hl:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:hl:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ النسخ التاريخية','nw:1:ha:'+id)]);
  return ui('<b>🕘 سجل النسخ التاريخية</b>\n'+
   'الشبكة: '+esc(overview.networkName)+'\nعدد النسخ: '+items.length+
   ' · صفحة '+(p+1)+'/'+pages+'\n'+
   'النسخ محلية للقراءة فقط. لا توجد أوامر استرجاع أو تنفيذ عبر Telegram.',rows);
 }
 private detail(s:BotState,actor:string,id:string):OwnerInlineScreen|null{
  if(!this.allowed(s,actor,this.clock()))return null;
  const entry=inspectSavedNetworkPolicy(s,this.policy,actor,this.clock(),id);
  if(!entry)return null;
  const {snapshot:sn}=entry;
  return ui('<b>📸 مراجعة نسخة تاريخية موثّقة</b>\n'+
   'المجموعة: <code>'+sn.chatId+'</code>\n'+
   'رقم النسخة: <code>'+sn.id+'</code>\n'+
   'إصدار السياسة المحفوظة: '+sn.policyRevision+
   ' · وضعها: '+sn.policy.mode+'\n'+
   'وقت الالتقاط (UTC): '+new Date(sn.capturedAt).toISOString().slice(0,19).replace('T',' ')+'\n'+
   (entry.emergencyStopped?'⛔ طوارئ الشبكة نشطة؛ المقارنة لا تغير التشغيل.\n':'')+
   (entry.equivalent?'✅ النسخة والسياسة الحالية متطابقة في محتوى الحماية.\n':
    entry.comparable?'⚠️ تختلف عن السياسة الحالية في '+entry.differences.length+' حقول:\n'+
     entry.differences.map(x=>'• '+(names[x]??'إعداد آخر')).join('\n')+'\n':
    '⚠️ السياسة الحالية غير متاحة للمقارنة الآمنة (مفقودة أو قديمة أو اعتماد متغير).\n')+
   'القيم الحساسة محفوظة محليًا ولا تُعرض هنا. لا يمكن استرجاع نسخة أو تفعيل حماية من هذه الشاشة.',[
    [btn('↩️ سجل نسخ الشبكة','nw:1:hl:'+sn.networkId+':0')],
    [btn('↩️ بطاقة الشبكة','nw:1:d:'+sn.networkId)]
   ]);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validOwnerNetworkPolicySnapshotRoute(data))return null;
  const c=confirm.exec(data);if(c)return this.decide(actor,c[1]!,'CONFIRM');
  const k=cancel.exec(data);if(k)return this.decide(actor,k[1]!,'CANCEL');
  const s=await this.store.snapshot();
  const h=home.exec(data);if(h)return this.home(s,actor,h[1]!);
  const p=picker.exec(data);if(p)return this.picker(s,actor,p[1]!,Number(p[2]));
  const v=preview.exec(data);if(v)return this.preview(actor,v[1]!,v[2]!);
  const li=listing.exec(data);if(li)return this.list(s,actor,li[1]!,Number(li[2]));
  const d=detail.exec(data);if(d)return this.detail(s,actor,d[1]!);
  return null;
 }
}
