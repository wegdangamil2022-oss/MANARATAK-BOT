import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway,type ModerationGateway} from '../src/moderation.js';

const NOW=1_800_000_000_000,DAY=86_400_000;
const OWNER='100',CHAT='-100123',MEMBER='300',OTHER='301';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-history-race-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 const revision=policy.chatRevision(await store.snapshot(),CHAT);
 const op=(id:string,kind:'BAN'|'MUTE',createdAt:number,memberId=MEMBER):
 ModerationOperation=>({
  id,chatId:CHAT,memberId,actorId:OWNER,kind,
  reasonFingerprint:'PRIVATE_HISTORY_FINGERPRINT',
  policyVersion:revision,status:'CONFIRMED',createdAt,
  attemptGateway:'TELEGRAM_API'
 });
 const prior=async(...entries:ModerationOperation[])=>
  store.transaction(s=>{s.moderationOperations.push(...entries);});
 return {store,policy,op,prior,file,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' older restored array tail cannot cause duplicate BAN when latest confirmed is BAN',async()=>{
  const f=await fixture(engine);try{
   await f.prior(f.op('latest-ban','BAN',NOW-2*DAY),
    f.op('old-mute','MUTE',NOW-3*DAY));
   const before=(await f.store.snapshot()).moderationOperations;
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,CHAT,MEMBER,'ban-reason','BAN');
   assert.equal(result.status,'NO_CHANGE');
   assert.equal(gateway.calls.length,0,'reordering the restored array must not trigger a duplicate sanction');
   assert.deepEqual((await f.store.snapshot()).moderationOperations,before);
  }finally{await f.close();}
 });
 test(engine+' older array tail cannot suppress MUTE when later confirmed BAN conflicts with desired state',async()=>{
  const f=await fixture(engine);try{
   await f.prior(f.op('latest-ban','BAN',NOW-2*DAY),
    f.op('old-mute','MUTE',NOW-3*DAY));
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,CHAT,MEMBER,'mute-reason','MUTE');
   assert.equal(result.status,'APPLIED');
   assert.deepEqual(gateway.calls.map(x=>x.kind),['MUTE']);
   assert.equal((await f.store.snapshot()).moderationOperations.at(-1)?.kind,'MUTE');
  }finally{await f.close();}
 });
 test(engine+' equal latest CONFIRMED timestamps are ambiguous, not authority to send or skip',async()=>{
  const f=await fixture(engine);try{
   await f.prior(f.op('same-ban','BAN',NOW-2*DAY),
    f.op('same-mute','MUTE',NOW-2*DAY));
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,CHAT,MEMBER,'ban-reason','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
   assert.equal((await f.store.snapshot()).moderationOperations.length,2,
    'never invent a new INTENT for unresolved local ordering');
  }finally{await f.close();}
 });
 test(engine+' parallel CONFIRMED insertion for same target before STARTED invalidates prepared intent',async()=>{
  const f=await fixture(engine);try{
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   service.beforeDispatch=async()=>{
    await f.prior(f.op('parallel-confirmed','BAN',NOW-1));
   };
   const result=await service.addManualReason(OWNER,CHAT,MEMBER,'new-ban','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations.find(o=>o.id==='parallel-confirmed')?.status,'CONFIRMED');
   assert.equal(s.moderationOperations.some(o=>o.memberId===MEMBER&&
    o.status==='UNKNOWN_OUTCOME'),true,'original target remains quarantined');
  }finally{await f.close();}
 });
 test(engine+' parallel same-target record after STARTED invalidates gateway authority callback',async()=>{
  const f=await fixture(engine);try{
   let authority:boolean|undefined;
   let sends=0;
   const gateway:ModerationGateway={
    canRestrict:async()=>true,isProtected:async()=>false,
    setRestriction:async(_chat,_member,_kind,verify)=>{
     await f.prior(f.op('parallel-confirmed','BAN',NOW-1));
     authority=await verify?.();
     if(authority)sends++;
     return authority?'CONFIRMED':'UNKNOWN_OUTCOME';
    }
   };
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,CHAT,MEMBER,'new-ban','BAN');
   assert.equal(authority,false);
   assert.equal(sends,0);
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal((await f.store.snapshot()).moderationOperations.some(o=>
    o.memberId===MEMBER&&o.status==='UNKNOWN_OUTCOME'),true);
  }finally{await f.close();}
 });
 test(engine+' network CONFIRMED cannot finalize if same-target history changed after STARTED',async()=>{
  const f=await fixture(engine);try{
   const gateway:ModerationGateway={
    canRestrict:async()=>true,isProtected:async()=>false,
    setRestriction:async()=>{await f.prior(f.op('parallel-confirmed','MUTE',NOW-1));return 'CONFIRMED';}
   };
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,CHAT,MEMBER,'new-ban','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations.find(o=>o.id==='parallel-confirmed')?.status,'CONFIRMED');
   assert.equal(s.moderationOperations.some(o=>o.memberId===MEMBER&&o.kind==='BAN'&&
    o.status==='UNKNOWN_OUTCOME'),true);
  }finally{await f.close();}
 });
 test(engine+' unrelated target history remains independent while a valid intent awaits rights',async()=>{
  const f=await fixture(engine);try{
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   service.beforeDispatch=async()=>{
    await f.prior(f.op('other-confirmed','BAN',NOW-1,OTHER));
   };
   const result=await service.addManualReason(OWNER,CHAT,MEMBER,'new-ban','BAN');
   assert.equal(result.status,'APPLIED');
   assert.equal(gateway.calls.length,1);
  }finally{await f.close();}
 });
}
