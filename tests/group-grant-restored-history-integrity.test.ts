import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore,type Grant} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',STAFF='200',OTHER_STAFF='201';
const GROUP='-100123',OTHER='-100456',NOW=1_700_000_000_000,UNTIL=NOW+90_000;
type Engine='json'|'sqlite';
type MutableGrant=Grant&{chatPolicyVersion?:unknown;grantId?:unknown};

async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-grant-history-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(path,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation','navigation','assistant']);
 await policy.approveChat(OWNER,OTHER,['moderation','navigation','assistant']);
 const give=async(actor=STAFF,group=GROUP)=>policy.grant(OWNER,actor,'chat.manage',group,UNTIL);
 const has=async(actor=STAFF,group=GROUP)=>
  policy.has(await store.snapshot(),actor,'chat.manage',group,NOW);
 const breakHistorical=async(mutator:(row:MutableGrant)=>void)=>{
  await store.transaction(s=>{
   const grant=s.grants.find(g=>g.chatId===GROUP&&g.actor===STAFF)!;
   const historic=structuredClone(grant);
   historic.chatPolicyVersion=0;
   historic.revoked=true;
   mutator(historic as MutableGrant);
   s.grants.push(historic);
  });
 };
 const state=()=>store.snapshot();
 const preserved=async(before:Awaited<ReturnType<typeof store.snapshot>>)=>
  assert.deepEqual(await state(),before,'corrupted rows must not be repaired or rewritten by denied operation');
 return {store,policy,give,has,breakHistorical,state,preserved,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 for(const [label,mutate] of [
  ['zero epoch',(g:MutableGrant)=>{g.chatPolicyVersion=0;}],
  ['negative epoch',(g:MutableGrant)=>{g.chatPolicyVersion=-5;}],
  ['fractional epoch',(g:MutableGrant)=>{g.chatPolicyVersion=1.5;}],
  ['string epoch',(g:MutableGrant)=>{g.chatPolicyVersion='1';}],
  ['null epoch',(g:MutableGrant)=>{g.chatPolicyVersion=null;}],
  ['unsafe integer epoch',(g:MutableGrant)=>{g.chatPolicyVersion=Number.MAX_SAFE_INTEGER+1;}],
  ['malformed historical id',(g:MutableGrant)=>{g.grantId='forged-id';g.chatPolicyVersion=1;}],
  ['malformed historical revoked flag',(g:MutableGrant)=>{g.revoked='yes' as unknown as boolean;g.chatPolicyVersion=1;}],
  ['malformed historical expiration',(g:MutableGrant)=>{g.expiresAt='forever' as unknown as number;g.chatPolicyVersion=1;}],
  ['UUID but missing epoch',(g:MutableGrant)=>{delete g.chatPolicyVersion;}],
 ] as const){
  test(engine+' restore quarantines group grant with '+label+' without blocking independent group',async()=>{
   const f=await fixture(engine);try{
    await f.give();await f.give(OTHER_STAFF,OTHER);
    await f.breakHistorical(mutate);
    const snapshot=await f.state();
    assert.equal(await f.has(),false,'cannot cherry-pick a valid record around corrupted same-tuple history');
    assert.equal(await f.has(OTHER_STAFF,OTHER),true);
    const gateway=new FakeModerationGateway();
    const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
    assert.equal((await service.addManualReason(STAFF,GROUP,'300','historical-conflict','BAN')).status,'DENIED');
    assert.equal(gateway.calls.length,0);
    await f.preserved(snapshot);
   }finally{await f.close();}
  });
  test(engine+' restore with '+label+' cannot be laundered by regrant or owner revoke',async()=>{
   const f=await fixture(engine);try{
    await f.give();await f.breakHistorical(mutate);
    const snapshot=await f.state();
    await assert.rejects(f.give(),/AMBIGUOUS|CORRUPT|INTEGRITY/);
    await assert.rejects(f.policy.revokeGrant(OWNER,STAFF,'chat.manage',GROUP),/AMBIGUOUS|CORRUPT|INTEGRITY/);
    await f.preserved(snapshot);
   }finally{await f.close();}
  });
 }
 test(engine+' genuine unbound pre-epoch legacy grant remains preserved but owner may issue fresh scoped grant',async()=>{
  const f=await fixture(engine);try{
   await f.give();
   await f.store.transaction(s=>{
    const old=s.grants[0]!;
    delete old.chatPolicyVersion;
    delete old.grantId;
   });
   assert.equal(await f.has(),false,'legacy grant without approval epoch never authorizes');
   const legacy=structuredClone((await f.state()).grants[0]);
   await f.give();
   const snapshot=await f.state();
   assert.deepEqual(snapshot.grants[0],legacy);
   assert.equal(snapshot.grants.length,2);
   assert.equal(await f.has(),true);
  }finally{await f.close();}
 });
 test(engine+' valid historical grant from prior positive epoch coexists with current approved grant',async()=>{
  const f=await fixture(engine);try{
   await f.give();
   const original=structuredClone((await f.state()).grants[0]!);
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['moderation','navigation','assistant']);
   await f.give();
   assert.equal(await f.has(),true);
   const snapshot=await f.state();
   assert.deepEqual(snapshot.grants[0],original);
   assert.equal(snapshot.grants.length,2);
  }finally{await f.close();}
 });
 test(engine+' valid group revoke marks delegated rights revoked without corrupting distinct actors',async()=>{
  const f=await fixture(engine);try{
   await f.give();await f.give(OTHER_STAFF,OTHER);
   await f.policy.revokeGrant(OWNER,STAFF,'chat.manage',GROUP);
   const state=await f.state();
   assert.equal(state.grants[0]?.revoked,true);
   assert.equal(state.grants[1]?.revoked,false);
   assert.equal(await f.has(),false);
   assert.equal(await f.has(OTHER_STAFF,OTHER),true);
  }finally{await f.close();}
 });
 test(engine+' restored duplicate group ID blocks group grant revocation before mutation',async()=>{
  const f=await fixture(engine);try{
   await f.give();
   await f.store.transaction(s=>s.chats.push({...s.chats.find(x=>x.id===GROUP)!}));
   const before=await f.state();
   await assert.rejects(f.policy.revokeGrant(OWNER,STAFF,'chat.manage',GROUP),/AMBIGUOUS/);
   await f.preserved(before);
  }finally{await f.close();}
 });
 test(engine+' stale but well-formed historical revoked grant is not replayed',async()=>{
  const f=await fixture(engine);try{
   await f.give();
   await f.policy.revokeGrant(OWNER,STAFF,'chat.manage',GROUP);
   await f.give();
   assert.equal(await f.has(),true);
   const s=await f.state();
   assert.equal(s.grants.length,2);
   assert.equal(s.grants[0]?.revoked,true);
   assert.equal(s.grants[1]?.revoked,false);
  }finally{await f.close();}
 });
}
