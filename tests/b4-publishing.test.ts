import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { FakePublicationGateway, PublicationService } from '../src/publishing.js';

const OWNER='100',PUBLISHER='200',UPLOADER='300',SOURCE='-100',DEST='-200',DEST2='-201';
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'manaratak-b4-')); const file=join(dir,'state.json');
  const store=new BotStore(file);let now=1_000;
  const clock=()=>now;
  const policy=new Policy(store,OWNER,clock);
  const education=new EducationService(store,policy,clock);
  const gateway=new FakePublicationGateway();
  const publishing=new PublicationService(store,policy,gateway,clock);
  await policy.approveChat(OWNER,SOURCE,['navigation']);
  await policy.approveChat(OWNER,DEST,['publishing']);
  await policy.approveChat(OWNER,DEST2,['publishing']);
  await policy.grant(OWNER,PUBLISHER,'content.publish',SOURCE,20_000);
  await policy.grant(OWNER,PUBLISHER,'content.publish',DEST,20_000);
  await policy.grant(OWNER,UPLOADER,'content.upload',SOURCE,20_000);
  await education.createCategory(OWNER,{id:'grants',scope:SOURCE,title:'المنح',order:1});
  const imp=await education.submitText(UPLOADER,SOURCE,'ADMIN_WEB','csv','scholarships.csv',
    'university,title,cycle,degree,seats\nA University,Scholarship A,2026,Master,3\nB University,Scholarship B,2026,Bachelor,4\n');
  await education.approveCandidate(PUBLISHER,imp.id,0,'grants');
  await education.approveCandidate(PUBLISHER,imp.id,1,'grants');
  const first=await education.publishCandidate(PUBLISHER,imp.id,0,'grants');
  const second=await education.publishCandidate(PUBLISHER,imp.id,1,'grants');
  return {dir,file,store,policy,education,gateway,publishing,first,second,imp,clock,setTime:(v:number)=>{now=v;},dispose:()=>rm(dir,{force:true,recursive:true})};
}

test('B4: drafts preview exact approved text without side effects; uploader cannot stage or approve',async()=>{
  const f=await fixture();try {
    await assert.rejects(f.publishing.draft(UPLOADER,SOURCE,DEST,[f.first.id]),/PUBLISH_DENIED/);
    await assert.rejects(f.publishing.draft(PUBLISHER,SOURCE,DEST2,[f.first.id]),/PUBLISH_DENIED/);
    const c=await f.publishing.draft(PUBLISHER,SOURCE,DEST,[f.first.id,f.second.id]);
    assert.equal(c.status,'DRAFT');assert.equal(c.previews.length,2);
    assert.match(c.previews[0]!.text,/Scholarship A/);
    assert.equal(c.previews[0]!.text.includes('reviewedBy'),false);
    assert.equal((await f.store.snapshot()).deliveries.length,0);
    await assert.rejects(f.publishing.approve(UPLOADER,c.id),/PUBLISH_DENIED/);
    const approved=await f.publishing.approve(PUBLISHER,c.id);
    assert.equal(approved.status,'APPROVED');assert.equal((await f.store.snapshot()).deliveries.length,2);
    assert.equal(f.gateway.calls.length,0);
  }finally{await f.dispose();}
});

test('B4: destination must have explicit publishing scope, not merely bot presence or navigation',async()=>{
  const f=await fixture();try{
    await f.policy.approveChat(OWNER,DEST2,['navigation']);
    await assert.rejects(f.publishing.draft(OWNER,SOURCE,DEST2,[f.first.id]),/DESTINATION_DENIED/);
    await f.policy.revokeChat(OWNER,DEST);
    await assert.rejects(f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]),/DESTINATION_DENIED/);
  }finally{await f.dispose();}
});

test('B4: duplicate resource IDs rejected; resource cannot be sent twice across campaigns to one destination',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.publishing.draft(PUBLISHER,SOURCE,DEST,[f.first.id,f.first.id]),/DUPLICATE_ITEM/);
  const a=await f.publishing.draft(PUBLISHER,SOURCE,DEST,[f.first.id]);
  const b=await f.publishing.draft(PUBLISHER,SOURCE,DEST,[f.first.id]);
  await f.publishing.approve(PUBLISHER,a.id);
  await assert.rejects(f.publishing.approve(PUBLISHER,b.id),/DELIVERY_ALREADY_RESERVED/);
  assert.equal((await f.store.snapshot()).deliveries.length,1);
 }finally{await f.dispose();}
});

test('B4: approval fails after resource archive or destination policy revision, never sends stale content',async()=>{
 const f=await fixture();try{
  const a=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);
  await f.education.archiveResource(OWNER,f.first.id);
  await assert.rejects(f.publishing.approve(OWNER,a.id),/PREVIEW_STALE/);
  const b=await f.publishing.draft(OWNER,SOURCE,DEST,[f.second.id]);
  await f.policy.approveChat(OWNER,DEST,['publishing']);
  await assert.rejects(f.publishing.approve(OWNER,b.id),/PREVIEW_STALE/);
 }finally{await f.dispose();}
});

test('B4: confirmed delivery stores a real mock receipt and is not resent after restart',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(PUBLISHER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(PUBLISHER,c.id);
  const delivered=await f.publishing.dispatchNext(c.id);
  assert.equal(delivered.status,'SENT');assert.equal(f.gateway.calls.length,1);
  assert.match(delivered.messageId??'',/^mock-message-/);
  const restarted=new PublicationService(new BotStore(f.file),new Policy(new BotStore(f.file),OWNER,f.clock),f.gateway,f.clock);
  assert.equal((await restarted.dispatchNext(c.id)).status,'EMPTY');
  assert.equal(f.gateway.calls.length,1);
  assert.equal((await f.store.snapshot()).campaigns[0]!.status,'COMPLETED');
 }finally{await f.dispose();}
});

test('B4: concurrent dispatch cannot send one delivery twice',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(OWNER,c.id);
  await Promise.all([f.publishing.dispatchNext(c.id),f.publishing.dispatchNext(c.id)]);
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.dispose();}
});

test('B4: transport timeout stays UNKNOWN_OUTCOME; retry and cross-campaign duplicates blocked',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(OWNER,c.id);
  f.gateway.throwAfterSend=true;
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'UNKNOWN_OUTCOME');
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'EMPTY');
  await assert.rejects(f.publishing.retryConfirmedFailure(OWNER,c.id,f.first.id),/NOT_CONFIRMED_FAILED/);
  const other=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);
  await assert.rejects(f.publishing.approve(OWNER,other.id),/DELIVERY_ALREADY_RESERVED/);
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.dispose();}
});

test('B4: after process crash, stale SENDING is UNKNOWN and is never automatically retried',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(OWNER,c.id);
  await f.store.transaction(s=>{s.deliveries[0]!.status='SENDING';s.deliveries[0]!.attemptId='unresolved';});
  const restarted=new PublicationService(new BotStore(f.file),new Policy(new BotStore(f.file),OWNER,f.clock),f.gateway,f.clock);
  assert.equal(await restarted.recoverPending(),1);
  assert.equal((await restarted.dispatchNext(c.id)).status,'EMPTY');
  assert.equal((await f.store.snapshot()).deliveries[0]!.status,'UNKNOWN_OUTCOME');
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.dispose();}
});

test('B4: confirmed hard failure is retried only after explicit authorization',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(OWNER,c.id);
  f.gateway.outcome='FAILED_CONFIRMED';
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'FAILED_CONFIRMED');
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'EMPTY');
  await assert.rejects(f.publishing.retryConfirmedFailure(UPLOADER,c.id,f.first.id),/PUBLISH_DENIED/);
  await f.publishing.retryConfirmedFailure(OWNER,c.id,f.first.id);
  f.gateway.outcome='SENT';
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'SENT');
  assert.equal(f.gateway.calls.length,2);
 }finally{await f.dispose();}
});

test('B4: delayed campaigns require due time and respect pause/resume/cancel',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id,f.second.id],5_000);await f.publishing.approve(OWNER,c.id);
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'NOT_DUE');
  f.setTime(6_000);
  await f.publishing.pause(OWNER,c.id);
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'PAUSED');
  await f.publishing.resume(OWNER,c.id);
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'SENT');
  await f.publishing.cancel(OWNER,c.id);
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'CANCELLED');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.dispose();}
});

test('B4: revoking publisher rights during dispatch denies side effect despite prior approval',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(PUBLISHER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(PUBLISHER,c.id);
  f.publishing.beforeSend=async()=>{await f.policy.revokeGrant(OWNER,PUBLISHER,'content.publish',DEST);};
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.dispose();}
});

test('B4: loss of bot posting rights blocks publication and does not assume delivery',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(OWNER,c.id);
  f.gateway.canPostHere=false;
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.dispose();}
});

test('B4: UNKNOWN reconciliation demands unique provider verified evidence and cannot use text matches',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(OWNER,c.id);
  f.gateway.throwAfterSend=true;
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'UNKNOWN_OUTCOME');
  const d=(await f.store.snapshot()).deliveries[0]!;
  await assert.rejects(f.publishing.reconcileUnknown(OWNER,d.id,{attemptId:d.attemptId!,messageId:'some-message',destination:DEST}),/UNVERIFIED_EVIDENCE/);
  const receipt=f.gateway.getReceipt(d.attemptId!)!;
  await assert.rejects(f.publishing.reconcileUnknown(UPLOADER,d.id,receipt),/PUBLISH_DENIED/);
  const confirmed=await f.publishing.reconcileUnknown(OWNER,d.id,receipt);
  assert.equal(confirmed.status,'SENT');
  assert.equal((await f.store.snapshot()).deliveries[0]!.status,'SENT');
 }finally{await f.dispose();}
});

test('B4: migrated v4 state preserves B3 resources and gets empty B4 ledgers',async()=>{
 const f=await fixture();try{
  const old=await f.store.snapshot() as unknown as Record<string,unknown>;
  old.schemaVersion=4;delete old.campaigns;delete old.deliveries;
  await writeFile(f.file,JSON.stringify(old));
  const restored=await (new BotStore(f.file)).snapshot();
  assert.equal(restored.schemaVersion,5);
  assert.equal(restored.educationResources.length,2);
  assert.deepEqual(restored.campaigns,[]);
  assert.deepEqual(restored.deliveries,[]);
 }finally{await f.dispose();}
});

test('B4: only one in-flight item per campaign, maintaining preview order',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id,f.second.id]);await f.publishing.approve(OWNER,c.id);
  await f.store.transaction(s=>{s.deliveries[0]!.status='SENDING';s.deliveries[0]!.attemptId='request-one';});
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'EMPTY');
  assert.equal(f.gateway.calls.length,0);
  const changed=await f.publishing.recoverPending();assert.equal(changed,1);
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'EMPTY');
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.dispose();}
});

test('B4: pre-send resource archive blocks queued publication and maintains approved preview',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(OWNER,c.id);
  await f.education.archiveResource(OWNER,f.first.id);
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,0);
  assert.equal((await f.store.snapshot()).campaigns[0]!.status,'PAUSED');
  await assert.rejects(f.publishing.resume(OWNER,c.id),/PREVIEW_STALE/);
 }finally{await f.dispose();}
});

test('B4: manual skip is recorded separately and never treated as verified publication',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id,f.second.id]);await f.publishing.approve(OWNER,c.id);
  const d=(await f.store.snapshot()).deliveries[0]!;
  await assert.rejects(f.publishing.markManuallySkipped(UPLOADER,d.id,'old post may exist'),/PUBLISH_DENIED/);
  await f.publishing.markManuallySkipped(OWNER,d.id,'مراجعة سابقة غير موثقة');
  const s=await f.store.snapshot();assert.equal(s.deliveries[0]!.status,'SKIPPED');
  assert.equal(s.deliveries[0]!.messageId,undefined);
  assert.equal((await f.publishing.dispatchNext(c.id)).status,'SENT');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.dispose();}
});

test('B4: delivery result UNKNOWN cannot be marked as manually skipped to avoid duplicates',async()=>{
 const f=await fixture();try{
  const c=await f.publishing.draft(OWNER,SOURCE,DEST,[f.first.id]);await f.publishing.approve(OWNER,c.id);
  f.gateway.outcome='UNKNOWN_OUTCOME';
  await f.publishing.dispatchNext(c.id);
  const d=(await f.store.snapshot()).deliveries[0]!;
  await assert.rejects(f.publishing.markManuallySkipped(OWNER,d.id,'skip after timeout'),/REVIEW_REQUIRED/);
  assert.equal(d.status,'UNKNOWN_OUTCOME');
 }finally{await f.dispose();}
});

test('B4: owner can review a draft after original editor loses a grant; future sending rechecks approver',async()=>{
 const f=await fixture();try {
   const c=await f.publishing.draft(PUBLISHER,SOURCE,DEST,[f.first.id]);
   await f.policy.revokeGrant(OWNER,PUBLISHER,'content.publish',SOURCE);
   const approved=await f.publishing.approve(OWNER,c.id);
   assert.equal(approved.approvedBy,OWNER);
   assert.equal((await f.publishing.dispatchNext(c.id)).status,'SENT');
 }finally{await f.dispose();}
});
