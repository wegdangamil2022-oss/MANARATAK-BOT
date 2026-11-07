import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4PollService} from './phase4-polls.js';

/** Phase 4 / 09:08 poll expiry and local voter-data retention.
 * Independent from Telegram posting and protected by a single-flight,
 * immediate + periodic scheduler, drained on shutdown.
 */
export function startPhase4PollPrivacyMaintenance(
 service:Pick<Phase4PollService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
