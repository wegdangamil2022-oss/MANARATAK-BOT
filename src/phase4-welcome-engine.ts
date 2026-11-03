/** Phase 4: isolated greeting/automatic-response kernel. Never sends to Telegram. */
export type InteractionTrigger='JOIN'|'VERIFIED_JOIN'|'LEAVE'|'KEYWORD'|'COMMAND'|'GROUP_TITLE_CHANGED'|'GROUP_PHOTO_CHANGED';
export type GreetingMode='OFF'|'GROUP'|'VERIFIED_ONLY';
export type InteractionDecisionCode='READY'|'DISABLED'|'UNAPPROVED'|'UNTRUSTED'|'BOT_EVENT'|'UNSUPPORTED'|'REPLAY'|'QUIET'|'LECTURE'|'RATE_LIMIT'|'NO_MATCH'|'ONBOARDING_REQUIRED'|'INVALID_CONFIG';
export interface GreetingButton{readonly label:string;readonly url:string;}
export interface GreetingTemplate{readonly id:string;readonly language:string;readonly text:string;readonly buttons?:readonly GreetingButton[];}
export interface AutoReplyRule{
 readonly id:string;readonly enabled:boolean;readonly trigger:'KEYWORD'|'COMMAND';
 readonly match:'EXACT'|'CONTAINS'|'WORD';readonly phrase:string;readonly templateId:string;
 readonly topicId?:number;readonly priority:number;readonly cooldownUserMs:number;readonly cooldownTopicMs:number;
}
export interface GreetingSettings{
 readonly chatId:string;readonly revision:number;readonly enabled:boolean;readonly welcomeMode:GreetingMode;
 readonly farewellEnabled:boolean;readonly welcomeTemplateId?:string;readonly verifiedTemplateId?:string;
 readonly farewellTemplateId?:string;readonly timezone:string;readonly hour12:boolean;
 readonly calendar:'gregory'|'islamic';readonly language:string;
 readonly quietHours?:{readonly startHour:number;readonly endHour:number};
 readonly lectureUntil?:number;readonly welcomeCooldownMs:number;
 readonly replyRules:readonly AutoReplyRule[];readonly templates:readonly GreetingTemplate[];
}
export interface InteractionEvent{
 readonly updateKey:string;readonly chatId:string;readonly actorId:string;readonly kind:InteractionTrigger;
 readonly at:number;readonly trusted:boolean;readonly chatApproved:boolean;readonly botActor?:boolean;
 readonly topicId?:number;readonly text?:string;readonly memberName?:string;readonly groupName?:string;
 readonly verified?:boolean;readonly rulesUrl?:string;readonly edited?:boolean;readonly forwarded?:boolean;
}
export interface InteractionReceipt {
 readonly updateKey:string;readonly at:number;readonly ruleId:string;readonly chatId:string;readonly actorId:string;
 readonly topicId?:number;readonly result:'SENT_PLANNED'|'SUPPRESSED';readonly reason:InteractionDecisionCode;
}
export interface InteractionDecision{
 readonly status:InteractionDecisionCode;readonly settingsRevision:number;readonly receipt:InteractionReceipt;
 readonly rendered?:{readonly html:string;readonly buttons:readonly GreetingButton[];readonly templateId:string;readonly ruleId:string};
}
const MAX_TIME=8_640_000_000_000_000;
const forbidden=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const textSafe=(x:unknown,max:number):x is string=>typeof x==='string'&&x.trim().length>0&&[...x].length<=max&&!forbidden.test(x);
const ident=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,39}$/u.test(x);
const group=(x:unknown):x is string=>typeof x==='string'&&/^-[1-9]\d{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const user=(x:unknown):x is string=>typeof x==='string'&&/^[1-9]\d{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const safeTime=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=MAX_TIME;
const topic=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0&&x<2147483648;
const esc=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const vars=new Set(['العضو','اسم_المجموعة','التاريخ','الوقت','رابط_القوانين']);
const variable=/\{([^{}]*)\}/gu;
const normalize=(s:string)=>s.normalize('NFKC').toLocaleLowerCase('ar').replace(/[\u064b-\u065f\u0670\u0640]/gu,'')
 .replace(/\s+/gu,' ').trim();
function safeTimezone(tz:string):boolean{
 try{new Intl.DateTimeFormat('en',{timeZone:tz}).format(0);return true;}catch{return false;}
}
function templateValid(t:GreetingTemplate):boolean{
 if(!ident(t.id)||!textSafe(t.language,20)||!/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(t.language)||
  typeof t.text!=='string'||t.text.trim().length===0||[...t.text].length>1800||
  /[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(t.text)||
  Buffer.byteLength(t.text,'utf8')>3500)return false;
 for(const m of t.text.matchAll(variable))if(!vars.has(m[1]!))return false;
 if(/[{}]/u.test(t.text.replace(variable,'')))return false;
 if(t.buttons!==undefined){
  if(!Array.isArray(t.buttons)||t.buttons.length>8)return false;
  for(const b of t.buttons){
   if(!textSafe(b.label,48)||!textSafe(b.url,300)||!/^https:\/\//u.test(b.url))return false;
   try{const u=new URL(b.url);if(u.username||u.password||!u.hostname.includes('.')||u.port||/\s/u.test(b.url))return false;}
   catch{return false;}
  }
 }
 return true;
}
export function validateGreetingSettings(x:unknown):x is GreetingSettings{
 if(!x||typeof x!=='object'||Array.isArray(x))return false;
 const s=x as GreetingSettings;
 if(!group(s.chatId)||!Number.isSafeInteger(s.revision)||s.revision<1||s.revision>1_000_000||
  typeof s.enabled!=='boolean'||!['OFF','GROUP','VERIFIED_ONLY'].includes(s.welcomeMode)||
  typeof s.farewellEnabled!=='boolean'||typeof s.hour12!=='boolean'||
  !['gregory','islamic'].includes(s.calendar)||typeof s.timezone!=='string'||s.timezone.length>70||
  !safeTimezone(s.timezone)||typeof s.language!=='string'||
  !/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(s.language)||!Number.isSafeInteger(s.welcomeCooldownMs)||
  s.welcomeCooldownMs<0||s.welcomeCooldownMs>86_400_000||
  (s.lectureUntil!==undefined&&!safeTime(s.lectureUntil))||
  (s.quietHours!==undefined&&(!s.quietHours||!Number.isInteger(s.quietHours.startHour)||
   !Number.isInteger(s.quietHours.endHour)||s.quietHours.startHour<0||s.quietHours.startHour>23||
   s.quietHours.endHour<0||s.quietHours.endHour>23||s.quietHours.startHour===s.quietHours.endHour))||
  !Array.isArray(s.templates)||s.templates.length>40||!s.templates.every(templateValid)||
  new Set(s.templates.map(t=>t.id)).size!==s.templates.length||
  !Array.isArray(s.replyRules)||s.replyRules.length>80)return false;
 const templates=new Set(s.templates.map(t=>t.id));
 for(const t of [s.welcomeTemplateId,s.verifiedTemplateId,s.farewellTemplateId])
  if(t!==undefined&&!templates.has(t))return false;
 if(s.welcomeMode==='GROUP'&&!s.welcomeTemplateId||
  s.welcomeMode==='VERIFIED_ONLY'&&!s.verifiedTemplateId||
  s.farewellEnabled&&!s.farewellTemplateId||
  new Set(s.replyRules.map(r=>r.id)).size!==s.replyRules.length)return false;
 return s.replyRules.every(r=>ident(r.id)&&typeof r.enabled==='boolean'&&
  ['KEYWORD','COMMAND'].includes(r.trigger)&&['EXACT','CONTAINS','WORD'].includes(r.match)&&
  textSafe(r.phrase,80)&&!/[{}]/u.test(r.phrase)&&templates.has(r.templateId)&&
  (r.topicId===undefined||topic(r.topicId))&&Number.isInteger(r.priority)&&
  r.priority>=0&&r.priority<=1000&&Number.isSafeInteger(r.cooldownUserMs)&&
  r.cooldownUserMs>=0&&r.cooldownUserMs<=86_400_000&&
  Number.isSafeInteger(r.cooldownTopicMs)&&r.cooldownTopicMs>=0&&r.cooldownTopicMs<=86_400_000&&
  (r.trigger!=='COMMAND'||/^\/[A-Za-z][A-Za-z0-9_]{0,30}$/u.test(r.phrase)));
}
export const defaultGreetingSettings=(chatId:string):GreetingSettings=>({
 chatId,revision:1,enabled:false,welcomeMode:'OFF',farewellEnabled:false,timezone:'Asia/Aden',
 hour12:false,calendar:'gregory',language:'ar',welcomeCooldownMs:300000,replyRules:[],templates:[]
});
function isQuiet(s:GreetingSettings,at:number):boolean{
 if(!s.quietHours)return false;
 const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:s.timezone,hour:'2-digit',hourCycle:'h23'}).format(at));
 const {startHour:a,endHour:b}=s.quietHours;
 return a<b?hour>=a&&hour<b:hour>=a||hour<b;
}
function matches(r:AutoReplyRule,text:string):boolean{
 const input=normalize(text),pattern=normalize(r.phrase);
 if(r.trigger==='COMMAND')return (input.split(/\s/u)[0]??'')===pattern;
 if(r.match==='EXACT')return input===pattern;
 if(r.match==='CONTAINS')return input.includes(pattern);
 for(let i=input.indexOf(pattern);i>=0;i=input.indexOf(pattern,i+1)){
  const before=i>0?input[i-1]:'';const after=input[i+pattern.length]??'';
  if((!before||!/[\p{L}\p{N}_]/u.test(before))&&(!after||!/[\p{L}\p{N}_]/u.test(after)))return true;
 }
 return false;
}
export function renderGreetingTemplate(t:GreetingTemplate,s:GreetingSettings,e:InteractionEvent):string{
 const dt=new Date(e.at),date=new Intl.DateTimeFormat('ar',{timeZone:s.timezone,calendar:s.calendar,
  year:'numeric',month:'2-digit',day:'2-digit'}).format(dt);
 const time=new Intl.DateTimeFormat('ar',{timeZone:s.timezone,hour:'2-digit',minute:'2-digit',
  hour12:s.hour12}).format(dt);
 const v:Record<string,string>={العضو:e.memberName??'عضو جديد',
  اسم_المجموعة:e.groupName??'المجموعة',التاريخ:date,الوقت:time,رابط_القوانين:e.rulesUrl??''};
 const segments:string[]=[];let previous=0;
 for(const m of t.text.matchAll(variable)){
  const i=m.index??0;segments.push(esc(t.text.slice(previous,i)),esc(v[m[1]!]??''));
  previous=i+m[0].length;
 }
 segments.push(esc(t.text.slice(previous)));
 const html=segments.join('');
 if(Buffer.byteLength(html,'utf8')>4096)throw Error('GREETING_TEXT_TOO_LONG');
 return html;
}
/** A deterministic proposal only: must reserve output and update key together in durable storage. */
export function decideGreeting(s:GreetingSettings,e:InteractionEvent,hist:readonly InteractionReceipt[]):InteractionDecision{
 const receipt=(ruleId:string,reason:InteractionDecisionCode,result:InteractionReceipt['result']):InteractionReceipt=>({
  updateKey:e.updateKey,at:e.at,ruleId,chatId:e.chatId,actorId:e.actorId,
  ...(e.topicId!==undefined?{topicId:e.topicId}:{}),result,reason});
 const reject=(reason:InteractionDecisionCode,ruleId='-'):InteractionDecision=>({
  status:reason,settingsRevision:s.revision,receipt:receipt(ruleId,reason,'SUPPRESSED')});
 if(!validateGreetingSettings(s))return reject('INVALID_CONFIG');
 if(!group(e.chatId)||!user(e.actorId)||!safeTime(e.at)||!textSafe(e.updateKey,100)||
  (e.topicId!==undefined&&!topic(e.topicId))||e.chatId!==s.chatId)return reject('UNTRUSTED');
 if(!e.chatApproved)return reject('UNAPPROVED');
 if(!e.trusted||e.forwarded||e.edited)return reject('UNTRUSTED');
 if(e.botActor)return reject('BOT_EVENT');
 if(!s.enabled)return reject('DISABLED');
 if(hist.some(x=>x.updateKey===e.updateKey))return reject('REPLAY');
 if(s.lectureUntil!==undefined&&e.at<s.lectureUntil)return reject('LECTURE');
 if(isQuiet(s,e.at))return reject('QUIET');
 let templateId:string|undefined,ruleId:string|undefined,cooldownUser=0,cooldownTopic=0;
 if(e.kind==='JOIN'||e.kind==='VERIFIED_JOIN'){
  if(s.welcomeMode==='OFF')return reject('DISABLED');
  if(s.welcomeMode==='VERIFIED_ONLY'&&!e.verified)return reject('ONBOARDING_REQUIRED');
  templateId=e.verified&&s.verifiedTemplateId?s.verifiedTemplateId:
   s.welcomeMode==='VERIFIED_ONLY'?s.verifiedTemplateId:s.welcomeTemplateId;
  ruleId='welcome';cooldownUser=s.welcomeCooldownMs;
 }else if(e.kind==='LEAVE'){
  if(!s.farewellEnabled)return reject('DISABLED');
  templateId=s.farewellTemplateId;ruleId='farewell';cooldownUser=s.welcomeCooldownMs;
 }else if(e.kind==='KEYWORD'||e.kind==='COMMAND'){
  if(!textSafe(e.text,4000))return reject('UNSUPPORTED');
  const candidates=s.replyRules.filter(r=>r.enabled&&r.trigger===e.kind&&
   (r.topicId===undefined||r.topicId===e.topicId)&&matches(r,e.text!))
   .sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
  if(!candidates.length)return reject('NO_MATCH');
  const selected=candidates[0]!;
  templateId=selected.templateId;ruleId=selected.id;
  cooldownUser=selected.cooldownUserMs;cooldownTopic=selected.cooldownTopicMs;
 }else return reject('UNSUPPORTED');
 if(!templateId||!ruleId)return reject('INVALID_CONFIG');
 const template=s.templates.find(t=>t.id===templateId);
 if(!template)return reject('INVALID_CONFIG');
 const history=hist.filter(x=>x.result==='SENT_PLANNED'&&x.chatId===s.chatId&&
  x.ruleId===ruleId&&x.at<=e.at);
 // Hard global anti-flood fuse applies even when a rule's configured cooldown is zero.
 // A group can stage at most 12 automatic replies/minute and one actor at most 3.
 const oneMinute=hist.filter(x=>x.result==='SENT_PLANNED'&&x.chatId===s.chatId&&
  x.at>=e.at-60_000&&x.at<=e.at);
 if(oneMinute.length>=12||oneMinute.filter(x=>x.actorId===e.actorId).length>=3)
  return reject('RATE_LIMIT',ruleId);
 if(cooldownUser>0&&history.some(x=>x.actorId===e.actorId&&e.at-x.at<cooldownUser))
  return reject('RATE_LIMIT',ruleId);
 if(cooldownTopic>0&&history.some(x=>x.topicId===e.topicId&&e.at-x.at<cooldownTopic))
  return reject('RATE_LIMIT',ruleId);
 const html=renderGreetingTemplate(template,s,e);
 return {status:'READY',settingsRevision:s.revision,receipt:receipt(ruleId,'READY','SENT_PLANNED'),
  rendered:{html,buttons:template.buttons??[],templateId,ruleId}};
}