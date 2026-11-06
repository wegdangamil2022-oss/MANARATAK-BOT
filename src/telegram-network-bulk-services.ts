import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {networkEmergencyStopped} from './network-emergency-stop.js';
import {eligibleNetworkServiceTargets,applyNetworkSelectedServiceDisable,
 type NetworkServiceControl,type NetworkServiceControlImpact} from './network-bulk-service-control.js';

/** NETWORK-004: owner-private, network-scoped, restrictive local group-service
 * controls. Never dispatch Telegram API calls, sanctions, grants or messages. */
const PREFIX='owner-network-service:',TTL=120_000,SIZE=8;
const net='([a-f0-9]{12})',page='(0|[1-9][0-9]{0,2})',mode='([am])';
const home=new RegExp('^nw:1:sh:'+net+'$','u');
const listing=new RegExp('^nw:1:sl:'+net+':'+mode+':'+page+'$','u');
const toggle=new RegExp('^nw:1:st:'+net+':'+mode+':'+page+':([a-f0-9]{2}):([0-7]):([a-f0-9]{12})$','u');
const preview=new RegExp('^nw:1:sv:'+net+':'+mode+':'+page+':([a-f0-9]{2}):([a-f0-9]{12})$','u');
const confirm=/^nw:1:sc:([A-Za-z0-9_-]{24})$/u;
const cancel=/^nw:1:sk:([A-Za-z0-9_-]{24})$/u;
const history=new RegExp('^nw:1:sa:'+net+':'+page+'$','u');
const detail=/^nw:1:sd:([A-Za-z0-9_-]{24})$/u;
type Mode='a'|'m';
const kind=(m:Mode):NetworkServiceControl=>m==='a'?'AI_OFF':'MONITOR_OFF';
const label=(m:Mode):string=>m==='a'?'إيقاف المساعد الذكي':'إيقاف مراقبة الحماية';
const auditReason=(m:Mode):string=>m==='a'?'OWNER_NETWORK_GROUP_AI_DISABLED':'OWNER_NETWORK_GROUP_MONITOR_DISABLED';
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const goodTime=(t:number)=>Number.isSafeInteger(t)&&t>=0&&t<=8_640_000_000_000_000-TTL;
export function validOwnerNetworkBulkServiceRoute(value:unknown):boolean{
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
  [home,listing,toggle,preview,confirm,cancel,history,detail].some(r=>r.test(value));
}
export class OwnerNetworkBulkServiceEditor {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private allowed(s:BotState,actor:string,now:number):boolean {
  return goodTime(now)&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private targetProof(s:BotState,networkId:string,m:Mode):string{
  return createHash('sha256').update(JSON.stringify([
   networkId,m,s.groupNetworks??[],s.chats,s.grants,s.protectionPolicies??[],
   s.networkInheritance??[],s.networkEmergencyControls??[],
   s.protectionFloodWindows??[],s.privateFeatures,s.privateSettingsRevision??null
  ])).digest('hex');
 }
 private eligible(s:BotState,actor:string,now:number,id:string,m:Mode){
  return eligibleNetworkServiceTargets(s,this.policy,actor,now,id,kind(m));
 }
 private screen(s:BotState,actor:string,now:number,id:string):OwnerInlineScreen|null{
  if(!this.allowed(s,actor,now))return null;
  const rows=(s.groupNetworks??[]).filter(n=>n.id===id);
  if(rows.length!==1||!rows[0])return null;
  const n=rows[0],stopped=networkEmergencyStopped(s,id);
  return ui('<b>🛑 إيقاف خدمات مجموعات الشبكة</b>\n'+
   'الشبكة: '+escape(n.name)+'\n'+
   (stopped?'⛔ الشبكة موقوفة طارئًا؛ لن تُنشأ معاينة إجراء إضافي.\n':'')+
   'اختر نوع إجراء تقليل الصلاحيات المحلي، ثم المجموعات المستهدفة، ثم عاين التأثير قبل التأكيد.\n'+
   'لا حظر أو كتم أو تغيير أذونات Telegram.',[
    [btn('🤖 إيقاف المساعد للمجموعات','nw:1:sl:'+id+':a:0')],
    [btn('🛡️ إيقاف المراقبة للمجموعات','nw:1:sl:'+id+':m:0')],
    [btn('🕘 سجل إيقاف خدمات الشبكة','nw:1:sa:'+id+':0')],
    [btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]
   ]);
 }
 private list(s:BotState,actor:string,now:number,id:string,m:Mode,p:number,
  mask:number,proof?:string):OwnerInlineScreen|null{
  if(!this.allowed(s,actor,now)||p<0||p>999||mask<0||mask>255||
   !Number.isSafeInteger(mask))return null;
  const all=this.eligible(s,actor,now,id,m);
  if(!all||all.length===0)return null;
  const digest=this.targetProof(s,id,m).slice(0,12);
  if(proof!==undefined&&proof!==digest)return null;
  const pages=Math.ceil(all.length/SIZE);
  if(p>=pages)return null;
  const visible=all.slice(p*SIZE,(p+1)*SIZE);
  if(mask>>>visible.length)return null;
  const maskHex=mask.toString(16).padStart(2,'0'),count=visible.filter((_,i)=>mask&(1<<i)).length;
  const rows=visible.map((item,i)=>[
   btn((mask&(1<<i)?'✅ ':'▫️ ')+item.chatId,
    'nw:1:st:'+id+':'+m+':'+p+':'+maskHex+':'+i+':'+digest)
  ]);
  if(count)rows.push([btn('🔎 معاينة '+count+' مجموعة مختارة',
   'nw:1:sv:'+id+':'+m+':'+p+':'+maskHex+':'+digest)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:sl:'+id+':'+m+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:sl:'+id+':'+m+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ إيقاف خدمات الشبكة','nw:1:sh:'+id)]);
  return ui('<b>👥 اختر مجموعات الشبكة</b>\n'+
   'الإجراء: '+label(m)+'\nالمختارة: '+count+' · صفحة '+(p+1)+'/'+pages+
   '\nالحد 8 مجموعات في المعاينة الواحدة. الانتقال إلى صفحة أخرى يبدأ اختيارًا مستقلًا.\n'+
   'المجموعات التي فقدت الاعتماد أو لا تملك الخدمة المطلوبة لا تظهر هنا.',rows);
 }
 private async review(actor:string,id:string,m:Mode,p:number,mask:number,
  proof:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),view=this.list(s,actor,now,id,m,p,mask,proof);
   const network=(s.groupNetworks??[]).find(n=>n.id===id);
   if(!view||!network||!mask)return null;
   const selected=this.eligible(s,actor,now,id,m)!.slice(p*SIZE,(p+1)*SIZE)
    .filter((_,i)=>Boolean(mask&(1<<i)));
   if(!selected.length||selected.length>SIZE)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(x=>x.ref===ref)||s.callbacks.filter(x=>x.actorId===actor&&
    x.action.startsWith(PREFIX)&&!x.used&&!x.revoked&&x.expiresAt>now).length>=100)return null;
   const ids=selected.map(x=>x.chatId),full=this.targetProof(s,id,m);
   s.callbacks.push({ref,action:PREFIX+'disable:'+JSON.stringify([id,network.revision,
    m,p,ids,full]),actorId:actor,chatId:'private',policyVersion:0,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة '+label(m)+'</b>\n'+
    'الشبكة: '+escape(network.name)+'\nالمجموعات المستهدفة: '+ids.length+'\n'+
    selected.map(x=>'• <code>'+x.chatId+'</code>: '+x.before+
     ' ← OFF؛ متابعات سياسات ستتوقف: '+x.linkedPolicies).join('\n')+'\n'+
    (m==='a'?'تعطيل المساعد يرفع إصدار اعتماد المجموعة؛ قد تحتاج سياسة الحماية وربط الشبكة إلى مراجعة جديدة.\n':
     'تعطيل المراقبة يزيل التشغيل فقط، ويحفظ القواعد والاستثناءات ويوقف المتابعات المرتبطة.\n')+
    'لا حذف أو حظر أو كتم عبر Telegram. التأكيد صالح لدقيقتين ولمرة واحدة.',[
     [btn('✅ تأكيد '+label(m),'nw:1:sc:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:sk:'+ref.slice(2))]
    ]);
  });
 }
 private async receipt(actor:string,nonce:string,action:'CONFIRM'|'CANCEL'):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.allowed(s,actor,now))return null;
   const rows=s.callbacks.filter(x=>x.ref==='c_'+nonce),record=rows[0];
   if(rows.length!==1||!record||!record.action.startsWith(PREFIX+'disable:')||
    record.actorId!==actor||record.chatId!=='private'||record.policyVersion!==0||
    record.oneShot!==true||record.used!==false||record.revoked!==false||
    !Number.isSafeInteger(record.expiresAt)||record.expiresAt<=now||
    record.expiresAt>now+TTL)return null;
   if(action==='CANCEL'){
    record.revoked=true;
    s.audit.push({actorId:actor,updateKey:'owner-network-service:cancel:'+nonce,
     decision:'NOOP',reason:'OWNER_NETWORK_SERVICE_PREVIEW_CANCELLED',
     policyVersion:0,at:now});
    return ui('<b>✖ ألغيت المعاينة</b>\nلا تغيير في خدمات أو سياسات المجموعات.',[
     [btn('🌐 الشبكات المحلية','nw:1:h')]
    ]);
   }
   let data:unknown;
   try{data=JSON.parse(record.action.slice((PREFIX+'disable:').length));}catch{return null;}
   if(!Array.isArray(data)||data.length!==6||
    typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
    !Number.isSafeInteger(data[1])||data[1]<1||
    !['a','m'].includes(String(data[2]))||
    !Number.isSafeInteger(data[3])||data[3]<0||data[3]>999||
    !Array.isArray(data[4])||data[4].length<1||data[4].length>SIZE||
    data[4].some((x:unknown)=>typeof x!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(x)||
     !Number.isSafeInteger(Number(x)))||new Set(data[4]).size!==data[4].length||
    typeof data[5]!=='string'||!/^[a-f0-9]{64}$/u.test(data[5]))return null;
   const [networkId,revision,m,p,ids,proof]=data as
    [string,number,Mode,number,string[],string];
   const networks=(s.groupNetworks??[]).filter(n=>n.id===networkId);
   if(networks.length!==1||networks[0]!.revision!==revision||
    this.targetProof(s,networkId,m)!==proof)return null;
   const eligible=this.eligible(s,actor,now,networkId,m),visible=eligible?.slice(p*SIZE,(p+1)*SIZE);
   if(!visible||!ids.every(id=>visible.some(row=>row.chatId===id))||
    JSON.stringify(visible.filter(row=>ids.includes(row.chatId)).map(row=>row.chatId))!==
     JSON.stringify(ids))return null;
   const applied=applyNetworkSelectedServiceDisable(s,this.policy,actor,now,networkId,kind(m),ids);
   if(!applied)return null;
   record.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-network-service:'+nonce,decision:'ALLOW',
    reason:auditReason(m),policyVersion:revision,at:now});
   return ui('<b>✅ '+label(m)+' محليًا</b>\n'+
    'الشبكة: '+escape(networks[0]!.name)+'\nالمجموعات المعدلة: '+ids.length+'\n'+
    ids.map(id=>'• <code>'+id+'</code>').join('\n')+'\n'+
    'متابعات السياسات التي توقفت احترازيًا: '+applied.pausedLinks+
    '\nلم تتغير عقوبات أو صلاحيات Telegram.',[
     [btn('🛑 إيقاف خدمات الشبكة','nw:1:sh:'+networkId)],
     [btn('🕘 سجل الإيقاف','nw:1:sa:'+networkId+':0')]
    ]);
  });
 }
 private verifiedEvents(s:BotState,actor:string,now:number,networkId?:string):
 {nonce:string;networkId:string;m:Mode;ids:string[];at:number}[]{
  const events:{nonce:string;networkId:string;m:Mode;ids:string[];at:number}[]=[];
  for(const a of s.audit.filter(x=>x.reason==='OWNER_NETWORK_GROUP_AI_DISABLED'||
   x.reason==='OWNER_NETWORK_GROUP_MONITOR_DISABLED')){
   const match=/^owner-network-service:([A-Za-z0-9_-]{24})$/u.exec(a.updateKey);
   if(!match||a.actorId!==actor||a.decision!=='ALLOW'||a.at>now||
    !Number.isSafeInteger(a.at)||a.at<0||
    s.audit.filter(x=>x.updateKey===a.updateKey).length!==1)continue;
   const receipts=s.callbacks.filter(x=>x.ref==='c_'+match[1]),record=receipts[0];
   if(receipts.length!==1||!record||record.actorId!==actor||
    record.chatId!=='private'||record.policyVersion!==0||
    !record.oneShot||!record.used||record.revoked||
    !Number.isSafeInteger(record.expiresAt)||record.expiresAt<=a.at||
    record.expiresAt>a.at+TTL||!record.action.startsWith(PREFIX+'disable:'))continue;
   let payload:unknown;
   try{payload=JSON.parse(record.action.slice((PREFIX+'disable:').length));}catch{continue;}
   if(!Array.isArray(payload)||payload.length!==6||
    typeof payload[0]!=='string'||!/^[a-f0-9]{12}$/u.test(payload[0])||
    networkId!==undefined&&payload[0]!==networkId||
    !Number.isSafeInteger(payload[1])||payload[1]!==a.policyVersion||
    !['a','m'].includes(String(payload[2]))||
    a.reason!==auditReason(payload[2] as Mode)||
    !Number.isSafeInteger(payload[3])||payload[3]<0||payload[3]>999||
    !Array.isArray(payload[4])||payload[4].length<1||payload[4].length>SIZE||
    payload[4].some((x:unknown)=>typeof x!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(x))||
    new Set(payload[4]).size!==payload[4].length||
    typeof payload[5]!=='string'||!/^[a-f0-9]{64}$/u.test(payload[5]))continue;
   events.push({nonce:match[1]!,networkId:payload[0] as string,
    m:payload[2] as Mode,ids:payload[4] as string[],at:a.at});
  }
  return events.sort((a,b)=>b.at-a.at||b.nonce.localeCompare(a.nonce));
 }
 private historyPage(s:BotState,actor:string,now:number,networkId:string,p:number):
 OwnerInlineScreen|null{
  if(!this.allowed(s,actor,now)||!(s.groupNetworks??[]).some(n=>n.id===networkId))return null;
  const items=this.verifiedEvents(s,actor,now,networkId),pages=Math.max(1,Math.ceil(items.length/SIZE));
  if(p>=pages)return null;
  const rows=items.slice(p*SIZE,(p+1)*SIZE).map(x=>[
   btn((x.m==='a'?'🤖 ':'🛡️ ')+x.ids.length+' مجموعات · '+
    new Date(x.at).toISOString().slice(0,16).replace('T',' '),
    'nw:1:sd:'+x.nonce)
  ]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:sa:'+networkId+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:sa:'+networkId+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ خدمات الشبكة','nw:1:sh:'+networkId)]);
  return ui('<b>🕘 سجل إيقاف خدمات الشبكة</b>\n'+
   'القرارات الموثقة: '+items.length+' · صفحة '+(p+1)+'/'+pages+
   '\nالسجل تاريخي للقراءة فقط وليس إثباتًا لأي تغيير في Telegram.',rows);
 }
 private detailPage(s:BotState,actor:string,now:number,nonce:string):
 OwnerInlineScreen|null{
  const entries=this.verifiedEvents(s,actor,now).filter(x=>x.nonce===nonce);
  if(!this.allowed(s,actor,now)||entries.length!==1)return null;
  const a=entries[0]!;
  if(!(s.groupNetworks??[]).some(n=>n.id===a.networkId))return null;
  return ui('<b>🕘 تفاصيل قرار إيقاف محلي</b>\n'+
   'العملية: '+label(a.m)+'\nالشبكة: '+a.networkId+
   '\nعدد المجموعات: '+a.ids.length+'\n'+
   a.ids.map(id=>'• <code>'+id+'</code>').join('\n')+
   '\nالتاريخ (UTC): '+new Date(a.at).toISOString().replace('T',' ').slice(0,19)+
   '\nلا تمثل هذه العملية أمرًا على Telegram.',[
    [btn('↩️ سجل الشبكة','nw:1:sa:'+a.networkId+':0')]
   ]);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validOwnerNetworkBulkServiceRoute(data))return null;
  const c=confirm.exec(data);if(c)return this.receipt(actor,c[1]!,'CONFIRM');
  const k=cancel.exec(data);if(k)return this.receipt(actor,k[1]!,'CANCEL');
  const s=await this.store.snapshot(),now=this.clock();
  if(!this.allowed(s,actor,now))return null;
  const h=home.exec(data);if(h)return this.screen(s,actor,now,h[1]!);
  const lp=listing.exec(data);
  if(lp)return this.list(s,actor,now,lp[1]!,lp[2] as Mode,Number(lp[3]),0);
  const t=toggle.exec(data);
  if(t){
   const mask=Number.parseInt(t[4]!,16),index=Number(t[5]),m=t[2] as Mode,p=Number(t[3]);
   if(!this.list(s,actor,now,t[1]!,m,p,mask,t[6]!))return null;
   return this.list(s,actor,now,t[1]!,m,p,mask^(1<<index),t[6]!);
  }
  const v=preview.exec(data);
  if(v)return this.review(actor,v[1]!,v[2] as Mode,Number(v[3]),
   Number.parseInt(v[4]!,16),v[5]!);
  const hist=history.exec(data);
  if(hist)return this.historyPage(s,actor,now,hist[1]!,Number(hist[2]));
  const d=detail.exec(data);if(d)return this.detailPage(s,actor,now,d[1]!);
  return null;
 }
}
