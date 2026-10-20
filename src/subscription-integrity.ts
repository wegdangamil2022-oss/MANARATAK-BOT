import {BotStore,type BotState} from './store.js';

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
  if(channels.length===0){inactiveRules++;continue;}
  activeRules++;
  const shapeInvalid=
   typeof rule.chatId!=='string'||!canonicalId.test(rule.chatId)||
   !['ALL','ANY'].includes(rule.mode)||!Number.isSafeInteger(rule.version)||rule.version<1||
   seenGroups.has(rule.chatId);
  if(shapeInvalid)invalidRules++;
  seenGroups.add(rule.chatId);
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
