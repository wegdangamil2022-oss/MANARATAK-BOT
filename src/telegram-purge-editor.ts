import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore,PurgeFilter,PurgeJob} from './store.js';
import type {Policy} from './policy.js';
import {isValidPurgeFilter,purgeReviewDigest,type ModerationPurgeService} from './moderation-purge.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';

const PREFIX='purge-editor:',TTL=120000;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const openJob=new RegExp('^pc:1:j:('+uuid+'):([a-f0-9]{16})$','u');
const nonce=()=>randomBytes(18).toString('base64url');
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const member=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-TTL;
const kinds={ALL:'كل الأنواع',LINKS:'روابط',MEDIA:'وسائط',COMMANDS:'أوامر'} as const;
const stateNames:Record<PurgeJob['status'],string>={PREVIEW:'معاينة',READY:'معتمدة',PAUSED:'متوقفة للمراجعة',CANCELLED:'ملغاة',COMPLETED:'مكتملة'};
const date=(value:number|undefined)=>value===undefined?'غير محدد':new Intl.DateTimeFormat('ar-YE',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(value)+' (UTC)';
type Options={chat:string;type:keyof typeof kinds;age:number;limit:number;sender:string};
type Step={kind:'groups';page:number}|{kind:'edit'|'senders'|'preview';options:Options;page:number}|{kind:'job'|'confirm'|'dispatch'|'cancel';job:string;digest:string};
type Screen=OwnerInlineScreen&{access:AdminUIAccess;status:'APPLIED'|'DENIED'|'UNKNOWN';reason:string};
export const validPurgeEditorRoute=(data:string)=>data==='pc:1:h'||/^pc:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data||openJob.exec(data)?.[0]===data;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function validStep(v:unknown):v is Step{
 if(!object(v))return false;
 if(v.kind==='groups')return Object.keys(v).sort().join(',')==='kind,page'&&Number.isSafeInteger(v.page)&&Number(v.page)>=0&&Number(v.page)<=999;
 if(['job','confirm','dispatch','cancel'].includes(String(v.kind)))return Object.keys(v).sort().join(',')==='digest,job,kind'&&typeof v.job==='string'&&new RegExp('^'+uuid+'$','u').exec(v.job)?.[0]===v.job&&typeof v.digest==='string'&&/^[a-f0-9]{16}$/u.exec(v.digest)?.[0]===v.digest;
 if(!['edit','senders','preview'].includes(String(v.kind))||Object.keys(v).sort().join(',')!=='kind,options,page'||!Number.isSafeInteger(v.page)||Number(v.page)<0||Number(v.page)>999||!object(v.options))return false;
 const o=v.options;return Object.keys(o).sort().join(',')==='age,chat,limit,sender,type'&&group(o.chat)&&Object.hasOwn(kinds,String(o.type))&&[600000,3600000,86400000,172800000].includes(Number(o.age))&&typeof o.age==='number'&&[1,5,10,25].includes(Number(o.limit))&&typeof o.limit==='number'&&(o.sender===''||member(o.sender));
}
const epoch=(s:BotState)=>createHash('sha256').update(JSON.stringify([s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision])).digest('hex');
const permitted=(s:BotState,p:Policy,actor:string)=>p.isOwner(actor)&&p.privateFeature(s,'owner.dashboard',actor);
const groups=(s:BotState,p:Policy,actor:string,now:number)=>s.chats.filter(c=>group(c.id)&&s.chats.filter(x=>x.id===c.id).length===1&&p.canUseChat(s,c.id,'moderation')&&p.has(s,actor,'chat.manage',c.id,now)).sort((a,b)=>a.id.localeCompare(b.id));
function filter(o:Options,now:number):PurgeFilter{return {limit:o.limit,sentAfter:Math.max(0,now-o.age),sentBefore:now+1,...(o.sender?{senderId:o.sender}:{}),...(o.type==='LINKS'?{linksOnly:true}:o.type==='MEDIA'?{mediaOnly:true}:o.type==='COMMANDS'?{commandsOnly:true}:{})};}
function validJob(j:PurgeJob):boolean{
 return isValidPurgeFilter(j.filter)&&time(j.createdAt)&&time(j.expiresAt)&&j.expiresAt>j.createdAt&&j.expiresAt-j.createdAt<=600000&&['PREVIEW','READY','PAUSED','CANCELLED','COMPLETED'].includes(j.status)&&Array.isArray(j.items)&&j.items.length>=1&&j.items.length<=25&&j.items.every(i=>i&&Number.isSafeInteger(i.messageId)&&i.messageId>0&&['QUEUED','SENDING','ACKNOWLEDGED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','SKIPPED_UNVERIFIED','CANCELLED'].includes(i.status))&&new Set(j.items.map(i=>i.messageId)).size===j.items.length&&Number.isSafeInteger(j.excluded?.protected)&&j.excluded.protected>=0;
}

/** Private owner controls only; the injected service owns all deletion evidence,
 * quotas, protection flags, durable claims and provider outcome handling. */
export class TelegramPurgeEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly purge:ModerationPurgeService|undefined,private readonly clock:()=>number){}
 async cancel(actor:string):Promise<void>{
  const state=await this.store.snapshot();if(!state.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith(PREFIX))&&!state.wizards.some(w=>w.key===PREFIX+actor&&w.status==='ACTIVE'))return;
  await this.store.transaction(s=>{
  s.callbacks=s.callbacks.filter(c=>c.actorId!==actor||!c.ref.startsWith(PREFIX));
  for(const w of s.wizards)if(w.key===PREFIX+actor)w.status='CANCELLED';
 });}
 async handle(actor:string,data:string):Promise<Screen|null>{
  if(!this.policy.isOwner(actor)||!validPurgeEditorRoute(data))return null;
  const request=await this.store.transaction(s=>{
   const now=this.clock();if(!time(now)||!permitted(s,this.policy,actor))return null;
   let step:Step;const selected=openJob.exec(data);
   if(data==='pc:1:h')step={kind:'groups',page:0};
   else if(selected?.[0]===data)step={kind:'job',job:selected[1]!,digest:selected[2]!};
   else{
    const controls=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(5)),c=controls[0];
    if(controls.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.oneShot!==true||c.used!==false||c.revoked!==false||!time(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL||!c.action.startsWith(PREFIX))return null;
    let v:unknown;try{v=JSON.parse(c.action.slice(PREFIX.length));}catch{return null;}
    if(!Array.isArray(v)||v.length!==3||!validStep(v[0])||v[1]!==epoch(s)||typeof v[2]!=='string')return null;
    const sessions=s.wizards.filter(w=>w.key===PREFIX+actor);if(sessions.length!==1||sessions[0]!.status!=='ACTIVE'||sessions[0]!.flow!==v[2]||sessions[0]!.expiresAt!==c.expiresAt)return null;
    c.used=true;step=v[0];
   }
   // Old controls cannot be used again; drop their sender selections as well.
   s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.actorId!==actor&&c.expiresAt>now);
   const session=PREFIX+nonce(),expiresAt=now+TTL;
   s.wizards=s.wizards.filter(w=>w.key!==PREFIX+actor);s.wizards.push({key:PREFIX+actor,userId:actor,chatId:actor,topicId:'',flow:session,step:0,version:1,policyVersion:0,expiresAt,status:'ACTIVE'});
   return {step,session,expiresAt,epoch:epoch(s),now};
  });
  if(!request)return null;
  const current=(s:BotState)=>{
   const now=this.clock(),sessions=s.wizards.filter(w=>w.key===PREFIX+actor),w=sessions[0];
   return time(now)&&now>=request.now&&now<request.expiresAt&&permitted(s,this.policy,actor)&&epoch(s)===request.epoch&&sessions.length===1&&w?.userId===actor&&w.chatId===actor&&w.flow===request.session&&w.status==='ACTIVE'&&w.expiresAt===request.expiresAt;
  };
  let step=request.step,note='',status:Screen['status']='APPLIED',reason='PURGE_EDITOR_VIEW';
  try{
   if(this.purge&&step.kind==='preview'){
    const job=await this.purge.preview(actor,step.options.chat,filter(step.options,request.now),current);step={kind:'job',job:job.id,digest:purgeReviewDigest(job)};
   }else if(this.purge&&['confirm','dispatch','cancel'].includes(step.kind)&&'job' in step){
    const jobId=step.job,s=await this.store.snapshot(),jobs=s.purgeJobs.filter(j=>j.id===jobId),job=jobs[0];
    if(!current(s)||jobs.length!==1||!job||!validJob(job)||job.actorId!==actor||Object.hasOwn(job,'automatic')||purgeReviewDigest(job)!==step.digest)return null;
    if(step.kind==='confirm'){await this.purge.confirm(actor,job.id,step.digest,current);reason='PURGE_PLAN_APPROVED';}
    if(step.kind==='dispatch'){if(job.status!=='READY')return null;const result=await this.purge.dispatchNext(job.id,current);status=result.status==='ACKNOWLEDGED'?'APPLIED':result.status==='UNKNOWN_OUTCOME'||result.status==='BLOCKED_UNKNOWN'?'UNKNOWN':'DENIED';reason='PURGE_'+result.status;note=result.status==='ACKNOWLEDGED'?'قُبل طلب الرسالة المحددة؛ لا يثبت ذلك الحذف المادي.':status==='UNKNOWN'?'النتيجة غير مؤكدة؛ لن تعاد هذه المحاولة.':'لم يُعتمد نجاح الطلب؛ راجع حالة الخطة قبل المحاولة من جديد.';}
    if(step.kind==='cancel'){await this.purge.cancel(actor,job.id);reason='PURGE_PLAN_CANCELLED';}
    step={kind:'job',job:job.id,digest:step.digest};
   }
  }catch(error){
   // Empty observed sets are an expected outcome, never an invitation to fetch history.
   if(step.kind!=='preview'||!(error instanceof Error)||error.message!=='NO_ELIGIBLE_OBSERVED_MESSAGES')return null;
   note='لا توجد رسائل ملاحظة مؤهلة بهذه الفلاتر؛ لم يُنشأ طلب حذف.';step={...step,kind:'edit'};
  }
  return this.store.transaction(s=>{
   if(!current(s))return null;
   const now=this.clock(),available=groups(s,this.policy,actor,now),rows:{text:string;callback_data:string}[][]=[];
   const b=(text:string,next:Step)=>{const ref=PREFIX+nonce();s.callbacks.push({ref,actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:request.expiresAt,action:PREFIX+JSON.stringify([next,request.epoch,request.session])});return {text,callback_data:'pc:1:'+ref.slice(PREFIX.length)};};
   let text=note?note+'\n':'';
   if(!this.purge)text+='موصل الحذف غير مهيأ في التطبيق؛ لم تتغير أي رسالة.';
   else if(step.kind==='groups'){
    const pages=Math.max(1,Math.ceil(available.length/8));if(step.page>=pages)return null;
    text+='اختر مجموعة لتنظيف الرسائل الملاحظة فقط — صفحة '+(step.page+1)+' من '+pages+'. لا جلب لتاريخ المجموعة.';
    for(const chat of available.slice(step.page*8,step.page*8+8))rows.push([b(chat.id,{kind:'edit',page:0,options:{chat:chat.id,type:'ALL',age:3600000,limit:5,sender:''}})]);
    if(step.page>0)rows.push([b('⬅️ السابق',{...step,page:step.page-1})]);if(step.page+1<pages)rows.push([b('➡️ التالي',{...step,page:step.page+1})]);
   }else if('options' in step){
    const o=step.options;if(!available.some(c=>c.id===o.chat))return null;
    if(step.kind==='senders'){
     const senders=[...new Set(s.rollingMessageMeta.filter(m=>m.chatId===o.chat&&m.senderKind==='USER'&&member(m.senderId)&&m.sentAt>now-172800000&&m.sentAt<=now).map(m=>m.senderId!))].sort();
     const pages=Math.max(1,Math.ceil(senders.length/8));if(step.page>=pages)return null;text+='اختيار مرسل من الفهرس الملاحظ — صفحة '+(step.page+1)+' من '+pages;
     for(const sender of senders.slice(step.page*8,step.page*8+8))rows.push([b(sender,{kind:'edit',page:0,options:{...o,sender}})]);
     if(step.page>0)rows.push([b('⬅️ السابق',{...step,page:step.page-1})]);if(step.page+1<pages)rows.push([b('➡️ التالي',{...step,page:step.page+1})]);
     rows.push([b('كل المرسلين',{kind:'edit',page:0,options:{...o,sender:''}}),b('↩️ الفلاتر',{kind:'edit',page:0,options:o})]);
    }else{
     text+='فلاتر التنظيف\nالمجموعة: '+o.chat+'\nالنوع: '+kinds[o.type]+'\nالمرسل: '+(o.sender||'الكل')+'\nآخر '+o.age/60000+' دقيقة بحسب تاريخ الإرسال\nالحد: '+o.limit+' رسالة. لا حذف قبل المعاينة والاعتماد والتنفيذ المنفصل.';
     rows.push(Object.entries(kinds).map(([kind,label])=>b((o.type===kind?'✅ ':'')+label,{kind:'edit',page:0,options:{...o,type:kind as Options['type']}})));
     rows.push(([['10 دقائق',600000],['ساعة واحدة',3600000],['يوم واحد',86400000],['48 ساعة',172800000]] as const).map(([label,age])=>b((o.age===age?'✅ ':'')+label,{kind:'edit',page:0,options:{...o,age}})));
     rows.push([1,5,10,25].map(limit=>b((o.limit===limit?'✅ ':'')+'حد '+limit+' رسالة',{kind:'edit',page:0,options:{...o,limit}})));
     rows.push([b('👤 اختيار مرسل',{kind:'senders',page:0,options:o}),b('👁️ معاينة العدد',{kind:'preview',page:0,options:o})]);
    }
    rows.push([b('↩️ اختيار المجموعة',{kind:'groups',page:0})]);
   }else if('job' in step){
    const jobs=s.purgeJobs.filter(j=>j.id===step.job),job=jobs[0];if(jobs.length!==1||!job||!validJob(job)||job.actorId!==actor||Object.hasOwn(job,'automatic')||purgeReviewDigest(job)!==step.digest||!available.some(c=>c.id===job.chatId))return null;
    text+=this.describe(job);
    const sameScope=job.scopeVersion===this.policy.chatRevision(s,job.chatId)&&now>=job.createdAt;
    if(!sameScope)text+='\nتغير اعتماد المجموعة أو توقيت الخطة؛ أنشئ معاينة جديدة قبل التنفيذ.';
    const next=(kind:'confirm'|'dispatch'|'cancel'):Step=>({kind,job:job.id,digest:purgeReviewDigest(job)});
    if(sameScope&&job.status==='PREVIEW'&&now<job.expiresAt)rows.push([b('✅ اعتماد الخطة دون إرسال',next('confirm'))]);
    if(sameScope&&job.status==='READY'&&job.items.find(i=>i.status!=='ACKNOWLEDGED'&&i.status!=='CANCELLED'&&i.status!=='SKIPPED_UNVERIFIED')?.status==='QUEUED')rows.push([b('▶️ تنفيذ الرسالة التالية فقط',next('dispatch'))]);
    if(!['CANCELLED','COMPLETED'].includes(job.status))rows.push([b('⏹ إلغاء الخطة المتبقية',next('cancel'))]);
   }
   rows.push([{text:'↩️ معاينات الحذف',callback_data:'pq:1:h'},{text:'↩️ قسم الحماية',callback_data:'mi:1:s:02:1'}]);
   const own=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(PREFIX));if(own.length>128){const remove=new Set(own.slice(0,own.length-128).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));}
   const access=protectionUIEpoch(s,this.policy,actor,now);return access?{text,status,reason,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch:access,expiresAt:request.expiresAt}}:null;
  });
 }
 private describe(j:PurgeJob):string{
  const types=[j.filter.linksOnly?'روابط':'',j.filter.mediaOnly?'وسائط':'',j.filter.commandsOnly?'أوامر':''].filter(Boolean).join(' + ')||'كل الأنواع';
  return 'خطة تنظيف مفلترة\nالمجموعة: '+j.chatId+'\nالحالة: '+stateNames[j.status]+'\nالمحددة: '+j.items.length+'\nالمحمية المستبعدة: '+j.excluded.protected+'\nأرقام الرسائل: '+j.items.map(i=>i.messageId).join('، ')+'\nالمرسل: '+(j.filter.senderId??'الكل')+'\nالنوع: '+types+'\nالحد: '+j.filter.limit+(j.filter.beforeMessageId===undefined?'':'\nمعرّف الرسالة قبل: '+j.filter.beforeMessageId)+'\nوقت الإرسال من: '+date(j.filter.sentAfter)+'\nوقت الإرسال قبل: '+date(j.filter.sentBefore)+'\nطلبات مقبولة: '+j.items.filter(i=>i.status==='ACKNOWLEDGED').length+'\nغير مؤكدة: '+j.items.filter(i=>i.status==='UNKNOWN_OUTCOME').length+'\nكل ضغطة تنفيذ تطلب حذف رسالة واحدة فقط؛ النتيجة المجهولة لا تعاد. الإلغاء لا يرجع رسالة حُذفت بالفعل.';
 }
}
