import {protectionUIEpoch,ADMIN_UI_TTL_MS,type AdminUIAccess} from './protection-ui-access.js';
import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat,Wizard} from './store.js';
import type {Policy} from './policy.js';
import {GroupProtectionPolicyService} from './group-protection-policy.js';
import {isValidProtectionPolicy,evaluateProtectionRules,type ProtectionPolicy,type ProtectionRule,type ProtectionMessageType} from './protection-rules.js';
import {protectionInlineRoute} from './protection-inline-route.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
type Button={text:string;callback_data:string};
type Frame={chat:Chat;config:ProtectionPolicy;epoch:number;page:number;slot:number;digest:string;stale:boolean};
type Outcome={status:'APPLIED'|'DENIED';reason:string;screen:OwnerInlineScreen};
const TTL=300000,PREFIX='protection-ui:';
const flow=/^protection-ui:(WORD|PHRASE|TEST|LINK):(-[1-9][0-9]{0,15}):([1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):([A-Za-z0-9_-]{16})(?::([A-Za-z0-9][A-Za-z0-9_-]{0,47}))?$/u;
const escape=(v:string)=>v.replace(/\p{Cf}/gu,'').replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;');
const btn=(text:string,callback_data:string):Button=>({text,callback_data});
const screen=(text:string,rows:Button[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const types:Record<ProtectionMessageType,string>={TEXT:'نصوص',PHOTO:'صور',VIDEO:'فيديو',ANIMATION:'GIF',STICKER:'ملصقات',DOCUMENT:'مستندات',AUDIO:'صوتيات',VOICE:'رسائل صوتية',VIDEO_NOTE:'دوائر مرئية',CONTACT:'جهات اتصال',LOCATION:'مواقع',POLL:'استطلاعات'};
const ruleName=(r:ProtectionRule)=>r.kind==='WORD'||r.kind==='PHRASE'?r.value:r.kind==='TYPE'?types[r.type]:r.kind==='LINK'?(r.hosts==='*'?'جميع الروابط':r.hosts.join('، ')):r.value;
const newRuleId=(config:ProtectionPolicy)=>{let id:string;do{id='r_'+randomBytes(8).toString('hex');}while(config.rules.some(r=>r.id===id));return id;};
const actions={REVIEW:'مراجعة',WARN:'تحذير',DELETE:'حذف',MUTE:'كتم'} as const;
const key=(kind:string,f:Frame,suffix='')=>'pr:1:'+kind+':'+f.page+':'+f.slot+':'+f.digest+suffix;
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000-TTL;
function rulesWithInput(config:ProtectionPolicy,kind:'WORD'|'PHRASE'|'LINK',value:string,id:string,editing:boolean):ProtectionRule[]|null{
 const old=config.rules.find(r=>r.id===id);
 if(editing&&(!old||old.kind!==kind))return null;
 const rule:ProtectionRule=kind==='LINK'?{id,kind,hosts:[value],enabled:old?.enabled??false,action:old?.action??'REVIEW'}:{id,kind,value,enabled:old?.enabled??false,action:old?.action??'REVIEW'};
 return editing?config.rules.map(r=>r.id===id?rule:r):[...config.rules,rule];
}
/** Shared owner/delegated private editor. Text samples are evaluated in memory;
 * only policy rules explicitly entered by an operator are persisted. */
export class TelegramProtectionEditor{
 private readonly service:GroupProtectionPolicyService;
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now){this.service=new GroupProtectionPolicyService(store,policy,clock);}
 private groups(state:BotState,actor:string):Chat[]{
  return state.chats.filter(c=>Number.isSafeInteger(c.version)&&c.version>=1&&/^-[1-9][0-9]{0,15}$/u.test(c.id)&&Number.isSafeInteger(Number(c.id))&&
   this.policy.canUseChat(state,c.id,'moderation')&&this.policy.has(state,actor,'chat.manage',c.id,this.clock()))
   .sort((a,b)=>a.id.localeCompare(b.id));
 }
 private frame(state:BotState,actor:string,page:number,slot:number):Frame|null{
  const chat=this.groups(state,actor)[page*8+slot-1];if(!chat)return null;
  const saved=state.protectionPolicies?.find(r=>r.policy.chatId===chat.id);
  const config=saved?.policy??{chatId:chat.id,revision:0,mode:'OFF' as const,rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]};
  return {chat,config,epoch:chat.version,page,slot,digest:createHash('sha256').update(JSON.stringify([chat,saved??null])).digest('hex').slice(0,16),
   stale:Boolean(saved&&(saved.chatPolicyVersion!==chat.version||saved.updatedAt>this.clock()))};
 }
 private back(actor:string):Button[]{return [btn('↩️ المجموعات','pr:1:h'),btn(this.policy.isOwner(actor)?'🏠 لوحة المالك':'🏠 مجموعاتي الإشرافية',this.policy.isOwner(actor)?'mi:1:h':'ms:1:h')];}
 private groupScreen(actor:string,f:Frame,notice=''):OwnerInlineScreen{
  const rows:Button[][]=[];
  if(!f.stale){
   rows.push([btn('➕ إضافة كلمة',key('w',f)),btn('➕ إضافة عبارة',key('f',f))]);
   rows.push([btn('🔗 جميع الروابط',key('b',f)),btn('🌐 نطاق محدد',key('j',f))]);
   rows.push([btn('🔒 أنواع الرسائل',key('y',f,':0'))]);
   rows.push([btn('📋 القواعد',key('l',f,':0')),btn('🧪 اختبار القواعد',key('t',f))]);
   rows.push([btn('👁️ تشغيل المراقبة',key('m',f)),btn('⏹ إيقاف الفحص',key('o',f))]);
  }
  rows.push(this.back(actor));
  return screen('<b>🚫 الكلمات والعبارات والروابط والأنواع</b>\nالمجموعة: <code>'+escape(f.chat.id)+'</code>\n'
   +(notice?escape(notice)+'\n':'')+(f.stale?'السياسة قديمة أو وقتها غير موثوق؛ التعديل محجوب.':
    'الحالة: '+(f.config.mode==='OFF'?'متوقفة':f.config.mode==='MONITOR'?'مراقبة فقط':'تحتاج مراجعة؛ التنفيذ غير موصول')+'\nالقواعد: '+f.config.rules.length+' · النسخة: '+f.config.revision)+'\n'
   +'هذه إعدادات محلية؛ لا تُفعّل حذفًا أو كتمًا تلقائيًا.',rows);
 }
 private async fresh(actor:string,chat:string,notice=''):Promise<OwnerInlineScreen|null>{
  const state=await this.store.snapshot(),index=this.groups(state,actor).findIndex(c=>c.id===chat);
  if(index<0)return null;const f=this.frame(state,actor,Math.floor(index/8),index%8+1);
  return f?this.groupScreen(actor,f,notice):null;
 }
 private failure(actor:string,text='تغيرت الصلاحية أو السياسة؛ افتح القسم من جديد.'):OwnerInlineScreen{return screen(text,[this.back(actor)]);}
 async handle(data:string,actor:string):Promise<OwnerInlineScreen|null>{
  if(!validTime(this.clock()))return null;
  const route=protectionInlineRoute(/^mi:1:i:02:0[567]$/u.test(data)?'pr:1:h':data);if(!route)return null;
  if(route.kind==='cancel')return this.cancel(actor,route.nonce);
  await this.cancel(actor);
  const state=await this.store.snapshot();
  if(route.kind==='home'){
   const all=this.groups(state,actor);if(!all.length&&!this.policy.isOwner(actor))return null;
   const pages=Math.max(1,Math.ceil(all.length/8));if(route.page>=pages)return null;
   const rows:Button[][]=[];
   for(let i=0;i<Math.min(8,all.length-route.page*8);i++){
    const f=this.frame(state,actor,route.page,i+1)!;rows.push([btn('👥 '+f.chat.id,key('g',f))]);
   }
   const nav:Button[]=[];
   if(route.page>0)nav.push(btn('⬅️ السابق','pr:1:p:'+(route.page-1)));
   if(route.page+1<pages)nav.push(btn('➡️ التالي','pr:1:p:'+(route.page+1)));
   if(nav.length)rows.push(nav);rows.push(this.back(actor));
   return screen('<b>🚫 الكلمات والعبارات — اختر مجموعة</b>\nالمجموعات المخولة: '+all.length+'\nصفحة '+(route.page+1)+' من '+pages+'\n'+(all.length?'اختر إعدادات مجموعة.':'لا توجد مجموعات مخولة حاليًا.'),rows);
  }
  const f=this.frame(state,actor,route.page,route.slot);if(!f||f.digest!==route.digest)return null;
  if(route.kind==='g')return this.groupScreen(actor,f);
  if(f.stale)return null;
  if(route.kind==='j')return this.begin(actor,f,'LINK');
  if(route.kind==='b')return this.addRule(actor,f,{id:newRuleId(f.config),kind:'LINK',hosts:'*',enabled:false,action:'REVIEW'});
  if(route.kind==='y'||route.kind==='n'){
   const entries=Object.entries(types) as [ProtectionMessageType,string][],page=route.rulePage??0;
   if(page>=Math.ceil(entries.length/8))return null;
   if(route.kind==='n'){
    const type=entries[page*8+(route.ruleSlot??1)-1]?.[0];
    return type?this.addRule(actor,f,{id:newRuleId(f.config),kind:'TYPE',type,enabled:false,action:'REVIEW'}):null;
   }
   const rows=entries.slice(page*8,page*8+8).map(([_,label],i)=>[btn(label,key('n',f,':'+page+':'+(i+1)))]);
   if(page>0)rows.push([btn('⬅️ السابق',key('y',f,':'+(page-1)))]);
   if((page+1)*8<entries.length)rows.push([btn('➡️ التالي',key('y',f,':'+(page+1)))]);
   rows.push([btn('↩️ إعدادات المجموعة',key('g',f))]);
   return screen('اختر نوع رسالة لإضافة قاعدة مراقبة معطلة؛ لا يتغير أي إذن Telegram.',rows);
  }
  if(route.kind==='w'||route.kind==='f'||route.kind==='t')return this.begin(actor,f,route.kind==='w'?'WORD':route.kind==='f'?'PHRASE':'TEST');
  if(route.kind==='m'||route.kind==='o'){
   const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,mode:route.kind==='m'?'MONITOR':'OFF'},f.epoch,f.config.revision);
   return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'حُفظ وضع الفحص المحلي.'):null;
  }
  const rulePage=route.rulePage??0,ruleSlot=route.ruleSlot??1,pages=Math.max(1,Math.ceil(f.config.rules.length/8));
  if(rulePage>=pages)return null;
  if(route.kind==='l'){
   const rows=f.config.rules.slice(rulePage*8,rulePage*8+8).map((r,i)=>[btn((r.enabled?'✅ ':'⏸ ')+Array.from(ruleName(r).replace(/\p{Cf}/gu,'')).slice(0,45).join(''),key('r',f,':'+rulePage+':'+(i+1)))]);
   const nav:Button[]=[];if(rulePage>0)nav.push(btn('⬅️ السابق',key('l',f,':'+(rulePage-1))));if(rulePage+1<pages)nav.push(btn('➡️ التالي',key('l',f,':'+(rulePage+1))));
   if(nav.length)rows.push(nav);rows.push([btn('↩️ إعدادات المجموعة',key('g',f))]);
   return screen('<b>قواعد المجموعة</b>\n'+f.config.rules.length+' قاعدة · صفحة '+(rulePage+1)+' من '+pages,rows);
  }
  const index=rulePage*8+ruleSlot-1,rule=f.config.rules[index];if(!rule)return null;
  const suffix=':'+rulePage+':'+ruleSlot;
  if(route.kind==='v')return rule.kind==='WORD'||rule.kind==='PHRASE'?this.begin(actor,f,rule.kind,rule.id):null;
  if(route.kind==='r')return screen('<b>تفاصيل القاعدة</b>\n'
   +escape(ruleName(rule))+'\nالحالة: '+(rule.enabled?'مفعلة للاختبار':'معطلة')+'\nالإجراء المقترح: '+actions[rule.action]+'\nلا توجد عقوبة تلقائية متصلة.',[
    ...(rule.kind==='WORD'||rule.kind==='PHRASE'?[[btn('✏️ تعديل النص',key('v',f,suffix))]]:[]),
    [btn(rule.enabled?'⏸ تعطيل القاعدة':'✅ تفعيل القاعدة للاختبار',key('e',f,suffix))],
    [btn('مراجعة',key('a',f,suffix+':r')),btn('تحذير',key('a',f,suffix+':w'))],
    [btn('حذف مقترح',key('a',f,suffix+':d')),btn('كتم مقترح',key('a',f,suffix+':m'))],
    [btn('🗑 حذف القاعدة',key('d',f,suffix)),btn('↩️ القواعد',key('l',f,':'+rulePage))]
   ]);
  if(route.kind==='d')return screen('هل تريد حذف هذه القاعدة من إعدادات المجموعة؟ لن تُحذف أي رسالة.',[[btn('✅ تأكيد حذف القاعدة',key('x',f,suffix)),btn('↩️ إلغاء',key('r',f,suffix))]]);
  const next=structuredClone(f.config);next.revision++;
  if(route.kind==='e')next.rules[index]!.enabled=!rule.enabled;
  else if(route.kind==='a'&&route.action)next.rules[index]!.action=route.action;
  else if(route.kind==='x')next.rules.splice(index,1);
  else return null;
  const saved=await this.service.save(actor,next,f.epoch,f.config.revision);
  return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'حُفظ تعديل القاعدة.'):null;
 }
 private async addRule(actor:string,f:Frame,rule:ProtectionRule):Promise<OwnerInlineScreen|null>{
  const duplicate=f.config.rules.some(r=>r.kind===rule.kind&&(r.kind==='TYPE'&&rule.kind==='TYPE'?r.type===rule.type:r.kind==='LINK'&&rule.kind==='LINK'?JSON.stringify(r.hosts)===JSON.stringify(rule.hosts):false));
  if(duplicate)return this.groupScreen(actor,f,'توجد قاعدة لهذا الهدف؛ عدّلها من قائمة القواعد.');
  if(f.config.rules.length>=100)return this.groupScreen(actor,f,'بلغت السياسة الحد الحالي: 100 قاعدة.');
  const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,rules:[...f.config.rules,rule]},f.epoch,f.config.revision);
  return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'أُضيفت قاعدة معطلة بإجراء مراجعة. اختبرها أولًا.'):null;
 }
 private active(state:BotState,actor:string):Wizard[]{return state.wizards.filter(w=>w.userId===actor&&w.chatId===actor&&w.status==='ACTIVE'&&typeof w.flow==='string'&&w.flow.startsWith(PREFIX));}
 private decode(w:Wizard):RegExpExecArray|null{
  const m=flow.exec(w.flow);
  if(!m||m[0]!==w.flow||m[1]==='TEST'&&m[7]!==undefined||w.key!==JSON.stringify([w.userId,w.chatId,'',w.flow])||w.topicId!==''||w.step!==0||w.version!==1||
   !Number.isSafeInteger(w.expiresAt)||!validTime(Number(m[5]))||w.expiresAt!==Number(m[5])+TTL||w.policyVersion!==Number(m[3])||![Number(m[3]),Number(m[4])].every(Number.isSafeInteger))return null;
  return m;
 }
 private async begin(actor:string,f:Frame,kind:'WORD'|'PHRASE'|'TEST'|'LINK',editRuleId?:string):Promise<OwnerInlineScreen|null>{
  if(kind==='TEST'&&!f.config.rules.length)return this.groupScreen(actor,f,'أضف قاعدة أولًا.');
  const nonce=randomBytes(12).toString('base64url');
  const created=await this.store.transaction(state=>{
   const current=this.frame(state,actor,f.page,f.slot),now=this.clock();
   if(!validTime(now)||!current||current.digest!==f.digest||current.stale)return false;
   const active=this.active(state,actor);
   if(active.some(w=>!this.decode(w)||state.wizards.filter(other=>other.key===w.key).length!==1))return false;
   for(const old of active){old.status='CANCELLED';old.version++;}
   const value=PREFIX+kind+':'+f.chat.id+':'+f.epoch+':'+f.config.revision+':'+now+':'+nonce+(editRuleId?':'+editRuleId:'');
   state.wizards.push({key:JSON.stringify([actor,actor,'',value]),userId:actor,chatId:actor,topicId:'',flow:value,step:0,version:1,expiresAt:now+TTL,policyVersion:f.epoch,status:'ACTIVE'});
   return true;
  });
  return created?screen(kind==='TEST'?'أرسل عينة نصية لاختبار جميع القواعد، بما فيها المعطلة، دون تشغيلها أو حفظ العينة.':
   kind==='LINK'?'أرسل اسم نطاق واحدًا بحروف صغيرة، مثل example.org، دون رابط أو مسار أو بيانات دخول. ستُضاف قاعدة معطلة تشمل النطاق ونطاقاته الفرعية.':
   editRuleId?'أرسل النص البديل حتى 120 حرفًا. تبقى حالة القاعدة وإجراؤها المقترح كما هما. الأوامر أو الرجوع يلغيان الخطوة.':
   'أرسل '+(kind==='WORD'?'كلمة واحدة':'عبارة')+' حتى 120 حرفًا. ستُضاف القاعدة معطلة وبإجراء مراجعة.\nالأوامر أو الرجوع يلغيان هذه الخطوة.',[[btn('↩️ إلغاء','pr:1:z:'+nonce)]]):null;
 }
 private async cancel(actor:string,nonce?:string):Promise<OwnerInlineScreen|null>{
  const cancelled=await this.store.transaction(state=>{
   const active=this.active(state,actor).filter(w=>!nonce||this.decode(w)?.[6]===nonce);
   if(!active.length||active.some(w=>!this.decode(w)||state.wizards.filter(other=>other.key===w.key).length!==1))return false;
   for(const w of active){w.status='CANCELLED';w.version++;}return true;
  });
  return cancelled?this.failure(actor,'أُلغيت خطوة إدخال القاعدة أو الاختبار.'):null;
 }
 async cancelNavigation(actor:string):Promise<void>{await this.cancel(actor);}
 async link(actor:string,chat:string):Promise<string|null>{
  const state=await this.store.snapshot(),index=this.groups(state,actor).findIndex(c=>c.id===chat);
  if(index<0)return null;const f=this.frame(state,actor,Math.floor(index/8),index%8+1);return f?key('g',f):null;
 }
 async witness(actor:string,keyboard:OwnerInlineScreen['keyboard']):Promise<AdminUIAccess|null>{
  const state=await this.store.snapshot(),now=this.clock(),epoch=protectionUIEpoch(state,this.policy,actor,now);
  if(!epoch||!validTime(now))return null;
  for(const button of keyboard.inline_keyboard.flat()){
   if(!button.callback_data.startsWith('pr:1:'))continue;
   const route=protectionInlineRoute(button.callback_data);if(!route)return null;
   if(route.kind==='home')continue;
   if(route.kind==='cancel'){
    const active=this.active(state,actor),w=active.length===1?active[0]:undefined,m=w?this.decode(w):null;
    if(!w||!m||m[6]!==route.nonce||now>=w.expiresAt||now<Number(m[5]))return null;
    const index=this.groups(state,actor).findIndex(c=>c.id===m[2]),f=index>=0?this.frame(state,actor,Math.floor(index/8),index%8+1):null;
    if(!f||f.stale||f.epoch!==Number(m[3])||f.config.revision!==Number(m[4]))return null;
   }else{
    const f=this.frame(state,actor,route.page,route.slot);if(!f||f.digest!==route.digest)return null;
   }
  }
  return {actorId:actor,epoch,expiresAt:now+ADMIN_UI_TTL_MS};
 }
 async handleText(actor:string,text:string,navigation:boolean):Promise<Outcome|null>{
  if(navigation||text.startsWith('/')){
   const cancelled=await this.cancel(actor);
   return text==='/cancel'&&cancelled?{status:'APPLIED',reason:'PROTECTION_EDITOR_CANCELLED',screen:cancelled}:null;
  }
  const claim=await this.store.transaction(state=>{
   const active=this.active(state,actor);if(!active.length)return null;
   const w=active[0]!,m=active.length===1?this.decode(w):null,now=this.clock();
   if(!m||state.wizards.filter(other=>other.key===w.key).length!==1)return {kind:'DENIED' as const};
   const chat=m[2]!,epoch=Number(m[3]),revision=Number(m[4]);
   const index=this.groups(state,actor).findIndex(c=>c.id===chat),f=index>=0?this.frame(state,actor,Math.floor(index/8),index%8+1):null;
   if(!validTime(now)||now>=w.expiresAt||now<w.expiresAt-TTL||!f||f.stale||f.epoch!==epoch||f.config.revision!==revision){w.status='CANCELLED';w.version++;return {kind:'DENIED' as const};}
   let ruleId=m[7]??'';
   if(m[1]!=='TEST'){
    if(!m[7]&&f.config.rules.length>=100)return {kind:'RETRY' as const,notice:'بلغت السياسة الحد الحالي للقواعد. ألغ الخطوة واحذف قاعدة قبل إضافة أخرى.'};
    if(!m[7])ruleId=newRuleId(f.config);
    const rules=rulesWithInput(f.config,m[1] as 'WORD'|'PHRASE'|'LINK',text,ruleId,Boolean(m[7]));
    if(!rules)return {kind:'DENIED' as const};
    const candidate={...f.config,revision:revision+1,rules};
    if(!isValidProtectionPolicy(candidate))return {kind:'RETRY' as const,notice:m[1]==='LINK'?'اسم النطاق غير صالح. أرسل اسم نطاق واحدًا بحروف صغيرة دون مسار أو بيانات دخول، أو /cancel.':'المدخل غير صالح. أرسل كلمة واحدة أو عبارة بحسب الخطوة، حتى 120 حرفًا، أو /cancel.'};
   }
   w.status='CANCELLED';w.version++;
   return {kind:m[1] as 'WORD'|'PHRASE'|'LINK'|'TEST',frame:f,ruleId,editing:Boolean(m[7])};
  });
  if(!claim)return null;
  if(claim.kind==='DENIED')return {status:'DENIED',reason:'PROTECTION_EDITOR_STALE',screen:this.failure(actor)};
  if(claim.kind==='RETRY')return {status:'APPLIED',reason:'PROTECTION_EDITOR_INPUT_REJECTED',screen:screen(claim.notice,[[btn('↩️ المجموعات','pr:1:h')]])};
  const f=claim.frame;
  if(claim.kind==='TEST'){
   const config={...f.config,mode:'MONITOR' as const,rules:f.config.rules.map(r=>({...r,enabled:true}))};
   const result=evaluateProtectionRules(config,{chatId:f.chat.id,memberId:actor,type:'TEXT',text});
   const matched=f.config.rules.filter(r=>result.matchedRuleIds.includes(r.id));
   const explanations=matched.slice(0,6).map(r=>{
    const name=Array.from(ruleName(r)).slice(0,45).join('');
    const reason=r.kind==='WORD'?'كلمة كاملة':r.kind==='PHRASE'?'عبارة متجاورة':r.kind==='TYPE'?'نوع رسالة':'سياسة روابط';
    return '• '+escape(name)+' — '+reason+'؛ '+actions[r.action];
   }).join('\n');
   return {status:'APPLIED',reason:'PROTECTION_DRY_RUN_ONLY',screen:screen('نتيجة الاختبار المحلي: '+(result.status==='MATCH'?'مطابقة':'لا مطابقة')+'\nنسخة الاختبار: '+f.config.revision+'\nالقواعد المطابقة: '+result.matchedRuleIds.length+'\nالإجراء المقترح: '+(result.proposedAction?actions[result.proposedAction]:'لا شيء')+'\n'+explanations+(matched.length>6?'\nتوجد مطابقات إضافية؛ راجع قائمة القواعد.':'')+'\nلم تُحفظ العينة أو تُفعّل عقوبة.',[[btn('↩️ إعدادات المجموعة',key('g',f))]])};
  }
  const rules=rulesWithInput(f.config,claim.kind,text,claim.ruleId,claim.editing);
  if(!rules)return {status:'DENIED',reason:'PROTECTION_EDITOR_STALE',screen:this.failure(actor)};
  const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,rules},f.epoch,f.config.revision);
  const view=saved.status==='SAVED'?await this.fresh(actor,f.chat.id,claim.editing?'حُفظ النص البديل مع إبقاء إعدادات القاعدة.':'أُضيفت القاعدة معطلة؛ راجعها واختبرها قبل أي تفعيل.'):null;
  return view?{status:'APPLIED',reason:'PROTECTION_RULE_SAVED',screen:view}:{status:'DENIED',reason:'PROTECTION_EDITOR_STALE',screen:this.failure(actor)};
 }
}
