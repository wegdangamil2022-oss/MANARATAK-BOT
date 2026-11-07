import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4EventService} from './phase4-events.js';

/** 09:09 local-only retention tick for ended meetings.
 * This starts immediately and runs periodically, without any Telegram
 * message or assumed attendance evidence. Stop drains active work.
 */
export function startPhase4EventPrivacyMaintenance(
 service:Pick<Phase4EventService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
