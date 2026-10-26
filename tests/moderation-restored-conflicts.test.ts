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

const OWNER='100',GROUP='-100123',TARGET='301',NOW=1_700_000_000_000;
const op=(id:string,memberId:string):ModerationOperation=>({
 id,chatId:GROUP,memberId,actorId:OWNER,kind:'BAN',
 reasonFingerprint:'historic-opaque',policyVersion:1,status:'CONFIRMED',
 createdAt:NOW-100
});
const options={now:NOW,staleAfterMs:15*60*1000};

test('v0.7.93 rejects an INTENT with forged provider-send provenance',()=>{
 const invalid={...op('intent','399'),status:'INTENT' as const,
  attemptGateway:'TELEGRAM_API' as const};
 assert.deepEqual(inspectModerationLedgerIntegrity({moderationOperations:[invalid]}),
  {valid:false,malformedRows:1});
});
test('v0.7.93 rejects review time before the creation of its UNKNOWN_OUTCOME',()=>{
 const invalid={...op('unknown','399'),status:'UNKNOWN_OUTCOME' as const,
  review:{decision:'ESCALATED' as const,reviewedBy:OWNER,reviewedAt:NOW-101}};
 assert.deepEqual(inspectModerationLedgerIntegrity({moderationOperations:[invalid]}),
  {valid:false,malformedRows:1});
});
test('v0.7.93 accepts chronological valid legacy review with absent provider label',()=>{
 const valid={...op('legacy','399'),status:'UNKNOWN_OUTCOME' as const,
  review:{decision:'ESCALATED' as const,reviewedBy:OWNER,reviewedAt:NOW}};
 assert.deepEqual(inspectModerationLedgerIntegrity({moderationOperations:[valid]}),
  {valid:true,malformedRows:0});
});
test('v0.7.93 read-only recovery refuses duplicated identifiers across targets and statuses',()=>{
 const rows=[op('same-id','399'),{...op('same-id','398'),chatId:'-100789',
  status:'CANCELLED' as const}];
 assert.throws(()=>summarizeModerationRecovery({moderationOperations:rows},options),
  /MODERATION_RECOVERY_INVALID_LEDGER/);
});
test('v0.7.93 read-only recovery continues to accept separate legacy operation IDs',()=>{
 const rows=[op('first','399'),op('second','398')];
 assert.equal(summarizeModerationRecovery({moderationOperations:rows},options).state,'OK');
});

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-conflicts-'));
 const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 let reads=0,sends=0;
 let beforeRights:(()=>Promise<void>)|undefined;
 const gateway:ModerationGateway={
  canRestrict:async()=>{reads++;if(beforeRights)await beforeRights();return true;},
  isProtected:async()=>false,
  setRestriction:async()=>{sends++;return 'CONFIRMED';}
 };
 const service=new ModerationService(store,policy,gateway,()=>NOW);
 return {store,service,
  reads:()=>reads,sends:()=>sends,
  onRights:(callback:()=>Promise<void>)=>{beforeRights=callback;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' duplicate restored operation identifiers block unrelated moderation before remote reads',async()=>{
  const f=await fixture(engine);
  try{
   await f.store.transaction(s=>{
    s.moderationOperations.push(op('same-id','399'));
    s.moderationOperations.push({...op('same-id','398'),chatId:'-100789',
     status:'FAILED_CONFIRMED'});
   });
   const before=await f.store.snapshot();
   const result=await f.service.addManualReason(OWNER,GROUP,TARGET,'case','MUTE');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(f.reads(),0);
   assert.equal(f.sends(),0);
   const after=await f.store.snapshot();
   assert.deepEqual(after.moderationReasons,before.moderationReasons);
   assert.deepEqual(after.moderationOperations,before.moderationOperations);
  }finally{await f.close();}
 });
 test(engine+' collision arriving during remote rights read blocks local reason mutation',async()=>{
  const f=await fixture(engine);
  try{
   let injected=false;
   f.onRights(async()=>{
    if(injected)return;
    injected=true;
    await f.store.transaction(s=>{
     s.moderationOperations.push(op('race-id','399'));
     s.moderationOperations.push({...op('race-id','398'),status:'CANCELLED'});
    });
   });
   const result=await f.service.addManualReason(OWNER,GROUP,TARGET,'case','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),0);
   const state=await f.store.snapshot();
   assert.deepEqual(state.moderationReasons,[]);
   assert.equal(state.moderationOperations.length,2);
  }finally{await f.close();}
 });
 test(engine+' collision introduced after INTENT blocks STARTED and provider send',async()=>{
  const f=await fixture(engine);
  try{
   await f.store.transaction(s=>s.moderationReasons.push({
    chatId:GROUP,memberId:TARGET,source:'MANUAL',reference:'existing',
    kind:'BAN',createdBy:OWNER,active:true
   }));
   f.onRights(async()=>{
    if(f.reads()!==2)return;
    await f.store.transaction(s=>{
     s.moderationOperations.push(op('restored-id','399'));
     s.moderationOperations.push({...op('restored-id','398'),
      chatId:'-100789',status:'CANCELLED'});
    });
   });
   const result=await f.service.reconcile(OWNER,GROUP,TARGET);
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),0);
   const state=await f.store.snapshot();
   assert.equal(state.moderationOperations.filter(x=>x.status==='STARTED').length,0);
   assert.equal(state.moderationOperations.filter(x=>x.status==='INTENT').length,1);
   assert.equal(state.moderationReasons[0]?.active,true);
  }finally{await f.close();}
 });
}
