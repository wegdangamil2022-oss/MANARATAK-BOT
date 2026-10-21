import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {SubscriptionGate,type MembershipGateway,type Membership} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',GROUP='-100100',CHANNEL_A='-100201',CHANNEL_B='-100202',OTHER='-100303';
const deferred=<T>()=>{
 let resolve!:(value:T)=>void;
 let reject!:(reason:Error)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
};
class DelayedGateway implements MembershipGateway{
 readonly requested=deferred<void>();
 readonly permission=deferred<boolean>();
 readonly askedMember=deferred<void>();
 readonly response=deferred<Membership>();
 waitForPermission=false;waitForMember=false;
 async canVerifyChannel(_id:string):Promise<boolean>{
  this.requested.resolve();
  return this.waitForPermission?this.permission.promise:true;
 }
 async getMember(_id:string,_user:string):Promise<Membership>{
  this.askedMember.resolve();
  return this.waitForMember?this.response.promise:'MEMBER';
 }
}
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-membership-epoch-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER);
 const gateway=new DelayedGateway(),mod=new FakeModerationGateway();
 const moderation=new ModerationService(store,policy,mod);
 const gate=new SubscriptionGate(store,policy,gateway,moderation);
 for(const id of [GROUP,CHANNEL_A,CHANNEL_B,OTHER])
  await policy.approveChat(OWNER,id,['verification']);
 return {dir,store,policy,gate,gateway,mod,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B2 '+engine+': channel revoke + re-approval during pending provider precheck cannot resurrect a stale subscription',async()=>{
  const f=await fixture(engine);try{
   f.gateway.waitForPermission=true;
   const delayed=f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
   await f.gateway.requested.promise;
   await f.policy.revokeChat(OWNER,CHANNEL_A);
   await f.policy.approveChat(OWNER,CHANNEL_A,['verification']);
   f.gateway.permission.resolve(true);
   await assert.rejects(delayed,/APPROVAL_REVOKED|SUBSCRIPTION_CONFIG_STALE/);
   assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);
  }finally{await f.close();}
 });
}
test('B2: group revocation and re-approval during provider precheck must fail closed',async()=>{
 const f=await fixture();try{
  f.gateway.waitForPermission=true;
  const delayed=f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
  await f.gateway.requested.promise;
  await f.policy.revokeChat(OWNER,GROUP);
  await f.policy.approveChat(OWNER,GROUP,['verification']);
  f.gateway.permission.resolve(true);
  await assert.rejects(delayed,/APPROVAL_REVOKED|SUBSCRIPTION_CONFIG_STALE/);
  assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);
 }finally{await f.close();}
});
test('B2: slow obsolete owner edit cannot clobber newer current subscription config',async()=>{
 const f=await fixture();try{
  f.gateway.waitForPermission=true;
  const delayed=f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
  await f.gateway.requested.promise;
  const faster=new SubscriptionGate(f.store,f.policy,{
   canVerifyChannel:async()=>true,getMember:async()=> 'MEMBER'
  },new ModerationService(f.store,f.policy,f.mod));
  await faster.configure(OWNER,GROUP,[CHANNEL_B],'ANY');
  f.gateway.permission.resolve(true);
  await assert.rejects(delayed,/SUBSCRIPTION_CONFIG_STALE/);
  const after=(await f.store.snapshot()).subscriptionRequirements[0]!;
  assert.deepEqual(after.channelIds,[CHANNEL_B]);assert.equal(after.mode,'ANY');
  assert.equal(after.version,1);
 }finally{await f.close();}
});
test('B2: unrelated authorized chat policy edit never invalidates an otherwise current checked subscription',async()=>{
 const f=await fixture();try{
  f.gateway.waitForPermission=true;
  const inFlight=f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
  await f.gateway.requested.promise;
  await f.policy.approveChat(OWNER,OTHER,['navigation','verification']);
  f.gateway.permission.resolve(true);
  await inFlight;
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[CHANNEL_A]);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B2 '+engine+': membership MEMBER checked on prior channel policy epoch cannot be accepted after revoke/re-approve',async()=>{
  const f=await fixture(engine);try{
   await f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
   f.gateway.waitForMember=true;
   const check=f.gate.verify(GROUP,'300');
   await f.gateway.askedMember.promise;
   await f.policy.revokeChat(OWNER,CHANNEL_A);
   await f.policy.approveChat(OWNER,CHANNEL_A,['verification']);
   f.gateway.response.resolve('MEMBER');
   const verdict=await check;
   assert.deepEqual(verdict,{status:'UNAVAILABLE',channels:[]});
  }finally{await f.close();}
 });
}
test('B2: group policy epoch changed while external NOT_MEMBER evidence pending returns UNAVAILABLE, not a punishable violation',async()=>{
 const f=await fixture();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
  f.gateway.waitForMember=true;
  const check=f.gate.verify(GROUP,'300');
  await f.gateway.askedMember.promise;
  await f.policy.revokeChat(OWNER,GROUP);
  await f.policy.approveChat(OWNER,GROUP,['verification']);
  f.gateway.response.resolve('NOT_MEMBER');
  assert.deepEqual(await check,{status:'UNAVAILABLE',channels:[]});
  assert.equal(f.mod.calls.length,0);
 }finally{await f.close();}
});
test('B2: changing verification scopes during provider check invalidates membership evidence even if scope remains present',async()=>{
 const f=await fixture();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ANY');
  f.gateway.waitForMember=true;
  const check=f.gate.verify(GROUP,'300');
  await f.gateway.askedMember.promise;
  await f.policy.approveChat(OWNER,CHANNEL_A,['navigation','verification']);
  f.gateway.response.resolve('MEMBER');
  assert.equal((await check).status,'UNAVAILABLE');
 }finally{await f.close();}
});
test('B2: unchanged authorization and required channels preserve existing known MEMBER / NOT_MEMBER results',async()=>{
 const f=await fixture();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL_A],'ALL');
  assert.deepEqual(await f.gate.verify(GROUP,'300'),{status:'MEMBER',channels:[CHANNEL_A]});
  const m=new SubscriptionGate(f.store,f.policy,{
   canVerifyChannel:async()=>true,getMember:async()=> 'NOT_MEMBER'
  },new ModerationService(f.store,f.policy,new FakeModerationGateway()));
  assert.deepEqual(await m.verify(GROUP,'300'),{status:'NOT_MEMBER',channels:[CHANNEL_A]});
 }finally{await f.close();}
});
