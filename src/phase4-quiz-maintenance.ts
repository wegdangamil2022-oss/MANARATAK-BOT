import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4QuizService} from './phase4-quizzes.js';

/** GAME-002 local-only maintenance. Closes expired windows and erases
 * account-linked answer records and questions after seven days.
 * Does not call Telegram, send winner announcements or change moderation.
 */
export function startPhase4QuizMaintenance(
 service:Pick<Phase4QuizService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
