import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import type {NetworkWatchCase} from './network-watchlist-model.js';
import {networkWatchCaseAccessible} from './network-watchlist.js';
import {networkSanctionReviewAccessible,prepareNetworkSanctionReview,
 decideNetworkSanctionReview} from './network-sanction-review.js';
import {validNetworkSanctionReview,type NetworkSanctionReview,
 type NetworkSanctionKind,type NetworkSanctionReviewDecision} from './network-sanction-review-model.js';
import {inspectNetworkTransferLocal,NetworkTransferReadOnlyPreflight,
 type NetworkTransferObservation} from './network-transfer-preflight.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

/** NETWORK-003 — owner-only *advisory* target reviews; no live Telegram gateway.
 * Each target requires its own human review and one-shot confirmation. */
const PREFIX='owner-network-sanction-',TTL=120_000,SIZE=8;
const id='([a-f0-9]{12})',page='(0|[1-9][0-9]{0,2})';
const group='(-[1-9][0-9]{0,15})';
const listing=new RegExp('^nw:1:sl:'+id+':'+page+'$','u');
const targets=new RegExp('^nw:1:st:'+id+':'+page+'$','u');
const choices=new RegExp('^nw:1:sk:'+id+':'+group+'$','u');
const propose=new RegExp('^nw:1:sv:'+id+':'+group+':([MB])$','u');
const details=new RegExp('^nw:1:sd:'+id+'$','u');
const decide=new RegExp('^nw:1:sm:'+id+':([ARC])$','u');
const localCheck=new RegExp('^nw:1:sp:'+id+'$','u');
const remoteCheck=new RegExp('^nw:1:sr:'+id+'$','u');
const confirm=/^nw:1:c:([A-Za-z0-9_-]{24})$/u;
const cancel=/^nw:1:k:([A-Za-z0-9_-]{24})$/u;
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const escape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const statusName:Record<string,string>={
 PENDING:'بانتظار قرار مستقل',REVIEWED_ONLY:'مراجعة معلوماتية فقط',
 REJECTED:'رُفض الاقتراح',CLOSED:'أُغلقت المراجعة'
};
const decisionName:Record<NetworkSanctionReviewDecision,string>={
 REVIEWED_ONLY:'معلوماتية فقط، دون عقوبة',REJECTED:'رفض الاقتراح',
 CLOSED:'إغلاق المراجعة'
};
const blockName:Record<string,string>={
 REVIEW_NOT_CURRENT:'المراجعة ليست فعالة أو فقدت صلاحيتها',
 PROTECTED_LOCAL:'العضو محمي محليًا من إجراءات النقل',
 UNRESOLVED_LOCAL:'توجد عملية إشراف معلقة أو غير مؤكدة',
 ACTIVE_LOCAL_REASON:'يوجد سبب إشراف نشط على الوجهة',
 LOCAL_LEDGER_UNSAFE:'سجل الإشراف المحلي يحتاج مراجعة',
 UNTRUSTED_OBSERVER:'مصدر فحص Telegram غير موثوق',
 TELEGRAM_NOT_GROUP:'المصدر أو الوجهة ليس مجموعة Telegram مؤكدة',
 SOURCE_NOT_VERIFIED:'لم تُثبت العقوبة المطلوبة في مجموعة المصدر',
 REMOTE_NOT_SAFE:'حالة العضو بالوجهة غير مناسبة أو غير مؤكدة',
 LOCAL_CHANGED:'تغيرت الأذونات أو المراجعة المحلية أثناء الفحص',
 REMOTE_CHANGED:'تغيرت حالة Telegram بين القراءتين',
};
const goodTime=(now:number)=>Number.isSafeInteger(now)&&now>=0&&
 now<=8_640_000_000_000_000-TTL;
export function validOwnerNetworkSanctionRoute(value:unknown):boolean {
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
  [listing,targets,choices,propose,details,decide,localCheck,remoteCheck]
   .some(re=>re.test(value));
}
export interface NetworkSanctionRemoteRead {
 gateway:TelegramBotApiModerationGateway;
 safety:()=>Promise<boolean>;
}
export class OwnerNetworkSanctionEditor {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly remoteRead?:NetworkSanctionRemoteRead){}
 private async safeRead():Promise<boolean>{
  if(!this.remoteRead)return false;
  try{return await this.remoteRead.safety()===true;}catch{return false;}
 }
 private auth(s:BotState,actor:string,now:number):boolean {
  return goodTime(now)&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private proof(s:BotState):string {
  return createHash('sha256').update(JSON.stringify([
   s.groupNetworks??[],s.chats,s.grants,s.networkWatchCases??[],
   s.networkSanctionReviews??[],s.moderationOperations,s.moderationReasons,
   s.privateFeatures,s.privateSettingsRevision??null
  ])).digest('hex');
 }
 private watched(s:BotState,actor:string,now:number,caseId:string):NetworkWatchCase|null {
  const c=networkWatchCaseAccessible(s,this.policy,actor,now,caseId);
  return c?.status==='WATCHED'&&c.revision===2&&
   c.reviewedAt!==undefined&&c.reviewedAt<=now?c:null;
 }
 private eligible(s:BotState,actor:string,now:number,c:NetworkWatchCase):Chat[] {
  const networks=(s.groupNetworks??[]).filter(x=>x.id===c.networkId);
  const n=networks.length===1?networks[0]:null;
  if(!n||n.revision!==c.networkRevision||n.updatedAt>now)return [];
  return s.chats.filter(chat=>chat.id!==c.sourceChatId&&
   s.chats.filter(x=>x.id===chat.id).length===1&&chat.approved&&chat.version>=1&&
   chat.scopes.includes('moderation')&&
   this.policy.canUseChat(s,chat.id,'moderation')&&
   this.policy.has(s,actor,'chat.manage',chat.id,now)&&
   n.members.filter(m=>m.chatId===chat.id&&m.version===chat.version).length===1)
   .sort((a,b)=>a.id.localeCompare(b.id));
 }
 private list(s:BotState,actor:string,now:number,caseId:string,p:number):OwnerInlineScreen|null {
  const c=this.watched(s,actor,now,caseId);
  if(!c||!Number.isSafeInteger(p)||p<0||p>999)return null;
  const rows=(s.networkSanctionReviews??[]).filter(x=>x.caseId===caseId&&
   networkSanctionReviewAccessible(s,this.policy,actor,now,x.id)!==null)
   .sort((a,b)=>b.requestedAt-a.requestedAt||a.id.localeCompare(b.id));
  const pages=Math.max(1,Math.ceil(rows.length/SIZE));
  if(p>=pages)return null;
  const keys=rows.slice(p*SIZE,(p+1)*SIZE).map(r=>
   [btn((r.kind==='BAN'?'🚫 حظر':'🔇 كتم')+' '+r.targetChatId+
    ' · '+statusName[r.status],'nw:1:sd:'+r.id)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:sl:'+caseId+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:sl:'+caseId+':'+(p+1)));
  if(nav.length)keys.push(nav);
  keys.push([btn('➕ اقتراح لمجموعة مستهدفة','nw:1:st:'+caseId+':0')]);
  keys.push([btn('↩️ تفاصيل البلاغ','nw:1:a:'+caseId)]);
  return ui('<b>⚖️ اقتراحات العقوبات لكل مجموعة</b>\nالبلاغ: <code>'+
   c.id+'</code> · المعرّف: <code>'+c.subjectId+'</code>\nعدد المقترحات: '+
   rows.length+' · الصفحة '+(p+1)+'/'+pages+
   '\nكل مقترح معلوماتي مستقل. لا يشكل إذنًا لتنفيذ حظر أو كتم على Telegram.',
   keys);
 }
 private targetPage(s:BotState,actor:string,now:number,caseId:string,p:number):OwnerInlineScreen|null {
  const c=this.watched(s,actor,now,caseId);
  if(!c||p<0||p>999)return null;
  const all=this.eligible(s,actor,now,c);
  const pages=Math.max(1,Math.ceil(all.length/SIZE));
  if(p>=pages)return null;
  const rows=all.slice(p*SIZE,(p+1)*SIZE).map(x=>
   [btn('👥 المجموعة '+x.id,'nw:1:sk:'+caseId+':'+x.id)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:st:'+caseId+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:st:'+caseId+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ المقترحات','nw:1:sl:'+caseId+':0')]);
  return ui('<b>👥 اختر الوجهة المستقلة</b>\nالمصدر: <code>'+c.sourceChatId+
   '</code>\nالوجهات المخوّلة: '+all.length+' · الصفحة '+(p+1)+'/'+pages+
   '\nالعضوية في الشبكة لا تمنح بذاتها حق معاقبة عضو.',rows);
 }
 private kindPage(s:BotState,actor:string,now:number,caseId:string,target:string):OwnerInlineScreen|null {
  const c=this.watched(s,actor,now,caseId);
  if(!c||!this.eligible(s,actor,now,c).some(x=>x.id===target))return null;
  return ui('<b>⚖️ نوع الاقتراح المعلوماتي</b>\nالمصدر: <code>'+
   c.sourceChatId+'</code>\nالوجهة: <code>'+target+
   '</code>\nلا ينفذ أي من الخيارين عقوبة حقيقية.',[
    [btn('🔇 كتم — اقتراح فقط','nw:1:sv:'+caseId+':'+target+':M')],
    [btn('🚫 حظر — اقتراح فقط','nw:1:sv:'+caseId+':'+target+':B')],
    [btn('↩️ الوجهات','nw:1:st:'+caseId+':0')]
   ]);
 }
 private async previewCreate(actor:string,caseId:string,target:string,key:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now)||!this.watched(s,actor,now,caseId))return null;
   const kind:NetworkSanctionKind=key==='B'?'BAN':'MUTE';
   const row=prepareNetworkSanctionReview(s,this.policy,actor,now,caseId,target,kind);
   if(!row)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PREFIX+'propose:'+JSON.stringify([row,this.proof(s)]),
    actorId:actor,chatId:'private',policyVersion:0,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   return ui('<b>🔎 معاينة مقترح عقوبة شبكة</b>\nالمعرّف: <code>'+
    row.subjectId+'</code>\nالمصدر: <code>'+row.sourceChatId+
    '</code>\nالوجهة: <code>'+row.targetChatId+
    '</code>\nالنوع: '+(row.kind==='BAN'?'حظر':'كتم')+
    '\nيحفظ مقترحًا بانتظار قرار بشري مستقل؛ لا يطبق عقوبة Telegram.',[
     [btn('✅ تأكيد حفظ المقترح','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]
    ]);
  });
 }
 private rowDetail(s:BotState,actor:string,now:number,id:string):OwnerInlineScreen|null{
  const r=networkSanctionReviewAccessible(s,this.policy,actor,now,id);
  if(!r)return null;
  const keys:{text:string;callback_data:string}[][]=[];
  if(r.status==='PENDING'){
   keys.push([btn('✅ تثبيت المراجعة المعلوماتية','nw:1:sm:'+id+':A')]);
   keys.push([btn('✖ رفض المراجعة','nw:1:sm:'+id+':R')]);
  }
  if(r.status==='REVIEWED_ONLY'){
   keys.push([btn('🔍 فحص الجاهزية المحلية','nw:1:sp:'+id)]);
   if(this.remoteRead)keys.push([btn('📡 فحص Telegram (قراءة فقط)','nw:1:sr:'+id)]);
   keys.push([btn('🔒 إغلاق المراجعة','nw:1:sm:'+id+':C')]);
  }
  keys.push([btn('↩️ مقترحات البلاغ','nw:1:sl:'+r.caseId+':0')]);
  return ui('<b>⚖️ تفاصيل اقتراح مستقل</b>\nالمرجع: <code>'+r.id+
   '</code>\nمعرّف العضو: <code>'+r.subjectId+
   '</code>\nالمصدر: <code>'+r.sourceChatId+
   '</code>\nالوجهة: <code>'+r.targetChatId+
   '</code>\nالنوع: '+(r.kind==='BAN'?'حظر':'كتم')+
   '\nالحالة: '+statusName[r.status]+
   '\nمراجعة معلوماتية فقط. لا حظر ولا كتم ولا نقل تلقائي.',keys);
 }
 private async previewDecision(actor:string,id:string,key:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),r=networkSanctionReviewAccessible(s,this.policy,actor,now,id);
   if(!this.auth(s,actor,now)||!r)return null;
   const d:NetworkSanctionReviewDecision=
    key==='A'?'REVIEWED_ONLY':key==='R'?'REJECTED':'CLOSED';
   if(!['A','R','C'].includes(key)||
    (r.status==='PENDING'&&d==='CLOSED')||
    (r.status==='REVIEWED_ONLY'&&d!=='CLOSED')||
    (r.status!=='PENDING'&&r.status!=='REVIEWED_ONLY'))return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PREFIX+'decide:'+JSON.stringify([
    r.id,r.revision,d,this.proof(s)]),actorId:actor,chatId:'private',
    policyVersion:0,expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
   return ui('<b>🔎 معاينة قرار مستقل لكل وجهة</b>\nالوجهة: <code>'+
    r.targetChatId+'</code>\nالعضو: <code>'+r.subjectId+
    '</code>\nالقرار: '+decisionName[d]+
    '\nلا يترتب على القرار أي إجراء Telegram.',[
     [btn('✅ تأكيد القرار','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','nw:1:k:'+ref.slice(2))]
    ]);
  });
 }
 private local(s:BotState,actor:string,now:number,id:string):OwnerInlineScreen|null{
  const r=networkSanctionReviewAccessible(s,this.policy,actor,now,id);
  if(!r)return null;
  const x=inspectNetworkTransferLocal(s,this.policy,actor,now,r.id);
  const message=x.status==='MAY_OBSERVE'
   ?'اجتازت المراجعة شروط القراءة المحلية فقط؛ لم تُفحص صلاحيات Telegram أو حالة العضو الحية.'
   :'ممنوع محليًا: '+(blockName[x.reason]??escape(x.reason));
  return ui('<b>🔍 فحص الجاهزية المحلية</b>\nالوجهة: <code>'+r.targetChatId+
   '</code>\n'+message+
   '\nهذا الفحص للقراءة فقط ولا يتصل بـTelegram ولا يسمح بعقوبة أو نقل.',[
    [btn('↩️ تفاصيل الاقتراح','nw:1:sd:'+r.id)]
   ]);
 }
 /** A remote read always starts with an explicit owner-only, expiring preview.
  * No Telegram query is performed while displaying the preview. */
 private async previewRemote(actor:string,id:string):Promise<OwnerInlineScreen|null>{
  if(!this.remoteRead||!await this.safeRead()||
   !TelegramBotApiModerationGateway.usesOfficialNetworkReviewRead(
    this.remoteRead.gateway))return null;
  return this.store.transaction(s=>{
   const now=this.clock(),row=networkSanctionReviewAccessible(
    s,this.policy,actor,now,id);
   if(!this.auth(s,actor,now)||!row||
    inspectNetworkTransferLocal(s,this.policy,actor,now,id).status!=='MAY_OBSERVE')
    return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   s.callbacks.push({ref,action:PREFIX+'remote:'+JSON.stringify([
    row.id,row.revision,this.proof(s)]),actorId:actor,
    chatId:'private',policyVersion:0,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   return ui('<b>🔎 معاينة فحص Telegram للقراءة فقط</b>\nالوجهة: <code>'+
    row.targetChatId+'</code>\nالمصدر: <code>'+row.sourceChatId+
    '</code>\nالمعرف: <code>'+row.subjectId+
    '</code>\nسيتحقق البوت من نوع مجموعتي المصدر والوجهة، وحقوقه وحالة العضو عبر Telegram مرتين. لا ينفذ حظرًا أو كتمًا ولا يحفظ نتيجة كإذن عقوبة.',[
     [btn('✅ تأكيد الفحص للقراءة فقط','nw:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء الفحص','nw:1:k:'+ref.slice(2))]
    ]);
  });
 }
 /** Consume the owner receipt BEFORE any awaited network I/O to prevent
  * replay or concurrent reads. A later STOP or drift may only downgrade a
  * provisional remote observation, never authorize Telegram mutations. */
 private async remoteReceipt(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.remoteRead||!this.policy.isOwner(actor))return null;
  const c=confirm.exec(data);
  if(!c)return null;
  const nonce=c[1]!;
  if(!await this.safeRead())return null;
  const accepted=await this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(x=>x.ref==='c_'+nonce),rec=rows[0];
   if(!this.auth(s,actor,now)||rows.length!==1||!rec||
    !rec.action.startsWith(PREFIX+'remote:')||
    rec.actorId!==actor||rec.chatId!=='private'||
    rec.policyVersion!==0||rec.oneShot!==true||rec.used!==false||
    rec.revoked!==false||!Number.isSafeInteger(rec.expiresAt)||
    rec.expiresAt<=now||rec.expiresAt>now+TTL)return null;
   let payload:unknown;
   try{payload=JSON.parse(rec.action.slice((PREFIX+'remote:').length));}
   catch{return null;}
   if(!Array.isArray(payload)||payload.length!==3||
    typeof payload[0]!=='string'||!/^[a-f0-9]{12}$/u.test(payload[0])||
    !Number.isSafeInteger(payload[1])||payload[1]<1||
    typeof payload[2]!=='string'||!/^[a-f0-9]{64}$/u.test(payload[2])||
    this.proof(s)!==payload[2])return null;
   const [id,revision]=payload as [string,number,string];
   const row=networkSanctionReviewAccessible(s,this.policy,actor,now,id);
   if(!row||row.revision!==revision||
    inspectNetworkTransferLocal(s,this.policy,actor,now,id).status!=='MAY_OBSERVE')
    return null;
   rec.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-network-remote-read:'+nonce,
    decision:'ALLOW',reason:'OWNER_NETWORK_REMOTE_READ_REQUESTED',
    policyVersion:row.networkRevision,at:now});
   return {id,target:row.targetChatId};
  });
  if(!accepted)return null;
  const back=[[btn('↩️ تفاصيل الاقتراح','nw:1:sd:'+accepted.id)]];
  if(!await this.safeRead())return ui('<b>⛔ توقف الفحص</b>\nأُلغي الوصول الحي عند تفعيل إيقاف التشغيل؛ لا نتيجة مؤكدة ولا عقوبة.',back);
  let result:NetworkTransferObservation;
  try{
   result=await new NetworkTransferReadOnlyPreflight(this.store,this.policy,
    this.remoteRead.gateway,this.clock).assess(actor,accepted.id);
  }catch{
   return ui('<b>⚠️ تعذر فحص Telegram</b>\nحالة الفحص غير مؤكدة؛ لا عقوبة.',back);
  }
  if(!await this.safeRead())return ui('<b>⛔ توقف الفحص</b>\nأُلغي الوصول الحي أثناء القراءة؛ لا نتيجة مؤكدة ولا عقوبة.',back);
  if(result.status==='OBSERVED_ONLY')
   return ui('<b>✅ رُصدت الحالة على Telegram</b>\nالوجهة: <code>'+
    accepted.target+'</code>\nظهرت عقوبة مطابقة في المصدر وعضوية عادية في الوجهة خلال قراءتين متتابعتين. هذه مشاهدة لحظية فقط؛ لا تعني ثبوت الجهة التي فرضت العقوبة، ولا تخول تنفيذ أو نقل أي عقوبة.',back);
  return ui('<b>⚠️ تعذر تأكيد الحالة على Telegram</b>\nالوجهة: <code>'+
   accepted.target+'</code>\nغير متحقق: '+
   (blockName[result.reason]??escape(result.reason))+
   '\nلم تُثبت صلاحية نقل العقوبة ولا يُنفذ أي تعديل.',back);
 }

 /** Shared network receipts are considered by this editor first, then watchlist,
  * then original network commands; only its own PREFIX can consume a receipt. */
 async handleReceipt(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor))return null;
  const c=confirm.exec(data),k=cancel.exec(data);
  if(!c&&!k)return null;
  const remote=await this.remoteReceipt(actor,data);
  if(remote)return remote;
  const nonce=(c??k)![1]!;
  return this.store.transaction(s=>{
   const now=this.clock(),matches=s.callbacks.filter(x=>x.ref==='c_'+nonce),rec=matches[0];
   if(!this.auth(s,actor,now)||matches.length!==1||!rec||
    !rec.action.startsWith(PREFIX)||rec.actorId!==actor||rec.chatId!=='private'||
    rec.policyVersion!==0||rec.oneShot!==true||rec.used!==false||rec.revoked!==false||
    !Number.isSafeInteger(rec.expiresAt)||rec.expiresAt<=now||
    rec.expiresAt>now+TTL)return null;
   if(k){
    rec.revoked=true;
    return ui('<b>✖ أُلغيت المعاينة</b>\nلا تغيير في مراجعات الشبكة.',[
     [btn('🌐 الشبكات','nw:1:h')]]);
   }
   let dataValue:unknown;
   if(rec.action.startsWith(PREFIX+'propose:')){
    try{dataValue=JSON.parse(rec.action.slice((PREFIX+'propose:').length));}
    catch{return null;}
    if(!Array.isArray(dataValue)||dataValue.length!==2||
     !validNetworkSanctionReview(dataValue[0])||typeof dataValue[1]!=='string'||
     !/^[a-f0-9]{64}$/u.test(dataValue[1])||this.proof(s)!==dataValue[1])return null;
    const row=dataValue[0] as NetworkSanctionReview;
    if(row.status!=='PENDING'||row.requestedBy!==actor||row.requestedAt>now||
     now-row.requestedAt>TTL||
     (s.networkSanctionReviews??[]).some(x=>x.id===row.id))return null;
    const fresh=prepareNetworkSanctionReview(s,this.policy,actor,now,
     row.caseId,row.targetChatId,row.kind);
    if(!fresh||fresh.caseRevision!==row.caseRevision||
     fresh.networkRevision!==row.networkRevision||
     fresh.sourceChatId!==row.sourceChatId||
     fresh.sourceChatVersion!==row.sourceChatVersion||
     fresh.targetChatVersion!==row.targetChatVersion||
     fresh.subjectId!==row.subjectId)return null;
    fresh.id=row.id;fresh.requestedAt=row.requestedAt;
    if(!validNetworkSanctionReview(fresh))return null;
    s.networkSanctionReviews??=[];s.networkSanctionReviews.push(fresh);
    rec.used=true;
    s.audit.push({actorId:actor,updateKey:'owner-network-sanction:'+nonce,
     decision:'ALLOW',reason:'OWNER_NETWORK_SANCTION_PROPOSED',
     policyVersion:row.networkRevision,at:now});
    return ui('<b>✅ تم حفظ المقترح للمراجعة</b>\nالوجهة: <code>'+
     row.targetChatId+'</code>\nلا عقوبة Telegram.',[
      [btn('⚖️ التفاصيل','nw:1:sd:'+row.id)],
      [btn('↩️ المقترحات','nw:1:sl:'+row.caseId+':0')]
     ]);
   }
   if(!rec.action.startsWith(PREFIX+'decide:'))return null;
   try{dataValue=JSON.parse(rec.action.slice((PREFIX+'decide:').length));}
   catch{return null;}
   if(!Array.isArray(dataValue)||dataValue.length!==4||
    typeof dataValue[0]!=='string'||!/^[a-f0-9]{12}$/u.test(dataValue[0])||
    !Number.isSafeInteger(dataValue[1])||dataValue[1]<1||
    !['REVIEWED_ONLY','REJECTED','CLOSED'].includes(String(dataValue[2]))||
    typeof dataValue[3]!=='string'||!/^[a-f0-9]{64}$/u.test(dataValue[3])||
    this.proof(s)!==dataValue[3])return null;
   const [reviewId,version,decision]=dataValue as
    [string,number,NetworkSanctionReviewDecision,string];
   const row=networkSanctionReviewAccessible(s,this.policy,actor,now,reviewId);
   if(!row||row.revision!==version||
    !decideNetworkSanctionReview(s,this.policy,actor,now,
     reviewId,version,decision))return null;
   rec.used=true;
   s.audit.push({actorId:actor,updateKey:'owner-network-sanction:'+nonce,
    decision:'ALLOW',reason:'OWNER_NETWORK_SANCTION_REVIEWED',
    policyVersion:row.networkRevision,at:now});
   return ui('<b>✅ اعتُمد قرار المراجعة</b>\nالحالة: '+decisionName[decision]+
    '\nلم يتغير أي قيد أو عقوبة Telegram.',[
     [btn('⚖️ التفاصيل','nw:1:sd:'+reviewId)],
     [btn('↩️ المقترحات','nw:1:sl:'+row.caseId+':0')]
    ]);
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validOwnerNetworkSanctionRoute(data))return null;
  const s=await this.store.snapshot(),now=this.clock();
  if(!this.auth(s,actor,now))return null;
  const l=listing.exec(data);
  if(l)return this.list(s,actor,now,l[1]!,Number(l[2]));
  const t=targets.exec(data);
  if(t)return this.targetPage(s,actor,now,t[1]!,Number(t[2]));
  const k=choices.exec(data);
  if(k)return this.kindPage(s,actor,now,k[1]!,k[2]!);
  const p=propose.exec(data);
  if(p)return this.previewCreate(actor,p[1]!,p[2]!,p[3]!);
  const d=details.exec(data);
  if(d)return this.rowDetail(s,actor,now,d[1]!);
  const m=decide.exec(data);
  if(m)return this.previewDecision(actor,m[1]!,m[2]!);
  const x=localCheck.exec(data);
  if(x)return this.local(s,actor,now,x[1]!);
  const remote=remoteCheck.exec(data);
  if(remote)return this.previewRemote(actor,remote[1]!);
  return null;
 }
}
