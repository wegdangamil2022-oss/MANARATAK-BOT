/** Phase 4 / 09:12 — optional owner-reviewed social appreciation.
 * Badges are never diplomas, licenses, eligibility for scholarships,
 * moderation authority, account rank or a Telegram verification mark.
 */
export type BadgeCode='HELPFULNESS'|'STUDY_SUPPORT'|'RESOURCE_GUIDE'|'COMMUNITY_CARE';
export const BADGE_LABELS:Readonly<Record<BadgeCode,string>>={
 HELPFULNESS:'مساعدة تعليمية',
 STUDY_SUPPORT:'دعم المذاكرة',
 RESOURCE_GUIDE:'مشاركة مصادر تعليمية',
 COMMUNITY_CARE:'مساهمة إيجابية'
};
export const isBadgeCode=(v:unknown):v is BadgeCode=>
 typeof v==='string'&&Object.hasOwn(BADGE_LABELS,v);
export interface BadgeConsent{
 chatId:string;chatVersion:number;memberId:string;revision:1;updatedAt:number;
}
export type BadgeStatus='DRAFT'|'AWARDED'|'REVOKED';
export interface BadgeAward{
 id:string;chatId:string;chatVersion:number;memberId:string;ownerId:string;
 code:BadgeCode;status:BadgeStatus;revision:1|2|3;
 createdAt:number;awardedAt?:number;revokedAt?:number;
}
export interface BadgeState{consents:BadgeConsent[];awards:BadgeAward[]}
export const emptyBadgeState=():BadgeState=>({consents:[],awards:[]});
const obj=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]) =>
 required.every(k=>Object.hasOwn(v,k))&&
 Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const time=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-100*86_400_000;
const rev=(v:unknown):v is number=>Number.isSafeInteger(v)&&
 typeof v==='number'&&v>=1&&v<=9_999_999_999;
export const badgeId=(v:unknown):v is string=>
 typeof v==='string'&&/^[a-f0-9]{24}$/u.test(v);
export const badgeUser=(v:unknown):v is string=>
 typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
export const badgeGroup=(v:unknown):v is string=>
 typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
function validConsent(v:unknown):v is BadgeConsent{
 return obj(v)&&exact(v,['chatId','chatVersion','memberId','revision','updatedAt'])&&
  badgeGroup(v.chatId)&&rev(v.chatVersion)&&badgeUser(v.memberId)&&
  v.revision===1&&time(v.updatedAt);
}
function validAward(v:unknown):v is BadgeAward{
 if(!obj(v)||!exact(v,['id','chatId','chatVersion','memberId','ownerId',
  'code','status','revision','createdAt'],['awardedAt','revokedAt'])||
  !badgeId(v.id)||!badgeGroup(v.chatId)||!rev(v.chatVersion)||
  !badgeUser(v.memberId)||!badgeUser(v.ownerId)||!isBadgeCode(v.code)||
  !time(v.createdAt)||v.memberId===v.ownerId)return false;
 if(v.status==='DRAFT')return v.revision===1&&
  v.awardedAt===undefined&&v.revokedAt===undefined;
 if(v.status==='AWARDED')return v.revision===2&&time(v.awardedAt)&&
  v.awardedAt>=v.createdAt&&v.revokedAt===undefined;
 if(v.status==='REVOKED')return v.revision===3&&
  time(v.awardedAt)&&v.awardedAt>=v.createdAt&&
  time(v.revokedAt)&&v.revokedAt>=v.awardedAt;
 return false;
}
export function validBadgeState(v:unknown):v is BadgeState{
 if(!obj(v)||!exact(v,['consents','awards'])||
  !Array.isArray(v.consents)||v.consents.length>5000||
  !Array.isArray(v.awards)||v.awards.length>3000||
  v.consents.some(x=>!validConsent(x))||
  v.awards.some(x=>!validAward(x)))return false;
 const consents=v.consents as BadgeConsent[],awards=v.awards as BadgeAward[];
 if(new Set(consents.map(x=>x.chatId+':'+x.memberId)).size!==consents.length||
  new Set(awards.map(x=>x.id)).size!==awards.length||
  new Set(awards.map(x=>x.chatId+':'+x.memberId+':'+x.code)).size!==awards.length)
  return false;
 const byUser=new Map(consents.map(x=>[x.chatId+':'+x.memberId,x]));
 for(const row of awards){
  const c=byUser.get(row.chatId+':'+row.memberId);
  if(!c||c.chatVersion!==row.chatVersion||c.updatedAt>row.createdAt)
   return false;
 }
 return true;
}
