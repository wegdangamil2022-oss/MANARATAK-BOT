import {tickProtectionNight} from './protection-night.js';
import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import {ModerationService} from './moderation.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';
import {GroupPermissionLockService} from './group-permission-lock.js';
import {telegramGroupPermissionGateway} from './telegram-group-permission-gateway.js';
import {moderationProtectionEnforcer} from './protection-enforcement.js';
import {tickGroupPermissionRestores} from './group-permission-timers.js';
import {tickModerationExpiry} from './moderation-expiry.js';

/** Construction is offline. A caller must explicitly select this composition;
 * no fake subscription gateway may share its sanction ledger. */
export async function createPhase3ModerationRuntime(store:BotStore,policy:Policy,token:string,request:typeof fetch=fetch,safetyGate:()=>Promise<boolean>=async()=>false,clock:()=>number=Date.now,automaticRestores=false){
 const state=await store.snapshot();
 // Old simulation receipts must never suppress a real dispatch or become a
 // restoration baseline. Refuse mixed ledgers without rewriting any data.
 if(state.moderationOperations.some(o=>o.status!=='CANCELLED'&&o.attemptGateway!=='TELEGRAM_API')||
  state.moderationReasons.some(r=>r.active&&!state.moderationOperations.some(o=>o.chatId===r.chatId&&o.memberId===r.memberId&&o.status==='CONFIRMED'&&o.attemptGateway==='TELEGRAM_API')))
  throw Error('PHASE3_UNPROVEN_MODERATION_HISTORY');
 const moderation=new ModerationService(store,policy,new TelegramBotApiModerationGateway(token,request,safetyGate,clock),clock);
 const groupPermissions=new GroupPermissionLockService(store,policy,telegramGroupPermissionGateway(token,request,safetyGate),clock);
 const protectionEnforcer=moderationProtectionEnforcer(moderation,automaticRestores?groupPermissions:undefined);
 return Object.freeze({moderation,groupPermissions,protectionEnforcer,
  async tick(enabled=false):Promise<void>{
   if(!enabled||!await safetyGate())return;
   const restored=await tickGroupPermissionRestores(store,groupPermissions,clock(),true);
   if(restored.status==='UNAVAILABLE'||restored.status==='INVALID')throw Error('PHASE3_TIMER_UNAVAILABLE');
   if(!await safetyGate())return;
   if(automaticRestores)await tickProtectionNight(store,policy,groupPermissions,clock,true);
   if(!await safetyGate())return;
   await tickModerationExpiry(store,policy,moderation,clock(),true);
  }
 });
}
