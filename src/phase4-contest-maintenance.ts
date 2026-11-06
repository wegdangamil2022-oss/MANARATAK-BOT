import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4ContestService} from './phase4-contests.js';

/** 08:02: local autonomous privacy maintenance.
 * Expires unattended registrations and running contests, then erases opt-in
 * participant identifiers seven days after closure/cancellation.
 * No Telegram calls, winner announcements or group moderation changes.
 */
export function startPhase4ContestMaintenance(
 service:Pick<Phase4ContestService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
