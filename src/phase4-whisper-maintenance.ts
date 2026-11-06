import {startProtectionMaintenance} from './protection-maintenance.js';
import type {Phase4WhisperService} from './phase4-whispers.js';

/** Privacy cleanup is independent of Telegram outbound delivery and of
 * protection/service-message maintenance. The first tick runs immediately
 * and later ticks are serialized; stopping drains the in-flight sweep.
 *
 * This removes expired PRIVATE content from the active store, not copies
 * already shown in previews or external backups. It makes no Telegram calls.
 */
export function startPhase4WhisperPrivacyMaintenance(
 service:Pick<Phase4WhisperService,'expire'>,
 schedule?:(tick:()=>void)=>()=>void,
 onFailure?:()=>void
):{stop:()=>Promise<void>}{
 return startProtectionMaintenance(async()=>{await service.expire();},schedule,onFailure);
}
