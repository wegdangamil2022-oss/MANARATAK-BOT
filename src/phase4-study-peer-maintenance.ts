import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4StudyPeersService} from './phase4-study-peers.js';

/** Independent 09:11 local-only study-circle retention worker.
 * Does not send Telegram messages or expose participant identities.
 */
export function startPhase4StudyPeerMaintenance(
 service:Pick<Phase4StudyPeersService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
