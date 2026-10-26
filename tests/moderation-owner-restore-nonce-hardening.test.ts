import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {inspectModerationLedgerIntegrity} from '../src/moderation-review-integrity.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',GROUP='-100123',TARGET='300',NOW=1_700_000_000_000;
type Engine='json'|'sqlite';
async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-nonce-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 const version=(await store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
 await store.transaction(s=>s.moderationOperations.push({
  id:'recovery-original',chatId:GROUP,memberId:TARGET,actorId:OWNER,
  kind:'BAN',reasonFingerprint:'opaque',policyVersion:version,
  status:'UNKNOWN_OUTCOME',createdAt:NOW
 }));
 let now=NOW;
 const current=()=>now;
 const reopen=()=>new ModerationUnknownOwnerReview(new BotStore(file,{engine}),
  new Policy(new BotStore(file,{engine}),OWNER,current),current);
 const screen=new ModerationUnknownOwnerReview(store,policy,current);
 const key=(plan:Awaited<ReturnType<typeof screen.handle>>,prefix:string)=>{
  const button=plan?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith(prefix));
  assert.ok(button,'Missing '+prefix);return button.callback_data;
 };
 const route=async()=>{
  const list=await screen.handle('mr:1:h',OWNER);
  const details=await screen.handle(key(list,'mr:1:d:'),OWNER);
  return key(details,'mr:1:v:');
 };
 const issue=async()=>{
  const action=await route();
  const preview=await screen.handle(action,OWNER);
  return key(preview,'c_');
 };
 const assertIntact=async(token:string)=>{
  const s=await store.snapshot();
  assert.equal(s.callbacks.find(x=>x.ref===token)?.used,false);
  assert.equal(s.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
  assert.equal(s.moderationOperations[0]?.review,undefined);
  assert.equal(s.audit.some(x=>x.reason.startsWith('MODERATION_UNKNOWN_OWNER_')),false);
 };
 return {store,policy,screen,reopen,route,issue,assertIntact,
  advance:(ms:number)=>{now+=ms;},now:()=>now,
  close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' refuses to mint owner-review nonce for future-dated restored recovery',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.moderationOperations[0]!.createdAt=NOW+60_000;});
   const action=await f.route();
   const before=(await f.store.snapshot()).callbacks;
   const preview=await f.screen.handle(action,OWNER);
   assert.equal(preview,null);
   assert.deepEqual((await f.store.snapshot()).callbacks,before);
   f.advance(60_001);
   const valid=await f.screen.handle(action,OWNER);
   assert.ok(valid,'future timestamp eventually becomes reviewable without changing it');
  }finally{await f.close();}
 });
 test(engine+' rejects a restored nonce after clock rollback before issuance',async()=>{
  const f=await fixture(engine);try{
   f.advance(60_000);
   const token=await f.issue();
   f.advance(-30_000);
   assert.equal(await f.reopen().handle(token,OWNER),null);
   await f.assertIntact(token);
   f.advance(30_000);
   assert.ok(await f.reopen().handle(token,OWNER));
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations[0]!.review?.reviewedAt,NOW+60_000);
  }finally{await f.close();}
 });
 test(engine+' rejects a nonce review timestamp preceding restored attempt creation',async()=>{
  const f=await fixture(engine);try{
   const token=await f.issue();
   f.advance(-1);
   assert.equal(await f.reopen().handle(token,OWNER),null);
   await f.assertIntact(token);
   assert.deepEqual(inspectModerationLedgerIntegrity(await f.store.snapshot()),
    {valid:true,malformedRows:0});
  }finally{await f.close();}
 });
 for(const [label,mutate] of [
  ['non-numeric expiry',(c:{expiresAt:number})=>{c.expiresAt='untrusted' as unknown as number;}],
  ['fractional expiry',(c:{expiresAt:number})=>{c.expiresAt=NOW+90_000.5;}],
  ['far-future expiry',(c:{expiresAt:number})=>{c.expiresAt=NOW+3600_000;}],
  ['negative expiry',(c:{expiresAt:number})=>{c.expiresAt=-1;}]
 ] as const){
  test(engine+' rejects restored owner nonce with '+label,async()=>{
   const f=await fixture(engine);try{
    const token=await f.issue();
    await f.store.transaction(s=>mutate(s.callbacks.find(x=>x.ref===token)!));
    assert.equal(await f.reopen().handle(token,OWNER),null);
    await f.assertIntact(token);
   }finally{await f.close();}
  });
 }
 for(const key of ['used','revoked'] as const){
  test(engine+' rejects owner review callback whose '+key+' field disappeared in restore',async()=>{
   const f=await fixture(engine);try{
    const token=await f.issue();
    await f.store.transaction(s=>{
     const c=s.callbacks.find(x=>x.ref===token)!;
     delete (c as unknown as Record<string,unknown>)[key];
    });
    assert.equal(await f.reopen().handle(token,OWNER),null);
    const s=await f.store.snapshot();
    assert.equal(s.moderationOperations[0]?.review,undefined);
    assert.equal(s.audit.some(x=>x.reason.startsWith('MODERATION_UNKNOWN_OWNER_')),false);
   }finally{await f.close();}
  });
 }
 test(engine+' permits restored unmodified two-minute nonce exactly once and never lifts UNKNOWN lock',async()=>{
  const f=await fixture(engine);try{
   const token=await f.issue();
   assert.ok(await f.reopen().handle(token,OWNER));
   assert.equal(await f.reopen().handle(token,OWNER),null);
   const state=await f.store.snapshot();
   assert.equal(state.callbacks.find(x=>x.ref===token)?.used,true);
   assert.equal(state.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
   assert.deepEqual(inspectModerationLedgerIntegrity(state),{valid:true,malformedRows:0});
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(f.store,f.policy,gateway,()=>f.now());
   assert.equal((await service.reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
  }finally{await f.close();}
 });
}
