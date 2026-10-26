import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,type ModerationGateway} from '../src/moderation.js';

const OWNER='100',CHAT='-100123',TARGET='300',NOW=1_700_000_000_000;
type Phase='BEFORE_DISPATCH'|'BOT_RIGHTS'|'TARGET_PROTECTION'|'SENT';
async function fixture(engine:'json'|'sqlite',phase:Phase){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-safe-prestart-abort-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 let rightsReads=0,targetReads=0,writes=0,dispatchAttempted=false;
 const gateway:ModerationGateway={
  canRestrict:async()=>{
   rightsReads++;
   // Initial eligibility read comes before a durable INTENT. Inject failure
   // only after INTENT exists, immediately before STARTED.
   if(phase==='BOT_RIGHTS'&&(await store.snapshot()).moderationOperations.length)
     throw Error('PRIVATE_TELEGRAM_BOT_RIGHTS_ERROR');
   return true;
  },
  isProtected:async()=>{
   targetReads++;
   if(phase==='TARGET_PROTECTION'&&(await store.snapshot()).moderationOperations.length)
     throw Error('PRIVATE_TELEGRAM_TARGET_STATUS_ERROR');
   return false;
  },
  setRestriction:async()=>{
   writes++;
   dispatchAttempted=true;
   if(phase==='SENT')throw Error('PRIVATE_TELEGRAM_RESPONSE_LOST');
   return 'CONFIRMED';
  }
 };
 const service=new ModerationService(store,policy,gateway,()=>NOW);
 if(phase==='BEFORE_DISPATCH')service.beforeDispatch=async()=>{
  throw Error('PRIVATE_PRESTART_HOOK_ERROR');
 };
 return {store,service,policy,file,
  reads:()=>rightsReads+targetReads,writes:()=>writes,
  attempted:()=>dispatchAttempted,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 for(const phase of ['BEFORE_DISPATCH','BOT_RIGHTS','TARGET_PROTECTION'] as const){
  test(engine+' '+phase+' exception before STARTED is safely CANCELLED and never dispatched',async()=>{
   const f=await fixture(engine,phase);try{
    const answer=await f.service.addManualReason(OWNER,CHAT,TARGET,'case-1','BAN');
    assert.deepEqual(answer,{status:'DENIED',reason:'PREFLIGHT_ABORTED_NO_SEND'});
    assert.equal(f.writes(),0);
    assert.equal(f.attempted(),false);
    const s=await f.store.snapshot();
    assert.equal(s.moderationOperations.length,1);
    assert.equal(s.moderationOperations[0]!.status,'CANCELLED');
    assert.equal(s.moderationOperations[0]!.attemptGateway,undefined);
    assert.equal(s.moderationOperations[0]!.kind,'BAN');
    assert.equal(s.moderationReasons.length,1);
    assert.equal(s.moderationReasons[0]!.active,true);
    assert.equal(JSON.stringify(answer).includes('PRIVATE_'),false);
   }finally{await f.close();}
  });
 }
 test(engine+' provider exception AFTER STARTED remains UNKNOWN_OUTCOME, never safe-cancelled',async()=>{
  const f=await fixture(engine,'SENT');try{
   const answer=await f.service.addManualReason(OWNER,CHAT,TARGET,'case-2','MUTE');
   assert.equal(answer.status,'UNKNOWN_OUTCOME');
   assert.equal(f.attempted(),true);
   assert.equal(f.writes(),1);
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal(op.kind,'MUTE');
   assert.equal((await f.service.reconcile(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.writes(),1,'must not replay an ambiguous provider attempt');
  }finally{await f.close();}
 });
 test(engine+' prestart error with concurrently modified INTENT must be quarantined, not cancelled',async()=>{
  const f=await fixture(engine,'BOT_RIGHTS');try{
   // The remote preflight can mutate the durable row before throwing. An
   // altered INTENT must not be declared conclusively safe just because
   // the awaited method itself threw.
   const original=f.service;
   const initial=await f.store.snapshot();
   assert.equal(initial.moderationOperations.length,0);
   // Injection happens in a beforeDispatch hook so no extra remote calls.
   original.beforeDispatch=async()=>{
    await f.store.transaction(s=>{s.moderationOperations.at(-1)!.kind='MUTE';});
    throw Error('PRIVATE_TRANSIENT_PRESTART_ERROR');
   };
   const answer=await original.addManualReason(OWNER,CHAT,TARGET,'case-3','BAN');
   assert.equal(answer.status,'BLOCKED_UNKNOWN');
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal(op.kind,'BAN');
   assert.equal(f.writes(),0);
   assert.equal((await f.service.reconcile(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
  }finally{await f.close();}
 });
 test(engine+' prestart error with terminalized INTENT cannot overwrite conflicting ledger evidence as CANCELLED',async()=>{
  const f=await fixture(engine,'BEFORE_DISPATCH');try{
   f.service.beforeDispatch=async()=>{
    await f.store.transaction(s=>{s.moderationOperations.at(-1)!.status='CONFIRMED';});
    throw Error('PRIVATE_TAMPERED_INTENT_ERROR');
   };
   const answer=await f.service.addManualReason(OWNER,CHAT,TARGET,'case-4','BAN');
   assert.equal(answer.status,'BLOCKED_UNKNOWN');
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal(op.kind,'BAN');
   assert.equal(f.writes(),0);
  }finally{await f.close();}
 });
 test(engine+' vanished prestart INTENT restores a blocked UNKNOWN_OUTCOME against original member',async()=>{
  const f=await fixture(engine,'BEFORE_DISPATCH');try{
   f.service.beforeDispatch=async()=>{
    await f.store.transaction(s=>{s.moderationOperations=[];});
    throw Error('PRIVATE_VANISHED_INTENT_ERROR');
   };
   const answer=await f.service.addManualReason(OWNER,CHAT,TARGET,'case-5','BAN');
   assert.equal(answer.status,'BLOCKED_UNKNOWN');
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal(op.memberId,TARGET);
   assert.equal(op.kind,'BAN');
   assert.equal(f.writes(),0);
  }finally{await f.close();}
 });
 test(engine+' safe-cancelled prestart attempt survives restart without blocked pending status',async()=>{
  const f=await fixture(engine,'BEFORE_DISPATCH');try{
   assert.equal((await f.service.addManualReason(OWNER,CHAT,TARGET,'case-6','MUTE')).status,'DENIED');
   const reopened=new BotStore(f.file,{engine});
   const s=await reopened.snapshot();
   assert.equal(s.moderationOperations.length,1);
   assert.equal(s.moderationOperations[0]!.status,'CANCELLED');
   // The history is preserved, but it does not masquerade as an in-flight
   // Telegram attempt; a new explicit owner decision is still required.
   assert.equal(s.moderationOperations[0]!.attemptGateway,undefined);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' policy callback exception inside STARTED reservation is a safe pre-send cancellation',async()=>{
  const f=await fixture(engine,'SENT');try{
   let evaluated=0;
   const valid=(state:Awaited<ReturnType<BotStore['snapshot']>>)=>{
    evaluated++;
    if(state.moderationOperations.some(op=>op.status==='INTENT')){
     throw Error('PRIVATE_CONCURRENT_POLICY_EXCEPTION');
    }
    return true;
   };
   // The callback succeeds in the candidate transaction before INTENT
   // insertion, then throws while the reservation transaction validates it.
   const outcome=await f.service.reconcile(OWNER,CHAT,TARGET,valid);
   assert.deepEqual(outcome,{status:'DENIED',reason:'PREFLIGHT_ABORTED_NO_SEND'});
   assert.ok(evaluated>=2);
   assert.equal(f.writes(),0);
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.status,'CANCELLED');
   assert.equal(op.attemptGateway,undefined);
  }finally{await f.close();}
 });
}
