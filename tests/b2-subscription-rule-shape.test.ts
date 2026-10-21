import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {summarizeSubscriptionIntegrity,isCanonicalSubscriptionRule} from '../src/subscription-integrity.js';

const OWNER='100',GROUP='-100123',CH='-100201',CH2='-100202';
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-invalid-gate-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),membership=new FakeMembershipGateway();
 const mod=new FakeModerationGateway(),moderation=new ModerationService(store,policy,mod);
 const gate=new SubscriptionGate(store,policy,membership,moderation);
 for(const id of [GROUP,CH,CH2])await policy.approveChat(OWNER,id,['verification']);
 await gate.configure(OWNER,GROUP,[CH],'ALL');
 membership.set(CH,'300','NOT_MEMBER');membership.set(CH2,'300','NOT_MEMBER');
 return {dir,store,policy,gate,membership,mod,close:()=>rm(dir,{force:true,recursive:true})};
}
test('B2 shared structural validator accepts canonical live and valid zero-channel paused rule',()=>{
 assert.equal(isCanonicalSubscriptionRule({chatId:GROUP,channelIds:[CH,CH2],mode:'ALL',version:1}),true);
 assert.equal(isCanonicalSubscriptionRule({chatId:GROUP,channelIds:[],mode:'ANY',version:3}),true);
 for(const value of [
  null,[],{},'bad',
  {chatId:GROUP,channelIds:[],mode:'BROKEN',version:1},
  {chatId:GROUP,channelIds:[],mode:'ALL',version:0},
  {chatId:'not-a-group',channelIds:[],mode:'ALL',version:1},
  {chatId:GROUP,channelIds:[CH,CH],mode:'ALL',version:1},
  {chatId:GROUP,channelIds:[CH,'invalid'],mode:'ALL',version:1},
  {chatId:GROUP,channelIds:Array.from({length:11},(_,i)=>'-1002'+i),mode:'ALL',version:1},
  {chatId:GROUP,channelIds:'not-array',mode:'ALL',version:1}
 ])assert.equal(isCanonicalSubscriptionRule(value),false,JSON.stringify(value));
});
for(const engine of ['json','sqlite'] as const){
 test('B2 '+engine+': malformed ALL/ANY mode cannot convert known NOT_MEMBER into a punishment',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.subscriptionRequirements[0]!.mode='BROKEN' as 'ALL';});
   const before=await f.store.snapshot();
   assert.deepEqual(await f.gate.verify(GROUP,'300'),{status:'UNAVAILABLE',channels:[]});
   const outcome=await f.gate.syncSubscriptionRestriction(GROUP,'300');
   assert.deepEqual(outcome,{status:'UNAVAILABLE',channels:[]});
   assert.equal(f.mod.calls.length,0);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
}
test('B2: invalid subscription rule version denies interpreting membership results',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version=0;});
  assert.equal((await f.gate.verify(GROUP,'300')).status,'UNAVAILABLE');
  assert.equal(f.mod.calls.length,0);
 }finally{await f.close();}
});
test('B2: duplicate mandatory channels, oversize lists and invalid IDs fail before provider checks',async()=>{
 const f=await fixture();try{
  let calls=0;
  const gate=new SubscriptionGate(f.store,f.policy,{
   canVerifyChannel:async()=>{calls++;return true;},
   getMember:async()=>{calls++;return 'NOT_MEMBER';}
  },new ModerationService(f.store,f.policy,f.mod));
  for(const invalid of [
   [CH,CH],
   [...Array.from({length:11},(_,i)=>'-1003'+i)],
   [CH,'@not-channel'],
  ]){
   await f.store.transaction(s=>{s.subscriptionRequirements[0]!.channelIds=invalid;});
   assert.deepEqual(await gate.verify(GROUP,'300'),{status:'UNAVAILABLE',channels:[]});
  }
  assert.equal(calls,0);assert.equal(f.mod.calls.length,0);
 }finally{await f.close();}
});
test('B2: corrupt paused rule cannot silently claim NOT_REQUIRED, valid pause remains NOT_REQUIRED',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.subscriptionRequirements[0]!.channelIds=[];
   s.subscriptionRequirements[0]!.mode='BROKEN' as 'ANY';
  });
  assert.equal((await f.gate.verify(GROUP,'300')).status,'UNAVAILABLE');
  await f.store.transaction(s=>{s.subscriptionRequirements[0]!.mode='ALL';});
  assert.deepEqual(await f.gate.verify(GROUP,'300'),{status:'NOT_REQUIRED',channels:[]});
 }finally{await f.close();}
});
test('B2 offline audit finds structurally malformed paused rule and duplicate rule across active/paused statuses',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.subscriptionRequirements[0]!.channelIds=[];s.subscriptionRequirements[0]!.version=-1;});
  const malformed=summarizeSubscriptionIntegrity(await f.store.snapshot());
  assert.equal(malformed.status,'BLOCKED');assert.equal(malformed.inactiveRules,1);
  assert.equal(malformed.invalidRules,1);
  assert.deepEqual(malformed.reasons,['INVALID_RULE_SHAPE']);
  await f.store.transaction(s=>{
   s.subscriptionRequirements[0]!.version=2;
   s.subscriptionRequirements.push({chatId:GROUP,mode:'ANY',channelIds:[CH2],version:1});
  });
  const duplicate=summarizeSubscriptionIntegrity(await f.store.snapshot());
  assert.equal(duplicate.status,'BLOCKED');
  assert.equal(duplicate.activeRules,1);assert.equal(duplicate.inactiveRules,1);
  assert.equal(duplicate.invalidRules,1);
  assert.ok(duplicate.reasons.includes('INVALID_RULE_SHAPE'));
 }finally{await f.close();}
});
test('B2 valid inactive rule after confirmed owner pause still passes offline audit and does not contact provider',async()=>{
 const f=await fixture('sqlite');try{
  const state=await f.store.snapshot();
  await f.policy.pauseSubscriptionAtRevision(OWNER,GROUP,
   state.chats.find(c=>c.id===GROUP)!.version,state.subscriptionRequirements[0]!.version);
  const report=summarizeSubscriptionIntegrity(await f.store.snapshot());
  assert.equal(report.status,'PASS');assert.equal(report.invalidRules,0);
  assert.equal(report.inactiveRules,1);
  assert.equal((await f.gate.verify(GROUP,'300')).status,'NOT_REQUIRED');
 }finally{await f.close();}
});
