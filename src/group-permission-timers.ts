import type {BotStore} from './store.js';
import type {GroupPermissionLockService} from './group-permission-lock.js';

/** Explicit local scheduler entry point. No startup registration or retry.
 * A confirmed timed lock authorizes only its exact original snapshot. */
export async function tickGroupPermissionRestores(store:BotStore,service:GroupPermissionLockService,now:number,enabled=false,limit=10):Promise<{status:'DISABLED'|'INVALID'|'CHECKED'|'UNAVAILABLE';attempted:number;confirmed:number;unknown:number}>{
 const result={attempted:0,confirmed:0,unknown:0};
 if(!enabled)return {status:'DISABLED',...result};
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000||!Number.isSafeInteger(limit)||limit<1||limit>50)return {status:'INVALID',...result};
 try{
  const s=await store.snapshot(),jobs=s.groupPermissionJobs??[];
  const candidates=jobs.filter(j=>j.kind==='LOCK'&&j.status==='CONFIRMED'&&j.restoreAt!==undefined&&j.restoreAt<=now&&!jobs.some(r=>r.restores===j.id)).sort((a,b)=>a.restoreAt!-b.restoreAt!).slice(0,limit);
  for(const lock of candidates){
   const preview=await service.preview(lock.actorId,lock.chatId,'RESTORE','MESSAGES',undefined,lock.id);
   if(!preview||preview.restores!==lock.id)continue;
   result.attempted++;const outcome=await service.confirm(lock.actorId,preview.id);
   if(outcome==='CONFIRMED')result.confirmed++;
   if(outcome==='UNKNOWN_OUTCOME')result.unknown++;
  }
  return {status:'CHECKED',...result};
 }catch{return {status:'UNAVAILABLE',...result};}
}
