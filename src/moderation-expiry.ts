import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {ModerationService} from './moderation.js';
import {createHash} from 'node:crypto';
/** Explicitly invoked local tick. Never arms a Telegram gateway or retries
 * an ambiguous attempt. Live runtime wiring waits for safe restoration. */
export async function tickModerationExpiry(store:BotStore,policy:Policy,service:ModerationService,now:number,enabled=false,limit=20):Promise<{status:'DISABLED'|'PROCESSED';processed:number;unresolved:number}>{
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_MODERATION_EXPIRY_TICK');
 if(!enabled)return {status:'DISABLED',processed:0,unresolved:0};
 const state=await store.snapshot(),seen=new Set<string>(),all:{chat:string;member:string;key:string}[]=[],cursorRows=state.audit.filter(a=>a.updateKey==='moderation-expiry:cursor'),cursor=cursorRows[0];
 if(cursorRows.length>1||cursor&&(!/^MODERATION_EXPIRY_CURSOR:[a-f0-9]{64}$/u.test(cursor.reason)||cursor.actorId!==policy.ownerId||cursor.decision!=='NOOP'||!Number.isSafeInteger(cursor.at)||cursor.at<0||cursor.at>now))throw Error('INVALID_MODERATION_EXPIRY_CURSOR');
 for(const r of state.moderationReasons){if(!r.active||r.source!=='MANUAL'||r.expiresAt===undefined||r.expiresAt>now||!policy.canUseChat(state,r.chatId,'moderation'))continue;const key=createHash('sha256').update(JSON.stringify([r.chatId,r.memberId])).digest('hex');if(!seen.has(key)){seen.add(key);all.push({chat:r.chatId,member:r.memberId,key});}}
 all.sort((a,b)=>a.key.localeCompare(b.key));const after=cursor?.reason.slice('MODERATION_EXPIRY_CURSOR:'.length),found=after?all.findIndex(t=>t.key>after):0,start=found<0?0:found,targets=[...all.slice(start),...all.slice(0,start)].slice(0,limit);
 let processed=0,unresolved=0;for(const t of targets){const result=await service.expireManualReasons(policy.ownerId,t.chat,t.member);processed++;if(!['APPLIED','NO_CHANGE'].includes(result.status))unresolved++;}
 if(targets.length)await store.transaction(s=>{const rows=s.audit.filter(a=>a.updateKey==='moderation-expiry:cursor');if(JSON.stringify(rows)!==JSON.stringify(cursorRows))return;const record={updateKey:'moderation-expiry:cursor',actorId:policy.ownerId,decision:'NOOP' as const,reason:'MODERATION_EXPIRY_CURSOR:'+targets.at(-1)!.key,policyVersion:0,at:now};if(rows[0])Object.assign(rows[0],record);else s.audit.push(record);});
 return {status:'PROCESSED',processed,unresolved};
}
