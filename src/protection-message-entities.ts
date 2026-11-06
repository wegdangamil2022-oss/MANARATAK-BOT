function telephoneURL(value:string):boolean{
 if(!/^tel:\+?[0-9().-]+$/i.test(value)||/[\r\n]/.test(value))return false;
 const digits=value.slice(4).replace(/[^0-9]/g,'').length;
 return digits>=7&&digits<=15;
}

/** Telegram entity offsets are UTF-16 code units. Extract only explicit URL
 * metadata, rejecting broken ranges instead of silently reporting no links. */
export function protectionEntityLinks(text:string,entities:unknown):string[]|null{
 if(entities===undefined)return [];
 if(!Array.isArray(entities)||entities.length>100)return null;
 const boundary=(position:number)=>{
  if(position<=0||position>=text.length)return true;
  const before=text.charCodeAt(position-1),after=text.charCodeAt(position);
  return !(before>=0xd800&&before<=0xdbff&&after>=0xdc00&&after<=0xdfff);
 };
 const links=new Set<string>();
 for(const raw of entities){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const e=raw as Record<string,unknown>;
  if(typeof e.type!=='string'||typeof e.offset!=='number'||typeof e.length!=='number'||
   !Number.isSafeInteger(e.offset)||!Number.isSafeInteger(e.length)||e.offset<0||e.length<1||
   e.offset+e.length>text.length||!boundary(e.offset)||!boundary(e.offset+e.length))return null;
  if(e.type==='url'){
   const value=text.slice(e.offset,e.offset+e.length);
   if(/^tel:/i.test(value)){if(!telephoneURL(value))return null;}else links.add(value);
  }
  if(e.type==='text_link'){
   if(typeof e.url!=='string'||e.url.length<1||e.url.length>2048)return null;
   if(/^tel:/i.test(e.url)){if(!telephoneURL(e.url))return null;}else links.add(e.url);
  }
 }
 return [...links];
}

/** Call only after protectionEntityLinks has validated entity ranges and URLs. */
export function protectionHasPhoneEntity(text:string,entities:unknown):boolean{
 return Array.isArray(entities)&&entities.some(e=>e.type==='phone_number'||
  (e.type==='text_link'&&telephoneURL(e.url))||
  (e.type==='url'&&telephoneURL(text.slice(e.offset,e.offset+e.length))));
}

/** Call only after entity ranges have been validated by protectionEntityLinks. */
export function protectionMentionCount(text:string,entities:unknown):number{
 const ranges:{start:number;end:number}[]=[];
 for(const match of text.matchAll(/(?<![\p{L}\p{N}_])@[A-Za-z][A-Za-z0-9_]{4,31}(?![A-Za-z0-9_])/gu))ranges.push({start:match.index,end:match.index+match[0].length});
 if(Array.isArray(entities))for(const e of entities){
  if(e.type==='mention'||e.type==='text_mention')ranges.push({start:e.offset,end:e.offset+e.length});
 }
 ranges.sort((a,b)=>a.start-b.start||a.end-b.end);
 let count=0,end=-1;
 for(const range of ranges){if(range.start>=end){count++;end=range.end;}else end=Math.max(end,range.end);}
 return Math.min(count,101);
}
