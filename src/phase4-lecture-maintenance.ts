import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4LectureService} from './phase4-lectures.js';

/** Independent local expiry; pending and active sessions are ended even
 * if the owner never opens the menu. No Telegram sends or policy rewrites.
 */
export function startPhase4LectureMaintenance(
 service:Pick<Phase4LectureService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
