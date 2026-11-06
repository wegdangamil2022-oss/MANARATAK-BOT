import type {BotState} from './store.js';
const ROOT='moderation:rules:',PUBLISH='GROUP_RULES_PUBLISHED:';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const escape=(v:string)=>v.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
export type Version={chat:string;version:number;lines:string[];disabled?:number[];translations?:Record<string,string[]>;actor:string;at:number;scope:number};
export const validRuleLanguage=(v:string):boolean=>/^[a-z]{2}(?:-[A-Z]{2})?$/u.exec(v)?.[0]===v;
export const validRuleTranslations=(v:unknown,length:number):v is Record<string,string[]>=>object(v)&&Object.keys(v).length<=3&&Object.entries(v).every(([language,text])=>validRuleLanguage(language)&&lines(text)&&text.length===length);
export const ruleContentShape=(v:Record<string,unknown>,required:string):boolean=>Object.keys(v).filter(k=>k!=='disabled'&&k!=='translations').sort().join(',')===required&&lines(v.lines)&&(!Object.hasOwn(v,'disabled')||validDisabled(v.disabled,v.lines.length))&&(!Object.hasOwn(v,'translations')||validRuleTranslations(v.translations,v.lines.length));
export const validDisabled=(v:unknown,length:number):v is number[]=>Array.isArray(v)&&v.length<=length&&v.every((n,i)=>Number.isSafeInteger(n)&&n>=1&&n<=length&&(i===0||n>v[i-1]));
export const lines=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>=1&&v.length<=20&&v.every(x=>typeof x==='string'&&x===x.trim()&&x.length>=1&&x.length<=120&&!/[\u0000-\u001f\u007f]/u.test(x))&&new Set(v).size===v.length&&Buffer.byteLength(v.map(x=>escape(x)).join('\n'),'utf8')<=2400;
export function versions(s:BotState,chat:string):Version[]{
 const result:Version[]=[];
 for(const a of s.audit){if(!a.updateKey.startsWith(ROOT+'published:'+chat+':')||!a.reason.startsWith(PUBLISH)||a.decision!=='ALLOW'||!a.actorId||s.audit.filter(x=>x.updateKey===a.updateKey).length!==1)continue;
  try{const v:unknown=JSON.parse(Buffer.from(a.reason.slice(PUBLISH.length),'base64url').toString('utf8'));if(!object(v)||!ruleContentShape(v,'chat,lines,version')||v.chat!==chat||!lines(v.lines)||!Number.isSafeInteger(v.version)||Number(v.version)<=0||a.updateKey!==ROOT+'published:'+chat+':'+v.version||!Number.isSafeInteger(a.at)||a.at<0||a.at>8640000000000000)continue;
   result.push({chat,lines:v.lines,...(Object.hasOwn(v,'disabled')?{disabled:v.disabled as number[]}:{}),...(Object.hasOwn(v,'translations')?{translations:v.translations as Record<string,string[]>}:{}),version:Number(v.version),actor:a.actorId,at:a.at,scope:a.policyVersion});
  }catch{/* invalid history cannot become approved rules */}
 }
 return result.sort((a,b)=>a.version-b.version);
}
export function currentGroupRuleVersion(s:BotState,chat:string):number|null{const history=versions(s,chat),v=history.at(-1),groups=s.chats.filter(c=>c.id===chat);return history.length===s.audit.filter(a=>a.updateKey.startsWith(ROOT+'published:'+chat+':')).length&&groups.length===1&&v?.scope===groups[0]!.version?v.version:null;}
export function groupRuleDescription(s:BotState,chat:string,reference:string,current=false):string|null{
 const m=/^law_v([1-9][0-9]{0,14})_p([1-9][0-9]?)_m([1-9][0-9]{0,15})$/u.exec(reference);if(!m||m[0]!==reference)return null;
 const history=versions(s,chat),v=history.find(v=>v.version===Number(m[1])),line=v?.lines[Number(m[2])-1];if(!v||!line||current&&(currentGroupRuleVersion(s,chat)!==v.version||v.disabled?.includes(Number(m[2]))))return null;
 return 'القانون '+m[2]+' · الإصدار '+m[1]+': '+line;
}
