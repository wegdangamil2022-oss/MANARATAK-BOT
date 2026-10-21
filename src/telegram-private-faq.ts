import {createHash} from 'node:crypto';
export const privateFAQBrowseLabel='📖 تصفح الأسئلة المعتمدة';
const id=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
/** Hashes hide private FAQ database identifiers from student's button text.
 * This token is a locator only; all authorized records must be re-read.
 */
export function privateFAQButton(faqId:string,ordinal?:number):string{
 if(!id.test(faqId)||ordinal!==undefined&&
   (!Number.isSafeInteger(ordinal)||ordinal<1||ordinal>10000))
  throw Error('INVALID_PRIVATE_FAQ_ID');
 const hash='~'+createHash('sha256').update(faqId,'utf8').digest('hex').slice(0,16);
 return ordinal===undefined?'📖 سؤال · '+hash:'📖 سؤال '+ordinal+' · '+hash;
}
export function parsePrivateFAQSelection(text:string):string|null{
 if(typeof text!=='string'||text.length>50)return null;
 const found=/^📖 سؤال (?:([1-9][0-9]{0,3}|10000) · )?(~[a-f0-9]{16})$/u.exec(text);
 if(found)return found[2]!;
 const legacy=/^📖 سؤال · (~[a-f0-9]{16})$/u.exec(text);
 return legacy?.[1]??null;
}
export type PrivateFAQPage={page:number;direction:'next'|'previous'};
export function parsePrivateFAQPage(text:string):PrivateFAQPage|null{
 if(typeof text!=='string'||text.length>48)return null;
 const found=/^(➡️ التالي|⬅️ السابق) · pf:(0|[1-9][0-9]{0,2})$/u.exec(text);
 return found?{page:Number(found[2]!),direction:found[1]==='➡️ التالي'?'next':'previous'}:null;
}
export function privateFAQPageLabel(page:number,direction:PrivateFAQPage['direction']):string{
 if(!Number.isInteger(page)||page<0||page>999)throw Error('INVALID_PRIVATE_FAQ_PAGE');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+' · pf:'+page;
}
export function isPrivateFAQBrowseText(text:string):boolean{
 return text===privateFAQBrowseLabel||text.startsWith('📖 سؤال ')||
  text.startsWith('➡️ التالي · pf:')||text.startsWith('⬅️ السابق · pf:');
}

/**
 * A private student may explicitly request one exact, owner-approved FAQ
 * answer. The command is NOT an AI opt-in nor a request to inspect a group.
 */
export function parsePrivateFAQQuery(text:string):string|null{
 if(typeof text!=='string'||text.length>250)return null;
 const match=/^\/faq ([^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]{1,246})$/u.exec(text);
 if(!match)return null;
 const q=match[1]!.trim();
 return q&&Array.from(q).length<=240?q:null;
}
