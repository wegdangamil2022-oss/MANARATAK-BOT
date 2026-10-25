import type {BotState,ModerationOperation} from './store.js';

/** Conservative, unconditional offline/online sanction rate fuse.
 *
 * Limits apply to *new* BAN/MUTE dispatch attempts. No separate counters,
 * timers, TTL resets or external locks: immutable intent/attempt records in the
 * shared durable ModerationOperation ledger are the reservation authority.
 * The store transaction serializes the check AND new INTENT creation.
 *
 * This never unlocks or retries UNKNOWN_OUTCOME and never overrides owner/
 * moderator ACLs or remote Bot API checks. Operator review is required to
 * change these conservative baseline ceilings.
 */
export const MODERATION_RATE_LIMITS={
 actorChatTenMinutes:5,
 groupTenMinutes:12,
 actorAllChatsDay:30,
 tenMinutesMs:600_000,
 dayMs:86_400_000
} as const;

export type ModerationRateBlock=
 'INVALID_CLOCK'|'ACTOR_CHAT_TEN_MINUTES'|'GROUP_TEN_MINUTES'|'ACTOR_ALL_CHATS_DAY';
export const moderationRateDenial=(code:ModerationRateBlock):string=>
 code==='ACTOR_CHAT_TEN_MINUTES'?'MODERATION_RATE_LIMIT_ACTOR_CHAT':
 code==='GROUP_TEN_MINUTES'?'MODERATION_RATE_LIMIT_GROUP':
 code==='ACTOR_ALL_CHATS_DAY'?'MODERATION_RATE_LIMIT_ACTOR_DAY':
 'MODERATION_RATE_LIMIT_INVALID_CLOCK';

const sanction=(o:ModerationOperation):boolean=>
 (o.kind==='BAN'||o.kind==='MUTE')&&o.status!=='CANCELLED';

/** Pure projection; no private identities, personal data or raw evidence
 * should be included in UI logs. The caller must not treat null as permission:
 * full actor/policy/target checks still apply separately.
 */
export function moderationRateFuse(state:Pick<BotState,'moderationOperations'>,
 actorId:string,chatId:string,now:number):ModerationRateBlock|null{
 if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)
  return 'INVALID_CLOCK';
 let actorChat=0,group=0,actorDay=0;
 for(const op of state.moderationOperations){
  if(!sanction(op))continue;
  // A future record (clock skew) conservatively consumes the budget.
  if(op.actorId===actorId&&op.createdAt>now-MODERATION_RATE_LIMITS.dayMs)
   actorDay++;
  if(op.createdAt>now-MODERATION_RATE_LIMITS.tenMinutesMs){
   if(op.chatId===chatId)group++;
   if(op.chatId===chatId&&op.actorId===actorId)actorChat++;
  }
 }
 if(actorChat>=MODERATION_RATE_LIMITS.actorChatTenMinutes)
  return 'ACTOR_CHAT_TEN_MINUTES';
 if(group>=MODERATION_RATE_LIMITS.groupTenMinutes)
  return 'GROUP_TEN_MINUTES';
 if(actorDay>=MODERATION_RATE_LIMITS.actorAllChatsDay)
  return 'ACTOR_ALL_CHATS_DAY';
 return null;
}
