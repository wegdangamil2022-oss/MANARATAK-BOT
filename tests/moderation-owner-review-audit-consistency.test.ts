import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type AuditRecord} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',GROUP='-100123',TARGET='300',NOW=1_700_000_000_000;
const auditKey=(id:string)=>'owner:moderation:review:'+
 createHash('sha256').update('MODERATION:REVIEW:'+id).digest('hex').slice(0,32);

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-audit-consistency-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 const version=(await store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
 await store.transaction(s=>s.moderationOperations.push({
  id:'case-a',chatId:GROUP,memberId:TARGET,actorId:OWNER,
  kind:'BAN',reasonFingerprint:'private-evidence',policyVersion:version,
  status:'UNKNOWN_OUTCOME',createdAt:NOW
 }));
 const reopen=()=>new ModerationUnknownOwnerReview(new BotStore(file,{engine}),policy,()=>NOW+30);
 const review=new ModerationUnknownOwnerReview(store,policy,()=>NOW+30);
 const select=(screen:Awaited<ReturnType<typeof review.handle>>,prefix:string)=>{
  const c=screen?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith(prefix));
  assert.ok(c,'Expected '+prefix);return c.callback_data;
 };
 const list=()=>reopen().handle('mr:1:h',OWNER);
 const detail=async()=>{
  const home=await list();return select(home,'mr:1:d:');
 };
 const preview=async()=>{
  const details=await reopen().handle(await detail(),OWNER);
  return select(details,'mr:1:v:');
 };
 const issue=async()=>select(await reopen().handle(await preview(),OWNER),'c_');
 const confirm=async()=>{const token=await issue();assert.ok(await reopen().handle(token,OWNER));return token;};
 const reviewAudit=async()=>await store.transaction(s=>{
  const a=s.audit.find(x=>x.updateKey===auditKey('case-a'));
  assert.ok(a);return a;
 });
 const injectAudit=async()=>{
  const fake:AuditRecord={actorId:OWNER,updateKey:auditKey('case-a'),
   decision:'ALLOW',reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
   policyVersion:version,at:NOW+30};
  await store.transaction(s=>{s.audit.push(fake);});
 };
 const assertLocked=async()=>{
  const s=await store.snapshot();
  assert.equal(s.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
  const gateway=new FakeModerationGateway();
  assert.equal((await new ModerationService(store,policy,gateway,()=>NOW+30)
   .reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
  assert.equal(gateway.calls.length,0);
 };
 return {store,policy,reopen,list,detail,preview,issue,confirm,reviewAudit,injectAudit,
  assertLocked,close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' hides a claimed owner review whose matching audit record vanished in restoration',async()=>{
  const f=await fixture(engine);try{
   await f.confirm();
   await f.store.transaction(s=>{s.audit=s.audit.filter(a=>a.updateKey!==auditKey('case-a'));});
   const before=await f.store.snapshot();
   const list=await f.list();
   assert.equal(list?.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('mr:1:d:')),false);
   assert.match(list?.text??'',/تدقيق|متعارض|موثوق/);
   assert.doesNotMatch(list?.text??'',/private-evidence|case-a|300/);
   assert.deepEqual(await f.store.snapshot(),before,'read-only quarantine must preserve evidence');
   await f.assertLocked();
  }finally{await f.close();}
 });
 for(const [label,mutate] of [
  ['audit actor mismatch',(a:AuditRecord)=>{a.actorId='399';}],
  ['audit decision mismatch',(a:AuditRecord)=>{a.decision='DENY';}],
  ['audit reason mismatch',(a:AuditRecord)=>{a.reason='MODERATION_UNKNOWN_OWNER_ESCALATED';}],
  ['audit timestamp mismatch',(a:AuditRecord)=>{a.at=NOW+29;}],
  ['audit policy mismatch',(a:AuditRecord)=>{a.policyVersion+=1;}],
  ['audit correlation key mismatch',(a:AuditRecord)=>{a.updateKey='other-audit-key';}]
 ] as const){
  test(engine+' blocks reviewed record with '+label,async()=>{
   const f=await fixture(engine);try{
    await f.confirm();
    await f.store.transaction(s=>{
     const a=s.audit.find(x=>x.updateKey===auditKey('case-a'))!;
     mutate(a);
    });
    const list=await f.list();
    assert.equal(list?.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('mr:1:d:')),false);
    assert.match(list?.text??'',/تدقيق|متعارض|موثوق/);
    assert.equal((await f.store.snapshot()).moderationOperations[0]?.review?.decision,'ACKNOWLEDGED_UNRESOLVED');
   }finally{await f.close();}
  });
 }
 test(engine+' duplicated owner audit receipt cannot verify a single review',async()=>{
  const f=await fixture(engine);try{
   await f.confirm();
   await f.store.transaction(s=>{
    const a=s.audit.find(x=>x.updateKey===auditKey('case-a'))!;
    s.audit.push({...a});
   });
   const list=await f.list();
   assert.equal(list?.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('mr:1:d:')),false);
   assert.match(list?.text??'',/تدقيق|متعارض|موثوق/);
  }finally{await f.close();}
 });
 test(engine+' orphan owner audit before review hides the target and never creates a nonce',async()=>{
  const f=await fixture(engine);try{
   await f.injectAudit();
   const before=await f.store.snapshot();
   const list=await f.list();
   assert.equal(list?.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('mr:1:d:')),false);
   assert.match(list?.text??'',/تدقيق|متعارض|موثوق/);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' old detail selector is invalidated when orphan audit arrives',async()=>{
  const f=await fixture(engine);try{
   const selector=await f.detail();
   await f.injectAudit();
   assert.equal(await f.reopen().handle(selector,OWNER),null);
   assert.equal((await f.store.snapshot()).moderationOperations[0]?.review,undefined);
  }finally{await f.close();}
 });
 test(engine+' audit injected after nonce issuance rejects atomic review without consuming nonce',async()=>{
  const f=await fixture(engine);try{
   const token=await f.issue();
   await f.injectAudit();
   const before=await f.store.snapshot();
   assert.equal(await f.reopen().handle(token,OWNER),null);
   const after=await f.store.snapshot();
   assert.deepEqual(after,before,'neither consume callback nor append a competing audit');
   assert.equal(after.moderationOperations[0]?.review,undefined);
   await f.assertLocked();
  }finally{await f.close();}
 });
 test(engine+' audit-inconsistent case does not hide unrelated reviewable UNKNOWN_OUTCOME case',async()=>{
  const f=await fixture(engine);try{
   await f.injectAudit();
   await f.store.transaction(s=>s.moderationOperations.push({
    ...s.moderationOperations[0]!,id:'case-b',memberId:'301'
   }));
   const home=await f.list();
   const selectors=home?.keyboard.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('mr:1:d:'))??[];
   assert.equal(selectors.length,1,'unique independent target stays reviewable');
   const details=await f.reopen().handle(selectors[0]!.callback_data,OWNER);
   const action=details?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mr:1:v:'))?.callback_data;
   assert.ok(action);
   const preview=await f.reopen().handle(action,OWNER);
   const token=preview?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('c_'))?.callback_data;
   assert.ok(token);
   assert.ok(await f.reopen().handle(token,OWNER));
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations.find(x=>x.id==='case-a')?.review,undefined);
   assert.equal(s.moderationOperations.find(x=>x.id==='case-b')?.review?.decision,'ACKNOWLEDGED_UNRESOLVED');
   await f.assertLocked();
  }finally{await f.close();}
 });
 test(engine+' clean audit-backed review remains visible and status never becomes retryable',async()=>{
  const f=await fixture(engine);try{
   await f.confirm();
   const list=await f.list();
   assert.match(list?.text??'',/تمت مراجعتها/);
   const sel=await f.detail();
   const detail=await f.reopen().handle(sel,OWNER);
   assert.match(detail?.text??'',/إقرار بالمراجعة دون حسم/);
   const s=await f.store.snapshot();
   assert.equal(s.audit.filter(x=>x.updateKey===auditKey('case-a')).length,1);
   await f.assertLocked();
  }finally{await f.close();}
 });
}
