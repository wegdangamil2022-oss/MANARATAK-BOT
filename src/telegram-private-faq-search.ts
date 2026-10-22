import {privateFAQButton,parsePrivateFAQSelection} from './telegram-private-faq.js';
export const privateFAQSearchLabel='🔎 ابحث في الأسئلة';
export interface PrivateFAQSearchPage{query:string;page:number;direction:'next'|'previous'}
/** Search requests are stateless, private and bounded. Only approved private
 * FAQs are ever searched; the query is not stored or sent to external AI.
 */
function canonicalSearchTerm(value:string):string|null{
 if(typeof value!=='string'||value.length>80)return null;
 const term=value.trim();
 if(!term||Array.from(term).length>40||Buffer.byteLength(term,'utf8')>48||
  /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(term))
  return null;
 return term;
}
export function parsePrivateFAQSearchQuery(value:string):string|null{
 if(typeof value!=='string'||value.length>150)return null;
 const match=/^\/faqsearch ([^\u0000-\u001f\u007f]+)$/u.exec(value);
 return match?canonicalSearchTerm(match[1]!):null;
}
export function privateFAQSearchPageLabel(query:string,page:number,direction:PrivateFAQSearchPage['direction']):string{
 const term=canonicalSearchTerm(query);
 if(!term||!Number.isSafeInteger(page)||page<0||page>999)
  throw Error('INVALID_FAQ_SEARCH_PAGE');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+' · fq:'+page+':'+
  Buffer.from(term,'utf8').toString('base64url');
}
export function parsePrivateFAQSearchPage(value:string):PrivateFAQSearchPage|null{
 if(typeof value!=='string'||value.length>100)return null;
 const m=/^(➡️ التالي|⬅️ السابق) · fq:(0|[1-9][0-9]{0,2}):([A-Za-z0-9_-]{2,64})$/u.exec(value);
 if(!m)return null;
 const decoded=Buffer.from(m[3]!,'base64url').toString('utf8');
 const term=canonicalSearchTerm(decoded);
 if(!term||Buffer.from(term,'utf8').toString('base64url')!==m[3])return null;
 const direction=m[1]==='➡️ التالي'?'next':'previous',page=Number(m[2]!);
 if((direction==='next'&&page===0)||(direction==='previous'&&page===999))return null;
 return {query:term,page,direction};
}
export function isPrivateFAQSearchText(value:string):boolean{
 return value===privateFAQSearchLabel||value.startsWith('/faqsearch')||
  value.startsWith('➡️ التالي · fq:')||value.startsWith('⬅️ السابق · fq:')||
  value.startsWith('↩️ نتائج الأسئلة · fs:')||
  (value.startsWith('📖 سؤال ')&&value.includes(' · fs:'));
}


/** A search-origin FAQ selector carries the current visible global ordinal,
 * opaque ID locator, bounded keyword and page. It is not a source grant.
 * Oversized reply keyboard labels deliberately fall back to the legacy
 * visible-FAQ selector; this loses search context but not safety.
 */
const encodedTerm=(query:string):string=>{
 const term=canonicalSearchTerm(query);
 if(!term)throw Error('INVALID_FAQ_SEARCH_ORIGIN');
 return Buffer.from(term,'utf8').toString('base64url');
};
const decodedTerm=(encoded:string):string|null=>{
 if(!/^[A-Za-z0-9_-]{2,64}$/u.test(encoded))return null;
 const decoded=Buffer.from(encoded,'base64url').toString('utf8');
 const term=canonicalSearchTerm(decoded);
 if(!term||Buffer.from(term,'utf8').toString('base64url')!==encoded)return null;
 return term;
};
const fitsKeyboard=(text:string):boolean=>
 Array.from(text).length<=96&&Buffer.byteLength(text,'utf8')<=256;
export function privateFAQSearchSelectionLabel(
 faqId:string,ordinal:number,query:string,page:number
):string{
 const original=privateFAQButton(faqId,ordinal);
 if(!Number.isSafeInteger(page)||page<0||page>999)throw Error('INVALID_FAQ_SEARCH_ORIGIN');
 const text=original+' · fs:'+page+':'+encodedTerm(query);
 return fitsKeyboard(text)?text:original;
}
export interface PrivateFAQSearchSelection{
 token:string;ordinal:number;query:string;page:number;
}
export function parsePrivateFAQSearchSelection(value:string):PrivateFAQSearchSelection|null{
 if(typeof value!=='string'||value.length>256||!fitsKeyboard(value))return null;
 const m=/^(📖 سؤال ([1-9][0-9]{0,3}|10000) · (~[a-f0-9]{16})) · fs:(0|[1-9][0-9]{0,2}):([A-Za-z0-9_-]{2,64})$/u.exec(value);
 if(!m||!parsePrivateFAQSelection(m[1]!))return null;
 const query=decodedTerm(m[5]!);
 return query?{token:m[3]!,ordinal:Number(m[2]!),query,page:Number(m[4]!)}:null;
}
export function privateFAQSearchReturnLabel(query:string,page:number):string{
 if(!Number.isSafeInteger(page)||page<0||page>999)
  throw Error('INVALID_FAQ_SEARCH_RETURN');
 const label='↩️ نتائج الأسئلة · fs:'+page+':'+encodedTerm(query);
 if(!fitsKeyboard(label))throw Error('FAQ_RETURN_KEYBOARD_TOO_LARGE');
 return label;
}
export function parsePrivateFAQSearchReturn(value:string):{query:string;page:number}|null{
 if(typeof value!=='string'||value.length>140||!fitsKeyboard(value))return null;
 const m=/^↩️ نتائج الأسئلة · fs:(0|[1-9][0-9]{0,2}):([A-Za-z0-9_-]{2,64})$/u.exec(value);
 if(!m)return null;
 const query=decodedTerm(m[2]!);
 return query?{query,page:Number(m[1]!)}:null;
}
