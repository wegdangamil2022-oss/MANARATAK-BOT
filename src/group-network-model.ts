/** Pure schema validation for local group-network organization.
 * Network membership is organizational metadata only, never authorization. */
export interface GroupNetwork {
 id:string; name:string; revision:number; createdBy:string; updatedAt:number;
 members:{chatId:string;version:number}[];
}
const chat=(id:unknown)=>typeof id==='string'&&/^-[1-9][0-9]{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
const ver=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=9_999_999_999;
const name=(v:unknown)=>typeof v==='string'&&v.length>=2&&v.length<=48&&
 v===v.trim()&&v===v.normalize('NFC')&&
 /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(v)&&!/\s{2}/u.test(v);
export const validNetworkName=name;
export function validGroupNetwork(value:unknown):value is GroupNetwork{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>,keys=Object.keys(v);
 if(keys.length!==6||!['id','name','revision','createdBy','updatedAt','members'].every(k=>keys.includes(k))||
  typeof v.id!=='string'||!/^[a-f0-9]{12}$/u.test(v.id)||!name(v.name)||
  !ver(v.revision)||typeof v.createdBy!=='string'||!/^[1-9][0-9]{0,15}$/u.test(v.createdBy)||
  !Number.isSafeInteger(v.updatedAt)||typeof v.updatedAt!=='number'||v.updatedAt<0||
  v.updatedAt>8_640_000_000_000_000||
  !Array.isArray(v.members)||v.members.length>50)return false;
 const ids=new Set<string>();
 for(const item of v.members){
  if(!item||typeof item!=='object'||Array.isArray(item))return false;
  const m=item as Record<string,unknown>;
  if(Object.keys(m).length!==2||!chat(m.chatId)||!ver(m.version)||ids.has(m.chatId as string))return false;
  ids.add(m.chatId as string);
 }
 return true;
}
export function validGroupNetworks(value:unknown):value is GroupNetwork[]{
 if(!Array.isArray(value)||value.length>32||value.some(v=>!validGroupNetwork(v)))return false;
 const ids=value.map((v:GroupNetwork)=>v.id);
 const names=value.map((v:GroupNetwork)=>v.name.toLocaleLowerCase('en-US'));
 return new Set(ids).size===ids.length&&new Set(names).size===names.length;
}
