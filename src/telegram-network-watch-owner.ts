import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {prepareNetworkWatchCase,networkWatchCaseAccessible,reviewNetworkWatchCase} from './network-watchlist.js';
import {validNetworkWatchCase,type NetworkWatchCase,type NetworkWatchCategory,
 type NetworkWatchDecision} from './network-watchlist-model.js';

/** NETWORK-003: owner-private, advisory-only UI. No moderation gateway is imported. */
const PRE='owner-network-watch-',TTL=120_000,INPUT_TTL=600_000,SIZE=8;
const net='([a-f0-9]{12})',group='(-[1-9][0-9]{0,15})',page='(0|[1-9][0-9]{0,2})';
const list=new RegExp('^nw:1:w:'+net+':'+page+'$','u');
const sources=new RegExp('^nw:1:u:'+net+':'+page+'$','u');
const category=new RegExp('^nw:1:o:'+net+':'+group+'$','u');
const input=new RegExp('^nw:1:v:'+net+':'+group+':([SFIO])$','u');
const detail=new RegExp('^nw:1:a:'+net+'$','u');
const decision=new RegExp('^nw:1:m:'+net+':([WDC])$','u');
const confirm=/^nw:1:c:([A-Za-z0-9_-]{24})$/u,cancel=/^nw:1:k:([A-Za-z0-9_-]{24})$/u;
const types:Record<string,NetworkWatchCategory>={S:'SPAM',F:'FLOOD',I:'IMPERSONATION',O:'OTHER'};
const typeNames:Record<NetworkWatchCategory,string>={
 SPAM:'إزعاج',FLOOD:'إغراق',IMPERSONATION:'انتحال',OTHER:'أخرى'
};
const statuses:Record<string,string>={
 PENDING:'بانتظار المراجعة',WATCHED:'متابعة معلوماتية',DISMISSED:'مرفوض',CLEARED:'أُغلقت المتابعة'
};
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const goodTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000-INPUT_TTL;
const goodSubject=(v:string)=>/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
export function validOwnerNetworkWatchRoute(value:unknown):boolean{
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
  [list,sources,category,input,detail,decision].some(re=>re.test(value));
}
export class OwnerNetworkWatchEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private auth(s:BotState,actor:string,now:number):boolean{
  return goodTime(now)&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private network(s:BotState,id:string){
  const matches=(s.groupNetworks??[]).filter(n=>n.id===id);
  return matches.length===1?matches[0]!:null;
 }
 private proof(s:BotState):string{
  return createHash('sha256').update(JSON.stringify([
   s.groupNetworks??[],s.chats,s.grants,s.networkWatchCases??[],
   s.privateFeatures,s.privateSettingsRevision??null
  ])).digest('hex');
 }
 private sourceChats(s:BotState,actor:string,now:number,id:string):Chat[]{
  const n=this.network(s,id);if(!n)return [];
  const counts=new Map<string,number>();
  for(const c of s.chats)counts.set(c.id,(counts.get(c.id)??0)+1);
  return s.chats.filter(c=>counts.get(c.id)===1&&c.approved&&
   c.scopes.includes('moderation')&&this.policy.canUseChat(s,c.id,'moderation')&&
   this.policy.has(s,actor,'chat.manage',c.id,now)&&
   n.members.filter(m=>m.chatId===c.id&&m.version===c.version).length===1)
   .sort((a,b)=>a.id.localeCompare(b.id));
 }
 private page(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const n=this.network(s,id);if(!n||p<0||p>999)return null;
  const cases=(s.networkWatchCases??[]).filter(c=>c.networkId===id&&
   networkWatchCaseAccessible(s,this.policy,actor,now,c.id)!==null)
   .sort((a,b)=>b.submittedAt-a.submittedAt||a.id.localeCompare(b.id));
  const pages=Math.max(1,Math.ceil(cases.length/SIZE));if(p>=pages)return null;
  const rows=cases.slice(p*SIZE,(p+1)*SIZE).map(c=>[
   btn('🛡️ '+c.subjectId+' · '+statuses[c.status],'nw:1:a:'+c.id)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:w:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:w:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('➕ تقديم بلاغ للمراجعة','nw:1:u:'+id+':0')]);
  rows.push([btn('↩️ بطاقة الشبكة','nw:1:d:'+id)]);
  return ui('<b>🛡️ بلاغات الشبكة المركزية</b>\nالشبكة: '+escape(n.name)+
   '\nالحالات المتاحة بمصدرها الحالي: '+cases.length+' · صفحة '+(p+1)+'/'+pages+
   '\nهذه بلاغات معلوماتية فقط، ولا تمنح إذن حظر أو كتم أو نقل عقوبة.',rows);
 }
 private sourcePage(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const n=this.network(s,id);if(!n||p<0||p>999)return null;
  const all=this.sourceChats(s,actor,now,id),pages=Math.max(1,Math.ceil(all.length/SIZE));
  if(p>=pages)return null;
  const rows=all.slice(p*SIZE,(p+1)*SIZE).map(c=>
   [btn('👥 المجموعة '+c.id,'nw:1:o:'+id+':'+c.id)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:u:'+id+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:u:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ البلاغات','nw:1:w:'+id+':0')]);
  return ui('<b>🛡️ اختر مصدر البلاغ</b>\nالشبكة: '+escape(n.name)+
   '\nاختر مجموعة معتمدة لنطاق الإشراف ومربوطة بإصدارها الحالي.\nالمجموعات: '+
   all.length+' · صفحة '+(p+1)+'/'+pages,rows);
 }
 private categories(s:BotState,actor:string,now:number,id:string,source:string):OwnerInlineScreen|null{
  if(!this.sourceChats(s,actor,now,id).some(c=>c.id===source))return null;
  const rows=Object.entries(types).map(([key,kind])=>[
   btn('◆ '+typeNames[kind],'nw:1:v:'+id+':'+source+':'+key)]);
  rows.push([btn('↩️ مصادر البلاغ','nw:1:u:'+id+':0')]);
  return ui('<b>🛡️ تصنيف البلاغ</b>\nالمصدر: <code>'+source+
   '</code>\nالتصنيف ليس إثبات مخالفة ولا عقوبة.',rows);
 }
 private async begin(actor:string,id:string,source:string,key:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),n=this.network(s,id);
   const chat=this.sourceChats(s,actor,now,id).find(c=>c.id===source);
   if(!this.auth(s,actor,now)||!n||!chat||!types[key]||
    (s.networkWatchCases??[]).length>=400)return null;
   for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(PRE+'input:')&&
    !c.used&&!c.revoked)c.revoked=true;
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PRE+'input:'+id+':'+n.revision+':'+source+
    ':'+chat.version+':'+key,actorId:actor,chatId:'private',policyVersion:0,
    expiresAt:now+INPUT_TTL,oneShot:true,used:false,revoked:false});
   return ui('<b>🛡️ معرّف العضو للبلاغ</b>\n'+
    'أرسل معرّف Telegram الرقمي الموجب فقط في الخاص (ليس رقم هاتف أو رابطًا).\n'+
    'المصدر: <code>'+source+'</code> · التصنيف: '+typeNames[types[key]!]+'\n'+
    'يُحفظ بلاغ للمراجعة فقط بعد معاينة وتأكيد مستقلين.',
    [[btn('↩️ إلغاء البلاغ','nw:1:w:'+id+':0')]]);
  });
 }
 async previewInput(actor:string,subject:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor))return null;
  const before=await this.store.snapshot();
  if(!before.callbacks.some(c=>c.actorId===actor&&c.action.startsWith(PRE+'input:')&&
   !c.used&&!c.revoked))return null;
  if(!goodSubject(subject))throw Error('NETWORK_WATCH_INVALID_SUBJECT');
  return this.store.transaction(s=>{
   const now=this.clock(),pending=s.callbacks.filter(c=>c.actorId===actor&&
    c.action.startsWith(PRE+'input:')&&!c.used&&!c.revoked),intent=pending[0];
   if(!this.auth(s,actor,now)||pending.length!==1||!intent||intent.chatId!=='private'||
    intent.policyVersion!==0||intent.oneShot!==true||!Number.isSafeInteger(intent.expiresAt)||
    intent.expiresAt<=now||intent.expiresAt>now+INPUT_TTL)throw Error('NETWORK_WATCH_STALE');
   const m=/^owner-network-watch-input:([a-f0-9]{12}):([1-9][0-9]{0,9}):(-[1-9][0-9]{0,15}):([1-9][0-9]{0,9}):([SFIO])$/u.exec(intent.action);
   if(!m)throw Error('NETWORK_WATCH_STALE');
   const n=this.network(s,m[1]!),source=this.sourceChats(s,actor,now,m[1]!)
    .find(c=>c.id===m[3]);
   if(!n||n.revision!==Number(m[2])||!source||source.version!==Number(m[4]))
    throw Error('NETWORK_WATCH_STALE');
   const row=prepareNetworkWatchCase(s,this.policy,actor,now,m[1]!,m[3]!,subject,types[m[5]!]!);
   if(!row)throw Error('NETWORK_WATCH_NOT_ALLOWED');
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PRE+'create:'+JSON.stringify([row,this.proof(s)]),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,
    used:false,revoked:false,expiresAt:now+TTL});
   intent.used=true;
   return ui('<b>🔎 معاينة بلاغ شبكة</b>\nالشبكة: '+escape(n.name)+
    '\nالمجموعة المصدر: <code>'+source.id+'</code>'+
    '\nالمعرّف الرقمي: <code>'+subject+'</code>\nالتصنيف: '+typeNames[row.category]+
    '\nبعد الحفظ يصبح البلاغ بانتظار مراجعة بشرية؛ لا عقوبة تلقائية.',
    [[btn('✅ تأكيد حفظ البلاغ','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }
 private caseDetail(s:BotState,actor:string,now:number,id:string):OwnerInlineScreen|null{
  const row=networkWatchCaseAccessible(s,this.policy,actor,now,id);if(!row)return null;
  const rows:{text:string;callback_data:string}[][]=[];
  if(row.status==='PENDING'){
   rows.push([btn('✅ اعتماد متابعة معلوماتية','nw:1:m:'+row.id+':W')]);
   rows.push([btn('✖ رفض البلاغ','nw:1:m:'+row.id+':D')]);
  }
  if(row.status==='WATCHED')rows.push([btn('✅ رفع المتابعة','nw:1:m:'+row.id+':C')]);
  rows.push([btn('↩️ بلاغات الشبكة','nw:1:w:'+row.networkId+':0')]);
  return ui('<b>🛡️ تفاصيل بلاغ الشبكة</b>\nالرقم: <code>'+row.id+
   '</code>\nالمعرّف: <code>'+row.subjectId+'</code>\nالمصدر: <code>'+
   row.sourceChatId+'</code>\nالتصنيف: '+typeNames[row.category]+
   '\nالحالة: '+statuses[row.status]+
   '\nهذه الحالة معلوماتية ولا تنفذ عقوبة Telegram.',rows);
 }
 private async previewDecision(actor:string,id:string,key:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),row=networkWatchCaseAccessible(s,this.policy,actor,now,id);
   if(!this.auth(s,actor,now)||!row)return null;
   const decision:NetworkWatchDecision=key==='W'?'WATCHED':key==='D'?'DISMISSED':'CLEARED';
   if(!['W','D','C'].includes(key)||
    (row.status==='PENDING'&&decision==='CLEARED')||
    (row.status==='WATCHED'&&decision!=='CLEARED')||
    (row.status!=='PENDING'&&row.status!=='WATCHED'))return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PRE+'decide:'+JSON.stringify([
    row.id,row.revision,decision,this.proof(s)]),actorId:actor,chatId:'private',
    policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   return ui('<b>🔎 معاينة قرار بلاغ</b>\nالمعرّف: <code>'+row.subjectId+
    '</code>\nالقرار: '+statuses[decision]+
    '\nلا يغيّر هذا القرار صلاحيات الأعضاء أو العقوبات.',
    [[btn('✅ تأكيد القرار','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]]);
  });
 }
 private async receipt(actor:string,nonce:string,approve:boolean):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref==='c_'+nonce),rec=rows[0];
   if(!this.auth(s,actor,now)||rows.length!==1||!rec||
    !rec.action.startsWith(PRE)||rec.actorId!==actor||rec.chatId!=='private'||
    rec.policyVersion!==0||rec.oneShot!==true||rec.used!==false||rec.revoked!==false||
    !Number.isSafeInteger(rec.expiresAt)||rec.expiresAt<=now||rec.expiresAt>now+TTL)return null;
   if(!approve){
    if(!rec.action.startsWith(PRE+'create:')&&!rec.action.startsWith(PRE+'decide:'))return null;
    rec.revoked=true;
    return ui('<b>✖ أُلغيت المعاينة</b>\nلم يتغير البلاغ.',
     [[btn('🌐 الشبكات','nw:1:h')]]);
   }
   let data:unknown;
   if(rec.action.startsWith(PRE+'create:')){
    try{data=JSON.parse(rec.action.slice((PRE+'create:').length));}catch{return null;}
    if(!Array.isArray(data)||data.length!==2||!validNetworkWatchCase(data[0])||
     typeof data[1]!=='string'||!/^[a-f0-9]{64}$/u.test(data[1])||
     this.proof(s)!==data[1])return null;
    const row=data[0] as NetworkWatchCase;
    if(row.status!=='PENDING'||row.submittedBy!==actor||row.submittedAt>now||
     now-row.submittedAt>TTL||(s.networkWatchCases??[]).some(c=>c.id===row.id))return null;
    const fresh=prepareNetworkWatchCase(s,this.policy,actor,now,row.networkId,
     row.sourceChatId,row.subjectId,row.category);
    if(!fresh||fresh.networkRevision!==row.networkRevision||
     fresh.sourceChatVersion!==row.sourceChatVersion)return null;
    fresh.id=row.id;fresh.submittedAt=row.submittedAt;
    if(!validNetworkWatchCase(fresh))return null;
    s.networkWatchCases??=[];s.networkWatchCases.push(fresh);
    rec.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network-watch:'+nonce,decision:'ALLOW',
     reason:'OWNER_NETWORK_WATCH_SUBMITTED',policyVersion:row.networkRevision,at:now});
    return ui('<b>✅ حُفظ البلاغ للمراجعة</b>\nرقم الحالة: <code>'+row.id+
     '</code>\nلا إجراءات Telegram.',
     [[btn('🛡️ تفاصيل البلاغ','nw:1:a:'+row.id)],
      [btn('↩️ بلاغات الشبكة','nw:1:w:'+row.networkId+':0')]]);
   }
   if(!rec.action.startsWith(PRE+'decide:'))return null;
   try{data=JSON.parse(rec.action.slice((PRE+'decide:').length));}catch{return null;}
   if(!Array.isArray(data)||data.length!==4||typeof data[0]!=='string'||
    !/^[a-f0-9]{12}$/u.test(data[0])||!Number.isSafeInteger(data[1])||data[1]<1||
    !['WATCHED','DISMISSED','CLEARED'].includes(data[2])||
    typeof data[3]!=='string'||!/^[a-f0-9]{64}$/u.test(data[3])||
    this.proof(s)!==data[3])return null;
   const [id,version,decision]=data as [string,number,NetworkWatchDecision,string];
   const row=networkWatchCaseAccessible(s,this.policy,actor,now,id);
   if(!row||row.revision!==version||
    !reviewNetworkWatchCase(s,this.policy,actor,now,id,version,decision))return null;
   rec.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-network-watch:'+nonce,decision:'ALLOW',
    reason:'OWNER_NETWORK_WATCH_REVIEWED',policyVersion:row.networkRevision,at:now});
   return ui('<b>✅ اعتُمد قرار البلاغ</b>\nالحالة: '+statuses[decision]+
    '\nلم تُنفذ أي عقوبة Telegram.',
    [[btn('🛡️ تفاصيل البلاغ','nw:1:a:'+id)],
     [btn('↩️ بلاغات الشبكة','nw:1:w:'+row.networkId+':0')]]);
  });
 }
 async cancelInput(actor:string):Promise<void>{
  if(!this.policy.isOwner(actor))return;
  const snap=await this.store.snapshot();
  if(!snap.callbacks.some(c=>c.actorId===actor&&c.action.startsWith(PRE+'input:')&&
   !c.revoked&&!c.used))return;
  await this.store.transaction(s=>{
   for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(PRE+'input:')&&
    !c.revoked&&!c.used)c.revoked=true;
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor))return null;
  const c=confirm.exec(data);if(c)return this.receipt(actor,c[1]!,true);
  const k=cancel.exec(data);if(k)return this.receipt(actor,k[1]!,false);
  if(!validOwnerNetworkWatchRoute(data))return null;
  // Any other watchlist navigation cancels an unfinished text-input intent.
  await this.cancelInput(actor);
  const s=await this.store.snapshot(),now=this.clock();
  if(!this.auth(s,actor,now))return null;
  const wl=list.exec(data);if(wl)return this.page(s,actor,now,wl[1]!,Number(wl[2]));
  const ws=sources.exec(data);if(ws)return this.sourcePage(s,actor,now,ws[1]!,Number(ws[2]));
  const wc=category.exec(data);if(wc)return this.categories(s,actor,now,wc[1]!,wc[2]!);
  const wi=input.exec(data);if(wi)return this.begin(actor,wi[1]!,wi[2]!,wi[3]!);
  const wd=detail.exec(data);if(wd)return this.caseDetail(s,actor,now,wd[1]!);
  const wm=decision.exec(data);if(wm)return this.previewDecision(actor,wm[1]!,wm[2]!);
  return null;
 }
}
