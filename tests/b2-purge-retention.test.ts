import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationPurgeService,FakePurgeGateway} from '../src/moderation-purge.js';
const OWNER='100',STAFF='200',CHAT='-100',DAY=86_400_000,START=40*DAY;
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'b2-retention-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 let now=START;
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock),gateway=new FakePurgeGateway();
 const service=()=>new ModerationPurgeService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),gateway,clock);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 async function observe(id:number,sentAt=now-60_000){
  return service().observe({chatId:CHAT,messageId:id,senderKind:'USER',senderId:'300',sentAt,observedAt:now,
   contentType:'TEXT',hasLinks:true,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});
 }
 async function job(ids:number){
  for(let i=1;i<=ids;i++)await observe(i);
  const p=await service().preview(OWNER,CHAT,{limit:ids,senderId:'300'});
  await service().confirm(OWNER,p.id);return p;
 }
 async function unknownAndSkip(){
  const j=await job(2);
  gateway.throwAfterDelete=true;
  assert.equal((await service().dispatchNext(j.id)).status,'UNKNOWN_OUTCOME');
  gateway.throwAfterDelete=false;
  const item=(await store.snapshot()).purgeJobs[0]!.items[0]!;
  const reason='Long case note for this investigation';
  await service().skipForReview(OWNER,j.id,item.messageId,reason);
  await service().dispatchNext(j.id);
  return {j,item,reason};
 }
 async function unknownAndVerified(){
  const j=await job(2);
  gateway.throwAfterDelete=true;await service().dispatchNext(j.id);
  gateway.throwAfterDelete=false;
  const item=(await store.snapshot()).purgeJobs[0]!.items[0]!;
  const evidence={chatId:CHAT,messageId:item.messageId,attemptId:item.attemptId!,
    evidenceId:'case-evidence-unique-0123',outcome:'ACKNOWLEDGED' as const};
  gateway.acceptEvidence(evidence);
  await service().reconcileUnknown(OWNER,j.id,item.messageId,evidence);
  await service().dispatchNext(j.id);
  return {j,evidence,item};
 }
 return {dir,file,clock,store,policy,gateway,service,observe,job,unknownAndSkip,unknownAndVerified,
  now:()=>now,advance:(ms:number)=>{now+=ms},close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(`retention ${engine}: owner must preview; preview never mutates or contacts gateway`,async()=>{
  const f=await fixture(engine);try{
   await f.unknownAndSkip();
   f.advance(31*DAY);
   const before=await f.store.snapshot();
   await assert.rejects(f.service().previewRetention(STAFF),/OWNER_ONLY/);
   const plan=await f.service().previewRetention(OWNER);
   assert.equal(plan.expiredObserved,2);
   assert.equal(plan.eligibleJobs,1);
   assert.equal(plan.reasonsToRedact,1);
   assert.equal(plan.senderFiltersToRedact,1);
   assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.reconciliation?.reason,'Long case note for this investigation');
   assert.deepEqual(await f.store.snapshot(),before);
   assert.equal(f.gateway.calls.length,2);
  }finally{await f.close()}
 });

 test(`retention ${engine}: explicit compaction redacts personal review notes and metadata, preserves immutable job tombstones`,async()=>{
  const f=await fixture(engine);try{
   const {j,reason}=await f.unknownAndSkip();
   const original=await f.store.snapshot();
   assert.equal(original.purgeJobs[0]!.status,'COMPLETED');
   f.advance(31*DAY);
   const preview=await f.service().previewRetention(OWNER);
   await assert.rejects(f.service().compactRetention(STAFF,preview),/OWNER_ONLY/);
   const result=await f.service().compactRetention(OWNER,preview);
   assert.equal(result.redactedJobs,1);
   const state=await f.store.snapshot();
   assert.equal(state.rollingMessageMeta.length,0);
   assert.equal(state.purgeJobs[0]!.status,'COMPLETED');
   assert.deepEqual(state.purgeJobs[0]!.items.map(x=>x.messageId),original.purgeJobs[0]!.items.map(x=>x.messageId));
   assert.equal(state.purgeJobs[0]!.filter.senderId,undefined);
   assert.equal(state.purgeJobs[0]!.items[0]!.reconciliation?.reason,undefined);
   assert.equal(state.purgeJobs[0]!.items[0]!.attemptId,undefined);
   assert.equal(state.purgeJobs[0]!.items[0]!.metaDigest,'REDACTED');
   assert.equal(JSON.stringify(state).includes(reason),false);
   assert.equal(state.audit.some(x=>x.reason==='PURGE_RETENTION_COMPACTED'),true);
   assert.equal((await f.service().dispatchNext(j.id)).status,'EMPTY');
   assert.equal(f.gateway.calls.length,2);
  }finally{await f.close()}
 });

 test(`retention ${engine}: hashed evidence tombstone prevents proof ID reuse long after raw ID redacted`,async()=>{
  const f=await fixture(engine);try{
   const {j,evidence}=await f.unknownAndVerified();
   f.advance(31*DAY);
   await f.service().compactRetention(OWNER,await f.service().previewRetention(OWNER));
   const s=await f.store.snapshot();
   const reconciled=s.purgeJobs[0]!.items[0]!.reconciliation!;
   assert.equal(reconciled.evidenceId,undefined);
   assert.match(reconciled.evidenceDigest!,/^[0-9a-f]{64}$/);
   assert.equal(JSON.stringify(s).includes(evidence.evidenceId),false);
   // Construct a separate UNKNOWN attempt and inject a reused evidence ID.
   // The proof must fail even though its original plaintext was redacted.
   await f.observe(77);
   const more=await f.service().preview(OWNER,CHAT,{limit:1});
   await f.service().confirm(OWNER,more.id);
   f.gateway.throwAfterDelete=true;
   assert.equal((await f.service().dispatchNext(more.id)).status,'UNKNOWN_OUTCOME');
   const ii=(await f.store.snapshot()).purgeJobs.find(x=>x.id===more.id)!.items[0]!;
   const reused={...evidence,messageId:ii.messageId,attemptId:ii.attemptId!};
   f.gateway.acceptEvidence(reused);
   await assert.rejects(f.service().reconcileUnknown(OWNER,more.id,ii.messageId,reused),/EVIDENCE_INVALID/);
   assert.equal((await f.store.snapshot()).purgeJobs.find(x=>x.id===more.id)!.items[0]!.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.service().dispatchNext(j.id)).status,'EMPTY');
  }finally{await f.close()}
 });

 test(`retention ${engine}: unresolved UNKNOWN attempts are kept intact, including attemptId and original metadata fingerprint`,async()=>{
  const f=await fixture(engine);try{
   const j=await f.job(2);
   f.gateway.throwAfterDelete=true;
   assert.equal((await f.service().dispatchNext(j.id)).status,'UNKNOWN_OUTCOME');
   const before=(await f.store.snapshot()).purgeJobs[0]!.items[0]!;
   f.advance(31*DAY);
   const plan=await f.service().previewRetention(OWNER);
   assert.equal(plan.eligibleJobs,0);
   await f.service().compactRetention(OWNER,plan);
   const after=(await f.store.snapshot()).purgeJobs[0]!.items[0]!;
   assert.equal(after.attemptId,before.attemptId);
   assert.equal(after.metaDigest,before.metaDigest);
   assert.equal(after.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.service().dispatchNext(j.id)).status,'BLOCKED_UNKNOWN');
  }finally{await f.close()}
 });

 test(`retention ${engine}: stale preview cannot wipe a job updated after preview`,async()=>{
  const f=await fixture(engine);try{
   await f.unknownAndSkip();f.advance(31*DAY);
   const plan=await f.service().previewRetention(OWNER);
   await f.store.transaction(s=>{s.purgeJobs[0]!.items[0]!.reconciliation!.reason='Another documented decision';});
   await assert.rejects(f.service().compactRetention(OWNER,plan),/RETENTION_PREVIEW_STALE/);
   assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.reconciliation?.reason,'Another documented decision');
  }finally{await f.close()}
 });

 test(`retention ${engine}: review expires and cannot be replayed to erase newer changes`,async()=>{
  const f=await fixture(engine);try{
   await f.unknownAndSkip();f.advance(31*DAY);
   const plan=await f.service().previewRetention(OWNER);
   f.advance(11*60_000);
   await assert.rejects(f.service().compactRetention(OWNER,plan),/RETENTION_PREVIEW_EXPIRED/);
   const fresh=await f.service().previewRetention(OWNER);
   const first=await f.service().compactRetention(OWNER,fresh);
   assert.equal(first.redactedJobs,1);
   await assert.rejects(f.service().compactRetention(OWNER,fresh),/RETENTION_PREVIEW_STALE/);
  }finally{await f.close()}
 });
}

test('retention: SQLite independent writers cannot both consume the same preview after mutation',async()=>{
 const f=await fixture('sqlite');try{
  await f.unknownAndVerified();f.advance(31*DAY);
  const plan=await f.service().previewRetention(OWNER);
  const results=await Promise.allSettled([f.service().compactRetention(OWNER,plan),f.service().compactRetention(OWNER,plan)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
  assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='PURGE_RETENTION_COMPACTED').length,1);
 }finally{await f.close()}
});

test('retention: age is measured from the last reviewer decision, not old job creation',async()=>{
 const f=await fixture('sqlite');try{
  await f.unknownAndSkip();
  f.advance(31*DAY);
  // The original preview may have been created a month ago while its
  // human reconciliation happened only yesterday.
  await f.store.transaction(s=>{
   const i=s.purgeJobs[0]!.items[0]!;
   i.reconciliation!.at=f.now()-DAY;
  });
  const plan=await f.service().previewRetention(OWNER);
  assert.equal(plan.eligibleJobs,0);
  assert.equal(plan.expiredObserved,2);
  await f.service().compactRetention(OWNER,plan);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.reconciliation?.reason,
    'Long case note for this investigation');
 }finally{await f.close()}
});

test('retention: an already cancelled job retaining an UNKNOWN attempt cannot lose its proof identity',async()=>{
 const f=await fixture('sqlite');try{
  const j=await f.job(2);
  f.gateway.throwAfterDelete=true;
  assert.equal((await f.service().dispatchNext(j.id)).status,'UNKNOWN_OUTCOME');
  await f.service().cancel(OWNER,j.id);
  const before=(await f.store.snapshot()).purgeJobs[0]!.items[0]!;
  assert.equal(before.status,'UNKNOWN_OUTCOME');
  f.advance(31*DAY);
  const p=await f.service().previewRetention(OWNER);
  assert.equal(p.eligibleJobs,0);
  await f.service().compactRetention(OWNER,p);
  const after=(await f.store.snapshot()).purgeJobs[0]!.items[0]!;
  assert.equal(after.status,'UNKNOWN_OUTCOME');
  assert.equal(after.attemptId,before.attemptId);
  assert.equal(after.metaDigest,before.metaDigest);
  assert.equal((await f.service().dispatchNext(j.id)).status,'CANCELLED');
 }finally{await f.close()}
});

test('retention: legacy plaintext evidence in the audit key is migrated to a stable digest',async()=>{
 const f=await fixture();try{
  const {evidence}=await f.unknownAndVerified();
  await f.store.transaction(s=>{
   const old=s.audit.find(a=>a.reason==='PURGE_EVIDENCE_RECONCILED')!;
   const segments=old.updateKey.split(':');
   segments[segments.length-1]=evidence.evidenceId;
   old.updateKey=segments.join(':');
  });
  assert.equal(JSON.stringify(await f.store.snapshot()).includes(evidence.evidenceId),true);
  f.advance(31*DAY);
  await f.service().compactRetention(OWNER,await f.service().previewRetention(OWNER));
  const after=await f.store.snapshot();
  assert.equal(JSON.stringify(after).includes(evidence.evidenceId),false);
  assert.match(after.audit.find(a=>a.reason==='PURGE_EVIDENCE_RECONCILED')!.updateKey,/:[0-9a-f]{64}$/);
  assert.equal(after.purgeJobs[0]!.items[0]!.reconciliation?.evidenceId,undefined);
 }finally{await f.close()}
});

test('retention: private owner preview contains counts and digest, not reviewer notes or proof identifiers',async()=>{
 const f=await fixture();try{
  const {reason}=await f.unknownAndSkip();
  f.advance(31*DAY);
  const preview=await f.service().previewRetention(OWNER);
  assert.equal(JSON.stringify(preview).includes(reason),false);
  assert.equal(Object.keys(preview).some(k=>k==='items'||k==='messageIds'),false);
  assert.match(preview.digest,/^[0-9a-f]{64}$/);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.reconciliation?.reason,reason);
 }finally{await f.close()}
});
