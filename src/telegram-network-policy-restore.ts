import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {previewNetworkPolicyRestore,applyNetworkPolicyRestore,
 type RestorablePolicyField} from './network-policy-restore.js';

const PREFIX='owner-network-policy-restore:',TTL=120_000,SIZE=8;
const preview=/^nw:1:rr:([a-f0-9]{12})$/u;
const confirm=/^nw:1:rc:([A-Za-z0-9_-]{24})$/u;
const cancel=/^nw:1:rx:([A-Za-z0-9_-]{24})$/u;
const history=/^nw:1:rl:([a-f0-9]{12}):(0|[1-9][0-9]{0,2})$/u;
const detail=/^nw:1:rd:([A-Za-z0-9_-]{24})$/u;
const fieldNames:Record<RestorablePolicyField,string>={
 rules:'قواعد الحماية',allowedDomains:'النطاقات المسموحة',
 allowedPhrases:'العبارات المستثناة',exemptMemberIds:'الاستثناءات الدائمة',
 flood:'منع الفلود',joinRaid:'حماية الانضمام',night:'وضع الليل',
 raid:'حماية الهجمات',escalation:'تصعيد التحذيرات',
 temporaryExemptions:'الاستثناءات المؤقتة',ruleExemptions:'استثناءات القواعد'
};
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const clock=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000-TTL;
export function validOwnerNetworkPolicyRestoreRoute(data:unknown):boolean{
 return typeof data==='string'&&Buffer.byteLength(data,'utf8')<=64&&
  [preview,confirm,cancel,history,detail].some(re=>re.test(data));
}
export class OwnerNetworkPolicyRestore{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly now:()=>number=Date.now){}
 private allowed(s:BotState,actor:string):boolean{
  return clock(this.now())&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private async review(actor:string,id:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.now();
   if(!this.allowed(s,actor))return null;
   const available=previewNetworkPolicyRestore(s,this.policy,actor,now,id);
   if(!available)return null;
   const networks=(s.groupNetworks??[]).filter(n=>n.id===available.networkId),n=networks[0];
   if(networks.length!==1||!n)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(x=>x.ref===ref)||
    s.callbacks.filter(x=>x.actorId===actor&&x.action.startsWith(PREFIX)&&
     !x.revoked&&!x.used&&x.expiresAt>now).length>=100)return null;
   s.callbacks.push({ref,action:PREFIX+'restore:'+JSON.stringify([
    available.snapshotId,available.networkId,available.chatId,
    available.currentRevision,available.archiveRevision,
    available.networkRevision,available.proof]),
    actorId:actor,chatId:'private',policyVersion:0,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة استرجاع إعدادات الحماية</b>\n'+
    'الشبكة: '+esc(n.name)+'\n'+
    'المجموعة: <code>'+available.chatId+'</code>\n'+
    'المرجع: نسخة <code>'+id+'</code> · إصدار '+available.archiveRevision+'\n'+
    'الإصدار الحالي: '+available.currentRevision+'\n'+
    'الوضع المحفوظ: '+available.archiveMode+' · الوضع الذي سيبقى: '+available.currentMode+'\n'+
    'الحقول التي ستتغير ('+available.changedFields.length+'):\n'+
    available.changedFields.map(x=>'• '+fieldNames[x]).join('\n')+'\n'+
    'روابط توريث السياسات التي ستتوقف احترازيًا: '+available.pausedLinks+'\n'+
    'تُستعاد إعدادات القواعد فقط، دون نسخ وضع التشغيل أو تفعيل ENFORCE أو إرسال أي أمر Telegram.\n'+
    'الاسترجاع يتطلب تأكيدًا مستقلًا صالحًا لدقيقتين ولمرة واحدة.',[
     [btn('✅ تأكيد استرجاع الإعدادات','nw:1:rc:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:rx:'+ref.slice(2))]
    ]);
  });
 }
 private async decide(actor:string,nonce:string,operation:'CONFIRM'|'CANCEL'):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.now();
   if(!this.allowed(s,actor))return null;
   const found=s.callbacks.filter(x=>x.ref==='c_'+nonce),receipt=found[0];
   if(found.length!==1||!receipt||receipt.actorId!==actor||
    receipt.chatId!=='private'||receipt.policyVersion!==0||
    receipt.oneShot!==true||receipt.used!==false||receipt.revoked!==false||
    !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=now||
    receipt.expiresAt>now+TTL||!receipt.action.startsWith(PREFIX+'restore:'))return null;
   if(operation==='CANCEL'){
    receipt.revoked=true;
    return ui('<b>✖ أُلغي استرجاع الإعدادات</b>\nلم تتغير السياسة الحالية.',[
     [btn('📸 سجل السياسات التاريخية','nw:1:h')]
    ]);
   }
   let raw:unknown;
   try{raw=JSON.parse(receipt.action.slice((PREFIX+'restore:').length));}catch{return null;}
   if(!Array.isArray(raw)||raw.length!==7||
    [0,1].some(i=>typeof raw[i]!=='string'||!/^[a-f0-9]{12}$/u.test(raw[i] as string))||
    typeof raw[2]!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(raw[2])||
    !Number.isSafeInteger(Number(raw[2]))||
    [3,4,5].some(i=>!Number.isSafeInteger(raw[i])||Number(raw[i])<1)||
    typeof raw[6]!=='string'||!/^[a-f0-9]{64}$/u.test(raw[6]))return null;
   const [id,networkId,chatId,oldRevision,archiveRevision,netRev,proof]=raw as
    [string,string,string,number,number,number,string];
   const view=previewNetworkPolicyRestore(s,this.policy,actor,now,id);
   if(!view||view.networkId!==networkId||view.chatId!==chatId||
    view.currentRevision!==oldRevision||view.archiveRevision!==archiveRevision||
    view.networkRevision!==netRev||view.proof!==proof)return null;
   const result=applyNetworkPolicyRestore(s,this.policy,actor,now,id,proof);
   if(!result)return null;
   receipt.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-network-policy-restore:'+nonce,
    decision:'ALLOW',reason:'OWNER_NETWORK_POLICY_SNAPSHOT_RESTORED',
    policyVersion:result.newRevision,at:now});
   return ui('<b>✅ تم استرجاع إعدادات الحماية محليًا</b>\n'+
    'المجموعة: <code>'+chatId+'</code> · النسخة: <code>'+id+'</code>\n'+
    'إصدار السياسة الجديد: '+result.newRevision+'\n'+
    'الوضع المحفوظ على المجموعة: '+result.currentMode+'\n'+
    'الحقول المسترجعة: '+result.changedFields.length+'\n'+
    'روابط التوريث التي توقفت: '+result.pausedLinks+'\n'+
    'لا تنفيذ لعقوبات أو تغيير أذونات Telegram.',[
     [btn('📸 سجل نسخ الشبكة','nw:1:hl:'+networkId+':0')],
     [btn('🕘 سجل الاسترجاع','nw:1:rl:'+networkId+':0')],
     [btn('↩️ بطاقة الشبكة','nw:1:d:'+networkId)]
    ]);
  });
 }
 /** History is trusted only when exactly one committed audit matches one
  * consumed, uncancelled, one-shot restore receipt and its revision. */
 private entries(s:BotState,actor:string,now:number,networkId?:string){
  const list:{nonce:string;networkId:string;chatId:string;snapshotId:string;
   revision:number;at:number}[]=[];
  for(const audit of s.audit.filter(a=>a.reason==='OWNER_NETWORK_POLICY_SNAPSHOT_RESTORED')){
   const match=/^owner-network-policy-restore:([A-Za-z0-9_-]{24})$/u.exec(audit.updateKey);
   if(!match||audit.actorId!==actor||audit.decision!=='ALLOW'||
    !Number.isSafeInteger(audit.at)||audit.at<0||audit.at>now||
    s.audit.filter(a=>a.updateKey===audit.updateKey).length!==1)continue;
   const rows=s.callbacks.filter(c=>c.ref==='c_'+match[1]),rec=rows[0];
   if(rows.length!==1||!rec||rec.actorId!==actor||rec.chatId!=='private'||
    !rec.oneShot||!rec.used||rec.revoked||rec.policyVersion!==0||
    rec.expiresAt<=audit.at||rec.expiresAt>audit.at+TTL||
    !rec.action.startsWith(PREFIX+'restore:'))continue;
   let raw:unknown;
   try{raw=JSON.parse(rec.action.slice((PREFIX+'restore:').length));}catch{continue;}
   if(!Array.isArray(raw)||raw.length!==7||
    typeof raw[0]!=='string'||!/^[a-f0-9]{12}$/u.test(raw[0])||
    typeof raw[1]!=='string'||!/^[a-f0-9]{12}$/u.test(raw[1])||
    networkId!==undefined&&raw[1]!==networkId||
    typeof raw[2]!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(raw[2])||
    !Number.isSafeInteger(raw[3])||!Number.isSafeInteger(raw[4])||
    !Number.isSafeInteger(raw[5])||Number(raw[3])<1||
    audit.policyVersion!==Number(raw[3])+1||
    typeof raw[6]!=='string'||!/^[a-f0-9]{64}$/u.test(raw[6]))continue;
   list.push({nonce:match[1]!,snapshotId:raw[0],networkId:raw[1],
    chatId:raw[2],revision:audit.policyVersion,at:audit.at});
  }
  return list.sort((a,b)=>b.at-a.at||b.nonce.localeCompare(a.nonce));
 }
 private historyScreen(s:BotState,actor:string,id:string,p:number):OwnerInlineScreen|null{
  if(!this.allowed(s,actor)||(s.groupNetworks??[]).filter(n=>n.id===id).length!==1)return null;
  const items=this.entries(s,actor,this.now(),id),pages=Math.max(1,Math.ceil(items.length/SIZE));
  if(p>=pages)return null;
  const rows=items.slice(p*SIZE,(p+1)*SIZE).map(x=>[
   btn('↩️ '+x.chatId+' · إصدار '+x.revision,'nw:1:rd:'+x.nonce)
  ]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:rl:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:rl:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('📸 النسخ التاريخية','nw:1:ha:'+id)]);
  return ui('<b>🕘 سجل استرجاع إعدادات الشبكة</b>\n'+
   'العمليات المعتمدة: '+items.length+' · صفحة '+(p+1)+'/'+pages+'\n'+
   'هذه سجلات محلية مثبتة بإيصالات مستهلكة، ولا تثبت أي عمل على Telegram.',rows);
 }
 private detailScreen(s:BotState,actor:string,nonce:string):OwnerInlineScreen|null{
  if(!this.allowed(s,actor))return null;
  const rows=this.entries(s,actor,this.now()).filter(e=>e.nonce===nonce);
  if(rows.length!==1)return null;
  const e=rows[0]!;
  if(!(s.groupNetworks??[]).some(n=>n.id===e.networkId))return null;
  return ui('<b>🕘 استرجاع سياسة تاريخية</b>\n'+
   'المجموعة: <code>'+e.chatId+'</code>\n'+
   'النسخة المستخدمة: <code>'+e.snapshotId+'</code>\n'+
   'إصدار السياسة الجديد: '+e.revision+'\n'+
   'الوقت (UTC): '+new Date(e.at).toISOString().slice(0,19).replace('T',' ')+'\n'+
   'لا توجد أي أوامر أو عقوبات Telegram مرتبطة بالاسترجاع.',[
    [btn('↩️ سجل استرجاع الشبكة','nw:1:rl:'+e.networkId+':0')]
   ]);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validOwnerNetworkPolicyRestoreRoute(data))return null;
  const c=confirm.exec(data);if(c)return this.decide(actor,c[1]!,'CONFIRM');
  const x=cancel.exec(data);if(x)return this.decide(actor,x[1]!,'CANCEL');
  const v=preview.exec(data);if(v)return this.review(actor,v[1]!);
  const s=await this.store.snapshot();
  const h=history.exec(data);if(h)return this.historyScreen(s,actor,h[1]!,Number(h[2]));
  const d=detail.exec(data);if(d)return this.detailScreen(s,actor,d[1]!);
  return null;
 }
}
