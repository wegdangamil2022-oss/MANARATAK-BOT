/** Only an actual Telegram MessageEntity for this bot in the current
 * message can activate the group assistant. Telegram offsets/lengths are
 * UTF-16 code units; JavaScript slice follows precisely the same indexing.
 * Untrusted pasted @username text or text_mention has no authority.
 */
export type B6ExplicitMention = {status:'MATCH';question:string}|
 {status:'NO_MATCH'|'INVALID'};
const record=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const boundary=(text:string,index:number):boolean=>
 index>=0&&index<=text.length&&!(index>0&&index<text.length&&
  text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff&&
  text.charCodeAt(index-1)>=0xd800&&text.charCodeAt(index-1)<=0xdbff);

export function parseB6ExplicitMention(
 text:string,entities:unknown,botUsername:string):B6ExplicitMention {
 if(entities===undefined)return {status:'NO_MATCH'};
 if(typeof text!=='string'||typeof botUsername!=='string'||
    !/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(botUsername)||
    !Array.isArray(entities)||entities.length>64)return {status:'INVALID'};
 const target='@'+botUsername.toLowerCase();
 const prefix=text.slice(0,target.length).toLowerCase()===target;
 let found=false;
 for(const e of entities){
  if(!record(e)||typeof e.type!=='string'||
    !/^[a-z_]{1,40}$/u.test(e.type)||
    typeof e.offset!=='number'||!Number.isSafeInteger(e.offset)||
    typeof e.length!=='number'||!Number.isSafeInteger(e.length)||
    e.length<1||!boundary(text,e.offset)||!boundary(text,e.offset+e.length))
   return {status:'INVALID'};
  if(e.type!=='mention')continue;
  if(prefix&&(e.offset!==0||e.length!==target.length||
    Object.keys(e).length!==3))return {status:'INVALID'};
  if(e.offset!==0)continue;
  if(e.length!==target.length||text.slice(0,e.length).toLowerCase()!==target)
   continue;
  if(Object.keys(e).length!==3||found)return {status:'INVALID'};
  found=true;
 }
 if(!found)return {status:'NO_MATCH'};
 const tail=text.slice(target.length);
 if(!/^\s/u.test(tail))return {status:'INVALID'};
 const question=tail.trim();
 if(!question||question.length>240)return {status:'INVALID'};
 return {status:'MATCH',question};
}
