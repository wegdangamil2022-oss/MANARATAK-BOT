import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,chmod,symlink,access,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {summarizeModerationRecovery,inspectModerationRecoveryReadOnly} from '../src/moderation-recovery-monitor.js';

const NOW=1_800_000_000_000,STALE=900_000,CHAT='-100123',OTHER='-100456',MEMBER='300';
function op(status:ModerationOperation['status'],id:string,createdAt:number,
 extra:Partial<ModerationOperation>={}):ModerationOperation{
 return {id,chatId:CHAT,memberId:MEMBER,actorId:'100',kind:'BAN',
  reasonFingerprint:'confidential-digest',policyVersion:1,status,createdAt,
  ...extra};
}
const baseline={
 stage:'OFFLINE_MODERATION_RECOVERY',state:'OK',
 totalOperations:0,intent:0,started:0,unknownOutcome:0,
 staleIntent:0,staleStarted:0,clockAnomaly:0,
 awaitingFirstReview:0,reviewedUnresolved:0,untrustedReviewEvidence:0,
 orphanReviewAuditReceipts:0,distinctBlockedTargets:0,manualAttention:0
} as const;
const options=()=>({now:NOW,staleAfterMs:STALE});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-moderation-recovery-'));
 const file=join(dir,'bot.sqlite'),store=new BotStore(file,{engine:'sqlite'});
 // SQLite snapshot() can return a synthetic empty state without persisting
 // bot_state. Initialize a genuine stored empty ledger before CLI inspection.
 await store.transaction(s=>{s.moderationOperations=[];});
 await chmod(file,0o600);
 return {dir,file,store,close:()=>rm(dir,{recursive:true,force:true})};
}
const command=(file:string,extra:string[]=[])=>spawnSync(process.execPath,[
 'dist/src/moderation-recovery-monitor-cli.js','--once','--state',file,
 '--stale-ms',String(STALE),...extra
],{encoding:'utf8',timeout:15_000,env:{...process.env,
 TELEGRAM_BOT_TOKEN:'SECRET_TOKEN_MUST_NOT_LEAK',TELEGRAM_ENABLED:'false'}});

test('pure recovery projection treats a clean ledger as healthy without inventing activity',()=>{
 assert.deepEqual(summarizeModerationRecovery({moderationOperations:[]},options()),baseline);
});
test('fresh INTENT and STARTED need human attention after restart, without guessing provider delivery',()=>{
 const x=summarizeModerationRecovery({moderationOperations:[
  op('INTENT','i',NOW-1000),op('STARTED','s',NOW-1000,{memberId:'301'})
 ]},options());
 assert.deepEqual(x,{...baseline,state:'ATTENTION_REQUIRED',
  totalOperations:2,intent:1,started:1,manualAttention:2,
  staleIntent:0,staleStarted:0,distinctBlockedTargets:2});
});
test('stale INTENT is attention-worthy but remains a pending case, NOT proof of no-send',()=>{
 const x=summarizeModerationRecovery({moderationOperations:[
  op('INTENT','stale',NOW-STALE)
 ]},options());
 assert.deepEqual(x,{...baseline,state:'ATTENTION_REQUIRED',totalOperations:1,
  intent:1,staleIntent:1,distinctBlockedTargets:1,manualAttention:1});
});
test('stale STARTED must be flagged as possible remote delivery and never retried',()=>{
 const x=summarizeModerationRecovery({moderationOperations:[
  op('STARTED','stale',NOW-STALE-1)
 ]},options());
 assert.deepEqual(x,{...baseline,state:'ATTENTION_REQUIRED',totalOperations:1,
  started:1,staleStarted:1,distinctBlockedTargets:1,manualAttention:1});
});
test('unknown results stay attention-worthy even after owner acknowledgement',()=>{
 const x=summarizeModerationRecovery({moderationOperations:[
  op('UNKNOWN_OUTCOME','u1',NOW-50),
  op('UNKNOWN_OUTCOME','u2',NOW-20,{review:{
   decision:'ACKNOWLEDGED_UNRESOLVED',reviewedAt:NOW-1,reviewedBy:'100'
  }}),
  op('UNKNOWN_OUTCOME','u3',NOW-10,{review:{
   decision:'ESCALATED',reviewedAt:NOW-1,reviewedBy:'100'
  }})
 ]},options());
 assert.deepEqual(x,{...baseline,state:'ATTENTION_REQUIRED',totalOperations:3,
  unknownOutcome:3,awaitingFirstReview:1,untrustedReviewEvidence:2,
  distinctBlockedTargets:1,manualAttention:3});
 assert.equal(JSON.stringify(x).includes('u1'),false);
 assert.equal(JSON.stringify(x).includes('100'),false);
 assert.equal(JSON.stringify(x).includes('300'),false);
});
test('future timestamp is an explicit clock anomaly requiring owner attention',()=>{
 const x=summarizeModerationRecovery({moderationOperations:[
  op('INTENT','future',NOW+1)
 ]},options());
 assert.deepEqual(x,{...baseline,state:'ATTENTION_REQUIRED',totalOperations:1,
  intent:1,clockAnomaly:1,distinctBlockedTargets:1,manualAttention:1});
});
test('invalid negative and nonnumeric restored timestamps fail closed, never return a healthy report',()=>{
 for(const createdAt of [-1,Number.NaN]){
  assert.throws(()=>summarizeModerationRecovery({moderationOperations:[
   op('STARTED','corrupt',createdAt)
  ]},options()),/MODERATION_RECOVERY_INVALID_LEDGER/);
 }
});
test('only unresolved attempts count toward blocked targets, deduplicated per chat/member',()=>{
 const x=summarizeModerationRecovery({moderationOperations:[
  op('CONFIRMED','c',NOW-10000,{memberId:'777'}),
  op('FAILED_CONFIRMED','f',NOW-10000,{memberId:'778'}),
  op('CANCELLED','d',NOW-10000),
  op('INTENT','i',NOW-100),
  op('STARTED','s',NOW-100),
  op('UNKNOWN_OUTCOME','u',NOW-100,{chatId:OTHER}),
 ]},options());
 assert.equal(x.totalOperations,6);
 assert.equal(x.distinctBlockedTargets,2);
 assert.equal(x.manualAttention,3,'fresh pending attempts are not proven active workers');
 assert.equal(x.state,'ATTENTION_REQUIRED');
});
test('strict options reject arbitrary properties, negative clock, unsafe windows, or malformed selectors',()=>{
 const s={moderationOperations:[]};
 for(const value of [
  {now:-1,staleAfterMs:STALE},{now:NOW,staleAfterMs:10},
  {now:NOW,staleAfterMs:31*24*3600_000},
  {now:NOW,staleAfterMs:STALE,autoRetry:true},
  {now:NOW,staleAfterMs:STALE,token:'DONT_LOG'},
  {now:Number.NaN,staleAfterMs:STALE}
 ])assert.throws(()=>summarizeModerationRecovery(s,value),
  /MODERATION_RECOVERY_OPTIONS_INVALID/);
});
test('invalid ledger row status or identity cannot fabricate a healthy report',()=>{
 const illegal=op('STARTED','bad',NOW-10,{status:'SENT' as ModerationOperation['status']});
 assert.throws(()=>summarizeModerationRecovery({moderationOperations:[illegal]},options()),
  /MODERATION_RECOVERY_INVALID_LEDGER/);
});

test('read-only SQLite inventory does not modify database and includes all unresolved cases',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.moderationOperations.push(op('STARTED','stale',NOW-STALE-1));
   s.moderationOperations.push(op('UNKNOWN_OUTCOME','unknown',NOW-300,{memberId:'301'}));
  });
  const before=await readFile(f.file);
  const stateBefore=await f.store.snapshot();
  const report=await inspectModerationRecoveryReadOnly(f.file,options());
  assert.deepEqual(report,{...baseline,state:'ATTENTION_REQUIRED',
   totalOperations:2,started:1,unknownOutcome:1,staleStarted:1,
   awaitingFirstReview:1,distinctBlockedTargets:2,manualAttention:2});
  assert.deepEqual(await readFile(f.file),before);
  assert.deepEqual(await f.store.snapshot(),stateBefore);
 }finally{await f.close();}
});
test('read-only inventory rejects symlinks, world-readable state, bogus SQLite and missing paths',async()=>{
 const f=await fixture();try{
  const alias=join(f.dir,'alias.sqlite');await symlink(f.file,alias);
  await assert.rejects(inspectModerationRecoveryReadOnly(alias,options()),
   /TELEGRAM_OUTBOX_STATE_INVALID/);
  await chmod(f.file,0o644);
  await assert.rejects(inspectModerationRecoveryReadOnly(f.file,options()),
   /TELEGRAM_OUTBOX_STATE_INVALID/);
  await chmod(f.file,0o600);
  const bad=join(f.dir,'bogus.sqlite');await writeFile(bad,'malformed',{mode:0o600});
  await assert.rejects(inspectModerationRecoveryReadOnly(bad,options()),
   /TELEGRAM_OUTBOX_STATE_INVALID/);
  const missing=join(f.dir,'missing.sqlite');
  await assert.rejects(inspectModerationRecoveryReadOnly(missing,options()),
   /TELEGRAM_OUTBOX_STATE_INVALID/);
  await assert.rejects(access(missing),{code:'ENOENT'});
 }finally{await f.close();}
});
test('CLI has no network or token dependence and only reports safe aggregate counts',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.moderationOperations.push(op(
   'UNKNOWN_OUTCOME','private-case',Date.now()-1000,{reasonFingerprint:'SENSITIVE_EVIDENCE'}
  )));
  const before=await readFile(f.file);
  const x=command(f.file);
  assert.equal(x.status,2,x.stderr);
  const report=JSON.parse(x.stdout) as {state:string;unknownOutcome:number;manualAttention:number};
  assert.equal(report.state,'ATTENTION_REQUIRED');
  assert.equal(report.unknownOutcome,1);
  assert.equal(report.manualAttention,1);
  for(const secret of ['private-case','SENSITIVE_EVIDENCE','SECRET_TOKEN_MUST_NOT_LEAK',
   f.file,CHAT,MEMBER,'100'])assert.equal((x.stdout+x.stderr).includes(secret),false);
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
test('CLI exits zero on clean state and rejects new flags that could trigger send/retry',async()=>{
 const f=await fixture();try{
  const x=command(f.file);
  assert.equal(x.status,0,x.stderr);
  assert.deepEqual(JSON.parse(x.stdout),baseline);
  for(const extra of [['--retry'],['--enable'],['--token','UNSAFE']]){
   const denied=command(f.file,extra);
   assert.equal(denied.status,1);assert.equal(denied.stdout,'');
   assert.match(denied.stderr,/MANARATAK_MODERATION_RECOVERY_INVALID_REQUEST/);
  }
 }finally{await f.close();}
});
test('CLI invalid/missing state never fabricates healthy data or prints file details',async()=>{
 const f=await fixture();try{
  const missing=join(f.dir,'absent.sqlite');
  const x=command(missing);
  assert.equal(x.status,1);assert.equal(x.stdout,'');
  assert.match(x.stderr,/MANARATAK_MODERATION_RECOVERY_INVALID_STATE/);
  assert.equal(x.stderr.includes(f.dir),false);
 }finally{await f.close();}
});
