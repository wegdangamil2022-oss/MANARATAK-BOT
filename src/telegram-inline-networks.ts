import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat} from './store.js';
import type {GroupNetwork} from './group-network-model.js';
import {validNetworkName} from './group-network-model.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';

/** Local network folders for approved groups. Membership is an organization
 * hint only; it NEVER issues Telegram rights, grants, moderation or delivery. */
const TTL=120_000,INPUT_TTL=600_000,PREFIX='owner-network-',SIZE=8;
const net='([a-f0-9]{12})',page='(0|[1-9][0-9]{0,2})',
 group='(-[1-9][0-9]{0,15})',revision='([1-9][0-9]{0,9})';
const home=/^nw:1:h$/u,begin=/^nw:1:n$/u;
const list=new RegExp('^nw:1:p:'+page+'$','u');
const detail=new RegExp('^nw:1:d:'+net+'$','u');
const pick=new RegExp('^nw:1:g:'+net+':'+page+'$','u');
const toggle=new RegExp('^nw:1:t:'+net+':'+revision+':'+group+':'+revision+':'+page+'$','u');
const confirm=/^nw:1:c:([A-Za-z0-9_-]{24})$/u,cancel=/^nw:1:k:([A-Za-z0-9_-]{24})$/u;
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(value:string)=>value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const validId=(value:string)=>/^-[1-9][0-9]{0,15}$/u.test(value)&&Number.isSafeInteger(Number(value));
const validClock=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000-INPUT_TTL;
export function validOwnerNetworkRoute(data:unknown):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return false;
 return data==='mi:1:i:01:03'||home.test(data)||begin.test(data)||
  [list,detail,pick,toggle,confirm,cancel].some(re=>re.test(data));
}
function approved(s:BotState,policy:Policy,actor:string,now:number):Chat[]{
 const counts=new Map<string,number>();
 for(const c of s.chats)counts.set(c.id,(counts.get(c.id)??0)+1);
 return s.chats.filter(c=>c.approved&&counts.get(c.id)===1&&validId(c.id)&&
  Number.isSafeInteger(c.version)&&c.version>=1&&c.version<=9_999_999_999&&
  policy.has(s,actor,'chat.manage',c.id,now))
  .sort((a,b)=>a.id.localeCompare(b.id));
}
function namesProof(s:BotState):string{
 return createHash('sha256').update(JSON.stringify([
  (s.groupNetworks??[]).map(n=>[n.id,n.name,n.revision]),s.privateSettingsRevision??0,
  s.privateFeatures['owner.dashboard']
 ])).digest('hex');
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
 private async start(actor:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now)||(s.groupNetworks??[]).length>=32)return null;
   for(const c of s.callbacks)if(c.actorId===actor&&c.action===PREFIX+'input:'&&
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
  if(!snapshot.callbacks.some(c=>c.actorId===actor&&c.action===PREFIX+'input:'&&
   !c.used&&!c.revoked))return null;
  if(!validNetworkName(name))throw Error('NETWORK_INVALID_NAME');
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))throw Error('NETWORK_DISABLED');
   const pend=s.callbacks.filter(c=>c.actorId===actor&&c.action===PREFIX+'input:'&&
    !c.used&&!c.revoked),intent=pend[0];
   if(pend.length!==1||!intent||intent.chatId!=='private'||intent.policyVersion!==0||
    intent.oneShot!==true||!Number.isSafeInteger(intent.expiresAt)||
    intent.expiresAt<=now||intent.expiresAt>now+INPUT_TTL)throw Error('NETWORK_INPUT_EXPIRED');
   if((s.groupNetworks??[]).length>=32||matchesName(s.groupNetworks??[],name))
    throw Error('NETWORK_DUPLICATE_OR_LIMIT');
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PREFIX+'create:'+JSON.stringify([name,namesProof(s)]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,
    expiresAt:now+TTL});
   intent.used=true;
   return ui('<b>🔎 معاينة إنشاء شبكة</b>\n'+
    'الاسم: <b>'+escape(name)+'</b>\n'+
    'لا توجد مجموعات مرتبطة بعد، وستضيفها لاحقًا بعد اعتمادها.\n'+
    'الحفظ في قاعدة البيانات المحلية فقط، وليس إنشاء شبكة أو اتحاد داخل Telegram.',
    [[btn('✅ تأكيد إنشاء الشبكة','nw:1:c:'+ref.slice(2))],
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
  if(!snapshot.callbacks.some(c=>c.actorId===actor&&c.action===PREFIX+'input:'&&
   !c.revoked&&!c.used))return;
  await this.store.transaction(s=>{
   for(const c of s.callbacks)if(c.actorId===actor&&c.action===PREFIX+'input:'&&
    !c.revoked&&!c.used)c.revoked=true;
  });
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
  const l=list.exec(data);if(l)return this.networkList(state,Number(l[1]));
  const d=detail.exec(data);if(d)return this.networkCard(state,actor,now,d[1]!);
  const p=pick.exec(data);if(p)return this.members(state,actor,now,p[1]!,Number(p[2]));
  const t=toggle.exec(data);
  if(t)return this.togglePreview(actor,t[1]!,Number(t[2]),t[3]!,Number(t[4]),Number(t[5]));
  return null;
 }
}
