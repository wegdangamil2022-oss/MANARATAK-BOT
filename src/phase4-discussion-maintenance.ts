import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4DiscussionService} from './phase4-discussions.js';

/** A separate, immediate + periodic PRIVACY sweep.
 * Never publishes discussion content or interacts with Telegram. It removes
 * active-store question text after session expiry and later prunes tombstones.
 * Backups and already rendered private owner previews cannot be recalled.
 */
export function startPhase4DiscussionPrivacyMaintenance(
 service:Pick<Phase4DiscussionService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
