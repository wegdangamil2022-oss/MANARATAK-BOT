import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type ModerationOperation,type AuditRecord} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {inspectModerationLedgerIntegrity,moderationOwnerReviewAuditConsistency}
 from '../src/moderation-review-integrity.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',GROUP='-100123',OTHER_GROUP='-100987',TARGET='300',NOW=1_700_000_000_000;
const storage=['json','sqlite'] as const;
// The old persisted contract has no binding fields yet; RED must compile
// against the unpatched version, so inspect optional additions dynamically.
const evidenceDigest=(v:unknown):unknown=>
 v&&typeof v==='object'?(v as Record<string,unknown>).evidenceDigest:undefined;
const setBinding=(v:unknown,value?:string)=>{
 const row=v as Record<string,unknown>;
 if(value===undefined)delete row.evidenceDigest;
 else row.evidenceDigest=value;
};
const setAuditBinding=(v:unknown,value?:string)=>{
 const row=v as Record<string,unknown>;
 if(value===undefined)delete row.moderationEvidenceDigest;
 else row.moderationEvidenceDigest=value;
};

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-identity-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 await policy.approveChat(OWNER,OTHER_GROUP,['moderation']);
 const revision=(await store.snapshot()).chats.find(x=>x.id===GROUP)!.version;
 await store.transaction(s=>s.moderationOperations.push({
  id:'case-immutable',chatId:GROUP,memberId:TARGET,actorId:OWNER,
  kind:'BAN',reasonFingerprint:'private-reason',policyVersion:revision,
  status:'UNKNOWN_OUTCOME',createdAt:NOW-100,attemptGateway:'TELEGRAM_API'
 }));
 const view=()=>new ModerationUnknownOwnerReview(new BotStore(file,{engine}),policy,()=>NOW+30);
 const choose=(screen:Awaited<ReturnType<ModerationUnknownOwnerReview['handle']>>,prefix:string)=>{
  const found=screen?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith(prefix));
  assert.ok(found,'missing '+prefix);return found.callback_data;
 };
 const home=()=>view().handle('mr:1:h',OWNER);
 const issue=async()=>{
  const list=await home();
  const details=await view().handle(choose(list,'mr:1:d:'),OWNER);
  const confirmPreview=await view().handle(choose(details,'mr:1:v:'),OWNER);
  return choose(confirmPreview,'c_');
 };
 const annotate=async()=>{
  const token=await issue();
  assert.ok(await view().handle(token,OWNER),'local review accepted');
  const s=await store.snapshot();
  assert.equal(s.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
  return token;
 };
 const checked=async()=>{
  const list=await home();
  const selectors=list?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mr:1:d:'))??[];
  return {list,selectors};
 };
 const assertSafe=async()=>{
  const s=await store.snapshot(),gateway=new FakeModerationGateway();
  const service=new ModerationService(store,policy,gateway,()=>NOW+30);
  assert.equal((await service.reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
  assert.equal(gateway.calls.length,0);
  return s;
 };
 return {store,policy,view,home,issue,annotate,checked,assertSafe,
  close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of storage){
 test(engine+' newly confirmed review binds original attempt evidence into review and audit',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();
   const s=await f.store.snapshot(),op=s.moderationOperations[0]!;
   const receipt=s.audit.find(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED');
   assert.ok(receipt);
   assert.match(String(evidenceDigest(op.review)??''),/^[a-f0-9]{64}$/);
   assert.equal((receipt as unknown as Record<string,unknown>).moderationEvidenceDigest,evidenceDigest(op.review));
   assert.equal(moderationOwnerReviewAuditConsistency(s,op),'REVIEWED');
   assert.equal((await f.checked()).selectors.length,1);
   await f.assertSafe();
  }finally{await f.close();}
 });
 for(const [name,change] of [
  ['member identity',(o:ModerationOperation)=>{o.memberId='301';}],
  ['operator identity',(o:ModerationOperation)=>{o.actorId='399';}],
  ['sanction kind',(o:ModerationOperation)=>{o.kind='MUTE';}],
  ['reason fingerprint',(o:ModerationOperation)=>{o.reasonFingerprint='different-reason';}],
  ['attempt creation time',(o:ModerationOperation)=>{o.createdAt=NOW-101;}],
  ['gateway provenance',(o:ModerationOperation)=>{o.attemptGateway='UNSPECIFIED';}],
  ['approved group identity',(o:ModerationOperation)=>{o.chatId=OTHER_GROUP;}]
 ] as const){
  test(engine+' restored reviewed sanction with changed '+name+' is quarantined without rewriting evidence',async()=>{
   const f=await fixture(engine);try{
    await f.annotate();
    await f.store.transaction(s=>change(s.moderationOperations[0]!));
    const before=await f.store.snapshot();
    assert.deepEqual(inspectModerationLedgerIntegrity(before),{valid:true,malformedRows:0});
    const {list,selectors}=await f.checked();
    assert.equal(selectors.length,0,'never assert a review belongs to a rewritten sanction');
    assert.match(list?.text??'',/تدقيق|متعارض|موثوق/);
    assert.doesNotMatch(list?.text??'',/private-reason|case-immutable|301|399/);
    assert.equal(moderationOwnerReviewAuditConsistency(before,before.moderationOperations[0]!),'INCONSISTENT');
    assert.deepEqual(await f.store.snapshot(),before,'read-only evidence preservation');
   }finally{await f.close();}
  });
 }
 for(const [name,change] of [
  ['review digest removed',(o:ModerationOperation,a:AuditRecord)=>{setBinding(o.review);void a;}],
  ['audit digest removed',(o:ModerationOperation,a:AuditRecord)=>{setAuditBinding(a);void o;}],
  ['audit digest altered',(o:ModerationOperation,a:AuditRecord)=>{setAuditBinding(a,'a'.repeat(64));void o;}],
  ['review digest malformed',(o:ModerationOperation,a:AuditRecord)=>{setBinding(o.review,'malformed');void a;}],
  ['audit digest malformed',(o:ModerationOperation,a:AuditRecord)=>{setAuditBinding(a,'malformed');void o;}]
 ] as const){
  test(engine+' owner review refuses one-sided or forged '+name,async()=>{
   const f=await fixture(engine);try{
    await f.annotate();
    await f.store.transaction(s=>{
     const audit=s.audit.find(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED')!;
     change(s.moderationOperations[0]!,audit);
    });
    const snap=await f.store.snapshot();
    assert.equal(moderationOwnerReviewAuditConsistency(snap,snap.moderationOperations[0]!),'INCONSISTENT');
    const list=await f.home();
    assert.equal(list?.keyboard.inline_keyboard.flat().some(x=>x.callback_data.startsWith('mr:1:d:')),false);
    assert.equal(snap.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
   }finally{await f.close();}
  });
 }
 test(engine+' changing operation after a stored detail selector invalidates it on reopened store',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();
   const page=await f.home(),before=page!.keyboard.inline_keyboard.flat()
    .find(x=>x.callback_data.startsWith('mr:1:d:'))!.callback_data;
   await f.store.transaction(s=>{s.moderationOperations[0]!.kind='MUTE';});
   assert.equal(await f.view().handle(before,OWNER),null);
  }finally{await f.close();}
 });
 test(engine+' old legacy review without evidence digests stays visible',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();
   await f.store.transaction(s=>{
    setBinding(s.moderationOperations[0]!.review);
    const rec=s.audit.find(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED')!;
    setAuditBinding(rec);
   });
   const x=await f.checked();
   assert.equal(x.selectors.length,1);
   assert.match(x.list?.text??'',/تمت مراجعتها/);
   await f.assertSafe();
  }finally{await f.close();}
 });
 test(engine+' unreviewed independent case stays reviewable despite conflicting bound review',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();
   await f.store.transaction(s=>{
    s.moderationOperations[0]!.memberId='301';
    const other:ModerationOperation={
     ...s.moderationOperations[0]!,id:'other-case',memberId:'302',
     status:'UNKNOWN_OUTCOME'
    };
    delete other.review;
    s.moderationOperations.push(other);
   });
   const x=await f.checked();
   assert.equal(x.selectors.length,1);
   const selector=x.selectors[0]!.callback_data;
   const details=await f.view().handle(selector,OWNER);
   const preview=details?.keyboard.inline_keyboard.flat().find(y=>y.callback_data.startsWith('mr:1:v:'));
   assert.ok(preview);
   const confirmPreview=await f.view().handle(preview.callback_data,OWNER);
   const token=confirmPreview?.keyboard.inline_keyboard.flat().find(y=>y.callback_data.startsWith('c_'))?.callback_data;
   assert.ok(token);
   assert.ok(await f.view().handle(token,OWNER));
   const snap=await f.store.snapshot();
   assert.equal(snap.moderationOperations[1]?.review?.decision,'ACKNOWLEDGED_UNRESOLVED');
   assert.equal(snap.moderationOperations[0]?.review?.decision,'ACKNOWLEDGED_UNRESOLVED');
  }finally{await f.close();}
 });
}
