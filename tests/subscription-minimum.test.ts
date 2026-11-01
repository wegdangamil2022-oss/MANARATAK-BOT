import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {SubscriptionGate,FakeMembershipGateway,type Membership} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {isCanonicalSubscriptionRule,subscriptionRuleWitness} from '../src/subscription-integrity.js';
import {groupMenuEpochDigest} from '../src/telegram-group-access.js';
const GROUP='-100100',CHANNELS=['-100200','-100201','-100202'];
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'minimum-subscription-')),store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100');
  await policy.approveChat('100',GROUP,['navigation','verification','moderation']);for(const id of CHANNELS)await policy.approveChat('100',id,['verification']);
  const membership=new FakeMembershipGateway(),gateway=new FakeModerationGateway(),gate=new SubscriptionGate(store,policy,membership,new ModerationService(store,policy,gateway));
  await store.transaction(s=>{s.subscriptionRequirements.push({chatId:GROUP,channelIds:CHANNELS,mode:'AT_LEAST',minimumCount:2,version:1});});
  return {store,policy,membership,gate,gateway,path:join(dir,'state.'+engine),close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' numeric minimum needs enough verified members and never treats unknowns as violations',async()=>{
  const f=await fixture();try{
   const cases:[Membership[],string][]=[[['MEMBER','MEMBER','UNKNOWN'],'MEMBER'],[['MEMBER','NOT_MEMBER','UNKNOWN'],'UNAVAILABLE'],[['NOT_MEMBER','NOT_MEMBER','MEMBER'],'NOT_MEMBER'],[['MEMBER','MEMBER','NOT_MEMBER'],'MEMBER']];
   for(const [values,expected] of cases){CHANNELS.forEach((id,i)=>f.membership.set(id,'300',values[i]!));assert.equal((await f.gate.verify(GROUP,'300')).status,expected);}
  }finally{await f.close();}
 });
 test(engine+' malformed and incompatible numeric minimum rules fail closed',async()=>{
  const f=await fixture();try{
   const rule=(await f.store.snapshot()).subscriptionRequirements[0]!;
   assert.equal(isCanonicalSubscriptionRule(rule),true);for(const minimumCount of [0,4,1.5,'2',undefined])assert.equal(isCanonicalSubscriptionRule({...rule,minimumCount}),false);
   assert.equal(isCanonicalSubscriptionRule({...rule,mode:'ANY'}),false);assert.equal(isCanonicalSubscriptionRule({...rule,channelIds:[]}),false);
  }finally{await f.close();}
 });
 test(engine+' changing only the numeric minimum while membership is read invalidates evidence',async()=>{
  const f=await fixture();try{
   CHANNELS.forEach(id=>f.membership.set(id,'300','MEMBER'));
   let reads=0;f.membership.getMember=async()=>{reads++;await f.store.transaction(s=>{s.subscriptionRequirements[0]!.minimumCount=3;});return 'MEMBER';};
   assert.equal((await f.gate.verify(GROUP,'300')).status,'UNAVAILABLE');assert.equal(reads,3);
  }finally{await f.close();}
 });
 test(engine+' minimum is persisted, requires valid counts, and is cleared by explicit pause and approval revocation',async()=>{
  const f=await fixture();try{
   await f.gate.configure('100',GROUP,CHANNELS,'AT_LEAST',undefined,2);assert.equal((await new BotStore(f.path,{engine}).snapshot()).subscriptionRequirements[0]!.minimumCount,2);
   for(const n of [0,4,1.5])await assert.rejects(f.gate.configure('100',GROUP,CHANNELS,'AT_LEAST',undefined,n));await assert.rejects(f.gate.configure('100',GROUP,CHANNELS,'ANY',undefined,2));
   let s=await f.store.snapshot();await f.policy.pauseSubscriptionAtRevision('100',GROUP,s.chats.find(c=>c.id===GROUP)!.version,s.subscriptionRequirements[0]!.version);s=await f.store.snapshot();assert.equal(isCanonicalSubscriptionRule(s.subscriptionRequirements[0]),true);assert.equal(s.subscriptionRequirements[0]!.minimumCount,undefined);assert.equal(s.subscriptionRequirements[0]!.channelIds.length,0);
   await f.gate.configure('100',GROUP,CHANNELS,'AT_LEAST',undefined,2);await f.policy.revokeChat('100',CHANNELS[0]!);s=await f.store.snapshot();assert.equal(isCanonicalSubscriptionRule(s.subscriptionRequirements[0]),true);assert.equal(s.subscriptionRequirements[0]!.minimumCount,undefined);assert.equal(s.subscriptionRequirements[0]!.channelIds.length,0);
  }finally{await f.close();}
 });
 test(engine+' pruning a channel never silently reduces a numeric minimum',async()=>{
  const f=await fixture();try{
   const group=()=>f.store.snapshot().then(s=>s.chats.find(c=>c.id===GROUP)!.version);
   await f.gate.configure('100',GROUP,CHANNELS,'AT_LEAST',undefined,3);let rule=(await f.store.snapshot()).subscriptionRequirements[0]!;
   await assert.rejects(f.policy.removeSubscriptionChannelAtRevision('100',GROUP,CHANNELS[0]!,await group(),rule.version),/SUBSCRIPTION_MINIMUM_REVIEW_REQUIRED/);assert.equal((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds.length,3);
   await f.gate.configure('100',GROUP,CHANNELS,'AT_LEAST',undefined,2);rule=(await f.store.snapshot()).subscriptionRequirements[0]!;await f.policy.removeSubscriptionChannelAtRevision('100',GROUP,CHANNELS[0]!,await group(),rule.version);rule=(await f.store.snapshot()).subscriptionRequirements[0]!;assert.equal(rule.minimumCount,2);assert.equal(rule.channelIds.length,2);
  }finally{await f.close();}
 });
 test(engine+' changing minimum after membership verification cannot apply or release a stale restriction',async()=>{
  for(const releasing of [false,true]){
   const f=await fixture();try{
    CHANNELS.forEach((id,i)=>f.membership.set(id,'300',i<(releasing?2:1)?'MEMBER':'NOT_MEMBER'));
    if(releasing)await f.store.transaction(s=>{s.moderationReasons.push({chatId:GROUP,memberId:'300',source:'SUBSCRIPTION',reference:'subscription-gate',kind:'MUTE',createdBy:'SYSTEM_SUBSCRIPTION',active:true});});
    f.gateway.canRestrict=async()=>{await f.store.transaction(s=>{s.subscriptionRequirements[0]!.minimumCount=releasing?3:1;});return true;};
    assert.equal((await f.gate.syncSubscriptionRestriction(GROUP,'300')).status,'DENIED');assert.equal(f.gateway.calls.length,0);assert.equal((await f.store.snapshot()).moderationReasons.filter(r=>r.active).length,releasing?1:0);
   }finally{await f.close();}
  }
 });
 test(engine+' rule witnesses include numeric minima without changing legacy bytes',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot(),rule=s.subscriptionRequirements[0]!,digest=groupMenuEpochDigest(s,GROUP),witness=subscriptionRuleWitness(rule);rule.minimumCount=3;assert.notEqual(groupMenuEpochDigest(s,GROUP),digest);assert.notDeepEqual(subscriptionRuleWitness(rule),witness);
   const legacy={chatId:GROUP,mode:'ALL' as const,channelIds:CHANNELS,version:1};assert.deepEqual(subscriptionRuleWitness(legacy),[1,'ALL',...CHANNELS]);
  }finally{await f.close();}
 });
}
