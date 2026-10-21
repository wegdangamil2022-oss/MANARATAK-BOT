/**
 * Orthographic matching only, not machine translation or fuzzy similarity.
 * Keep Telegram input validation separate from matching: normalizing a
 * displayed label must never be mistaken for a trusted command or actor.
 */
export function normalizeStudentSearchText(value:string):string{
 return value.normalize('NFKC').toLowerCase()
  // Tatweel and Arabic vowel / Quranic combining marks often occur in titles,
  // but are optional in how students type a simple scholarship search.
  .replace(/[\u0640\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/gu,'')
  .replace(/[أإآٱ]/gu,'ا')
  .replace(/[ؤ]/gu,'و')
  .replace(/[ئىيی]/gu,'ي')
  .replace(/[ةە]/gu,'ه')
  .replace(/ک/gu,'ك')
  .replace(/[\u0660-\u0669\u06f0-\u06f9]/gu,ch=>{
   const n=ch.charCodeAt(0);
   return String(n>0x06ef?n-0x06f0:n-0x0660);
  })
  .replace(/\s+/gu,' ').trim();
}
