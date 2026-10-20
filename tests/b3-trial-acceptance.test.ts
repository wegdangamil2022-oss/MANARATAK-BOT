import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,symlink,readFile,access,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore} from '../src/store.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';

const NOW=1_800_000_000_000;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-trial-acceptance-'));
 const state=join(dir,'state.sqlite'),backup=join(dir,'safe-backup.sqlite'),safety=join(dir,'safety.flag');
 const store=new BotStore(state,{engine:'sqlite'});
 await store.transaction(()=>undefined);
 await chmod(state,0o600);
 await writeFile(safety,'STOP\n',{mode:0o600});
 const snapshot=async()=>{await BotStore.backupSqlite(state,backup);await chmod(backup,0o600);};
 return {dir,state,backup,safety,store,snapshot,close:()=>rm(dir,{recursive:true,force:true})};
}
const args=(f:Awaited<ReturnType<typeof fixture>>)=>({
 stateFile:f.state,backupFile:f.backup,safetyFile:f.safety,now:NOW,staleAfterMs:900_000
});
const cli=(f:Awaited<ReturnType<typeof fixture>>,extra:string[]=[])=>spawnSync(
 process.execPath,['dist/src/telegram-trial-acceptance-cli.js','--offline-only','--state',f.state,
 '--backup',f.backup,'--safety',f.safety,'--stale-ms','900000',...extra],
 {encoding:'utf8',timeout:15_000,env:{...process.env,TELEGRAM_ENABLED:'false',
  TELEGRAM_BOT_TOKEN:'FAKE_SECRET_TOKEN_NEVER_ECHO'}}
);
test('B3 acceptance: protected stopped state with exact validated backup passes offline only',async()=>{
 const f=await fixture();try{
  await f.snapshot();
  const stateBefore=await readFile(f.state),backupBefore=await readFile(f.backup);
  const report=await inspectTelegramTrialAcceptanceReadOnly(args(f));
  assert.deepEqual(report,{stage:'OFFLINE_ONLY',status:'PASS',safety:'STOP',
   rollback:'MATCH',reasons:[]});
  assert.deepEqual(await readFile(f.state),stateBefore);
  assert.deepEqual(await readFile(f.backup),backupBefore);
  assert.equal(await readFile(f.safety,'utf8'),'STOP\n');
 }finally{await f.close();}
});
test('B3 acceptance: RUN is never accepted as an offline rollback rehearsal',async()=>{
 const f=await fixture();try{
  await f.snapshot();await writeFile(f.safety,'RUN\n');
  assert.deepEqual(await inspectTelegramTrialAcceptanceReadOnly(args(f)),{
   stage:'OFFLINE_ONLY',status:'BLOCKED',safety:'RUN',
   rollback:'MATCH',reasons:['SAFETY_NOT_STOP']});
  assert.equal(await readFile(f.safety,'utf8'),'RUN\n');
 }finally{await f.close();}
});
test('B3 acceptance: an outdated but valid backup cannot pretend to match current state',async()=>{
 const f=await fixture();try{
  await f.snapshot();
  await f.store.transaction(s=>{s.telegramReplyJobs=[{updateKey:'b3-webhook:bot-main:1',
   status:'SENT',attemptId:'sent-attempt-1',messageId:18,startedAt:NOW-1_000_000}];});
  const r=await inspectTelegramTrialAcceptanceReadOnly(args(f));
  assert.equal(r.status,'BLOCKED');assert.equal(r.rollback,'MISMATCH');
  assert.deepEqual(r.reasons,['BACKUP_STATE_MISMATCH']);
 }finally{await f.close();}
});
test('B3 acceptance: QUEUED replies are not safe to auto-replay after rollback',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.telegramReplyJobs=[{
   updateKey:'b3-webhook:bot-main:3',status:'QUEUED',queuedAt:NOW,
   plan:{chatId:'300',parseMode:'HTML',text:'Secret student information'}
  }];});
  await f.snapshot();
  const r=await inspectTelegramTrialAcceptanceReadOnly(args(f));
  assert.deepEqual(r.reasons,['PENDING_REPLIES']);
  assert.equal(r.status,'BLOCKED');
  assert.equal(JSON.stringify(r).includes('Secret'),false);
 }finally{await f.close();}
});
test('B3 acceptance: UNKNOWN and stale SENDING block even when manually reviewed',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.telegramReplyJobs=[
   {updateKey:'b3-webhook:bot-main:4',status:'UNKNOWN_OUTCOME',attemptId:'maybe-delivered',
    startedAt:NOW-1_000_000,manualReview:{decision:'ESCALATED',reviewedBy:'100',
     reviewedAt:NOW-100_000,attemptId:'maybe-delivered'}},
   {updateKey:'b3-webhook:bot-main:5',status:'SENDING',attemptId:'still-open',
    startedAt:NOW-5_000}
  ];});
  await f.snapshot();
  const r=await inspectTelegramTrialAcceptanceReadOnly(args(f));
  assert.deepEqual(r.reasons,['UNRESOLVED_REPLIES']);
  assert.equal(r.status,'BLOCKED');assert.equal(r.rollback,'MATCH');
  assert.equal(JSON.stringify(r).includes('maybe-delivered'),false);
 }finally{await f.close();}
});
test('B3 acceptance: recovered updates and unresolved moderation/leave operations block dry run',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.updates.push({key:'private-update-44',status:'UNKNOWN',leaseUntil:0});
   s.operations.push({id:'op-private',updateKey:'private-update-44',kind:'CHAT_LEAVE',
    chatId:'-100123',policyVersion:1,status:'UNKNOWN_OUTCOME'});
  });
  await f.snapshot();
  const r=await inspectTelegramTrialAcceptanceReadOnly(args(f));
  assert.deepEqual(r.reasons,['UNRESOLVED_UPDATES','UNRESOLVED_OPERATIONS']);
 }finally{await f.close();}
});
test('B3 acceptance: unresolved publication part and active purge are not ignored',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.deliveries.push({id:'d1',campaignId:'c1',resourceId:'r1',destination:'-100123',
    revision:'rev',status:'UNKNOWN_OUTCOME'});
   s.purgeJobs.push({id:'pj',chatId:'-100123',actorId:'100',scopeVersion:1,
    createdAt:1,expiresAt:NOW,filter:{limit:10},excluded:{protected:0,expired:0},
    status:'READY',items:[]});
  });
  await f.snapshot();
  const r=await inspectTelegramTrialAcceptanceReadOnly(args(f));
  assert.deepEqual(r.reasons,['UNRESOLVED_PUBLICATIONS','ACTIVE_PURGE']);
 }finally{await f.close();}
});
test('B3 acceptance: backup and source must be distinct, canonical and protected',async()=>{
 const f=await fixture();try{
  await f.snapshot();
  for(const bad of [{backupFile:f.state},{backupFile:'relative.sqlite'},
   {backupFile:f.backup+'/../alias.sqlite'}, {safetyFile:f.state},
   {stateFile:'relative.sqlite'}]){
   await assert.rejects(inspectTelegramTrialAcceptanceReadOnly({...args(f),...bad}),
    /TRIAL_ACCEPTANCE_INVALID_INPUT/);
  }
  await chmod(f.backup,0o644);
  await assert.rejects(inspectTelegramTrialAcceptanceReadOnly(args(f)),
   /TRIAL_ACCEPTANCE_INVALID_BACKUP/);
  await chmod(f.backup,0o600);
  const alias=join(f.dir,'backup-alias.sqlite');await symlink(f.backup,alias);
  await assert.rejects(inspectTelegramTrialAcceptanceReadOnly({...args(f),backupFile:alias}),
   /TRIAL_ACCEPTANCE_INVALID_BACKUP/);
 }finally{await f.close();}
});
test('B3 acceptance: invalid/absent STOP switch and backup fail without creating anything',async()=>{
 const f=await fixture();try{
  await assert.rejects(inspectTelegramTrialAcceptanceReadOnly(args(f)),
   /TRIAL_ACCEPTANCE_INVALID_BACKUP/);
  await assert.rejects(access(f.backup),{code:'ENOENT'});
  await f.snapshot();
  await writeFile(f.safety,'STOP');
  await assert.rejects(inspectTelegramTrialAcceptanceReadOnly(args(f)),
   /TRIAL_ACCEPTANCE_INVALID_SAFETY/);
  await unlink(f.safety);
  await assert.rejects(inspectTelegramTrialAcceptanceReadOnly(args(f)),
   /TRIAL_ACCEPTANCE_INVALID_SAFETY/);
 }finally{await f.close();}
});
test('B3 acceptance: unexpected input fields and forged thresholds are rejected',async()=>{
 const f=await fixture();try{
  await f.snapshot();
  for(const bad of [{now:-1},{staleAfterMs:5},{now:NOW,actorId:'100'},
   {now:NOW,activate:true},{now:NOW,rollback:true},{now:NOW,safetyFile:undefined}]){
   await assert.rejects(inspectTelegramTrialAcceptanceReadOnly({...args(f),...bad}),
    /TRIAL_ACCEPTANCE_INVALID_INPUT/);
  }
 }finally{await f.close();}
});
test('B3 acceptance CLI: PASS status-only JSON, no token/path/private student data',async()=>{
 const f=await fixture();try{
  await f.snapshot();
  const r=cli(f);assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout),{stage:'OFFLINE_ONLY',status:'PASS',
   safety:'STOP',rollback:'MATCH',reasons:[]});
  for(const secret of ['FAKE_SECRET_TOKEN_NEVER_ECHO',f.dir,'100','300'])
   assert.equal(r.stdout.includes(secret),false);
 }finally{await f.close();}
});
test('B3 acceptance CLI: BLOCKED is distinct nonzero, never auto-mutates a switch or DB',async()=>{
 const f=await fixture();try{
  await f.snapshot();await writeFile(f.safety,'RUN\n');
  const before=await readFile(f.state);
  const r=cli(f);assert.equal(r.status,2,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout),{stage:'OFFLINE_ONLY',status:'BLOCKED',
   safety:'RUN',rollback:'MATCH',reasons:['SAFETY_NOT_STOP']});
  assert.deepEqual(await readFile(f.state),before);
  assert.equal(await readFile(f.safety,'utf8'),'RUN\n');
 }finally{await f.close();}
});
test('B3 acceptance CLI: invalid args/absent backup return sanitized failure',async()=>{
 const f=await fixture();try{
  for(const extra of [['--go-live'],['--state','forged.sqlite']]){
   const r=cli(f,extra);
   assert.equal(r.status,1);assert.equal(r.stdout,'');
   assert.match(r.stderr,/MANARATAK_TRIAL_INVALID_REQUEST/);
  }
  const bad=cli(f);assert.equal(bad.status,1);assert.equal(bad.stdout,'');
  assert.match(bad.stderr,/MANARATAK_TRIAL_INVALID_BACKUP/);
  assert.equal(bad.stderr.includes(f.dir),false);
  await assert.rejects(access(f.backup),{code:'ENOENT'});
 }finally{await f.close();}
});
