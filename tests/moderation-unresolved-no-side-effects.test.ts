import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type OperationStatus} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,type ModerationGateway} from '../src/moderation.js';

const OWNER='100',GROUP='-100123',TARGET='300',NOW=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite', status:OperationStatus){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-unresolved-moderation-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(path,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 await store.transaction(s=>{
  s.moderationOperations.push({id:'old-ambiguous-write',chatId:GROUP,
   memberId:TARGET,actorId:OWNER,kind:'BAN',reasonFingerprint:'opaque',
   policyVersion:s.chats[0]!.version,status,createdAt:NOW-1000,
   attemptGateway:'TELEGRAM_API'});
 });
 let reads=0, writes=0;
 const gateway:ModerationGateway={
  canRestrict:async()=>{reads++;return true;},
  isProtected:async()=>{reads++;return false;},
  setRestriction:async()=>{writes++;return 'CONFIRMED';}
 };
 const service=new ModerationService(store,policy,gateway,()=>NOW);
 return {store,policy,service,path,
  reads:()=>reads,writes:()=>writes,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 for(const status of ['UNKNOWN_OUTCOME','INTENT','STARTED'] as const){
  const blocker=status==='UNKNOWN_OUTCOME'?'BLOCKED_UNKNOWN':'BLOCKED_PENDING';
  test(engine+' '+status+' blocks new sanction reason before ANY network read',async()=>{
   const f=await fixture(engine,status);try{
    const result=await f.service.addManualReason(OWNER,GROUP,TARGET,'new-case','MUTE');
    assert.equal(result.status,blocker);
    assert.equal(f.reads(),0);assert.equal(f.writes(),0);
    const s=await f.store.snapshot();
    assert.deepEqual(s.moderationReasons,[]);
    assert.equal(s.moderationOperations.length,1);
    assert.equal(s.moderationOperations[0]!.status,status);
   }finally{await f.close();}
  });
  test(engine+' '+status+' cannot silently remove active reasons or alter subscription decisions',async()=>{
   const f=await fixture(engine,status);try{
    await f.store.transaction(s=>s.moderationReasons.push({
     chatId:GROUP,memberId:TARGET,source:'MANUAL',reference:'protected',
     kind:'BAN',createdBy:OWNER,active:true
    }));
    const removed=await f.service.removeManualReason(OWNER,GROUP,TARGET,'protected');
    const added=await f.service.setSubscriptionReason(GROUP,TARGET,'required-channel',true);
    assert.equal(removed.status,blocker);
    assert.equal(added.status,blocker);
    assert.equal(f.reads(),0);assert.equal(f.writes(),0);
    const s=await f.store.snapshot();
    assert.equal(s.moderationReasons.length,1);
    assert.equal(s.moderationReasons[0]!.active,true);
    assert.equal(s.moderationReasons[0]!.reference,'protected');
   }finally{await f.close();}
  });
  test(engine+' '+status+' reconcile surfaces risk even if Telegram permission reads fail',async()=>{
   const f=await fixture(engine,status);try{
    const answer=await f.service.reconcile(OWNER,GROUP,TARGET);
    assert.equal(answer.status,blocker);
    assert.equal(f.reads(),0);
    assert.equal(f.writes(),0);
   }finally{await f.close();}
  });
 }
 test(engine+' unresolved result never discloses case existence to unauthorized actor',async()=>{
  const f=await fixture(engine,'UNKNOWN_OUTCOME');try{
   const answer=await f.service.reconcile('400',GROUP,TARGET);
   assert.equal(answer.status,'DENIED');
   assert.equal(f.reads(),0);
   assert.equal(f.writes(),0);
  }finally{await f.close();}
 });
 test(engine+' ambiguous ledger remains a no-send after reopening persistent store',async()=>{
  const f=await fixture(engine,'UNKNOWN_OUTCOME');try{
   const reopened=new BotStore(f.path,{engine});
   const policy=new Policy(reopened,OWNER,()=>NOW);
   let requests=0;
   const offlineGateway:ModerationGateway={
    canRestrict:async()=>{requests++;return false;},
    isProtected:async()=>{requests++;return true;},
    setRestriction:async()=>{requests++;return 'UNKNOWN_OUTCOME';}
   };
   const service=new ModerationService(reopened,policy,offlineGateway,()=>NOW);
   assert.equal((await service.addManualReason(OWNER,GROUP,TARGET,'after-restart','BAN')).status,
    'BLOCKED_UNKNOWN');
   assert.equal(requests,0);
   assert.deepEqual((await reopened.snapshot()).moderationReasons,[]);
  }finally{await f.close();}
 });
}
