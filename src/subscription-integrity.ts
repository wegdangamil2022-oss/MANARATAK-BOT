import {BotStore,type BotState,type SubscriptionRequirement} from './store.js';

/** Aggregate-only operator record. Intentionally contains no chat ID, channel
 * ID, student identity, username, message text, SQLite path or API credential.
 */
export interface SubscriptionIntegrityReport{
 stage:'OFFLINE_ONLY';status:'PASS'|'BLOCKED';
 rules:number;activeRules:number;inactiveRules:number;
 invalidRules:number;invalidGroups:number;invalidChannels:number;
 duplicateChannels:number;overLimitRules:number;
 reasons:('INVALID_RULE_SHAPE'|'GROUP_NOT_VERIFIABLE'|'CHANNEL_NOT_VERIFIABLE'|
  'DUPLICATE_REQUIRED_CHANNELS'|'TOO_MANY_REQUIRED_CHANNELS')[];
}
const canonicalId=/^-[1-9][0-9]{0,18}$/u;
/** Shared runtime + offline structural invariant. A paused zero-channel rule
 * is valid only when its ID, mode and revision are still well formed.
 * This is NOT external Telegram approval (checked separately).
 */
export function isCanonicalSubscriptionRule(value:unknown):value is SubscriptionRequirement{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const r=value as Partial<SubscriptionRequirement>;
 if(typeof r.chatId!=='string'||!canonicalId.test(r.chatId)||
   (r.mode!=='ALL'&&r.mode!=='ANY')||
   !Number.isSafeInteger(r.version)||r.version===undefined||r.version<1||
   !Array.isArray(r.channelIds)||r.channelIds.length>10)return false;
 if(r.channelIds.some(id=>typeof id!=='string'||!canonicalId.test(id)))return false;
 return new Set(r.channelIds).size===r.channelIds.length;
}
/** One canonical policy per group. A malformed or duplicated saved rule
 * is never equivalent to an explicitly owner-paused requirement. This helper
 * makes link, group-message and private-group browsing gates agree.
 */
export function subscriptionRequirementMode(state:BotState,chatId:string):
 'NONE'|'PAUSED'|'ACTIVE'|'INVALID'{
 const matches=state.subscriptionRequirements.filter(r=>r?.chatId===chatId);
 if(matches.length===0)return 'NONE';
 if(matches.length!==1||!isCanonicalSubscriptionRule(matches[0]))return 'INVALID';
 return matches[0].channelIds.length?'ACTIVE':'PAUSED';
}
/** NOT_REQUIRED may be an explicit owner exception, but must never prove
 * student membership while the owner has configured required channels.
 */
export function acceptsActiveSubscriptionEvidence(
 status:'MEMBER'|'NOT_REQUIRED'|'NOT_MEMBER'|'UNAVAILABLE'|'DENIED',
 isOwner:boolean):boolean{
 return status==='MEMBER'||(status==='NOT_REQUIRED'&&isOwner);
}
/** No network. This is not proof that Telegram still considers the bot an
 * administrator: the result verifies ONLY local authorization invariants.
 */
export function summarizeSubscriptionIntegrity(state:BotState):SubscriptionIntegrityReport{
 let activeRules=0,inactiveRules=0,invalidRules=0,invalidGroups=0,
  invalidChannels=0,duplicateChannels=0,overLimitRules=0;
 const seenGroups=new Set<string>();
 for(const rule of state.subscriptionRequirements){
  // Treat unexpected malformed legacy rule properties as blocked, never as
  // missing subscription success (state snapshots are untrusted for rollout).
  if(!rule||typeof rule!=='object'||!Array.isArray(rule.channelIds)){
   invalidRules++;continue;
  }
  const channels=rule.channelIds;
  // Structural corruption and duplicate rule identities are unsafe even if
  // a rule currently has no active channels; a future edit must not silently
  // revive malformed policies.
  if(!isCanonicalSubscriptionRule(rule)||seenGroups.has(rule.chatId))invalidRules++;
  if(typeof rule.chatId==='string')seenGroups.add(rule.chatId);
  if(channels.length===0){inactiveRules++;continue;}
  activeRules++;
  const group=state.chats.find(c=>c.id===rule.chatId);
  if(!group?.approved||!group.scopes.includes('verification'))invalidGroups++;
  if(channels.length>10)overLimitRules++;
  const visited=new Set<string>();
  for(const channel of channels){
   if(visited.has(channel))duplicateChannels++;
   visited.add(channel);
   const source=state.chats.find(c=>c.id===channel);
   if(typeof channel!=='string'||!canonicalId.test(channel)||
     !source?.approved||!source.scopes.includes('verification'))invalidChannels++;
  }
 }
 const reasons:SubscriptionIntegrityReport['reasons']=[];
 if(invalidRules)reasons.push('INVALID_RULE_SHAPE');
 if(invalidGroups)reasons.push('GROUP_NOT_VERIFIABLE');
 if(invalidChannels)reasons.push('CHANNEL_NOT_VERIFIABLE');
 if(duplicateChannels)reasons.push('DUPLICATE_REQUIRED_CHANNELS');
 if(overLimitRules)reasons.push('TOO_MANY_REQUIRED_CHANNELS');
 return {
  stage:'OFFLINE_ONLY',status:reasons.length?'BLOCKED':'PASS',
  rules:state.subscriptionRequirements.length,
  activeRules,inactiveRules,invalidRules,invalidGroups,
  invalidChannels,duplicateChannels,overLimitRules,reasons
 };
}
/** Existing strict SQLite read-only snapshot verifies absolute private path,
 * SQLite validity and symlink/file permissions before reading any state.
 */
export async function inspectSubscriptionIntegrityReadOnly(stateFile:string):
 Promise<SubscriptionIntegrityReport>{
 const state=await BotStore.snapshotSqliteReadOnly(stateFile);
 return summarizeSubscriptionIntegrity(state);
}
