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
  if(e.type==='url')links.add(text.slice(e.offset,e.offset+e.length));
  if(e.type==='text_link'){
   if(typeof e.url!=='string'||e.url.length<1||e.url.length>2048)return null;
   links.add(e.url);
  }
 }
 return [...links];
}
