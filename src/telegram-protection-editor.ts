import {protectionUIEpoch,ADMIN_UI_TTL_MS,type AdminUIAccess} from './protection-ui-access.js';
import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat,Wizard} from './store.js';
import type {Policy} from './policy.js';
import {GroupProtectionPolicyService} from './group-protection-policy.js';
import type {ProtectionEnforcer} from './protection-enforcement.js';
import {isValidProtectionPolicy,evaluateProtectionRules,type ProtectionPolicy,type ProtectionRule,type ProtectionMessageType} from './protection-rules.js';
import {protectionInlineRoute} from './protection-inline-route.js';
import {ownerGroupCardLink} from './telegram-inline-groups.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
type Button={text:string;callback_data:string};
type Frame={chat:Chat;config:ProtectionPolicy;epoch:number;page:number;slot:number;digest:string;stale:boolean;returnToOwnerGroup:string|null};
type Outcome={status:'APPLIED'|'DENIED';reason:string;screen:OwnerInlineScreen};
type InputKind='WORD'|'PHRASE'|'LINK'|'TEST'|'DOMAIN'|'ALLOWPHRASE'|'FLOOD'|'EXEMPT'|'ESCALATION'|'RAID'|'NIGHT'|'LIMIT'|'JOINRAID'|'FRAUD'|'LOOKALIKE'|'NAME';
const TTL=300000,PREFIX='protection-ui:';
const flow=/^protection-ui:(WORD|PHRASE|TEST|LINK|DOMAIN|ALLOWPHRASE|FLOOD|EXEMPT|ESCALATION|RAID|NIGHT|LIMIT|JOINRAID|FRAUD|LOOKALIKE|NAME):(-[1-9][0-9]{0,15}):([1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):([A-Za-z0-9_-]{16})(?::([A-Za-z0-9][A-Za-z0-9_-]{0,47}))?$/u;
const escape=(v:string)=>v.replace(/\p{Cf}/gu,'').replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;');
const btn=(text:string,callback_data:string):Button=>({text,callback_data});
const screen=(text:string,rows:Button[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const types:Record<ProtectionMessageType,string>={TEXT:'نصوص',PHOTO:'صور',VIDEO:'فيديو',ANIMATION:'GIF',STICKER:'ملصقات',DOCUMENT:'مستندات',AUDIO:'صوتيات',VOICE:'رسائل صوتية',VIDEO_NOTE:'دوائر مرئية',CONTACT:'جهات اتصال',LOCATION:'مواقع',POLL:'استطلاعات'};
function ruleName(r:ProtectionRule):string{
 switch(r.kind){case 'WORD':case 'PHRASE':return r.value;case 'FRAUD':return 'ادعاء ودفع: '+r.identity+' + '+r.payment;case 'LOOKALIKE':return 'تقليد النطاق: '+r.domain;case 'NAME':return 'الاسم المحمي: '+r.name+' · '+r.trustedId;case 'TYPE':return types[r.type];case 'LIMIT':return ({MENTIONS:'حد المنشن',HASHTAGS:'حد الوسوم',LENGTH:'حد طول الرسالة',QUOTES:'حد كتل الاقتباس'} as const)[r.metric]+': '+r.maximum;case 'FORWARD':return 'رسالة معاد توجيهها';case 'LINK':return r.hosts==='*'?'جميع الروابط':r.hosts.slice(0,3).join('، ')+(r.hosts.length>3?' …':'');}
}
const newRuleId=(config:ProtectionPolicy)=>{let id:string;do{id='r_'+randomBytes(8).toString('hex');}while(config.rules.some(r=>r.id===id));return id;};
const actions={REVIEW:'مراجعة',WARN:'تحذير',DELETE:'حذف',MUTE:'كتم'} as const;
const key=(kind:string,f:Frame,suffix='')=>'pr:1:'+kind+':'+f.page+':'+f.slot+':'+f.digest+suffix;
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000-TTL;
function rulesWithInput(config:ProtectionPolicy,kind:'WORD'|'PHRASE'|'LINK',value:string,id:string,editing:boolean):ProtectionRule[]|null{
 const old=config.rules.find(r=>r.id===id);
 if(editing&&(!old||old.kind!==kind))return null;
 const rule:ProtectionRule=kind==='LINK'?{id,kind,hosts:[value],enabled:old?.enabled??false,action:old?.action??'REVIEW'}:{id,kind,value,enabled:old?.enabled??false,action:old?.action??'REVIEW',...(kind==='WORD'&&old?.kind==='WORD'&&old.match?{match:old.match}:{})};
 return editing?config.rules.map(r=>r.id===id?rule:r):[...config.rules,rule];
}
function inputPolicy(config:ProtectionPolicy,kind:Exclude<InputKind,'TEST'>,text:string,id:string,editing:boolean,now:number):ProtectionPolicy|null{
 if(kind==='NAME'){
  const parts=text.split('|').map(s=>s.trim());if(parts.length!==2||parts.some(s=>!s))return null;
  const [name,trustedId]=parts as [string,string];
  if(config.rules.some(r=>r.kind==='NAME'&&r.id!==id&&r.name===name&&r.trustedId===trustedId))return null;
  const old=config.rules.find(r=>r.id===id);if(editing&&old?.kind!=='NAME')return null;
  const rule:ProtectionRule={id,kind:'NAME',name,trustedId,enabled:old?.enabled??false,action:old?.action??'REVIEW'};
  return {...config,revision:config.revision+1,rules:editing?config.rules.map(r=>r.id===id?rule:r):[...config.rules,rule]};
 }
 if(kind==='LOOKALIKE'){
  if(config.rules.some(r=>r.kind==='LOOKALIKE'&&r.id!==id&&r.domain===text))return null;
  const old=config.rules.find(r=>r.id===id);if(editing&&old?.kind!=='LOOKALIKE')return null;
  const rule:ProtectionRule={id,kind:'LOOKALIKE',domain:text,enabled:old?.enabled??false,action:old?.action??'REVIEW'};
  return {...config,revision:config.revision+1,rules:editing?config.rules.map(r=>r.id===id?rule:r):[...config.rules,rule]};
 }
 if(kind==='FRAUD'){
  const parts=text.split('|').map(s=>s.trim());if(parts.length!==2||parts.some(s=>!s))return null;
  const [identity,payment]=parts as [string,string];
  if(config.rules.some(r=>r.kind==='FRAUD'&&r.id!==id&&r.identity===identity&&r.payment===payment))return null;
  const old=config.rules.find(r=>r.id===id);if(editing&&old?.kind!=='FRAUD')return null;
  const rule:ProtectionRule={id,kind:'FRAUD',identity,payment,enabled:old?.enabled??false,action:old?.action??'REVIEW'};
  return {...config,revision:config.revision+1,rules:editing?config.rules.map(r=>r.id===id?rule:r):[...config.rules,rule]};
 }
 if(kind==='LIMIT'){
  const m=/^(mentions|hashtags|length|quotes) ([1-9][0-9]{0,3})$/u.exec(text);if(!m||m[0]!==text)return null;
  const metric=({mentions:'MENTIONS',hashtags:'HASHTAGS',length:'LENGTH',quotes:'QUOTES'} as const)[m[1] as 'mentions'|'hashtags'|'length'|'quotes'];
  if(config.rules.some(r=>r.kind==='LIMIT'&&r.metric===metric&&r.maximum===Number(m[2])))return null;
  return {...config,revision:config.revision+1,rules:[...config.rules,{id,kind:'LIMIT',metric,maximum:Number(m[2]),enabled:false,action:'REVIEW'}]};
 }
 if(kind==='JOINRAID'){
  const m=/^([1-9][0-9]{0,2}) ([1-9][0-9]?) ([1-9][0-9]{0,2})$/u.exec(text);if(!m||m[0]!==text)return null;
  return {...config,revision:config.revision+1,joinRaid:{enabled:config.joinRaid?.enabled??false,minimumMembers:Number(m[1]),windowMs:Number(m[2])*1000,lockSeconds:Number(m[3])}};
 }
 if(kind==='NIGHT'){
  const m=/^([0-2][0-9]):([0-5][0-9]) ([0-2][0-9]):([0-5][0-9]) (-?(?:0|[1-9][0-9]{0,2}))$/u.exec(text);if(!m||m[0]!==text||Number(m[1])>23||Number(m[3])>23)return null;
  return {...config,revision:config.revision+1,night:{enabled:config.night?.enabled??false,startMinute:Number(m[1])*60+Number(m[2]),endMinute:Number(m[3])*60+Number(m[4]),offsetMinutes:Number(m[5])}};
 }
 if(kind==='RAID'){
  const m=/^([1-9][0-9]{0,2}) ([1-9][0-9]{0,3}) ([1-9][0-9]{0,2})$/u.exec(text);if(!m||m[0]!==text)return null;
  return {...config,revision:config.revision+1,raid:{enabled:config.raid?.enabled??false,minimumMembers:Number(m[1]),minimumMessages:Number(m[2]),lockSeconds:Number(m[3])}};
 }
 if(kind==='ESCALATION'){
  const m=/^([1-9][0-9]?) ([1-9][0-9]{0,4})$/u.exec(text);if(!m||m[0]!==text)return null;
  return {...config,revision:config.revision+1,escalation:{enabled:config.escalation?.enabled??false,afterWarnings:Number(m[1]),windowMs:Number(m[2])*1000}};
 }
 if(kind==='EXEMPT'){
  const m=/^([1-9][0-9]{0,15}) ([1-9][0-9]{0,4})$/u.exec(text);
  if(!m||m[0]!==text||!Number.isSafeInteger(Number(m[1]))||Number(m[2])<60||Number(m[2])>86400||config.exemptMemberIds.includes(m[1]!))return null;
  const rows=(config.temporaryExemptions??[]).filter(e=>e.expiresAt>now);
  if(rows.some(e=>e.memberId===m[1]))return null;
  return {...config,revision:config.revision+1,temporaryExemptions:[...rows,{memberId:m[1]!,createdAt:now,expiresAt:now+Number(m[2])*1000}]};
 }
 if(kind==='FLOOD'){
  const m=/^([1-9][0-9]{0,2}) ([1-9][0-9]?)(?: ([1-9][0-9]?))?$/u.exec(text);if(!m||m[0]!==text)return null;
  return {...config,revision:config.revision+1,flood:{enabled:config.flood?.enabled??false,limit:Number(m[1]),windowMs:Number(m[2])*1000,action:config.flood?.action??'REVIEW',...(m[3]===undefined?{}:{repeatLimit:Number(m[3])})}};
 }
 if(kind==='DOMAIN'||kind==='ALLOWPHRASE'){
  const field=kind==='DOMAIN'?'allowedDomains':'allowedPhrases';
  if(config[field].includes(text))return null;
  return {...config,revision:config.revision+1,[field]:[...config[field],text]};
 }
 const rules=rulesWithInput(config,kind,text,id,editing);
 return rules?{...config,revision:config.revision+1,rules}:null;
}
/** Shared owner/delegated private editor. Text samples are evaluated in memory;
 * only policy rules explicitly entered by an operator are persisted. */
export class TelegramProtectionEditor{
 private readonly service:GroupProtectionPolicyService;
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now,enforcer?:ProtectionEnforcer){this.service=new GroupProtectionPolicyService(store,policy,clock,enforcer);}
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
   stale:Boolean(saved&&(saved.chatPolicyVersion!==chat.version||saved.updatedAt>this.clock())),
   returnToOwnerGroup:this.policy.isOwner(actor)?ownerGroupCardLink(state,chat.id):null};
 }
 private back(actor:string,frame?:Frame):Button[]{return [btn('↩️ المجموعات','pr:1:h'),
  ...(frame?.returnToOwnerGroup?[btn('👥 بطاقة المجموعة',frame.returnToOwnerGroup)]:[]),
  btn(this.policy.isOwner(actor)?'🏠 لوحة المالك':'🏠 مجموعاتي الإشرافية',this.policy.isOwner(actor)?'mi:1:h':'ms:1:h')];}
 private groupScreen(actor:string,f:Frame,notice=''):OwnerInlineScreen{
  const rows:Button[][]=[];
  if(!f.stale){
   rows.push([btn('➕ إضافة كلمة',key('w',f)),btn('➕ إضافة عبارة',key('f',f))]);
   rows.push([btn('🔗 جميع الروابط',key('b',f)),btn('🌐 نطاق محدد',key('j',f))]);
   rows.push([btn('✅ سماح نطاق',key('c',f)),btn('📚 سماح عبارة',key('u',f))]);
   rows.push([btn('📋 النطاقات المسموحة',key('s',f,':0:1')),btn('📋 العبارات المسموحة',key('s',f,':0:2'))]);
   rows.push([btn('⏳ إضافة استثناء مؤقت',key('E',f)),btn('📋 الاستثناءات المؤقتة',key('s',f,':0:3'))]);
   rows.push([btn('📏 حدود المنشن والوسوم والطول',key('Q',f))]);
   rows.push([btn('🚨 قاعدة ادعاء هوية وطلب دفع',key('X',f))]);
   rows.push([btn('🔎 نطاقات تقلّد نطاقًا رسميًا',key('Y',f))]);
   rows.push([btn('👤 حماية اسم مشرف أو جهة',key('Z',f))]);
   rows.push([btn('🌊 مكافحة الفلود',key('S',f)),btn('📈 التدرج العقابي',key('B',f))]);
   rows.push([btn('🛡 AntiRaid مؤقت',key('J',f)),btn('🌙 الوضع الليلي',key('N',f))]);
   rows.push([btn('🔒 أنواع الرسائل',key('y',f,':0'))]);
   rows.push([btn('🔐 أقفال أذونات Telegram','lk:1:h')]);
   rows.push([btn('📋 القواعد',key('l',f,':0')),btn('🧪 اختبار القواعد',key('t',f))]);
   rows.push([btn('👁️ تشغيل المراقبة',key('m',f)),btn('⏹ إيقاف الفحص',key('o',f))]);
   if(this.service.canEnforce({...f.config,revision:Math.max(1,f.config.revision)}))rows.push([btn('⚠️ مراجعة تفعيل التنفيذ',key('H',f))]);
  }
  rows.push(this.back(actor,f));
  return screen('<b>🚫 الكلمات والعبارات والروابط والأنواع</b>\nالمجموعة: <code>'+escape(f.chat.id)+'</code>\n'
   +(notice?escape(notice)+'\n':'')+(f.stale?'السياسة قديمة أو وقتها غير موثوق؛ التعديل محجوب.':
    'الحالة: '+(f.config.mode==='OFF'?'متوقفة':f.config.mode==='MONITOR'?'مراقبة فقط':'تنفيذ القواعد المفعلة')+'\nالقواعد: '+f.config.rules.length+' · النسخة: '+f.config.revision)+'\n'
   +'التنفيذ يتطلب خدمة موصولة وتأكيدًا مستقلًا. الكتم التلقائي مدته دقيقة واحدة؛ '+(this.service.deletionConnected()?'الحذف لرسالة مطابقة مرصودة موثوقة فقط.':'الحذف غير موصول.'),rows);
 }
 private async fresh(actor:string,chat:string,notice=''):Promise<OwnerInlineScreen|null>{
  const state=await this.store.snapshot(),index=this.groups(state,actor).findIndex(c=>c.id===chat);
  if(index<0)return null;const f=this.frame(state,actor,Math.floor(index/8),index%8+1);
  return f?this.groupScreen(actor,f,notice):null;
 }
 /** The group-card selector is only a locator; rebuild the actual editor from
  * current authorized policy and its current group-specific fingerprint. */
 async openOwnerGroup(actor:string,chat:string,revision:number):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!Number.isSafeInteger(revision)||revision<1)return null;
  const state=await this.store.snapshot();
  if(!this.policy.privateFeature(state,'owner.dashboard',actor))return null;
  const index=this.groups(state,actor).findIndex(c=>c.id===chat&&c.version===revision);
  if(index<0)return null;
  const frame=this.frame(state,actor,Math.floor(index/8),index%8+1);
  return frame?this.groupScreen(actor,frame):null;
 }
 private failure(actor:string,text='تغيرت الصلاحية أو السياسة؛ افتح القسم من جديد.'):OwnerInlineScreen{return screen(text,[this.back(actor)]);}
 async handle(data:string,actor:string):Promise<OwnerInlineScreen|null>{
  if(!validTime(this.clock()))return null;
  const route=protectionInlineRoute(/^mi:1:i:02:(?:0[56789]|12)$/u.test(data)?'pr:1:h':data);if(!route)return null;
  if(route.kind!=='I')await this.cancelEnforcement(actor);
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
  if(route.kind==='H'||route.kind==='I'){
   if(!this.service.canEnforce({...f.config,revision:Math.max(1,f.config.revision)}))return null;
   if(route.kind==='H'){
    const nonce=randomBytes(12).toString('base64url'),now=this.clock();
    const created=await this.store.transaction(s=>{
     const live=this.frame(s,actor,f.page,f.slot);if(!live||live.digest!==f.digest||live.stale)return false;
     const key='protection-enforce:'+actor;const old=s.wizards.find(w=>w.key===key);
     const value:Wizard={key,userId:actor,chatId:actor,topicId:'',flow:'protection-enforce:'+f.chat.id+':'+f.digest+':'+nonce,step:0,version:(old?.version??0)+1,expiresAt:now+120000,policyVersion:f.epoch,status:'ACTIVE'};
     if(old)Object.assign(old,value);else s.wizards.push(value);return true;
    });
    return created?screen('⚠️ تفعيل تنفيذ القواعد المفعلة لهذه المجموعة؟\nالمراجعة تُسجل فقط، والتحذير يسجل مخالفة، والكتم مدته دقيقة واحدة. تُحترم الاستثناءات وحماية المشرفين والصلاحيات. '+(this.service.deletionConnected()?'الحذف لرسالة المطابقة المفهرسة فقط؛ لا حذف عند غياب بياناتها الموثوقة.':'الحذف غير موصول.')+'\nالوضع الليلي: '+(f.config.night?.enabled?'قفل واستعادة حسب الوقت المحفوظ':'معطل')+'\nAntiRaid: '+(f.config.raid?.enabled?'قفل إرسال مؤقت '+f.config.raid.lockSeconds+' ثانية؛ استعادة اللقطة عبر العامل المفعّل':'معطل')+'\nرصد الانضمام: '+(f.config.joinRaid?.enabled?'قفل مؤقت '+f.config.joinRaid.lockSeconds+' ثانية':'معطل')+'\nعدد القواعد المفعلة: '+f.config.rules.filter(r=>r.enabled).length+'\nالفلود: '+(f.config.flood?.enabled?'مفعل':'متوقف')+'\nالتأكيد صالح لدقيقتين؛ الرجوع يلغيه.',[[btn('✅ تأكيد التنفيذ',key('I',f,':'+nonce))],[btn('↩️ رجوع دون تفعيل',key('g',f))]]):null;
   }
   const claimed=await this.store.transaction(s=>{
    const rows=s.wizards.filter(w=>w.key==='protection-enforce:'+actor),w=rows[0],now=this.clock();
    if(rows.length!==1||!w||w.status!=='ACTIVE'||w.userId!==actor||w.chatId!==actor||w.policyVersion!==f.epoch||w.expiresAt<=now||w.expiresAt>now+120000||w.flow!=='protection-enforce:'+f.chat.id+':'+f.digest+':'+route.nonce)return false;
    w.status='CANCELLED';w.version++;return true;
   });
   if(!claimed)return null;
   const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,mode:'ENFORCE'},f.epoch,f.config.revision);
   return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'فُعّل تنفيذ القواعد المدعومة.'):null;
  }
  if(route.kind==='Q')return this.begin(actor,f,'LIMIT');
  if(route.kind==='X')return this.begin(actor,f,'FRAUD');
  if(route.kind==='Y')return this.begin(actor,f,'LOOKALIKE');
  if(route.kind==='Z')return this.begin(actor,f,'NAME');
  if(route.kind==='N')return this.nightScreen(f);
  if(route.kind==='O')return this.begin(actor,f,'NIGHT');
  if(route.kind==='P'){
   if(!f.config.night)return null;
   const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,night:{...f.config.night,enabled:!f.config.night.enabled}},f.epoch,f.config.revision);
   return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'حُفظ إعداد الوضع الليلي.'):null;
  }
  if(route.kind==='U')return this.joinRaidScreen(f);
  if(route.kind==='V')return this.begin(actor,f,'JOINRAID');
  if(route.kind==='W'){
   if(!f.config.joinRaid)return null;
   const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,joinRaid:{...f.config.joinRaid,enabled:!f.config.joinRaid.enabled}},f.epoch,f.config.revision);
   return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'حُفظ إعداد رصد الانضمام.'):null;
  }
  if(route.kind==='J')return this.raidScreen(f);
  if(route.kind==='K')return this.begin(actor,f,'RAID');
  if(route.kind==='L'){
   if(!f.config.raid||!f.config.flood?.enabled)return null;
   const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,raid:{...f.config.raid,enabled:!f.config.raid.enabled}},f.epoch,f.config.revision);
   return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'حُفظ إعداد AntiRaid.'):null;
  }
  if(route.kind==='B')return this.escalationScreen(f);
  if(route.kind==='C')return this.begin(actor,f,'ESCALATION');
  if(route.kind==='D'){
   if(!f.config.escalation)return null;
   const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,escalation:{...f.config.escalation,enabled:!f.config.escalation.enabled}},f.epoch,f.config.revision);
   return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'حُفظ إعداد التدرج.'):null;
  }
  if(route.kind==='F')return this.begin(actor,f,'FLOOD');
  if(route.kind==='S')return this.floodScreen(f);
  if(route.kind==='T'||route.kind==='A'){
   if(!f.config.flood||route.kind==='A'&&!route.action)return null;
   const flood={...f.config.flood,...(route.kind==='T'?{enabled:!f.config.flood.enabled}:{action:route.action!})};
   const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,flood},f.epoch,f.config.revision);
   if(saved.status!=='SAVED')return null;
   const state=await this.store.snapshot(),index=this.groups(state,actor).findIndex(c=>c.id===f.chat.id);
   const current=index<0?null:this.frame(state,actor,Math.floor(index/8),index%8+1);return current&&!current.stale?this.floodScreen(current):null;
  }
  if(route.kind==='E')return this.begin(actor,f,'EXEMPT');
  if(route.kind==='c'||route.kind==='u')return this.begin(actor,f,route.kind==='c'?'DOMAIN':'ALLOWPHRASE');
  if(route.kind==='s'||route.kind==='q'||route.kind==='k'){
   const listKind=route.kind==='s'?(route.ruleSlot===1?'d':route.ruleSlot===2?'p':route.ruleSlot===3?'e':null):route.listKind;
   if(!listKind)return null;
   const field=listKind==='d'?'allowedDomains':'allowedPhrases',values=listKind==='e'?(f.config.temporaryExemptions??[]).map(e=>e.memberId+' · '+(this.clock()<e.createdAt?'وقت غير موثوق':this.clock()<e.expiresAt?'ينتهي ':'منتهي ')+new Date(e.expiresAt).toISOString()):f.config[field],page=route.rulePage??0;
   if(page>=Math.max(1,Math.ceil(values.length/8)))return null;
   if(route.kind==='s'){
    const rows=values.slice(page*8,page*8+8).map((value,i)=>[btn('🗑 '+Array.from(value).slice(0,40).join(''),key('q',f,':'+page+':'+(i+1)+':'+listKind))]);
    const nav:Button[]=[];if(page>0)nav.push(btn('⬅️ السابق',key('s',f,':'+(page-1)+':'+(listKind==='d'?1:listKind==='e'?3:2))));
    if((page+1)*8<values.length)nav.push(btn('➡️ التالي',key('s',f,':'+(page+1)+':'+(listKind==='d'?1:listKind==='e'?3:2))));
    if(nav.length)rows.push(nav);rows.push([btn('↩️ إعدادات المجموعة',key('g',f))]);
    return screen((listKind==='e'?'الاستثناءات المؤقتة من فحص المحتوى والفلود فقط؛ لا تمنح صلاحيات أو ترفع عقوبات.':listKind==='d'?'النطاقات المسموحة: تطابق المضيف بالضبط.':'العبارات المسموحة: تعفى في موضعها فقط.')+'\n'+values.slice(page*8,page*8+8).map(v=>'• '+escape(listKind==='p'?Array.from(v).slice(0,60).join('')+(Array.from(v).length>60?'…':''):v)).join('\n'),rows);
   }
   const index=page*8+(route.ruleSlot??1)-1,value=values[index];if(value===undefined)return null;
   if(route.kind==='q')return screen('إزالة عنصر السماح التالي؟\n'+escape(value),[[btn('✅ تأكيد الإزالة',key('k',f,':'+page+':'+(route.ruleSlot??1)+':'+listKind)),btn('↩️ إلغاء',key('s',f,':'+page+':'+(listKind==='d'?1:listKind==='e'?3:2)))]]);
   const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,...(listKind==='e'?{temporaryExemptions:(f.config.temporaryExemptions??[]).filter((_,i)=>i!==index)}:{[field]:values.filter((_,i)=>i!==index)})},f.epoch,f.config.revision);
   return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'أُزيل عنصر السماح.'):null;
  }
  if(route.kind==='j')return this.begin(actor,f,'LINK');
  if(route.kind==='b')return this.addRule(actor,f,{id:newRuleId(f.config),kind:'LINK',hosts:'*',enabled:false,action:'REVIEW'});
  if(route.kind==='y'||route.kind==='n'){
   const entries:[ProtectionMessageType|'FORWARDED',string][]=[...(Object.entries(types) as [ProtectionMessageType,string][]),['FORWARDED','إعادة توجيه']],page=route.rulePage??0;
   if(page>=Math.ceil(entries.length/8))return null;
   if(route.kind==='n'){
    const type=entries[page*8+(route.ruleSlot??1)-1]?.[0];
    return type?this.addRule(actor,f,type==='FORWARDED'?{id:newRuleId(f.config),kind:'FORWARD',enabled:false,action:'REVIEW'}:{id:newRuleId(f.config),kind:'TYPE',type,enabled:false,action:'REVIEW'}):null;
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
  if(route.kind==='v')return rule.kind==='WORD'||rule.kind==='PHRASE'||rule.kind==='FRAUD'||rule.kind==='LOOKALIKE'||rule.kind==='NAME'?this.begin(actor,f,rule.kind,rule.id):null;
  if(route.kind==='r')return screen('<b>تفاصيل القاعدة</b>\n'
   +escape(ruleName(rule))+'\nالحالة: '+(rule.enabled?'مفعلة':'معطلة')+'\nالإجراء المقترح: '+actions[rule.action]+'\n'+(f.config.mode==='ENFORCE'?'هذه سياسة تنفيذ محفوظة؛ ينفذ الإجراء عند اتصال خدمته واستيفاء شروطه. الكتم لدقيقة والحذف لرسالة مرصودة موثوقة فقط.':'وضع المجموعة لا يرسل عقوبات تلقائية.'),[
    ...(rule.kind==='WORD'||rule.kind==='PHRASE'||rule.kind==='FRAUD'||rule.kind==='LOOKALIKE'||rule.kind==='NAME'?[[btn('✏️ تعديل النص',key('v',f,suffix))]]:[]),
    ...(rule.kind==='WORD'?[[btn(rule.match==='PARTIAL'?'🔎 المطابقة: جزئية — اضغط للكاملة':'🔎 المطابقة: كلمة كاملة — اضغط للجزئية',key('R',f,suffix))]]:[]),
    [btn(rule.enabled?'⏸ تعطيل القاعدة':'✅ تفعيل القاعدة',key('e',f,suffix))],
    [btn('مراجعة',key('a',f,suffix+':r')),btn('تحذير',key('a',f,suffix+':w'))],
    [btn('حذف مقترح',key('a',f,suffix+':d')),btn('كتم مقترح',key('a',f,suffix+':m'))],
    [btn('🗑 حذف القاعدة',key('d',f,suffix)),btn('↩️ القواعد',key('l',f,':'+rulePage))]
   ]);
  if(route.kind==='d')return screen('هل تريد حذف هذه القاعدة من إعدادات المجموعة؟ لن تُحذف أي رسالة.',[[btn('✅ تأكيد حذف القاعدة',key('x',f,suffix)),btn('↩️ إلغاء',key('r',f,suffix))]]);
  const next=structuredClone(f.config);next.revision++;
  if(route.kind==='R'&&rule.kind==='WORD'){const changed=next.rules[index]!;if(changed.kind!=='WORD')return null;if(changed.match==='PARTIAL')delete changed.match;else changed.match='PARTIAL';}
  else if(route.kind==='e')next.rules[index]!.enabled=!rule.enabled;
  else if(route.kind==='a'&&route.action)next.rules[index]!.action=route.action;
  else if(route.kind==='x')next.rules.splice(index,1);
  else return null;
  const saved=await this.service.save(actor,next,f.epoch,f.config.revision);
  return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'حُفظ تعديل القاعدة.'):null;
 }
 private nightScreen(f:Frame):OwnerInlineScreen{
  const n=f.config.night,hhmm=(v:number)=>String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0');
  return screen('الوضع الليلي المتكرر: قفل الإرسال ضمن الفترة اليومية ثم استعادة اللقطة الأصلية. يستخدم إزاحة UTC ثابتة بالدقائق، بلا تحويل تلقائي للتوقيت الصيفي. يتطلب وضع التنفيذ وعامل الاستعادة المفعّل.\n'+(n?'الحالة: '+(n.enabled?'مفعل':'معطل')+' · من '+hhmm(n.startMinute)+' إلى '+hhmm(n.endMinute)+' · UTC بالدقائق '+n.offsetMinutes:'لم يُضبط بعد.')+'\nلن يفتح قيدًا مستقلاً أو يستبدل معاينة بشرية. يتوقف عند تغير الأذونات أو الغموض؛ راجع السجل. إيقاف السياسة يمنع قفلاً جديدًا، ويظل موعد استعادة القفل المؤكد محفوظًا.',[[btn('⚙️ ضبط الوقت والإزاحة',key('O',f))],...(n?[[btn(n.enabled?'⏹ تعطيل الليلي':'✅ تفعيل الليلي',key('P',f))]]:[]),[btn('↩️ إعدادات المجموعة',key('g',f))]]);
 }
 private joinRaidScreen(f:Frame):OwnerInlineScreen{
  const r=f.config.joinRaid;
  return screen('رصد دفعات الانضمام من رسائل الخدمة البشرية الجديدة التي تصل إلى البوت. يستبعد البوتات والمالك والمشرفين والاستثناءات، ويعد الحساب مرة واحدة في النافذة. لا يجلب سجل أعضاء ولا يرصد كل طرق الانضمام أو دعوات البوتات.\n'+(r?'الحالة: '+(r.enabled?'مفعل':'معطل')+' · أعضاء: '+r.minimumMembers+' · النافذة بالثواني: '+r.windowMs/1000+' · القفل بالثواني: '+r.lockSeconds:'لم يُضبط بعد.')+'\nفي المراقبة يسجل الرصد فقط. التنفيذ يحتاج التأكيد المستقل ومنفذ قفل وعامل استعادة مفعّل؛ لا حظر للأعضاء.',[[btn('⚙️ ضبط العدد والنافذة والمدة',key('V',f))],...(r?[[btn(r.enabled?'⏹ تعطيل رصد الانضمام':'✅ تفعيل رصد الانضمام',key('W',f))]]:[]),[btn('↩️ AntiRaid',key('J',f))]]);
 }
 private raidScreen(f:Frame):OwnerInlineScreen{
  const r=f.config.raid;
  return screen('AntiRaid لمعدل الإرسال الجماعي: يستخدم نافذة الفلود المرصودة فقط، ولا يدعي رصد الانضمامات. لا حظر جماعي؛ قفل إرسال مؤقت بلقطة أصلية. يشترط منفذًا موصولاً وعامل استعادة مفعلاً وتأكيد وضع التنفيذ.\n'+(r?'الحالة: '+(r.enabled?'مفعل':'معطل')+' · أعضاء: '+r.minimumMembers+' · رسائل: '+r.minimumMessages+' · القفل بالثواني: '+r.lockSeconds:'لم يُضبط بعد.')+'\nفعّل نافذة الفلود أولاً. العد محدود وقد يقل عن إجمالي الرسائل، ولا تُحتسب الرسائل المعدلة أو الأعضاء المستثنون. الاستعادة تحجب عند تغير الأذونات أو الحقوق أو غموض النتيجة.',[[btn('🚪 رصد دفعات الانضمام',key('U',f))],[btn('⚙️ ضبط الحدود والمدة',key('K',f))],...(r&&f.config.flood?.enabled?[[btn(r.enabled?'⏹ تعطيل AntiRaid':'✅ تفعيل AntiRaid',key('L',f))]]:[]),[btn('↩️ إعدادات المجموعة',key('g',f))]]);
 }
 private escalationScreen(f:Frame):OwnerInlineScreen{
  const e=f.config.escalation;
  return screen('التدرج الاختياري: المخالفة ذات إجراء التحذير تتحول إلى كتم لدقيقة بعد بلوغ عدد التحذيرات النشطة للعضو في النافذة، بما فيها اليدوية. لا حظر دائم ولا عقوبتان للمخالفة نفسها.\n'+(e?'الحالة: '+(e.enabled?'مفعل':'معطل')+' · التحذيرات السابقة: '+e.afterWarnings+' · النافذة بالثواني: '+e.windowMs/1000:'لم يُضبط بعد.')+'\nالتنفيذ يتطلب تفعيل سياسة التنفيذ المستقل.',[[btn('⚙️ ضبط العدد والنافذة',key('C',f))],...(e?[[btn(e.enabled?'⏹ تعطيل التدرج':'✅ تفعيل التدرج',key('D',f))]]:[]),[btn('↩️ إعدادات المجموعة',key('g',f))]]);
 }
 private floodScreen(f:Frame):OwnerInlineScreen{
  const config=f.config.flood,rows:Button[][]=[[btn('⚙️ ضبط العدد والمدة',key('F',f))]];
  if(config){
   rows.push([btn(config.enabled?'⏹ تعطيل الفلود':'✅ تفعيل الفلود',key('T',f))]);
   rows.push([btn('مراجعة',key('A',f,':r')),btn('تحذير مقترح',key('A',f,':w'))]);
   rows.push([btn('حذف مقترح',key('A',f,':d')),btn('كتم مقترح',key('A',f,':m'))]);
  }
  rows.push([btn('↩️ إعدادات المجموعة',key('g',f))]);
  return screen('مكافحة الفلود — إعداد محلي\nالمجموعة: <code>'+escape(f.chat.id)+'</code>\n'+(config?'الحالة: '+(config.enabled?'مفعلة':'متوقفة')+'\nالحد: '+config.limit+' رسالة خلال '+config.windowMs/1000+' ثانية\nالإجراء المقترح: '+actions[config.action]:'لم تضبط سياسة فلود لهذه المجموعة.')+'\nيُحتسب الفلود في المراقبة أو التنفيذ؛ التنفيذ يتطلب الخدمة الموصولة والتأكيد المستقل. تعديل الرسالة لا يحتسب رسالة جديدة.',rows);
 }
 private async addRule(actor:string,f:Frame,rule:ProtectionRule):Promise<OwnerInlineScreen|null>{
  const duplicate=f.config.rules.some(r=>r.kind===rule.kind&&(r.kind==='TYPE'&&rule.kind==='TYPE'?r.type===rule.type:r.kind==='LINK'&&rule.kind==='LINK'?JSON.stringify(r.hosts)===JSON.stringify(rule.hosts):r.kind==='FORWARD'&&rule.kind==='FORWARD'));
  if(duplicate)return this.groupScreen(actor,f,'توجد قاعدة لهذا الهدف؛ عدّلها من قائمة القواعد.');
  if(f.config.rules.length>=100)return this.groupScreen(actor,f,'بلغت السياسة الحد الحالي: 100 قاعدة.');
  const saved=await this.service.save(actor,{...f.config,revision:f.config.revision+1,rules:[...f.config.rules,rule]},f.epoch,f.config.revision);
  return saved.status==='SAVED'?this.fresh(actor,f.chat.id,'أُضيفت قاعدة معطلة بإجراء مراجعة. اختبرها أولًا.'):null;
 }
 private active(state:BotState,actor:string):Wizard[]{return state.wizards.filter(w=>w.userId===actor&&w.chatId===actor&&w.status==='ACTIVE'&&typeof w.flow==='string'&&w.flow.startsWith(PREFIX));}
 private decode(w:Wizard):RegExpExecArray|null{
  const m=flow.exec(w.flow);
  if(!m||m[0]!==w.flow||!['WORD','PHRASE','LINK','FRAUD','LOOKALIKE','NAME'].includes(m[1]!)&&m[7]!==undefined||w.key!==JSON.stringify([w.userId,w.chatId,'',w.flow])||w.topicId!==''||w.step!==0||w.version!==1||
   !Number.isSafeInteger(w.expiresAt)||!validTime(Number(m[5]))||w.expiresAt!==Number(m[5])+TTL||w.policyVersion!==Number(m[3])||![Number(m[3]),Number(m[4])].every(Number.isSafeInteger))return null;
  return m;
 }
 private async begin(actor:string,f:Frame,kind:InputKind,editRuleId?:string):Promise<OwnerInlineScreen|null>{
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
  return created?screen(kind==='TEST'?'أرسل عينة نصية لاختبار قواعد المحتوى، بما فيها المعطلة، دون تشغيلها أو حفظ العينة. لاختبار اسم العرض أرسل «اسم: » ثم الاسم. لا يختبر هذا المسار وتيرة الفلود.':
   kind==='NAME'?'أرسل اسم العرض المحمي ثم رقم حساب صاحبه الموثوق، وبينهما |، مثل: إدارة منارتك | 123456. يتحقق المشرف من الرقم بنفسه؛ القاعدة تقارن الاسم وتستثني هذا الرقم فقط ولا تثبت الانتحال. تبدأ معطلة بإجراء مراجعة، واختبر الأسماء المتشابهة قبل تفعيلها.':
   kind==='FRAUD'?'أرسل عبارتين مختلفتين تفصل بينهما |: الأولى لادعاء الهوية والثانية لطلب الدفع. مثال: ممثل منارتك | رسوم التسجيل. ترصد القاعدة اجتماعهما في رسالة واحدة؛ لا تثبت الاحتيال أو هوية المرسل ولا تكشف كل الأساليب. تبدأ معطلة بإجراء مراجعة؛ اختبرها قبل تفعيلها.':
   kind==='LOOKALIKE'?'أرسل النطاق الرسمي المرجعي بحروف إنجليزية صغيرة دون رابط أو مسار، مثل example.org. ترصد القاعدة تغييرًا واحدًا في النطاق أو إضافة نطاق بعده، ولا تثبت الاحتيال ولا تكشف جميع التشابهات. يبدأ الفحص معطلاً للمراجعة؛ اختبر النتائج الخاطئة قبل تفعيله.':
   kind==='LIMIT'?'أرسل نوع الحد ثم العدد. الأنواع: mentions للمنشن، hashtags للوسوم، length لطول الرسالة بالحروف، quotes لعدد كتل الاقتباس المنسقة. مثال: mentions 5. الحد من 1 إلى 100 للمنشن والوسوم وكتل الاقتباس وحتى 4096 للطول. تبدأ القاعدة معطلة بإجراء مراجعة.':
   kind==='JOINRAID'?'أرسل عدد الأعضاء ثم نافذة الرصد ثم مدة القفل بالثواني، مثل 5 30 120. العدد من 3 إلى 100، النافذة من 5 إلى 60 ثانية، القفل من 60 إلى 600 ثانية. يبدأ الإعداد الجديد معطلاً.':
   kind==='NIGHT'?'أرسل البداية والنهاية بصيغة 24 ساعة ثم إزاحة UTC بالدقائق. مثال لليمن: 22:00 06:00 180. الوقتان مختلفان والإزاحة من -720 إلى 840؛ يبدأ الإعداد الجديد معطلاً.':
   kind==='RAID'?'أرسل عدد الأعضاء ثم عدد الرسائل ثم مدة القفل بالثواني؛ مثال: 5 20 120. الأعضاء من 2 إلى 100 والرسائل حتى 1000 ولا تقل عن الأعضاء، والمدة من 60 إلى 600. يبدأ الإعداد الجديد معطلاً.':
   kind==='ESCALATION'?'أرسل عدد التحذيرات السابقة من 1 إلى 20 ثم نافذة بالثواني من 60 إلى 86400؛ مثال: 3 3600. يبدأ الإعداد الجديد معطلاً. الكتم لمدة دقيقة فقط.':
   kind==='EXEMPT'?'أرسل رقم العضو ثم المدة بالثواني، مفصولين بمسافة؛ المدة من 60 إلى 86400. مثال: 300 600. الاستثناء لفحص المحتوى والفلود فقط، ولا يرفع عقوبة قائمة. الرجوع يلغي الإدخال.':
   kind==='FLOOD'?'أرسل عدد الرسائل ثم المدة بالثواني، مفصولين بمسافة. العدد من 1 إلى 100 والمدة من 1 إلى 60. مثال: 10 30؛ ويمكن إضافة حد تكرار من 2 إلى عدد الرسائل: 10 30 3. يرصد النص المتطابق بعد التطبيع لنفس العضو من 8 محارف، دون حفظ النص؛ لا يربط المجموعات. حذف الرقم الثالث يعطل هذا الفحص. تبدأ السياسة الجديدة معطلة بإجراء مراجعة.':
   kind==='DOMAIN'?'أرسل اسم نطاق مسموح واحدًا بحروف صغيرة دون رابط أو مسار، مثل school.edu. السماح للمضيف نفسه فقط ولا يعفي أنواع الرسائل.':
   kind==='ALLOWPHRASE'?'أرسل عبارة تعليمية مسموحة حتى 120 حرفًا. تعفى في موضعها فقط ولا تعفي بقية الرسالة أو نوعها.':
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
 private async cancelEnforcement(actor:string):Promise<void>{
  if(!(await this.store.snapshot()).wizards.some(w=>w.key==='protection-enforce:'+actor&&w.status==='ACTIVE'))return;
  await this.store.transaction(s=>{
  for(const w of s.wizards.filter(w=>w.key==='protection-enforce:'+actor&&w.status==='ACTIVE')){w.status='CANCELLED';w.version++;}
 });}
 async cancelNavigation(actor:string):Promise<void>{await this.cancel(actor);await this.cancelEnforcement(actor);}
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
    if(route.kind==='I'){
     const rows=state.wizards.filter(w=>w.key==='protection-enforce:'+actor),w=rows[0];
     if(rows.length!==1||!w||w.status!=='ACTIVE'||w.userId!==actor||w.chatId!==actor||w.policyVersion!==f.epoch||w.expiresAt<=now||w.expiresAt>now+120000||w.flow!=='protection-enforce:'+f.chat.id+':'+f.digest+':'+route.nonce)return null;
    }
   }
  }
  return {actorId:actor,epoch,expiresAt:now+ADMIN_UI_TTL_MS};
 }
 async handleText(actor:string,text:string,navigation:boolean):Promise<Outcome|null>{
  await this.cancelEnforcement(actor);
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
    if(!m[7]&&!['DOMAIN','ALLOWPHRASE','FLOOD','EXEMPT','ESCALATION','RAID','NIGHT'].includes(m[1]!)&&f.config.rules.length>=100)return {kind:'RETRY' as const,notice:'بلغت السياسة الحد الحالي للقواعد. ألغ الخطوة واحذف قاعدة قبل إضافة أخرى.'};
    if(!m[7])ruleId=newRuleId(f.config);
    const candidate=inputPolicy(f.config,m[1] as Exclude<InputKind,'TEST'>,text,ruleId,Boolean(m[7]),now);
    if(!candidate||!isValidProtectionPolicy(candidate))return {kind:'RETRY' as const,notice:'المدخل غير صالح أو مكرر أو يتجاوز الحد. راجع صيغة الخطوة أو أرسل /cancel.'};
   }
   w.status='CANCELLED';w.version++;
   return {kind:m[1] as InputKind,frame:f,ruleId,editing:Boolean(m[7])};
  });
  if(!claim)return null;
  if(claim.kind==='DENIED')return {status:'DENIED',reason:'PROTECTION_EDITOR_STALE',screen:this.failure(actor)};
  if(claim.kind==='RETRY')return {status:'APPLIED',reason:'PROTECTION_EDITOR_INPUT_REJECTED',screen:screen(claim.notice,[[btn('↩️ المجموعات','pr:1:h')]])};
  const f=claim.frame;
  if(claim.kind==='TEST'){
   const config={...f.config,mode:'MONITOR' as const,rules:f.config.rules.map(r=>({...r,enabled:true}))};
   const displayName=text.startsWith('اسم: ')?text.slice('اسم: '.length):undefined;
   const result=evaluateProtectionRules(config,{chatId:f.chat.id,memberId:actor,type:'TEXT',text,...(displayName!==undefined?{displayName}:{})},this.clock());
   if(result.status==='INVALID_MESSAGE'||result.status==='INVALID_POLICY')return {status:'APPLIED',reason:'PROTECTION_DRY_RUN_UNAVAILABLE',screen:screen('تعذر فحص العينة. اسم العرض من حرف إلى 128 حرفًا ولا يقبل محارف التحكم. افتح الاختبار وأرسل عينة صحيحة.',[[btn('↩️ إعدادات المجموعة',key('g',f))]])};
   const matched=f.config.rules.filter(r=>result.matchedRuleIds.includes(r.id));
   const explanations=matched.slice(0,6).map(r=>{
    const name=Array.from(ruleName(r)).slice(0,45).join('');
    const reason=r.kind==='WORD'?(r.match==='PARTIAL'?'جزء من كلمة':'كلمة كاملة'):r.kind==='PHRASE'?'عبارة متجاورة':r.kind==='FRAUD'?'اجتماع عبارتي الادعاء والدفع':r.kind==='LOOKALIKE'?'نطاق مشابه للمرجع':r.kind==='NAME'?'تطابق الاسم مع رقم مختلف':'TYPE'===r.kind?'نوع رسالة':r.kind==='FORWARD'?'إعادة توجيه':r.kind==='LIMIT'?'تجاوز الحد المضبوط':'سياسة روابط';
    return '• '+escape(name)+' — '+reason+'؛ '+actions[r.action];
   }).join('\n');
   return {status:'APPLIED',reason:'PROTECTION_DRY_RUN_ONLY',screen:screen('نتيجة الاختبار المحلي: '+(result.status==='MATCH'?'مطابقة':'لا مطابقة')+'\nنسخة الاختبار: '+f.config.revision+'\nالقواعد المطابقة: '+result.matchedRuleIds.length+'\nالإجراء المقترح: '+(result.proposedAction?actions[result.proposedAction]:'لا شيء')+'\n'+explanations+(matched.length>6?'\nتوجد مطابقات إضافية؛ راجع قائمة القواعد.':'')+'\nلم تُحفظ العينة أو تُفعّل عقوبة.',[[btn('↩️ إعدادات المجموعة',key('g',f))]])};
  }
  const candidate=inputPolicy(f.config,claim.kind,text,claim.ruleId,claim.editing,this.clock());
  if(!candidate)return {status:'DENIED',reason:'PROTECTION_EDITOR_STALE',screen:this.failure(actor)};
  const saved=await this.service.save(actor,candidate,f.epoch,f.config.revision);
  const view=saved.status==='SAVED'?await this.fresh(actor,f.chat.id,claim.kind==='JOINRAID'?'حُفظت حدود رصد الانضمام؛ تفعيل التنفيذ مستقل.':claim.kind==='NIGHT'?'حُفظ الوقت اليومي وإزاحة UTC.':claim.kind==='RAID'?'حُفظت حدود AntiRaid المؤقتة.':claim.kind==='ESCALATION'?'حُفظ عدد التحذيرات ونافذة التدرج.':claim.kind==='EXEMPT'?'حُفظ الاستثناء المؤقت؛ ينتهي تلقائيًا في الموعد المعروض.':claim.kind==='FLOOD'?'حُفظت حدود الفلود المحلية.':claim.kind==='DOMAIN'||claim.kind==='ALLOWPHRASE'?'حُفظ عنصر السماح المحلي.':claim.editing?'حُفظ النص البديل مع إبقاء إعدادات القاعدة.':'أُضيفت القاعدة معطلة؛ راجعها واختبرها قبل أي تفعيل.'):null;
  return view?{status:'APPLIED',reason:'PROTECTION_RULE_SAVED',screen:view}:{status:'DENIED',reason:'PROTECTION_EDITOR_STALE',screen:this.failure(actor)};
 }
}
