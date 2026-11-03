/** Phase 4 community interaction model.
 * Telegram identity and group approval must come from the authenticated transport,
 * never from a student-supplied message or a callback parameter.
 */
export type CommunityEventKind='JOIN'|'LEAVE'|'TEXT';
export type ReplyMatch='EXACT'|'WORD'|'CONTAINS'|'COMMAND';
export interface CommunityReplyRule{
 id:string;trigger:string;response:string;match:ReplyMatch;
 enabled:boolean;cooldownMs:number;topicId?:number;
}
export interface CommunityGreeting{
 enabled:boolean;text:string;
}
export interface CommunityConfig{
 chatId:string;version:number;welcome:CommunityGreeting;farewell:CommunityGreeting;
 repliesEnabled:boolean;rules:CommunityReplyRule[];
 /** Minutes from UTC. Display-only, never a claim about a real Telegram time zone. */
 utcOffsetMinutes:number;
 /** A group-wide minimum gap between any two automatic group replies. */
 groupCooldownMs:number;
}
export type CommunityDraftKind='WELCOME_TEXT'|'FAREWELL_TEXT'|'REPLY_ADD'|'REPLY_REMOVE'|
 'WELCOME_ON'|'WELCOME_OFF'|'FAREWELL_ON'|'FAREWELL_OFF'|'REPLIES_ON'|'REPLIES_OFF'|
 'REPLY_ENABLE'|'REPLY_DISABLE'|'REPLY_COOLDOWN';
export interface CommunityDraft{
 id:string;actorId:string;chatId:string;chatVersion:number;configVersion:number;
 kind:CommunityDraftKind;createdAt:number;expiresAt:number;
 text?:string;trigger?:string;match?:ReplyMatch;ruleId?:string;topicId?:number;cooldownMs?:number;
}
export interface CommunityReceipt{
 /** An opaque hash of the inbound Telegram update and bot identifier. */
 key:string;chatId:string;at:number;kind:CommunityEventKind;
 /** A short-lived digest, not a raw student message or display name. */
 actorDigest:string;ruleId?:string;
}
export interface CommunityAutomationState{
 configs:CommunityConfig[];drafts:CommunityDraft[];receipts:CommunityReceipt[];
}
export interface CommunityInput{
 kind:CommunityEventKind;chatId:string;actorId:string;
 memberName:string;groupName:string;messageText?:string;
 topicId?:number;edited?:boolean;forwarded?:boolean;fromBot?:boolean;
}
const validGroup=(s:unknown):s is string=>typeof s==='string'&&/^-[1-9]\d{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const validActor=(s:unknown):s is string=>typeof s==='string'&&/^[1-9]\d{0,15}$/u.test(s)&&Number.isSafeInteger(Number(s));
const validClock=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000;
const validText=(s:unknown,max:number):s is string=>typeof s==='string'&&
 s.trim().length>0&&Array.from(s).length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(s);
const validTemplate=(t:unknown):t is string=>validText(t,800)&&
 !/\{(?!العضو\}|اسم_المجموعة\}|التاريخ\}|الوقت\}|رابط_القوانين\})[^{}]*\}/u.test(t);
const validTopic=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const kinds=new Set<CommunityDraftKind>(['WELCOME_TEXT','FAREWELL_TEXT','REPLY_ADD','REPLY_REMOVE',
 'WELCOME_ON','WELCOME_OFF','FAREWELL_ON','FAREWELL_OFF','REPLIES_ON','REPLIES_OFF',
 'REPLY_ENABLE','REPLY_DISABLE','REPLY_COOLDOWN']);
const matches=new Set<ReplyMatch>(['EXACT','WORD','CONTAINS','COMMAND']);
export function defaultCommunityConfig(chatId:string):CommunityConfig{
 if(!validGroup(chatId))throw Error('COMMUNITY_CHAT_INVALID');
 return {chatId,version:0,welcome:{enabled:false,text:'مرحبًا {العضو} في {اسم_المجموعة} 👋'},
  farewell:{enabled:false,text:'نتمنى لك التوفيق يا {العضو} 👋'},
  repliesEnabled:false,rules:[],utcOffsetMinutes:180,groupCooldownMs:8000};
}
export function validCommunityConfig(value:unknown):value is CommunityConfig{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const x=value as CommunityConfig;
 if(!validGroup(x.chatId)||!Number.isSafeInteger(x.version)||x.version<0||x.version>2_000_000_000||
  !Number.isInteger(x.utcOffsetMinutes)||x.utcOffsetMinutes< -720||x.utcOffsetMinutes>840||
  !Number.isInteger(x.groupCooldownMs)||x.groupCooldownMs<1000||x.groupCooldownMs>600000||
  !Array.isArray(x.rules)||x.rules.length>30)return false;
 for(const item of [x.welcome,x.farewell]){
  if(!item||typeof item!=='object'||typeof item.enabled!=='boolean'||!validTemplate(item.text))return false;
 }
 const ids=new Set<string>(),triggers=new Set<string>();
 for(const rule of x.rules){
  if(!rule||typeof rule!=='object'||typeof rule.id!=='string'||!/^[a-f0-9]{12}$/u.test(rule.id)||
   !validText(rule.trigger,80)||!validTemplate(rule.response)||!matches.has(rule.match)||
   (rule.match==='COMMAND'&&!/^m_[a-z][a-z0-9_]{0,23}$/u.test(rule.trigger))||
   typeof rule.enabled!=='boolean'||!Number.isInteger(rule.cooldownMs)||
   rule.cooldownMs<1000||rule.cooldownMs>86400000||
   (rule.topicId!==undefined&&!validTopic(rule.topicId)))return false;
  const triggerKey=JSON.stringify([rule.topicId??0,normalizeCommunityMatch(rule.trigger),rule.match]);
  if(ids.has(rule.id)||triggers.has(triggerKey))return false;
  ids.add(rule.id);triggers.add(triggerKey);
 }
 return typeof x.repliesEnabled==='boolean';
}
export function validCommunityState(value:unknown):value is CommunityAutomationState{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as CommunityAutomationState;
 if(!Array.isArray(v.configs)||v.configs.length>500||!v.configs.every(validCommunityConfig)||
  new Set(v.configs.map(c=>c.chatId)).size!==v.configs.length||
  !Array.isArray(v.drafts)||v.drafts.length>100||
  !Array.isArray(v.receipts)||v.receipts.length>2500)return false;
 const draftIds=new Set<string>();
 for(const d of v.drafts){
  if(!d||typeof d!=='object'||typeof d.id!=='string'||!/^[a-f0-9]{24}$/u.test(d.id)||
   draftIds.has(d.id)||!validActor(d.actorId)||!validGroup(d.chatId)||
   !Number.isSafeInteger(d.chatVersion)||d.chatVersion<1||
   !Number.isSafeInteger(d.configVersion)||d.configVersion<0||
   !kinds.has(d.kind)||!validClock(d.createdAt)||!validClock(d.expiresAt)||
   d.expiresAt<=d.createdAt||d.expiresAt-d.createdAt>120000||
   (d.text!==undefined&&!validTemplate(d.text))||
   (d.trigger!==undefined&&!validText(d.trigger,80))||
   (d.match!==undefined&&!matches.has(d.match))||
   (d.ruleId!==undefined&&!/^[a-f0-9]{12}$/u.test(d.ruleId))||
   (d.topicId!==undefined&&!validTopic(d.topicId))||
   (d.cooldownMs!==undefined&&(!Number.isInteger(d.cooldownMs)||d.cooldownMs<1000||d.cooldownMs>86400000)))return false;
  if((d.kind==='WELCOME_TEXT'||d.kind==='FAREWELL_TEXT')&&!d.text||
   d.kind==='REPLY_ADD'&&(!d.text||!d.trigger||!d.match)||
   (['REPLY_REMOVE','REPLY_ENABLE','REPLY_DISABLE','REPLY_COOLDOWN'] as string[]).includes(d.kind)&&!d.ruleId||
   d.kind==='REPLY_COOLDOWN'&&d.cooldownMs===undefined)return false;
  draftIds.add(d.id);
 }
 const receiptIds=new Set<string>();
 for(const x of v.receipts){
  if(!x||typeof x!=='object'||typeof x.key!=='string'||!/^[a-f0-9]{64}$/u.test(x.key)||
   receiptIds.has(x.key)||!validGroup(x.chatId)||!validClock(x.at)||
   !['JOIN','LEAVE','TEXT'].includes(x.kind)||typeof x.actorDigest!=='string'||
   !/^[a-f0-9]{64}$/u.test(x.actorDigest)||
   (x.ruleId!==undefined&&!/^[a-f0-9]{12}$/u.test(x.ruleId)))return false;
  receiptIds.add(x.key);
 }
 return true;
}
export const emptyCommunityState=():CommunityAutomationState=>({configs:[],drafts:[],receipts:[]});
export function normalizeCommunityMatch(raw:string):string{
 return raw.normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640]/gu,'')
  .toLocaleLowerCase('ar').replace(/\s+/gu,' ').trim();
}
export function matchCommunityRule(rule:CommunityReplyRule,text:string):boolean{
 const value=normalizeCommunityMatch(text),trigger=normalizeCommunityMatch(rule.trigger);
 if(!value||!trigger)return false;
 // An isolated /m_ namespace cannot collide with Telegram moderation or
 // commands addressed to another bot; no callback or command is authorization.
 if(rule.match==='COMMAND'){
  if(!/^m_[a-z][a-z0-9_]{0,23}$/u.test(trigger))return false;
  const parsed=/^\/(m_[a-z][a-z0-9_]{0,23})(?:\s|$)/u.exec(value);
  return parsed?.[1]===trigger;
 }
 if(rule.match==='EXACT')return value===trigger;
 if(rule.match==='CONTAINS')return value.includes(trigger);
 let start=value.indexOf(trigger);
 while(start!==-1){
  const before=start===0?'':value[start-1]!,after=value[start+trigger.length]??'';
  if((!before||!(/[\p{L}\p{N}]/u.test(before)))&&
     (!after||!(/[\p{L}\p{N}]/u.test(after))))return true;
  start=value.indexOf(trigger,start+1);
 }
 return false;
}
const escapeHtml=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const safeName=(name:string,max:number):string=>name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim().slice(0,max)||'عضو';
export function renderCommunityTemplate(template:string,input:CommunityInput,now:number,rulesUrl=''):string{
 if(!validTemplate(template)||!validClock(now))throw Error('COMMUNITY_TEMPLATE_INVALID');
 const shifted=new Date(now);
 // Shift explicitly, then use UTC formatters so server locale never changes output.
 const date=shifted.toISOString().slice(0,10),time=shifted.toISOString().slice(11,16);
 const vars:Record<string,string>={
  'العضو':safeName(input.memberName,80),'اسم_المجموعة':safeName(input.groupName,120),
  'التاريخ':date,'الوقت':time,'رابط_القوانين':rulesUrl
 };
 const rendered=template.replace(/\{(العضو|اسم_المجموعة|التاريخ|الوقت|رابط_القوانين)\}/gu,
  (_,key:string)=>vars[key]??'');
 const html=escapeHtml(rendered);
 if(Buffer.byteLength(html,'utf8')>4096)throw Error('COMMUNITY_MESSAGE_TOO_LONG');
 return html;
}
export function selectCommunityRule(config:CommunityConfig,text:string,topicId?:number):CommunityReplyRule|undefined{
 if(!config.repliesEnabled||!text.trim()||
   /^@\w+/u.test(text.trimStart()))return;
 const command=text.trimStart().startsWith('/');
 return config.rules.find(rule=>rule.enabled&&
  (command?rule.match==='COMMAND':rule.match!=='COMMAND')&&
  (rule.topicId===undefined||rule.topicId===topicId)&&matchCommunityRule(rule,text));
}
