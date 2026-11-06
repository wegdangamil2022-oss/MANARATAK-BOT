import {recordSubscriptionEnforcementConsent,subscriptionEnforcementConsent} from './subscription-enforcement-policy.js';
import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {SubscriptionGate,ChannelRights} from './subscription.js';
import {isCanonicalSubscriptionRule} from './subscription-integrity.js';
import {subscriptionConfigEpoch} from './subscription-config-epoch.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import {subscriptionGracePolicy,recordSubscriptionGracePolicy} from './subscription-leave-grace.js';
const PREFIX='subscription-editor:',TTL=120000;
type Step={kind:'groups'|'edit'|'health'|'review'|'confirm'|'enforcementReview'|'enforcementEnable'|'enforcementOffReview'|'enforcementDisable'|'graceReview'|'graceConfirm';page:number;group:string;channels:string[];mode:'ALL'|'ANY'|'AT_LEAST';minimumCount?:number;graceSeconds?:number};
const initial:Step={kind:'groups',page:0,group:'',channels:[],mode:'ALL'};
const basicMode=(step:Step,mode:'ALL'|'ANY'):Step=>{const next={...step,mode};delete next.minimumCount;return next;};
const canonical=(id:string)=>/^-[1-9][0-9]{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
const available=(s:BotState,p:Policy)=>s.chats.filter(c=>canonical(c.id)&&s.chats.filter(x=>x.id===c.id).length===1&&p.canUseChat(s,c.id,'verification')).sort((a,b)=>a.id.localeCompare(b.id));
export const validSubscriptionConfigRoute=(data:string):boolean=>data==='sc:1:h'||/^sc:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
function validStep(v:unknown):v is Step{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const a=v as Record<string,unknown>;
 return Object.keys(a).length===5+(Object.hasOwn(a,'minimumCount')?1:0)+(Object.hasOwn(a,'graceSeconds')?1:0)&&['groups','edit','health','review','confirm','enforcementReview','enforcementEnable','enforcementOffReview','enforcementDisable','graceReview','graceConfirm'].includes(String(a.kind))&&(['graceReview','graceConfirm'].includes(String(a.kind))?typeof a.graceSeconds==='number'&&[0,3600,86400].includes(a.graceSeconds):!Object.hasOwn(a,'graceSeconds'))&&Number.isSafeInteger(a.page)&&Number(a.page)>=0&&Number(a.page)<=999&&typeof a.group==='string'&&(a.group===''||canonical(a.group))&&Array.isArray(a.channels)&&a.channels.length<=10&&a.channels.every(c=>typeof c==='string'&&canonical(c))&&new Set(a.channels).size===a.channels.length&&((a.mode==='ALL'||a.mode==='ANY')?!Object.hasOwn(a,'minimumCount'):a.mode==='AT_LEAST'&&Number.isSafeInteger(a.minimumCount)&&Number(a.minimumCount)>=1&&Number(a.minimumCount)<=a.channels.length)&&(a.kind==='groups'?a.group===''&&a.channels.length===0:a.group!=='');
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
  if(!Array.isArray(v)||v.length!==2||!validStep(v[0])||v[1]!==subscriptionConfigEpoch(s))return null;
  for(const other of s.callbacks){if(other===c||other.actorId!==actor||!other.ref.startsWith(PREFIX)||typeof other.action!=='string'||!other.action.startsWith(PREFIX))continue;try{const next:unknown=JSON.parse(other.action.slice(PREFIX.length));if(Array.isArray(next)&&validStep(next[0])&&next[0].kind==='graceConfirm')other.revoked=true;}catch{other.revoked=true;}}
  c.used=true;return {step:v[0],epoch:v[1] as string};
 });
 if(!request)return null;let step=request.step,saved=false,committedRuleVersion:number|null=null,removedChannels:string[]=[],addedChannels:string[]=[],health:{id:string;status:ChannelRights}[]|null=null;
 if(step.kind==='health'){if(!gate)return null;health=await gate.channelRightsHealth(actor,step.group,request.epoch);if(!health)return null;}
 if(step.kind==='enforcementEnable'&&(!gate||!await gate.validateEnforcementConfiguration(actor,step.group,request.epoch)))return null;
 if(step.kind==='confirm'){
  if(!gate)return null;
  const before=await store.snapshot();if(subscriptionConfigEpoch(before)!==request.epoch)return null;const old=before.subscriptionRequirements.filter(r=>r.chatId===step.group);if(old.length>1||old[0]&&!isCanonicalSubscriptionRule(old[0]))return null;committedRuleVersion=(old[0]?.version??0)+1;if(!Number.isSafeInteger(committedRuleVersion))return null;removedChannels=(old[0]?.channelIds??[]).filter(id=>!step.channels.includes(id));if(old[0])addedChannels=step.channels.filter(id=>!old[0]!.channelIds.includes(id));
  try{await gate.configure(actor,step.group,[...step.channels],step.mode,request.epoch,step.minimumCount);saved=true;step={...step,kind:'edit',page:0};}catch{return null;}
 }
 return store.transaction(s=>{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL||!policy.privateFeature(s,'owner.dashboard',actor)||!saved&&subscriptionConfigEpoch(s)!==request.epoch)return null;
  if(committedRuleVersion!==null){const rules=s.subscriptionRequirements.filter(r=>r.chatId===step.group),rule=rules[0];if(rules.length!==1||!rule||!isCanonicalSubscriptionRule(rule)||rule.version!==committedRuleVersion||JSON.stringify(rule.channelIds)!==JSON.stringify(step.channels)||rule.mode!==step.mode||rule.minimumCount!==step.minimumCount||!policy.canUseChat(s,step.group,'verification'))return null;}
  if(step.kind==='enforcementEnable'||step.kind==='enforcementDisable'){const rule=s.subscriptionRequirements.find(r=>r.chatId===step.group);if(!gate?.supportsAutomaticEnforcement()||!rule||JSON.stringify(rule.channelIds)!==JSON.stringify(step.channels)||rule.mode!==step.mode||rule.minimumCount!==step.minimumCount||!recordSubscriptionEnforcementConsent(s,policy,actor,step.group,step.kind==='enforcementEnable',now))return null;saved=true;step={...step,kind:'edit'};}
  if(step.kind==='graceConfirm'){const rule=s.subscriptionRequirements.find(r=>r.chatId===step.group);if(!gate?.supportsAutomaticEnforcement()||!rule||JSON.stringify(rule.channelIds)!==JSON.stringify(step.channels)||rule.mode!==step.mode||rule.minimumCount!==step.minimumCount||!recordSubscriptionGracePolicy(s,policy,actor,step.group,step.graceSeconds!,now))return null;saved=true;const next={...step,kind:'edit' as const};delete next.graceSeconds;step=next;}
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
   if(step.kind==='health'){
    if(!health||JSON.stringify(health.map(x=>x.id))!==JSON.stringify(step.channels))return null;
    text='<b>صلاحية فحص جهات الاشتراك</b>\nالمجموعة: '+step.group+'\n'+health.map(x=>x.id+': '+(x.status==='ADMIN'?'البوت مشرف':x.status==='NOT_ADMIN'?'البوت ليس مشرفًا':'تعذر التحقق')).join('\n')+'\nهذه نتيجة الفحص الحالي فقط؛ تعذر التحقق لا يثبت فقد الإشراف ولا يعد العضو مخالفًا. لا يغيّر الفحص أي قيد أو اشتراك.';
    rows.push([b('↩️ إعداد القنوات',{...step,kind:'edit',page:0})]);
   }else if(step.kind==='graceReview'){
    const rule=s.subscriptionRequirements.find(r=>r.chatId===step.group);if(!gate?.supportsAutomaticEnforcement()||!rule||JSON.stringify(rule.channelIds)!==JSON.stringify(step.channels)||rule.mode!==step.mode||rule.minimumCount!==step.minimumCount)return null;
    text='<b>معاينة مهلة مغادرة جهة الاشتراك</b>\nالمجموعة: '+step.group+'\nالمهلة: '+(step.graceSeconds===0?'دون مهلة':step.graceSeconds===3600?'ساعة':'24 ساعة')+'\nتطبق فقط على عضو سبق التحقق من اشتراكه في النطاق الحالي، بعد رصد مغادرة مؤكدة. تعذر التحقق لا يعد مخالفة. بعد المهلة يلزم فحص جديد؛ لا يصدر حظر دائم.';
    rows.push([b('✅ اعتماد المهلة',{...step,kind:'graceConfirm'})]);const back={...step,kind:'edit' as const};delete back.graceSeconds;rows.push([b('↩️ رجوع دون تغيير',back)]);
   }else if(step.kind==='enforcementReview'||step.kind==='enforcementOffReview'){
    const rule=s.subscriptionRequirements.find(r=>r.chatId===step.group);if(!gate?.supportsAutomaticEnforcement()||!rule||JSON.stringify(rule.channelIds)!==JSON.stringify(step.channels)||rule.mode!==step.mode||rule.minimumCount!==step.minimumCount)return null;
    const enable=step.kind==='enforcementReview';text='<b>معاينة '+(enable?'تفعيل':'تعطيل')+' تقييد الاشتراك</b>\nالمجموعة: '+step.group+'\n'+(enable?'بعد رسالة بشرية واردة، غياب الاشتراك المؤكد قد يضيف كتم الاشتراك. بعد تحقق حديث يسمح بفك سبب الاشتراك المنفرد المطابق من سجل المحول الرسمي لعضو كان عاديًا. لا يفتح أسبابًا مستقلة أو سجلاً غامضًا. قد يتعذر تمييز قيد خارجي مطابق متزامن؛ راجع ذلك قبل الاعتماد.':'يوقف التقييد الجديد ويسمح بفك سبب الاشتراك المنفرد المطابق عند التحقق التالي من العضو. لا يرفع أسبابًا مستقلة ولا يستأنف محاولة مجهولة.')+'\nيظل التشغيل الحقيقي خاضعًا لاختيار المشغل وSTOP. تغيير الشرط أو اعتماد الجهات يبطل هذا القرار؛ لا تُفعّل العقوبات بمجرد حفظ جهات الاشتراك.';
    rows.push([b(enable?'✅ اعتماد التقييد والفك المطابق':'✅ تعطيل التقييد والسماح بالفك المطابق',{...step,kind:enable?'enforcementEnable':'enforcementDisable'})]);rows.push([b('↩️ رجوع دون تغيير',{...step,kind:'edit'})]);
   }else if(step.kind==='review'){
    const current=s.subscriptionRequirements.find(r=>r.chatId===step.group),removed=(current?.channelIds??[]).filter(id=>!step.channels.includes(id)),added=current?step.channels.filter(id=>!current.channelIds.includes(id)):[];
    text='<b>معاينة شرط الاشتراك</b>\nالمجموعة: <code>'+step.group+'</code>\nالقاعدة: '+(step.channels.length?(step.mode==='ALL'?'جميع الجهات المختارة':step.mode==='ANY'?'جهة واحدة على الأقل':'حد أدنى '+step.minimumCount+' من '+step.channels.length):'تعطيل الشرط')+'\nالمختار: '+step.channels.join('، ')+(removed.length?'\n⚠️ ستزال من الشرط: '+removed.join('، '):'')+(added.length?'\nستضاف إلى الشرط: '+added.join('، '):'')+'\nيتحقق الحفظ من قابلية فحص الجهات المختارة؛ لا يغير عضوية أحد أو ينفذ عقوبة.';
    rows.push([b('✅ حفظ والتحقق من الصلاحيات',{...step,kind:'confirm'})]);
   }else{
    const pages=Math.max(1,Math.ceil(channels.length/8));if(step.page>=pages)return null;
    text=(saved?'<b>حُفظ شرط الاشتراك</b>':'<b>اختيار جهات التحقق</b>')+'\nالمجموعة: <code>'+step.group+'</code>\nالمختار: '+step.channels.length+' من 10\nصفحة '+(step.page+1)+' من '+pages+(saved&&removedChannels.length?'\n⚠️ أزيلت من الشرط: '+removedChannels.join('، '):'')+(saved&&addedChannels.length?'\nأضيفت إلى الشرط: '+addedChannels.join('، '):'')+'\nكل تغيير يحتاج معاينة وتأكيدًا. لا يُفترض نوع الجهة من معرّفها؛ تُستعمل الجهات المعتمدة للتحقق.';
    if(step.mode==='AT_LEAST')text+='\nالحد الأدنى: '+step.minimumCount+' من '+step.channels.length+'\nالجهات المختارة: '+step.channels.join('، ')+'\nإذا بلغ عدد المختار الحد الأدنى، اخفض الحد أو غيّر الوضع قبل إزالة جهة.';
    for(const c of channels.slice(step.page*8,step.page*8+8)){const selected=step.channels.includes(c.id);if(!selected&&step.channels.length===10||selected&&step.mode==='AT_LEAST'&&step.channels.length===step.minimumCount)continue;rows.push([b((selected?'✅ ':'▫️ ')+c.id,{...step,channels:selected?step.channels.filter(id=>id!==c.id):[...step.channels,c.id]})]);}
    const nav=[];if(step.page>0)nav.push(b('⬅️ السابق',{...step,page:step.page-1}));if(step.page+1<pages)nav.push(b('➡️ التالي',{...step,page:step.page+1}));if(nav.length)rows.push(nav);
    rows.push([b('☑️ جميع القنوات',basicMode(step,'ALL')),b('🔘 قناة واحدة على الأقل',basicMode(step,'ANY'))]);
    if(step.channels.length>=2)rows.push([b('🔢 حد أدنى (الافتراضي 2)',{...step,mode:'AT_LEAST',minimumCount:2})]);
    if(step.mode==='AT_LEAST')for(let n=1;n<=step.channels.length;n+=3)rows.push(Array.from({length:Math.min(3,step.channels.length-n+1)},(_,i)=>b('🔢 '+(n+i)+' من '+step.channels.length,{...step,minimumCount:n+i})));
    const enforcement=subscriptionEnforcementConsent(s,policy,step.group,now);text+='\nتقييد الاشتراك: '+(enforcement?.enabled?'قرار تفعيل محفوظ':'غير مفعل');
    const grace=subscriptionGracePolicy(s,policy,step.group,now);text+='\nمهلة المغادرة: '+(grace===null?'غير متاحة':grace.seconds===0?'دون مهلة':grace.seconds===3600?'ساعة':'24 ساعة');
    const savedRule=s.subscriptionRequirements.find(r=>r.chatId===step.group);if(savedRule&&step.channels.length&&JSON.stringify(savedRule.channelIds)===JSON.stringify(step.channels)&&savedRule.mode===step.mode&&savedRule.minimumCount===step.minimumCount)rows.push([b('🔎 فحص صلاحية القنوات',{...step,kind:'health'})]);
    if(gate?.supportsAutomaticEnforcement()&&step.channels.length)rows.push([b('⏱ دون مهلة',{...step,kind:'graceReview',graceSeconds:0}),b('⏱ ساعة',{...step,kind:'graceReview',graceSeconds:3600}),b('⏱ 24 ساعة',{...step,kind:'graceReview',graceSeconds:86400})]);
    if(gate?.supportsAutomaticEnforcement()){if(!enforcement?.enabled&&step.channels.length)rows.push([b('🔒 معاينة تفعيل التقييد',{...step,kind:'enforcementReview'})]);rows.push([b('⏹ معاينة إيقاف التقييد والفك المطابق',{...step,kind:'enforcementOffReview'})]);}
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
