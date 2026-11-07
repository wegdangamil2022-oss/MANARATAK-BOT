/** 08:01 — GAME-001. Policies apply per approved Telegram group.
 * Only the multiple-choice quiz engine is implemented. All other catalogue
 * entries are informative: they cannot be enabled or mistaken for working games.
 * Absent configuration preserves the existing owner-reviewed quiz workflow.
 */
export interface GameCatalogConfig{
 chatId:string;chatVersion:number;revision:number;
 quizEnabled:boolean;dailyLimit:number;
 quietStartUtcMinute?:number;quietEndUtcMinute?:number;
 updatedAt:number;
}
export interface GameCatalogState{groups:GameCatalogConfig[];}
export interface GameCatalogChange{
 quizEnabled:boolean;dailyLimit:number;
 quietStartUtcMinute?:number;quietEndUtcMinute?:number;
}
export const emptyGameCatalogState=():GameCatalogState=>({groups:[]});
export const gameCatalogGroup=(x:unknown):x is string=>
 typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
const object=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(o:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]) =>
 required.every(x=>Object.hasOwn(o,x))&&
 Object.keys(o).every(x=>required.includes(x)||optional.includes(x));
const integer=(x:unknown,lo:number,hi:number):x is number=>
 typeof x==='number'&&Number.isSafeInteger(x)&&x>=lo&&x<=hi;
const clock=(x:unknown):x is number=>integer(x,0,8_640_000_000_000_000-100*86_400_000);
export function validGameCatalogChange(x:unknown):x is GameCatalogChange{
 if(!object(x)||!exact(x,['quizEnabled','dailyLimit'],[
  'quietStartUtcMinute','quietEndUtcMinute'])||
  typeof x.quizEnabled!=='boolean'||!integer(x.dailyLimit,1,10))return false;
 const hasStart=x.quietStartUtcMinute!==undefined;
 const hasEnd=x.quietEndUtcMinute!==undefined;
 if(hasStart!==hasEnd)return false;
 if(hasStart&&(!integer(x.quietStartUtcMinute,0,1439)||
  !integer(x.quietEndUtcMinute,0,1439)||
  x.quietStartUtcMinute===x.quietEndUtcMinute))return false;
 return true;
}
function validConfig(v:unknown):v is GameCatalogConfig{
 if(!object(v)||!exact(v,['chatId','chatVersion','revision',
  'quizEnabled','dailyLimit','updatedAt'],[
  'quietStartUtcMinute','quietEndUtcMinute'])||
  !gameCatalogGroup(v.chatId)||!integer(v.chatVersion,1,999999999)||
  !integer(v.revision,1,999999999)||!clock(v.updatedAt))return false;
 return validGameCatalogChange({
  quizEnabled:v.quizEnabled,dailyLimit:v.dailyLimit,
  ...(v.quietStartUtcMinute!==undefined?{quietStartUtcMinute:v.quietStartUtcMinute}:{}),
  ...(v.quietEndUtcMinute!==undefined?{quietEndUtcMinute:v.quietEndUtcMinute}:{})
 });
}
export function validGameCatalogState(v:unknown):v is GameCatalogState{
 if(!object(v)||!exact(v,['groups'])||!Array.isArray(v.groups)||
  v.groups.length>500||v.groups.some(x=>!validConfig(x)))return false;
 const groups=v.groups as GameCatalogConfig[];
 return new Set(groups.map(x=>x.chatId)).size===groups.length;
}
