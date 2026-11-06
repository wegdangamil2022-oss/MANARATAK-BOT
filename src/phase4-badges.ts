import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyBadgeState,BADGE_LABELS,type BadgeCode,
 isBadgeCode,badgeId,badgeGroup,badgeUser} from './phase4-badge-model.js';
import type {BadgeAward,BadgeState} from './phase4-badge-model.js';

type VerifyMember=(chatId:string,memberId:string)=>Promise<
 'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
type ConsentStatus='ENABLED'|'DISABLED'|'ALREADY_ENABLED'|'ALREADY_DISABLED'|
 'VERIFICATION_REQUIRED'|'STALE'|'INVALID';
const time=(v:number)=>Number.isSafeInteger(v)&&v>=0&&
 v<=8_640_000_000_000_000-100*86_400_000;
const state=(s:BotState):BadgeState=>s.phase4Badges??emptyBadgeState();
const randomId=(items:readonly {id:string}[]):string=>{
 let id:string;do{id=randomBytes(12).toString('hex');}
 while(items.some(x=>x.id===id));return id;
};
const approved=(s:BotState,p:Policy,chatId:string)=>{
 const rows=s.chats.filter(x=>x.id===chatId),chat=rows[0];
 return rows.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&p.canUseChat(s,chatId,'navigation')?chat:null;
};
const fingerprint=(s:BotState,id:string)=>JSON.stringify(
 s.subscriptionRequirements.filter(x=>x.chatId===id));
export interface PersonalBadge{code:BadgeCode;label:string;awardedAt:number;}
/** Opt-in owner-reviewed appreciation: never validates academic credentials,
 * changes Telegram group permissions, awards money or gives scholarship
 * preference. Owner cannot submit an award absent member consent.
 */
export class Phase4BadgesService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private owner(s:BotState,actor:string,chatId:string):number|null{
  const chat=approved(s,this.policy,chatId);
  return chat&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?chat.version:null;
 }
 async consent(actor:string,chatId:string,enable:boolean):
 Promise<{status:ConsentStatus}>{
  const deny=(status:ConsentStatus)=>({status});
  const now=this.clock();
  if(!badgeUser(actor)||!badgeGroup(chatId)||!time(now)||typeof enable!=='boolean')
   return deny('INVALID');
  // Opt-out is permitted after leaving the group or losing bot access.
  // It erases ALL associated group awards and consent atomically, including
  // owner-previewed drafts, without leaving identity-linked tombstones.
  if(!enable)return this.store.transaction(s=>{
   const d=state(s);
   const existing=d.consents.some(x=>x.chatId===chatId&&x.memberId===actor)||
    d.awards.some(x=>x.chatId===chatId&&x.memberId===actor);
   if(!existing)return deny('ALREADY_DISABLED');
   d.consents=d.consents.filter(x=>!(x.chatId===chatId&&x.memberId===actor));
   d.awards=d.awards.filter(x=>!(x.chatId===chatId&&x.memberId===actor));
   s.phase4Badges=d;return deny('DISABLED');
  });
  const initial=await this.store.snapshot(),chat=approved(initial,this.policy,chatId);
  if(!chat)return deny('STALE');
  const d=state(initial);
  if(d.consents.some(x=>x.chatId===chatId&&x.memberId===actor&&
   x.chatVersion===chat.version))return deny('ALREADY_ENABLED');
  const fence=fingerprint(initial,chatId);
  let verified=false;
  try{verified=await this.verifyMember(chatId,actor)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!verified)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const fresh=approved(s,this.policy,chatId);
   if(!fresh||fresh.version!==chat.version||
    fingerprint(s,chatId)!==fence)return deny('STALE');
   const d=state(s);
   if(d.consents.some(x=>x.chatId===chatId&&x.memberId===actor&&
    x.chatVersion===chat.version))return deny('ALREADY_ENABLED');
   // Reapproval from an older chat epoch requires a NEW explicit opt-in.
   d.consents=d.consents.filter(x=>!(x.chatId===chatId&&x.memberId===actor));
   d.awards=d.awards.filter(x=>!(x.chatId===chatId&&x.memberId===actor));
   if(d.consents.length>=5000)return deny('INVALID');
   d.consents.push({chatId,chatVersion:fresh.version,memberId:actor,
    revision:1,updatedAt:this.clock()});
   s.phase4Badges=d;return deny('ENABLED');
  });
 }
 async draft(actor:string,chatId:string,memberId:string,code:BadgeCode):
 Promise<BadgeAward>{
  const now=this.clock();
  if(!time(now)||!badgeGroup(chatId)||!badgeUser(memberId)||!isBadgeCode(code))
   throw Error('BADGE_INVALID');
  return this.store.transaction(s=>{
   const version=this.owner(s,actor,chatId);
   if(version===null||actor===memberId)throw Error('BADGE_DENIED');
   const d=state(s);
   if(!d.consents.some(x=>x.chatId===chatId&&x.memberId===memberId&&
    x.chatVersion===version))throw Error('BADGE_CONSENT_REQUIRED');
   if(d.awards.some(x=>x.chatId===chatId&&x.memberId===memberId&&x.code===code))
    throw Error('BADGE_DUPLICATE');
   if(d.awards.length>=3000)throw Error('BADGE_CAPACITY');
   const row:BadgeAward={id:randomId(d.awards),chatId,chatVersion:version,
    memberId,ownerId:actor,code,status:'DRAFT',revision:1,createdAt:now};
   d.awards.push(row);s.phase4Badges=d;return structuredClone(row);
  });
 }
 async approve(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now)||!badgeId(id)||revision!==1)return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.awards.filter(x=>x.id===id),b=rows[0];
   if(rows.length!==1||!b||b.status!=='DRAFT'||b.revision!==revision||
    now<b.createdAt||now>=b.createdAt+30*86_400_000||b.ownerId!==actor||
    this.owner(s,actor,b.chatId)!==b.chatVersion||
    !d.consents.some(x=>x.chatId===b.chatId&&x.chatVersion===b.chatVersion&&
     x.memberId===b.memberId))return false;
   b.status='AWARDED';b.revision=2;b.awardedAt=now;
   s.phase4Badges=d;return true;
  });
 }
 async revoke(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now)||!badgeId(id)||revision!==2)return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.awards.filter(x=>x.id===id),b=rows[0];
   if(rows.length!==1||!b||b.status!=='AWARDED'||b.revision!==revision||
    now<b.awardedAt!||b.ownerId!==actor||
    this.owner(s,actor,b.chatId)!==b.chatVersion)return false;
   b.status='REVOKED';b.revision=3;b.revokedAt=now;
   s.phase4Badges=d;return true;
  });
 }
 async ownerCount(actor:string,chatId:string):Promise<number|null>{
  const s=await this.store.snapshot(),version=this.owner(s,actor,chatId),now=this.clock();
  if(version===null||!time(now))return null;
  return state(s).awards.filter(x=>x.chatId===chatId&&
   x.chatVersion===version&&x.status==='AWARDED'&&
   x.awardedAt!==undefined&&now<x.awardedAt+90*86_400_000).length;
 }
 async ownerView(actor:string,id:string):Promise<BadgeAward|null>{
  const s=await this.store.snapshot(),rows=state(s).awards.filter(x=>x.id===id),row=rows[0];
  return rows.length===1&&row&&row.ownerId===actor&&
   this.owner(s,actor,row.chatId)===row.chatVersion?structuredClone(row):null;
 }
 async list(actor:string):Promise<BadgeAward[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor))
   throw Error('BADGE_DENIED');
  return state(s).awards.filter(x=>x.ownerId===actor&&
   this.owner(s,actor,x.chatId)===x.chatVersion)
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
   .slice(0,40).map(x=>structuredClone(x));
 }
 async myBadges(actor:string,chatId:string):Promise<PersonalBadge[]|null>{
  if(!badgeUser(actor)||!badgeGroup(chatId))return null;
  const initial=await this.store.snapshot(),chat=approved(initial,this.policy,chatId);
  if(!chat||!state(initial).consents.some(x=>x.chatId===chatId&&
   x.chatVersion===chat.version&&x.memberId===actor))return null;
  const fence=fingerprint(initial,chatId);
  let verified=false;
  try{verified=await this.verifyMember(chatId,actor)==='VERIFIED';}
  catch{return null;}
  if(!verified)return null;
  const s=await this.store.snapshot(),fresh=approved(s,this.policy,chatId);
  if(!fresh||fresh.version!==chat.version||
   fingerprint(s,chatId)!==fence)return null;
  const d=state(s);
  if(!d.consents.some(x=>x.chatId===chatId&&x.chatVersion===fresh.version&&
   x.memberId===actor))return null;
  const now=this.clock();
  return d.awards.filter(x=>x.chatId===chatId&&x.memberId===actor&&
   x.chatVersion===fresh.version&&x.status==='AWARDED'&&
   x.awardedAt!==undefined&&now<x.awardedAt+90*86_400_000)
   .map(x=>({code:x.code,label:BADGE_LABELS[x.code],awardedAt:x.awardedAt!}));
 }
 /** Independent no-send cleanup. New opt-in always required after 180 days,
  * eliminating long-lived consent-only identifiers that could be forgotten.
  */
 async expire():Promise<number>{
  const now=this.clock();if(!time(now))return 0;
  return this.store.transaction(s=>{
   const d=state(s),beforeA=d.awards.length,beforeC=d.consents.length;
   d.consents=d.consents.filter(x=>now<x.updatedAt+180*86_400_000);
   d.awards=d.awards.filter(x=>{
    if(!d.consents.some(c=>c.chatId===x.chatId&&c.memberId===x.memberId&&
     c.chatVersion===x.chatVersion))return false;
    if(x.status==='DRAFT')return now<x.createdAt+30*86_400_000;
    if(x.status==='REVOKED')return now<x.revokedAt!+86_400_000;
    return now<x.awardedAt!+90*86_400_000;
   });
   if(beforeA!==d.awards.length||beforeC!==d.consents.length)
    s.phase4Badges=d;
   return beforeA-d.awards.length+beforeC-d.consents.length;
  });
 }
}
