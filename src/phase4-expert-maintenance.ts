import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4ExpertService} from './phase4-experts.js';

/** Owner-reviewed AMA privacy lifecycle, independent of network sends.
 * Immediate + periodic serial cleanup on live server; stop drains work.
 */
export function startPhase4ExpertPrivacyMaintenance(
 service:Pick<Phase4ExpertService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
