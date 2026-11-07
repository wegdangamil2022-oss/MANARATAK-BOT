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
  categories,resources,faq,...(s.audit.some(a=>a.updateKey.startsWith('moderation:rules:published:'+groupId+':'))?[s.audit.filter(a=>a.updateKey.startsWith('moderation:rules:published:'+groupId+':'))]:[])]);
}
export function groupQuestionEpochDigest(state:BotState,groupId:string):string{
 return createHash('sha256').update('MANARATAK:B6:GROUP-FAQ:DISPATCH:v2:')
  .update(groupQuestionSubscriptionEpoch(state,groupId)).digest('hex');
}

/** The topic menu witness also binds all current topic-local approvals and
 * editorial versions for THIS group, so withdrawing an approved topic FAQ
 * or pausing its educational navigation invalidates a queued reply.
 * Never include an unrelated group's forum messages in this epoch.
 */
function groupForumEpochSource(state:BotState,groupId:string):string{
 const groupTag='"group":'+JSON.stringify(groupId);
 const registrationTag='"chat":'+JSON.stringify(groupId);
 const rows=state.audit.filter(a=>
  a.updateKey.startsWith('group:forum:')&&
  (a.reason.includes(groupTag)||a.reason.includes(registrationTag)));
 return JSON.stringify(rows);
}
export function groupMenuEpochDigest(state:BotState,groupId:string,topicId?:number):string{
 return createHash('sha256').update('MANARATAK:B6:GROUP-MENU:DISPATCH:v2:')
  .update(topicId===undefined?'':'TOPIC:'+topicId+':')
  .update(groupQuestionSubscriptionEpoch(state,groupId))
  .update(topicId===undefined?'':groupForumEpochSource(state,groupId)).digest('hex');
}

/** Scoped private DM browsing uses a separate change-detection domain. */
export function privateGroupEpochDigest(state:BotState,scope:string):string{
 return createHash('sha256').update('MANARATAK:B6:PRIVATE-GROUP:DISPATCH:v1:')
  .update(groupQuestionSubscriptionEpoch(state,scope)).digest('hex');
}
