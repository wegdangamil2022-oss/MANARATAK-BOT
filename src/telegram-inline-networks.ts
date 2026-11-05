import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat} from './store.js';
import type {GroupNetwork} from './group-network-model.js';
import {validNetworkName} from './group-network-model.js';
import {prepareNetworkInheritance,pauseNetworkInheritanceByOwner} from './network-inheritance.js';
import type {NetworkInheritanceLink} from './network-inheritance-model.js';
import type {Policy} from './policy.js';
import {defaultCommunityConfig,emptyCommunityState,validCommunityConfig,
 type CommunityConfig} from './phase4-community-model.js';
import {isValidGroupProtectionRecord,isValidProtectionPolicy,
 type GroupProtectionRecord,type ProtectionPolicy} from './protection-rules.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';

/** Local network folders for approved groups. Membership is an organization
 * hint only; it NEVER issues Telegram rights, grants, moderation or delivery. */
const TTL=120_000,INPUT_TTL=600_000,PREFIX='owner-network-',SIZE=8;
const net='([a-f0-9]{12})',page='(0|[1-9][0-9]{0,2})',
 group='(-[1-9][0-9]{0,15})',revision='([1-9][0-9]{0,9})';
const home=/^nw:1:h$/u,begin=/^nw:1:n$/u;
const list=new RegExp('^nw:1:p:'+page+'$','u');
const detail=new RegExp('^nw:1:d:'+net+'$','u');
const rename=new RegExp('^nw:1:e:'+net+'$','u');
const remove=new RegExp('^nw:1:x:'+net+'$','u');
const pick=new RegExp('^nw:1:g:'+net+':'+page+'$','u');
const stalePage=new RegExp('^nw:1:s:'+net+':'+page+'$','u');
const policySources=new RegExp('^nw:1:y:'+net+':'+page+'$','u');
const excludeMask='([1-9][0-9]{0,2})';
const policyPreview=new RegExp('^nw:1:z:'+net+':'+group+':'+page+'(?::'+excludeMask+')?$','u');
const greetingSources=new RegExp('^nw:1:w:'+net+':'+page+'$','u');
const greetingPreview=new RegExp('^nw:1:v:'+net+':'+group+':'+page+'(?::'+excludeMask+')?$','u');
const inheritancePage=new RegExp('^nw:1:f:'+net+':'+page+'$','u');
const inheritanceStop=/^nw:1:j:([a-f0-9]{12})$/u;
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
/** A bit is an exclusion on a page of up to eight candidates. */
const validMask=(mask:number,length:number)=>Number.isSafeInteger(mask)&&mask>=0&&
 length>=1&&length<=SIZE&&mask<2**length;
const copyPageRoute=(kind:'z'|'v',id:string,source:string,p:number,mask:number)=>
 'nw:1:'+kind+':'+id+':'+source+':'+p+(mask?':'+mask:'');
export function validOwnerNetworkRoute(data:unknown):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return false;
 const preview=policyPreview.exec(data)??greetingPreview.exec(data);
 if(preview?.[4]!==undefined&&Number(preview[4])>255)return false;
 return data==='mi:1:i:01:03'||home.test(data)||begin.test(data)||
  [list,detail,rename,remove,pick,toggle,stalePage,stalePick,staleBatch,policySources,policyPreview,greetingSources,greetingPreview,inheritancePage,inheritanceStop,confirm,cancel,historyPage,historyView].some(re=>re.test(data));
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
  private readonly clock:()=>number=Date.now){}
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
    [btn('👋 قوالب الترحيب المشتركة','nw:1:w:'+n.id+':0')],
     [btn('🔁 المتابعة التلقائية','nw:1:f:'+n.id+':0')],
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
 /** NETWORK-002 uses the already-reviewed group protection engine. Network
  * membership is never authority; every member must still have a live local
  * approval revision, moderation scope and per-group management capability.
  * Existing target records are explicit per-group overrides (including STALE). */
 private networkPolicySources(s:BotState,actor:string,now:number,n:GroupNetwork):
  {chat:Chat;record:GroupProtectionRecord}[]{
  const current=approved(s,this.policy,actor,now);
  return n.members.flatMap(member=>{
   const chat=current.find(c=>c.id===member.chatId&&c.version===member.version);
   if(!chat||!chat.scopes.includes('moderation')||
    !this.policy.canUseChat(s,chat.id,'moderation'))return [];
   const rows=(s.protectionPolicies??[]).filter(r=>r.policy.chatId===chat.id);
   const record=rows[0];
   if(rows.length!==1||!isValidGroupProtectionRecord(record)||
    record.chatPolicyVersion!==chat.version||record.updatedAt>now||
    !['MONITOR','OFF'].includes(record.policy.mode))return [];
   return [{chat,record}];
  }).sort((a,b)=>a.chat.id.localeCompare(b.chat.id));
 }
 private networkPolicySelection(s:BotState,actor:string,now:number,
  networkId:string,sourceId:string):{
   network:GroupNetwork;source:GroupProtectionRecord;targets:Chat[];digest:string
  }|null{
  if(!this.auth(s,actor,now))return null;
  const network=this.find(s,networkId);
  if(!network)return null;
  const source=this.networkPolicySources(s,actor,now,network)
   .find(x=>x.chat.id===sourceId);
  if(!source)return null;
  const current=approved(s,this.policy,actor,now);
  const targets=network.members.flatMap(m=>{
   if(m.chatId===sourceId)return [];
   const chat=current.find(c=>c.id===m.chatId&&c.version===m.version);
   if(!chat||!chat.scopes.includes('moderation')||
    !this.policy.canUseChat(s,chat.id,'moderation')||
    (s.protectionPolicies??[]).some(row=>row.policy.chatId===chat.id))return [];
   return [chat];
  }).sort((a,b)=>a.id.localeCompare(b.id));
  // This is optimistic concurrency evidence only, not a secret bearer token.
  // All authorizations are checked again in the final store transaction.
  const digest=createHash('sha256').update(JSON.stringify([
   network,s.chats,s.protectionPolicies??[],s.privateSettingsRevision??0,
   s.privateFeatures['owner.dashboard']
  ])).digest('hex');
  return {network,source:source.record,targets,digest};
 }
 private policySourceList(s:BotState,actor:string,now:number,id:string,p:number):
  OwnerInlineScreen|null{
  const network=this.find(s,id);if(!network)return null;
  const sources=this.networkPolicySources(s,actor,now,network),
   pages=Math.max(1,Math.ceil(sources.length/SIZE));
  if(p<0||p>=pages)return null;
  const rows=sources.slice(p*SIZE,(p+1)*SIZE).map(item=>[
   btn('🛡️ مصدر '+item.chat.id+' · '+item.record.policy.mode,
    'nw:1:z:'+id+':'+item.chat.id+':0')]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:y:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:y:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ بطاقة الشبكة','nw:1:d:'+id),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>📑 سياسة شبكة '+escape(network.name)+'</b>\n'+
   'اختر المجموعة المصدر لنسخ قواعد حمايتها المحلية إلى المجموعات المرتبطة التي لا تمتلك سياسة.\n'+
   'مصادر متاحة: '+sources.length+' · صفحة '+(p+1)+' من '+pages+'\n'+
   'النسخ لا يمنح Telegram صلاحيات جديدة، ولا يشغّل ENFORCE.\n'+
   'أي سياسة وجهة موجودة تعتبر استثناء مستقلًا ولا يتم استبدالها.',rows);
 }
 /** Replacing a page preview revokes older unconsumed approvals for this
  * owner/category/network/source/page, but leaves other pages independent. */
 private revokeCopyPage(s:BotState,actor:string,kind:'policy'|'greeting',
  id:string,sourceId:string,p:number):void{
  const prefix=PREFIX+kind+':';
  for(const c of s.callbacks){
   if(c.actorId!==actor||c.used||c.revoked||!c.action.startsWith(prefix))continue;
   let data:unknown;
   try{data=JSON.parse(c.action.slice(prefix.length));}catch{continue;}
   if(Array.isArray(data)&&data.length===6&&data[0]===id&&
    data[2]===sourceId&&data[3]===p)c.revoked=true;
  }
 }
 private async previewNetworkPolicy(actor:string,id:string,sourceId:string,p:number,mask=0):
  Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   const ctx=this.networkPolicySelection(s,actor,now,id,sourceId);
   if(!ctx||p<0||p>999||p>=Math.ceil(ctx.targets.length/SIZE))return null;
   const chosen=ctx.targets.slice(p*SIZE,(p+1)*SIZE);
   if(!validMask(mask,chosen.length))return null;
   const selected=chosen.filter((_,i)=>(mask&(1<<i))===0);
   const ref='c_'+randomBytes(18).toString('base64url');
   if(selected.length&&s.callbacks.some(row=>row.ref===ref))return null;
   this.revokeCopyPage(s,actor,'policy',id,sourceId,p);
   if(selected.length)s.callbacks.push({ref,action:PREFIX+'policy:'+JSON.stringify([
    id,ctx.network.revision,sourceId,p,selected.map(c=>c.id),ctx.digest]),
    actorId:actor,chatId:'private',policyVersion:0,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   const nav:{text:string;callback_data:string}[]=[];
   if(p)nav.push(btn('⬅️ السابق','nw:1:z:'+id+':'+sourceId+':'+(p-1)));
   if((p+1)*SIZE<ctx.targets.length)nav.push(
    btn('➡️ التالي','nw:1:z:'+id+':'+sourceId+':'+(p+1)));
   return ui('<b>🔎 معاينة سياسة الشبكة المشتركة</b>\n'+
    'الشبكة: '+escape(ctx.network.name)+' · v'+ctx.network.revision+'\n'+
    'المصدر: <code>'+sourceId+'</code> · وضع '+ctx.source.policy.mode+'\n'+
    'الصفحة: '+(p+1)+' من '+Math.ceil(ctx.targets.length/SIZE)+'\n'+
    'النطاق: '+selected.length+' مجموعات فقط (الحد 8 لكل اعتماد) · مستبعدة: '+(chosen.length-selected.length)+'\n'+
    chosen.map((c,i)=>((mask&(1<<i))?'🚫 مستبعدة: ':'✅ مختارة: ')+
     '<code>'+c.id+'</code> · v'+c.version).join('\n')+'\n'+
    'القواعد: '+ctx.source.policy.rules.length+'\n'+
    'لن تُنسخ قوائم الاستثناء أو النطاقات المسموحة أو أعضاء الاستثناء من المصدر.\n'+
    'تُستثنى المجموعات ذات سياسة موجودة، حتى لو كانت متوقفة أو قديمة.\n'+
    'كل كتابة محلية داخل معاملة واحدة بعد موافقة المالك لمرة واحدة خلال دقيقتين.\n'+
    'لا عقوبات أو رسائل أو تغييرات Telegram.',
    [...(selected.length?[[btn('✅ تأكيد نسخ السياسة محليًا','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]:[]),
     ...chosen.map((c,i)=>[btn(((mask&(1<<i))?'✅ تضمين ':'🚫 استبعاد ')+c.id,
      copyPageRoute('z',id,sourceId,p,mask^(1<<i)))]),
     ...(nav.length?[nav]:[]),
     [btn('↩️ اختيار المصدر','nw:1:y:'+id+':0')]]);
  });
 }


 /** NETWORK-002 greeting templates are separate from operational policies.
  * The source and EVERY destination require current per-chat authorization.
  * An existing destination config is an unconditional local override, even if
  * greetings are disabled; it must never be silently replaced by the network. */
 private greetingSourceList(s:BotState,actor:string,now:number,n:GroupNetwork):
  {chat:Chat;config:CommunityConfig}[]{
  const current=approved(s,this.policy,actor,now);
  const configs=s.phase4Community?.configs??[];
  return n.members.flatMap(member=>{
   const chat=current.find(c=>c.id===member.chatId&&c.version===member.version);
   if(!chat||!chat.scopes.includes('navigation')||
      !this.policy.canUseChat(s,chat.id,'navigation'))return [];
   const rows=configs.filter(c=>c.chatId===chat.id);
   const config=rows[0];
   if(rows.length!==1||!validCommunityConfig(config)||
      config.version<1)return [];
   return [{chat,config}];
  }).sort((a,b)=>a.chat.id.localeCompare(b.chat.id));
 }
 private greetingSelection(s:BotState,actor:string,now:number,
  id:string,sourceId:string):{
   network:GroupNetwork;source:CommunityConfig;targets:Chat[];digest:string
  }|null{
  if(!this.auth(s,actor,now))return null;
  const network=this.find(s,id);
  if(!network)return null;
  const source=this.greetingSourceList(s,actor,now,network).find(
   x=>x.chat.id===sourceId);
  if(!source)return null;
  const current=approved(s,this.policy,actor,now);
  const configs=s.phase4Community?.configs??[];
  const targets=network.members.flatMap(m=>{
   if(m.chatId===sourceId)return [];
   const chat=current.find(c=>c.id===m.chatId&&c.version===m.version);
   if(!chat||!chat.scopes.includes('navigation')||
      !this.policy.canUseChat(s,chat.id,'navigation')||
      configs.some(c=>c.chatId===chat.id))return [];
   return [chat];
  }).sort((a,b)=>a.id.localeCompare(b.id));
  // Owner approval is the authority, not this digest. The transaction
  // reevaluates both authority and ALL inputs when consuming the receipt.
  const digest=createHash('sha256').update(JSON.stringify([
   network,s.chats,configs,s.privateSettingsRevision??0,
   s.privateFeatures['owner.dashboard']
  ])).digest('hex');
  return {network,source:source.config,targets,digest};
 }
 private greetingSourcesScreen(s:BotState,actor:string,now:number,
  id:string,p:number):OwnerInlineScreen|null{
  const network=this.find(s,id);if(!network)return null;
  const sources=this.greetingSourceList(s,actor,now,network);
  const pages=Math.max(1,Math.ceil(sources.length/SIZE));
  if(p<0||p>=pages)return null;
  const rows=sources.slice(p*SIZE,(p+1)*SIZE).map(x=>[
   btn('👋 المصدر '+x.chat.id+' · v'+x.config.version,
    'nw:1:v:'+id+':'+x.chat.id+':0')]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','nw:1:w:'+id+':'+(p-1)));
  if((p+1)*SIZE<sources.length)nav.push(btn('➡️ التالي','nw:1:w:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ بطاقة الشبكة','nw:1:d:'+id),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>👋 قوالب الترحيب والوداع للشبكة</b>\n'+
   'اختر المجموعة المصدر المعتمدة لنسخ القوالب النصية فقط إلى مجموعات الشبكة غير المضبوطة.\n'+
   'مصادر متاحة: '+sources.length+' · صفحة '+(p+1)+' من '+pages+'\n'+
   'النسخ لا يشغل الترحيب أو الوداع أو الردود أو أي إجراء Telegram.\n'+
   'لا تُنسخ الصور والأزرار والروابط والإعدادات التشغيلية أو الأسرار.',rows);
 }
 private async previewGreeting(actor:string,id:string,sourceId:string,p:number,mask=0):
  Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   const ctx=this.greetingSelection(s,actor,now,id,sourceId);
   if(!ctx||p<0||p>999||p>=Math.ceil(ctx.targets.length/SIZE))return null;
   const candidates=ctx.targets.slice(p*SIZE,(p+1)*SIZE);
   if(!validMask(mask,candidates.length))return null;
   const selected=candidates.filter((_,i)=>(mask&(1<<i))===0);
   const ref='c_'+randomBytes(18).toString('base64url');
   if(selected.length&&s.callbacks.some(c=>c.ref===ref))return null;
   this.revokeCopyPage(s,actor,'greeting',id,sourceId,p);
   if(selected.length)s.callbacks.push({ref,action:PREFIX+'greeting:'+JSON.stringify([
    id,ctx.network.revision,sourceId,p,selected.map(c=>c.id),ctx.digest]),
    actorId:actor,chatId:'private',policyVersion:0,
    expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
   const nav:{text:string;callback_data:string}[]=[];
   if(p)nav.push(btn('⬅️ السابق','nw:1:v:'+id+':'+sourceId+':'+(p-1)));
   if((p+1)*SIZE<ctx.targets.length)nav.push(
    btn('➡️ التالي','nw:1:v:'+id+':'+sourceId+':'+(p+1)));
   return ui('<b>🔎 معاينة نشر قالب الترحيب المحلي</b>\n'+
    'الشبكة: '+escape(ctx.network.name)+' · v'+ctx.network.revision+'\n'+
    'المصدر: <code>'+sourceId+'</code> · إعداد v'+ctx.source.version+'\n'+
    'النطاق: '+selected.length+' مجموعات (حد أقصى 8 لكل اعتماد) · مستبعدة: '+(candidates.length-selected.length)+'\n'+
    candidates.map((c,i)=>((mask&(1<<i))?'🚫 مستبعدة: ':'✅ مختارة: ')+
     '<code>'+c.id+'</code> · v'+c.version).join('\n')+'\n'+
    'مثال نص الترحيب: '+escape(ctx.source.welcome.text.slice(0,180))+'\n'+
    'قوالب الانضمام المخصصة: '+Object.keys(ctx.source.welcomeByJoin??{}).length+'\n'+
    'النسخ يشمل نصوص الترحيب والوداع وترجماتها وأنواع الانضمام والمغادرة فقط.\n'+
    'لن تُنسخ أي صورة أو زر أو رابط أو إعداد تشغيل أو قواعد رد، ولن يُفعل إرسال.\n'+
    'تُستثنى كل مجموعة لديها إعداد خاص ولو كان معطّلًا.\n'+
    'التأكيد لمرة واحدة خلال دقيقتين مع فحص الصلاحيات والإصدارات مجددًا.',
    [...(selected.length?[[btn('✅ تأكيد نسخ قوالب الترحيب','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]:[]),
     ...candidates.map((c,i)=>[btn(((mask&(1<<i))?'✅ تضمين ':'🚫 استبعاد ')+c.id,
      copyPageRoute('v',id,sourceId,p,mask^(1<<i)))]),
     ...(nav.length?[nav]:[]),
     [btn('↩️ اختيار المصدر','nw:1:w:'+id+':0')]]);
  });
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
     editProof(s,n)!==data[2])return null;
    s.groupNetworks=s.groupNetworks!.filter(row=>row.id!==n.id);
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_DELETED',policyVersion:n.revision,at:now});
    return ui('<b>✅ حُذفت الشبكة المحلية الفارغة</b>\n'+
     'الشبكة المحذوفة: '+escape(n.name)+'\n'+
     'لم تُحذف أي مجموعة أو تُنفّذ أوامر Telegram.',
     [[btn('📋 قائمة الشبكات','nw:1:p:0'),
       btn('🏠 لوحة المالك','mi:1:h')]]);
   }
   if(receipt.action.startsWith(PREFIX+'policy:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'policy:').length));}
    catch{return null;}
    if(!Array.isArray(data)||data.length!==6||
     typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
     !Number.isSafeInteger(data[1])||data[1]<1||data[1]>9_999_999_999||
     typeof data[2]!=='string'||!validId(data[2])||
     !Number.isSafeInteger(data[3])||data[3]<0||data[3]>999||
     !Array.isArray(data[4])||data[4].length<1||data[4].length>SIZE||
     data[4].some((id:unknown)=>typeof id!=='string'||!validId(id))||
     new Set(data[4]).size!==data[4].length||
     typeof data[5]!=='string'||!/^[a-f0-9]{64}$/u.test(data[5]))return null;
    const [id,revision,sourceId,p,ids,digest]=data as [
     string,number,string,number,string[],string];
    const ctx=this.networkPolicySelection(s,actor,now,id,sourceId);
    if(!ctx||ctx.network.revision!==revision||ctx.digest!==digest)return null;
    const selected=ctx.targets.slice(p*SIZE,(p+1)*SIZE).filter(c=>ids.includes(c.id));
    if(selected.length!==ids.length||JSON.stringify(selected.map(c=>c.id))!==
     JSON.stringify(ids))return null;
    const drafts=selected.map(chat=>{
     const source=ctx.source.policy;
     // Never move group-specific allowlists, member exemptions, or any
     // approval/authority. Even a reviewed ENFORCE source is forbidden.
     const policy:ProtectionPolicy={chatId:chat.id,revision:1,mode:source.mode,
      rules:structuredClone(source.rules),allowedDomains:[],
      allowedPhrases:[],exemptMemberIds:[],
      ...(source.flood?{flood:structuredClone(source.flood)}:{})};
     return {policy,chatPolicyVersion:chat.version,updatedBy:actor,updatedAt:now};
    });
    if(drafts.length!==ids.length||drafts.some(d=>
     !isValidProtectionPolicy(d.policy)||!isValidGroupProtectionRecord(d)))return null;
    s.protectionPolicies??=[];
    for(const draft of drafts)s.protectionPolicies.push(draft);
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,
     decision:'ALLOW',reason:'OWNER_NETWORK_MONITOR_POLICIES_COPIED',
     policyVersion:revision,at:now});
    return ui('<b>✅ نُسخت سياسة الشبكة محليًا</b>\n'+
     'الشبكة: '+escape(ctx.network.name)+'\n'+
     'المجموعات المستفيدة: '+drafts.length+'\n'+
     'الأوضاع لا تتجاوز OFF أو MONITOR.\n'+
     'سياسات الاستثناء لم تتغير؛ لا اتصالات Telegram ولا عقوبات.',
     [[btn('🌐 بطاقة الشبكة','nw:1:d:'+id)],
      [btn('📑 مصادر السياسة','nw:1:y:'+id+':0')]]);
   }


   if(receipt.action.startsWith(PREFIX+'greeting:')){
    try{data=JSON.parse(receipt.action.slice((PREFIX+'greeting:').length));}
    catch{return null;}
    if(!Array.isArray(data)||data.length!==6||
     typeof data[0]!=='string'||!/^[a-f0-9]{12}$/u.test(data[0])||
     !Number.isSafeInteger(data[1])||data[1]<1||data[1]>9_999_999_999||
     typeof data[2]!=='string'||!validId(data[2])||
     !Number.isSafeInteger(data[3])||data[3]<0||data[3]>999||
     !Array.isArray(data[4])||data[4].length<1||data[4].length>SIZE||
     data[4].some((id:unknown)=>typeof id!=='string'||!validId(id))||
     new Set(data[4]).size!==data[4].length||
     typeof data[5]!=='string'||!/^[a-f0-9]{64}$/u.test(data[5]))return null;
    const [id,revision,sourceId,p,ids,digest]=data as
     [string,number,string,number,string[],string];
    const ctx=this.greetingSelection(s,actor,now,id,sourceId);
    if(!ctx||ctx.network.revision!==revision||ctx.digest!==digest)return null;
    const selected=ctx.targets.slice(p*SIZE,(p+1)*SIZE).filter(c=>ids.includes(c.id));
    if(selected.length!==ids.length||JSON.stringify(selected.map(c=>c.id))!==
     JSON.stringify(ids))return null;
    if((s.phase4Community?.configs.length??0)+selected.length>500)return null;
    const drafts=selected.map(chat=>{
     const result=defaultCommunityConfig(chat.id);
     result.version=1;
     result.welcome.text=ctx.source.welcome.text;
     if(ctx.source.welcome.localized)
      result.welcome.localized=structuredClone(ctx.source.welcome.localized);
     if(ctx.source.welcomeByJoin)
      result.welcomeByJoin=structuredClone(ctx.source.welcomeByJoin);
     result.farewell.text=ctx.source.farewell.text;
     if(ctx.source.farewell.localized)
      result.farewell.localized=structuredClone(ctx.source.farewell.localized);
     if(ctx.source.farewellByLeave)
      result.farewellByLeave=structuredClone(ctx.source.farewellByLeave);
     // Disabled by construction: no buttons/photos, URLs, user IDs,
     // automatic replies, operational flags or moderation rights.
     return result;
    });
    if(drafts.length!==ids.length||drafts.some(d=>!validCommunityConfig(d)||
     d.welcome.enabled||d.farewell.enabled||d.repliesEnabled))return null;
    s.phase4Community??=emptyCommunityState();
    s.phase4Community.configs.push(...drafts);
    receipt.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network:'+nonce,
     decision:'ALLOW',reason:'OWNER_NETWORK_GREETING_TEMPLATES_COPIED',
     policyVersion:revision,at:now});
    return ui('<b>✅ حُفظت قوالب الترحيب والوداع</b>\n'+
     'الشبكة: '+escape(ctx.network.name)+'\n'+
     'عدد المجموعات: '+drafts.length+'\n'+
     'جميع قوالب المجموعة الجديدة معطّلة حتى يفعّلها مالك المجموعة.\n'+
     'لم تُنسخ الوسائط أو الروابط أو إعدادات التشغيل، ولا اتصال Telegram.',
     [[btn('🌐 بطاقة الشبكة','nw:1:d:'+id)],
      [btn('👋 قوالب الترحيب','nw:1:w:'+id+':0')]]);
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
   'OWNER_NETWORK_MONITOR_POLICIES_COPIED',
   'OWNER_NETWORK_GREETING_TEMPLATES_COPIED']);
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
   else if(c.action.startsWith(PREFIX+'policy:'))prefix=PREFIX+'policy:';
   else if(c.action.startsWith(PREFIX+'greeting:'))prefix=PREFIX+'greeting:';
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
   if(description===null&&prefix===PREFIX+'policy:'&&
    a.reason==='OWNER_NETWORK_MONITOR_POLICIES_COPIED'&&values.length===6&&
    typeof values[0]==='string'&&/^[a-f0-9]{12}$/u.test(values[0])&&
    Number.isSafeInteger(values[1])&&values[1]>=1&&
    a.policyVersion===values[1]&&typeof values[2]==='string'&&validId(values[2])&&
    Number.isSafeInteger(values[3])&&values[3]>=0&&values[3]<=999&&
    Array.isArray(values[4])&&values[4].length>=1&&values[4].length<=SIZE&&
    values[4].every((id:unknown)=>typeof id==='string'&&validId(id))&&
    new Set(values[4]).size===values[4].length&&typeof values[5]==='string'&&
    /^[a-f0-9]{64}$/u.test(values[5])){
    description='الشبكة: '+values[0]+' · نسخ السياسة من '+values[2]+
     ' إلى '+values[4].length+' مجموعات';
   }
   if(description===null&&prefix===PREFIX+'greeting:'&&
    a.reason==='OWNER_NETWORK_GREETING_TEMPLATES_COPIED'&&values.length===6&&
    typeof values[0]==='string'&&/^[a-f0-9]{12}$/u.test(values[0])&&
    Number.isSafeInteger(values[1])&&values[1]>=1&&
    a.policyVersion===values[1]&&typeof values[2]==='string'&&validId(values[2])&&
    Number.isSafeInteger(values[3])&&values[3]>=0&&values[3]<=999&&
    Array.isArray(values[4])&&values[4].length>=1&&values[4].length<=SIZE&&
    values[4].every((id:unknown)=>typeof id==='string'&&validId(id))&&
    new Set(values[4]).size===values[4].length&&typeof values[5]==='string'&&
    /^[a-f0-9]{64}$/u.test(values[5])){
    description='الشبكة: '+values[0]+' · قوالب نصية من '+values[2]+
     ' إلى '+values[4].length+' مجموعات';
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
    e.reason==='OWNER_NETWORK_MONITOR_POLICIES_COPIED'?'نسخ سياسة الشبكة':
    e.reason==='OWNER_NETWORK_GREETING_TEMPLATES_COPIED'?'نسخ قوالب الترحيب':'فصل مجموعة')+
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
  const c=confirm.exec(data);if(c)return this.commit(actor,c[1]!);
  const k=cancel.exec(data);if(k)return this.revoke(actor,k[1]!);
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
  const p=pick.exec(data);if(p)return this.members(state,actor,now,p[1]!,Number(p[2]));
  const py=policySources.exec(data);
  if(py)return this.policySourceList(state,actor,now,py[1]!,Number(py[2]));
  const pz=policyPreview.exec(data);
  if(pz)return this.previewNetworkPolicy(actor,pz[1]!,pz[2]!,Number(pz[3]),Number(pz[4]??0));
  const gw=greetingSources.exec(data);
  if(gw)return this.greetingSourcesScreen(state,actor,now,gw[1]!,Number(gw[2]));
  const gv=greetingPreview.exec(data);
  if(gv)return this.previewGreeting(actor,gv[1]!,gv[2]!,Number(gv[3]),Number(gv[4]??0));
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
