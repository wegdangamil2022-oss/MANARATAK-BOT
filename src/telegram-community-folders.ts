import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {SubscriptionGate} from './subscription.js';
import type {StudioNativeKeyboard,StudioNativeButton} from './telegram-studio-rich.js';
import {communityFolderURL} from './community-folder-model.js';
import {subscriptionRequirementMode,subscriptionRuleLabel} from './subscription-integrity.js';
import {communityFolderEpoch} from './community-folder-access.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
const OWNER='folder-owner:',PUBLIC='folder-public:',INPUT=OWNER+'input:',VIEW=OWNER+'view:',TTL=120000;
type Step={kind:'groups'|'detail'|'input'|'save'|'enable'|'disable'|'review-enable'|'review-disable'|'verify';page:number;group:string;url:string};
export interface FolderScreen{text:string;keyboard:StudioNativeKeyboard;access:AdminUIAccess;public:boolean;}
const initial:Step={kind:'groups',page:0,group:'',url:''};
const epoch=(s:BotState)=>createHash('sha256').update(JSON.stringify([s.chats,s.subscriptionRequirements,s.communityFolders??[],s.privateFeatures,s.privateSettingsRevision])).digest('hex');
const groups=(s:BotState,p:Policy)=>s.chats.filter(c=>/^-[1-9][0-9]{0,15}$/u.test(c.id)&&Number.isSafeInteger(Number(c.id))&&s.chats.filter(x=>x.id===c.id).length===1&&p.canUseChat(s,c.id,'navigation')&&p.canUseChat(s,c.id,'verification')).sort((a,b)=>a.id.localeCompare(b.id));
export const publicFolderGroups=(s:BotState,p:Policy)=>groups(s,p).filter(c=>s.communityFolders?.some(f=>f.chatId===c.id&&f.enabled)&&subscriptionRequirementMode(s,c.id)==='ACTIVE');
export const validCommunityFolderRoute=(data:string):boolean=>/^(?:cf|fj):1:(?:h|[A-Za-z0-9_-]{24})$/u.exec(data)?.[0]===data;
function validStep(v:unknown):v is Step{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const a=v as Record<string,unknown>;
 return Object.keys(a).length===4&&['groups','detail','input','save','enable','disable','review-enable','review-disable','verify'].includes(String(a.kind))&&Number.isSafeInteger(a.page)&&Number(a.page)>=0&&Number(a.page)<=999&&typeof a.group==='string'&&(a.kind==='groups'?a.group==='':/^-[1-9][0-9]{0,15}$/u.test(a.group)&&Number.isSafeInteger(Number(a.group)))&&typeof a.url==='string'&&(a.kind==='save'?communityFolderURL(a.url):a.url==='');
}
function cancel(s:BotState,actor:string){
 for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(OWNER))c.revoked=true;
 for(const w of s.wizards)if(w.userId===actor&&w.chatId===actor&&w.flow.startsWith(OWNER))w.status='CANCELLED';
}
export async function cancelCommunityFolder(store:BotStore,actor:string):Promise<void>{await store.transaction(s=>{cancel(s,actor);});}
export class CommunityFolderUI{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly gate:SubscriptionGate|undefined,private readonly clock:()=>number){}
 private allowed(s:BotState,actor:string,pub:boolean):boolean{return pub?communityFolderEpoch(s,this.policy,actor)!==null:this.policy.isOwner(actor)&&this.policy.privateFeature(s,'owner.dashboard',actor);}
 private validTime(now:number):boolean{return Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-TTL;}
 private render(s:BotState,actor:string,pub:boolean,step:Step,notice='',waiting=false):FolderScreen|null{
  const now=this.clock();if(!this.validTime(now)||!this.allowed(s,actor,pub))return null;
  const prefix=pub?PUBLIC:OWNER,route=pub?'fj:1:':'cf:1:',source=epoch(s),eligible=pub?publicFolderGroups(s,this.policy):groups(s,this.policy);
  s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(prefix)||c.expiresAt>now);const previous=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(prefix));let created=0;
  const b=(text:string,next:Step)=>{const nonce=randomBytes(18).toString('base64url');created++;s.callbacks.push({ref:prefix+nonce,actorId:actor,chatId:'private',policyVersion:0,expiresAt:now+TTL,oneShot:true,used:false,revoked:false,action:prefix+JSON.stringify([next,source])});return {text,callback_data:route+nonce};};
  const rows:StudioNativeButton[][]=[];let text=notice?notice+'\n\n':'';
  if(waiting){text+='<b>أرسل رابط المجلد</b>\nالصيغة المقبولة: https://t.me/addlist/…\nأرسل الرابط الذي أنشأته في Telegram خلال دقيقتين. لن يُحفظ أو يظهر للطلاب قبل تأكيد مستقل.';}
  else if(step.kind==='groups'){
   const pages=Math.max(1,Math.ceil(eligible.length/8));if(step.page>=pages)return null;
   text+='<b>مجلدات المجتمع 📁</b>\nصفحة '+(step.page+1)+' من '+pages+'\n'+(eligible.length?'اختر المجموعة المستهدفة.':'لا توجد مجلدات متاحة حاليًا.');
   for(const g of eligible.slice(step.page*8,step.page*8+8))rows.push([b((pub?'📁 ':'👥 ')+g.id,{kind:'detail',page:step.page,group:g.id,url:''})]);
   const nav=[];if(step.page>0)nav.push(b('⬅️ السابق',{...step,page:step.page-1}));if(step.page+1<pages)nav.push(b('➡️ التالي',{...step,page:step.page+1}));if(nav.length)rows.push(nav);
  }else{
   if(!eligible.some(g=>g.id===step.group))return null;
   const folder=s.communityFolders?.find(f=>f.chatId===step.group),rule=s.subscriptionRequirements.find(r=>r.chatId===step.group);
   text+='<b>مجلد المجتمع</b>\nالمجموعة: <code>'+step.group+'</code>\n';
   if(pub){
    if(!folder?.enabled||!rule)return null;
    text+='قاعدة القنوات: '+subscriptionRuleLabel(rule)+'\nإضافة المجلد لا تثبت الاشتراك في القنوات أو العضوية بالمجموعة. اضغط التحقق بعد الانضمام؛ لا تُمنح صلاحية تلقائيًا.';
    rows.push([{text:'📁 فتح مجلد المجتمع',url:folder.url}],[b('✅ تحقق من الاشتراك',{...step,kind:'verify'})]);
   }else if(step.kind==='save'||step.kind==='enable'||step.kind==='disable'){
    text+='معاينة '+(step.kind==='save'?'حفظ الرابط وإتاحته':step.kind==='enable'?'إتاحة الرابط':'تعطيل عرض الرابط')+'\n';
    if(step.kind==='save')text+='<code>'+step.url+'</code>\nسيظهر للطلاب فقط مع اعتماد المجموعة وقاعدة اشتراك نشطة.\n';
    text+='التأكيد لا يضيف أحدًا إلى المجلد أو القنوات، ولا يغيّر قاعدة الاشتراك.';
    rows.push([b('✅ تأكيد '+(step.kind==='disable'?'التعطيل':'الحفظ'),step)]);
    if(step.kind==='save')rows.push([{text:'👁️ فتح الرابط للمعاينة',url:step.url}]);
   }else{
    text+='الحالة: '+(folder?(folder.enabled?'متاح عند تحقق الشروط':'معطل'):'لم يُضبط رابط')+'\nقاعدة القنوات: '+(rule&&subscriptionRequirementMode(s,step.group)==='ACTIVE'?subscriptionRuleLabel(rule):'غير مهيأة؛ اضبطها من إعداد الاشتراك')+'\n';
    if(folder)rows.push([{text:'👁️ معاينة رابط المجلد',url:folder.url}]);
    rows.push([b('✏️ الرابط / تعديله',{...step,kind:'input'})]);if(folder)rows.push([b(folder.enabled?'⏸️ تعطيل العرض':'▶️ إتاحة العرض',{...step,kind:folder.enabled?'review-disable':'review-enable'})]);
    rows.push([{text:'🔐 إعداد الاشتراك',callback_data:'sc:1:h'}]);
   }
  }
  rows.push([step.kind==='groups'?{text:pub?'↩️ المجلدات':'↩️ إلغاء / المجلدات',callback_data:route+'h'}:b(pub?'↩️ المجلدات':'↩️ إلغاء / المجلدات',{...initial,page:step.page}),{text:pub?'🏠 الرئيسية':'↩️ قسم الانضمام',callback_data:pub?'pn:1:h':'mi:1:s:04:0'}]);
  const remove=new Set(previous.slice(0,Math.max(0,previous.length+created-128)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));
  if(!pub&&eligible.length){s.wizards=s.wizards.filter(w=>w.key!==VIEW+actor);s.wizards.push({key:VIEW+actor,userId:actor,chatId:actor,topicId:'',flow:VIEW+randomBytes(12).toString('hex'),step:0,version:1,policyVersion:0,expiresAt:now+TTL,status:'ACTIVE'});}
  const proof=pub?communityFolderEpoch(s,this.policy,actor):protectionUIEpoch(s,this.policy,actor,now);if(!proof)return null;
  return {text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch:proof,expiresAt:now+TTL},public:pub};
 }
 async handle(actor:string,data:string):Promise<FolderScreen|null>{
  const entry=data==='mi:1:i:04:03',pub=data.startsWith('fj:1:'),root=entry||data==='cf:1:h'||data==='fj:1:h';
  if(!entry&&!validCommunityFolderRoute(data))return null;
  const request=await this.store.transaction(s=>{
   const now=this.clock();if(!this.validTime(now)||!this.allowed(s,actor,pub))return null;
   if(root){if(!pub)cancel(s,actor);return {step:initial,epoch:epoch(s)};}
   const prefix=pub?PUBLIC:OWNER,rows=s.callbacks.filter(c=>c.ref===prefix+data.slice(5)),c=rows[0];
   if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.oneShot!==true||c.used!==false||c.revoked!==false||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL||!c.action.startsWith(prefix))return null;
   let v:unknown;try{v=JSON.parse(c.action.slice(prefix.length));}catch{return null;}
   if(!Array.isArray(v)||v.length!==2||!validStep(v[0])||v[1]!==epoch(s)||pub&&!['groups','detail','verify'].includes(v[0].kind)||!pub&&v[0].kind==='verify')return null;c.used=true;return {step:v[0],epoch:v[1] as string};
  });
  if(!request)return null;let notice='';
  if(request.step.kind==='verify'){
   if(!this.gate)return null;
   const before=await this.store.snapshot();if(epoch(before)!==request.epoch||!this.allowed(before,actor,true)||!publicFolderGroups(before,this.policy).some(g=>g.id===request.step.group))return null;
   const decision=await this.gate.verify(request.step.group,actor);
   notice=decision.status==='MEMBER'?'✅ تحقق شرط الاشتراك في القنوات؛ هذه نتيجة الفحص وليست تصريحًا دائمًا.':decision.status==='NOT_REQUIRED'&&this.policy.isOwner(actor)?'المالك مستثنى؛ هذا لا يثبت عضوية فعلية.':decision.status==='NOT_MEMBER'?'لم يتحقق العدد المطلوب من القنوات.':'تعذر التحقق الآن؛ لا تُعد هذه النتيجة مخالفة.';
  }
  return this.store.transaction(s=>{
   if(epoch(s)!==request.epoch||!this.allowed(s,actor,pub)||!this.validTime(this.clock()))return null;let step=request.step;
   if(step.kind!=='groups'&&!groups(s,this.policy).some(g=>g.id===step.group))return null;
   if(!pub&&step.kind==='input'){
    s.wizards=s.wizards.filter(w=>w.key!==INPUT+actor);s.wizards.push({key:INPUT+actor,userId:actor,chatId:actor,topicId:'',flow:INPUT+JSON.stringify([step.group,epoch(s),step.page]),step:1,version:1,policyVersion:0,expiresAt:this.clock()+TTL,status:'ACTIVE'});
    return this.render(s,actor,false,step,'',true);
   }
   if(!pub&&(step.kind==='review-enable'||step.kind==='review-disable'))return this.render(s,actor,false,{...step,kind:step.kind==='review-enable'?'enable':'disable'});
   if(!pub&&['save','enable','disable'].includes(step.kind)){
    const old=s.communityFolders?.find(f=>f.chatId===step.group);if(step.kind!=='save'&&!old)return null;
    const folder={chatId:step.group,url:step.kind==='save'?step.url:old!.url,enabled:step.kind!=='disable',revision:(old?.revision??0)+1};
    if(folder.revision>=Number.MAX_SAFE_INTEGER||!communityFolderURL(folder.url))return null;
    s.communityFolders??=[];s.communityFolders=s.communityFolders.filter(f=>f.chatId!==step.group);s.communityFolders.push(folder);
    s.audit.push({actorId:actor,updateKey:'community-folder:'+step.group+':'+folder.revision,decision:'ALLOW',reason:'COMMUNITY_FOLDER_CONFIRMED',policyVersion:s.chats.find(c=>c.id===step.group)!.version,at:this.clock()});notice='✅ حُفظ إعداد مجلد المجتمع.';step={...step,kind:'detail',url:''};
   }
   if(!pub&&step.kind==='groups')cancel(s,actor);
   return this.render(s,actor,pub,step,notice);
  });
 }
 async text(actor:string,text:string):Promise<FolderScreen|null>{
  if(!this.policy.isOwner(actor))return null;
  return this.store.transaction(s=>{
   const now=this.clock(),rows=s.wizards.filter(w=>w.key===INPUT+actor),w=rows[0];
   if(!this.validTime(now)||!this.allowed(s,actor,false)||rows.length!==1||!w||w.status!=='ACTIVE'||w.userId!==actor||w.chatId!==actor||w.topicId!==''||w.step!==1||w.version!==1||w.policyVersion!==0||!Number.isSafeInteger(w.expiresAt)||w.expiresAt<=now||w.expiresAt>now+TTL||!w.flow.startsWith(INPUT))return null;
   let v:unknown;try{v=JSON.parse(w.flow.slice(INPUT.length));}catch{return null;}
   if(!Array.isArray(v)||v.length!==3||typeof v[0]!=='string'||v[1]!==epoch(s)||!Number.isSafeInteger(v[2])||Number(v[2])<0||Number(v[2])>999||!groups(s,this.policy).some(g=>g.id===v[0])){w.status='CANCELLED';return this.render(s,actor,false,initial,'تغيرت الإعدادات؛ أعد اختيار المجموعة.');}
   const step:Step={kind:'detail',page:v[2] as number,group:v[0],url:''};
   if(!communityFolderURL(text))return this.render(s,actor,false,step,'الرابط غير صالح؛ أرسل رابط Telegram من النمط المسموح.',true);
   w.status='CANCELLED';
   // Only a later one-shot callback can commit this text-input preview.
   return this.render(s,actor,false,{...step,kind:'save',url:text});
  });
 }
}
