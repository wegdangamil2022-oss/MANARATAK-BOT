import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {moderationOwnerReviewAuditConsistency} from '../src/moderation-review-integrity.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',GROUP='-100123',NOW=1_700_000_000_000;
type Engine='json'|'sqlite';

async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-legacy-trust-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 const policyVersion=(await store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
 const op=(id:string,memberId:string):ModerationOperation=>({
  id,chatId:GROUP,memberId,actorId:OWNER,kind:'BAN',
  reasonFingerprint:'opaque-evidence-'+id,policyVersion,
  status:'UNKNOWN_OUTCOME',createdAt:NOW-100,attemptGateway:'SIMULATION'
 });
 await store.transaction(s=>s.moderationOperations.push(op('case-old','300')));
 const handle=(data:string)=>new ModerationUnknownOwnerReview(
  new BotStore(file,{engine}),policy,()=>NOW).handle(data,OWNER);
 const btn=(screen:Awaited<ReturnType<typeof handle>>,prefix:string)=>{
  const b=screen?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith(prefix));
  assert.ok(b,'expected '+prefix);return b.callback_data;
 };
 const preview=async()=>{
  const home=await handle('mr:1:h');
  const detail=await handle(btn(home,'mr:1:d:'));
  return handle(btn(detail,'mr:1:v:'));
 };
 const annotate=async()=>{
  const p=await preview();
  const token=btn(p,'c_');
  const ok=await handle(token);
  assert.ok(ok);
  return token;
 };
 const removeBoth=async(id='case-old')=>store.transaction(s=>{
  const o=s.moderationOperations.find(x=>x.id===id)!;
  const audit=s.audit.find(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED'&&
   x.moderationEvidenceDigest===o.review?.evidenceDigest)!;
  delete o.review!.evidenceDigest;
  delete audit.moderationEvidenceDigest;
 });
 const addCase=async(id:string,memberId:string)=>store.transaction(s=>{
  s.moderationOperations.push(op(id,memberId));
 });
 const detail=async(id:string)=>{
  const list=await handle('mr:1:h');
  const choices=list?.keyboard.inline_keyboard.flat()
   .filter(x=>x.callback_data.startsWith('mr:1:d:'))??[];
  for(const choice of choices){
   const d=await handle(choice.callback_data);
   if(d?.text.includes('مراجعة'))return d;
  }
  void id;return null;
 };
 const assertLock=async(target='300')=>{
  const gateway=new FakeModerationGateway();
  const result=await new ModerationService(store,policy,gateway,()=>NOW)
   .reconcile(OWNER,GROUP,target);
  assert.equal(result.status,'BLOCKED_UNKNOWN');
  assert.equal(gateway.calls.length,0);
 };
 return {store,policy,op,handle,btn,annotate,preview,removeBoth,addCase,detail,assertLock,
  close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' bound review remains explicitly corroborated and counted as reviewed',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();
   const snap=await f.store.snapshot();
   assert.equal(moderationOwnerReviewAuditConsistency(snap,snap.moderationOperations[0]!),'REVIEWED');
   const list=await f.handle('mr:1:h');
   assert.match(list?.text??'',/تمت مراجعتها: 1/);
   assert.match(list?.text??'',/قديمة بلا بصمة: 0/);
   assert.match(list?.keyboard.inline_keyboard.flat()
    .find(x=>x.callback_data.startsWith('mr:1:d:'))?.text??'',/✅/);
   await f.assertLock();
  }finally{await f.close();}
 });
 test(engine+' erasing both review and audit bindings yields unverified legacy, never trusted REVIEWED',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();
   await f.removeBoth();
   const state=await f.store.snapshot();
   assert.equal(moderationOwnerReviewAuditConsistency(state,state.moderationOperations[0]!),'LEGACY_UNBOUND');
   const view=await f.handle('mr:1:h');
   assert.match(view?.text??'',/تمت مراجعتها: 0/);
   assert.match(view?.text??'',/قديمة بلا بصمة: 1/);
   const selector=view?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith('mr:1:d:'));
   assert.ok(selector,'legacy case still visible for human triage');
   assert.match(selector.text,/⚠️/);
   assert.doesNotMatch(selector.text,/✅/);
   const d=await f.handle(selector.callback_data);
   assert.match(d?.text??'',/قديمة|غير مربوطة/);
   assert.match(d?.text??'',/تحقق بشري|بصمة/);
   assert.equal(d?.keyboard.inline_keyboard.flat().some(x=>x.callback_data.startsWith('mr:1:v:')),false);
   await f.assertLock();
  }finally{await f.close();}
 });
 test(engine+' evidence-stripped review remains readable after database reopen without rewriting original records',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();await f.removeBoth();
   const before=await f.store.snapshot();
   const home=await f.handle('mr:1:h');
   const selector=f.btn(home,'mr:1:d:');
   assert.ok(await f.handle(selector));
   assert.deepEqual(await f.store.snapshot(),before);
   assert.equal(before.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
   assert.equal(before.moderationOperations[0]?.review?.evidenceDigest,undefined);
  }finally{await f.close();}
 });
 test(engine+' legacy reviewed escalation carries same warning, never a verified checkmark',async()=>{
  const f=await fixture(engine);try{
   const p=await f.preview();
   const action=f.btn(p,'c_');
   assert.ok(await f.handle(action));
   await f.store.transaction(s=>{
    const o=s.moderationOperations[0]!;
    o.review!.decision='ESCALATED';
    const audit=s.audit.find(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED')!;
    audit.reason='MODERATION_UNKNOWN_OWNER_ESCALATED';
    delete o.review!.evidenceDigest;
    delete audit.moderationEvidenceDigest;
   });
   const home=await f.handle('mr:1:h');
   assert.match(home?.text??'',/قديمة بلا بصمة: 1/);
   const entry=home?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith('mr:1:d:'));
   assert.ok(entry);assert.match(entry.text,/⚠️/);
   const d=await f.handle(entry.callback_data);
   assert.match(d?.text??'',/تصعيد/);
   assert.match(d?.text??'',/بصمة/);
   await f.assertLock();
  }finally{await f.close();}
 });
 test(engine+' bound and legacy owner reviews display distinct aggregate trust counts',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();await f.removeBoth();
   await f.addCase('case-bound','301');
   const home=await f.handle('mr:1:h');
   const options=home?.keyboard.inline_keyboard.flat()
    .filter(x=>x.callback_data.startsWith('mr:1:d:'))??[];
   assert.equal(options.length,2);
   const unreviewed=options.find(x=>x.text.includes('بحاجة'));
   assert.ok(unreviewed);
   const dt=await f.handle(unreviewed.callback_data);
   const p=await f.handle(f.btn(dt,'mr:1:v:'));
   assert.ok(await f.handle(f.btn(p,'c_')));
   const next=await f.handle('mr:1:h');
   assert.match(next?.text??'',/تمت مراجعتها: 1/);
   assert.match(next?.text??'',/قديمة بلا بصمة: 1/);
   assert.match(next?.text??'',/بحاجة لمراجعة: 0/);
   const labels=next?.keyboard.inline_keyboard.flat()
    .filter(x=>x.callback_data.startsWith('mr:1:d:')).map(x=>x.text)??[];
   assert.equal(labels.filter(x=>x.includes('✅')).length,1);
   assert.equal(labels.filter(x=>x.includes('⚠️')).length,1);
   await f.assertLock('300');await f.assertLock('301');
  }finally{await f.close();}
 });
 test(engine+' invalid single-sided evidence bindings remain quarantined rather than legacy',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();
   await f.store.transaction(s=>{
    delete s.moderationOperations[0]!.review!.evidenceDigest;
   });
   const s=await f.store.snapshot();
   assert.equal(moderationOwnerReviewAuditConsistency(s,s.moderationOperations[0]!),'INCONSISTENT');
   const home=await f.handle('mr:1:h');
   assert.match(home?.text??'',/تدقيق مراجعات متعارض محجوب: 1/);
   assert.equal(home?.keyboard.inline_keyboard.flat().some(x=>x.callback_data.startsWith('mr:1:d:')),false);
  }finally{await f.close();}
 });
 test(engine+' owner page never exposes target or fingerprint in downgrade summary',async()=>{
  const f=await fixture(engine);try{
   await f.annotate();await f.removeBoth();
   const home=await f.handle('mr:1:h');
   assert.doesNotMatch(home?.text??'',/opaque-evidence-case-old|case-old|300/);
   const d=await f.handle(f.btn(home,'mr:1:d:'));
   assert.doesNotMatch(d?.text??'',/opaque-evidence-case-old|case-old|300/);
   assert.equal((await f.store.snapshot()).moderationOperations[0]?.review?.decision,'ACKNOWLEDGED_UNRESOLVED');
  }finally{await f.close();}
 });
}
