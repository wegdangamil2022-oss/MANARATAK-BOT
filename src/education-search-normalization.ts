/** Discovery-only Unicode normalization for owner-reviewed education titles,
 * aliases and published resource metadata. Never use this for authority,
 * button identity, source modification or exact FAQ answer matching.
 */
export function normalizeEducationDiscovery(value:string):string{
 return value.normalize('NFKC').toLocaleLowerCase('en-US')
  .replace(/[\u064b-\u065f\u0670\u06d6-\u06ed]/gu,'')
  .replace(/[\u0622\u0623\u0625\u0671]/gu,'ا')
  .replace(/\u0649/gu,'ي')
  .replace(/\u0640/gu,'')
  .replace(/[\u0660-\u0669]/gu,d=>String(d.charCodeAt(0)-0x0660))
  .replace(/[\u06f0-\u06f9]/gu,d=>String(d.charCodeAt(0)-0x06f0))
  .replace(/[\p{P}\p{Z}\s]+/gu,' ').trim();
}
