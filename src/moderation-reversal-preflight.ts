import type {BotStore,BotState,RestrictionKind} from './store.js';
import type {Policy} from './policy.js';

/** Telegram getChatMember cannot identify WHO imposed a past restriction.
 * Thus even an exact observed match is NOT release permission.
 * This API never writes durable state and never performs Telegram mutations.
 */
export type RestrictionObservation=
 'BAN_PRESENT'|'MUTE_PRESENT'|'NO_RESTRICTION'|'PROTECTED'|'NO_RIGHTS'|'UNKNOWN';
export interface RestrictionObserver{
 observeRestriction(chatId:string,memberId:string):Promise<RestrictionObservation>;
}
export type ReversalPreflightResult=
 |{status:'DENIED'|'BLOCKED_UNKNOWN'|'BLOCKED_PENDING'|
  'BLOCKED_ACTIVE_REASON'|'BLOCKED_UNPROVEN'|'BLOCKED_STALE'|
  'BLOCKED_MISMATCH'|'BLOCKED_RIGHTS'|'BLOCKED_OBSERVATION_UNKNOWN'}
 |{status:'OBSERVED_NOT_ATTRIBUTABLE';kind:'BAN'|'MUTE'};

const validChat=(x:string)=>/^-[1-9][0-9]{0,15}$/u.test(x)&&
 Number.isSafeInteger(Number(x));
const validMember=(x:string)=>/^[1-9][0-9]{0,15}$/u.test(x)&&
 Number.isSafeInteger(Number(x));
/** Share the local-only risk classification with the owner's aggregate
 * status screen, so the UI can never classify a blocked case as promising.
 * MAY_INSPECT is NOT permission to unban, unmute or even contact Telegram.
 */
export type LocalReversalAssessment=
 |{status:'DENIED'|'BLOCKED_UNKNOWN'|'BLOCKED_PENDING'|
   'BLOCKED_ACTIVE_REASON'|'BLOCKED_UNPROVEN'|'BLOCKED_STALE'}
 |{status:'MAY_INSPECT';kind:'BAN'|'MUTE'};
export function inspectLocalReversal(s:BotState,policy:Policy,chat:string,
 member:string):LocalReversalAssessment{
 if(!validChat(chat)||!validMember(member)||member===policy.ownerId||
   !policy.canUseChat(s,chat,'moderation'))return {status:'DENIED'};
 const all=s.moderationOperations.filter(o=>o.chatId===chat&&o.memberId===member);
 if(all.some(o=>o.status==='UNKNOWN_OUTCOME'))return {status:'BLOCKED_UNKNOWN'};
 if(all.some(o=>o.status==='INTENT'||o.status==='STARTED'))
  return {status:'BLOCKED_PENDING'};
 if(s.moderationReasons.some(r=>r.chatId===chat&&r.memberId===member&&r.active))
  return {status:'BLOCKED_ACTIVE_REASON'};
 const last=all.at(-1);
 if(!last||last.status!=='CONFIRMED'||(last.kind!=='BAN'&&last.kind!=='MUTE'))
  return {status:'BLOCKED_UNPROVEN'};
 if(last.policyVersion!==policy.chatRevision(s,chat))return {status:'BLOCKED_STALE'};
 // Local fake successes and legacy/unidentified gateways are never
 // treated as observations of a possible real Telegram restriction.
 if(last.attemptGateway!=='TELEGRAM_API')return {status:'BLOCKED_UNPROVEN'};
 return {status:'MAY_INSPECT',kind:last.kind};
}
const localEpoch=(s:BotState,chat:string,member:string)=>JSON.stringify([
 s.chats.filter(c=>c.id===chat),
 s.moderationReasons.filter(r=>r.chatId===chat&&r.memberId===member),
 s.moderationOperations.filter(o=>o.chatId===chat&&o.memberId===member)
]);
/** There is deliberately no positive 'SAFE_TO_RELEASE' state. A live member
 * status and our local confirmed write cannot establish exclusive authorship
 * or prove no administrator has since imposed an independent restriction.
 */
export class ModerationReversalPreflight {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly observer:RestrictionObserver){}
 async assess(actor:string,chat:string,member:string):Promise<ReversalPreflightResult>{
  if(!this.policy.isOwner(actor)||!validChat(chat)||!validMember(member)||
   member===actor||member===this.policy.ownerId)
   return {status:'DENIED'};
  const before=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.canUseChat(before,chat,'moderation'))
   return {status:'DENIED'};
  const local=inspectLocalReversal(before,this.policy,chat,member);
  if(local.status!=='MAY_INSPECT')return local;
  const expected=local.kind;
  const epoch=localEpoch(before,chat,member);
  let remote:RestrictionObservation;
  try{remote=await this.observer.observeRestriction(chat,member);}
  catch{remote='UNKNOWN';}
  const after=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||!this.policy.canUseChat(after,chat,'moderation')||
   epoch!==localEpoch(after,chat,member))
   return {status:'BLOCKED_STALE'};
  if(remote==='NO_RIGHTS')return {status:'BLOCKED_RIGHTS'};
  if(remote==='UNKNOWN')return {status:'BLOCKED_OBSERVATION_UNKNOWN'};
  if(remote!==(expected==='BAN'?'BAN_PRESENT':'MUTE_PRESENT'))
   return {status:'BLOCKED_MISMATCH'};
  return {status:'OBSERVED_NOT_ATTRIBUTABLE',kind:expected};
 }
}
