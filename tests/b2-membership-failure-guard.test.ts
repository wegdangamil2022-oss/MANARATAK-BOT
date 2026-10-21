import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {SubscriptionGate,type MembershipGateway,type Membership} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
const OWNER='100',GROUP='-100123',A='-100201',B='-100202';
async function fixture(engine:'json'|'sqlite'='json',mode:'ALL'|'ANY'='ALL'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-membership-failure-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'s.sqlite':'s.json'),{engine});
 const policy=new Policy(store,OWNER);
 for(const id of [GROUP,A,B])await policy.approveChat(OWNER,id,['verification']);
 await store.transaction(s=>s.subscriptionRequirements.push({chatId:GROUP,channelIds:[A,B],mode,version:1}));
 const moderationApi=new FakeModerationGateway(),moderation=new ModerationService(store,policy,moderationApi);
 let canVerifyCalls=0,getMemberCalls=0;
 const verifiable=new Map([[A,true],[B,true]]);
 const answers=new Map<string,Membership>([[A,'MEMBER'],[B,'MEMBER']]);
 const gateway:MembershipGateway={
  async canVerifyChannel(channel:string){canVerifyCalls++;return verifiable.get(channel)??false;},
  async getMember(channel:string){getMemberCalls++;return answers.get(channel)??'UNKNOWN';}
 };
 const gate=new SubscriptionGate(store,policy,gateway,moderation);
 return {dir,store,policy,answers,verifiable,gateway,gate,moderationApi,
  get calls(){return {canVerifyCalls,getMemberCalls};},
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B2 Core '+engine+': transport-level canVerifyChannel rejection becomes UNAVAILABLE not a crash or punishment',async()=>{
  const f=await fixture(engine);try{
   const providerMessage='secret CHANNEL_ID=very-private DO_NOT_LEAK';
   const gate=new SubscriptionGate(f.store,f.policy,{
    async canVerifyChannel(){throw Error(providerMessage);},
    async getMember(){throw Error('must never query while channel cannot be checked');}
   },new ModerationService(f.store,f.policy,f.moderationApi));
   const r=await gate.verify(GROUP,'300');
   assert.deepEqual(r,{status:'UNAVAILABLE',channels:[]});
   const sync=await gate.syncSubscriptionRestriction(GROUP,'300');
   assert.equal(sync.status,'UNAVAILABLE');
   assert.equal(f.moderationApi.calls.length,0);
   assert.equal(JSON.stringify(await f.store.snapshot()).includes(providerMessage),false);
  }finally{await f.close();}
 });
}
test('B2 Core owner configure fails closed with static CHANNEL_UNVERIFIABLE on gateway exception',async()=>{
 const f=await fixture();try{
  const g=new SubscriptionGate(f.store,f.policy,{
   async canVerifyChannel(){throw Error('API error PRIVATE_TG_TOKEN_DO_NOT_ECHO');},
   async getMember(){return 'MEMBER';}
  },new ModerationService(f.store,f.policy,f.moderationApi));
  const before=await f.store.snapshot();
  await assert.rejects(g.configure(OWNER,GROUP,[A],'ALL'),e=>{
   assert.equal((e as Error).message,'CHANNEL_UNVERIFIABLE');return true;
  });
  const after=await f.store.snapshot();
  assert.deepEqual(after.subscriptionRequirements,before.subscriptionRequirements);
  assert.equal(f.moderationApi.calls.length,0);
 }finally{await f.close();}
});
for(const order of [['NOT_MEMBER','UNKNOWN'],['UNKNOWN','NOT_MEMBER']] as const){
 test('B2 Core ALL with mixed negative and UNKNOWN returns UNAVAILABLE, not an unverified user punishment '+order.join('/'),async()=>{
  const f=await fixture('sqlite','ALL');try{
   f.answers.set(A,order[0]);f.answers.set(B,order[1]);
   const decision=await f.gate.verify(GROUP,'300');
   assert.equal(decision.status,'UNAVAILABLE');
   const sync=await f.gate.syncSubscriptionRestriction(GROUP,'300');
   assert.equal(sync.status,'UNAVAILABLE');
   assert.equal(f.moderationApi.calls.length,0);
  }finally{await f.close();}
 });
}
test('B2 Core ALL with all known MEMBER and NOT_MEMBER gives determinate decision',async()=>{
 const f=await fixture('json','ALL');try{
  f.answers.set(A,'MEMBER');f.answers.set(B,'NOT_MEMBER');
  const r=await f.gate.verify(GROUP,'300');
  assert.equal(r.status,'NOT_MEMBER');assert.deepEqual(r.channels,[A,B]);
  f.answers.set(B,'MEMBER');
  assert.equal((await f.gate.verify(GROUP,'300')).status,'MEMBER');
 }finally{await f.close();}
});
test('B2 Core ANY with one certain MEMBER can pass despite another unknown channel',async()=>{
 const f=await fixture('json','ANY');try{
  f.answers.set(A,'MEMBER');f.answers.set(B,'UNKNOWN');
  assert.equal((await f.gate.verify(GROUP,'300')).status,'MEMBER');
  assert.equal(f.moderationApi.calls.length,0);
 }finally{await f.close();}
});
test('B2 Core ANY without a known MEMBER and with an unknown channel is UNAVAILABLE',async()=>{
 const f=await fixture('sqlite','ANY');try{
  f.answers.set(A,'NOT_MEMBER');f.answers.set(B,'UNKNOWN');
  assert.equal((await f.gate.verify(GROUP,'300')).status,'UNAVAILABLE');
  assert.equal((await f.gate.syncSubscriptionRestriction(GROUP,'300')).status,'UNAVAILABLE');
  assert.equal(f.moderationApi.calls.length,0);
 }finally{await f.close();}
});
test('B2 Core gateway unexpected membership result cannot count as verified, even with an otherwise negative ALL channel',async()=>{
 const f=await fixture('sqlite','ALL');try{
  f.answers.set(A,'NOT_MEMBER');
  f.answers.set(B,'BROKEN_RESPONSE' as Membership);
  assert.equal((await f.gate.verify(GROUP,'300')).status,'UNAVAILABLE');
  assert.equal((await f.gate.syncSubscriptionRestriction(GROUP,'300')).status,'UNAVAILABLE');
  assert.equal(f.moderationApi.calls.length,0);
 }finally{await f.close();}
});
test('B2 Core external getMember throwing is UNAVAILABLE when combined with a determinate ALL failure',async()=>{
 const f=await fixture();try{
  const g=new SubscriptionGate(f.store,f.policy,{
   async canVerifyChannel(){return true;},
   async getMember(channel){if(channel===B)throw Error('transient provider timeout');return 'NOT_MEMBER';}
  },new ModerationService(f.store,f.policy,f.moderationApi));
  assert.equal((await g.verify(GROUP,'300')).status,'UNAVAILABLE');
  assert.equal((await g.syncSubscriptionRestriction(GROUP,'300')).status,'UNAVAILABLE');
  assert.equal(f.moderationApi.calls.length,0);
 }finally{await f.close();}
});
test('B2 Core approval revoked mid-flight never returns MEMBER on stale gateway membership evidence',async()=>{
 const f=await fixture();try{
  const g=new SubscriptionGate(f.store,f.policy,{
   async canVerifyChannel(channel){if(channel===B)await f.policy.revokeChat(OWNER,B);return true;},
   async getMember(){return 'MEMBER';}
  },new ModerationService(f.store,f.policy,f.moderationApi));
  const r=await g.verify(GROUP,'300');
  assert.equal(r.status,'UNAVAILABLE');
  assert.equal(f.moderationApi.calls.length,0);
 }finally{await f.close();}
});
