import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {ModerationService} from './moderation.js';
/** Explicitly invoked local tick. Never arms a Telegram gateway or retries
 * an ambiguous attempt. Live runtime wiring waits for safe restoration. */
export async function tickModerationExpiry(store:BotStore,policy:Policy,service:ModerationService,now:number,enabled=false,limit=20):Promise<{status:'DISABLED'|'PROCESSED';processed:number;unresolved:number}>{
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_MODERATION_EXPIRY_TICK');
 if(!enabled)return {status:'DISABLED',processed:0,unresolved:0};
 const state=await store.snapshot(),seen=new Set<string>(),targets:{chat:string;member:string}[]=[];
 for(const r of state.moderationReasons){if(!r.active||r.source!=='MANUAL'||r.expiresAt===undefined||r.expiresAt>now||!policy.canUseChat(state,r.chatId,'moderation'))continue;const key=JSON.stringify([r.chatId,r.memberId]);if(!seen.has(key)){seen.add(key);targets.push({chat:r.chatId,member:r.memberId});if(targets.length===limit)break;}}
 let processed=0,unresolved=0;for(const t of targets){const result=await service.expireManualReasons(policy.ownerId,t.chat,t.member);processed++;if(!['APPLIED','NO_CHANGE'].includes(result.status))unresolved++;}
 return {status:'PROCESSED',processed,unresolved};
}
