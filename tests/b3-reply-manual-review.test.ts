import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type TelegramReplyJob} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramReplyDispatcher,type TelegramReplySender} from '../src/telegram-replies.js';
import {recordTelegramReplyManualReview,reviewTelegramReplyOutbox}
 from '../src/telegram-reply-maintenance.js';

const key=(n:number)=>'b3-webhook:bot-test:'+n;
const jobs:TelegramReplyJob[]=[
 {updateKey:key(1),status:'UNKNOWN_OUTCOME',attemptId:'attempt-1',startedAt:10_000,redactedAt:10_000},
 {updateKey:key(2),status:'SENDING',attemptId:'attempt-2',startedAt:150_000,redactedAt:150_000},
 {updateKey:key(3),status:'SENDING',attemptId:'attempt-3',startedAt:100_000,redactedAt:100_000},
 {updateKey:key(4),status:'QUEUED',queuedAt:10_000,
  plan:{chatId:'300',parseMode:'HTML',text:'Sensitive queued body'}},
 {updateKey:key(5),status:'SENT',attemptId:'attempt-5',messageId:55},
 {updateKey:key(6),status:'FAILED_CONFIRMED',attemptId:'attempt-6'}
];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-manual-review-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 await store.transaction(s=>{s.telegramReplyJobs=structuredClone(jobs);});
 return {store,other:()=>new BotStore(store.file,{engine}),
  owner:new Policy(store,'100'),close:()=>rm(dir,{force:true,recursive:true})};
}
const args=(updateKey=key(1),attemptId='attempt-1')=>({
 actorId:'100',updateKey,attemptId,decision:'ACKNOWLEDGED_UNRESOLVED' as const,
 now:200_000,staleAfterMs:60_000
});
for(const engine of ['json','sqlite'] as const){
 test('B3 manual review '+engine+': owner records unresolved outcome without altering delivery receipt',async()=>{
  const f=await fixture(engine);try{
   const before=(await f.other().snapshot()).telegramReplyJobs!;
   assert.deepEqual(await recordTelegramReplyManualReview(f.other(),f.owner,args()),{result:'RECORDED'});
   const after=(await f.other().snapshot()).telegramReplyJobs!;
   assert.deepEqual(after[0]?.manualReview,{
    decision:'ACKNOWLEDGED_UNRESOLVED',reviewedBy:'100',reviewedAt:200_000,
    attemptId:'attempt-1'});
   assert.equal(after[0]?.status,'UNKNOWN_OUTCOME');
   assert.equal(after[0]?.attemptId,'attempt-1');
   assert.equal(after[0]?.startedAt,10_000);
   assert.deepEqual(after.slice(1),before.slice(1));
   assert.equal(after[0]?.plan,undefined);
  }finally{await f.close();}
 });
 test('B3 manual review '+engine+': exact repeated approval is idempotent; changed decision cannot overwrite',async()=>{
  const f=await fixture(engine);try{
   assert.deepEqual(await recordTelegramReplyManualReview(f.store,f.owner,args()),{result:'RECORDED'});
   const before=await f.other().snapshot();
   assert.deepEqual(await recordTelegramReplyManualReview(f.other(),f.owner,{...args(),now:220_000}),
    {result:'ALREADY_RECORDED'});
   await assert.rejects(recordTelegramReplyManualReview(f.other(),f.owner,
    {...args(),decision:'ESCALATED'}),/REPLY_REVIEW_ALREADY_RECORDED/);
   assert.deepEqual(await f.other().snapshot(),before);
  }finally{await f.close();}
 });
 test('B3 manual review '+engine+': only owner may review; no delegated role or forged selector',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   await assert.rejects(recordTelegramReplyManualReview(f.store,f.owner,{...args(),actorId:'900'}),
    /OWNER_ONLY/);
   await assert.rejects(recordTelegramReplyManualReview(f.store,f.owner,{...args(),actorId:''}),
    /OWNER_ONLY/);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B3 manual review '+engine+': in-flight send needs to be stale before owner may label it',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(recordTelegramReplyManualReview(f.store,f.owner,args(key(2),'attempt-2')),
    /REPLY_REVIEW_NOT_STALE/);
   assert.equal((await f.other().snapshot()).telegramReplyJobs?.[1]?.manualReview,undefined);
   assert.deepEqual(await recordTelegramReplyManualReview(f.other(),f.owner,
    {...args(key(3),'attempt-3'),decision:'ESCALATED'}),{result:'RECORDED'});
   const job=(await f.other().snapshot()).telegramReplyJobs?.[2];
   assert.equal(job?.status,'SENDING');
   assert.equal(job?.manualReview?.decision,'ESCALATED');
  }finally{await f.close();}
 });
 test('B3 manual review '+engine+': mismatched attempt, nonambiguous state and missing record fail closed',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   for(const p of [
    args(key(1),'different'),
    args(key(4),'unused'),args(key(5),'attempt-5'),args(key(6),'attempt-6'),
    args(key(999),'attempt-999')
   ])await assert.rejects(recordTelegramReplyManualReview(f.other(),f.owner,p),
    /REPLY_REVIEW_(ATTEMPT_MISMATCH|NOT_REVIEWABLE|NOT_FOUND)/);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B3 manual review '+engine+': count-only backlog separates reviewed from awaiting first review',async()=>{
  const f=await fixture(engine);try{
   await recordTelegramReplyManualReview(f.store,f.owner,args());
   await recordTelegramReplyManualReview(f.store,f.owner,
    {...args(key(3),'attempt-3'),decision:'ESCALATED'});
   const before=await f.other().snapshot();
   const report=await reviewTelegramReplyOutbox(f.other(),{now:200_000,staleAfterMs:60_000});
   assert.equal(report.manualReviewRequired,3);
   assert.equal(report.reviewedUnresolved,2);
   assert.equal(report.awaitingFirstReview,1);
   for(const value of ['attempt-1','bot-test','Sensitive','300','100']){
    assert.equal(JSON.stringify(report).includes(value),false);
   }
   assert.deepEqual(await f.other().snapshot(),before);
  }finally{await f.close();}
 });
 test('B3 manual review '+engine+': recorded acknowledgement does not permit automatic send replay',async()=>{
  const f=await fixture(engine);try{
   await recordTelegramReplyManualReview(f.store,f.owner,args());
   await recordTelegramReplyManualReview(f.store,f.owner,args(key(3),'attempt-3'));
   let sent=0;
   const sender:TelegramReplySender={send:async()=>{sent++;return {status:'CONFIRMED',messageId:100};}};
   const d=new TelegramReplyDispatcher(f.other(),f.owner,sender);
   assert.equal((await d.dispatch(key(1))).status,'UNKNOWN_OUTCOME');
   assert.equal((await d.dispatch(key(3))).status,'UNKNOWN_OUTCOME');
   assert.equal(sent,0);
  }finally{await f.close();}
 });
}
test('B3 manual review: invalid input cannot persist extra text, provider details or unsafe time',async()=>{
 const f=await fixture('sqlite');try{
  const before=await f.store.snapshot();
  const cases=[
   {...args(),notes:'Private student text'}, {...args(),proofUrl:'https://t.me/secret'},
   {...args(),decision:'SENT'}, {...args(),now:-1}, {...args(),now:NaN},
   {...args(),staleAfterMs:1},{...args(),staleAfterMs:60_000.2},
   {...args(),attemptId:''},{...args(),updateKey:'../../outside'}
  ];
  for(const input of cases)await assert.rejects(
   recordTelegramReplyManualReview(f.store,f.owner,input as never),/REPLY_REVIEW_INVALID_OPTIONS/);
  assert.deepEqual(await f.store.snapshot(),before);
 }finally{await f.close();}
});
test('B3 manual review: concurrent owners cannot write two different decisions',async()=>{
 const f=await fixture('sqlite');try{
  const outcomes=await Promise.allSettled([
   recordTelegramReplyManualReview(f.store,f.owner,args()),
   recordTelegramReplyManualReview(f.other(),f.owner,{...args(),decision:'ESCALATED'})
  ]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
  const job=(await f.other().snapshot()).telegramReplyJobs?.[0];
  assert.ok(['ESCALATED','ACKNOWLEDGED_UNRESOLVED'].includes(job?.manualReview?.decision??''));
  assert.equal(job?.status,'UNKNOWN_OUTCOME');
 }finally{await f.close();}
});
test('B3 manual review: malformed ledger or forged existing review blocks mutation entirely',async()=>{
 const f=await fixture('sqlite');try{
  await f.store.transaction(s=>{
   s.telegramReplyJobs?.push({updateKey:key(90),status:'SENT',
    manualReview:{decision:'ESCALATED',attemptId:'x',reviewedBy:'999',reviewedAt:1}} as never);
  });
  const before=await f.store.snapshot();
  await assert.rejects(recordTelegramReplyManualReview(f.store,f.owner,args()),
   /REPLY_REVIEW_INVALID_JOB/);
  assert.deepEqual(await f.store.snapshot(),before);
 }finally{await f.close();}
});
