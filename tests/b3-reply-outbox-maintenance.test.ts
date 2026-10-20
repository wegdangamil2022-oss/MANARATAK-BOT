import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type TelegramReplyJob} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramReplyDispatcher,type TelegramReplySender} from '../src/telegram-replies.js';
import {reviewTelegramReplyOutbox,redactFinishedTelegramReplies} from '../src/telegram-reply-maintenance.js';

const plan=(text='Sensitive <student> & course application details')=>({chatId:'300',parseMode:'HTML' as const,text});
const key=(id:number)=>'b3-webhook:bot-test:'+id;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-reply-privacy-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const same=()=>new BotStore(store.file,{engine});
 await store.snapshot();
 const insert=async(jobs:TelegramReplyJob[])=>store.transaction(s=>{s.telegramReplyJobs=jobs.map(j=>structuredClone(j));});
 const close=async()=>rm(dir,{recursive:true,force:true});
 return {dir,store,same,insert,close};
}
const populated:TelegramReplyJob[]=[
 {updateKey:key(1),status:'QUEUED',plan:plan('queued and MUST NOT disappear'),queuedAt:120_000},
 {updateKey:key(2),status:'SENDING',plan:plan('old in-flight body'),startedAt:101_000,attemptId:'attempt-sending'},
 {updateKey:key(3),status:'SENT',plan:plan('sent private body'),startedAt:99_000,messageId:77,attemptId:'attempt-sent'},
 {updateKey:key(4),status:'FAILED_CONFIRMED',plan:plan('failed delivery body'),startedAt:95_000,attemptId:'attempt-failed'},
 {updateKey:key(5),status:'UNKNOWN_OUTCOME',plan:plan('uncertain send body'),startedAt:90_000,attemptId:'attempt-unknown'},
 {updateKey:key(6),status:'SENT',messageId:88,redactedAt:120_000,attemptId:'already'}
];
for(const engine of ['json','sqlite'] as const){
 test(`B3 reply privacy ${engine}: read-only audit shows stale and unknown, no IDs/text leaked or state changes`,async()=>{
  const f=await fixture(engine);try{
   await f.insert(populated);
   const before=await f.same().snapshot();
   const report=await reviewTelegramReplyOutbox(f.same(),{now:200_000,staleAfterMs:60_000});
   assert.deepEqual(report,{asOf:200_000,total:6,queued:1,sending:1,sent:2,
    failedConfirmed:1,unknownOutcome:1,bodiesStored:5,staleQueued:1,staleSending:1,
    manualReviewRequired:2});
   assert.equal(JSON.stringify(report).includes('Sensitive'),false);
   assert.equal(JSON.stringify(report).includes('b3-webhook'),false);
   assert.equal(JSON.stringify(report).includes('300'),false);
   assert.deepEqual(await f.same().snapshot(),before);
  }finally{await f.close()}
 });
 test(`B3 reply privacy ${engine}: explicit scrub strips bodies only from non-queued and preserves immutable evidence`,async()=>{
  const f=await fixture(engine);try{
   await f.insert(populated);
   const result=await redactFinishedTelegramReplies(f.same(),{now:200_000});
   assert.deepEqual(result,{scanned:6,redacted:4,skippedQueued:1,alreadyRedacted:1,remaining:0});
   const after=await f.same().snapshot(),jobs=after.telegramReplyJobs!;
   assert.equal(jobs[0]?.plan?.text,'queued and MUST NOT disappear');
   for(const j of jobs.slice(1))assert.equal(j.plan,undefined);
   assert.equal(jobs[1]?.status,'SENDING');
   assert.equal(jobs[1]?.attemptId,'attempt-sending');
   assert.equal(jobs[3]?.status,'FAILED_CONFIRMED');
   assert.equal(jobs[4]?.status,'UNKNOWN_OUTCOME');
   assert.equal(jobs[4]?.attemptId,'attempt-unknown');
   assert.equal(jobs[2]?.messageId,77);
   assert.equal(jobs[1]?.redactedAt,200_000);
   assert.equal(jobs[5]?.redactedAt,120_000);
   assert.deepEqual(await redactFinishedTelegramReplies(f.same(),{now:210_000}),
    {scanned:6,redacted:0,skippedQueued:1,alreadyRedacted:5,remaining:0});
   assert.equal((await reviewTelegramReplyOutbox(f.same(),{now:210_000,staleAfterMs:60_000})).bodiesStored,1);
  }finally{await f.close()}
 });
 test(`B3 reply privacy ${engine}: never resend redacted SENDING or UNKNOWN receipts`,async()=>{
  const f=await fixture(engine);try{
   await f.insert(populated);
   await redactFinishedTelegramReplies(f.same(),{now:200_000});
   let calls=0;
   const sender:TelegramReplySender={send:async()=>{calls++;return {status:'CONFIRMED',messageId:32}}};
   const dispatcher=new TelegramReplyDispatcher(f.same(),new Policy(f.same(),'100'),sender);
   assert.equal((await dispatcher.dispatch(key(2))).status,'UNKNOWN_OUTCOME');
   assert.equal((await dispatcher.dispatch(key(5))).status,'UNKNOWN_OUTCOME');
   assert.equal((await dispatcher.dispatch(key(3))).status,'SENT');
   assert.equal(calls,0);
   assert.equal((await dispatcher.dispatch(key(1))).status,'CONFIRMED');
   assert.equal(calls,1);
   assert.equal((await f.same().snapshot()).telegramReplyJobs?.[0]?.plan,undefined);
  }finally{await f.close()}
 });
 test(`B3 reply privacy ${engine}: dispatcher clears queued payload atomically before outbound network effect`,async()=>{
  const f=await fixture(engine);try{
   await f.insert([{updateKey:key(9),status:'QUEUED',queuedAt:120_000,plan:plan('super secret student reply')}]);
   const sender:TelegramReplySender={send:async(savedPlan)=>{
    assert.equal(savedPlan.text,'super secret student reply');
    const live=(await f.same().snapshot()).telegramReplyJobs?.[0];
    assert.equal(live?.status,'SENDING');
    assert.equal(live?.plan,undefined);
    assert.equal(live?.redactedAt,200_000);
    return {status:'UNKNOWN_OUTCOME'};
   }};
   const dispatcher=new TelegramReplyDispatcher(f.same(),new Policy(f.same(),'100'),sender,()=>200_000);
   assert.equal((await dispatcher.dispatch(key(9))).status,'UNKNOWN_OUTCOME');
   assert.equal((await f.same().snapshot()).telegramReplyJobs?.[0]?.status,'UNKNOWN_OUTCOME');
   assert.equal((await dispatcher.dispatch(key(9))).status,'UNKNOWN_OUTCOME');
  }finally{await f.close()}
 });
 test(`B3 reply privacy ${engine}: capped cleanup never scrubs QUEUED or touches tail`,async()=>{
  const f=await fixture(engine);try{
   await f.insert(populated);
   const first=await redactFinishedTelegramReplies(f.same(),{now:200_000,maxEntries:3});
   assert.deepEqual(first,{scanned:3,redacted:2,skippedQueued:1,alreadyRedacted:0,remaining:3});
   const all=(await f.same().snapshot()).telegramReplyJobs!;
   assert.ok(all[3]?.plan);
   assert.ok(all[4]?.plan);
   assert.ok(all[0]?.plan);
  }finally{await f.close()}
 });
}
test('B3 reply privacy: reject invalid options before any data mutation and keep state identical',async()=>{
 const f=await fixture('sqlite');try{
  await f.insert(populated);
  const before=await f.store.snapshot();
  for(const opts of [
   {now:-1},{now:NaN},{now:Infinity},{now:200000,maxEntries:0},{now:200000,maxEntries:501},
   {now:200000,maxEntries:2.5},{now:200000,deleteBackups:true},{now:200000,includeBodies:true}
  ])await assert.rejects(redactFinishedTelegramReplies(f.store,opts as never),/REPLY_MAINTENANCE_INVALID_OPTIONS/);
  for(const opts of [
   {now:200000,staleAfterMs:0},{now:200000,staleAfterMs:-1},
   {now:200000,staleAfterMs:12.5},{now:200000,staleAfterMs:60000,includeContent:true}
  ])await assert.rejects(reviewTelegramReplyOutbox(f.store,opts as never),/REPLY_MAINTENANCE_INVALID_OPTIONS/);
  assert.deepEqual(await f.store.snapshot(),before);
 }finally{await f.close()}
});
test('B3 reply privacy: malformed job refuses scrub transaction and cannot erase evidence',async()=>{
 const f=await fixture('sqlite');try{
  await f.insert(populated);
  await f.store.transaction(s=>{s.telegramReplyJobs?.push({updateKey:key(77),status:'QUEUED'} as never)});
  const before=await f.store.snapshot();
  await assert.rejects(redactFinishedTelegramReplies(f.store,{now:200_000}),
   /REPLY_MAINTENANCE_INVALID_JOB/);
  assert.deepEqual(await f.store.snapshot(),before);
  await assert.rejects(reviewTelegramReplyOutbox(f.store,{now:200_000,staleAfterMs:60_000}),
   /REPLY_MAINTENANCE_INVALID_JOB/);
 }finally{await f.close()}
});
test('B3 reply privacy: concurrent scrub calls do not double-count or corrupt receipts',async()=>{
 const f=await fixture('sqlite');try{
  await f.insert(populated);
  const [a,b]=await Promise.all([
   redactFinishedTelegramReplies(f.same(),{now:200_000}),
   redactFinishedTelegramReplies(f.same(),{now:200_000})
  ]);
  assert.equal(a.redacted+b.redacted,4);
  assert.equal((await f.same().snapshot()).telegramReplyJobs?.filter(j=>j.plan).length,1);
 }finally{await f.close()}
});
test('B3 reply privacy: empty historical snapshots require no migration',async()=>{
 const f=await fixture('sqlite');try{
  assert.deepEqual(await reviewTelegramReplyOutbox(f.store,{now:200_000,staleAfterMs:60_000}),
   {asOf:200_000,total:0,queued:0,sending:0,sent:0,failedConfirmed:0,unknownOutcome:0,
    bodiesStored:0,staleQueued:0,staleSending:0,manualReviewRequired:0});
  assert.deepEqual(await redactFinishedTelegramReplies(f.store,{now:200_000}),
   {scanned:0,redacted:0,skippedQueued:0,alreadyRedacted:0,remaining:0});
 }finally{await f.close()}
});
