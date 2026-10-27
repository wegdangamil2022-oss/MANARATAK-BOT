import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';

const OWNER='100',CHAT='-100123',TARGET='399';
const unsafe='UNSAFE_MODERATION_LEDGER';
const terminal=(now:number):ModerationOperation=>({
 id:'private-restored-terminal',chatId:CHAT,memberId:TARGET,
 actorId:OWNER,kind:'BAN',reasonFingerprint:'PRIVATE_LEDGER_CANARY',
 policyVersion:1,status:'CONFIRMED',createdAt:now-1000
});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-trial-ledger-integrity-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),
  safetyFile=join(dir,'switch.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 await store.transaction(()=>undefined);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 const snapshot=async()=>{
  await BotStore.backupSqlite(stateFile,backupFile);await chmod(backupFile,0o600);
 };
 const args=()=>({stateFile,backupFile,safetyFile,now:Date.now(),staleAfterMs:900_000});
 const close=()=>rm(dir,{recursive:true,force:true});
 return {dir,stateFile,backupFile,safetyFile,store,snapshot,args,close};
}
test('offline acceptance rejects a malformed terminal sanction even with STOP and matching backup',async()=>{
 const f=await fixture();try{
  const op=terminal(Date.now());
  op.kind='DELETE' as ModerationOperation['kind'];
  await f.store.transaction(s=>s.moderationOperations.push(op));
  await f.snapshot();
  const before=await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]);
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.args());
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.rollback,'MATCH');
  assert.deepEqual(report.reasons,[unsafe]);
  assert.equal(JSON.stringify(report).includes('PRIVATE_LEDGER_CANARY'),false);
  assert.deepEqual(await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]),before,'offline acceptance must preserve every evidence file');
 }finally{await f.close();}
});
test('duplicate terminal IDs cannot be mistaken for independent clean history',async()=>{
 const f=await fixture();try{
  const op=terminal(Date.now());
  await f.store.transaction(s=>s.moderationOperations.push(op,{...op,
   chatId:'-100456',memberId:'398',status:'CANCELLED'}));
  await f.snapshot();
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.args());
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,[unsafe]);
 }finally{await f.close();}
});
test('a future-dated finished sanction blocks readiness until the observation clock is valid',async()=>{
 const f=await fixture();try{
  const op={...terminal(Date.now()),createdAt:Date.now()+120_000};
  await f.store.transaction(s=>s.moderationOperations.push(op));
  await f.snapshot();
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.args());
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,[unsafe]);
 }finally{await f.close();}
});
test('an UNKNOWN owner review with a missing audit is not only unresolved but ledger-unsafe',async()=>{
 const f=await fixture();try{
  const now=Date.now();
  const op:ModerationOperation={...terminal(now),status:'UNKNOWN_OUTCOME',
   review:{decision:'ACKNOWLEDGED_UNRESOLVED',reviewedBy:OWNER,reviewedAt:now-100}};
  await f.store.transaction(s=>s.moderationOperations.push(op));
  await f.snapshot();
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.args());
  assert.deepEqual(report.reasons,['UNRESOLVED_OPERATIONS',unsafe]);
  assert.equal(report.status,'BLOCKED');
 }finally{await f.close();}
});
test('valid terminal history and unrelated FAQ audit remain compatible with STOP readiness',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.moderationOperations.push(terminal(Date.now()));
   s.audit.push({updateKey:'owner:faq:unrelated',actorId:OWNER,
    reason:'RESPONSE_PLANNED_ONLY',decision:'ALLOW',policyVersion:1,at:Date.now()});
  });
  await f.snapshot();
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.args());
  assert.equal(report.status,'PASS');
  assert.deepEqual(report.reasons,[]);
 }finally{await f.close();}
});
test('audit-only orphan blocker stays specific; do not duplicate a generic unsafe warning',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.audit.push({
   updateKey:'owner:moderation:review:missing-private-operation',
   actorId:OWNER,reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
   decision:'ALLOW',policyVersion:1,at:Date.now()-1000
  }));
  await f.snapshot();
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.args());
  assert.deepEqual(report.reasons,['ORPHAN_MODERATION_REVIEW_AUDIT']);
 }finally{await f.close();}
});
test('CLI rejects terminal corruption with redacted status and a distinct blocked exit code',async()=>{
 const f=await fixture();try{
  const op={...terminal(Date.now()),status:'IMAGINARY' as ModerationOperation['status']};
  await f.store.transaction(s=>s.moderationOperations.push(op));
  await f.snapshot();
  const child=spawnSync(process.execPath,[
   'dist/src/telegram-trial-acceptance-cli.js','--offline-only',
   '--state',f.stateFile,'--backup',f.backupFile,'--safety',f.safetyFile,
   '--stale-ms','900000'
  ],{encoding:'utf8',timeout:15000,env:{...process.env,
   TELEGRAM_ENABLED:'false',TELEGRAM_BOT_TOKEN:'PRIVATE_TRIAL_TOKEN'}});
  assert.equal(child.status,2,child.stderr);
  const report=JSON.parse(child.stdout);
  assert.deepEqual(report.reasons,[unsafe]);
  for(const secret of [f.dir,CHAT,TARGET,'PRIVATE_LEDGER_CANARY',
   'private-restored-terminal','PRIVATE_TRIAL_TOKEN'])
   assert.equal((child.stdout+child.stderr).includes(secret),false,secret);
 }finally{await f.close();}
});
