import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat} from './store.js';
import type {GroupNetwork} from './group-network-model.js';
import {validNetworkName} from './group-network-model.js';
import {prepareNetworkInheritance,pauseNetworkInheritanceByOwner} from './network-inheritance.js';
import {decideNetworkEmergency,networkEmergencyStopped} from './network-emergency-stop.js';
import {pauseSelectedNetworkPolicyLinks} from './network-bulk-policy-pause.js';
import {OwnerNetworkWatchEditor,validOwnerNetworkWatchRoute} from './telegram-network-watch-owner.js';
import {OwnerNetworkSanctionEditor,validOwnerNetworkSanctionRoute,
 type NetworkSanctionRemoteRead} from './telegram-network-sanction-owner.js';
import {isValidProtectionPolicy,type ProtectionPolicy} from './protection-rules.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';

/** Local network folders for approved groups. Membership is an organization
 * hint only; it NEVER issues Telegram rights, grants, moderation or delivery. */
const TTL=120_000,INPUT_TTL=600_000,MULTI_TTL=600_000,PREFIX='owner-network-',SIZE=8;
const net='([a-f0-9]{12})',page='(0|[1-9][0-9]{0,2})',
 group='(-[1-9][0-9]{0,15})',revision='([1-9][0-9]{0,9})';
const home=/^nw:1:h$/u,begin=/^nw:1:n$/u;
const list=new RegExp('^nw:1:p:'+page+'$','u');
const detail=new RegExp('^nw:1:d:'+net+'$','u');
const policySources=new RegExp('^nw:1:y:'+net+':'+page+'$','u');
const policyPreview=new RegExp('^nw:1:z:'+net+':'+group+':'+page+'$','u');
const followList=new RegExp('^nw:1:f:'+net+':'+page+'$','u');
const followStop=/^nw:1:j:([a-f0-9]{12})$/u;
const bulkList=new RegExp('^nw:1:bl:'+net+':'+page+'$','u');
const multiStart=new RegExp('^nw:1:ms:'+net+'$','u');
const multiMove=/^nw:1:mp:([A-Za-z0-9_-]{24}):(0|[1-9][0-9]{0,2}):(0|[1-9][0-9]{0,2})$/u;
const multiToggle=/^nw:1:mt:([A-Za-z0-9_-]{24}):(0|[1-9][0-9]{0,2}):([0-7])$/u;
const multiPreview=/^nw:1:mv:([A-Za-z0-9_-]{24}):(0|[1-9][0-9]{0,2})$/u;
const multiCancel=/^nw:1:mx:([A-Za-z0-9_-]{24}):(0|[1-9][0-9]{0,2})$/u;
const bulkToggle=new RegExp('^nw:1:bt:'+net+':'+page+':([a-f0-9]{2}):([0-7]):([a-f0-9]{12})$','u');
const bulkPreview=new RegExp('^nw:1:bv:'+net+':'+page+':([a-f0-9]{2}):([a-f0-9]{12})$','u');
const emergencyHome=new RegExp('^nw:1:eh:'+net+'$','u');
const emergencyStop=new RegExp('^nw:1:es:'+net+'$','u');
const emergencyResume=new RegExp('^nw:1:er:'+net+'$','u');
const rename=new RegExp('^nw:1:e:'+net+'$','u');
const remove=new RegExp('^nw:1:x:'+net+'$','u');
const pick=new RegExp('^nw:1:g:'+net+':'+page+'$','u');
const stalePage=new RegExp('^nw:1:s:'+net+':'+page+'$','u');
const stalePick=new RegExp('^nw:1:q:'+net+':'+revision+':'+group+':'+revision+':'+page+'$','u');
const staleBatch=new RegExp('^nw:1:b:'+net+':'+revision+':'+page+'$','u');
const toggle=new RegExp('^nw:1:t:'+net+':'+revision+':'+group+':'+revision+':'+page+'$','u');
const confirm=/^nw:1:c:([A-Za-z0-9_-]{24})$/u,cancel=/^nw:1:k:([A-Za-z0-9_-]{24})$/u;
const historyPage=new RegExp('^nw:1:r:p:'+page+'$','u');
const historyView=/^nw:1:r:v:([A-Za-z0-9_-]{24})$/u;
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(value:string)=>value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const validId=(value:string)=>/^-[1-9][0-9]{0,15}$/u.test(value)&&Number.isSafeInteger(Number(value));
const validClock=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000-INPUT_TTL;
export function validOwnerNetworkRoute(data:unknown):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return false;
 return data==='mi:1:i:01:03'||home.test(data)||begin.test(data)||validOwnerNetworkWatchRoute(data)||
   validOwnerNetworkSanctionRoute(data)||
  [list,detail,policySources,policyPreview,followList,followStop,
   bulkList,bulkToggle,bulkPreview,multiStart,multiMove,multiToggle,multiPreview,multiCancel,
   emergencyHome,emergencyStop,emergencyResume,rename,remove,pick,toggle,
   stalePage,stalePick,staleBatch,confirm,cancel,historyPage,historyView].some(re=>re.test(data));
}
function approved(s:BotState,policy:Policy,actor:string,now:number):Chat[]{
 const counts=new Map<string,number>();
 for(const c of s.chats)counts.set(c.id,(counts.get(c.id)??0)+1);
 return s.chats.filter(c=>c.approved&&counts.get(c.id)===1&&validId(c.id)&&
  Number.isSafeInteger(c.version)&&c.version>=1&&c.version<=9_999_999_999&&
  policy.has(s,actor,'chat.manage',c.id,now))
  .sort((a,b)=>a.id.localeCompare(b.id));
}
/** A network association is stale unless its exact approval revision remains authorized. */
function staleLinks(n:GroupNetwork,current:readonly Chat[]):GroupNetwork['members']{
 return n.members.filter(m=>!current.some(c=>c.id===m.chatId&&c.version===m.version))
  .sort((a,b)=>a.chatId.localeCompare(b.chatId));
}
function namesProof(s:BotState):string{
 return createHash('sha256').update(JSON.stringify([
  (s.groupNetworks??[]).map(n=>[n.id,n.name,n.revision]),s.privateSettingsRevision??0,
  s.privateFeatures['owner.dashboard']
 ])).digest('hex');
}
function editProof(s:BotState,n:GroupNetwork):string{
 return createHash('sha256').update(JSON.stringify([namesProof(s),n])).digest('hex');
}
function groupProof(s:BotState,n:GroupNetwork,items:Chat[]):string{
 return createHash('sha256').update(JSON.stringify([
  n, s.chats, items.map(c=>[c.id,c.version]), s.privateSettingsRevision??0,
  s.privateFeatures['owner.dashboard']
 ])).digest('hex');
}
const matchesName=(networks:readonly GroupNetwork[],name:string)=>networks.some(
 n=>n.name.toLocaleLowerCase('en-US')===name.toLocaleLowerCase('en-US'));

export class OwnerNetworkEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly remoteRead?:NetworkSanctionRemoteRead){}
 private auth(s:BotState,actor:string,now:number):boolean{
  return this.policy.isOwner(actor)&&validClock(now)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private root(s:BotState):OwnerInlineScreen{
  return ui('<b>🌐 الشبكات والاتحادات — التنظيم المحلي</b>\n'+
   'إنشاء شبكات مسماة وربط مجموعات معتمدة بها دون تفعيل حقوق أو عقوبات Telegram.\n'+
   'الشبكات المحفوظة: '+(s.groupNetworks??[]).length+' من 32\n'+
   'عضوية الشبكة محلية ولا تمنح إذن النشر أو الإشراف، ولا تُنشئ اتحاد Telegram تلقائيًا.',
   [[btn('➕ إنشاء شبكة محلية','nw:1:n')],
    [btn('📋 شبكاتي المحفوظة','nw:1:p:0')],
    [btn('🕘 سجل تغييرات الشبكات','nw:1:r:p:0')],
    [btn('↩️ المجموعات والشبكات','mi:1:s:01:0'),btn('🏠 لوحة المالك','mi:1:h')]]);
 }
 private networkList(s:BotState,p:number):OwnerInlineScreen|null{
  const rowsAll=[...(s.groupNetworks??[])].sort((a,b)=>a.id.localeCompare(b.id));
  const pages=Math.max(1,Math.ceil(rowsAll.length/SIZE));
  if(p>=pages)return null;
  const rows=rowsAll.slice(p*SIZE,(p+1)*SIZE)
   .map(n=>[btn('🌐 '+n.name,'nw:1:d:'+n.id)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:p:'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:p:'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('➕ إنشاء شبكة','nw:1:n'),btn('↩️ الشبكات','nw:1:h')]);
  return ui('<b>🌐 شبكات منارتك المحلية</b>\n'+
   'عدد الشبكات: '+rowsAll.length+' · صفحة '+(p+1)+' من '+pages+'\n'+
   (rowsAll.length?'اختر شبكة لإدارة ارتباطاتها.':'لا توجد شبكات محفوظة بعد.')+'\n'+
   'لا تُمثّل هذه الشبكات صلاحيات Telegram.',rows);
 }
 private find(s:BotState,id:string):GroupNetwork|null{
  const found=(s.groupNetworks??[]).filter(n=>n.id===id);
  return found.length===1?found[0]!:null;
 }
 /** Only explicit owner-reviewed MONITOR/OFF policy templates can be a
  * network source. Each source and target needs current group rights. */
 private availablePolicySources(s:BotState,actor:string,now:number,n:GroupNetwork):Chat[]{
  if(networkEmergencyStopped(s,n.id))return [];
  const allowed=approved(s,this.policy,actor,now);
  return allowed.filter(c=>n.members.some(m=>m.chatId===c.id&&m.version===c.version)&&
   c.scopes.includes('moderation')&&this.policy.canUseChat(s,c.id,'moderation')&&
   (s.protectionPolicies??[]).filter(r=>r.policy.chatId===c.id).length===1&&
   (s.protectionPolicies??[]).some(r=>r.policy.chatId===c.id&&
    r.chatPolicyVersion===c.version&&r.updatedAt<=now&&
    isValidProtectionPolicy(r.policy)&&r.policy.mode!=='ENFORCE'));
 }
 private targetPolicyCandidates(s:BotState,actor:string,now:number,n:GroupNetwork,sourceId:string):Chat[]{
  const current=approved(s,this.policy,actor,now);
  return current.filter(c=>c.id!==sourceId&&c.scopes.includes('moderation')&&
   this.policy.canUseChat(s,c.id,'moderation')&&
   n.members.some(m=>m.chatId===c.id&&m.version===c.version)&&
   !(s.protectionPolicies??[]).some(p=>p.policy.chatId===c.id)&&
   !(s.networkInheritance??[]).some(l=>l.kind==='POLICY'&&l.targetChatId===c.id))
   .slice(0,50);
 }
 private policyWitness(s:BotState,actor:string,now:number,n:GroupNetwork,sourceId:string):string{
  const targets=this.targetPolicyCandidates(s,actor,now,n,sourceId);
  return createHash('sha256').update(JSON.stringify([
   n,s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision??null,
   s.protectionPolicies??[],s.networkInheritance??[],sourceId,
   targets.map(c=>[c.id,c.version])
  ])).digest('hex');
 }
 private policySourcePage(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const n=this.find(s,id);if(!n||p<0||p>999)return null;
  const sources=this.availablePolicySources(s,actor,now,n),pages=Math.max(1,Math.ceil(sources.length/SIZE));
  if(p>=pages)return null;
  const rows=sources.slice(p*SIZE,(p+1)*SIZE).map(x=>
   [btn('📑 سياسة المجموعة '+x.id,'nw:1:z:'+n.id+':'+x.id+':'+p)]);
  if(p>0)rows.push([btn('⬅️ السابق','nw:1:y:'+id+':'+(p-1))]);
  if(p+1<pages)rows.push([btn('➡️ التالي','nw:1:y:'+id+':'+(p+1))]);
  rows.push([btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]);
  return ui('<b>📑 سياسات شبكة '+escape(n.name)+'</b>\nاختر مصدر مراقبة معتمدًا؛ لا تنقل هذه الميزة عقوبات ولا تفعّل ENFORCE.\n'+
   (sources.length?'اختر مجموعة لمعاينة النسخ إلى المجموعات بلا سياسة محلية.':'لا توجد مصادر سياسات مؤهلة بعد.')+
   '\nالمصادر: '+sources.length+' · صفحة '+(p+1)+'/'+pages,rows);
 }
 private async previewPolicy(actor:string,networkId:string,sourceId:string,p:number):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),n=this.find(s,networkId);
   if(!this.auth(s,actor,now)||!n||
      !this.availablePolicySources(s,actor,now,n).some(x=>x.id===sourceId)||
      !this.policySourcePage(s,actor,now,networkId,p))return null;
   const targets=this.targetPolicyCandidates(s,actor,now,n,sourceId);
   if(!targets.length||targets.length>50)return null;
   const source=(s.protectionPolicies??[]).find(x=>x.policy.chatId===sourceId)!;
   const proof=this.policyWitness(s,actor,now,n,sourceId);
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+'policy-follow:'+JSON.stringify([
    networkId,n.revision,sourceId,source.policy.revision,targets.map(t=>t.id),proof]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,
    revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة متابعة سياسة شبكة</b>\nالمصدر: <code>'+sourceId+'</code>'+
    '\nالمجموعات المستهدفة: '+targets.length+
    '\nالنمط: مراقبة محلية فقط، دون عقوبات Telegram أو نسخ الاستثناءات والقوائم الخاصة.\n'+
    'أي تعديل للمجموعة المستهدفة أو تغير اعتماد الشبكة يوقف متابعتها.\n'+
    'المتابعة تبدأ فقط بعد التأكيد، ولا تفعّل إنفاذ أي عقوبة.',
    [[btn('✅ تأكيد متابعة المصدر','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }
 /** NETWORK-004: persisted emergency gate uses owner approval only.
  * Stale group memberships may NOT block the owner from STOPPING; no
  * Telegram operation is made, and paused policies remain locally intact. */
 private emergencyProof(s:BotState,id:string):string{
  const n=this.find(s,id);
  return createHash('sha256').update(JSON.stringify([
   n,s.networkEmergencyControls??[],s.networkInheritance??[],
   s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision??null
  ])).digest('hex');
 }
 private emergencyPage(s:BotState,actor:string,now:number,id:string):OwnerInlineScreen|null{
  const n=this.find(s,id);
  if(!this.auth(s,actor,now)||!n)return null;
  const stopped=networkEmergencyStopped(s,id);
  const links=(s.networkInheritance??[]).filter(x=>x.networkId===id);
  const active=links.filter(x=>x.status==='ACTIVE').length;
  const paused=links.filter(x=>x.status==='PAUSED').length;
  const record=(s.networkEmergencyControls??[]).find(x=>x.networkId===id);
  return ui('<b>🚨 طوارئ الشبكة</b>\nالشبكة: '+escape(n.name)+
   '\nالحالة: '+(stopped?'⛔ الإيقاف الطارئ مفعل':'✅ لا يوجد إيقاف طارئ')+
   '\nالمتابعات النشطة: '+active+' · المتوقفة: '+paused+
   '\nإصدار قرار الطوارئ: '+(record?.revision??0)+
   '\nالإيقاف يوقف مزامنة سياسات مراقبة الشبكة المحلية فقط، ولا يغير سياسات المجموعات الحالية أو عقوبات Telegram. رفع الإيقاف لا يعيد تشغيل أي متابعة سابقة تلقائيًا.',[
    [stopped?btn('🔓 رفع الإيقاف بموافقة','nw:1:er:'+id):
     btn('⛔ إيقاف طارئ للشبكة','nw:1:es:'+id)],
    [btn('⏸️ إدارة المتابعات','nw:1:f:'+id+':0')],
    [btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]
   ]);
 }
 private async previewEmergency(actor:string,id:string,action:'STOP'|'RESUME'):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),n=this.find(s,id);
   if(!this.auth(s,actor,now)||!n||
    action==='STOP'&&networkEmergencyStopped(s,id)||
    action==='RESUME'&&!networkEmergencyStopped(s,id))return null;
   const state=(s.networkEmergencyControls??[]).find(x=>x.networkId===id);
   const revision=state?.revision??0;
   const active=(s.networkInheritance??[]).filter(x=>x.networkId===id&&x.status==='ACTIVE').length;
   const proof=this.emergencyProof(s,id);
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(x=>x.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+'emergency:'+JSON.stringify([id,revision,action,proof]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,
    revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة '+(action==='STOP'?'الإيقاف الطارئ':'رفع الإيقاف')+'</b>\n'+
    'الشبكة: '+escape(n.name)+'\nمتابعات ستتوقف: '+active+
    '\n'+(action==='STOP'?
     'سيتم وقف جميع متابعات سياسات الشبكة الآن وحظر أي متابعة جديدة حتى موافقة لاحقة.':
     'ستُتاح إعدادات المراقبة المستقبلية فقط؛ لا تُستأنف المتابعات المتوقفة.')+
    '\nلا تتغير عقوبات Telegram أو حقوق المجموعات. التأكيد صالح لدقيقتين فقط.',[
     [btn('✅ تأكيد '+(action==='STOP'?'الإيقاف':'رفع الإيقاف'),'nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]
    ]);
  });
 }
 /** No grant or enforcement. Proof binds network and exact follow record. */
 private followStopProof(s:BotState,n:GroupNetwork,id:string):string{
  const rows=(s.networkInheritance??[]).filter(x=>x.id===id);
  return createHash('sha256').update(JSON.stringify([
   n,rows,s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision??null
  ])).digest('hex');
 }
 /** Selected-group bulk pause wizard (8 links per page). All selection
  * state is in short, snapshot-bound callback data, not a shared user slot. */
 private bulkProof(s:BotState,networkId:string):string{
  const n=this.find(s,networkId);
  return createHash('sha256').update(JSON.stringify([
   n,s.networkInheritance??[],s.networkEmergencyControls??[],
   s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision??null
  ])).digest('hex');
 }
 private bulkActive(s:BotState,networkId:string){
  return (s.networkInheritance??[]).filter(x=>x.networkId===networkId&&
   x.kind==='POLICY'&&x.status==='ACTIVE').sort((a,b)=>a.id.localeCompare(b.id));
 }
 private bulkPage(s:BotState,actor:string,now:number,networkId:string,p:number,
  mask:number,expectedProof?:string):OwnerInlineScreen|null{
  if(!this.auth(s,actor,now)||!this.find(s,networkId)||
   networkEmergencyStopped(s,networkId)||!Number.isSafeInteger(p)||
   p<0||p>999||!Number.isSafeInteger(mask)||mask<0||mask>255)return null;
  const digest=this.bulkProof(s,networkId).slice(0,12);
  if(expectedProof!==undefined&&digest!==expectedProof)return null;
  const active=this.bulkActive(s,networkId),pages=Math.max(1,Math.ceil(active.length/SIZE));
  if(!active.length||p>=pages)return null;
  const pageRows=active.slice(p*SIZE,(p+1)*SIZE);
  if(mask>>>pageRows.length)return null;
  const maskStr=mask.toString(16).padStart(2,'0');
  const chosen=pageRows.filter((_,i)=>(mask&(1<<i))!==0);
  const rows=pageRows.map((x,i)=>[
   btn((mask&(1<<i)?'✅ ':'▫️ ')+x.targetChatId,
    'nw:1:bt:'+networkId+':'+p+':'+maskStr+':'+i+':'+digest)
  ]);
  if(chosen.length)rows.push([
   btn('🔎 معاينة إيقاف '+chosen.length+' مجموعة','nw:1:bv:'+
    networkId+':'+p+':'+maskStr+':'+digest)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:bl:'+networkId+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:bl:'+networkId+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ إدارة المتابعات','nw:1:f:'+networkId+':0')]);
  return ui('<b>👥 اختيار المجموعات لإيقاف المتابعة</b>\n'+
   'اختر أهدافًا محددة بعلامة ✅. المختارة: '+chosen.length+
   ' · صفحة '+(p+1)+'/'+pages+'\n'+
   'يُختار حتى 8 مجموعات من الصفحة الحالية فقط. الانتقال لصفحة أخرى يبدأ اختيارًا منفصلًا. '+
   'لن تُحذف أي سياسة محلية ولا تُنفذ عقوبة Telegram.',rows);
 }
 private async previewBulkStop(actor:string,networkId:string,p:number,
  mask:number,expectedProof:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),page=this.bulkPage(s,actor,now,networkId,p,mask,expectedProof);
   const n=this.find(s,networkId);
   if(!page||!n||!mask)return null;
   const selected=this.bulkActive(s,networkId).slice(p*SIZE,(p+1)*SIZE)
    .filter((_,i)=>Boolean(mask&(1<<i)));
   if(!selected.length||selected.length>SIZE)return null;
   const ids=selected.map(x=>x.id),proof=this.bulkProof(s,networkId);
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+'policy-bulk-stop:'+JSON.stringify([
    networkId,n.revision,p,ids,proof]),actorId:actor,chatId:'private',
    policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة إيقاف المتابعات المحددة</b>\n'+
    'الشبكة: '+escape(n.name)+'\n'+
    'عدد المجموعات: '+selected.length+'\n'+
    selected.map(x=>'• <code>'+x.targetChatId+'</code>').join('\n')+
    '\nسيُوقف التوريث المحلي إلى هذه المجموعات فقط. بقية الشبكة ستستمر. '+
    'لا تغيير في سياسات المجموعات أو Telegram. التأكيد صالح لدقيقتين.',[
    [btn('✅ تأكيد إيقاف المجموعات المحددة','nw:1:c:'+ref.slice(2))],
    [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]
   ]);
  });
 }
 /** Owner-bound multi-page selection persists as a private, expiring callback
  * record. All buttons contain a revision to reject old Telegram keyboards.
  * Snapshot fingerprints bind every group and link, not only the current page. */
 private readMultiSession(s:BotState,actor:string,now:number,nonce:string):
  {record:BotState['callbacks'][number];networkId:string;selected:string[];
   version:number;page:number}|null{
  if(!this.auth(s,actor,now)||!/^[A-Za-z0-9_-]{24}$/u.test(nonce))return null;
  const rows=s.callbacks.filter(x=>x.ref==='b_'+nonce),record=rows[0];
  if(rows.length!==1||!record||record.actorId!==actor||record.chatId!=='private'||
   record.policyVersion!==0||record.oneShot!==false||record.used!==false||
   record.revoked!==false||!Number.isSafeInteger(record.expiresAt)||
   record.expiresAt<=now||record.expiresAt>now+MULTI_TTL||
   !record.action.startsWith(PREFIX+'multi-select:'))return null;
  let payload:unknown;
  try{payload=JSON.parse(record.action.slice((PREFIX+'multi-select:').length));}
  catch{return null;}
  if(!Array.isArray(payload)||payload.length!==5||
   typeof payload[0]!=='string'||!/^[a-f0-9]{12}$/u.test(payload[0])||
   typeof payload[1]!=='string'||!/^[a-f0-9]{64}$/u.test(payload[1])||
   !Array.isArray(payload[2])||payload[2].length>SIZE||
   payload[2].some((x:unknown)=>typeof x!=='string'||!/^[a-f0-9]{12}$/u.test(x))||
   new Set(payload[2]).size!==payload[2].length||
   !Number.isSafeInteger(payload[3])||payload[3]<0||payload[3]>999||
   !Number.isSafeInteger(payload[4])||payload[4]<0||payload[4]>999)return null;
  const [networkId,proof,selected,version,page]=payload as
   [string,string,string[],number,number];
  if(!this.find(s,networkId)||networkEmergencyStopped(s,networkId)||
   this.bulkProof(s,networkId)!==proof)return null;
  const active=this.bulkActive(s,networkId),pages=Math.max(1,Math.ceil(active.length/SIZE));
  if(!active.length||page>=pages||
   selected.some(id=>!active.some(row=>row.id===id)))return null;
  return {record,networkId,selected,version,page};
 }
 private multiPage(s:BotState,actor:string,now:number,nonce:string,
  expectedVersion?:number,capHit=false):OwnerInlineScreen|null{
  const session=this.readMultiSession(s,actor,now,nonce);
  if(!session||(expectedVersion!==undefined&&session.version!==expectedVersion))return null;
  const active=this.bulkActive(s,session.networkId);
  const pages=Math.ceil(active.length/SIZE),records=active.slice(session.page*SIZE,
   (session.page+1)*SIZE);
  const rows=records.map((record,i)=>[
   btn((session.selected.includes(record.id)?'✅ ':'▫️ ')+record.targetChatId,
    'nw:1:mt:'+nonce+':'+session.version+':'+i)
  ]);
  if(session.selected.length)rows.push([
   btn('🔎 معاينة '+session.selected.length+' مجموعة مختارة',
    'nw:1:mv:'+nonce+':'+session.version)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(session.page)nav.push(btn('⬅️ السابق','nw:1:mp:'+nonce+':'+
   session.version+':'+(session.page-1)));
  if(session.page+1<pages)nav.push(btn('➡️ التالي','nw:1:mp:'+nonce+':'+
   session.version+':'+(session.page+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('✖ إلغاء الاختيار','nw:1:mx:'+nonce+':'+session.version)]);
  rows.push([btn('↩️ إدارة المتابعات','nw:1:f:'+session.networkId+':0')]);
  return ui('<b>👥 اختيار مجموعات من صفحات متعددة</b>\n'+
   'الشبكة: '+escape(this.find(s,session.networkId)!.name)+
   '\nالمختارة: '+session.selected.length+' من '+SIZE+
   ' · صفحة '+(session.page+1)+'/'+pages+'\n'+
   (capHit?'⚠️ وصلت إلى الحد الأقصى (8 مجموعات). ألغِ اختيارًا للمتابعة.\n':'')+
   'تبقى الاختيارات محفوظة عند التنقل بين الصفحات. لن تتغير سياسات المجموعات أو عقوبات Telegram.',
   rows);
 }
 private async beginMulti(actor:string,networkId:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),n=this.find(s,networkId);
   if(!this.auth(s,actor,now)||!n||networkEmergencyStopped(s,networkId)||
    !this.bulkActive(s,networkId).length)return null;
   const ref='b_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(x=>x.ref===ref))return null;
   // Starting a fresh wizard invalidates older unfinished selections of
   // this owner; other owners and all confirmation receipts are untouched.
   for(const x of s.callbacks)if(x.actorId===actor&&x.chatId==='private'&&
    x.action.startsWith(PREFIX+'multi-select:')&&!x.used&&!x.revoked)
    x.revoked=true;
   s.callbacks.push({ref,action:PREFIX+'multi-select:'+JSON.stringify([
    networkId,this.bulkProof(s,networkId),[],0,0]),actorId:actor,chatId:'private',
    policyVersion:0,oneShot:false,used:false,revoked:false,
    expiresAt:now+MULTI_TTL});
   return this.multiPage(s,actor,now,ref.slice(2));
  });
 }
 private async actMulti(actor:string,nonce:string,revision:number,
  action:'TOGGLE'|'MOVE'|'PREVIEW'|'CANCEL',arg?:number):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),session=this.readMultiSession(s,actor,now,nonce);
   if(!session||session.version!==revision)return null;
   if(action==='CANCEL'){
    session.record.revoked=true;
    return ui('<b>✖ أُلغي اختيار مجموعات الشبكة</b>\nلم تتغير المتابعات أو السياسات.',[
     [btn('⏸️ إدارة المتابعات','nw:1:f:'+session.networkId+':0')]]);
   }
   const active=this.bulkActive(s,session.networkId);
   const pages=Math.ceil(active.length/SIZE),pageRows=active.slice(
    session.page*SIZE,(session.page+1)*SIZE);
   if(action==='MOVE'){
    if(arg===undefined||!Number.isSafeInteger(arg)||arg<0||arg>=pages||
     Math.abs(arg-session.page)!==1||session.version>=999)return null;
    session.page=arg;
   }else if(action==='TOGGLE'){
    if(arg===undefined||!Number.isSafeInteger(arg)||arg<0||arg>=pageRows.length||
     session.version>=999)return null;
    const target=pageRows[arg]!.id;
    if(session.selected.includes(target)){
     session.selected=session.selected.filter(id=>id!==target);
    }else{
     if(session.selected.length===SIZE)
      return this.multiPage(s,actor,now,nonce,revision,true);
     session.selected.push(target);
    }
   }else if(action==='PREVIEW'){
    if(!session.selected.length)return null;
    const sorted=active.filter(x=>session.selected.includes(x.id));
    if(sorted.length!==session.selected.length)return null;
    const ids=sorted.map(x=>x.id),n=this.find(s,session.networkId)!;
    const ref='c_'+randomBytes(18).toString('base64url');
    if(s.callbacks.some(x=>x.ref===ref))return null;
    s.callbacks.push({ref,action:PREFIX+'policy-bulk-stop:'+JSON.stringify([
     n.id,n.revision,999,ids,this.bulkProof(s,n.id)]),
     actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,
     revoked:false,expiresAt:now+TTL});
    session.record.revoked=true;
    return ui('<b>🔎 معاينة إيقاف متابعات مجموعات متعددة الصفحات</b>\n'+
     'الشبكة: '+escape(n.name)+'\nالمجموعات المختارة: '+sorted.length+'\n'+
     sorted.map(x=>'• <code>'+x.targetChatId+'</code>').join('\n')+
     '\nسيُوقف التوريث المحلي للمجموعات المدرجة فقط. لن تُحذف سياسة ولن تُرسل عقوبة Telegram. التأكيد صالح لدقيقتين.',[
     [btn('✅ تأكيد إيقاف المتابعات المحددة','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]
    ]);
   }else return null;
   session.version++;
   session.record.action=PREFIX+'multi-select:'+JSON.stringify([
    session.networkId,this.bulkProof(s,session.networkId),
    session.selected,session.version,session.page]);
   return this.multiPage(s,actor,now,nonce,session.version);
  });
 }
 private followPage(s:BotState,networkId:string,p:number):OwnerInlineScreen|null{
  const n=this.find(s,networkId);if(!n||!Number.isSafeInteger(p)||p<0||p>999)return null;
  const entries=(s.networkInheritance??[]).filter(x=>x.kind==='POLICY'&&x.networkId===networkId)
   .sort((a,b)=>a.id.localeCompare(b.id));
  const pages=Math.max(1,Math.ceil(entries.length/SIZE));if(p>=pages)return null;
  const rows=entries.slice(p*SIZE,(p+1)*SIZE).map(x=>[
   btn((x.status==='ACTIVE'?'⏸️ إيقاف متابعة ':'🔒 متوقفة: ')+x.targetChatId,
    x.status==='ACTIVE'?'nw:1:j:'+x.id:'nw:1:f:'+networkId+':'+p)]);
  if(p>0)rows.push([btn('⬅️ السابق','nw:1:f:'+networkId+':'+(p-1))]);
  if(p+1<pages)rows.push([btn('➡️ التالي','nw:1:f:'+networkId+':'+(p+1))]);
  if(entries.some(x=>x.status==='ACTIVE')&&!networkEmergencyStopped(s,networkId))
   rows.push([btn('👥 إيقاف مجموعات من صفحات متعددة','nw:1:ms:'+networkId)]);
  rows.push([btn('📑 إضافة متابعة جديدة','nw:1:y:'+networkId+':0')]);
  rows.push([btn('↩️ بطاقة الشبكة','nw:1:d:'+networkId)]);
  return ui('<b>📑 المتابعة المحلية لسياسات الشبكة</b>\n'+
   'الشبكة: '+escape(n.name)+' · الارتباطات: '+entries.length+
   ' · صفحة '+(p+1)+'/'+pages+'\n'+
   'الإيقاف يمنع النقل اللاحق فقط ولا يحذف سياسة المجموعة ولا يغيّر Telegram.',rows);
 }
 private async previewFollowStop(actor:string,id:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),rows=(s.networkInheritance??[]).filter(x=>x.id===id),link=rows[0];
   if(!this.auth(s,actor,now)||rows.length!==1||!link||link.kind!=='POLICY'||
      link.status!=='ACTIVE')return null;
   const n=this.find(s,link.networkId);if(!n)return null;
   const proof=this.followStopProof(s,n,id),ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(x=>x.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+'policy-stop:'+JSON.stringify([id,proof]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,
    revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة إيقاف المتابعة</b>\n'+
    'الشبكة: '+escape(n.name)+'\nالمجموعة: <code>'+link.targetChatId+'</code>'+
    '\nسيوقف البوت متابعة هذا الهدف وحده ولن يحذف سياسته المحلية.'+
    '\nالتأكيد ينتهي بعد دقيقتين ويبطل إذا تغيرت الشبكة أو حالة الاعتماد.',
    [[btn('✅ تأكيد إيقاف المتابعة','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }
 private networkCard(s:BotState,actor:string,now:number,id:string):OwnerInlineScreen|null{
  const n=this.find(s,id);if(!n)return null;
  const current=approved(s,this.policy,actor,now);
  const active=n.members.filter(m=>current.some(c=>c.id===m.chatId&&c.version===m.version)).length;
  const stale=n.members.length-active;
  return ui('<b>🌐 '+escape(n.name)+'</b>\n'+
   'رقم السجل: <code>'+n.id+'</code> · الإصدار: '+n.revision+'\n'+
   'مجموعات فعالة: '+active+' · ارتباطات تحتاج مراجعة: '+stale+'\n'+
   'المجموعات الفعالة هي المعتمدة بنفس إصدار ارتباطها فقط؛ لا تُنقل إليها حقوق البوت.',
   [[btn('👥 إدارة المجموعات','nw:1:g:'+n.id+':0')],
    [btn('📑 سياسات الشبكة المشتركة','nw:1:y:'+n.id+':0')],
    [btn('⏸️ إدارة المتابعة','nw:1:f:'+n.id+':0')],
    [btn('🚨 طوارئ الشبكة','nw:1:eh:'+n.id)],
    [btn('🛡️ بلاغات الشبكة المركزية','nw:1:w:'+n.id+':0')],
    ...(stale>0?[[btn('🧹 مراجعة الارتباطات القديمة','nw:1:s:'+n.id+':0')]]:[]),
    [btn('✏️ إعادة تسمية الشبكة','nw:1:e:'+n.id)],
    ...(n.members.length===0?[[btn('🗑️ حذف الشبكة','nw:1:x:'+n.id)]]:[]),
    [btn('📋 الشبكات','nw:1:p:0'),btn('🏠 لوحة المالك','mi:1:h')]]);
 }
 private members(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const n=this.find(s,id);if(!n)return null;
  const all=approved(s,this.policy,actor,now),pages=Math.max(1,Math.ceil(all.length/SIZE));
  if(p>=pages)return null;
  const rows=all.slice(p*SIZE,(p+1)*SIZE).map(c=>[btn(
   (n.members.some(m=>m.chatId===c.id&&m.version===c.version)?'✅ مرتبطة: ':'➕ اربط: ')+c.id,
   'nw:1:t:'+n.id+':'+n.revision+':'+c.id+':'+c.version+':'+p)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:g:'+n.id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:g:'+n.id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ الشبكة','nw:1:d:'+n.id),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>👥 ربط مجموعات شبكة '+escape(n.name)+'</b>\n'+
   'المجموعات المؤهلة: '+all.length+' · صفحة '+(p+1)+' من '+pages+'\n'+
   'اختر المجموعة للمعاينة قبل الإضافة أو الفصل.\n'+
   'لا يتيح الربط أي مشاركة آلية للمحتوى أو صلاحيات إدارة.',
   rows);
 }

 /** Stale association cleanup never reauthorizes a group or changes Telegram rights. */
 private staleMembersPage(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const n=this.find(s,id);if(!n)return null;
  const stale=staleLinks(n,approved(s,this.policy,actor,now));
  const pages=Math.ceil(stale.length/SIZE);
  if(pages===0||p>=pages)return null;
  const rows=stale.slice(p*SIZE,(p+1)*SIZE).map(m=>[
   btn('🧹 فصل قديم: '+m.chatId+' · v'+m.version,
    'nw:1:q:'+n.id+':'+n.revision+':'+m.chatId+':'+m.version+':'+p)
  ]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:s:'+n.id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:s:'+n.id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('🧹 تنظيف الصفحة (حتى 8)','nw:1:b:'+n.id+':'+n.revision+':'+p)]);
  rows.push([btn('↩️ بطاقة الشبكة','nw:1:d:'+n.id)]);
  return ui('<b>🧹 الارتباطات القديمة — '+escape(n.name)+'</b>\n'+
   'عدد الارتباطات التي تحتاج مراجعة: '+stale.length+
   ' · صفحة '+(p+1)+' من '+pages+'\n'+
   'كل ارتباط يخص اعتمادًا سابقًا للمجموعة. فصله يحذف المرجع المحلي فقط، ولا يؤثر على Telegram.',
   rows);
 }
 private async previewStale(actor:string,id:string,revision:number,groupId:string,
  memberVersion:number,p:number):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();if(!this.auth(s,actor,now))return null;
   const n=this.find(s,id);if(!n||n.revision!==revision||
    n.revision>=9_999_999_999)return null;
   const current=approved(s,this.policy,actor,now),stale=staleLinks(n,current),
    index=stale.findIndex(m=>m.chatId===groupId&&m.version===memberVersion);
   if(index<0||Math.floor(index/SIZE)!==p)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+'clean:'+JSON.stringify([
    id,revision,groupId,memberVersion,p,groupProof(s,n,current)]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,
    revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة فصل ارتباط قديم</b>\n'+
    'الشبكة: '+escape(n.name)+'\n'+
    'المجموعة: <code>'+escape(groupId)+'</code> · إصدار الارتباط: '+memberVersion+'\n'+
    'لن تُسحب موافقة المجموعة الحالية أو أي صلاحية Telegram. سيتوقف التأكيد إذا تغيرت الحالة.',
    [[btn('✅ تأكيد الفصل','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }

 /** Preview at most eight stale links; no Telegram rights, sends, or policy updates.
  * The signed server-side receipt captures exact page membership and approval state. */
 private async previewBatch(actor:string,id:string,revision:number,p:number):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))return null;
   const n=this.find(s,id);
   if(!n||n.revision!==revision||n.revision>=9_999_999_999)return null;
   const current=approved(s,this.policy,actor,now);
   const selection=staleLinks(n,current).slice(p*SIZE,(p+1)*SIZE);
   if(selection.length===0||selection.length>SIZE)return null;
   const captured=selection.map(m=>[m.chatId,m.version] as [string,number]);
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,
    action:PREFIX+'clean-batch:'+JSON.stringify([id,revision,p,captured,groupProof(s,n,current)]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,
    revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة تنظيف جماعي للارتباطات القديمة</b>\n'+
    'الشبكة: '+escape(n.name)+' · الإصدار: '+n.revision+'\n'+
    'النطاق: '+selection.length+(selection.length===1?' ارتباط':' ارتباطات')+'\n'+
    selection.map(m=>'• <code>'+escape(m.chatId)+'</code> · v'+m.version).join('\n')+'\n'+
    'التنظيف محلي فقط. لا يتغير اعتماد المجموعات أو سياسات الحماية أو Telegram.\n'+
    'إذا تغيرت أي عضوية أو موافقة أو إعداد، يُرفض التنظيف بالكامل.',
    [[btn('✅ تأكيد التنظيف','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }

 /** Start a scoped rename prompt without allowing older name-input intents
  * to remain active. The source network is rechecked at text preview. */
 private async startRename(actor:string,id:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),n=this.find(s,id);
   if(!this.auth(s,actor,now)||!n||n.revision>=9_999_999_999)return null;
   for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(PREFIX+'input:')&&
    !c.used&&!c.revoked)c.revoked=true;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+'input:rename:'+id+':'+n.revision,actorId:actor,
    chatId:'private',policyVersion:0,expiresAt:now+INPUT_TTL,
    oneShot:true,used:false,revoked:false});
   return ui('<b>✏️ الاسم الجديد للشبكة</b>\n'+
    'الاسم الحالي: '+escape(n.name)+'\n'+
    'أرسل اسمًا مختلفًا من 2 إلى 48 حرفًا. الحفظ يتطلب معاينة وتأكيدًا.\n'+
    'لن تُعدل عضوية الشبكة ولا صلاحيات Telegram.',
    [[btn('↩️ إلغاء إعادة التسمية','nw:1:d:'+id)]]);
  });
 }
 /** Only empty network folders can be deleted; all group associations must
  * first be removed explicitly by the owner. */
 private async previewDelete(actor:string,id:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),n=this.find(s,id);
   if(!this.auth(s,actor,now)||!n||n.members.length!==0)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+'delete:'+JSON.stringify([id,n.revision,editProof(s,n)]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,
    used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🗑️ معاينة حذف الشبكة المحلية</b>\n'+
    'الشبكة: '+escape(n.name)+'\n'+
    'العضوية: 0 مجموعات. لن تُحذف المجموعات أو إعداداتها.\n'+
    'يرفض الحذف إذا تغيرت الشبكة. التأكيد لمرة واحدة خلال دقيقتين.',
    [[btn('✅ تأكيد الحذف','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }

 private async start(actor:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now)||(s.groupNetworks??[]).length>=32)return null;
   for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(PREFIX+'input:')&&
    !c.used&&!c.revoked)c.revoked=true;
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PREFIX+'input:',actorId:actor,chatId:'private',
    policyVersion:0,expiresAt:now+INPUT_TTL,oneShot:true,used:false,revoked:false});
   return ui('<b>➕ اسم الشبكة الجديدة</b>\n'+
    'أرسل اسمًا عربيًا أو إنجليزيًا من 2 إلى 48 حرفًا (حروف وأرقام ومسافات وشرطة).\n'+
    'ستظهر معاينة قبل الحفظ. تنتهي خطوة الإدخال بعد عشر دقائق.\n'+
    'لا تُرسل معلومات طلاب أو أسرارًا أو رموز Telegram.',
    [[btn('↩️ إلغاء والعودة','nw:1:h')]]);
  });
 }
 /** Accept the next owner-private text only when a unique fresh input intent
  * exists. A failed name is never stored as a network record. */
 async previewName(actor:string,name:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor))return null;
  const watch=await new OwnerNetworkWatchEditor(this.store,this.policy,this.clock).previewInput(actor,name);
  if(watch)return watch;
  const snapshot=await this.store.snapshot();
  if(!snapshot.callbacks.some(c=>c.actorId===actor&&c.action.startsWith(PREFIX+'input:')&&
   !c.used&&!c.revoked))return null;
  if(!validNetworkName(name))throw Error('NETWORK_INVALID_NAME');
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))throw Error('NETWORK_DISABLED');
   const pend=s.callbacks.filter(c=>c.actorId===actor&&c.action.startsWith(PREFIX+'input:')&&
    !c.used&&!c.revoked),intent=pend[0];
   if(pend.length!==1||!intent||intent.chatId!=='private'||intent.policyVersion!==0||
    intent.oneShot!==true||!Number.isSafeInteger(intent.expiresAt)||
    intent.expiresAt<=now||intent.expiresAt>now+INPUT_TTL)throw Error('NETWORK_INPUT_EXPIRED');
   if(matchesName(s.groupNetworks??[],name))throw Error('NETWORK_DUPLICATE_OR_LIMIT');
   const isRename=intent.action.startsWith(PREFIX+'input:rename:');
   const scope=isRename?new RegExp('^'+PREFIX+'input:rename:([a-f0-9]{12}):([1-9][0-9]{0,9})$','u')
    .exec(intent.action):null;
   const targetId=scope?.[1]??'';
   const expectedVersion=scope?Number(scope[2]):0;
   const target=isRename?this.find(s,targetId):null;
   if(isRename&&(!scope||!target||!Number.isSafeInteger(expectedVersion)||
    target.revision!==expectedVersion||target.name===name||
    target.revision>=9_999_999_999))throw Error('NETWORK_RENAME_STALE');
   if(!isRename&&(intent.action!==PREFIX+'input:'||(s.groupNetworks??[]).length>=32))
    throw Error('NETWORK_INPUT_INVALID');
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:isRename?
    PREFIX+'rename:'+JSON.stringify([targetId,name,target!.revision,editProof(s,target!)]):
    PREFIX+'create:'+JSON.stringify([name,namesProof(s)]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,
    expiresAt:now+TTL});
   intent.used=true;
   return ui('<b>🔎 '+(isRename?'معاينة إعادة تسمية شبكة':'معاينة إنشاء شبكة')+'</b>\n'+
    'الاسم: <b>'+escape(name)+'</b>\n'+
    (isRename?'اسم الشبكة الحالي: '+escape(target!.name)+'، والارتباطات ستبقى كما هي.\n':
    'لا توجد مجموعات مرتبطة بعد، وستضيفها لاحقًا بعد اعتمادها.\n')+
    'الحفظ في قاعدة البيانات المحلية فقط، وليس تغيير شبكة أو اتحاد داخل Telegram.',
    [[btn(isRename?'✅ تأكيد إعادة التسمية':'✅ تأكيد إنشاء الشبكة','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }
 private async togglePreview(actor:string,id:string,revision:number,groupId:string,
  groupVersion:number,p:number):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();if(!this.auth(s,actor,now))return null;
   const n=this.find(s,id),all=approved(s,this.policy,actor,now),
    c=all.find(c=>c.id===groupId&&c.version===groupVersion);
   if(!n||n.revision!==revision||!c||Math.floor(all.indexOf(c)/SIZE)!==p)return null;
   const member=n.members.find(m=>m.chatId===groupId);
   // A stale association cannot be silently treated as a fresh grant.
   if(member&&member.version!==groupVersion)return null;
   if(!member&&n.members.length>=50)return null;
   const op=member?'REMOVE':'ADD',ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PREFIX+'toggle:'+JSON.stringify([
    id,revision,groupId,groupVersion,p,op,groupProof(s,n,all)]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,
    expiresAt:now+TTL});
   return ui('<b>🔎 معاينة '+(op==='ADD'?'ربط':'فصل')+' المجموعة</b>\n'+
    'الشبكة: '+escape(n.name)+'\nالمجموعة: <code>'+escape(groupId)+'</code>\n'+
    'سيُحدّث الربط المحلي فقط. لا تغيير في صلاحيات Telegram أو قواعد الحماية.',
    [[btn('✅ تأكيد '+(op==='ADD'?'الربط':'الفصل'),'nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }
 private async commit(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();if(!this.auth(s,actor,now))return null;
   const rows=s.callbacks.filter(c=>c.ref==='c_'+nonce),receipt=rows[0];
   if(rows.length!==1||!receipt||!receipt.action.startsWith(PREFIX)||
    receipt.action===PREFIX+'input:'||receipt.actorId!==actor||receipt.chatId!=='private'||
    receipt.policyVersion!==0||receipt.oneShot!==true||receipt.used!==false||
    receipt.revoked!==false||!Number.isSafeInteger(receipt.expiresAt)||
    receipt.expiresAt<=now||receipt.expiresAt>now+TTL)return null;
   let data:unknown;
   if(receipt.action.startsWith(PREFIX+'emergency:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'emergency:').length));}
    catch{return null;}
    if(!Array.isArray(data)||data.length!==4||
     typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
     !Number.isSafeInteger(data[1])||data[1]<0||data[1]>9_999_999_999||
     !['STOP','RESUME'].includes(String(data[2]))||
     typeof data[3]!=='string'||!/^[a-f0-9]{64}$/u.test(data[3]))return null;
    const [networkId,expectedRevision,action,proof]=data as
     [string,number,'STOP'|'RESUME',string];
    const n=this.find(s,networkId),record=(s.networkEmergencyControls??[])
     .find(x=>x.networkId===networkId);
    if(!n||(record?.revision??0)!==expectedRevision||
     this.emergencyProof(s,networkId)!==proof)return null;
    const outcome=decideNetworkEmergency(s,this.policy,actor,now,networkId,action);
    if(!outcome)return null;
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:outcome.status==='STOPPED'?'OWNER_NETWORK_EMERGENCY_STOPPED':
      'OWNER_NETWORK_EMERGENCY_RESUMED',policyVersion:n.revision,at:now});
    return ui('<b>✅ '+(outcome.status==='STOPPED'?'أُوقف توريث الشبكة':'رُفع إيقاف الشبكة')+'</b>\n'+
     'الشبكة: '+escape(n.name)+'\nالمتابعات التي توقفت: '+outcome.paused+
     '\nالقرار محفوظ في قاعدة البيانات، ويظل نافذًا بعد إعادة التشغيل. لا تغيير في عقوبات Telegram ولا إعادة تشغيل تلقائية للمتابعات.',[
      [btn('🚨 حالة الطوارئ','nw:1:eh:'+networkId)],
      [btn('↩️ بطاقة الشبكة','nw:1:d:'+networkId)]
     ]);
   }
   if(receipt.action.startsWith(PREFIX+'policy-bulk-stop:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'policy-bulk-stop:').length));}
    catch{return null;}
    if(!Array.isArray(data)||data.length!==5||
     typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
     !Number.isSafeInteger(data[1])||data[1]<1||
     !Number.isSafeInteger(data[2])||data[2]<0||data[2]>999||
     !Array.isArray(data[3])||!data[3].length||data[3].length>SIZE||
     data[3].some((x:unknown)=>typeof x!=='string'||!/^[a-f0-9]{12}$/u.test(x))||
     new Set(data[3]).size!==data[3].length||
     typeof data[4]!=='string'||!/^[a-f0-9]{64}$/u.test(data[4]))return null;
    const [networkId,networkRevision,p,ids,proof]=data as
     [string,number,number,string[],string];
    const n=this.find(s,networkId);
    if(!n||n.revision!==networkRevision||this.bulkProof(s,networkId)!==proof||
     networkEmergencyStopped(s,networkId))return null;
    const active=this.bulkActive(s,networkId),pages=Math.max(1,Math.ceil(active.length/SIZE));
    if(p>=pages&&p!==999)return null;
    const pageRows=p===999?active:active.slice(p*SIZE,(p+1)*SIZE);
    if(!ids.every(id=>pageRows.some(row=>row.id===id))||
     JSON.stringify(pageRows.filter(row=>ids.includes(row.id)).map(row=>row.id))!==
      JSON.stringify(ids))return null;
    const outcome=pauseSelectedNetworkPolicyLinks(s,this.policy,actor,now,networkId,ids);
    if(!outcome)return null;
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_SELECTED_POLICY_FOLLOWS_STOPPED',policyVersion:n.revision,at:now});
    return ui('<b>✅ أُوقفت متابعات المجموعات المحددة</b>\n'+
     'الشبكة: '+escape(n.name)+'\nالمجموعات: '+outcome.paused+'\n'+
     outcome.targetChatIds.map(id=>'• <code>'+id+'</code>').join('\n')+
     '\nلم تُحذف سياسة، ولم تُنفذ عقوبة Telegram.',[
      [btn('⏸️ بقية متابعات الشبكة','nw:1:f:'+networkId+':0')],
      [btn('🌐 بطاقة الشبكة','nw:1:d:'+networkId)]
     ]);
   }
   if(receipt.action.startsWith(PREFIX+'policy-stop:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'policy-stop:').length));}catch{return null;}
    if(!Array.isArray(data)||data.length!==2||
       typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
       typeof data[1]!=='string'||!/^[a-f0-9]{64}$/u.test(data[1]))return null;
    const [id,proof]=data as [string,string];
    const rows=(s.networkInheritance??[]).filter(x=>x.id===id),link=rows[0];
    if(rows.length!==1||!link||link.kind!=='POLICY'||link.status!=='ACTIVE')return null;
    const n=this.find(s,link.networkId);
    if(!n||this.followStopProof(s,n,id)!==proof||!pauseNetworkInheritanceByOwner(s,id))return null;
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_POLICY_FOLLOW_STOPPED',policyVersion:n.revision,at:now});
    return ui('<b>✅ أوقفت متابعة السياسة محليًا</b>\n'+
     'المجموعة: '+link.targetChatId+'\nبقية المجموعات تستمر باستقلالية.\n'+
     'لم تُحذف سياسة ولا تُنفذ عقوبة Telegram.',
     [[btn('⏸️ إدارة المتابعة','nw:1:f:'+n.id+':0')],
      [btn('🌐 بطاقة الشبكة','nw:1:d:'+n.id)]]);
   }
   if(receipt.action.startsWith(PREFIX+'policy-follow:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'policy-follow:').length));}catch{return null;}
    if(!Array.isArray(data)||data.length!==6||typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
       !Number.isSafeInteger(data[1])||data[1]<1||!validId(data[2])||
       !Number.isSafeInteger(data[3])||data[3]<1||
       !Array.isArray(data[4])||data[4].length<1||data[4].length>50||
       data[4].some((x:unknown)=>typeof x!=='string'||!validId(x))||
       new Set(data[4]).size!==data[4].length||
       typeof data[5]!=='string'||!/^[a-f0-9]{64}$/u.test(data[5]))return null;
    const [netId,revision,sourceId,sourceRevision,ids,proof]=data as
     [string,number,string,number,string[],string];
    const n=this.find(s,netId),source=(s.protectionPolicies??[]).filter(x=>x.policy.chatId===sourceId);
    if(!n||networkEmergencyStopped(s,n.id)||n.revision!==revision||source.length!==1||
       source[0]!.policy.revision!==sourceRevision||
       !this.availablePolicySources(s,actor,now,n).some(x=>x.id===sourceId)||
       this.policyWitness(s,actor,now,n,sourceId)!==proof)return null;
    const targets=this.targetPolicyCandidates(s,actor,now,n,sourceId);
    if(JSON.stringify(targets.map(t=>t.id))!==JSON.stringify(ids))return null;
    const proposal=structuredClone(s);
    for(const target of targets){
     const initial:ProtectionPolicy={chatId:target.id,revision:1,
      mode:source[0]!.policy.mode,rules:structuredClone(source[0]!.policy.rules),
      allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],
      ...(source[0]!.policy.flood?{flood:structuredClone(source[0]!.policy.flood)}:{})};
     if(!isValidProtectionPolicy(initial)||initial.mode==='ENFORCE')return null;
     proposal.protectionPolicies??=[];
     proposal.protectionPolicies.push({policy:initial,chatPolicyVersion:target.version,
      updatedBy:actor,updatedAt:now});
     const link=prepareNetworkInheritance(proposal,this.policy,actor,now,'POLICY',n,
      sourceId,target.id,sourceRevision,initial);
     if(!link)return null;
     proposal.networkInheritance??=[];proposal.networkInheritance.push(link);
    }
    if(!proposal.protectionPolicies||!proposal.networkInheritance)return null;
    s.protectionPolicies=proposal.protectionPolicies;
    s.networkInheritance=proposal.networkInheritance;
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_POLICY_FOLLOW_ENABLED',policyVersion:n.revision,at:now});
    return ui('<b>✅ فُعّلت متابعة سياسة الشبكة محليًا</b>\n'+
     'المصدر: '+sourceId+'\nالمستهدفات: '+targets.length+
     '\nأي تعديل محلي بالمستهدف يوقف المتابعة دون تغيير Telegram.',
     [[btn('📑 سياسات الشبكة','nw:1:y:'+n.id+':0')],
      [btn('🌐 بطاقة الشبكة','nw:1:d:'+n.id)]]);
   }
   if(receipt.action.startsWith(PREFIX+'create:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'create:').length));}catch{return null;}
    if(!Array.isArray(data)||data.length!==2||!validNetworkName(data[0])||
     typeof data[1]!=='string'||!(/^[a-f0-9]{64}$/u).test(data[1])||
     data[1]!==namesProof(s)||(s.groupNetworks??[]).length>=32||
     matchesName(s.groupNetworks??[],data[0]))return null;
    const id=randomBytes(6).toString('hex');
    if((s.groupNetworks??[]).some(n=>n.id===id))return null;
    s.groupNetworks??=[];
    s.groupNetworks.push({id,name:data[0],revision:1,createdBy:actor,updatedAt:now,members:[]});
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_CREATED',policyVersion:1,at:now});
    return ui('<b>✅ حُفظت الشبكة المحلية</b>\nالاسم: '+escape(data[0])+
     '\nيمكن الآن ربط المجموعات المعتمدة بها.',
     [[btn('👥 ربط المجموعات','nw:1:g:'+id+':0')],
      [btn('🌐 قائمة الشبكات','nw:1:p:0')]]);
   }

   if(receipt.action.startsWith(PREFIX+'rename:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'rename:').length));}catch{return null;}
    if(!Array.isArray(data)||data.length!==4||
     typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
     !validNetworkName(data[1])||!Number.isSafeInteger(data[2])||
     data[2]<1||data[2]>=9_999_999_999||
     typeof data[3]!=='string'||!/^[a-f0-9]{64}$/u.test(data[3]))return null;
    const n=this.find(s,data[0]);
    if(!n||n.revision!==data[2]||n.name===data[1]||
     matchesName((s.groupNetworks??[]).filter(other=>other.id!==n.id),data[1])||
     editProof(s,n)!==data[3])return null;
    n.name=data[1];n.revision++;n.updatedAt=now;receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_RENAMED',policyVersion:n.revision,at:now});
    return ui('<b>✅ أُعيدت تسمية الشبكة محليًا</b>\n'+
     'الاسم الجديد: '+escape(n.name)+'\nلم تتغير مجموعاتها ولا صلاحيات Telegram.',
     [[btn('🌐 بطاقة الشبكة','nw:1:d:'+n.id),
       btn('📋 قائمة الشبكات','nw:1:p:0')]]);
   }
   if(receipt.action.startsWith(PREFIX+'delete:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'delete:').length));}catch{return null;}
    if(!Array.isArray(data)||data.length!==3||
     typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
     !Number.isSafeInteger(data[1])||data[1]<1||
     typeof data[2]!=='string'||!/^[a-f0-9]{64}$/u.test(data[2]))return null;
    const n=this.find(s,data[0]);
    if(!n||n.revision!==data[1]||n.members.length!==0||
     editProof(s,n)!==data[2]||
     (s.networkInheritance??[]).some(link=>link.networkId===n.id)||
     (s.networkWatchCases??[]).some(row=>row.networkId===n.id)||
     (s.networkSanctionReviews??[]).some(row=>row.networkId===n.id))return null;
    s.groupNetworks=s.groupNetworks!.filter(row=>row.id!==n.id);
    if(s.networkEmergencyControls)s.networkEmergencyControls=
     s.networkEmergencyControls.filter(row=>row.networkId!==n.id);
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_DELETED',policyVersion:n.revision,at:now});
    return ui('<b>✅ حُذفت الشبكة المحلية الفارغة</b>\n'+
     'الشبكة المحذوفة: '+escape(n.name)+'\n'+
     'لم تُحذف أي مجموعة أو تُنفّذ أوامر Telegram.',
     [[btn('📋 قائمة الشبكات','nw:1:p:0'),
       btn('🏠 لوحة المالك','mi:1:h')]]);
   }
   if(receipt.action.startsWith(PREFIX+'clean-batch:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'clean-batch:').length));}
    catch{return null;}
    if(!Array.isArray(data)||data.length!==5||
     typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
     !Number.isSafeInteger(data[1])||data[1]<1||data[1]>=9_999_999_999||
     !Number.isSafeInteger(data[2])||data[2]<0||data[2]>999||
     !Array.isArray(data[3])||data[3].length===0||data[3].length>SIZE||
     data[3].some((row:unknown)=>!Array.isArray(row)||row.length!==2||
      typeof row[0]!=='string'||!validId(row[0])||
      !Number.isSafeInteger(row[1])||row[1]<1||row[1]>9_999_999_999)||
     new Set(data[3].map((row:[string,number])=>row[0])).size!==data[3].length||
     typeof data[4]!=='string'||!/^[a-f0-9]{64}$/u.test(data[4]))return null;
    const [id,version,p,captured,digest]=data as
     [string,number,number,[string,number][],string];
    const n=this.find(s,id);
    if(!n||n.revision!==version)return null;
    const current=approved(s,this.policy,actor,now);
    const selected=staleLinks(n,current).slice(p*SIZE,(p+1)*SIZE)
     .map(m=>[m.chatId,m.version] as [string,number]);
    if(selected.length===0||JSON.stringify(captured)!==JSON.stringify(selected)||
     groupProof(s,n,current)!==digest)return null;
    const ids=new Set(captured.map(row=>row[0]));
    n.members=n.members.filter(m=>!ids.has(m.chatId));
    n.revision++;n.updatedAt=now;receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_STALE_MEMBERS_PRUNED',policyVersion:n.revision,at:now});
    return ui('<b>✅ اكتمل التنظيف الجماعي المحلي</b>\n'+
     'الشبكة: '+escape(n.name)+'\n'+
     'الارتباطات القديمة المفصولة: '+captured.length+'\n'+
     'لم يتغير اعتماد المجموعات أو صلاحيات Telegram.',
     [[btn('🌐 بطاقة الشبكة','nw:1:d:'+id)],
      ...(staleLinks(n,current).length?[[btn('🧹 بقية الارتباطات القديمة','nw:1:s:'+id+':0')]]:[])]);
   }
   if(receipt.action.startsWith(PREFIX+'clean:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'clean:').length));}catch{return null;}
    if(!Array.isArray(data)||data.length!==6||
     typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
     !Number.isSafeInteger(data[1])||data[1]<1||data[1]>=9_999_999_999||
     typeof data[2]!=='string'||!validId(data[2])||
     !Number.isSafeInteger(data[3])||data[3]<1||data[3]>9_999_999_999||
     !Number.isSafeInteger(data[4])||data[4]<0||data[4]>999||
     typeof data[5]!=='string'||!/^[a-f0-9]{64}$/u.test(data[5]))return null;
    const [id,version,groupId,memberVersion,p,digest]=data as
     [string,number,string,number,number,string];
    const n=this.find(s,id);
    if(!n||n.revision!==version)return null;
    const current=approved(s,this.policy,actor,now),stale=staleLinks(n,current),
     index=stale.findIndex(m=>m.chatId===groupId&&m.version===memberVersion);
    if(index<0||Math.floor(index/SIZE)!==p||
     groupProof(s,n,current)!==digest)return null;
    n.members=n.members.filter(m=>m.chatId!==groupId);
    n.revision++;n.updatedAt=now;receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_STALE_MEMBER_REMOVED',policyVersion:n.revision,at:now});
    return ui('<b>✅ فُصل الارتباط القديم محليًا</b>\n'+
     'الشبكة: '+escape(n.name)+'\nالمجموعة: <code>'+escape(groupId)+'</code>\n'+
     'بقي اعتماد Telegram وإعدادات المجموعة دون تغيير.',
     [[btn('🌐 بطاقة الشبكة','nw:1:d:'+id)],
      ...(staleLinks(n,current).length?[[btn('🧹 بقية الارتباطات القديمة','nw:1:s:'+id+':0')]]:[])]);
   }
   if(!receipt.action.startsWith(PREFIX+'toggle:'))return null;
   try{data=JSON.parse(receipt.action.slice((PREFIX+'toggle:').length));}catch{return null;}
   if(!Array.isArray(data)||data.length!==7||
    typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
    !Number.isSafeInteger(data[1])||data[1]<1||
    typeof data[2]!=='string'||!validId(data[2])||
    !Number.isSafeInteger(data[3])||data[3]<1||
    !Number.isSafeInteger(data[4])||data[4]<0||data[4]>999||
    !['ADD','REMOVE'].includes(data[5])||
    typeof data[6]!=='string'||!/^[a-f0-9]{64}$/u.test(data[6]))return null;
   const [id,revision,groupId,groupVersion,p,operation,digest]=data as [
    string,number,string,number,number,'ADD'|'REMOVE',string];
   const n=this.find(s,id),all=approved(s,this.policy,actor,now),
    c=all.find(c=>c.id===groupId&&c.version===groupVersion);
   if(!n||n.revision!==revision||!c||Math.floor(all.indexOf(c)/SIZE)!==p||
    groupProof(s,n,all)!==digest||n.revision>=9_999_999_999)return null;
   const existing=n.members.find(m=>m.chatId===groupId);
   if(operation==='ADD'){
    if(existing||n.members.length>=50)return null;
    n.members.push({chatId:groupId,version:groupVersion});
   }else{
    if(!existing||existing.version!==groupVersion)return null;
    n.members=n.members.filter(m=>m.chatId!==groupId);
   }
   n.revision++;n.updatedAt=now;receipt.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
    reason:operation==='ADD'?'OWNER_NETWORK_MEMBER_ADDED':'OWNER_NETWORK_MEMBER_REMOVED',
    policyVersion:n.revision,at:now});
   return ui('<b>✅ '+(operation==='ADD'?'رُبطت':'فُصلت')+' المجموعة محليًا</b>\n'+
    'الشبكة: '+escape(n.name)+'\nالمجموعة: <code>'+escape(groupId)+'</code>\n'+
    'لم تتغير أي صلاحيات أو عقوبات في Telegram.',
    [[btn('🌐 بطاقة الشبكة','nw:1:d:'+id),btn('👥 إدارة الربط','nw:1:g:'+id+':'+p)]]);
  });
 }
 private async revoke(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();if(!this.auth(s,actor,now))return null;
   const rows=s.callbacks.filter(c=>c.ref==='c_'+nonce),c=rows[0];
   if(rows.length!==1||!c||!c.action.startsWith(PREFIX)||c.action===PREFIX+'input:'||
    c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||
    c.oneShot!==true||c.used!==false||c.revoked!==false||
    !Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   c.revoked=true;
   s.audit.push({actorId:actor,updateKey:'owner-network:cancel:'+nonce,decision:'NOOP',
    reason:'OWNER_NETWORK_PREVIEW_CANCELLED',policyVersion:0,at:now});
   return ui('<b>✖ أُلغيت معاينة الشبكة</b>\nأُبطل التأكيد في قاعدة البيانات دون تعديل الشبكات.',
    [[btn('🌐 الشبكات والاتحادات','nw:1:h')]]);
  });
 }
 async cancelInput(actor:string):Promise<void>{
  if(!this.policy.isOwner(actor))return;
  await new OwnerNetworkWatchEditor(this.store,this.policy,this.clock).cancelInput(actor);
  const snapshot=await this.store.snapshot();
  if(!snapshot.callbacks.some(c=>c.actorId===actor&&c.action.startsWith(PREFIX+'input:')&&
   !c.revoked&&!c.used))return;
  await this.store.transaction(s=>{
   for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(PREFIX+'input:')&&
    !c.revoked&&!c.used)c.revoked=true;
  });
 }

 /** Local audit history is never reconstructed from an audit label alone.
  * An unambiguous committed audit and a one-shot consumed callback receipt
  * with a matching operation and well-formed payload must both be present. */
 private historyEntries(s:BotState,actor:string,now:number):{
  nonce:string;reason:string;at:number;description:string
 }[]{
  const reasons=new Set(['OWNER_NETWORK_CREATED','OWNER_NETWORK_RENAMED',
   'OWNER_NETWORK_DELETED','OWNER_NETWORK_MEMBER_ADDED','OWNER_NETWORK_MEMBER_REMOVED',
   'OWNER_NETWORK_STALE_MEMBER_REMOVED','OWNER_NETWORK_STALE_MEMBERS_PRUNED',
   'OWNER_NETWORK_SELECTED_POLICY_FOLLOWS_STOPPED']);
  const entries:{nonce:string;reason:string;at:number;description:string}[]=[];
  for(const a of s.audit){
   if(!reasons.has(a.reason))continue;
   const matched=/^owner-network:([A-Za-z0-9_-]{24})$/u.exec(a.updateKey);
   if(!matched||a.actorId!==actor||a.decision!=='ALLOW'||
    !Number.isSafeInteger(a.at)||a.at<0||a.at>now||
    s.audit.filter(x=>x.updateKey===a.updateKey).length!==1)continue;
   const receipts=s.callbacks.filter(x=>x.ref==='c_'+matched[1]);
   const c=receipts[0];
   if(receipts.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||
    c.policyVersion!==0||c.oneShot!==true||c.used!==true||
    c.revoked!==false||!Number.isSafeInteger(c.expiresAt)||
    c.expiresAt<=a.at||c.expiresAt>a.at+TTL)continue;
   let prefix:string,values:unknown;
   if(c.action.startsWith(PREFIX+'create:'))prefix=PREFIX+'create:';
   else if(c.action.startsWith(PREFIX+'rename:'))prefix=PREFIX+'rename:';
   else if(c.action.startsWith(PREFIX+'delete:'))prefix=PREFIX+'delete:';
   else if(c.action.startsWith(PREFIX+'toggle:'))prefix=PREFIX+'toggle:';
   else if(c.action.startsWith(PREFIX+'clean:'))prefix=PREFIX+'clean:';
   else if(c.action.startsWith(PREFIX+'clean-batch:'))prefix=PREFIX+'clean-batch:';
   else if(c.action.startsWith(PREFIX+'policy-bulk-stop:'))prefix=PREFIX+'policy-bulk-stop:';
   else continue;
   try{values=JSON.parse(c.action.slice(prefix.length));}catch{continue;}
   if(!Array.isArray(values))continue;
   let description:string|null=null;
   if(prefix===PREFIX+'create:'&&a.reason==='OWNER_NETWORK_CREATED'&&
    a.policyVersion===1&&values.length===2&&validNetworkName(values[0])&&
    typeof values[1]==='string'&&/^[a-f0-9]{64}$/u.test(values[1])){
    description='الاسم: '+values[0];
   }else if(prefix===PREFIX+'rename:'&&a.reason==='OWNER_NETWORK_RENAMED'&&
    values.length===4&&typeof values[0]==='string'&&/^[a-f0-9]{12}$/u.test(values[0])&&
    validNetworkName(values[1])&&Number.isSafeInteger(values[2])&&
    values[2]>=1&&values[2]<9_999_999_999&&a.policyVersion===values[2]+1&&
    typeof values[3]==='string'&&/^[a-f0-9]{64}$/u.test(values[3])){
    description='الشبكة: '+values[0]+' · الاسم الجديد: '+values[1];
   }else if(prefix===PREFIX+'delete:'&&a.reason==='OWNER_NETWORK_DELETED'&&
    values.length===3&&typeof values[0]==='string'&&/^[a-f0-9]{12}$/u.test(values[0])&&
    Number.isSafeInteger(values[1])&&values[1]>=1&&
    a.policyVersion===values[1]&&typeof values[2]==='string'&&
    /^[a-f0-9]{64}$/u.test(values[2])){
    description='الشبكة المحلية المحذوفة: '+values[0];
   }else if(prefix===PREFIX+'toggle:'&&values.length===7&&
    typeof values[0]==='string'&&/^[a-f0-9]{12}$/u.test(values[0])&&
    Number.isSafeInteger(values[1])&&values[1]>=1&&
    a.policyVersion===values[1]+1&&typeof values[2]==='string'&&validId(values[2])&&
    Number.isSafeInteger(values[3])&&values[3]>=1&&
    Number.isSafeInteger(values[4])&&values[4]>=0&&values[4]<=999&&
    ['ADD','REMOVE'].includes(values[5])&&typeof values[6]==='string'&&
    /^[a-f0-9]{64}$/u.test(values[6])&&
    a.reason===(values[5]==='ADD'?'OWNER_NETWORK_MEMBER_ADDED':'OWNER_NETWORK_MEMBER_REMOVED')){
    description='الشبكة: '+values[0]+' · المجموعة: '+values[2];
   }
   if(description===null&&prefix===PREFIX+'clean:'&&
    a.reason==='OWNER_NETWORK_STALE_MEMBER_REMOVED'&&values.length===6&&
    typeof values[0]==='string'&&/^[a-f0-9]{12}$/u.test(values[0])&&
    Number.isSafeInteger(values[1])&&values[1]>=1&&
    a.policyVersion===values[1]+1&&typeof values[2]==='string'&&validId(values[2])&&
    Number.isSafeInteger(values[3])&&values[3]>=1&&
    Number.isSafeInteger(values[4])&&values[4]>=0&&values[4]<=999&&
    typeof values[5]==='string'&&/^[a-f0-9]{64}$/u.test(values[5])){
    description='الشبكة: '+values[0]+' · الارتباط القديم: '+values[2];
   }
   if(description===null&&prefix===PREFIX+'clean-batch:'&&
    a.reason==='OWNER_NETWORK_STALE_MEMBERS_PRUNED'&&values.length===5&&
    typeof values[0]==='string'&&/^[a-f0-9]{12}$/u.test(values[0])&&
    Number.isSafeInteger(values[1])&&values[1]>=1&&values[1]<9_999_999_999&&
    a.policyVersion===values[1]+1&&
    Number.isSafeInteger(values[2])&&values[2]>=0&&values[2]<=999&&
    Array.isArray(values[3])&&values[3].length>=1&&values[3].length<=SIZE&&
    values[3].every((row:unknown)=>Array.isArray(row)&&row.length===2&&
     typeof row[0]==='string'&&validId(row[0])&&
     Number.isSafeInteger(row[1])&&row[1]>=1&&row[1]<=9_999_999_999)&&
    new Set(values[3].map((row:[string,number])=>row[0])).size===values[3].length&&
    typeof values[4]==='string'&&/^[a-f0-9]{64}$/u.test(values[4])){
    description='الشبكة: '+values[0]+' · العدد: '+values[3].length+
     ' · الارتباطات القديمة: '+values[3].map((row:[string,number])=>row[0]).join('، ');
   }
   if(description===null&&prefix===PREFIX+'policy-bulk-stop:'&&
    a.reason==='OWNER_NETWORK_SELECTED_POLICY_FOLLOWS_STOPPED'&&
    values.length===5&&typeof values[0]==='string'&&/^[a-f0-9]{12}$/u.test(values[0])&&
    Number.isSafeInteger(values[1])&&values[1]>=1&&
    a.policyVersion===values[1]&&Number.isSafeInteger(values[2])&&
    values[2]>=0&&values[2]<=999&&Array.isArray(values[3])&&
    values[3].length>0&&values[3].length<=SIZE&&
    values[3].every((id:unknown)=>typeof id==='string'&&/^[a-f0-9]{12}$/u.test(id))&&
    new Set(values[3]).size===values[3].length&&
    typeof values[4]==='string'&&/^[a-f0-9]{64}$/u.test(values[4])){
    const links=(values[3] as string[]).map(id=>(s.networkInheritance??[])
     .filter(row=>row.id===id&&row.networkId===values[0]&&
      row.status==='PAUSED'&&row.pausedReason==='OWNER_PAUSED'));
    if(links.every(rows=>rows.length===1)){
     description='الشبكة: '+values[0]+' · المجموعات المتوقفة: '+
      links.length+' · المجموعات: '+links.map(rows=>rows[0]!.targetChatId).join('، ');
    }
   }
   if(description!==null)entries.push({nonce:matched[1]!,reason:a.reason,at:a.at,description});
  }
  entries.sort((a,b)=>b.at-a.at||b.nonce.localeCompare(a.nonce));
  return entries;
 }
 private history(s:BotState,actor:string,now:number,p:number):OwnerInlineScreen|null{
  if(!Number.isSafeInteger(p)||p<0||p>999)return null;
  const events=this.historyEntries(s,actor,now),
   maxPage=Math.max(1,Math.ceil(events.length/SIZE));
  if(p>=maxPage)return null;
  const rows=events.slice(p*SIZE,(p+1)*SIZE).map(e=>
   [btn('🌐 '+(e.reason==='OWNER_NETWORK_CREATED'?'إنشاء':
    e.reason==='OWNER_NETWORK_RENAMED'?'إعادة تسمية':
    e.reason==='OWNER_NETWORK_DELETED'?'حذف':
    e.reason==='OWNER_NETWORK_MEMBER_ADDED'?'ربط مجموعة':
    e.reason==='OWNER_NETWORK_STALE_MEMBER_REMOVED'?'تنظيف ارتباط قديم':
    e.reason==='OWNER_NETWORK_STALE_MEMBERS_PRUNED'?'تنظيف جماعي':
    e.reason==='OWNER_NETWORK_SELECTED_POLICY_FOLLOWS_STOPPED'?'إيقاف متابعات مختارة':'فصل مجموعة')+
    ' · '+new Date(e.at).toISOString().slice(0,16).replace('T',' '),
    'nw:1:r:v:'+e.nonce)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:r:p:'+(p-1)));
  if(p+1<maxPage)nav.push(btn('➡️ التالي','nw:1:r:p:'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ الشبكات المحلية','nw:1:h'),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>🕘 سجل تغييرات الشبكات المحلية</b>\n'+
   'العمليات الموثقة: '+(events.length===1?'عملية واحدة':events.length+' عمليات')+
   '\nصفحة '+(p+1)+' من '+maxPage+'\n'+
   (events.length?'اختر عملية لعرض تفاصيلها.':'لا توجد عمليات موثقة حاليًا.')+
   '\nالسجل للقراءة فقط، ولا يمنح أي حق Telegram.',
   rows);
 }
 private historyDetail(s:BotState,actor:string,now:number,nonce:string):OwnerInlineScreen|null{
  const entries=this.historyEntries(s,actor,now).filter(e=>e.nonce===nonce);
  if(entries.length!==1)return null;
  const entry=entries[0]!;
  return ui('<b>🕘 تفاصيل تغيير الشبكة المحلية</b>\n'+
   'النوع: '+entry.reason+'\n'+
   escape(entry.description)+'\n'+
   'الوقت (UTC): '+new Date(entry.at).toISOString().slice(0,19).replace('T',' ')+
   '\nهذا بيان محفوظ محليًا، ولا ينفذ أوامر Telegram أو يؤكد إيصالها.',
   [[btn('↩️ سجل تغييرات الشبكات','nw:1:r:p:0'),btn('🏠 لوحة المالك','mi:1:h')]]);
 }

 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validOwnerNetworkRoute(data))return null;
  const watchEditor=new OwnerNetworkWatchEditor(this.store,this.policy,this.clock);
  const sanctionEditor=new OwnerNetworkSanctionEditor(this.store,this.policy,this.clock,this.remoteRead);
  if(validOwnerNetworkSanctionRoute(data)){
   await this.cancelInput(actor);
   return sanctionEditor.handle(actor,data);
  }
  if(validOwnerNetworkWatchRoute(data)){
   await this.cancelInput(actor);
   return watchEditor.handle(actor,data);
  }
  const c=confirm.exec(data);
  if(c){
   const reviewed=await sanctionEditor.handleReceipt(actor,data);
   if(reviewed)return reviewed;
   const result=await watchEditor.handle(actor,data);
   return result??this.commit(actor,c[1]!);
  }
  const k=cancel.exec(data);
  if(k){
   const reviewed=await sanctionEditor.handleReceipt(actor,data);
   if(reviewed)return reviewed;
   const result=await watchEditor.handle(actor,data);
   return result??this.revoke(actor,k[1]!);
  }
  const state=await this.store.snapshot(),now=this.clock();
  if(!this.auth(state,actor,now))return null;
  // Navigating away from the name-entry step is an actual cancellation,
  // not merely a different screen while the pending input remains live.
  if(!begin.test(data))await this.cancelInput(actor);
  if(data==='mi:1:i:01:03'||home.test(data))
   return this.root(await this.store.snapshot());
  if(begin.test(data))return this.start(actor);
  const hp=historyPage.exec(data);if(hp)return this.history(state,actor,now,Number(hp[1]));
  const hv=historyView.exec(data);if(hv)return this.historyDetail(state,actor,now,hv[1]!);
  const e=rename.exec(data);if(e)return this.startRename(actor,e[1]!);
  const x=remove.exec(data);if(x)return this.previewDelete(actor,x[1]!);
  const l=list.exec(data);if(l)return this.networkList(state,Number(l[1]));
  const d=detail.exec(data);if(d)return this.networkCard(state,actor,now,d[1]!);
  const ps=policySources.exec(data);if(ps)return this.policySourcePage(state,actor,now,ps[1]!,Number(ps[2]));
  const pp=policyPreview.exec(data);if(pp)return this.previewPolicy(actor,pp[1]!,pp[2]!,Number(pp[3]));
  const ms=multiStart.exec(data);
  if(ms)return this.beginMulti(actor,ms[1]!);
  const mp=multiMove.exec(data);
  if(mp)return this.actMulti(actor,mp[1]!,Number(mp[2]),'MOVE',Number(mp[3]));
  const mt=multiToggle.exec(data);
  if(mt)return this.actMulti(actor,mt[1]!,Number(mt[2]),'TOGGLE',Number(mt[3]));
  const mv=multiPreview.exec(data);
  if(mv)return this.actMulti(actor,mv[1]!,Number(mv[2]),'PREVIEW');
  const mx=multiCancel.exec(data);
  if(mx)return this.actMulti(actor,mx[1]!,Number(mx[2]),'CANCEL');
  const bl=bulkList.exec(data);
  if(bl)return this.bulkPage(state,actor,now,bl[1]!,Number(bl[2]),0);
  const bt=bulkToggle.exec(data);
  if(bt){
   const mask=Number.parseInt(bt[3]!,16),i=Number(bt[4]);
   if(!Number.isInteger(i)||i<0||i>=SIZE)return null;
   // First require the old selection to match the same immutable snapshot.
   if(!this.bulkPage(state,actor,now,bt[1]!,Number(bt[2]),mask,bt[5]!))return null;
   return this.bulkPage(state,actor,now,bt[1]!,Number(bt[2]),mask^(1<<i),bt[5]!);
  }
  const bv=bulkPreview.exec(data);
  if(bv)return this.previewBulkStop(actor,bv[1]!,Number(bv[2]),
   Number.parseInt(bv[3]!,16),bv[4]!);
  const fl=followList.exec(data);if(fl)return this.followPage(state,fl[1]!,Number(fl[2]));
  const fs=followStop.exec(data);if(fs)return this.previewFollowStop(actor,fs[1]!);
  const eh=emergencyHome.exec(data);
  if(eh)return this.emergencyPage(state,actor,now,eh[1]!);
  const es=emergencyStop.exec(data);
  if(es)return this.previewEmergency(actor,es[1]!,'STOP');
  const er=emergencyResume.exec(data);
  if(er)return this.previewEmergency(actor,er[1]!,'RESUME');
  const p=pick.exec(data);if(p)return this.members(state,actor,now,p[1]!,Number(p[2]));
  const sp=stalePage.exec(data);
  if(sp)return this.staleMembersPage(state,actor,now,sp[1]!,Number(sp[2]));
  const sq=stalePick.exec(data);
  if(sq)return this.previewStale(actor,sq[1]!,Number(sq[2]),sq[3]!,
   Number(sq[4]),Number(sq[5]));
  const sb=staleBatch.exec(data);
  if(sb)return this.previewBatch(actor,sb[1]!,Number(sb[2]),Number(sb[3]));
  const t=toggle.exec(data);
  if(t)return this.togglePreview(actor,t[1]!,Number(t[2]),t[3]!,Number(t[4]),Number(t[5]));
  return null;
 }
}
