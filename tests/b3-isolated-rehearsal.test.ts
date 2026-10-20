import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,chmod,writeFile,readFile,readdir,symlink,link,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore} from '../src/store.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';
import {rehearseTelegramTrialRollback} from '../src/telegram-trial-rehearsal.js';
const NOW=1_800_000_000_000;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-rollback-rehearsal-'));
 const stateFile=join(dir,'live.sqlite'),backupFile=join(dir,'backup.sqlite');
 const safetyFile=join(dir,'emergency.flag'),sandboxDir=join(dir,'isolated');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 await store.transaction(()=>undefined);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await mkdir(sandboxDir,{mode:0o700});
 const backup=async()=>{await BotStore.backupSqlite(stateFile,backupFile);await chmod(backupFile,0o600);};
 return {dir,stateFile,backupFile,safetyFile,sandboxDir,store,backup,
  close:()=>rm(dir,{recursive:true,force:true})};
}
const opts=(f:Awaited<ReturnType<typeof fixture>>)=>({stateFile:f.stateFile,
 backupFile:f.backupFile,safetyFile:f.safetyFile,sandboxDir:f.sandboxDir,
 now:NOW,staleAfterMs:900_000});
function cli(f:Awaited<ReturnType<typeof fixture>>,extra:string[]=[]){
 return spawnSync(process.execPath,['dist/src/telegram-trial-rehearsal-cli.js',
  '--offline-only','--state',f.stateFile,'--backup',f.backupFile,
  '--safety',f.safetyFile,'--sandbox',f.sandboxDir,'--stale-ms','900000',...extra],
 {encoding:'utf8',timeout:20_000,env:{...process.env,TELEGRAM_ENABLED:'false',
  TELEGRAM_BOT_TOKEN:'FAKE_PRIVATE_TOKEN_MUST_NOT_PRINT'}});
}
test('B3 isolated rehearsal restores verified snapshot into sandbox then deletes scratch',async()=>{
 const f=await fixture();try{
  await f.backup();
  const before=await readFile(f.stateFile),backup=await readFile(f.backupFile);
  const r=await rehearseTelegramTrialRollback(opts(f));
  assert.deepEqual(r,{stage:'ISOLATED_RESTORE_REHEARSAL',status:'PASS',
   rollback:'VERIFIED',safety:'STOP',reasons:[]});
  assert.deepEqual(await readdir(f.sandboxDir),[]);
  assert.deepEqual(await readFile(f.stateFile),before);
  assert.deepEqual(await readFile(f.backupFile),backup);
  assert.equal(await readFile(f.safetyFile,'utf8'),'STOP\n');
 }finally{await f.close();}
});
test('B3 isolated rehearsal never creates scratch if STOP is RUN or inbound intent is queued',async()=>{
 const f=await fixture();try{
  await f.backup();await writeFile(f.safetyFile,'RUN\n');
  let r=await rehearseTelegramTrialRollback(opts(f));
  assert.deepEqual(r,{stage:'ISOLATED_RESTORE_REHEARSAL',status:'BLOCKED',
   rollback:'NOT_ATTEMPTED',safety:'RUN',reasons:['SAFETY_NOT_STOP']});
  assert.deepEqual(await readdir(f.sandboxDir),[]);
  await writeFile(f.safetyFile,'STOP\n');
  await f.store.transaction(s=>{s.telegramReplyJobs=[{
   updateKey:'b3-webhook:bot-main:7',status:'QUEUED',
   plan:{chatId:'300',parseMode:'HTML',text:'Private student message'} }];});
  r=await rehearseTelegramTrialRollback(opts(f));
  assert.equal(r.status,'BLOCKED');
  assert.ok(r.reasons.includes('PENDING_REPLIES'));
  assert.ok(r.reasons.includes('BACKUP_STATE_MISMATCH'));
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close();}
});
test('B3 isolated rehearsal preserves UNKNOWN_OUTCOME receipt and does not replay',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.telegramReplyJobs=[{
   updateKey:'b3-webhook:bot-main:9',status:'UNKNOWN_OUTCOME',
   attemptId:'possibly-sent',startedAt:NOW-1000,
   manualReview:{decision:'ESCALATED',reviewedBy:'100',
    reviewedAt:NOW,attemptId:'possibly-sent'}
  }];});
  await f.backup();
  const before=await f.store.snapshot();
  const r=await rehearseTelegramTrialRollback(opts(f));
  assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.reasons,['UNRESOLVED_REPLIES']);
  assert.deepEqual(await f.store.snapshot(),before);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close();}
});
test('B3 isolated rehearsal rejects sandbox equal to live or backup parent directory',async()=>{
 const f=await fixture();try{
  await f.backup();
  await assert.rejects(rehearseTelegramTrialRollback({...opts(f),sandboxDir:f.dir}),
   /TRIAL_REHEARSAL_UNSAFE_SANDBOX/);
  await assert.rejects(rehearseTelegramTrialRollback({...opts(f),sandboxDir:'.'}),
   /TRIAL_REHEARSAL_UNSAFE_SANDBOX/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close();}
});
test('B3 isolated rehearsal rejects missing/public/symlinked sandbox without creating it',async()=>{
 const f=await fixture();try{
  await f.backup();
  const missing=join(f.dir,'missing');
  await assert.rejects(rehearseTelegramTrialRollback({...opts(f),sandboxDir:missing}),
   /TRIAL_REHEARSAL_UNSAFE_SANDBOX/);
  await assert.rejects(access(missing),{code:'ENOENT'});
  await chmod(f.sandboxDir,0o755);
  await assert.rejects(rehearseTelegramTrialRollback(opts(f)),/TRIAL_REHEARSAL_UNSAFE_SANDBOX/);
  await chmod(f.sandboxDir,0o700);
  const alias=join(f.dir,'symlink');await symlink(f.sandboxDir,alias);
  await assert.rejects(rehearseTelegramTrialRollback({...opts(f),sandboxDir:alias}),
   /TRIAL_REHEARSAL_UNSAFE_SANDBOX/);
 }finally{await f.close();}
});
test('B3 hard-link alias cannot masquerade as independent backup',async()=>{
 const f=await fixture();try{
  const alias=join(f.dir,'hardlink.sqlite');
  await link(f.stateFile,alias);
  await assert.rejects(inspectTelegramTrialAcceptanceReadOnly({...opts(f),backupFile:alias}),
   /TRIAL_ACCEPTANCE_INVALID_BACKUP/);
  await assert.rejects(rehearseTelegramTrialRollback({...opts(f),backupFile:alias}),
   /TRIAL_ACCEPTANCE_INVALID_BACKUP/);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close();}
});
test('B3 isolated rehearsal verifies nonempty state without emitting private identifiers',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.chats.push({id:'-100123',approved:true,present:true,scopes:['navigation'],version:1,groupAI:'OFF'});
   s.audit.push({updateKey:'secret-private-identifier',at:NOW,reason:'SENSITIVE',
    policyVersion:1,decision:'NOOP'});
  });
  await f.backup();
  const r=await rehearseTelegramTrialRollback(opts(f));
  assert.equal(r.status,'PASS');assert.equal(r.rollback,'VERIFIED');
  assert.equal(JSON.stringify(r).includes('secret-private-identifier'),false);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close();}
});
test('B3 isolated rehearsal CLI success is JSON-only and no leftover scratch',async()=>{
 const f=await fixture();try{
  await f.backup();
  const r=cli(f);assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout),{stage:'ISOLATED_RESTORE_REHEARSAL',
   status:'PASS',rollback:'VERIFIED',safety:'STOP',reasons:[]});
  assert.deepEqual(await readdir(f.sandboxDir),[]);
  for(const v of ['FAKE_PRIVATE_TOKEN_MUST_NOT_PRINT',f.dir,'100','300'])
   assert.equal(r.stdout.includes(v),false);
 }finally{await f.close();}
});
test('B3 isolated rehearsal CLI blocked and malformed requests yield distinct sanitized exits',async()=>{
 const f=await fixture();try{
  await f.backup();await writeFile(f.safetyFile,'RUN\n');
  const r=cli(f);assert.equal(r.status,2,r.stderr);
  assert.equal((JSON.parse(r.stdout) as {status:string}).status,'BLOCKED');
  for(const extra of [['--go-live'],['--restore-production'],['--send'],['--force']]){
   const bad=cli(f,extra);assert.equal(bad.status,1);assert.equal(bad.stdout,'');
   assert.match(bad.stderr,/MANARATAK_REHEARSAL_INVALID_REQUEST/);
  }
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close();}
});
