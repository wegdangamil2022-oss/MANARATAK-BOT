import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,rename,readFile,chmod,lstat,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';

const OWNER='100',CHECKPOINT='PRIVATE_BEFORE',MUTATED='PRIVATE_AFTER_';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-trial-checkpoint-'));
 const stateFile=join(dir,'primary.sqlite'),backupFile=join(dir,'rollback.sqlite'),
  safetyFile=join(dir,'stop.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 await store.transaction(s=>s.audit.push({
  updateKey:'owner:faq:check-race',actorId:OWNER,
  reason:CHECKPOINT,decision:'ALLOW',policyVersion:1,at:Date.now()-1000
 }));
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 // Deterministic backup mtime ensures an in-place same-size update can
 // restore an exactly comparable timestamp (no filesystem nanosecond noise).
 const mtime=new Date(Math.floor(Date.now()/1000)*1000);
 await utimes(backupFile,mtime,mtime);
 const options=()=>({stateFile,backupFile,safetyFile,
  now:Date.now(),staleAfterMs:900_000});
 return {dir,stateFile,backupFile,safetyFile,options,
  close:()=>rm(dir,{recursive:true,force:true})};
}
async function onFinalStateSnapshot(action:()=>Promise<void>,run:()=>Promise<unknown>){
 const original=BotStore.snapshotSqliteReadOnly;
 let count=0;
 BotStore.snapshotSqliteReadOnly=async function(file:string){
  count++;
  // Call 1: source, call 2: backup; call 3 is the final source recheck.
  // Inject after the original backup/switch metadata checkpoints.
  if(count===3)await action();
  return original.call(BotStore,file);
 };
 try{return await run();}
 finally{BotStore.snapshotSqliteReadOnly=original;}
}
test('stable source, private STOP and independent matching rollback still PASS read-only',async()=>{
 const f=await fixture();try{
  const before=await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]);
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.options());
  assert.deepEqual(report,{stage:'OFFLINE_ONLY',status:'PASS',safety:'STOP',
   rollback:'MATCH',reasons:[]});
  assert.deepEqual(await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]),before);
 }finally{await f.close();}
});
test('replacing STOP inode mid-inspection cannot certify an unchanged safety epoch',async()=>{
 const f=await fixture();try{
  const source=await readFile(f.stateFile),rollback=await readFile(f.backupFile);
  const old=await lstat(f.safetyFile);
  const replacement=join(f.dir,'replacement.flag');
  await writeFile(replacement,'STOP\n',{mode:0o600});
  const run=()=>inspectTelegramTrialAcceptanceReadOnly(f.options());
  await assert.rejects(onFinalStateSnapshot(async()=>{
   await rename(replacement,f.safetyFile);
   const now=await lstat(f.safetyFile);
   assert.notEqual(now.ino,old.ino,'test must swap a distinct inode');
  },run),/TRIAL_ACCEPTANCE_STATE_CHANGED/);
  assert.equal(await readFile(f.safetyFile,'utf8'),'STOP\n');
  assert.deepEqual(await readFile(f.stateFile),source);
  assert.deepEqual(await readFile(f.backupFile),rollback);
 }finally{await f.close();}
});
test('in-place changed rollback with identical size and restored mtime cannot inherit old PASS',async()=>{
 const f=await fixture();try{
  const originalBackup=await readFile(f.backupFile);
  const first=await lstat(f.backupFile);
  const run=()=>inspectTelegramTrialAcceptanceReadOnly(f.options());
  await assert.rejects(onFinalStateSnapshot(async()=>{
   // Change an existing value without changing SQLite page size.
   const backupStore=new BotStore(f.backupFile,{engine:'sqlite'});
   await backupStore.transaction(s=>{
    assert.equal(s.audit[0]?.reason,CHECKPOINT);
    s.audit[0]!.reason=MUTATED;
   });
   await utimes(f.backupFile,first.atimeMs/1000,first.mtimeMs/1000);
   const after=await lstat(f.backupFile);
   assert.equal(after.size,first.size,'same-size regression fixture');
   assert.equal(after.mtimeMs,first.mtimeMs,'restored-mtime regression fixture');
  },run),/TRIAL_ACCEPTANCE_STATE_CHANGED/);
  assert.notDeepEqual(await readFile(f.backupFile),originalBackup);
  assert.equal((await BotStore.snapshotSqliteReadOnly(f.backupFile)).audit[0]?.reason,MUTATED);
  assert.equal((await BotStore.snapshotSqliteReadOnly(f.stateFile)).audit[0]?.reason,CHECKPOINT);
 }finally{await f.close();}
});
