import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {GroupWelcomeFarewell,savedGreetingVersion,type GreetingKind} from './group-welcome-farewell.js';

const PREFIX='welcome-owner:',ROOT='mi:1:i:09:01',GUIDE_ROOT='mi:1:i:09:02',TTL=120000;
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const int=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-TTL;
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
type Kind='GROUPS'|'GROUP'|'EDIT'|'TEMPLATES'|'PREVIEW'|'CONFIRM'|'OFF_PREVIEW'|'OFF_CONFIRM';
type Step={kind:Kind;page:number;chat:string;greeting:GreetingKind;templateId:string;templateRevision:number};
const initial:Step={kind:'GROUPS',page:0,chat:'',greeting:'WELCOME',templateId:'',templateRevision:0};
const title=(kind:GreetingKind)=>kind==='WELCOME'?'الترحيب':kind==='FAREWELL'?'الوداع':'دليل العضو الجديد';
export const validWelcomeOwnerRoute=(route:string):boolean=>/^wm:1:[A-Za-z0-9_-]{24}$/u.test(route);
export class TelegramWelcomeOwner{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly greetings:GroupWelcomeFarewell,private readonly clock:()=>number=Date.now){}
 private auth(s:BotState,actor:string,now:number):boolean{
  return int(now)&&this.policy.isOwner(actor)&&this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private groups(s:BotState):string[]{
  const seen=new Set<string>();
  return s.chats.filter(c=>group(c.id)&&s.chats.filter(x=>x.id===c.id).length===1&&
   this.policy.canUseChat(s,c.id,'moderation')&&!seen.has(c.id)&&seen.add(c.id)).
   map(c=>c.id).sort();
 }
 private validStep(v:unknown):v is Step{
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const s=v as Record<string,unknown>;
  return Object.keys(s).sort().join(',')==='chat,greeting,kind,page,templateId,templateRevision'&&
   ['GROUPS','GROUP','EDIT','TEMPLATES','PREVIEW','CONFIRM','OFF_PREVIEW','OFF_CONFIRM'].includes(String(s.kind))&&
   ['WELCOME','FAREWELL','GUIDE'].includes(String(s.greeting))&&Number.isSafeInteger(s.page)&&
   Number(s.page)>=0&&Number(s.page)<=999&&typeof s.chat==='string'&&
   typeof s.templateId==='string'&&Number.isSafeInteger(s.templateRevision);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||(data!==ROOT&&data!==GUIDE_ROOT&&!validWelcomeOwnerRoute(data)))return null;
  const chosen=await this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))return null;
   let step:Step=data===GUIDE_ROOT?{...initial,greeting:'GUIDE'}:initial,ref:string|undefined,expected:string|null=null;
   if(data!==ROOT&&data!==GUIDE_ROOT){
    const found=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(5)),c=found[0];
    if(found.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||
       !c.oneShot||c.used||c.revoked||!int(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
    try{
     const raw:unknown=JSON.parse(c.action);
     if(!Array.isArray(raw)||raw.length!==2||!this.validStep(raw[0])||typeof raw[1]!=='string')return null;
     step=raw[0];expected=raw[1];
    }catch{return null;}
    if(step.chat!==''&&this.greetings.epoch(s,step.chat,step.greeting)!==expected)return null;
    c.used=true;ref=c.ref;
   }
   for(const callback of s.callbacks)if(callback.actorId===actor&&callback.ref.startsWith(PREFIX)&&
      callback.ref!==ref&&!callback.used)callback.revoked=true;
   return {step,ref,expected};
  });
  if(!chosen)return null;
  let {step}=chosen;
  if(step.kind==='CONFIRM'||step.kind==='OFF_CONFIRM'){
   if(!chosen.ref||!chosen.expected||!await this.greetings.configure(actor,step.chat,step.greeting,
    step.kind==='CONFIRM',step.kind==='CONFIRM'?step.templateId:'',step.kind==='CONFIRM'?step.templateRevision:0,
    chosen.expected,chosen.ref))return null;
   step={...step,kind:'EDIT',page:0};
  }
  return this.store.transaction(s=>{
   const now=this.clock();if(!this.auth(s,actor,now))return null;
   const groups=this.groups(s);
   if(step.kind!=='GROUPS'&&!groups.includes(step.chat))return null;
   const config=step.kind!=='GROUPS'?this.greetings.policy(s,step.chat,step.greeting):null;
   if(step.kind!=='GROUPS'&&!config)return null;
   const make=(label:string,next:Step)=>{
    const key=PREFIX+randomBytes(18).toString('base64url');
    if(s.callbacks.some(c=>c.ref===key))throw Error('WELCOME_OWNER_CALLBACK_COLLISION');
    s.callbacks.push({ref:key,action:JSON.stringify([next,this.greetings.epoch(s,next.chat,next.greeting)]),
     actorId:actor,chatId:'private',policyVersion:0,expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
    return {text:label,callback_data:'wm:1:'+key.slice(PREFIX.length)};
   };
   const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
    ({text,keyboard:{inline_keyboard:rows}});
   const back={text:'🏠 لوحة المالك',callback_data:'mi:1:h'};
   if(step.kind==='GROUPS'){
    const pages=Math.max(1,Math.ceil(groups.length/8));
    if(step.page>=pages)return null;
    const rows=groups.slice(step.page*8,step.page*8+8).map(chat=>[make('👥 '+chat,{...step,kind:'GROUP',page:0,chat})]);
    const page=[];
    if(step.page>0)page.push(make('⬅️ السابق',{...step,page:step.page-1}));
    if(step.page+1<pages)page.push(make('التالي ➡️',{...step,page:step.page+1}));
    if(page.length)rows.push(page);
    rows.push([back]);
    return ui('<b>'+(step.greeting==='GUIDE'?'🧭 دليل العضو الجديد':'👋 الترحيب والوداع')+'</b>\nاختر مجموعة معتمدة لربط قالب محفوظ من استوديو الأزرار.\n'+
     'الرسائل العامة متوقفة افتراضيًا، ولا تُرسل مراسلات خاصة استباقية.',rows);
   }
   if(step.kind==='GROUP'){
    const welcome=this.greetings.policy(s,step.chat,'WELCOME'),
     bye=this.greetings.policy(s,step.chat,'FAREWELL'),guide=this.greetings.policy(s,step.chat,'GUIDE');
    return ui('<b>👋 الترحيب والوداع للمجموعة</b>\n'+esc(step.chat)+
     '\nالترحيب: '+(welcome?.enabled?'مفعل':'متوقف')+
     '\nالوداع: '+(bye?.enabled?'مفعل':'متوقف')+
     '\nدليل العضو الجديد: '+(guide?.enabled?'مفعل عبر /guide':'متوقف')+
     '\nيمكن تخصيص رسالة كل نوع باختيار إصدار محفوظ من استوديو القوالب، ثم معاينة وتأكيد مستقل.',
     [[make('👋 الترحيب',{...step,kind:'EDIT',greeting:'WELCOME'})],
      [make('🚪 الوداع',{...step,kind:'EDIT',greeting:'FAREWELL'})],
      [make('🧭 دليل العضو',{...step,kind:'EDIT',greeting:'GUIDE'})],
      [make('↩️ المجموعات',{...initial})],[back]]);
   }
   if(step.kind==='EDIT'){
    const current=config!;
    const rows=[[make('📝 اختيار قالب '+title(step.greeting),{...step,kind:'TEMPLATES',page:0})]];
    if(current.enabled)rows.push([make('⛔ إيقاف '+title(step.greeting),{...step,kind:'OFF_PREVIEW'})]);
    rows.push([make('↩️ أنواع الرسائل',{...step,kind:'GROUP',page:0})],
     [{text:'🎨 استوديو قوالب الرسائل',callback_data:'mi:1:i:07:09'}],[back]);
    return ui('<b>'+title(step.greeting)+' للمجموعة</b>\n'+esc(step.chat)+
     '\nالحالة: '+(current.enabled?'✅ مفعلة':'متوقفة')+
     '\n'+(current.enabled?'معرّف الإصدار المحفوظ: '+esc(current.templateId)+' · '+current.templateRevision:'لم يُعتمد قالب للإرسال.')+
     '\nقالب محفوظ فقط، '+(step.greeting==='GUIDE'?'ولا يُرسل دليل العضو إلا عند طلب /guide داخل المجموعة.':'والإرسال لا يبدأ دون تفعيل مستقل.')+' تُحذف رسالة البوت العامة المؤكدة بعد خمس دقائق.',rows);
   }
   if(step.kind==='TEMPLATES'){
    const versions=(s.buttonStudio?.templates??[]).flatMap(t=>{
     const latest=t.versions.at(-1);
     return latest&&savedGreetingVersion(s,t.id,latest.revision)?[{id:t.id,revision:latest.revision,name:latest.content.name}]:[];
    }).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
    const pages=Math.max(1,Math.ceil(versions.length/8));
    if(step.page>=pages)return null;
    const rows=versions.slice(step.page*8,step.page*8+8).map(v=>
     [make('📝 '+Array.from(v.name).slice(0,34).join(''),{...step,kind:'PREVIEW',templateId:v.id,templateRevision:v.revision})]);
    const nav=[];
    if(step.page)nav.push(make('⬅️ السابق',{...step,page:step.page-1}));
    if(step.page+1<pages)nav.push(make('التالي ➡️',{...step,page:step.page+1}));
    if(nav.length)rows.push(nav);
    rows.push([make('↩️ إعداد '+title(step.greeting),{...step,kind:'EDIT',page:0})],
     [{text:'🎨 إنشاء أو حفظ قالب',callback_data:'mi:1:i:07:09'}]);
    return ui('<b>اختيار قالب محفوظ · '+title(step.greeting)+'</b>\n'+
     'تظهر الإصدارات التي حُفظت من الاستوديو وبها أزرار روابط HTTPS عامة فقط (حتى أربعة).'+
     '\nالمسودات غير المحفوظة لا يمكن تفعيلها.\nصفحة '+(step.page+1)+' من '+pages,rows);
   }
   if(step.kind==='PREVIEW'){
    const saved=savedGreetingVersion(s,step.templateId,step.templateRevision),
     rendered=this.greetings.preview(s,step.chat,step.greeting,step.templateId,step.templateRevision);
    if(!saved||!rendered)return null;
    return ui('<b>👁️ معاينة '+title(step.greeting)+'</b>\nالمجموعة: '+esc(step.chat)+
     '\nالقالب: '+esc(saved.content.name)+' · الإصدار '+step.templateRevision+
     '\n\n'+esc(rendered.text)+
     (rendered.buttons.length?'\nالأزرار: '+rendered.buttons.flat().map(x=>esc(x.text)).join(' · '):'')+
     '\n\nيستلزم النشر تفعيلًا مستقلًا، '+(step.greeting==='GUIDE'?'ولا يرسل الدليل دون أمر /guide.':'ويُرسل بنص عام دون ذكر هوية الطلاب الفعلية.')+'\n'+
     'لا تتغير هذه النسخة عند تحرير مسودة الاستوديو.',
     [[make('✅ تأكيد تفعيل '+title(step.greeting),{...step,kind:'CONFIRM'})],
      [make('↩️ اختيار قالب آخر',{...step,kind:'TEMPLATES',page:0})]]);
   }
   if(step.kind==='OFF_PREVIEW'){
    if(!config!.enabled)return null;
    return ui('<b>معاينة إيقاف '+title(step.greeting)+'</b>\nستتوقف الرسائل العامة الجديدة عن هذا النوع في '+esc(step.chat)+
     '. لا تعاد إرسال الرسائل مجهولة النتيجة، ولا يلغى تنظيف رسالة مؤكدة سابقة إذا ظلت المجموعة معتمدة.',
     [[make('✅ تأكيد الإيقاف',{...step,kind:'OFF_CONFIRM'})],
      [make('↩️ إلغاء',{...step,kind:'EDIT'})]]);
   }
   return null;
  });
 }
}
