import {randomBytes} from 'node:crypto';
import {AdminRoomLinks,adminRoomRevokeWitness,type AdminRoomMode} from './admin-room-links.js';
import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';
const TTL=120000,PREFIX='admin-room:revoke-preview:',QUIET='admin-room:quiet-preview:',DAILY='admin-room:daily-preview:',CHECK='admin-room-check:';
const ROUTE=/^al:1:h:(0|[1-9][0-9]{0,2})$|^al:1:([dgrxpqts]):([A-Za-z0-9_-]{24})$|^al:1:z:([A-Za-z0-9_-]{24})$/u,NEW_ROUTE=/^al:1:n:(notifications|control|central)$/u,QUIET_CONFIRM=/^al:1:y:([A-Za-z0-9_-]{24})$/u,DAILY_CONFIRM=/^al:1:v:([A-Za-z0-9_-]{24})$/u,REVOKE_FINAL=/^al:1:w:([A-Za-z0-9_-]{24})$/u;
export const validAdminRoomRoute=(v:string)=>ROUTE.exec(v)?.[0]===v||NEW_ROUTE.exec(v)?.[0]===v||QUIET_CONFIRM.exec(v)?.[0]===v||DAILY_CONFIRM.exec(v)?.[0]===v||REVOKE_FINAL.exec(v)?.[0]===v;
type Screen=OwnerInlineScreen&{access:AdminUIAccess};
const modes={NOTIFICATIONS:'إشعارات',CONTROL:'تحكم',CENTRAL:'إدارة مركزية'};
const statuses={PENDING_GROUP:'بانتظار المجموعة',PENDING_ROOM:'بانتظار الغرفة',ACTIVE:'التفويضان مسجلان',CONFLICT:'تعارض يمنع الربط',EXPIRED:'انتهى الطلب',REVOKED:'ملغى'};
export class TelegramAdminRoomLinks{
 private readonly service:AdminRoomLinks;
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number,private readonly gateway?:TelegramBotApiModerationGateway,private readonly safety:()=>Promise<boolean>=async()=>false){this.service=new AdminRoomLinks(store,policy,clock);}
 async cancel(actor:string):Promise<void>{const snap=await this.store.snapshot();if(!snap.callbacks.some(c=>c.actorId===actor&&(c.ref.startsWith(PREFIX)||c.ref.startsWith(QUIET)||c.ref.startsWith(DAILY))&&!c.used&&!c.revoked)&&!snap.wizards.some(w=>w.key===CHECK+actor&&w.status==='ACTIVE'))return;await this.store.transaction(s=>{for(const c of s.callbacks)if(c.actorId===actor&&(c.ref.startsWith(PREFIX)||c.ref.startsWith(QUIET)||c.ref.startsWith(DAILY))&&!c.used)c.revoked=true;for(const w of s.wizards)if(w.key===CHECK+actor)w.status='CANCELLED';});}
 private async view(actor:string,text:string,keyboard:OwnerInlineScreen['keyboard'],expected:string,deadline?:number):Promise<Screen|null>{const s=await this.store.snapshot(),now=this.clock(),epoch=protectionUIEpoch(s,this.policy,actor,now),expiresAt=Math.min(now+TTL,deadline??now+TTL);return epoch&&epoch===expected&&Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-TTL&&Number.isSafeInteger(expiresAt)&&expiresAt>now?{text,keyboard,access:{actorId:actor,epoch,expiresAt}}:null;}
 private async confirmRevoke(actor:string,token:string,final:boolean):Promise<Screen|null>{
  const nextToken=randomBytes(18).toString('base64url');
  const claim=await this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===PREFIX+token),c=rows[0];
   if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.used!==false||c.revoked!==false||c.oneShot!==true||!Number.isSafeInteger(now))return null;
   const m=/^admin-room:revoke-preview:([A-Za-z0-9_-]{24}):([a-f0-9]{64}):(0|[1-9][0-9]{0,15}):([12])$/u.exec(c.action);
   if(!m||m[0]!==c.action||m[4]!== (final?'2':'1'))return null;
   const createdAt=Number(m[3]),expiresAt=createdAt+TTL;
   if(!Number.isSafeInteger(createdAt)||createdAt<0||createdAt>8640000000000000-TTL||c.expiresAt!==expiresAt||now<createdAt||now>=expiresAt||adminRoomRevokeWitness(s,this.policy,actor,m[1]!,now)!==m[2])return null;
   c.used=true;
   if(!final){for(const other of s.callbacks)if(other.actorId===actor&&other.ref.startsWith(PREFIX)&&!other.used)other.revoked=true;s.callbacks.push({ref:PREFIX+nextToken,action:PREFIX+m[1]+':'+m[2]+':'+createdAt+':2',chatId:'private',actorId:actor,policyVersion:0,expiresAt,oneShot:true,used:false,revoked:false});}
   return {id:m[1]!,witness:m[2]!,createdAt,expiresAt};
  });
  if(!claim)return null;
  if(final){if(!await this.service.revoke(actor,claim.id,claim))return null;return this.handle(actor,'al:1:h:0');}
  const state=await this.store.snapshot(),at=this.clock(),epoch=protectionUIEpoch(state,this.policy,actor,at),row=(await this.service.visible(actor)).find(r=>r.id===claim.id&&r.canRevoke);
  if(!epoch||!row||at<claim.createdAt||at>=claim.expiresAt||adminRoomRevokeWitness(state,this.policy,actor,claim.id,at)!==claim.witness)return null;
  return this.view(actor,'<b>التأكيد الثاني والأخير لقطع الربط</b>\nالمجموعة: <code>'+row.group+'</code>\nالغرفة: <code>'+row.room+'</code>\nالوضع: '+modes[row.mode]+'\nسيُلغى تفويض هذا الوضع فور الاعتماد. الأوضاع المستقلة الأخرى تبقى بتفويضها.',{inline_keyboard:[[{text:'🛑 تأكيد نهائي — قطع الربط',callback_data:'al:1:w:'+nextToken}],[{text:'↩️ إلغاء والرجوع',callback_data:'al:1:d:'+row.id}]]},epoch,claim.expiresAt);
 }
 async create(actor:string,text:string):Promise<Screen|null>{
  const m=/^\/adminlink (-[1-9][0-9]{0,15}) (-[1-9][0-9]{0,15}) (notifications|control|central)$/u.exec(text);if(!m||m[0]!==text)return null;
  const mode=m[3]!.toUpperCase() as AdminRoomMode,id=await this.service.propose(actor,m[1]!,m[2]!,mode);return id?this.handle(actor,'al:1:d:'+id):null;
 }
 async handle(actor:string,data:string):Promise<Screen|null>{
  if(data==='mi:1:i:01:04'){if(!this.policy.isOwner(actor))return null;data='al:1:h:0';}
  const revokeFinal=REVOKE_FINAL.exec(data);if(revokeFinal?.[0]===data)return this.confirmRevoke(actor,revokeFinal[1]!,true);
  const dailyConfirm=DAILY_CONFIRM.exec(data);if(dailyConfirm?.[0]===data){const claim=await this.store.transaction(s=>{const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===DAILY+dailyConfirm[1]),c=rows[0];if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.used!==false||c.revoked!==false||c.oneShot!==true||!Number.isSafeInteger(now)||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;const m=/^admin-room:daily-preview:([A-Za-z0-9_-]{24}):(0|[a-f0-9]{64}):([01])$/u.exec(c.action);if(!m||m[0]!==c.action)return null;c.used=true;return {id:m[1]!,witness:m[2]!,enabled:m[3]==='1'};});if(!claim||!await this.service.setDaily(actor,claim.id,claim.witness,claim.enabled))return null;return this.handle(actor,'al:1:d:'+claim.id);}
  const quietConfirm=QUIET_CONFIRM.exec(data);if(quietConfirm?.[0]===data){const claim=await this.store.transaction(s=>{const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===QUIET+quietConfirm[1]),c=rows[0];if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.used!==false||c.revoked!==false||c.oneShot!==true||!Number.isSafeInteger(now)||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;const m=/^admin-room:quiet-preview:([A-Za-z0-9_-]{24}):(0|[a-f0-9]{64}):([01])$/u.exec(c.action);if(!m||m[0]!==c.action)return null;c.used=true;return {id:m[1]!,witness:m[2]!,quiet:m[3]==='1'};});if(!claim||!await this.service.setQuiet(actor,claim.id,claim.witness,claim.quiet))return null;return this.handle(actor,'al:1:d:'+claim.id);}
  const choice=NEW_ROUTE.exec(data);if(choice?.[0]===data){const s=await this.store.snapshot(),now=this.clock(),epoch=protectionUIEpoch(s,this.policy,actor,now);if(!epoch)return null;const mode=choice[1]!.toUpperCase() as AdminRoomMode;
   return this.view(actor,'<b>طلب ربط — '+modes[mode]+'</b>\nأرسل في الخاص الأمر التالي بعد استبدال الرقمين:\n<code>/adminlink رقم_المجموعة رقم_الغرفة '+choice[1]+'</code>\nمثال: <code>/adminlink -100123 -100456 '+choice[1]+'</code>\nالمجموعتان يجب أن تكونا معتمدتين للإشراف. يصدر الطلب دون تشغيل الإرسال أو التحكم، ويتطلب موافقتين منفصلتين.',{inline_keyboard:[[{text:'↩️ غرف الإدارة',callback_data:'al:1:h:0'}]]},epoch);
  }
  const match=ROUTE.exec(data);if(!match||match[0]!==data)return null;
  if(match[4]){
   return this.confirmRevoke(actor,match[4],false);
  }
  if(match[2]==='g'||match[2]==='r'){if(!await this.service.approve(actor,match[3]!,match[2]==='g'?'GROUP':'ROOM'))return null;return this.handle(actor,'al:1:d:'+match[3]);}
  const before=await this.store.snapshot(),now=this.clock(),epoch=protectionUIEpoch(before,this.policy,actor,now);if(!epoch)return null;const entries=await this.service.visible(actor);
  if(match[2]){const row=entries.find(e=>e.id===match[3]);if(!row)return null;
   if(match[2]==='s'){
    if(row.status!=='ACTIVE'||row.mode!=='NOTIFICATIONS'||typeof row.daily!=='boolean'||!row.dailyWitness)return null;const token=randomBytes(18).toString('base64url'),created=await this.store.transaction(s=>{const at=this.clock();if(protectionUIEpoch(s,this.policy,actor,at)!==epoch||!Number.isSafeInteger(at)||at<now||at>8640000000000000-TTL)return false;for(const c of s.callbacks)if(c.actorId===actor&&(c.ref.startsWith(PREFIX)||c.ref.startsWith(QUIET)||c.ref.startsWith(DAILY))&&!c.used)c.revoked=true;s.callbacks.push({ref:DAILY+token,action:DAILY+row.id+':'+row.dailyWitness+':'+(row.daily?'0':'1'),chatId:'private',actorId:actor,policyVersion:0,expiresAt:at+TTL,oneShot:true,used:false,revoked:false});return true;});if(!created)return null;
    const state=await this.store.snapshot(),next=protectionUIEpoch(state,this.policy,actor,this.clock());return next?this.view(actor,row.daily?'تأكيد إيقاف الملخص اليومي لهذه الغرفة؟':'تأكيد إرسال ملخص يومي لهذه الغرفة؟ يبدأ بعد 24 ساعة، ويتضمن أعداد البلاغات والتحذيرات فقط، وقد يصل حتى عند تفعيل الوضع الصامت.',{inline_keyboard:[[{text:'✅ تأكيد',callback_data:'al:1:v:'+token}],[{text:'↩️ تفاصيل الطلب',callback_data:'al:1:d:'+row.id}]]},next):null;
   }
   if(match[2]==='t'){
    if(row.status!=='ACTIVE'||row.mode!=='NOTIFICATIONS')return null;const summary=await this.service.summary(actor,row.id);if(!summary)return null;
    return this.view(actor,'<b>ملخص المجموعة خلال 24 ساعة</b>\nالمجموعة: <code>'+summary.group+'</code>\nالبلاغات المسجلة: '+summary.reports+'\nالتحذيرات المسجلة: '+summary.warnings+'\nالإجراءات المؤكدة: '+summary.actions+'\nتعديلات الأذونات: '+summary.changes+'\nرفض التنفيذ: '+summary.failures+'\nالنتائج غير المحسومة: '+summary.incidents+'\nيُحتسب السجل المحفوظ، بما فيه التحذيرات الملغاة، ولا تظهر هويات الأعضاء أو محتوى الرسائل. هذا عرض عند الطلب وليس إرسالًا دوريًا.',{inline_keyboard:[[{text:'↩️ تفاصيل الطلب',callback_data:'al:1:d:'+row.id}]]},epoch);
   }
   if(match[2]==='q'){
    if(row.status!=='ACTIVE'||row.mode!=='NOTIFICATIONS'||typeof row.quiet!=='boolean'||!row.quietWitness)return null;const token=randomBytes(18).toString('base64url'),created=await this.store.transaction(s=>{const at=this.clock();if(protectionUIEpoch(s,this.policy,actor,at)!==epoch||!Number.isSafeInteger(at)||at<now||at>8640000000000000-TTL)return false;for(const c of s.callbacks)if(c.actorId===actor&&(c.ref.startsWith(PREFIX)||c.ref.startsWith(QUIET))&&!c.used)c.revoked=true;s.callbacks.push({ref:QUIET+token,action:QUIET+row.id+':'+row.quietWitness+':'+(row.quiet?'0':'1'),chatId:'private',actorId:actor,policyVersion:0,expiresAt:at+TTL,oneShot:true,used:false,revoked:false});return true;});if(!created)return null;
    const state=await this.store.snapshot(),next=protectionUIEpoch(state,this.policy,actor,this.clock());return next?this.view(actor,row.quiet?'تأكيد استئناف تنبيهات الغرفة؟ لا تُستعاد التنبيهات التي أُبطلت أثناء الصمت.':'تأكيد إيقاف تنبيهات الغرفة مؤقتًا؟ ستُبطل التنبيهات المنتظرة، ويبقى التفويض محفوظًا.',{inline_keyboard:[[{text:'✅ تأكيد',callback_data:'al:1:y:'+token}],[{text:'↩️ تفاصيل الطلب',callback_data:'al:1:d:'+row.id}]]},next):null;
   }
   if(match[2]==='p'){
    let privacy:'NO_PUBLIC_USERNAME'|'PUBLIC_USERNAME'|'NOT_GROUP'|'UNKNOWN'='UNKNOWN',rights='تعذر التحقق';
    const flow=CHECK+randomBytes(18).toString('base64url'),claimed=await this.store.transaction(s=>{const at=this.clock();if(!Number.isSafeInteger(at)||at<now||at>=now+TTL||at>8640000000000000-TTL||protectionUIEpoch(s,this.policy,actor,at)!==epoch)return null;s.wizards=s.wizards.filter(w=>w.key!==CHECK+actor);s.wizards.push({key:CHECK+actor,userId:actor,chatId:actor,topicId:'',flow,step:0,version:1,policyVersion:0,expiresAt:at+TTL,status:'ACTIVE'});return protectionUIEpoch(s,this.policy,actor,at);});if(!claimed)return null;
    const current=async()=>{const at=this.clock(),s=await this.store.snapshot(),sessions=s.wizards.filter(w=>w.key===CHECK+actor),w=sessions[0];return Number.isSafeInteger(at)&&at>=now&&at<now+TTL&&sessions.length===1&&!!w&&w.userId===actor&&w.chatId===actor&&w.flow===flow&&w.status==='ACTIVE'&&Number.isSafeInteger(w.expiresAt)&&w.expiresAt>at&&w.expiresAt<=at+TTL&&protectionUIEpoch(s,this.policy,actor,at)===claimed&&(await this.service.visible(actor)).some(e=>e.id===row.id&&e.room===row.room);};
    const safe=async()=>{try{return await this.safety()===true;}catch{return false;}};
    if(this.gateway&&TelegramBotApiModerationGateway.usesOfficialRoomPrivacyRead(this.gateway)&&await safe()&&await current()&&await safe()&&await current()&&TelegramBotApiModerationGateway.usesOfficialRoomPrivacyRead(this.gateway)){
     try{privacy=await this.gateway.inspectRoomPrivacy(row.room);}catch{/* unknown is not proof */}
     if(await safe()&&await current()&&await safe()&&await current()&&TelegramBotApiModerationGateway.usesOfficialRightsRead(this.gateway)){
      try{const r=await this.gateway.inspectBotAdminRights(row.room),explain=(v:string)=>v==='GRANTED'?'متاح':v==='DENIED'?'غير متاح':'غير معروف';rights='حذف الرسائل: '+explain(r.delete)+'، دعوة الأعضاء: '+explain(r.invite)+'، إدارة المشرفين: '+explain(r.promote);}catch{/* remain unknown */}
     }
     if(!await safe()||!await current()||!TelegramBotApiModerationGateway.usesOfficialRoomPrivacyRead(this.gateway))return null;
     if(!TelegramBotApiModerationGateway.usesOfficialRightsRead(this.gateway))rights='تعذر التحقق';
    }
    const description={NO_PUBLIC_USERNAME:'لم يُرصد معرّف عام في لحظة الفحص',PUBLIC_USERNAME:'للغرفة معرّف عام',NOT_GROUP:'الوجهة ليست مجموعة',UNKNOWN:'تعذر التحقق'}[privacy];
    if(!await current())return null;return this.view(actor,'<b>فحص غرفة الإدارة</b>\nالغرفة: <code>'+row.room+'</code>\nالظهور: '+description+'\nحقوق البوت الإدارية: '+rights+'\nقراءة استشارية لحظية؛ قد تتغير الحقوق والظهور، وقد تسمح روابط الدعوة بدخول أشخاص آخرين. لا يفعّل الفحص إرسالًا أو تحكمًا.',{inline_keyboard:[[{text:'🔄 إعادة الفحص',callback_data:'al:1:p:'+row.id}],[{text:'↩️ تفاصيل الطلب',callback_data:'al:1:d:'+row.id}]]},claimed);
   }
   if(match[2]==='x'){
    if(!row.canRevoke)return null;const token=randomBytes(18).toString('base64url'),created=await this.store.transaction(s=>{const at=this.clock(),witness=adminRoomRevokeWitness(s,this.policy,actor,row.id,at);if(!witness||protectionUIEpoch(s,this.policy,actor,at)!==epoch||!Number.isSafeInteger(at)||at<now||at>8640000000000000-TTL)return false;for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used)c.revoked=true;s.callbacks.push({ref:PREFIX+token,action:PREFIX+row.id+':'+witness+':'+at+':1',chatId:'private',actorId:actor,policyVersion:0,expiresAt:at+TTL,oneShot:true,used:false,revoked:false});return true;});if(!created)return null;
    const state=await this.store.snapshot(),next=protectionUIEpoch(state,this.policy,actor,this.clock());return next?this.view(actor,'<b>التأكيد الأول لقطع الربط</b>\nالمجموعة: <code>'+row.group+'</code>\nالغرفة: <code>'+row.room+'</code>\nالوضع: '+modes[row.mode]+'\nتابع إلى التأكيد النهائي أو ارجع لإلغاء الطلب.',{inline_keyboard:[[{text:'✅ التأكيد الأول — متابعة',callback_data:'al:1:z:'+token}],[{text:'↩️ إلغاء والرجوع',callback_data:'al:1:d:'+row.id}]]},next):null;
   }
   const buttons:{text:string;callback_data:string}[][]=[];if(row.canApproveGroup)buttons.push([{text:'✅ موافقة المجموعة',callback_data:'al:1:g:'+row.id}]);if(row.canApproveRoom)buttons.push([{text:'✅ موافقة الغرفة',callback_data:'al:1:r:'+row.id}]);buttons.push([{text:'🔎 فحص الغرفة',callback_data:'al:1:p:'+row.id}]);if(row.status==='ACTIVE'&&typeof row.quiet==='boolean')buttons.push([{text:row.quiet?'🔔 استئناف التنبيهات':'🔕 الوضع الصامت',callback_data:'al:1:q:'+row.id}],[{text:'📊 ملخص آخر 24 ساعة',callback_data:'al:1:t:'+row.id}]);if(row.status==='ACTIVE'&&row.mode==='NOTIFICATIONS'&&this.policy.has(before,actor,'chat.manage',row.group,now)&&this.policy.privateFeature(before,'support.use',actor))buttons.push([{text:'👤 مناوبة البلاغات',callback_data:'oc:1:g:'+row.id}]);if(row.status==='ACTIVE'&&typeof row.daily==='boolean')buttons.push([{text:row.daily?'🛑 إيقاف الملخص اليومي':'📅 تفعيل الملخص اليومي',callback_data:'al:1:s:'+row.id}]);if(row.canRevoke)buttons.push([{text:'🛑 قطع التفويض',callback_data:'al:1:x:'+row.id}]);buttons.push([{text:'↩️ الطلبات',callback_data:'al:1:h:0'}]);
   if(row.status==='ACTIVE'&&row.mode==='CONTROL'&&this.policy.has(before,actor,'chat.manage',row.group,now)&&this.policy.has(before,actor,'chat.manage',row.room,now))buttons.splice(buttons.length-1,0,[{text:'📋 بلاغات غرفة التحكم',callback_data:'rc:1:h:'+row.room+':0'}]);
   return this.view(actor,'<b>تفويض غرفة الإدارة</b>\nالمجموعة: <code>'+row.group+'</code>\nالغرفة: <code>'+row.room+'</code>\nالوضع: '+modes[row.mode]+'\nالحالة: '+statuses[row.status]+(typeof row.quiet==='boolean'?'\nالتنبيهات: '+(row.quiet?'صامتة':'مفعّلة حسب الشروط'):'')+(typeof row.daily==='boolean'?'\nالملخص اليومي: '+(row.daily?'مفعّل':'متوقف'):'')+'\nتنبيهات البلاغات والتحذيرات ونتائج إجراءات الإشراف وتعديلات الأذونات متاحة عند تشغيل العامل وتوفر شروطه. التحكم مستقل عن الإشعارات: استخدم /roomreports في الغرفة لفتح الصندوق الخاص، أو أزرار البلاغات عند ربط الإشعارات بالغرفة نفسها.\nللإدارة المركزية أرسل في الخاص: <code>/centralban '+row.room+' رقم_العضو مدة_بالثواني</code> ثم اختر المجموعات بالأزرار، أو أضف حتى 8 معرّفات مجموعات محددة للأمر لفتح المعاينة مباشرةً.\nتحتاج كل مجموعة تفويض CENTRAL مستقلًا للغرفة وصلاحيتك في الطرفين. فحص الغرفة استشاري.',{inline_keyboard:buttons},epoch);
  }
  const page=Number(match[1]),pages=Math.max(1,Math.ceil(entries.length/8));if(page>=pages||page>999)return null;const keyboard=entries.slice(page*8,page*8+8).map(e=>[{text:modes[e.mode]+' · '+e.group+' · '+statuses[e.status],callback_data:'al:1:d:'+e.id}]);if(page>0)keyboard.push([{text:'⬅️ السابق',callback_data:'al:1:h:'+(page-1)}]);if(page+1<pages&&page<999)keyboard.push([{text:'➡️ التالي',callback_data:'al:1:h:'+(page+1)}]);keyboard.push([{text:'🔔 طلب إشعارات',callback_data:'al:1:n:notifications'},{text:'🎛 طلب تحكم',callback_data:'al:1:n:control'}],[{text:'🌐 طلب إدارة مركزية',callback_data:'al:1:n:central'}]);keyboard.push([{text:'↩️ المجموعات والشبكات',callback_data:this.policy.isOwner(actor)?'mi:1:s:01:0':'pn:1:h'}]);
  return this.view(actor,'<b>تفويضات غرف الإدارة</b>\nاختر وضعًا لإنشاء طلب جديد، أو افتح طلبًا مسجلًا. تؤكد المجموعة أولًا ثم الغرفة خلال عشر دقائق. الإشعارات والتحكم والإدارة المركزية تفويضات مستقلة. كل إجراء يحتاج صلاحيتك الحالية ومراجعته الخاصة.',{inline_keyboard:keyboard},epoch);
 }
}
