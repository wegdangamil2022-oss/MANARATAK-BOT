export interface CommunityFolder{chatId:string;url:string;enabled:boolean;revision:number;}
export const communityFolderURL=(v:unknown):v is string=>typeof v==='string'&&/^https:\/\/t\.me\/addlist\/[A-Za-z0-9_-]{1,128}$/u.exec(v)?.[0]===v;
export function validCommunityFolders(v:unknown):v is CommunityFolder[]{
 return Array.isArray(v)&&v.length<=1000&&v.every(r=>r&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).length===4&&typeof r.chatId==='string'&&/^-[1-9][0-9]{0,15}$/u.test(r.chatId)&&Number.isSafeInteger(Number(r.chatId))&&communityFolderURL(r.url)&&typeof r.enabled==='boolean'&&Number.isSafeInteger(r.revision)&&r.revision>=1&&r.revision<Number.MAX_SAFE_INTEGER)&&new Set(v.map(r=>r.chatId)).size===v.length;
}
