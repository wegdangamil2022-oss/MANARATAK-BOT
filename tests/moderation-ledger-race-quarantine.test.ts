import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type OperationStatus} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,type ModerationGateway,type RestrictionOutcome} from '../src/moderation.js';

const OWNER='100',CHAT='-100123',TARGET='300',NOW=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite',
 dispatch:(s:BotStore)=>ModerationGateway['setRestriction']){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-ledger-race-'));
 const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 let sends=0;
 const gateway:ModerationGateway={
  canRestrict:async()=>true,
  isProtected:async()=>false,
  setRestriction:async(...args)=>{
   sends++;
   return dispatch(store)(...args);
  }
 };
 const service=new ModerationService(store,policy,gateway,()=>NOW);
 return {store,service,policy,sends:()=>sends,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 for(const raced of ['CANCELLED','CONFIRMED','UNKNOWN_OUTCOME'] as const){
  test(engine+' refuses to overwrite '+raced+' when network result returns',async()=>{
   const f=await fixture(engine,store=>async()=>{
    await store.transaction(s=>{
     const op=s.moderationOperations.at(-1)!;
     assert.equal(op.status,'STARTED');
     op.status=raced;
    });
    return 'CONFIRMED';
   });
   try{
    const result=await f.service.addManualReason(OWNER,CHAT,TARGET,'case','BAN');
    assert.equal(result.status,'BLOCKED_UNKNOWN');
    assert.equal(f.sends(),1);
    const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
    assert.equal(op.status,'UNKNOWN_OUTCOME');
    assert.equal(op.kind,'BAN');
    assert.equal(op.memberId,TARGET);
    assert.equal((await f.service.reconcile(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
    assert.equal(f.sends(),1,'no retry once dispatch may have happened');
   }finally{await f.close();}
  });
 }
 test(engine+' quarantines conflicting operation identity after network return',async()=>{
  const f=await fixture(engine,store=>async()=>{
   await store.transaction(s=>{s.moderationOperations.at(-1)!.kind='MUTE';});
   return 'CONFIRMED';
  });
  try{
   const result=await f.service.addManualReason(OWNER,CHAT,TARGET,'case','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.kind,'BAN','original target action must not be replaced');
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.service.reconcile(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
 test(engine+' rejects forged runtime gateway success string',async()=>{
  const f=await fixture(engine,_store=>async()=>('SENT' as RestrictionOutcome));
  try{
   const result=await f.service.addManualReason(OWNER,CHAT,TARGET,'case','BAN');
   assert.equal(result.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.store.snapshot()).moderationOperations.at(-1)?.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.service.reconcile(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
 test(engine+' altered INTENT action is cancelled before any provider dispatch',async()=>{
  const f=await fixture(engine,_store=>async()=>{throw Error('must not dispatch');});
  try{
   f.service.beforeDispatch=async()=>{await f.store.transaction(s=>{
    const op=s.moderationOperations.at(-1)!;
    assert.equal(op.status,'INTENT');
    op.kind='MUTE';
   });};
   const result=await f.service.addManualReason(OWNER,CHAT,TARGET,'case','BAN');
   assert.equal(result.status,'DENIED');
   assert.equal(f.sends(),0);
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.status,'CANCELLED');
  }finally{await f.close();}
 });
 test(engine+' altered INTENT status never starts or sends a forged confirmed operation',async()=>{
  const f=await fixture(engine,_store=>async()=>{throw Error('must not dispatch');});
  try{
   f.service.beforeDispatch=async()=>{await f.store.transaction(s=>{
    s.moderationOperations.at(-1)!.status='CONFIRMED';
   });};
   const result=await f.service.addManualReason(OWNER,CHAT,TARGET,'case','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),0);
   assert.equal((await f.store.snapshot()).moderationOperations.at(-1)?.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.service.reconcile(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' restores UNKNOWN_OUTCOME receipt when STARTED row disappears during remote await',async()=>{
  const f=await fixture(engine,store=>async()=>{
   await store.transaction(s=>{s.moderationOperations=[];});
   return 'CONFIRMED';
  });
  try{
   const result=await f.service.addManualReason(OWNER,CHAT,TARGET,'case','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   const ops=(await f.store.snapshot()).moderationOperations;
   assert.equal(ops.length,1);
   assert.equal(ops[0]!.status,'UNKNOWN_OUTCOME');
   assert.equal(ops[0]!.chatId,CHAT);
   assert.equal(ops[0]!.memberId,TARGET);
   assert.equal(ops[0]!.kind,'BAN');
   assert.equal((await f.service.reconcile(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
 test(engine+' restores blocked original target if another actor rewrites STARTED member ID',async()=>{
  const f=await fixture(engine,store=>async()=>{
   await store.transaction(s=>{s.moderationOperations.at(-1)!.memberId='301';});
   return 'FAILED_CONFIRMED';
  });
  try{
   const answer=await f.service.addManualReason(OWNER,CHAT,TARGET,'case','MUTE');
   assert.equal(answer.status,'BLOCKED_UNKNOWN');
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.memberId,TARGET);
   assert.equal(op.kind,'MUTE');
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.service.reconcile(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
 test(engine+' vanished INTENT does not issue a sanction and reserves the original case',async()=>{
  const f=await fixture(engine,_store=>async()=>{throw Error('must not send');});
  try{
   f.service.beforeDispatch=async()=>{
    await f.store.transaction(s=>{s.moderationOperations=[];});
   };
   const answer=await f.service.addManualReason(OWNER,CHAT,TARGET,'case','BAN');
   assert.equal(answer.status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),0);
   const op=(await f.store.snapshot()).moderationOperations.at(-1)!;
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal(op.memberId,TARGET);
  }finally{await f.close();}
 });
}
