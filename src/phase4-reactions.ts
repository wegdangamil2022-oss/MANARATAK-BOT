import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyReactionState,type ReactionState,type ReactionTarget,
 validReactionInput,reactionId,reactionUser,reactionGroup}
 from './phase4-reaction-model.js';

type VerifyMember=(chatId:string,actor:string)=>Promise<
 'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
type LikeStatus='LIKED'|'ALREADY_REACTED'|'VERIFICATION_REQUIRED'|
 'NOT_FOUND'|'CLOSED'|'EXPIRED'|'STALE'|'INVALID'|'CAPACITY'|'RATE_LIMIT';
const time=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-40*86_400_000;
const state=(s:BotState):ReactionState=>s.phase4Reactions??emptyReactionState();
const newId=(rows:readonly {id:string}[]):string=>{
 let id='';do{id=randomBytes(12).toString('hex');}
 while(rows.some(x=>x.id===id));return id;
};
const group=(s:BotState,p:Policy,id:string)=>{
 const rows=s.chats.filter(x=>x.id===id),chat=rows[0];
 return rows.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&p.canUseChat(s,id,'navigation')?chat:null;
};
const rule=(s:BotState,id:string)=>JSON.stringify(
 s.subscriptionRequirements.filter(x=>x.chatId===id));
/** Local manual catalog only, deliberately not Telegram-native buttons:
 * no announcement, no group edit, no competitions or anonymous prize score.
 * Student identity is stored for one-per-post dedupe until privacy cleanup.
 */
export class Phase4ReactionsService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private owner(s:BotState,actor:string,chatId:string):number|null{
  const c=group(s,this.policy,chatId);
  return c&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?c.version:null;
 }
 async draft(actor:string,chatId:string,input:{
  kind:'BOT_POST'|'COMMUNITY_QUESTION'|'STUDY_EXPERIENCE';
  messageId:number;description:string;durationMinutes:number;
 }):Promise<ReactionTarget>{
  const now=this.clock();
  if(!time(now)||!reactionGroup(chatId)||!validReactionInput(input))
   throw Error('REACTION_INVALID');
  return this.store.transaction(s=>{
   const version=this.owner(s,actor,chatId);
   if(version===null)throw Error('REACTION_DENIED');
   const d=state(s);
   if(d.targets.length>=200)throw Error('REACTION_CAPACITY');
   if(d.targets.some(x=>x.chatId===chatId&&x.messageId===input.messageId))
    throw Error('REACTION_DUPLICATE');
   const target:ReactionTarget={
    id:newId(d.targets),chatId,chatVersion:version,ownerId:actor,
    kind:input.kind,messageId:input.messageId,description:input.description,
    sourceVerified:false,status:'DRAFT',revision:1,createdAt:now,
    expiresAt:now+input.durationMinutes*60_000
   };
   d.targets.push(target);s.phase4Reactions=d;return structuredClone(target);
  });
 }
 async open(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.targets.filter(x=>x.id===id),target=rows[0];
   if(rows.length!==1||!target||target.status!=='DRAFT'||revision!==1||
    target.revision!==revision||target.ownerId!==actor||
    this.owner(s,actor,target.chatId)!==target.chatVersion||
    now<target.createdAt||now>=target.expiresAt)return false;
   target.status='OPEN';target.revision=2;target.openedAt=now;
   s.phase4Reactions=d;return true;
  });
 }
 /** Close is version-fenced and irreversible. Identities are scrubbed
  * 24h after closure, whether manual or deadline-driven. */
 async close(actor:string,id:string,revision:number):Promise<boolean>{
  const now=this.clock();if(!time(now))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.targets.filter(x=>x.id===id),target=rows[0];
   if(rows.length!==1||!target||!['DRAFT','OPEN'].includes(target.status)||
    target.revision!==revision||target.ownerId!==actor||
    this.owner(s,actor,target.chatId)!==target.chatVersion||
    now<target.createdAt)return false;
   target.status='CLOSED';target.revision++;target.closedAt=now;
   s.phase4Reactions=d;return true;
  });
 }
 async like(actor:string,id:string):Promise<{status:LikeStatus}>{
  const deny=(status:LikeStatus)=>({status});
  const start=this.clock();
  if(!time(start)||!reactionUser(actor)||!reactionId(id))return deny('INVALID');
  const initial=await this.store.snapshot(),d=state(initial),
   found=d.targets.filter(x=>x.id===id),target=found[0];
  if(found.length!==1||!target)return deny('NOT_FOUND');
  if(target.status!=='OPEN')return deny('CLOSED');
  if(start<target.createdAt||start>=target.expiresAt)return deny('EXPIRED');
  if(actor===target.ownerId)return deny('INVALID');
  if(group(initial,this.policy,target.chatId)?.version!==target.chatVersion)return deny('STALE');
  if(d.reactions.some(x=>x.targetId===id&&x.memberId===actor))
   return deny('ALREADY_REACTED');
  const fingerprint=rule(initial,target.chatId);
  let verified=false;
  try{verified=await this.verifyMember(target.chatId,actor)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!verified)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const data=state(s),rows=data.targets.filter(x=>x.id===id),live=rows[0],now=this.clock();
   if(rows.length!==1||!live||live.status!=='OPEN')return deny('CLOSED');
   if(now<start||now>=live.expiresAt)return deny('EXPIRED');
   if(live.revision!==target.revision||live.chatVersion!==target.chatVersion||
    group(s,this.policy,live.chatId)?.version!==live.chatVersion||
    rule(s,live.chatId)!==fingerprint)return deny('STALE');
   if(live.ownerId===actor)return deny('INVALID');
   if(data.reactions.some(x=>x.targetId===id&&x.memberId===actor))
    return deny('ALREADY_REACTED');
   // Discourage mass likes across many targets, even when all are distinct.
   if(data.reactions.filter(x=>x.memberId===actor&&
    x.createdAt>now-86_400_000).length>=12)return deny('RATE_LIMIT');
   if(data.reactions.length>=5000)return deny('CAPACITY');
   data.reactions.push({id:newId(data.reactions),targetId:id,memberId:actor,
    status:'ACTIVE',revision:1,createdAt:now});
   s.phase4Reactions=data;return deny('LIKED');
  });
 }
 /** Consent withdrawal never depends on continuing group membership or
  * a successful external verifier. Tombstone blocks repeated likes.
  */
 async unlike(actor:string,id:string):Promise<boolean>{
  const now=this.clock();if(!time(now)||!reactionUser(actor)||!reactionId(id))return false;
  return this.store.transaction(s=>{
   const d=state(s),rows=d.reactions.filter(x=>x.targetId===id&&x.memberId===actor),
    reaction=rows[0];
   if(rows.length!==1||!reaction||reaction.status!=='ACTIVE'||now<reaction.createdAt)
    return false;
   reaction.status='WITHDRAWN';reaction.revision=2;reaction.withdrawnAt=now;
   s.phase4Reactions=d;return true;
  });
 }
 async myReaction(actor:string,id:string):Promise<{status:'ACTIVE'|'WITHDRAWN'}|null>{
  if(!reactionUser(actor)||!reactionId(id))return null;
  const s=await this.store.snapshot();
  const rows=state(s).reactions.filter(x=>x.targetId===id&&x.memberId===actor);
  return rows.length===1?{status:rows[0]!.status}:null;
 }
 async memberInfo(actor:string,id:string):Promise<{
  kind:ReactionTarget['kind'];description:string;status:'OPEN'|'CLOSED';
 }|null>{
  if(!reactionUser(actor)||!reactionId(id))return null;
  const initial=await this.store.snapshot(),d=state(initial),
   found=d.targets.filter(x=>x.id===id),target=found[0];
  if(found.length!==1||!target||!['OPEN','CLOSED'].includes(target.status)||
   group(initial,this.policy,target.chatId)?.version!==target.chatVersion)return null;
  const fence=rule(initial,target.chatId);
  let proof=false;try{proof=await this.verifyMember(target.chatId,actor)==='VERIFIED';}
  catch{return null;}
  if(!proof)return null;
  const after=await this.store.snapshot(),rows=state(after).targets.filter(x=>x.id===id),live=rows[0];
  if(rows.length!==1||!live||!['OPEN','CLOSED'].includes(live.status)||
   live.chatVersion!==target.chatVersion||live.revision!==target.revision||
   group(after,this.policy,live.chatId)?.version!==live.chatVersion||
   rule(after,live.chatId)!==fence)return null;
  return {kind:live.kind,description:live.description,
   status:live.status==='OPEN'?'OPEN':'CLOSED'};
 }
 async ownerCount(actor:string,id:string):Promise<number|null>{
  const s=await this.store.snapshot(),d=state(s),
   rows=d.targets.filter(x=>x.id===id),target=rows[0];
  if(rows.length!==1||!target||target.ownerId!==actor||
   this.owner(s,actor,target.chatId)!==target.chatVersion)return null;
  return d.reactions.filter(x=>x.targetId===id&&x.status==='ACTIVE').length;
 }
 /** At least five distinct ACTIVE likes and a closed post required before
  * reporting even aggregates, to avoid tiny-group de-anonymization. */
 async results(actor:string,id:string):Promise<{likes:number}|null>{
  const s=await this.store.snapshot(),d=state(s),rows=d.targets.filter(x=>x.id===id),t=rows[0];
  if(rows.length!==1||!t||t.status!=='CLOSED'||t.ownerId!==actor||
   this.owner(s,actor,t.chatId)!==t.chatVersion)return null;
  const likes=d.reactions.filter(x=>x.targetId===id&&x.status==='ACTIVE').length;
  return likes>=5?{likes}:null;
 }
 async view(actor:string,id:string):Promise<ReactionTarget|null>{
  const s=await this.store.snapshot(),rows=state(s).targets.filter(x=>x.id===id),t=rows[0];
  return rows.length===1&&t&&t.ownerId===actor&&
   this.owner(s,actor,t.chatId)===t.chatVersion?structuredClone(t):null;
 }
 async list(actor:string):Promise<ReactionTarget[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor))
   throw Error('REACTION_DENIED');
  return state(s).targets.filter(x=>x.ownerId===actor&&
   this.owner(s,actor,x.chatId)===x.chatVersion)
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
   .slice(0,50).map(x=>structuredClone(x));
 }
 async expire():Promise<number>{
  const now=this.clock();if(!time(now))return 0;
  return this.store.transaction(s=>{
   const d=state(s);let closed=0;
   for(const t of d.targets){
    if(t.status==='DRAFT'&&now>=t.expiresAt){
     t.status='CLOSED';t.revision=2;t.closedAt=now;closed++;
    }else if(t.status==='OPEN'&&now>=t.expiresAt){
     t.status='CLOSED';t.revision=3;t.closedAt=now;closed++;
    }
   }
   const beforeReactions=d.reactions.length,beforeTargets=d.targets.length;
   d.reactions=d.reactions.filter(x=>{
    const t=d.targets.find(z=>z.id===x.targetId);
    return Boolean(t&&(t.closedAt===undefined||now<t.closedAt+86_400_000));
   });
   d.targets=d.targets.filter(x=>x.closedAt===undefined||
    now<x.closedAt+30*86_400_000);
   if(closed||beforeReactions!==d.reactions.length||beforeTargets!==d.targets.length)
    s.phase4Reactions=d;
   return closed;
  });
 }
}
