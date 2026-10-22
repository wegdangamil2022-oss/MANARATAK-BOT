import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import {subscriptionRequirementMode} from './subscription-integrity.js';

/** Captures the exact local approval/rule epoch before a read-only FAQ await.
 * A SHA-256 digest is persisted briefly instead of chat/channel configuration.
 * It is a change detector, NOT authentication or an anonymous user identity.
 */
export function groupQuestionSubscriptionEpoch(s:BotState,groupId:string):string {
 const rules=s.subscriptionRequirements.filter(r=>r?.chatId===groupId);
 const ids=new Set<string>([groupId]);
 for(const rule of rules)
  if(Array.isArray(rule?.channelIds))
   for(const id of rule.channelIds)
    if(typeof id==='string')ids.add(id);
 const approvals=[...ids].sort().map(id=>
  [id,s.chats.filter(c=>c?.id===id).map(c=>
   [c.approved,c.present,c.version,c.scopes,c.groupAI])]);
 return JSON.stringify([subscriptionRequirementMode(s,groupId),rules,approvals]);
}
export function groupQuestionEpochDigest(state:BotState,groupId:string):string{
 return createHash('sha256').update('MANARATAK:B6:GROUP-FAQ:DISPATCH:v1\\0')
  .update(groupQuestionSubscriptionEpoch(state,groupId)).digest('hex');
}
