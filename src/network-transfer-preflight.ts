import {createHash} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {NetworkSanctionReview} from './network-sanction-review-model.js';
import {networkSanctionReviewAccessible} from './network-sanction-review.js';
import {moderationLedgerSafeForDispatch} from './moderation-review-integrity.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

/** Local state classification, NOT authorization to contact or mutate Telegram.
 * No status here authorizes a live restriction, even after remote observations. */
export type NetworkTransferLocalBlock='REVIEW_NOT_CURRENT'|'PROTECTED_LOCAL'|
 'UNRESOLVED_LOCAL'|'ACTIVE_LOCAL_REASON'|'LOCAL_LEDGER_UNSAFE';
export type NetworkTransferLocalResult=
 {status:'BLOCKED';reason:NetworkTransferLocalBlock}|
 {status:'MAY_OBSERVE';review:NetworkSanctionReview};
const clockValid=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-600_000;
export function inspectNetworkTransferLocal(
 s:BotState,policy:Policy,actor:string,now:number,reviewId:string
):NetworkTransferLocalResult{
 if(!clockValid(now))return {status:'BLOCKED',reason:'REVIEW_NOT_CURRENT'};
 const row=networkSanctionReviewAccessible(s,policy,actor,now,reviewId);
 if(!row||row.status!=='REVIEWED_ONLY'||row.reviewedAt===undefined||
  row.reviewedAt>now)return {status:'BLOCKED',reason:'REVIEW_NOT_CURRENT'};
 // The owner and locally delegated moderators are protected even when a
 // remote Telegram snapshot transiently labels them ordinary members.
 if(row.subjectId===actor||row.subjectId===policy.ownerId||
  policy.has(s,row.subjectId,'chat.manage',row.targetChatId,now))
  return {status:'BLOCKED',reason:'PROTECTED_LOCAL'};
 // Unknown/pending attempts cannot be overwritten or used as evidence to
 // copy a sanction. Reject any conflicting local history at this target.
 if(s.moderationOperations.some(x=>x.chatId===row.targetChatId&&
  x.memberId===row.subjectId&&
  (x.status==='UNKNOWN_OUTCOME'||x.status==='INTENT'||x.status==='STARTED')))
  return {status:'BLOCKED',reason:'UNRESOLVED_LOCAL'};
 if(!moderationLedgerSafeForDispatch(s,now))
  return {status:'BLOCKED',reason:'LOCAL_LEDGER_UNSAFE'};
 if(s.moderationReasons.some(x=>x.chatId===row.targetChatId&&
  x.memberId===row.subjectId&&x.active))
  return {status:'BLOCKED',reason:'ACTIVE_LOCAL_REASON'};
 return {status:'MAY_OBSERVE',review:row};
}
/** Only local authorization-bearing state is part of the witness. The digest
 * is never persisted, a Telegram permission, nor an authorization token.
 * Restored mutated grants, network versions or sanctions force a new review. */
function localEpoch(s:BotState):string{
 return createHash('sha256').update(JSON.stringify([
  s.chats,s.grants,s.groupNetworks??[],s.networkWatchCases??[],
  s.networkSanctionReviews??[],s.moderationOperations,s.moderationReasons,
  s.privateFeatures,s.privateSettingsRevision??0
 ])).digest('hex');
}
export type NetworkTransferObservation=
 |{status:'BLOCKED';reason:NetworkTransferLocalBlock|
   'UNTRUSTED_OBSERVER'|'TELEGRAM_NOT_GROUP'|'SOURCE_NOT_VERIFIED'|
   'REMOTE_NOT_SAFE'|'LOCAL_CHANGED'|'REMOTE_CHANGED'}
 |{status:'OBSERVED_ONLY';reason:'SOURCE_RESTRICTION_AND_TARGET_MEMBER_OBSERVED'};
/** Read-only Telegram probe for ONE reviewed case and ONE destination.
 * It is deliberately NOT wired to Telegram moderation dispatch and never
 * calls setRestriction, banChatMember, restrictChatMember or stores a grant.
 * Both remote observations and local authorization are re-checked after
 * awaited I/O, preventing a stale snapshot from looking current.
 *
 * The official adapter's read-only credentials are necessary but never
 * sufficient to authorize a real action. OBSERVED_ONLY is advisory ONLY. */
export class NetworkTransferReadOnlyPreflight{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:Pick<TelegramBotApiModerationGateway,
   'inspectTrialGroupKind'|'observeRestriction'>,
  private readonly clock:()=>number=Date.now){}
 async assess(actor:string,reviewId:string):Promise<NetworkTransferObservation>{
  const initial=await this.store.snapshot();
  const local=inspectNetworkTransferLocal(initial,this.policy,actor,this.clock(),reviewId);
  if(local.status==='BLOCKED')return local;
  const epoch=localEpoch(initial),review=local.review;
  const authentic=()=>TelegramBotApiModerationGateway.usesOfficialNetworkReviewRead(this.gateway);
  if(!authentic())return {status:'BLOCKED',reason:'UNTRUSTED_OBSERVER'};
  const recheck=async():Promise<NetworkTransferObservation|null>=>{
   const s=await this.store.snapshot();
   const current=inspectNetworkTransferLocal(s,this.policy,actor,this.clock(),reviewId);
   if(localEpoch(s)!==epoch||current.status!=='MAY_OBSERVE'||
    current.review.id!==review.id||current.review.revision!==review.revision)
    return {status:'BLOCKED',reason:'LOCAL_CHANGED'};
   if(!authentic())return {status:'BLOCKED',reason:'UNTRUSTED_OBSERVER'};
   return null;
  };
  const group=async(chatId:string):Promise<'GROUP'|'SUPERGROUP'|'NOT_GROUP'|'UNKNOWN'>=>{
   try{return await this.gateway.inspectTrialGroupKind(chatId);}
   catch{return 'UNKNOWN';}
  };
  const observe=async(chatId:string):Promise<string>=>{
   try{return await this.gateway.observeRestriction(chatId,review.subjectId);}
   catch{return 'UNKNOWN';}
  };
  const isGroup=(kind:string)=>kind==='GROUP'||kind==='SUPERGROUP';
  const expectedSource=review.kind==='BAN'?'BAN_PRESENT':'MUTE_PRESENT';
  // An owner's proposed transfer is NOT evidence of a restriction existing
  // at its origin. Observe source separately, rejecting a missing/mismatched
  // restriction before even observing a destination member.
  const firstSourceGroup=await group(review.sourceChatId);
  {const denied=await recheck();if(denied)return denied;}
  if(!isGroup(firstSourceGroup))return {status:'BLOCKED',reason:'TELEGRAM_NOT_GROUP'};
  const firstSource=await observe(review.sourceChatId);
  {const denied=await recheck();if(denied)return denied;}
  if(firstSource!==expectedSource)
   return {status:'BLOCKED',reason:'SOURCE_NOT_VERIFIED'};
  const firstTargetGroup=await group(review.targetChatId);
  {const denied=await recheck();if(denied)return denied;}
  if(!isGroup(firstTargetGroup))return {status:'BLOCKED',reason:'TELEGRAM_NOT_GROUP'};
  const firstTarget=await observe(review.targetChatId);
  {const denied=await recheck();if(denied)return denied;}
  if(firstTarget!=='NO_RESTRICTION')
   return {status:'BLOCKED',reason:'REMOTE_NOT_SAFE'};
  // Double observations guard transient rights/target drift. Even a matching
  // result can never identify the original sanctioning administrator.
  const secondSourceGroup=await group(review.sourceChatId);
  {const denied=await recheck();if(denied)return denied;}
  if(firstSourceGroup!==secondSourceGroup)return {status:'BLOCKED',reason:'REMOTE_CHANGED'};
  const secondSource=await observe(review.sourceChatId);
  {const denied=await recheck();if(denied)return denied;}
  if(secondSource!==firstSource)return {status:'BLOCKED',reason:'REMOTE_CHANGED'};
  const secondTargetGroup=await group(review.targetChatId);
  {const denied=await recheck();if(denied)return denied;}
  if(firstTargetGroup!==secondTargetGroup)return {status:'BLOCKED',reason:'REMOTE_CHANGED'};
  const secondTarget=await observe(review.targetChatId);
  {const denied=await recheck();if(denied)return denied;}
  if(secondTarget!==firstTarget)return {status:'BLOCKED',reason:'REMOTE_CHANGED'};
  return {status:'OBSERVED_ONLY',reason:'SOURCE_RESTRICTION_AND_TARGET_MEMBER_OBSERVED'};
 }
}
