import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4ReactionsService} from './phase4-reactions.js';

/** Immediate and periodic privacy cleanup of local 09:13 likes.
 * No Telegram dispatch and no inference of actual message reactions.
 */
export function startPhase4ReactionMaintenance(
 service:Pick<Phase4ReactionsService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
