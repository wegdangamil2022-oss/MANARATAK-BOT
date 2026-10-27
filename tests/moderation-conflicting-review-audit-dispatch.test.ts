import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type AuditRecord,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {moderationLedgerSafeForDispatch,moderationReviewEvidenceDigest} from '../src/moderation-review-integrity.js';
import {inspectLocalReversal,ModerationReversalPreflight} from '../src/moderation-reversal-preflight.js';
import {summarizeModerationRecovery,inspectModerationRecoveryReadOnly} from '../src/moderation-recovery-monitor.js';

const NOW=1_800_000_000_000,STALE=900_000;
const OWNER='100',BAD_CHAT='-100123',OTHER_CHAT='-100456',TARGET='300';
const options=()=>({now:NOW,staleAfterMs:STALE});
function attempt():ModerationOperation{
 return {id:'historical-private-case',chatId:BAD_CHAT,memberId:TARGET,actorId:OWNER,
  kind:'MUTE',reasonFingerprint:'PRIVATE_OPERATION_EVIDENCE',
  policyVersion:1,createdAt:NOW-5000,status:'UNKNOWN_OUTCOME',attemptGateway:'TELEGRAM_API'};
}
function reviewed(op:ModerationOperation,legacy=false):ModerationOperation{
 return {...op,review:{decision:'ACKNOWLEDGED_UNRESOLVED',reviewedBy:OWNER,
  reviewedAt:NOW-1000,policyVersion:op.policyVersion,
  ...(legacy?{}:{evidenceDigest:moderationReviewEvidenceDigest(op)})}};
}
function receipt(op:ModerationOperation,legacy=false):AuditRecord{
 return {updateKey:'owner:moderation:review:'+
   createHash('sha256').update('MODERATION:REVIEW:'+op.id).digest('hex').slice(0,32),
  actorId:OWNER,decision:'ALLOW',reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
  policyVersion:op.policyVersion,at:NOW-1000,
  ...(legacy?{}:{moderationEvidenceDigest:moderationReviewEvidenceDigest(op)})};
}
const unrelated:AuditRecord={updateKey:'transport:ordinary-update',policyVersion:1,
 decision:'ALLOW',reason:'RESPONSE_PLANNED_ONLY',at:NOW};
const evidence=(operations:ModerationOperation[],audit:AuditRecord[])=>
 ({moderationOperations:operations,audit});
const conflictCount=(report:ReturnType<typeof summarizeModerationRecovery>)=>
 Reflect.get(report,'conflictingReviewAuditOperations') as number|undefined;

test('missing audit for an annotated UNKNOWN globally blocks dispatch on every target',()=>{
 const state=evidence([reviewed(attempt())],[]);
 assert.equal(moderationLedgerSafeForDispatch(state),false);
 const r=summarizeModerationRecovery(state,options());
 assert.equal(r.untrustedReviewEvidence,1);
 assert.equal(conflictCount(r),1);
 assert.equal(r.orphanReviewAuditReceipts,0);
});
test('a matched audit key with divergent actor or evidence digest is not safe to dispatch',()=>{
 const op=attempt();
 for(const candidate of [
  {...receipt(op),actorId:'399'},
  {...receipt(op),moderationEvidenceDigest:'0'.repeat(64)},
  {...receipt(op),decision:'DENY' as const},
  {...receipt(op),at:NOW-999}
 ]){
  const state=evidence([reviewed(op)],[candidate]);
  assert.equal(moderationLedgerSafeForDispatch(state),false);
  const r=summarizeModerationRecovery(state,options());
  assert.equal(r.untrustedReviewEvidence,1);
  assert.equal(conflictCount(r),1);
 }
});
test('duplicate audit receipts referring to a still-existing UNKNOWN require global quarantine',()=>{
 const op=attempt(),a=receipt(op);
 const state=evidence([reviewed(op)],[a,{...a}]);
 assert.equal(moderationLedgerSafeForDispatch(state),false);
 assert.equal(conflictCount(summarizeModerationRecovery(state,options())),1);
 assert.equal(summarizeModerationRecovery(state,options()).orphanReviewAuditReceipts,0);
});
test('audit for unreviewed UNKNOWN must not permit a sanction in a different group',()=>{
 const op=attempt();
 const state=evidence([op],[receipt(op)]);
 assert.equal(moderationLedgerSafeForDispatch(state),false);
 assert.equal(conflictCount(summarizeModerationRecovery(state,options())),1);
});
test('bound and legacy audit reviews remain dispatch-safe for unrelated cases',()=>{
 const op=attempt();
 for(const legacy of [false,true]){
  const state=evidence([reviewed(op,legacy)],[receipt(op,legacy),unrelated]);
  assert.equal(moderationLedgerSafeForDispatch(state),true);
  const report=summarizeModerationRecovery(state,options());
  assert.equal(conflictCount(report),0);
  assert.equal(report.manualAttention,1,'unknown outcome remains locked even when reviewed');
  assert.equal(report.state,'ATTENTION_REQUIRED');
 }
});
test('unrelated audit and optional audit-free projection do not quarantine an otherwise clean ledger',()=>{
 assert.equal(moderationLedgerSafeForDispatch(evidence([], [unrelated])),true);
 assert.equal(moderationLedgerSafeForDispatch({moderationOperations:[]}),true);
 const clean=summarizeModerationRecovery(evidence([], [unrelated]),options());
 assert.equal(clean.state,'OK');
 assert.equal(conflictCount(clean),0);
});
test('untrusted audit with matching operation cannot be reclassified as an orphan',()=>{
 const op=attempt();
 const state=evidence([reviewed(op)],[{...receipt(op),actorId:'399'}]);
 assert.equal(summarizeModerationRecovery(state,options()).orphanReviewAuditReceipts,0);
 assert.equal(conflictCount(summarizeModerationRecovery(state,options())),1);
});

async function fixture(engine:'json'|'sqlite',variant:'MISSING_AUDIT'|'DUPLICATE_AUDIT'|'VALID_AUDIT'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-conflicting-review-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,BAD_CHAT,['moderation']);
 await policy.approveChat(OWNER,OTHER_CHAT,['moderation']);
 const op={...attempt(),policyVersion:policy.chatRevision(await store.snapshot(),BAD_CHAT)};
 await store.transaction(s=>{
  s.moderationOperations.push(reviewed(op));
  if(variant!=='MISSING_AUDIT'){
   s.audit.push(receipt(op));
   if(variant==='DUPLICATE_AUDIT')s.audit.push({...receipt(op)});
  }
 });
 if(engine==='sqlite')await chmod(file,0o600);
 const reopen=()=>new BotStore(file,{engine});
 return {file,store,policy,reopen,close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 for(const variant of ['MISSING_AUDIT','DUPLICATE_AUDIT'] as const){
  test(engine+' '+variant+' restored corruption prevents unrelated new BAN before provider calls',async()=>{
   const f=await fixture(engine,variant);try{
    const before=await f.store.snapshot();
    const gateway=new FakeModerationGateway();
    const reopened=f.reopen();
    const service=new ModerationService(reopened,new Policy(reopened,OWNER,()=>NOW),gateway,()=>NOW);
    const result=await service.addManualReason(OWNER,OTHER_CHAT,TARGET,'new-case','BAN');
    assert.equal(result.status,'BLOCKED_UNKNOWN');
    assert.equal(gateway.calls.length,0);
    const after=await f.store.snapshot();
    assert.deepEqual(after.moderationReasons,before.moderationReasons);
    assert.deepEqual(after.moderationOperations,before.moderationOperations);
    assert.deepEqual(after.audit,before.audit);
   }finally{await f.close();}
  });
 }
 test(engine+' inconsistent OTHER-group owner audit blocks local unban observation without remote access',async()=>{
  const f=await fixture(engine,'MISSING_AUDIT');try{
   await f.store.transaction(s=>s.moderationOperations.push({
    id:'other-confirmed',chatId:OTHER_CHAT,memberId:TARGET,actorId:OWNER,
    kind:'BAN',reasonFingerprint:'OTHER_PRIVATE_FINGERPRINT',
    policyVersion:f.policy.chatRevision(s,OTHER_CHAT),
    createdAt:NOW-1000,status:'CONFIRMED',attemptGateway:'TELEGRAM_API'
   }));
   const snap=await f.store.snapshot();
   assert.deepEqual(inspectLocalReversal(snap,f.policy,OTHER_CHAT,TARGET),
    {status:'BLOCKED_UNPROVEN'});
   let reads=0;
   const observer={observeRestriction:async()=>{reads++;return 'BAN_PRESENT' as const;}};
   const assessment=await new ModerationReversalPreflight(f.store,f.policy,observer)
    .assess(OWNER,OTHER_CHAT,TARGET);
   assert.equal(assessment.status,'BLOCKED_UNPROVEN');
   assert.equal(reads,0);
  }finally{await f.close();}
 });
 test(engine+' valid historical bound audit does not impose a global dispatch blockade',async()=>{
  const f=await fixture(engine,'VALID_AUDIT');try{
   const gateway=new FakeModerationGateway();
   const reopened=f.reopen();
   const service=new ModerationService(reopened,new Policy(reopened,OWNER,()=>NOW),gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,OTHER_CHAT,TARGET,'fresh-case','BAN');
   assert.equal(result.status,'APPLIED');
   assert.equal(gateway.calls.length,1);
  }finally{await f.close();}
 });
}
test('SQLite read-only report of missing audit shows conflict without modifying evidence',async()=>{
 const f=await fixture('sqlite','MISSING_AUDIT');try{
  const before=await readFile(f.file);
  const report=await inspectModerationRecoveryReadOnly(f.file,options());
  assert.equal(conflictCount(report),1);
  assert.equal(report.untrustedReviewEvidence,1);
  assert.equal(report.state,'ATTENTION_REQUIRED');
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
test('CLI exposes aggregate conflict, exits 2, and never leaks operation/owner or token evidence',async()=>{
 const f=await fixture('sqlite','DUPLICATE_AUDIT');try{
  await f.store.transaction(s=>{
   s.moderationOperations[0]!.createdAt=Date.now()-5000;
   const op=s.moderationOperations[0]!;
   op.review!.reviewedAt=Date.now()-500;
   op.review!.evidenceDigest=moderationReviewEvidenceDigest(op);
   for(const a of s.audit){
    a.at=op.review!.reviewedAt;
    a.moderationEvidenceDigest=moderationReviewEvidenceDigest(op);
   }
  });
  const before=await readFile(f.file);
  const child=spawnSync(process.execPath,[
   'dist/src/moderation-recovery-monitor-cli.js','--once','--state',f.file,
   '--stale-ms',String(STALE)
  ],{encoding:'utf8',timeout:15_000,env:{...process.env,
   TELEGRAM_BOT_TOKEN:'PRIVATE_BOT_SECRET',TELEGRAM_ENABLED:'false'}});
  assert.equal(child.status,2,child.stderr);
  const out=JSON.parse(child.stdout) as {conflictingReviewAuditOperations:number;state:string;untrustedReviewEvidence:number};
  assert.equal(out.conflictingReviewAuditOperations,1);
  assert.equal(out.untrustedReviewEvidence,1);
  assert.equal(out.state,'ATTENTION_REQUIRED');
  for(const secret of ['PRIVATE_BOT_SECRET',f.file,'historical-private-case',
   'PRIVATE_OPERATION_EVIDENCE',BAD_CHAT,TARGET])
   assert.equal((child.stdout+child.stderr).includes(secret),false);
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
