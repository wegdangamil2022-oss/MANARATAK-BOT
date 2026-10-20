import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationPurgeService, FakePurgeGateway, type PurgeEvidence} from '../src/moderation-purge.js';

const OWNER='100',EDITOR='200',OTHER='300',CHAT='-100',NOW=35*24*60*60*1000;
async function fixture(engine:'json'|'sqlite'='json') {
 const dir=await mkdtemp(join(tmpdir(),'b2-review-')),file=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 const store=new BotStore(file,{engine}),clock=()=>NOW,policy=new Policy(store,OWNER,clock),gateway=new FakePurgeGateway();
 const service=()=>new ModerationPurgeService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),gateway,clock);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 for(const messageId of [1,2,3])await service().observe({chatId:CHAT,messageId,senderKind:'USER',senderId:OTHER,
  sentAt:NOW-60_000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,
  linkedChannel:false,adminLog:false,approvedAnnouncement:false});
 async function planned(ids=3,actor=OWNER) {
  const j=await service().preview(actor,CHAT,{limit:ids});
  await service().confirm(OWNER,j.id);
  return j;
 }
 async function unknown(ids=2) {
  const j=await planned(ids);
  gateway.throwAfterDelete=true;
  assert.equal((await service().dispatchNext(j.id)).status,'UNKNOWN_OUTCOME');
  gateway.throwAfterDelete=false;
  const i=(await store.snapshot()).purgeJobs.find(x=>x.id===j.id)!.items[0]!;
  assert.ok(i.attemptId);
  return {j,i};
 }
 const proof=(i:{attemptId?:string;messageId:number},outcome:'ACKNOWLEDGED'|'FAILED_CONFIRMED'='ACKNOWLEDGED'):PurgeEvidence=>({
  evidenceId:'receipt-'+i.messageId+'-'+i.attemptId,chatId:CHAT,messageId:i.messageId,attemptId:i.attemptId!,outcome
 });
 return {dir,file,store,policy,gateway,service,unknown,planned,proof,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(`B2 evidence ${engine}: verified exact attempted mock receipt unblocks tail but never sends the attempted item twice`,async()=>{
  const f=await fixture(engine);try{
   const {j,i}=await f.unknown();
   const p=f.proof(i);f.gateway.acceptEvidence(p);
   const result=await f.service().reconcileUnknown(OWNER,j.id,i.messageId,p);
   assert.equal(result.status,'ACKNOWLEDGED');
   assert.equal(result.reconciliation?.evidenceId,p.evidenceId);
   assert.equal(result.reconciliation?.reviewedBy,OWNER);
   assert.equal((await f.service().dispatchNext(j.id)).status,'ACKNOWLEDGED');
   assert.deepEqual(f.gateway.calls.map(x=>x.messageId),[i.messageId,2]);
   const report=await f.service().reviewProgress(OWNER,j.id);
   assert.equal(report.requestAccepted,2);
   assert.equal(report.deletedConfirmed,0); // mocked API acknowledgement never proves physical deletion
   assert.equal(report.remaining,0);
   assert.equal((await f.service().dispatchNext(j.id)).status,'EMPTY');
  }finally{await f.close()}
 });

 test(`B2 evidence ${engine}: fake gateway unverifiable proof and mismatched attempt/chat/message cannot clear UNKNOWN`,async()=>{
  const f=await fixture(engine);try{
   const {j,i}=await f.unknown();
   const p=f.proof(i);
   await assert.rejects(f.service().reconcileUnknown(OWNER,j.id,i.messageId,p),/EVIDENCE_UNVERIFIED/);
   f.gateway.acceptEvidence(p);
   for(const bad of [
    {...p,attemptId:'unrelated-attempt'}, {...p,chatId:'-999'},
    {...p,messageId:111}, {...p,evidenceId:'bad\nheader'},
    {...p,evidenceId:''},{...p,outcome:'UNKNOWN_OUTCOME'}
   ]){
    await assert.rejects(f.service().reconcileUnknown(OWNER,j.id,i.messageId,bad as PurgeEvidence),/EVIDENCE_INVALID/);
   }
   assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'UNKNOWN_OUTCOME');
   assert.equal(f.gateway.calls.length,1);
  }finally{await f.close()}
 });

 test(`B2 evidence ${engine}: verified definitive non-effect is FAILED_CONFIRMED, not deleted and not automatically retried`,async()=>{
  const f=await fixture(engine);try{
   const {j,i}=await f.unknown();
   const p=f.proof(i,'FAILED_CONFIRMED');f.gateway.acceptEvidence(p);
   const r=await f.service().reconcileUnknown(OWNER,j.id,i.messageId,p);
   assert.equal(r.status,'FAILED_CONFIRMED');
   assert.equal((await f.service().dispatchNext(j.id)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.gateway.calls.length,1);
   const report=await f.service().reviewProgress(OWNER,j.id);
   assert.equal(report.confirmedFailed,1);
   assert.equal(report.deletedConfirmed,0);
  }finally{await f.close()}
 });

 test(`B2 evidence ${engine}: owner may explicitly stop UNKNOWN with reason, without claiming deletion or retrying`,async()=>{
  const f=await fixture(engine);try{
   const {j,i}=await f.unknown();
   await assert.rejects(f.service().skipForReview(OTHER,j.id,i.messageId,'manual review'),/OWNER_ONLY/);
   await assert.rejects(f.service().skipForReview(OWNER,j.id,i.messageId,' '),/INVALID_REVIEW_REASON/);
   const r=await f.service().skipForReview(OWNER,j.id,i.messageId,'External status is not independently knowable');
   assert.equal(r.status,'SKIPPED_UNVERIFIED');
   assert.equal(r.reconciliation?.reviewedBy,OWNER);
   assert.equal(r.reconciliation?.reason,'External status is not independently knowable');
   assert.equal((await f.service().dispatchNext(j.id)).status,'ACKNOWLEDGED');
   const report=await f.service().reviewProgress(OWNER,j.id);
   assert.equal(report.skippedUnverified,1);assert.equal(report.deletedConfirmed,0);
   assert.equal(f.gateway.calls.length,2);
   await assert.rejects(f.service().skipForReview(OWNER,j.id,i.messageId,'rewrite'),/NOT_REVIEWABLE/);
   const st=await f.store.snapshot();
   assert.equal(st.purgeJobs[0]!.items[0]!.reconciliation?.reason,'External status is not independently knowable');
   assert.equal(st.audit.filter(x=>x.reason==='PURGE_MANUAL_SKIP_UNVERIFIED').length,1);
  }finally{await f.close()}
 });

 test(`B2 evidence ${engine}: cancellation never authorizes new sends, but still accepts valid evidence for its uncertain attempt`,async()=>{
  const f=await fixture(engine);try{
   const {j,i}=await f.unknown();
   await f.service().cancel(OWNER,j.id);
   const p=f.proof(i);f.gateway.acceptEvidence(p);
   assert.equal((await f.service().reconcileUnknown(OWNER,j.id,i.messageId,p)).status,'ACKNOWLEDGED');
   assert.equal((await f.service().dispatchNext(j.id)).status,'CANCELLED');
   const report=await f.service().reviewProgress(OWNER,j.id);
   assert.equal(report.requestAccepted,1);
   assert.equal(report.cancelled,1);
   assert.equal(report.deletedConfirmed,0);
   assert.equal(f.gateway.calls.length,1);
  }finally{await f.close()}
 });
}

test('B2 evidence: revoke staff review rights while async verifier is running; owner can safely finish review',async()=>{
 const f=await fixture('sqlite');try{
  await f.policy.grant(OWNER,EDITOR,'chat.manage',CHAT,NOW+120_000);
  const j=await f.planned(2,EDITOR);
  f.gateway.throwAfterDelete=true;
  assert.equal((await f.service().dispatchNext(j.id)).status,'UNKNOWN_OUTCOME');
  const i=(await f.store.snapshot()).purgeJobs[0]!.items[0]!,p=f.proof(i);
  f.gateway.acceptEvidence(p);
  const verify=f.gateway.verifyEvidence.bind(f.gateway);
  f.gateway.verifyEvidence=async proof=>{
   await f.policy.revokeGrant(OWNER,EDITOR,'chat.manage',CHAT);
   return verify(proof);
  };
  await assert.rejects(f.service().reconcileUnknown(EDITOR,j.id,i.messageId,p),/REVIEW_DENIED/);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'UNKNOWN_OUTCOME');
  f.gateway.verifyEvidence=verify;
  assert.equal((await f.service().reconcileUnknown(OWNER,j.id,i.messageId,p)).status,'ACKNOWLEDGED');
 }finally{await f.close()}
});

test('B2 evidence: the same evidence ID cannot bind to a different deletion attempt',async()=>{
 const f=await fixture('sqlite');try{
  const a=await f.unknown(1);
  const p=f.proof(a.i);f.gateway.acceptEvidence(p);
  await f.service().reconcileUnknown(OWNER,a.j.id,a.i.messageId,p);
  const b=await f.service().preview(OWNER,CHAT,{limit:1,beforeMessageId:3});
  await f.service().confirm(OWNER,b.id);
  f.gateway.throwAfterDelete=true;
  assert.equal((await f.service().dispatchNext(b.id)).status,'UNKNOWN_OUTCOME');
  const second=(await f.store.snapshot()).purgeJobs.find(x=>x.id===b.id)!.items[0]!;
  const reused={...f.proof(second),evidenceId:p.evidenceId};
  f.gateway.acceptEvidence(reused);
  await assert.rejects(f.service().reconcileUnknown(OWNER,b.id,second.messageId,reused),/EVIDENCE_INVALID/);
  assert.equal((await f.store.snapshot()).purgeJobs.find(x=>x.id===b.id)!.items[0]!.status,'UNKNOWN_OUTCOME');
 }finally{await f.close()}
});

test('B2 evidence: exact receipt rejected if another reviewer has already finalized during asynchronous verification',async()=>{
 const f=await fixture();try{
  const {j,i}=await f.unknown(),p=f.proof(i);f.gateway.acceptEvidence(p);
  const verify=f.gateway.verifyEvidence.bind(f.gateway);
  f.gateway.verifyEvidence=async x=>{
   const ok=await verify(x);
   await f.service().skipForReview(OWNER,j.id,i.messageId,'Resolved by owner while gateway was waiting');
   return ok;
  };
  await assert.rejects(f.service().reconcileUnknown(OWNER,j.id,i.messageId,p),/EVIDENCE_INVALID/);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'SKIPPED_UNVERIFIED');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.close()}
});

test('B2 evidence: progress summary private to delegated reviewer or owner and not a proof of physical deletion',async()=>{
 const f=await fixture();try{
  const j=await f.planned();
  await assert.rejects(f.service().reviewProgress(EDITOR,j.id),/REVIEW_DENIED/);
  await f.policy.grant(OWNER,EDITOR,'chat.manage',CHAT,NOW+120_000);
  const s=await f.service().reviewProgress(EDITOR,j.id);
  assert.deepEqual({total:s.total,remaining:s.remaining,requestAccepted:s.requestAccepted,deletedConfirmed:s.deletedConfirmed},
   {total:3,remaining:3,requestAccepted:0,deletedConfirmed:0});
  await f.policy.revokeGrant(OWNER,EDITOR,'chat.manage',CHAT);
  await assert.rejects(f.service().reviewProgress(EDITOR,j.id),/REVIEW_DENIED/);
 }finally{await f.close()}
});
