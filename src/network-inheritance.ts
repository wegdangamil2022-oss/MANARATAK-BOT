import {createHash,randomBytes} from 'node:crypto';
import type {BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {GroupNetwork} from './group-network-model.js';
import {validCommunityConfig,defaultCommunityConfig,
 type CommunityConfig} from './phase4-community-model.js';
import {isValidProtectionPolicy,isValidGroupProtectionRecord,
 type ProtectionPolicy,type GroupProtectionRecord} from './protection-rules.js';
import {validNetworkInheritanceLink, type NetworkInheritanceKind,
 type NetworkInheritanceLink,type NetworkInheritancePauseReason} from './network-inheritance-model.js';

/** An irreversible optimistic checksum. It is never an authorization token.
 * Including ALL target fields prevents local edits to excluded/operational fields
 * from being overwritten even if they bypass the usual editor. */
export function networkInheritanceDigest(payload:ProtectionPolicy|CommunityConfig):string{
 return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
const validClock=(now:number)=>Number.isSafeInteger(now)&&now>=0&&
 now<=8_640_000_000_000_000;
const scope=(kind:NetworkInheritanceKind):'moderation'|'navigation'=>
 kind==='POLICY'?'moderation':'navigation';
function currentGroup(s:BotState,policy:Policy,actor:string,now:number,
 n:GroupNetwork,id:string,kind:NetworkInheritanceKind):Chat|null{
 const rows=s.chats.filter(c=>c.id===id),chat=rows[0],
  member=n.members.filter(m=>m.chatId===id);
 if(rows.length!==1||!chat||!chat.approved||chat.version<1||
  member.length!==1||member[0]!.version!==chat.version||
  !chat.scopes.includes(scope(kind))||!policy.canUseChat(s,id,scope(kind))||
  !policy.has(s,actor,'chat.manage',id,now))return null;
 return chat;
}
/** The target must be a disabled, no-secret copy. This is intentionally more
 * restrictive than the general per-group policy schema. */
function initialTarget(kind:NetworkInheritanceKind,
 payload:ProtectionPolicy|CommunityConfig):boolean{
 if(kind==='POLICY'){
  const p=payload as ProtectionPolicy;
  return isValidProtectionPolicy(p)&&p.mode!=='ENFORCE'&&p.revision===1&&
   p.allowedDomains.length===0&&p.allowedPhrases.length===0&&
   p.exemptMemberIds.length===0;
 }
 const c=payload as CommunityConfig;
 return validCommunityConfig(c)&&c.version===1&&!c.welcome.enabled&&
  !c.farewell.enabled&&!c.repliesEnabled&&c.rules.length===0&&
  c.welcome.photoFileId===undefined&&c.farewell.photoFileId===undefined&&
  c.welcome.buttons===undefined&&c.farewell.buttons===undefined&&
  c.rulesUrl===undefined&&c.privateWelcomeEnabled!==true;
}
/** Prepare a single opt-in link before any write. Per-chat local records are
 * required to be absent by the owner preview selection and rechecked at commit.
 * Active links cannot form a dependency chain, even across different networks. */
export function prepareNetworkInheritance(
 s:BotState,policy:Policy,actor:string,now:number,kind:NetworkInheritanceKind,
 n:GroupNetwork,sourceId:string,targetId:string,sourceRevision:number,
 payload:ProtectionPolicy|CommunityConfig):NetworkInheritanceLink|null{
 if(!validClock(now)||!policy.isOwner(actor)||!initialTarget(kind,payload)||
  (payload as {chatId:string}).chatId!==targetId||
  !Number.isSafeInteger(sourceRevision)||sourceRevision<1||
  (s.networkInheritance??[]).length>=500)return null;
 const source=currentGroup(s,policy,actor,now,n,sourceId,kind),
  target=currentGroup(s,policy,actor,now,n,targetId,kind);
 if(!source||!target||sourceId===targetId||
  (s.networkInheritance??[]).some(link=>link.kind===kind&&
   (link.targetChatId===targetId||
    link.status==='ACTIVE'&&(link.targetChatId===sourceId||link.sourceChatId===targetId))))return null;
 const id=randomBytes(6).toString('hex');
 if((s.networkInheritance??[]).some(link=>link.id===id))return null;
 const link:NetworkInheritanceLink={id,kind,networkId:n.id,networkRevision:n.revision,
  sourceChatId:sourceId,sourceChatVersion:source.version,sourceRevision,
  targetChatId:targetId,targetChatVersion:target.version,
  targetRevision:1,targetDigest:networkInheritanceDigest(payload),
  createdAt:now,lastSyncedAt:now,status:'ACTIVE'};
 return validNetworkInheritanceLink(link)?link:null;
}
function pause(link:NetworkInheritanceLink,reason:NetworkInheritancePauseReason):void{
 link.status='PAUSED';link.pausedReason=reason;
}
/** A deliberate local edit wins immediately and permanently. The owner may
 * retain or delete the target's configuration without a network overwriting it.
 * Re-enrollment requires a NEW explicit owner review, never implicit resume. */
export function pauseNetworkInheritanceForLocalEdit(s:BotState,kind:NetworkInheritanceKind,
 targetId:string):number{
 let paused=0;
 for(const link of s.networkInheritance??[]){
  if(link.kind===kind&&link.targetChatId===targetId&&link.status==='ACTIVE'){
   pause(link,'LOCAL_OVERRIDE');paused++;
  }
 }
 return paused;
}
export function pauseNetworkInheritanceByOwner(s:BotState,id:string):boolean{
 const items=(s.networkInheritance??[]).filter(x=>x.id===id);
 if(items.length!==1||items[0]!.status!=='ACTIVE')return false;
 pause(items[0]!,'OWNER_PAUSED');return true;
}
export type NetworkInheritanceSyncReport={updated:number;unchanged:number;paused:number};
/** Called inside the SAME BotStore.transaction as the approved source edit.
 * No scheduler/Telegram writes. Even a source owner has to retain current
 * per-chat authorization for EVERY target. If evidence fails, pause the link.
 * An unrelated target can succeed while the invalid one is left untouched. */
export function synchronizeNetworkInheritance(s:BotState,policy:Policy,actor:string,
 now:number,kind:NetworkInheritanceKind,sourceId:string):NetworkInheritanceSyncReport{
 const result:NetworkInheritanceSyncReport={updated:0,unchanged:0,paused:0};
 const links=(s.networkInheritance??[]).filter(x=>x.kind===kind&&
  x.sourceChatId===sourceId&&x.status==='ACTIVE');
 if(!links.length)return result;
 for(const link of links){
  const network=(s.groupNetworks??[]).filter(n=>n.id===link.networkId);
  let reason:NetworkInheritancePauseReason|null=null;
  if(!validClock(now)||!policy.isOwner(actor))reason='OWNER_REQUIRED';
  else if(network.length!==1||network[0]!.revision!==link.networkRevision)
   reason='NETWORK_STALE';
  const n=network[0];
  const from=n&&!reason?currentGroup(s,policy,actor,now,n,link.sourceChatId,kind):null;
  const to=n&&!reason?currentGroup(s,policy,actor,now,n,link.targetChatId,kind):null;
  if(!reason&&(!from||!to||from.version!==link.sourceChatVersion||
    to.version!==link.targetChatVersion))reason='GROUP_STALE';
  let sourceVersion:number|undefined;
  let targetVersion:number|undefined;
  let targetPolicy:GroupProtectionRecord|undefined;
  let targetGreeting:CommunityConfig|undefined;
  let sourcePolicy:GroupProtectionRecord|undefined;
  let sourceGreeting:CommunityConfig|undefined;
  if(!reason&&kind==='POLICY'){
   const a=(s.protectionPolicies??[]).filter(v=>v.policy.chatId===sourceId);
   const b=(s.protectionPolicies??[]).filter(v=>v.policy.chatId===link.targetChatId);
   sourcePolicy=a[0];targetPolicy=b[0];
   if(a.length!==1||!sourcePolicy||!isValidGroupProtectionRecord(sourcePolicy)||
     sourcePolicy.chatPolicyVersion!==link.sourceChatVersion||
     sourcePolicy.updatedAt>now||sourcePolicy.policy.mode==='ENFORCE')reason='SOURCE_STALE';
   else if(b.length!==1||!targetPolicy||!isValidGroupProtectionRecord(targetPolicy)||
     targetPolicy.chatPolicyVersion!==link.targetChatVersion||
     targetPolicy.updatedAt>now||targetPolicy.policy.mode==='ENFORCE')
    reason='TARGET_STALE';
   sourceVersion=sourcePolicy?.policy.revision;
   targetVersion=targetPolicy?.policy.revision;
  }else if(!reason){
   const a=(s.phase4Community?.configs??[]).filter(v=>v.chatId===sourceId);
   const b=(s.phase4Community?.configs??[]).filter(v=>v.chatId===link.targetChatId);
   sourceGreeting=a[0];targetGreeting=b[0];
   if(a.length!==1||!validCommunityConfig(sourceGreeting))reason='SOURCE_STALE';
   else if(b.length!==1||!validCommunityConfig(targetGreeting))
    reason='TARGET_STALE';
   sourceVersion=sourceGreeting?.version;
   targetVersion=targetGreeting?.version;
  }
  if(!reason&&(sourceVersion!==link.sourceRevision+1||
    !Number.isSafeInteger(sourceVersion)))reason='SOURCE_STALE';
  if(!reason&&(targetVersion!==link.targetRevision||
   networkInheritanceDigest(kind==='POLICY'?targetPolicy!.policy:targetGreeting!)!==link.targetDigest))
   reason='TARGET_STALE';
  if(!reason&&targetVersion!>=2_000_000_000)reason='CAP_EXCEEDED';
  if(reason){pause(link,reason);result.paused++;continue;}
  if(kind==='POLICY'){
   const source=sourcePolicy!.policy,old=targetPolicy!;
   const policyDraft:ProtectionPolicy={chatId:link.targetChatId,revision:old.policy.revision+1,
    mode:source.mode,rules:structuredClone(source.rules),
    allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],
    ...(source.flood?{flood:structuredClone(source.flood)}:{})};
   if(!isValidProtectionPolicy(policyDraft)){pause(link,'SOURCE_STALE');result.paused++;continue;}
   // A source allowlist never crosses the network. Ignore changes that affect
   // only source-local data rather than spuriously invalidating target drafts.
   if(JSON.stringify({...policyDraft,revision:old.policy.revision})===
      JSON.stringify(old.policy)){
    link.sourceRevision=sourceVersion!;link.lastSyncedAt=now;result.unchanged++;continue;
   }
   old.policy=policyDraft;old.updatedBy=actor;old.updatedAt=now;
   if(s.protectionFloodWindows)s.protectionFloodWindows=
    s.protectionFloodWindows.filter(w=>w.chatId!==link.targetChatId);
   link.targetRevision=policyDraft.revision;link.targetDigest=networkInheritanceDigest(policyDraft);
  }else{
   const old=targetGreeting!;
   const draft=defaultCommunityConfig(link.targetChatId);
   draft.version=old.version+1;
   draft.welcome.text=sourceGreeting!.welcome.text;
   if(sourceGreeting!.welcome.localized)
    draft.welcome.localized=structuredClone(sourceGreeting!.welcome.localized);
   if(sourceGreeting!.welcomeByJoin)
    draft.welcomeByJoin=structuredClone(sourceGreeting!.welcomeByJoin);
   draft.farewell.text=sourceGreeting!.farewell.text;
   if(sourceGreeting!.farewell.localized)
    draft.farewell.localized=structuredClone(sourceGreeting!.farewell.localized);
   if(sourceGreeting!.farewellByLeave)
    draft.farewellByLeave=structuredClone(sourceGreeting!.farewellByLeave);
   if(!validCommunityConfig(draft)){pause(link,'SOURCE_STALE');result.paused++;continue;}
   if(JSON.stringify({...draft,version:old.version})===JSON.stringify(old)){
    link.sourceRevision=sourceVersion!;link.lastSyncedAt=now;result.unchanged++;continue;
   }
   s.phase4Community!.configs[s.phase4Community!.configs.indexOf(old)]=draft;
   link.targetRevision=draft.version;link.targetDigest=networkInheritanceDigest(draft);
  }
  link.sourceRevision=sourceVersion!;link.lastSyncedAt=now;result.updated++;
 }
 if(result.updated||result.paused)
  s.audit.push({actorId:actor,updateKey:'network-follow:'+kind+':'+sourceId+':'+now,
   decision:'ALLOW',reason:'NETWORK_INHERITANCE_RESULT_UPDATED_'+result.updated+
    '_PAUSED_'+result.paused,policyVersion:0,at:now});
 return result;
}
