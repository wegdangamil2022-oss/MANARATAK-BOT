import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway,type ModerationGateway} from '../src/moderation.js';
import {moderationLedgerSafeForDispatch} from '../src/moderation-review-integrity.js';
import {summarizeModerationRecovery,inspectModerationRecoveryReadOnly} from '../src/moderation-recovery-monitor.js';
import {inspectLocalReversal} from '../src/moderation-reversal-preflight.js';
import {groupReversalInventory} from '../src/moderation-reversal-inventory.js';

const NOW=1_800_000_000_000,OWNER='100',CHAT='-100123',OTHER='-100456',
 TARGET='300',OTHER_MEMBER='399',STALE=900_000;
function op(status:ModerationOperation['status'],when=NOW+60_000,
 id='PRIVATE_FUTURE_OPERATION',chatId=OTHER):ModerationOperation{
 return {id,chatId,memberId:OTHER_MEMBER,actorId:OWNER,kind:'BAN',
 reasonFingerprint:'PRIVATE_OPERATION_FINGERPRINT',policyVersion:1,
 status,createdAt:when,attemptGateway:'TELEGRAM_API'};
}
const recovery=(rows:ModerationOperation[],now=NOW)=>summarizeModerationRecovery(
 {moderationOperations:rows,audit:[]},{now,staleAfterMs:STALE});

for(const status of ['CONFIRMED','FAILED_CONFIRMED','CANCELLED'] as const){
 test('future terminal '+status+' is not clean offline recovery or safe global dispatch',()=>{
  const state={moderationOperations:[op(status)],audit:[]};
  assert.equal(moderationLedgerSafeForDispatch(state,NOW),false);
  const r=recovery([op(status)]);
  assert.equal(r.state,'ATTENTION_REQUIRED');
  assert.equal(r.totalOperations,1);
  assert.equal(r.manualAttention,0,'terminal is not an unresolved outgoing attempt');
  assert.equal(r.clockAnomaly,1);
  assert.equal(r.distinctBlockedTargets,0);
  assert.equal(r.unknownOutcome,0);
 });
}
test('future INTENT and STARTED still get one clock anomaly per operation',()=>{
 const intent=op('INTENT');delete intent.attemptGateway;
 const rows=[intent,op('STARTED',NOW+2_000,'PRIVATE_PENDING_ID')];
 const r=recovery(rows);
 assert.equal(r.state,'ATTENTION_REQUIRED');
 assert.equal(r.clockAnomaly,2);
 assert.equal(r.manualAttention,2);
 assert.equal(r.intent,1);
 assert.equal(r.started,1);
});
test('future CONFIRMED is allowed exactly at its creation clock boundary',()=>{
 const row=op('CONFIRMED');
 assert.equal(moderationLedgerSafeForDispatch({
  moderationOperations:[row],audit:[]},NOW+60_000),true);
 const r=recovery([row],NOW+60_000);
 assert.equal(r.clockAnomaly,0);
 assert.equal(r.state,'OK');
});
test('valid past terminal histories and empty reports stay clean',()=>{
 for(const status of ['CONFIRMED','FAILED_CONFIRMED','CANCELLED'] as const){
  const row=op(status,NOW-3_000);
  assert.equal(moderationLedgerSafeForDispatch({
   moderationOperations:[row],audit:[]},NOW),true);
  const r=recovery([row]);
  assert.equal(r.state,'OK');
  assert.equal(r.clockAnomaly,0);
 }
 assert.equal(recovery([]).state,'OK');
});
test('invalid current clock fails closed instead of blessing future terminal evidence',()=>{
 const state={moderationOperations:[op('CONFIRMED',NOW-1)],audit:[]};
 assert.equal(moderationLedgerSafeForDispatch(state,Number.NaN),false);
 assert.equal(moderationLedgerSafeForDispatch(state,-1),false);
});

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-future-operation-clock-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.approveChat(OWNER,OTHER,['moderation']);
 if(engine==='sqlite')await chmod(file,0o600);
 const revisions=await store.snapshot();
 const revision=policy.chatRevision(revisions,OTHER);
 const targetRevision=policy.chatRevision(revisions,CHAT);
 const future=(status:ModerationOperation['status'],createdAt=NOW+60_000)=>({
  ...op(status,createdAt),policyVersion:revision
 });
 const confirmedTarget:ModerationOperation={
  id:'LOCAL_CONFIRMED',chatId:CHAT,memberId:TARGET,actorId:OWNER,
  kind:'BAN',reasonFingerprint:'PRIVATE_TARGET',policyVersion:targetRevision,
  status:'CONFIRMED',createdAt:NOW-10_000,attemptGateway:'TELEGRAM_API'
 };
 const inject=async(status:ModerationOperation['status']='CONFIRMED',at=NOW+60_000)=>
  store.transaction(s=>s.moderationOperations.push(future(status,at)));
 const reopened=()=>new BotStore(file,{engine});
 return {store,policy,file,reopened,inject,confirmedTarget,chat:revisions.chats.find(c=>c.id===CHAT)!,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' future CONFIRMED in another chat blocks unrelated new sanction and does not mutate evidence',async()=>{
  const f=await fixture(engine);try{
   await f.inject();
   const gateway=new FakeModerationGateway();
   const reopened=f.reopened();
   const service=new ModerationService(reopened,
    new Policy(reopened,OWNER,()=>NOW),gateway,()=>NOW);
   const before=await f.store.snapshot();
   const result=await service.addManualReason(OWNER,CHAT,TARGET,'new-ban','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
   const after=await f.store.snapshot();
   assert.deepEqual(after.moderationOperations,before.moderationOperations);
   assert.deepEqual(after.moderationReasons,before.moderationReasons);
   assert.deepEqual(after.audit,before.audit);
  }finally{await f.close();}
 });
 test(engine+' future confirmed inserted during pre-dispatch await prevents provider mutation',async()=>{
  const f=await fixture(engine);try{
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   service.beforeDispatch=async()=>{await f.inject('CONFIRMED');};
   const result=await service.addManualReason(OWNER,CHAT,TARGET,'new-ban','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
   const after=await f.store.snapshot();
   assert.equal(after.moderationOperations.filter(o=>o.status==='CONFIRMED'&&
    o.chatId===OTHER).length,1);
   // Before STARTED no provider request was possible; the intact INTENT
   // remains unresolved for operator recovery, not falsely marked as sent.
   assert.equal(after.moderationOperations.some(o=>o.memberId===TARGET&&
    (o.status==='INTENT'||o.status==='UNKNOWN_OUTCOME')),true);
  }finally{await f.close();}
 });
 test(engine+' future completed row injected AFTER STARTED blocks gateway authority callback',async()=>{
  const f=await fixture(engine);try{
   let allowed:boolean|undefined,sends=0;
   const gateway:ModerationGateway={
    canRestrict:async()=>true,isProtected:async()=>false,
    setRestriction:async(_chat,_member,_kind,verify)=>{
     await f.inject('FAILED_CONFIRMED');
     allowed=await verify?.();
     if(allowed)sends++;
     return allowed?'CONFIRMED':'UNKNOWN_OUTCOME';
    }
   };
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,CHAT,TARGET,'new-ban','BAN');
   assert.equal(allowed,false);
   assert.equal(sends,0);
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   const after=await f.store.snapshot();
   assert.equal(after.moderationOperations.some(o=>o.status==='UNKNOWN_OUTCOME'&&
    o.memberId===TARGET),true);
   assert.equal(after.moderationOperations.some(o=>o.status==='FAILED_CONFIRMED'&&
    o.chatId===OTHER),true);
  }finally{await f.close();}
 });
 test(engine+' network success cannot finalize after future completed ledger insertion',async()=>{
  const f=await fixture(engine);try{
   const gateway:ModerationGateway={
    canRestrict:async()=>true,isProtected:async()=>false,
    setRestriction:async()=>{await f.inject('CANCELLED');return 'CONFIRMED';}
   };
   const service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,CHAT,TARGET,'new-ban','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   const after=await f.store.snapshot();
   assert.equal(after.moderationOperations.some(o=>o.memberId===TARGET&&
    o.status==='UNKNOWN_OUTCOME'),true);
   assert.equal(after.moderationOperations.some(o=>o.chatId===OTHER&&
    o.status==='CANCELLED'),true);
  }finally{await f.close();}
 });
 test(engine+' owner reversal inventory does not label inspection as candidate during future terminal anomaly',async()=>{
  const f=await fixture(engine);try{
   await f.inject();
   await f.store.transaction(s=>s.moderationOperations.push(f.confirmedTarget));
   const snapshot=await f.store.snapshot();
   assert.deepEqual(inspectLocalReversal(snapshot,f.policy,CHAT,TARGET,NOW),
    {status:'BLOCKED_UNPROVEN'});
   const counts=groupReversalInventory(snapshot,f.policy,f.chat,NOW);
   assert.equal(counts.inspect,0);
   assert.equal(counts.unproven,1);
  }finally{await f.close();}
 });
}
test('SQLite read-only recovery exposes future CONFIRMED as anomaly with no evidence changes',async()=>{
 const f=await fixture('sqlite');try{
  await f.inject();
  const before=await readFile(f.file);
  const r=await inspectModerationRecoveryReadOnly(f.file,{now:NOW,staleAfterMs:STALE});
  assert.equal(r.totalOperations,1);
  assert.equal(r.manualAttention,0);
  assert.equal(r.clockAnomaly,1);
  assert.equal(r.state,'ATTENTION_REQUIRED');
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
test('SQLite CLI future terminal record is attention required and redacts private evidence',async()=>{
 const f=await fixture('sqlite');try{
  await f.inject('CONFIRMED',Date.now()+86_400_000);
  const before=await readFile(f.file);
  const child=spawnSync(process.execPath,[
   'dist/src/moderation-recovery-monitor-cli.js','--once','--state',f.file,
   '--stale-ms',String(STALE)
  ],{encoding:'utf8',timeout:15_000,env:{...process.env,
   TELEGRAM_BOT_TOKEN:'PRIVATE_TELEGRAM_TOKEN',TELEGRAM_ENABLED:'false'}});
  assert.equal(child.status,2,child.stderr);
  const r=JSON.parse(child.stdout) as {totalOperations:number;manualAttention:number;clockAnomaly:number;state:string};
  assert.equal(r.totalOperations,1);
  assert.equal(r.manualAttention,0);
  assert.equal(r.clockAnomaly,1);
  assert.equal(r.state,'ATTENTION_REQUIRED');
  for(const secret of [f.file,'PRIVATE_TELEGRAM_TOKEN','PRIVATE_FUTURE_OPERATION',
   'PRIVATE_OPERATION_FINGERPRINT',OTHER,OTHER_MEMBER]){
    assert.equal((child.stdout+child.stderr).includes(secret),false);
  }
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
