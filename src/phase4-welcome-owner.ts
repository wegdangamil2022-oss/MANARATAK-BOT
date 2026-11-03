import {randomBytes,createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import {Policy} from './policy.js';
import {Phase4GreetingService} from './phase4-greeting-service.js';
import {defaultGreetingSettings,validateGreetingSettings,renderGreetingTemplate,type GreetingSettings} from './phase4-welcome-engine.js';
import type {TelegramInlineKeyboard} from './telegram-inline-owner.js';
export interface OwnerGreetingScreen {readonly text:string;readonly keyboard:TelegramInlineKeyboard;}
interface OwnerPreview{actorId:string;chatId:string;nonce:string;expiresAt:number;createdAt:number;
 proposed:GreetingSettings;}
type State=BotState&{phase4GreetingOwnerPreviews?:OwnerPreview[]};
const validGroup=(v:string)=>/^-[1-9]\d{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');
const button=(text:string,callback_data:string)=>({text,callback_data});
const screen=(text:string,rows:{text:string;callback_data:string}[][]):OwnerGreetingScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
const addStarter=(s:GreetingSettings):GreetingSettings=>{
 const templates=[...s.templates];
 if(!templates.some(t=>t.id==='welcome_default'))
  templates.push({id:'welcome_default',language:'ar',
   text:'🎓 أهلًا بك يا {العضو} في {اسم_المجموعة}!\nاكتب /start في الخاص لاستعراض خدمات منارتك.'});
 if(!templates.some(t=>t.id==='farewell_default'))
  templates.push({id:'farewell_default',language:'ar',
   text:'نتمنى لك التوفيق يا {العضو}، ويسعدنا انضمامك مجددًا.'});
 return {...s,templates};
};
function previews(s:State):OwnerPreview[]{
 const v=s.phase4GreetingOwnerPreviews??[];
 if(!Array.isArray(v)||v.length>20||v.some(p=>!p||typeof p!=='object'||
   !/^[a-f0-9]{12}$/u.test(p.nonce)||typeof p.actorId!=='string'||
   !validGroup(p.chatId)||!Number.isSafeInteger(p.expiresAt)||
   !Number.isSafeInteger(p.createdAt)||p.expiresAt-p.createdAt!==120_000||
   !validateGreetingSettings(p.proposed)||p.proposed.chatId!==p.chatId)||
   new Set(v.map(p=>p.nonce)).size!==v.length)throw Error('PHASE4_PREVIEW_CORRUPT');
 return v;
}
export function validOwnerGreetingRoute(input:unknown):input is string{
 return typeof input==='string'&&Buffer.byteLength(input,'utf8')<=64&&
  /^p4w:1:(?:h|l:(?:0|[1-9]\d{0,2})|g:-[1-9]\d{0,15}|p:-[1-9]\d{0,15}:[wvof]|c:[a-f0-9]{12})$/u.test(input);
}
/** Owner-only group welcome and keyword editor. All changes use review/confirm;
 * no button, token or text input by itself is permission to send to Telegram.
 */
export class Phase4OwnerGreetingUI {
 private service:Phase4GreetingService;
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){
  this.service=new Phase4GreetingService(store,policy,{clock});
 }
 private allowed(s:BotState,chatId:string):boolean{
  return this.policy.canUseChat(s,chatId,'navigation');
 }
 private async root(actorId:string,page=0):Promise<OwnerGreetingScreen>{
  const s=await this.store.snapshot();
  const groups=s.chats.filter(c=>c.approved&&c.id.startsWith('-')&&this.allowed(s,c.id))
   .sort((a,b)=>a.id.localeCompare(b.id));
  const last=Math.max(0,Math.ceil(groups.length/8)-1);
  if(!Number.isSafeInteger(page)||page<0||page>last)throw Error('INVALID_PAGE');
  const rows=groups.slice(page*8,page*8+8).map(c=>[button('👋 '+c.id,'p4w:1:g:'+c.id)]);
  const nav=[];
  if(page>0)nav.push(button('⬅️ السابق','p4w:1:l:'+(page-1)));
  if(page<last)nav.push(button('➡️ التالي','p4w:1:l:'+(page+1)));
  if(nav.length)rows.push(nav);
  rows.push([button('↩️ التفاعل والترحيب','mi:1:s:09:0'),
   button('🏠 لوحة المالك','mi:1:h')]);
  return screen('<b>👋 الترحيب والردود التلقائية</b>\nاختر مجموعة معتمدة لإدارة قوالبها والردود بها.'
   +'\nالتشغيل مغلق افتراضيًا حتى اعتماد إعداد كل مجموعة. صفحة '+(page+1)+' / '+(last+1),rows);
 }
 private async detail(actorId:string,chatId:string):Promise<OwnerGreetingScreen>{
  if(!validGroup(chatId))throw Error('INVALID_GROUP');
  const status=await this.service.status(actorId,chatId),s=status.settings;
  const text='<b>👋 تفاعل المجموعة '+esc(chatId)+'</b>\n'
   +'الترحيب: '+esc(s?.welcomeMode??'OFF')+'\n'
   +'الوداع: '+(s?.farewellEnabled?'مفعّل':'مغلق')+'\n'
   +'الردود: '+(s?.replyRules.filter(r=>r.enabled).length??0)+' قاعدة فعالة\n'
   +'الإصدار: '+(s?.revision??0)+'\n'
   +'المعلق: '+status.counts.QUEUED+' · غير محسوم: '+status.counts.UNKNOWN_OUTCOME
   +'\n\nتعديل الرسائل والقواعد: /welcometext أو /autoreplyadd في الخاص، بعد اختيار المجموعة.'
   +'\nلا يُرسل أي رد دون تفعيل خادم المرحلة الرابعة وتصريح المجموعة.';
  return screen(text,[
   [button('✅ ترحيب عام','p4w:1:p:'+chatId+':w'),
    button('✅ بعد التحقق فقط','p4w:1:p:'+chatId+':v')],
   [button('🚫 إيقاف الترحيب','p4w:1:p:'+chatId+':o'),
    button(s?.farewellEnabled?'🚫 إيقاف الوداع':'👋 تفعيل الوداع','p4w:1:p:'+chatId+':f')],
   [button('↩️ المجموعات','p4w:1:h'),button('🏠 المالك','mi:1:h')]
  ]);
 }
 private async stage(actorId:string,proposed:GreetingSettings):Promise<OwnerGreetingScreen>{
  await this.service.preview(actorId,proposed);
  const nonce=randomBytes(6).toString('hex'),now=this.clock();
  if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000-120_000)throw Error('INVALID_TIME');
  await this.store.transaction(s=>{
   const state=s as State;
   const rows=previews(state).filter(p=>p.expiresAt>now&&p.actorId!==actorId);
   if(rows.length>=19)throw Error('PHASE4_PREVIEW_CAP');
   state.phase4GreetingOwnerPreviews=[...rows,{actorId,chatId:proposed.chatId,nonce,
    createdAt:now,expiresAt:now+120_000,proposed}];
  });
  const demo=proposed.templates.find(t=>t.id===(proposed.welcomeTemplateId??proposed.replyRules.at(-1)?.templateId));
  const previewText=demo?renderGreetingTemplate(demo,proposed,{updateKey:'p4:preview',
   chatId:proposed.chatId,actorId:actorId,kind:'JOIN',trusted:true,chatApproved:true,
   at:now,memberName:'طالب منارتك',groupName:'مجتمع منارتك'}):'لا يوجد قالب ترحيب مخصص.';
  const brief=previewText.slice(0,850).replace(/&(?:[a-z]*?)?$/u,'');
  return screen('<b>🔎 معاينة قبل اعتماد ترحيب المجموعة</b>\n'
   +'المجموعة: '+esc(proposed.chatId)+'\nالإصدار الجديد: '+proposed.revision
   +'\nالترحيب: '+esc(proposed.welcomeMode)+' · الوداع: '+(proposed.farewellEnabled?'نعم':'لا')
   +'\nقواعد الرد: '+proposed.replyRules.length+'\n\n<b>نموذج عرض تجريبي:</b>\n'+brief
   +'\n\nالمعاينة صالحة لدقيقتين، ولا تشغل Telegram.',
   [[button('✅ تأكيد التغيير','p4w:1:c:'+nonce)],
    [button('↩️ إلغاء','p4w:1:g:'+proposed.chatId)]]);
 }
 private async prepared(actorId:string,chatId:string,mode:'w'|'v'|'o'|'f'):Promise<OwnerGreetingScreen>{
  const old=(await this.service.status(actorId,chatId)).settings;
  const source=addStarter(old??defaultGreetingSettings(chatId));
  const proposed:GreetingSettings={...source,revision:(old?.revision??0)+1,
   enabled:mode==='o'?(source.farewellEnabled||source.replyRules.some(r=>r.enabled)):true,
   welcomeMode:mode==='o'?'OFF':mode==='w'?'GROUP':mode==='v'?'VERIFIED_ONLY':source.welcomeMode,
   farewellEnabled:mode==='f'?!source.farewellEnabled:source.farewellEnabled,
   welcomeTemplateId:source.welcomeTemplateId??'welcome_default',
   verifiedTemplateId:source.verifiedTemplateId??'welcome_default',
   farewellTemplateId:source.farewellTemplateId??'farewell_default'};
  return this.stage(actorId,proposed);
 }
 private async confirm(actorId:string,nonce:string):Promise<OwnerGreetingScreen>{
  const state=await this.store.snapshot() as State;
  const item=previews(state).find(p=>p.nonce===nonce&&p.actorId===actorId&&p.expiresAt>this.clock());
  if(!item)throw Error('PHASE4_PREVIEW_EXPIRED');
  await this.service.confirm(actorId,item.proposed);
  await this.store.transaction(s=>{
   const state=s as State;previews(state);
   state.phase4GreetingOwnerPreviews=(state.phase4GreetingOwnerPreviews??[]).filter(p=>p.nonce!==nonce);
  });
  return this.detail(actorId,item.chatId);
 }
 /** Inline route or privileged owner-private configuration text. */
 async handle(actorId:string,input:string):Promise<OwnerGreetingScreen|null>{
  if(!this.policy.isOwner(actorId))return null;
  if(input==='mi:1:i:09:01'||input==='mi:1:i:09:05'||input==='p4w:1:h')return this.root(actorId);
  if(validOwnerGreetingRoute(input)){
   if(input.startsWith('p4w:1:l:'))return this.root(actorId,Number(input.slice(8)));
   if(input.startsWith('p4w:1:g:'))return this.detail(actorId,input.slice(8));
   const p=/^p4w:1:p:(-[1-9]\d{0,15}):([wvof])$/u.exec(input);
   if(p)return this.prepared(actorId,p[1]!,p[2]! as 'w'|'v'|'o'|'f');
   const c=/^p4w:1:c:([a-f0-9]{12})$/u.exec(input);
   if(c)return this.confirm(actorId,c[1]!);
  }
  // No free-form code execution or URLs. Exact bounded syntax and owner-only scope.
  const welcome=/^\/welcometext\s+(-[1-9]\d{0,15})\s*\|\s*([\s\S]{1,1800})$/u.exec(input);
  if(welcome){
   const old=(await this.service.status(actorId,welcome[1]!)).settings;
   const source=addStarter(old??defaultGreetingSettings(welcome[1]!));
   const proposed={...source,revision:(old?.revision??0)+1,
    templates:source.templates.map(t=>t.id==='welcome_default'?{...t,text:welcome[2]!.trim()}:t)};
   if(!validateGreetingSettings(proposed))throw Error('INVALID_GREETING_TEXT');
   return this.stage(actorId,proposed);
  }
  const reply=/^\/autoreplyadd\s+(-[1-9]\d{0,15})\s*\|\s*(EXACT|CONTAINS|WORD)\s*\|\s*([^|\n]{1,80})\s*\|\s*([\s\S]{1,1800})$/u.exec(input);
  if(reply){
   const old=(await this.service.status(actorId,reply[1]!)).settings;
   const source=addStarter(old??defaultGreetingSettings(reply[1]!));
   const phrase=reply[3]!.trim(),body=reply[4]!.trim();
   const ruleId='rule_'+createHash('sha256').update(reply[2]+'|'+phrase).digest('hex').slice(0,12);
   const templateId='reply_'+ruleId;
   const proposed:GreetingSettings={...source,revision:(old?.revision??0)+1,enabled:true,
    templates:[...source.templates.filter(t=>t.id!==templateId),{id:templateId,language:'ar',text:body}],
    replyRules:[...source.replyRules.filter(r=>r.id!==ruleId),{id:ruleId,enabled:true,
     trigger:'KEYWORD',match:reply[2]! as 'EXACT'|'CONTAINS'|'WORD',
     phrase,templateId,priority:100,cooldownUserMs:120_000,cooldownTopicMs:15_000}]};
   if(!validateGreetingSettings(proposed))throw Error('INVALID_AUTOREPLY_TEXT');
   return this.stage(actorId,proposed);
  }
  return null;
 }
}