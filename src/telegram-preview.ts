/** Render a bounded, well-formed Telegram HTML *list preview*.
 * Approval and access happen elsewhere: clipping is for display only.
 * Iterate Unicode codepoints, escape BEFORE counting UTF-8 bytes and never
 * truncate inside a surrogate pair or HTML entity. Never use this to alter
 * authoritative item keys or the full reviewed answer.
 */
export function escapeTelegramListPreview(value:string,maxBytes=220):string{
 if(typeof value!=='string'||!Number.isSafeInteger(maxBytes)||maxBytes<8||maxBytes>1024)
  throw Error('INVALID_TELEGRAM_PREVIEW');
 const sanitized=value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim();
 const escape=(character:string):string=>{
  switch(character){
   case '&':return '&amp;';
   case '<':return '&lt;';
   case '>':return '&gt;';
   case '"':return '&quot;';
   case "'":return '&#39;';
   default:return character;
  }
 };
 let displayed='',bytes=0;
 const chars=Array.from(sanitized);
 for(let i=0;i<chars.length;i++){
  const part=escape(chars[i]!);
  const partBytes=Buffer.byteLength(part,'utf8');
  const reserve=i<chars.length-1?3:0;
  if(bytes+partBytes+reserve>maxBytes)return displayed+'…';
  displayed+=part;bytes+=partBytes;
 }
 return displayed;
}
