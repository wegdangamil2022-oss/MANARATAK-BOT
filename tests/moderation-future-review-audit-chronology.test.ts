import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type ModerationOperation,type AuditRecord} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {moderationOwnerReviewAuditConsistency,moderationReviewEvidenceDigest} from '../src/moderation-review-integrity.js';
import {summarizeModerationRecovery,inspectModerationRecoveryReadOnly} from '../src/moderation-recovery-monitor.js';

const OWNER='100',CHAT='-100123',TARGET='300',NOW=1_800_000_000_000;
const MINUTE=60_000,STALE=900_000;
const op=(id='future-review-private'):ModerationOperation=>({
 id,chatId:CHAT,memberId:TARGET,actorId:OWNER,kind:'BAN',
 reasonFingerprint:'PRIVATE_REVIEW_FINGERPRINT',policyVersion:1,
 status:'UNKNOWN_OUTCOME',createdAt:NOW-3000,attemptGateway:'TELEGRAM_API'
});
function reviewed(original:ModerationOperation,at=NOW+MINUTE,legacy=false){
 const digest=moderationReviewEvidenceDigest(original);
 const record:ModerationOperation={...original,review:{
  reviewedBy:OWNER,reviewedAt:at,decision:'ACKNOWLEDGED_UNRESOLVED',policyVersion:1,
  ...(legacy?{}:{evidenceDigest:digest})
 }};
 const audit:AuditRecord={
  updateKey:'owner:moderation:review:'+createHash('sha256')
   .update('MODERATION:REVIEW:'+original.id).digest('hex').slice(0,32),
  actorId:OWNER,decision:'ALLOW',reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
  policyVersion:1,at,...(legacy?{}:{moderationEvidenceDigest:digest})
 };
 return {record,audit};
}
const report=(record:ModerationOperation,audit:AuditRecord,now=NOW)=>summarizeModerationRecovery({
 moderationOperations:[record],audit:[audit]
},{now,staleAfterMs:STALE});

test('a V1 digest-matched future-dated review is NOT verified before its audit timestamp',()=>{
 const e=reviewed(op());
 assert.equal(moderationOwnerReviewAuditConsistency({audit:[e.audit]},e.record,NOW),'INCONSISTENT');
 const r=report(e.record,e.audit);
 assert.equal(r.reviewedUnresolved,0);
 assert.equal(r.untrustedReviewEvidence,1);
 assert.equal(r.awaitingFirstReview,0);
 assert.equal(r.clockAnomaly,1);
 assert.equal(r.manualAttention,1);
 assert.equal(r.state,'ATTENTION_REQUIRED');
});
test('exact review-time boundary restores local confidence without changing the ledger',()=>{
 const e=reviewed(op());
 assert.equal(moderationOwnerReviewAuditConsistency({audit:[e.audit]},e.record,NOW+MINUTE),'REVIEWED');
 const r=report(e.record,e.audit,NOW+MINUTE);
 assert.equal(r.reviewedUnresolved,1);
 assert.equal(r.untrustedReviewEvidence,0);
 assert.equal(r.clockAnomaly,0);
 assert.equal(r.unknownOutcome,1,'even reviewed unknown is unresolved');
});
test('future legacy-unbound review is inconsistent, not a trusted or legacy-only badge',()=>{
 const e=reviewed(op(),NOW+MINUTE,true);
 assert.equal(moderationOwnerReviewAuditConsistency({audit:[e.audit]},e.record,NOW),'INCONSISTENT');
 const r=report(e.record,e.audit);
 assert.equal(r.untrustedReviewEvidence,1);
 assert.equal(r.reviewedUnresolved,0);
 assert.equal(r.clockAnomaly,1);
});
test('a future operation and future review count as ONE anomalous case',()=>{
 const e=reviewed({...op(),createdAt:NOW+10},NOW+MINUTE);
 const r=report(e.record,e.audit);
 assert.equal(r.clockAnomaly,1);
 assert.equal(r.reviewedUnresolved,0);
 assert.equal(r.untrustedReviewEvidence,1);
});
test('chronology check applies only to actual review, not unreviewed UNKNOWN',()=>{
 const original=op();
 const r=summarizeModerationRecovery({moderationOperations:[original],audit:[]},{
  now:NOW,staleAfterMs:STALE
 });
 assert.equal(r.awaitingFirstReview,1);
 assert.equal(r.untrustedReviewEvidence,0);
 assert.equal(r.clockAnomaly,0);
});

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-audit-future-'));
 const file=join(dir,engine==='json'?'bot.json':'bot.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 const version=policy.chatRevision(await store.snapshot(),CHAT);
 const e=reviewed({...op(),policyVersion:version});
 e.record.review!.policyVersion=version;
 e.audit.policyVersion=version;
 await store.transaction(s=>{
  s.moderationOperations.push(e.record);
  s.audit.push(e.audit);
 });
 if(engine==='sqlite')await chmod(file,0o600);
 let now=NOW;
 const view=()=>new ModerationUnknownOwnerReview(new BotStore(file,{engine}),
  new Policy(new BotStore(file,{engine}),OWNER,()=>now),()=>now);
 return {store,policy,file,e,view,advance:(ms:number)=>{now+=ms},
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' restored future owner audit is quarantined from review selector without rewriting evidence',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   const menu=await f.view().handle('mr:1:h',OWNER);
   assert.ok(menu);
   assert.equal(menu.keyboard.inline_keyboard.flat()
    .some(b=>b.callback_data.startsWith('mr:1:d:')),false);
   assert.match(menu.text,/تدقيق مراجعات متعارض محجوب/);
   assert.doesNotMatch(menu.text,/PRIVATE_REVIEW_FINGERPRINT|future-review-private|300/);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' historical review becomes visible at its actual timestamp without a database edit',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   f.advance(MINUTE);
   const menu=await f.view().handle('mr:1:h',OWNER);
   assert.ok(menu);
   assert.equal(menu.keyboard.inline_keyboard.flat().filter(
    b=>b.callback_data.startsWith('mr:1:d:')).length,1);
   assert.match(menu.text,/تمت مراجعتها: 1/);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
}
test('read-only SQLite recovery quarantines future audit without writing state or exposing private evidence',async()=>{
 const f=await fixture('sqlite');try{
  const before=await readFile(f.file);
  const r=await inspectModerationRecoveryReadOnly(f.file,{now:NOW,staleAfterMs:STALE});
  assert.equal(r.untrustedReviewEvidence,1);
  assert.equal(r.reviewedUnresolved,0);
  assert.equal(r.clockAnomaly,1);
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
test('CLI on restored future audit returns attention status with aggregate-only counts',async()=>{
 const f=await fixture('sqlite');try{
  // CLI uses actual local Date.now, so shift the test review beyond wall time.
  const tomorrow=Date.now()+86_400_000;
  await f.store.transaction(s=>{
   const original=s.moderationOperations[0]!;
   original.createdAt=Date.now()-5000;
   original.review!.reviewedAt=tomorrow;
   original.review!.evidenceDigest=moderationReviewEvidenceDigest(original);
   const receipt=s.audit.find(a=>a.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED')!;
   receipt.at=tomorrow;
   receipt.moderationEvidenceDigest=moderationReviewEvidenceDigest(original);
  });
  const before=await readFile(f.file);
  const proc=spawnSync(process.execPath,[
   'dist/src/moderation-recovery-monitor-cli.js','--once','--state',f.file,
   '--stale-ms',String(STALE)
  ],{encoding:'utf8',timeout:15000,env:{...process.env,
   TELEGRAM_BOT_TOKEN:'PRIVATE_TEST_TOKEN',TELEGRAM_ENABLED:'false'}});
  assert.equal(proc.status,2,proc.stderr);
  const parsed=JSON.parse(proc.stdout) as {clockAnomaly:number;reviewedUnresolved:number;untrustedReviewEvidence:number};
  assert.equal(parsed.clockAnomaly,1);
  assert.equal(parsed.reviewedUnresolved,0);
  assert.equal(parsed.untrustedReviewEvidence,1);
  for(const secret of ['PRIVATE_TEST_TOKEN','PRIVATE_REVIEW_FINGERPRINT',
   'future-review-private',CHAT,TARGET,f.file])
   assert.equal((proc.stdout+proc.stderr).includes(secret),false);
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
