import {createHash} from 'node:crypto';
import type {BotState} from './store.js';
import {subscriptionRequirementMode} from './subscription-integrity.js';

/** Captures the exact local approval/rule epoch before a read-only FAQ or group menu await.
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
 // Content is authorization state too. Previously a group FAQ or resources
 // list could outlive owner withdrawal of its published source while queued.
 // Scope strictly to this group so private/other-group updates cannot revoke
 // unrelated group sends. Include full reviewed snapshots so text edits and
 // approval/visibility changes both invalidate stale outbox plans.
 const byId=<T extends {id:string}>(a:T,b:T):number=>
  a.id<b.id?-1:a.id>b.id?1:0;
 const categories=s.educationCategories.filter(c=>c.scope===groupId).sort(byId);
 const resources=s.educationResources.filter(r=>r.scope===groupId).sort(byId);
 const faq=s.faqEntries.filter(q=>q.scope===groupId).sort(byId);
 return JSON.stringify([subscriptionRequirementMode(s,groupId),rules,approvals,
  categories,resources,faq]);
}
export function groupQuestionEpochDigest(state:BotState,groupId:string):string{
 return createHash('sha256').update('MANARATAK:B6:GROUP-FAQ:DISPATCH:v2:')
  .update(groupQuestionSubscriptionEpoch(state,groupId)).digest('hex');
}

export function groupMenuEpochDigest(state:BotState,groupId:string):string{
 return createHash('sha256').update('MANARATAK:B6:GROUP-MENU:DISPATCH:v2:')
  .update(groupQuestionSubscriptionEpoch(state,groupId)).digest('hex');
}

/** Scoped private DM browsing uses a separate change-detection domain. */
export function privateGroupEpochDigest(state:BotState,scope:string):string{
 return createHash('sha256').update('MANARATAK:B6:PRIVATE-GROUP:DISPATCH:v1:')
  .update(groupQuestionSubscriptionEpoch(state,scope)).digest('hex');
}
