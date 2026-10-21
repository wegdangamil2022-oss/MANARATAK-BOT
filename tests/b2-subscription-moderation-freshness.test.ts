import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',GROUP='-100111',CHANNEL_A='-100201',CHANNEL_B='-100202',MEMBER='300';
function deferred<T>(){
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(ok=>{resolve=ok;});
 return {promise,resolve};
}
class PausedModerationGateway extends FakeModerationGateway{
 holdRights=false;
 readonly entered=deferred<void>();
 readonly release=deferred<void>();
 override async canRestrict(chatId:string,memberId:string):Promise<boolean>{
  if(this.holdRights){this.entered.resolve();await this.release.promise;}
  return super.canRestrict(chatId,memberId);
 }
}
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-subscription-recheck-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER);
 for(const id of [GROUP,CHANNEL_A,CHANNEL_B])
  await policy.approveChat(OWNER,id,['moderation','verification','navigation']);
 const membership=new FakeMembershipGateway();
 const modGateway=new PausedModerationGateway();
 const moderation=new ModerationService(store,policy,modGateway);
 const gate=new SubscriptionGate(store,policy,membership,moderation);
 await gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
 membership.set(CHANNEL_A,MEMBER,'NOT_MEMBER');
 membership.set(CHANNEL_B,MEMBER,'NOT_MEMBER');
 return {store,policy,gate,membership,moderation,modGateway,close:()=>rm(dir,{recursive:true,force:true})};
}
const activeReasons=async(store:BotStore)=>(await store.snapshot()).moderationReasons.filter(x=>x.source==='SUBSCRIPTION'&&x.active);
for(const engine of ['json','sqlite'] as const){
 test('B2 '+engine+': pausing mandatory rule after NOT_MEMBER verification but before moderation rights MUST prevent stale mute',async()=>{
  const f=await fixture(engine);try{
   f.modGateway.holdRights=true;
   const task=f.gate.syncSubscriptionRestriction(GROUP,MEMBER);
   await f.modGateway.entered.promise;
   const before=await f.store.snapshot();
   const rev=before.chats.find(c=>c.id===GROUP)!.version;
   await f.policy.pauseSubscriptionAtRevision(OWNER,GROUP,rev,before.subscriptionRequirements[0]!.version);
   f.modGateway.release.resolve();
   const result=await task;
   assert.equal(result.status,'DENIED');
   assert.equal((await activeReasons(f.store)).length,0);
   assert.equal((await f.store.snapshot()).moderationOperations.length,0);
   assert.equal(f.modGateway.calls.length,0);
  }finally{await f.close();}
 });
}
test('B2 MEMBER evidence must not release an existing subscription mute after a mandatory-channel change',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.moderationReasons.push({chatId:GROUP,memberId:MEMBER,source:'SUBSCRIPTION',
    reference:'subscription-gate',kind:'MUTE',createdBy:'SYSTEM_SUBSCRIPTION',active:true});
  });
  f.membership.set(CHANNEL_A,MEMBER,'MEMBER');
  f.modGateway.holdRights=true;
  const task=f.gate.syncSubscriptionRestriction(GROUP,MEMBER);
  await f.modGateway.entered.promise;
  await f.gate.configure(OWNER,GROUP,[CHANNEL_B],'ALL');
  f.modGateway.release.resolve();
  assert.equal((await task).status,'DENIED');
  assert.equal((await activeReasons(f.store)).length,1);
  assert.equal(f.modGateway.calls.length,0);
 }finally{await f.close();}
});
test('B2 pending moderation external precheck cannot reuse channel approval after revoke-reapprove with same visible scopes',async()=>{
 const f=await fixture('sqlite');try{
  f.modGateway.holdRights=true;
  const task=f.gate.syncSubscriptionRestriction(GROUP,MEMBER);
  await f.modGateway.entered.promise;
  await f.policy.revokeChat(OWNER,CHANNEL_A);
  await f.policy.approveChat(OWNER,CHANNEL_A,['moderation','verification','navigation']);
  await f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
  f.modGateway.release.resolve();
  assert.equal((await task).status,'DENIED');
  assert.equal((await activeReasons(f.store)).length,0);
  assert.equal(f.modGateway.calls.length,0);
 }finally{await f.close();}
});
test('B2 a subscription policy edit in beforeDispatch MUST cancel prepared intent before any external moderation call',async()=>{
 const f=await fixture('sqlite');try{
  f.moderation.beforeDispatch=async()=>{
   const before=await f.store.snapshot();
   await f.policy.pauseSubscriptionAtRevision(OWNER,GROUP,
    before.chats.find(c=>c.id===GROUP)!.version,before.subscriptionRequirements[0]!.version);
  };
  const outcome=await f.gate.syncSubscriptionRestriction(GROUP,MEMBER);
  assert.equal(outcome.status,'DENIED');
  const state=await f.store.snapshot();
  assert.equal(state.moderationOperations.length,1);
  assert.equal(state.moderationOperations[0]!.status,'CANCELLED');
  assert.equal(f.modGateway.calls.length,0);
  assert.equal(state.subscriptionRequirements[0]!.channelIds.length,0);
 }finally{await f.close();}
});
test('B2 unrelated chat policy changes while moderation is pending must not cause false stale denial',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,'-100444',['verification']);
  f.modGateway.holdRights=true;
  const task=f.gate.syncSubscriptionRestriction(GROUP,MEMBER);
  await f.modGateway.entered.promise;
  await f.policy.approveChat(OWNER,'-100444',['verification','navigation']);
  f.modGateway.release.resolve();
  const result=await task;
  assert.equal(result.status,'APPLIED');
  assert.equal((await activeReasons(f.store)).length,1);
  assert.equal(f.modGateway.calls.length,1);
 }finally{await f.close();}
});
test('B2 unchanged NOT_MEMBER still mutes and subsequent known MEMBER clears only the subscription reason',async()=>{
 const f=await fixture('sqlite');try{
  const applied=await f.gate.syncSubscriptionRestriction(GROUP,MEMBER);
  assert.equal(applied.status,'APPLIED');
  assert.equal((await activeReasons(f.store)).length,1);
  f.membership.set(CHANNEL_A,MEMBER,'MEMBER');
  const cleared=await f.gate.syncSubscriptionRestriction(GROUP,MEMBER);
  assert.equal(cleared.status,'APPLIED');
  assert.equal((await activeReasons(f.store)).length,0);
  assert.deepEqual(f.modGateway.calls.map(x=>x.kind),['MUTE','NONE']);
 }finally{await f.close();}
});
test('B2 unchanged UNAVAILABLE never creates a punishment or starts a moderation operation',async()=>{
 const f=await fixture();try{
  f.membership.set(CHANNEL_A,MEMBER,'UNKNOWN');
  const result=await f.gate.syncSubscriptionRestriction(GROUP,MEMBER);
  assert.equal(result.status,'UNAVAILABLE');
  assert.equal((await activeReasons(f.store)).length,0);
  assert.equal(f.modGateway.calls.length,0);
 }finally{await f.close();}
});
