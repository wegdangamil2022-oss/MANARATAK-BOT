import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
/** Conservative source witness shared by preview and the configuration transaction. */
export const subscriptionConfigEpoch=(s:BotState):string=>createHash('sha256').update(JSON.stringify([s.chats,s.subscriptionRequirements,s.privateFeatures,s.privateSettingsRevision])).digest('hex');
