import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
/** Conservative source witness shared by preview and the configuration transaction. */
export const subscriptionConfigEpoch=(s:BotState):string=>createHash('sha256').update(JSON.stringify([s.chats,s.subscriptionRequirements,s.privateFeatures,s.privateSettingsRevision,...(s.audit.some(a=>a.updateKey.startsWith('subscription:enforcement:'))?[s.audit.filter(a=>a.updateKey.startsWith('subscription:enforcement:'))]:[]),...(s.audit.some(a=>a.updateKey.startsWith('subscription:leave-grace:'))?[s.audit.filter(a=>a.updateKey.startsWith('subscription:leave-grace:'))]:[])])).digest('hex');
