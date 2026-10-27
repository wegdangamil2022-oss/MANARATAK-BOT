import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type AuditRecord,type ModerationOperation} from '../src/store.js';
import {moderationReviewEvidenceDigest} from '../src/moderation-review-integrity.js';
import {summarizeModerationRecovery,inspectModerationRecoveryReadOnly} from '../src/moderation-recovery-monitor.js';

const NOW=1_800_000_000_000,STALE=900_000,OWNER='100',CHAT='-100123',MEMBER='300';
const options=()=>({now:NOW,staleAfterMs:STALE});
const record=(id='unresolved-private-case'):ModerationOperation=>({
 id,chatId:CHAT,memberId:MEMBER,actorId:OWNER,kind:'BAN',
 reasonFingerprint:'PRIVATE_DIGEST_CANARY',policyVersion:1,
 createdAt:NOW-1000,status:'UNKNOWN_OUTCOME',attemptGateway:'TELEGRAM_API'
});
const withReview=(op:ModerationOperation,legacy=false):ModerationOperation=>({
 ...op,review:{decision:'ACKNOWLEDGED_UNRESOLVED',
 reviewedBy:OWNER,reviewedAt:NOW-100,policyVersion:1,
 ...(legacy?{}:{evidenceDigest:moderationReviewEvidenceDigest(op)})}
});
const auditFor=(op:ModerationOperation,legacy=false):AuditRecord=>({
 updateKey:'owner:moderation:review:'+
  createHash('sha256').update('MODERATION:REVIEW:'+op.id).digest('hex').slice(0,32),
 actorId:OWNER,decision:'ALLOW',reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
 policyVersion:1,at:NOW-100,
 ...(legacy?{}:{moderationEvidenceDigest:moderationReviewEvidenceDigest(op)})
});
const inspect=(ops:ModerationOperation[],audit?:AuditRecord[])=>{
 const state=audit===undefined?{moderationOperations:ops}:{moderationOperations:ops,audit};
 return summarizeModerationRecovery(state,options());
};
const counters=(r:ReturnType<typeof inspect>)=>({
 reviewed:r.reviewedUnresolved,awaiting:r.awaitingFirstReview,
 untrusted:Reflect.get(r,'untrustedReviewEvidence')
});

test('restored review with no matching audit cannot claim locally corroborated owner acknowledgement',()=>{
 const op=withReview(record());
 const report=inspect([op]);
 assert.deepEqual(counters(report),{reviewed:0,awaiting:0,untrusted:1});
 assert.equal(report.state,'ATTENTION_REQUIRED');
 assert.equal(report.manualAttention,1);
 assert.equal(JSON.stringify(report).includes(op.reasonFingerprint),false);
});
test('audit mismatch and duplicate audit rows must not be counted as trusted owner review',()=>{
 for(const audit of [
  [{...auditFor(record()),decision:'DENY' as const}],
  [{...auditFor(record()),moderationEvidenceDigest:'0'.repeat(64)}],
  [auditFor(record()),auditFor(record())]
 ]){
  const report=inspect([withReview(record())],audit);
  assert.deepEqual(counters(report),{reviewed:0,awaiting:0,untrusted:1});
 }
});
test('legacy audit without either digest is visible but is not cryptographically bound review evidence',()=>{
 const original=record();
 const report=inspect([withReview(original,true)],[auditFor(original,true)]);
 assert.deepEqual(counters(report),{reviewed:0,awaiting:0,untrusted:1});
});
test('a valid digest-bound review and matching audit count as corroborated ONLY locally',()=>{
 const original=record();
 const report=inspect([withReview(original)],[auditFor(original)]);
 assert.deepEqual(counters(report),{reviewed:1,awaiting:0,untrusted:0});
 assert.equal(report.unknownOutcome,1);
});
test('orphan audit without an actual moderation review is a conflict, not an awaiting-first-review case',()=>{
 const original=record();
 const report=inspect([original],[auditFor(original)]);
 assert.deepEqual(counters(report),{reviewed:0,awaiting:0,untrusted:1});
});
test('ordinary unreviewed UNKNOWN remains awaiting first review when no audit exists',()=>{
 const report=inspect([record()],[]);
 assert.deepEqual(counters(report),{reviewed:0,awaiting:1,untrusted:0});
});

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-recovery-audit-trust-'));
 const file=join(dir,'bot.sqlite');
 const store=new BotStore(file,{engine:'sqlite'});
 await store.transaction(s=>{s.moderationOperations=[];});
 await chmod(file,0o600);
 return {dir,file,store,close:()=>rm(dir,{recursive:true,force:true})};
}
test('SQLite recovery inventory rejects a review lacking audit while preserving all state bytes',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.moderationOperations.push(withReview(record())));
  const before=await readFile(f.file);
  const report=await inspectModerationRecoveryReadOnly(f.file,options());
  assert.deepEqual(counters(report),{reviewed:0,awaiting:0,untrusted:1});
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
test('SQLite recovery inventory accepts properly linked audit without changing evidence',async()=>{
 const f=await fixture();try{
  const op=record();
  await f.store.transaction(s=>{
   s.moderationOperations.push(withReview(op));s.audit.push(auditFor(op));
  });
  const before=await readFile(f.file);
  const report=await inspectModerationRecoveryReadOnly(f.file,options());
  assert.deepEqual(counters(report),{reviewed:1,awaiting:0,untrusted:0});
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
test('CLI after restart reports untrusted review evidence only as aggregate and exits attention code',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.moderationOperations.push(withReview({
   ...record(),createdAt:Date.now()-5000
  })));
  const before=await readFile(f.file);
  const cmd=spawnSync(process.execPath,[
   'dist/src/moderation-recovery-monitor-cli.js','--once','--state',f.file,
   '--stale-ms',String(STALE)
  ],{encoding:'utf8',timeout:15_000,env:{...process.env,
   TELEGRAM_BOT_TOKEN:'PRIVATE_CANARY_TOKEN',TELEGRAM_ENABLED:'false'}});
  assert.equal(cmd.status,2,cmd.stderr);
  const data=JSON.parse(cmd.stdout);
  assert.equal(data.reviewedUnresolved,0);
  assert.equal(data.untrustedReviewEvidence,1);
  for(const secret of ['PRIVATE_DIGEST_CANARY','PRIVATE_CANARY_TOKEN',
   'unresolved-private-case',CHAT,MEMBER,f.file])
   assert.equal((cmd.stdout+cmd.stderr).includes(secret),false);
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
