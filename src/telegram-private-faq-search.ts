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
  value.startsWith('➡️ التالي · fq:')||value.startsWith('⬅️ السابق · fq:');
}
