import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {SubscriptionGate} from './subscription.js';
import {isCanonicalSubscriptionRule} from './subscription-integrity.js';
import {subscriptionConfigEpoch} from './subscription-config-epoch.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
const PREFIX='subscription-editor:',TTL=120000;
type Step={kind:'groups'|'edit'|'review'|'confirm';page:number;group:string;channels:string[];mode:'ALL'|'ANY'|'AT_LEAST';minimumCount?:number};
const initial:Step={kind:'groups',page:0,group:'',channels:[],mode:'ALL'};
const basicMode=(step:Step,mode:'ALL'|'ANY'):Step=>{const next={...step,mode};delete next.minimumCount;return next;};
const canonical=(id:string)=>/^-[1-9][0-9]{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
const available=(s:BotState,p:Policy)=>s.chats.filter(c=>canonical(c.id)&&s.chats.filter(x=>x.id===c.id).length===1&&p.canUseChat(s,c.id,'verification')).sort((a,b)=>a.id.localeCompare(b.id));
export const validSubscriptionConfigRoute=(data:string):boolean=>data==='sc:1:h'||/^sc:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
function validStep(v:unknown):v is Step{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const a=v as Record<string,unknown>;
 return Object.keys(a).length===(Object.hasOwn(a,'minimumCount')?6:5)&&['groups','edit','review','confirm'].includes(String(a.kind))&&Number.isSafeInteger(a.page)&&Number(a.page)>=0&&Number(a.page)<=999&&typeof a.group==='string'&&(a.group===''||canonical(a.group))&&Array.isArray(a.channels)&&a.channels.length<=10&&a.channels.every(c=>typeof c==='string'&&canonical(c))&&new Set(a.channels).size===a.channels.length&&((a.mode==='ALL'||a.mode==='ANY')?!Object.hasOwn(a,'minimumCount'):a.mode==='AT_LEAST'&&Number.isSafeInteger(a.minimumCount)&&Number(a.minimumCount)>=1&&Number(a.minimumCount)<=a.channels.length)&&(a.kind==='groups'?a.group===''&&a.channels.length===0:a.group!=='');
}
export async function cancelSubscriptionConfig(store:BotStore,actor:string):Promise<void>{
 await store.transaction(s=>{
  for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX))c.revoked=true;
  for(const w of s.wizards)if(w.userId===actor&&w.chatId===actor&&w.flow.startsWith(PREFIX))w.status='CANCELLED';
 });
}
export async function renderSubscriptionConfig(store:BotStore,policy:Policy,gate:SubscriptionGate|undefined,actor:string,data:string,clock:()=>number):Promise<(OwnerInlineScreen&{access:AdminUIAccess})|null>{
 if(!policy.isOwner(actor))return null;
 const root=data==='mi:1:i:04:02'||data==='mi:1:i:04:04'||data==='sc:1:h';
 if(!root&&!validSubscriptionConfigRoute(data))return null;
 const request=await store.transaction(s=>{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL||!policy.privateFeature(s,'owner.dashboard',actor))return null;
  if(root){for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX))c.revoked=true;return {step:initial,epoch:subscriptionConfigEpoch(s)};}
  const rows=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(5)),c=rows[0];
  if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.oneShot!==true||c.used!==false||c.revoked!==false||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL||!c.action.startsWith(PREFIX))return null;
  let v:unknown;try{v=JSON.parse(c.action.slice(PREFIX.length));}catch{return null;}
  if(!Array.isArray(v)||v.length!==2||!validStep(v[0])||v[1]!==subscriptionConfigEpoch(s))return null;c.used=true;return {step:v[0],epoch:v[1] as string};
 });
 if(!request)return null;let step=request.step,saved=false;
 if(step.kind==='confirm'){
  if(!gate)return null;
  try{await gate.configure(actor,step.group,[...step.channels],step.mode,request.epoch,step.minimumCount);saved=true;step={...step,kind:'edit',page:0};}catch{return null;}
 }
 return store.transaction(s=>{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL||!policy.privateFeature(s,'owner.dashboard',actor)||!saved&&subscriptionConfigEpoch(s)!==request.epoch)return null;
  const epoch=subscriptionConfigEpoch(s),chats=available(s,policy),groups=chats.filter(c=>policy.canUseChat(s,c.id,'navigation'));
  s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>now);const previous=s.callbacks.filter(c=>c.ref.startsWith(PREFIX)&&c.actorId===actor);let created=0;
  const b=(text:string,next:Step)=>{const nonce=randomBytes(18).toString('base64url');created++;s.callbacks.push({ref:PREFIX+nonce,actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+TTL,action:PREFIX+JSON.stringify([next,epoch])});return {text,callback_data:'sc:1:'+nonce};};
  const rows:{text:string;callback_data:string}[][]=[];let text='';
  if(!gate){text='<b>إعداد الاشتراك غير متاح</b>\nخدمة التحقق غير موصولة في هذا التشغيل؛ لم تتغير أي قاعدة.';}
  else if(step.kind==='groups'){
   const pages=Math.max(1,Math.ceil(groups.length/8));if(step.page>=pages)return null;
   text='<b>اختيار مجموعة الاشتراك</b>\nصفحة '+(step.page+1)+' من '+pages+'\nتظهر النطاقات المعتمدة للتصفح والتحقق فقط. لا يغير هذا المحرر اعتماد أي جهة.';
   for(const group of groups.slice(step.page*8,step.page*8+8)){
    const matches=s.subscriptionRequirements.filter(r=>r.chatId===group.id),rule=matches[0];if(matches.length>1||rule&&!isCanonicalSubscriptionRule(rule))continue;
    rows.push([b('👥 '+group.id,{kind:'edit',group:group.id,page:0,channels:rule?[...rule.channelIds]:[],mode:rule?.mode??'ALL',...(rule?.mode==='AT_LEAST'?{minimumCount:rule.minimumCount}:{})})]);
   }
   const nav=[];if(step.page>0)nav.push(b('⬅️ السابق',{...step,page:step.page-1}));if(step.page+1<pages)nav.push(b('➡️ التالي',{...step,page:step.page+1}));if(nav.length)rows.push(nav);
  }else{
   if(!groups.some(c=>c.id===step.group))return null;
   const channels=chats.filter(c=>c.id!==step.group);if(step.channels.some(id=>!channels.some(c=>c.id===id)))return null;
   if(step.kind==='review'){
    text='<b>معاينة شرط الاشتراك</b>\nالمجموعة: <code>'+step.group+'</code>\nالقاعدة: '+(step.channels.length?(step.mode==='ALL'?'جميع الجهات المختارة':step.mode==='ANY'?'جهة واحدة على الأقل':'حد أدنى '+step.minimumCount+' من '+step.channels.length):'تعطيل الشرط')+'\nالمختار: '+step.channels.join('، ')+'\nيتحقق الحفظ من قابلية فحص الجهات المختارة؛ لا يغير عضوية أحد أو ينفذ عقوبة.';
    rows.push([b('✅ حفظ والتحقق من الصلاحيات',{...step,kind:'confirm'})]);
   }else{
    const pages=Math.max(1,Math.ceil(channels.length/8));if(step.page>=pages)return null;
    text=(saved?'<b>حُفظ شرط الاشتراك</b>':'<b>اختيار جهات التحقق</b>')+'\nالمجموعة: <code>'+step.group+'</code>\nالمختار: '+step.channels.length+' من 10\nصفحة '+(step.page+1)+' من '+pages+'\nكل تغيير يحتاج معاينة وتأكيدًا. لا يُفترض نوع الجهة من معرّفها؛ تُستعمل الجهات المعتمدة للتحقق.';
    if(step.mode==='AT_LEAST')text+='\nالحد الأدنى: '+step.minimumCount+' من '+step.channels.length+'\nالجهات المختارة: '+step.channels.join('، ')+'\nإذا بلغ عدد المختار الحد الأدنى، اخفض الحد أو غيّر الوضع قبل إزالة جهة.';
    for(const c of channels.slice(step.page*8,step.page*8+8)){const selected=step.channels.includes(c.id);if(!selected&&step.channels.length===10||selected&&step.mode==='AT_LEAST'&&step.channels.length===step.minimumCount)continue;rows.push([b((selected?'✅ ':'▫️ ')+c.id,{...step,channels:selected?step.channels.filter(id=>id!==c.id):[...step.channels,c.id]})]);}
    const nav=[];if(step.page>0)nav.push(b('⬅️ السابق',{...step,page:step.page-1}));if(step.page+1<pages)nav.push(b('➡️ التالي',{...step,page:step.page+1}));if(nav.length)rows.push(nav);
    rows.push([b('☑️ جميع القنوات',basicMode(step,'ALL')),b('🔘 قناة واحدة على الأقل',basicMode(step,'ANY'))]);
    if(step.channels.length>=2)rows.push([b('🔢 حد أدنى (الافتراضي 2)',{...step,mode:'AT_LEAST',minimumCount:2})]);
    if(step.mode==='AT_LEAST')for(let n=1;n<=step.channels.length;n+=3)rows.push(Array.from({length:Math.min(3,step.channels.length-n+1)},(_,i)=>b('🔢 '+(n+i)+' من '+step.channels.length,{...step,minimumCount:n+i})));
    rows.push([b('👁️ معاينة '+(step.mode==='ALL'?'الكل':step.mode==='ANY'?'واحدة':step.minimumCount+' من '+step.channels.length),{...step,kind:'review'}),b('⏸️ معاينة تعطيل الشرط',{...basicMode(step,step.mode==='ANY'?'ANY':'ALL'),kind:'review',channels:[]})]);
   }
  }
  rows.push([{text:'↩️ إلغاء / مجموعات الاشتراك',callback_data:'sc:1:h'},{text:'↩️ قسم الانضمام',callback_data:'mi:1:s:04:0'}]);
  const remove=new Set(previous.slice(0,Math.max(0,previous.length+created-128)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));
  s.wizards=s.wizards.filter(w=>w.key!==PREFIX+actor);
  if(gate)s.wizards.push({key:PREFIX+actor,userId:actor,chatId:actor,topicId:'',flow:PREFIX+'view:'+randomBytes(12).toString('hex'),step:0,version:1,policyVersion:0,expiresAt:now+TTL,status:'ACTIVE'});
  const proof=protectionUIEpoch(s,policy,actor,now);if(!proof)return null;
  return {text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch:proof,expiresAt:now+TTL}};
 });
}
