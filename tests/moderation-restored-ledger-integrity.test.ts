import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,type ModerationGateway} from '../src/moderation.js';
import {inspectModerationLedgerIntegrity} from '../src/moderation-review-integrity.js';
import {summarizeModerationRecovery} from '../src/moderation-recovery-monitor.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {ModerationPendingOwnerView} from '../src/moderation-pending-owner-view.js';

const OWNER='100',GROUP='-100123',TARGET='300',NOW=1_700_000_000_000;
const base=():ModerationOperation=>({id:'restored-intent',chatId:GROUP,memberId:TARGET,
 actorId:OWNER,kind:'BAN',reasonFingerprint:'opaque',policyVersion:1,
 status:'INTENT',createdAt:NOW-100});
const corruptions=[
 ['unknown operation status',(o:ModerationOperation)=>{o.status='SENT' as ModerationOperation['status'];}],
 ['non-Telegram target identity',(o:ModerationOperation)=>{o.memberId='bad';}],
 ['wrong action kind',(o:ModerationOperation)=>{o.kind='DELETE' as ModerationOperation['kind'];}],
 ['negative original timestamp',(o:ModerationOperation)=>{o.createdAt=-1;}],
 ['unbounded timestamp',(o:ModerationOperation)=>{o.createdAt=Number.MAX_SAFE_INTEGER;}],
 ['missing fingerprint',(o:ModerationOperation)=>{o.reasonFingerprint=undefined as unknown as string;}],
 ['invalid policy revision',(o:ModerationOperation)=>{o.policyVersion=0;}],
 ['unknown dispatch provenance',(o:ModerationOperation)=>{
  o.attemptGateway='UNVERIFIED_REMOTE' as NonNullable<ModerationOperation['attemptGateway']>;}],
 ['review recorded on prestart intent',(o:ModerationOperation)=>{
  o.review={decision:'ESCALATED',reviewedBy:OWNER,reviewedAt:NOW};}],
 ['unknown review decision',(o:ModerationOperation)=>{
  o.status='UNKNOWN_OUTCOME';
  o.review={decision:'UNBAN' as 'ESCALATED',reviewedBy:OWNER,reviewedAt:NOW};}],
 ['invalid review timestamp',(o:ModerationOperation)=>{
  o.status='UNKNOWN_OUTCOME';o.review={decision:'ESCALATED',reviewedBy:OWNER,reviewedAt:-1};}]
] as const;

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-invalid-ledger-'));
 const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 const valid=base();
 await store.transaction(s=>{s.moderationOperations.push(valid);});
 let reads=0,sends=0;
 const gateway:ModerationGateway={
  canRestrict:async()=>{reads++;return true;},
  isProtected:async()=>{reads++;return false;},
  setRestriction:async()=>{sends++;return 'CONFIRMED';}
 };
 const service=new ModerationService(store,policy,gateway,()=>NOW);
 return {store,policy,service,reads:()=>reads,sends:()=>sends,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('a valid legacy moderation record with no gateway provenance remains valid',()=>{
 assert.deepEqual(inspectModerationLedgerIntegrity({moderationOperations:[base()]}),
  {valid:true,malformedRows:0});
});
test('a legitimate UNKNOWN_OUTCOME owner annotation remains valid',()=>{
 const x=base();x.status='UNKNOWN_OUTCOME';
 x.review={decision:'ACKNOWLEDGED_UNRESOLVED',reviewedBy:OWNER,reviewedAt:NOW};
 assert.deepEqual(inspectModerationLedgerIntegrity({moderationOperations:[x]}),
  {valid:true,malformedRows:0});
});
test('null and non-object restored ledger rows are never trusted',()=>{
 assert.deepEqual(inspectModerationLedgerIntegrity({
  moderationOperations:[null as unknown as ModerationOperation,
   'corrupt' as unknown as ModerationOperation]}),{valid:false,malformedRows:2});
});
for(const engine of ['json','sqlite'] as const){
 for(const [name,mutate] of corruptions){
  test(engine+' restored '+name+' must not allow local reasons or outbound moderation',async()=>{
   const f=await fixture(engine);
   try{
    await f.store.transaction(s=>{mutate(s.moderationOperations[0]!);});
    const snapshot=await f.store.snapshot();
    assert.deepEqual(inspectModerationLedgerIntegrity(snapshot),
     {valid:false,malformedRows:1});
    const result=await f.service.addManualReason(OWNER,GROUP,'301','new-policy','MUTE');
    assert.equal(result.status,'BLOCKED_UNKNOWN');
    assert.equal(f.reads(),0);
    assert.equal(f.sends(),0);
    const after=await f.store.snapshot();
    assert.deepEqual(after.moderationReasons,[]);
    assert.deepEqual(after.moderationOperations,snapshot.moderationOperations);
    assert.throws(()=>summarizeModerationRecovery(snapshot,{
     now:NOW,staleAfterMs:900000}),/MODERATION_RECOVERY_INVALID_LEDGER/);
   }finally{await f.close();}
  });
 }
 test(engine+' owner views quarantine the whole ledger if a restored row is malformed',async()=>{
  const f=await fixture(engine);try{
   const pending=new ModerationPendingOwnerView(f.store,f.policy,()=>NOW);
   const unknown=new ModerationUnknownOwnerReview(f.store,f.policy,()=>NOW);
   const original=await pending.handle('mp:1:h',OWNER);
   const stale=original?.keyboard.inline_keyboard.flat()
    .find(x=>x.callback_data.startsWith('mp:1:d:'))?.callback_data;
   assert.ok(stale);
   await f.store.transaction(s=>{
    s.moderationOperations.push({...base(),id:'corrupt-status',memberId:'399',
     status:'CORRUPTED' as ModerationOperation['status']});
    s.moderationOperations.push({...base(),id:'independent-unknown',memberId:'398',
     status:'UNKNOWN_OUTCOME'});
   });
   const before=await f.store.snapshot();
   const a=await pending.handle('mp:1:h',OWNER);
   const z=await unknown.handle('mr:1:h',OWNER);
   assert.match(a?.text??'',/تالف|غير سليمة|يتطلب.*مراجعة/);
   assert.match(z?.text??'',/تالف|غير سليمة|يتطلب.*مراجعة/);
   assert.equal(a?.keyboard.inline_keyboard.flat().some(x=>x.callback_data.startsWith('mp:1:d:')),false);
   assert.equal(z?.keyboard.inline_keyboard.flat().some(x=>x.callback_data.startsWith('mr:1:d:')),false);
   assert.equal(await pending.handle(stale!,OWNER),null);
   for(const secret of [TARGET,'399','398','corrupt-status','opaque']){
    assert.equal((a?.text??'').includes(secret),false);
    assert.equal((z?.text??'').includes(secret),false);
   }
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' malformed ledger introduced during async rights check blocks dispatch atomically',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations=[]);
   let reads=0,sends=0;
   const gateway:ModerationGateway={
    canRestrict:async()=>{
     reads++;
     if(reads===1)await f.store.transaction(s=>s.moderationOperations.push({
      ...base(),id:'concurrent-invalid',status:'SENT' as ModerationOperation['status']
     }));
     return true;
    },
    isProtected:async()=>false,
    setRestriction:async()=>{sends++;return 'CONFIRMED';}
   };
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,GROUP,'301','new-rule','MUTE');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(sends,0);
   assert.deepEqual((await f.store.snapshot()).moderationReasons,[]);
  }finally{await f.close();}
 });
 test(engine+' unsupported actors cannot inspect malformed moderation state',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.moderationOperations[0]!.kind=
    'SOMETHING' as ModerationOperation['kind'];});
   assert.equal((await f.service.reconcile('400',GROUP,TARGET)).status,'DENIED');
   assert.equal(await new ModerationUnknownOwnerReview(f.store,f.policy,()=>NOW)
    .handle('mr:1:h','400'),null);
   assert.equal(await new ModerationPendingOwnerView(f.store,f.policy,()=>NOW)
    .handle('mp:1:h','400'),null);
   assert.equal(f.reads(),0);assert.equal(f.sends(),0);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' corruption after INTENT before STARTED must suppress the provider send',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    s.moderationOperations=[];
    s.moderationReasons.push({chatId:GROUP,memberId:TARGET,
     source:'MANUAL',reference:'existing',kind:'BAN',createdBy:OWNER,active:true});
   });
   let reads=0,sends=0;
   const transport:ModerationGateway={
    canRestrict:async()=>{
     reads++;
     if(reads===2)await f.store.transaction(s=>{
      s.moderationOperations.push({...base(),id:'corrupt-restoration',
       memberId:'399',status:'INVALID' as ModerationOperation['status']});
     });
     return true;
    },
    isProtected:async()=>false,
    setRestriction:async()=>{sends++;return 'CONFIRMED';}
   };
   const result=await new ModerationService(f.store,f.policy,transport,()=>NOW)
    .reconcile(OWNER,GROUP,TARGET);
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(reads,2);
   assert.equal(sends,0);
   const state=await f.store.snapshot();
   assert.equal(state.moderationReasons[0]!.active,true);
   assert.equal(state.moderationOperations.filter(o=>o.status==='INTENT').length,1);
   assert.equal(state.moderationOperations.filter(o=>(o.status as string)==='INVALID').length,1);
  }finally{await f.close();}
 });
 test(engine+' malformed restored evidence after gateway invocation never creates a false success receipt',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations=[]);
   let attempts=0;
   const transport:ModerationGateway={
    canRestrict:async()=>true,isProtected:async()=>false,
    setRestriction:async()=>{
     attempts++;
     await f.store.transaction(s=>s.moderationOperations.push({
      ...base(),id:'bad-parallel-row',memberId:'399',
      kind:'SILENCE' as ModerationOperation['kind']
     }));
     return 'CONFIRMED';
    }
   };
   const result=await new ModerationService(f.store,f.policy,transport,()=>NOW)
    .addManualReason(OWNER,GROUP,TARGET,'case','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(attempts,1);
   const state=await f.store.snapshot();
   assert.equal(state.moderationOperations.find(o=>o.memberId===TARGET)?.status,'UNKNOWN_OUTCOME');
   assert.equal(state.moderationOperations.find(o=>o.id==='bad-parallel-row')?.kind,'SILENCE');
  }finally{await f.close();}
 });
}
