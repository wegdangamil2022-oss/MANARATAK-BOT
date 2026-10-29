import {isValidFloodPolicy,type FloodPolicy} from './protection-flood.js';
/** Local policy evaluation only. No text storage, media download, classifier,
 * database, Telegram gateway or authority to punish belongs in this module. */
export type ProtectionAction='REVIEW'|'WARN'|'DELETE'|'MUTE';
export type ProtectionMessageType='TEXT'|'PHOTO'|'VIDEO'|'ANIMATION'|'STICKER'|'DOCUMENT'|'AUDIO'|'VOICE'|'VIDEO_NOTE'|'CONTACT'|'LOCATION'|'POLL';
type BaseRule={id:string;enabled:boolean;action:ProtectionAction};
export type ProtectionRule=BaseRule & ({kind:'WORD'|'PHRASE';value:string}|{kind:'TYPE';type:ProtectionMessageType}|{kind:'LINK';hosts:'*'|string[]}|{kind:'FORWARD'});
export interface ProtectionPolicy{chatId:string;revision:number;mode:'OFF'|'MONITOR'|'ENFORCE';rules:ProtectionRule[];allowedDomains:string[];allowedPhrases:string[];exemptMemberIds:string[];flood?:FloodPolicy;}
export interface ProtectionMessage{chatId:string;memberId:string;type:ProtectionMessageType;text?:string;caption?:string;links?:string[];forwarded?:boolean;}
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
export function isValidProtectionPolicy(v:unknown):v is ProtectionPolicy{
 if(!object(v)||!keys(v,['chatId','revision','mode','rules','allowedDomains','allowedPhrases','exemptMemberIds',...(Object.hasOwn(v,'flood')?['flood']:[])])||Object.hasOwn(v,'flood')&&!isValidFloodPolicy(v.flood)||!group(v.chatId)||
  !Number.isSafeInteger(v.revision)||typeof v.revision!=='number'||v.revision<1||(typeof v.mode!=='string'||!['OFF','MONITOR','ENFORCE'].includes(v.mode))||
  !stringList(v.allowedDomains,host,100)||!stringList(v.allowedPhrases,phrase,100)||!stringList(v.exemptMemberIds,member,100)||
  !Array.isArray(v.rules)||v.rules.length>100)return false;
 const seen=new Set<string>();
 return v.rules.every(r=>{
  if(!object(r)||typeof r.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/u.test(r.id)||seen.has(r.id)||
   typeof r.enabled!=='boolean'||(typeof r.action!=='string'||!actions.includes(r.action)))return false;
  seen.add(r.id);
  if(r.kind==='WORD'||r.kind==='PHRASE')return keys(r,['id','enabled','action','kind','value'])&&phrase(r.value)&&
   (r.kind!=='WORD'||!normalizeProtectionText(r.value).includes(' '));
  if(r.kind==='FORWARD')return keys(r,['id','enabled','action','kind']);
  if(r.kind==='TYPE')return keys(r,['id','enabled','action','kind','type'])&&typeof r.type==='string'&&typeNames.includes(r.type);
  return r.kind==='LINK'&&keys(r,['id','enabled','action','kind','hosts'])&&
   (r.hosts==='*'||stringList(r.hosts,host,100)&&r.hosts.length>0);
 });
}
function validMessage(v:unknown,chatId:string):v is ProtectionMessage{
 if(!object(v)||Object.keys(v).some(k=>!['chatId','memberId','type','text','caption','links','forwarded'].includes(k))||v.chatId!==chatId||
  !member(v.memberId)||typeof v.type!=='string'||!typeNames.includes(v.type)||v.text!==undefined&&v.caption!==undefined)return false;
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
export function evaluateProtectionRules(config:unknown,input:unknown):ProtectionEvaluation{
 const result=(status:ProtectionEvaluation['status'],ids:string[]=[],action:ProtectionAction|null=null):ProtectionEvaluation=>({status,matchedRuleIds:ids,proposedAction:action,authorizedToSend:false});
 if(!isValidProtectionPolicy(config))return result('INVALID_POLICY');
 if(!validMessage(input,config.chatId))return result('INVALID_MESSAGE');
 if(config.mode==='OFF')return result('OFF');
 if(config.exemptMemberIds.includes(input.memberId))return result('EXEMPT');
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
  if(r.kind==='WORD'||r.kind==='PHRASE')return contains(lexicalBody,r.value);
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
