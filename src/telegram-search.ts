import {resourceButton} from './telegram-menu.js';
import type {EducationResource} from './store.js';

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
const queryPattern=/^[\p{L}\p{N}][\p{L}\p{N}\p{M} _-]{0,30}[\p{L}\p{N}\p{M}]$/u;
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


/** Context-bearing result selection. The text+id+query+page combination is
 * never a grant. Long names/IDs fall back to the old safe category button,
 * since Telegram reply-keyboard labels cannot exceed 96 codepoints / 256 B.
 */
export interface SearchResourceSelection{resourceId:string;query:string;page:number;}
export function searchResourceButton(
 resource:Pick<EducationResource,'id'|'title'>,query:string,page:number
):string{
 if(!/^[a-zA-Z0-9_-]{1,64}$/u.test(resource.id)||
    !isValidSearchTerm(query)||!Number.isSafeInteger(page)||page<0||page>999)
  throw Error('INVALID_SEARCH_RESULT');
 const idWithContext=resource.id+' · s:'+query+':'+page;
 const candidate=resourceButton({id:idWithContext,title:resource.title});
 if(Array.from(candidate).length>96||Buffer.byteLength(candidate,'utf8')>256)
  return resourceButton(resource);
 return candidate;
}
export function parseSearchResourceSelection(text:string):SearchResourceSelection|null{
 if(typeof text!=='string'||text.length>256||
    Array.from(text).length>96||Buffer.byteLength(text,'utf8')>256)return null;
 const m=/^🔎 .+ · ([a-zA-Z0-9_-]{1,64}) · s:(.+):(0|[1-9][0-9]{0,2})$/u.exec(text);
 if(!m||m[0]!==text||!isValidSearchTerm(m[2]))return null;
 return {resourceId:m[1]!,query:m[2]!,page:Number(m[3]!)};
}
export function searchResultsBreadcrumb(query:string,page:number):string{
 if(!isValidSearchTerm(query)||!Number.isSafeInteger(page)||page<0||page>999)
  throw Error('INVALID_SEARCH_BREADCRUMB');
 return '↩️ نتائج البحث · s:'+query+':'+page;
}
export function parseSearchResultsBreadcrumb(text:string):{query:string;page:number}|null{
 if(typeof text!=='string'||text.length>140)return null;
 const m=/^↩️ نتائج البحث · s:(.+):(0|[1-9][0-9]{0,2})$/u.exec(text);
 if(!m||m[0]!==text||!isValidSearchTerm(m[1]))return null;
 return {query:m[1]!,page:Number(m[2]!)};
}
