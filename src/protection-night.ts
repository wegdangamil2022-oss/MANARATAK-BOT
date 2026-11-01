import {createHash} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {GroupPermissionLockService} from './group-permission-lock.js';
import type {ProtectionPolicy} from './protection-rules.js';

/** Fixed UTC offsets only. No unreviewed DST/calendar conversion. */
export function protectionNightWindow(night:NonNullable<ProtectionPolicy['night']>,now:number):{start:number;end:number}|null{
 if(![night.startMinute,night.endMinute,night.offsetMinutes].every(Number.isSafeInteger)||night.startMinute<0||night.startMinute>=1440||night.endMinute<0||night.endMinute>=1440||night.startMinute===night.endMinute||night.offsetMinutes< -720||night.offsetMinutes>840)return null;
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)return null;
 const shifted=now+night.offsetMinutes*60000,day=Math.floor(shifted/86400000)*86400000,minute=(shifted-day)/60000;
 let start=day+night.startMinute*60000,end=day+night.endMinute*60000;
 if(night.startMinute<night.endMinute){if(minute<night.startMinute||minute>=night.endMinute)return null;}
 else{if(minute>=night.startMinute)end+=86400000;else if(minute<night.endMinute)start-=86400000;else return null;}
 start-=night.offsetMinutes*60000;end-=night.offsetMinutes*60000;return {start,end};
}
/** One durable attempt per configured daily window; never retries an uncertain
 * or cancelled mutation. Existing restore ticks retain ownership of snapshots. */
export async function tickProtectionNight(store:BotStore,policy:Policy,locks:GroupPermissionLockService,clock:()=>number,enabled=false):Promise<{attempted:number;confirmed:number}>{
 const result={attempted:0,confirmed:0};if(!enabled)return result;
 const state=await store.snapshot(),now=clock();
 const eligible=(state.protectionPolicies??[]).filter(r=>r.policy.night?.enabled&&r.policy.mode==='ENFORCE');
 const offset=eligible.length>100?(Math.floor(now/15000)*100)%eligible.length:0;
 const batch=Array.from({length:Math.min(100,eligible.length)},(_,i)=>eligible[(offset+i)%eligible.length]!);
 for(const record of batch){
  const n=record.policy.night;if(!n?.enabled||record.policy.mode!=='ENFORCE')continue;
  const window=protectionNightWindow(n,now);if(!window||window.end-now<60000)continue;
  const key=createHash('sha256').update(JSON.stringify(['night',record.policy.chatId,record.policy.revision,record.chatPolicyVersion,window.start])).digest('hex');
  const current=(s:BotState)=>{
   const at=clock(),rows=(s.protectionPolicies??[]).filter(r=>r.policy.chatId===record.policy.chatId);
   return Number.isSafeInteger(at)&&at>=now&&at<now+5000&&at>=window.start&&at<window.end-30000&&rows.length===1&&JSON.stringify(rows[0])===JSON.stringify(record)&&record.updatedAt<=at&&
    policy.canUseChat(s,record.policy.chatId,'moderation')&&policy.chatRevision(s,record.policy.chatId)===record.chatPolicyVersion&&policy.has(s,record.updatedBy,'chat.manage',record.policy.chatId,at);
  };
  const job=await locks.preview(record.updatedBy,record.policy.chatId,'LOCK','MESSAGES',Math.floor((window.end-now)/1000),undefined,s=>current(s)&&!(s.groupPermissionJobs??[]).some(j=>(j.actorId===record.updatedBy||j.chatId===record.policy.chatId)&&j.status==='PREVIEW'),key,window.end);
  if(!job)continue;result.attempted++;if(await locks.confirm(record.updatedBy,job.id,current)==='CONFIRMED')result.confirmed++;
 }
 return result;
}
