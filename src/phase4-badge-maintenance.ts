import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4BadgesService} from './phase4-badges.js';

/** Phase 4 / 09:12: local-only badge retention, no Telegram delivery.
 * Immediate first sweep; one at a time; shutdown waits for pending work. */
export function startPhase4BadgeMaintenance(
 service:Pick<Phase4BadgesService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
