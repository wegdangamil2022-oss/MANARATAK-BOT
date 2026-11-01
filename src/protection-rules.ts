import {isValidFloodPolicy,type FloodPolicy} from './protection-flood.js';
/** Local policy evaluation only. No text storage, media download, classifier,
 * database, Telegram gateway or authority to punish belongs in this module. */
export type ProtectionAction='REVIEW'|'WARN'|'DELETE'|'MUTE';
export type ProtectionMessageType='TEXT'|'PHOTO'|'VIDEO'|'ANIMATION'|'STICKER'|'DOCUMENT'|'AUDIO'|'VOICE'|'VIDEO_NOTE'|'CONTACT'|'LOCATION'|'POLL';
type BaseRule={id:string;enabled:boolean;action:ProtectionAction};
export type ProtectionRule=BaseRule & ({kind:'WORD';value:string;match?:'PARTIAL'}|{kind:'PHRASE';value:string}|{kind:'TYPE';type:ProtectionMessageType}|{kind:'LINK';hosts:'*'|string[]}|{kind:'FORWARD'}|{kind:'LIMIT';metric:'MENTIONS'|'HASHTAGS'|'LENGTH';maximum:number});
export interface ProtectionPolicy{chatId:string;revision:number;mode:'OFF'|'MONITOR'|'ENFORCE';rules:ProtectionRule[];allowedDomains:string[];allowedPhrases:string[];exemptMemberIds:string[];flood?:FloodPolicy;night?:{enabled:boolean;startMinute:number;endMinute:number;offsetMinutes:number};raid?:{enabled:boolean;minimumMembers:number;minimumMessages:number;lockSeconds:number};escalation?:{enabled:boolean;afterWarnings:number;windowMs:number};temporaryExemptions?:{memberId:string;createdAt:number;expiresAt:number}[];}
export interface ProtectionMessage{chatId:string;memberId:string;type:ProtectionMessageType;text?:string;caption?:string;links?:string[];forwarded?:boolean;mentionCount?:number;}
export interface ProtectionEvaluation{status:'INVALID_POLICY'|'INVALID_MESSAGE'|'OFF'|'EXEMPT'|'CLEAR'|'MATCH';matchedRuleIds:string[];proposedAction:ProtectionAction|null;authorizedToSend:false;}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).length===expected.length&&expected.every(k=>Object.hasOwn(v,k));
const typeNames=['TEXT','PHOTO','VIDEO','ANIMATION','STICKER','DOCUMENT','AUDIO','VOICE','VIDEO_NOTE','CONTACT','LOCATION','POLL'];
const actions=['REVIEW','WARN','DELETE','MUTE'];
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const member=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
/** Conservative normalization: do not stem Arabic or equate ة with ه. */
export const normalizeProtectionText=(text:string):string=>text.normalize('NFKC').replace(/[\p{M}\p{Cf}\u0640]/gu,'')
 .replace(/[أإآٱ]/gu,'ا').replace(/ى/gu,'ي').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/ +/gu,' ');
const phrase=(v:unknown):v is string=>typeof v==='string'&&v.length>=1&&v.length<=120&&normalizeProtectionText(v).length>0&&!/[\u0000-\u001f\u007f]/u.test(v);
function host(v:unknown):v is string{
 if(typeof v!=='string'||v.length<1||v.length>253||v!==v.toLowerCase()||!/^[a-z0-9.-]+$/u.test(v)||v.endsWith('.'))return false;
 try{const u=new URL('https://'+v);return u.hostname===v&&u.port===''&&u.username===''&&u.password===''&&u.pathname==='/';}catch{return false;}
}
const stringList=(v:unknown,check:(x:unknown)=>boolean,max:number):v is string[]=>Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(check);
function validNight(v:unknown):boolean{
 return object(v)&&keys(v,['enabled','startMinute','endMinute','offsetMinutes'])&&typeof v.enabled==='boolean'&&
  [v.startMinute,v.endMinute,v.offsetMinutes].every(n=>typeof n==='number'&&Number.isSafeInteger(n))&&
  Number(v.startMinute)>=0&&Number(v.startMinute)<1440&&Number(v.endMinute)>=0&&Number(v.endMinute)<1440&&v.startMinute!==v.endMinute&&Number(v.offsetMinutes)>=-720&&Number(v.offsetMinutes)<=840;
}
function validRaid(v:unknown):boolean{
 return object(v)&&keys(v,['enabled','minimumMembers','minimumMessages','lockSeconds'])&&typeof v.enabled==='boolean'&&
  [v.minimumMembers,v.minimumMessages,v.lockSeconds].every(n=>typeof n==='number'&&Number.isSafeInteger(n))&&
  Number(v.minimumMembers)>=2&&Number(v.minimumMembers)<=100&&Number(v.minimumMessages)>=Number(v.minimumMembers)&&Number(v.minimumMessages)<=1000&&Number(v.lockSeconds)>=60&&Number(v.lockSeconds)<=600;
}
function validEscalation(v:unknown):boolean{
 return object(v)&&keys(v,['enabled','afterWarnings','windowMs'])&&typeof v.enabled==='boolean'&&typeof v.afterWarnings==='number'&&
  Number.isSafeInteger(v.afterWarnings)&&v.afterWarnings>=1&&v.afterWarnings<=20&&typeof v.windowMs==='number'&&
  Number.isSafeInteger(v.windowMs)&&v.windowMs>=60000&&v.windowMs<=86400000;
}
function validTemporaryExemptions(v:unknown):boolean{
 if(!Array.isArray(v)||v.length>100)return false;
 const seen=new Set<string>();return v.every(e=>{
  if(!object(e)||!keys(e,['memberId','createdAt','expiresAt'])||!member(e.memberId)||seen.has(e.memberId)||
   typeof e.createdAt!=='number'||!Number.isSafeInteger(e.createdAt)||e.createdAt<0||typeof e.expiresAt!=='number'||
   !Number.isSafeInteger(e.expiresAt)||e.expiresAt>8640000000000000||e.expiresAt<e.createdAt+60000||e.expiresAt>e.createdAt+86400000)return false;
  seen.add(e.memberId);return true;
 });
}
export function protectionMemberExempt(config:ProtectionPolicy,memberId:string,now:number):boolean{
 return config.exemptMemberIds.includes(memberId)||Boolean(config.temporaryExemptions?.some(e=>e.memberId===memberId&&now>=e.createdAt&&now<e.expiresAt));
}
export function isValidProtectionPolicy(v:unknown):v is ProtectionPolicy{
 if(!object(v)||!keys(v,['chatId','revision','mode','rules','allowedDomains','allowedPhrases','exemptMemberIds',...(Object.hasOwn(v,'flood')?['flood']:[]),...(Object.hasOwn(v,'temporaryExemptions')?['temporaryExemptions']:[]),...(Object.hasOwn(v,'escalation')?['escalation']:[]),...(Object.hasOwn(v,'raid')?['raid']:[]),...(Object.hasOwn(v,'night')?['night']:[])])||Object.hasOwn(v,'flood')&&!isValidFloodPolicy(v.flood)||!group(v.chatId)||
  !Number.isSafeInteger(v.revision)||typeof v.revision!=='number'||v.revision<1||(typeof v.mode!=='string'||!['OFF','MONITOR','ENFORCE'].includes(v.mode))||
  !stringList(v.allowedDomains,host,100)||!stringList(v.allowedPhrases,phrase,100)||!stringList(v.exemptMemberIds,member,100)||
  Object.hasOwn(v,'night')&&!validNight(v.night)||Object.hasOwn(v,'raid')&&(!validRaid(v.raid)||(v.raid as {enabled:boolean}).enabled&&!(v.flood as FloodPolicy|undefined)?.enabled)||Object.hasOwn(v,'escalation')&&!validEscalation(v.escalation)||Object.hasOwn(v,'temporaryExemptions')&&!validTemporaryExemptions(v.temporaryExemptions)||!Array.isArray(v.rules)||v.rules.length>100)return false;
 const seen=new Set<string>();
 return v.rules.every(r=>{
  if(!object(r)||typeof r.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/u.test(r.id)||seen.has(r.id)||
   typeof r.enabled!=='boolean'||(typeof r.action!=='string'||!actions.includes(r.action)))return false;
  seen.add(r.id);
  if(r.kind==='WORD'||r.kind==='PHRASE')return keys(r,['id','enabled','action','kind','value',...(Object.hasOwn(r,'match')?['match']:[])])&&(!Object.hasOwn(r,'match')||r.kind==='WORD'&&r.match==='PARTIAL')&&phrase(r.value)&&
   (r.kind!=='WORD'||!normalizeProtectionText(r.value).includes(' '));
  if(r.kind==='LIMIT')return keys(r,['id','enabled','action','kind','metric','maximum'])&&typeof r.metric==='string'&&['MENTIONS','HASHTAGS','LENGTH'].includes(r.metric)&&typeof r.maximum==='number'&&Number.isSafeInteger(r.maximum)&&r.maximum>=1&&r.maximum<=(r.metric==='LENGTH'?4096:100);
  if(r.kind==='FORWARD')return keys(r,['id','enabled','action','kind']);
  if(r.kind==='TYPE')return keys(r,['id','enabled','action','kind','type'])&&typeof r.type==='string'&&typeNames.includes(r.type);
  return r.kind==='LINK'&&keys(r,['id','enabled','action','kind','hosts'])&&
   (r.hosts==='*'||stringList(r.hosts,host,100)&&r.hosts.length>0);
 });
}
function validMessage(v:unknown,chatId:string):v is ProtectionMessage{
 if(!object(v)||Object.keys(v).some(k=>!['chatId','memberId','type','text','caption','links','forwarded','mentionCount'].includes(k))||v.chatId!==chatId||
  !member(v.memberId)||typeof v.type!=='string'||!typeNames.includes(v.type)||v.text!==undefined&&v.caption!==undefined)return false;
 if(v.mentionCount!==undefined&&(typeof v.mentionCount!=='number'||!Number.isSafeInteger(v.mentionCount)||v.mentionCount<0||v.mentionCount>100))return false;
 if(v.forwarded!==undefined&&typeof v.forwarded!=='boolean')return false;
 if(v.text!==undefined&&(v.type!=='TEXT'||typeof v.text!=='string'||v.text.length>4096||v.text.includes('\0')))return false;
 if(v.caption!==undefined&&(v.type==='TEXT'||typeof v.caption!=='string'||v.caption.length>4096||v.caption.includes('\0')))return false;
 return v.links===undefined||stringList(v.links,x=>typeof x==='string'&&x.length>=1&&x.length<=2048&&urlHost(x)!==null,100);
}
function urlHost(raw:string):string|null{
 try{const u=new URL(/^https?:\/\//iu.test(raw)?raw:'https://'+raw);return ['https:','http:'].includes(u.protocol)&&u.hostname?u.hostname.toLowerCase():null;}catch{return null;}
}
const contains=(normalized:string,value:string)=>(' '+normalized+' ').includes(' '+normalizeProtectionText(value)+' ');
const severity:Readonly<Record<ProtectionAction,number>>={REVIEW:0,WARN:1,DELETE:2,MUTE:3};
export function evaluateProtectionRules(config:unknown,input:unknown,now:number=Date.now()):ProtectionEvaluation{
 const result=(status:ProtectionEvaluation['status'],ids:string[]=[],action:ProtectionAction|null=null):ProtectionEvaluation=>({status,matchedRuleIds:ids,proposedAction:action,authorizedToSend:false});
 if(!isValidProtectionPolicy(config))return result('INVALID_POLICY');
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000||!validMessage(input,config.chatId))return result('INVALID_MESSAGE');
 if(config.mode==='OFF')return result('OFF');
 if(protectionMemberExempt(config,input.memberId,now))return result('EXEMPT');
 const body=input.text??input.caption??'',normalized=normalizeProtectionText(body);
 // Mask only the reviewed phrase span, never unrelated words elsewhere.
 let lexicalBody=' '+normalized+' ';
 for(const allowed of config.allowedPhrases){
  const needle=' '+normalizeProtectionText(allowed)+' ';
  // An internal boundary prevents joining words across an exempt span.
  while(lexicalBody.includes(needle))lexicalBody=lexicalBody.replaceAll(needle,' \u0000 ');
 }
 lexicalBody=lexicalBody.trim();
 const extracted=[...body.matchAll(/https?:\/\/[^\s<>"']+|(?:www\.|t\.me\/)[^\s<>"']+/giu)].map(m=>m[0].replace(/[),.!؟،؛]+$/gu,''));
 const hosts=new Set([...extracted,...(input.links??[])].map(urlHost).filter((h):h is string=>h!==null));
 const matches=config.rules.filter(r=>{
  if(!r.enabled)return false;
  if(r.kind==='WORD'&&r.match==='PARTIAL')return lexicalBody.includes(normalizeProtectionText(r.value));
  if(r.kind==='WORD'||r.kind==='PHRASE')return contains(lexicalBody,r.value);
  if(r.kind==='LIMIT'){
   const count=r.metric==='LENGTH'?Array.from(body).length:r.metric==='MENTIONS'?Math.max(input.mentionCount??0,[...body.matchAll(/(?<![\p{L}\p{N}_])@[A-Za-z][A-Za-z0-9_]{4,31}(?![A-Za-z0-9_])/gu)].length):[...body.matchAll(/(?<![\p{L}\p{N}_])#[\p{L}\p{N}_]+/gu)].length;
   return count>r.maximum;
  }
  if(r.kind==='FORWARD')return input.forwarded===true;
  if(r.kind==='TYPE')return r.type===input.type;
  if(r.kind!=='LINK')return false;
  const targets=r.hosts;
  return [...hosts].some(h=>!config.allowedDomains.includes(h)&&(targets==='*'||targets.some(blocked=>h===blocked||h.endsWith('.'+blocked))));
 });
 if(!matches.length)return result('CLEAR');
 const action=matches.reduce<ProtectionAction>((current,r)=>severity[r.action]>severity[current]?r.action:current,'REVIEW');
 return result('MATCH',matches.map(r=>r.id).sort(),action);
}

export interface GroupProtectionRecord{policy:ProtectionPolicy;chatPolicyVersion:number;updatedBy:string;updatedAt:number;}
export function isValidGroupProtectionRecord(value:unknown):value is GroupProtectionRecord{
 return object(value)&&keys(value,['policy','chatPolicyVersion','updatedBy','updatedAt'])&&isValidProtectionPolicy(value.policy)&&
  typeof value.chatPolicyVersion==='number'&&Number.isSafeInteger(value.chatPolicyVersion)&&value.chatPolicyVersion>=1&&member(value.updatedBy)&&
  typeof value.updatedAt==='number'&&Number.isSafeInteger(value.updatedAt)&&value.updatedAt>=0&&value.updatedAt<=8640000000000000;
}
