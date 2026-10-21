/** Stateless Telegram search selectors are display-only. There is no cursor
 * authority in button text: every page must be recomputed under the current
 * actor's published-resource access policy.
 */
export interface SearchPageCommand{
 query:string;page:number;direction:'next'|'previous';
}
/** Bounded, predictable Unicode search; no markup, colon, controls, newlines
 * or whitespace ambiguity in a copyable Telegram reply-keyboard label.
 */
const queryPattern=/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,30}[\p{L}\p{N}]$/u;
export function isValidSearchTerm(value:unknown):value is string{
 return typeof value==='string'&&value.length<=64&&
  Array.from(value).length>=2&&Array.from(value).length<=32&&
  queryPattern.test(value)&&!value.includes('  ');
}
export function parseSearchQuery(text:string):string|null{
 if(typeof text!=='string'||text.length>120)return null;
 const match=/^\/search (.+)$/u.exec(text);
 if(!match||!isValidSearchTerm(match[1]))return null;
 return match[1]!;
}
export function searchPageButton(query:string,page:number,direction:'next'|'previous'):string{
 if(!isValidSearchTerm(query)||!Number.isSafeInteger(page)||page<0||page>999)
  throw Error('INVALID_SEARCH_PAGE');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+' · s:'+query+':'+page;
}
export function parseSearchPageCommand(text:string):SearchPageCommand|null{
 if(typeof text!=='string'||text.length>140)return null;
 const match=/^(➡️ التالي|⬅️ السابق) · s:(.+):(0|[1-9][0-9]{0,2})$/u.exec(text);
 if(!match||match[0]!==text||!isValidSearchTerm(match[2]))return null;
 return {
  query:match[2]!,page:Number(match[3]),
  direction:match[1]==='➡️ التالي'?'next':'previous'
 };
}
