import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile,utimes,mkdir,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';
import {rehearseTelegramTrialRollback} from '../src/telegram-trial-rehearsal.js';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-trial-freshness-'));
 const stateFile=join(dir,'state.sqlite');
 const backupFile=join(dir,'snapshot.sqlite');
 const safetyFile=join(dir,'safety.flag');
 const sandboxDir=join(dir,'sandbox');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 await store.transaction(()=>undefined);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await mkdir(sandboxDir,{mode:0o700});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 const now=Date.now()+2_000;
 const options={stateFile,backupFile,safetyFile,now,staleAfterMs:900_000};
 return {dir,options,sandboxDir,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('fresh, matched, independent private backup still passes offline acceptance',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await inspectTelegramTrialAcceptanceReadOnly(f.options),{
   stage:'OFFLINE_ONLY',status:'PASS',safety:'STOP',rollback:'MATCH',reasons:[]
  });
 }finally{await f.close();}
});
test('matched but older-than-policy backup is BLOCKED, not a rollback-ready PASS',async()=>{
 const f=await fixture();try{
  const original=await readFile(f.options.backupFile);
  const old=new Date(f.options.now-f.options.staleAfterMs-120_000);
  await utimes(f.options.backupFile,old,old);
  const r=await inspectTelegramTrialAcceptanceReadOnly(f.options);
  assert.deepEqual(r,{stage:'OFFLINE_ONLY',status:'BLOCKED',safety:'STOP',
   rollback:'MATCH',reasons:['BACKUP_TOO_OLD']});
  assert.deepEqual(await readFile(f.options.backupFile),original);
 }finally{await f.close();}
});
test('future-dated backup beyond clock skew tolerance is BLOCKED',async()=>{
 const f=await fixture();try{
  const future=new Date(f.options.now+120_000);
  await utimes(f.options.backupFile,future,future);
  const r=await inspectTelegramTrialAcceptanceReadOnly(f.options);
  assert.deepEqual(r,{stage:'OFFLINE_ONLY',status:'BLOCKED',safety:'STOP',
   rollback:'MATCH',reasons:['BACKUP_TIMESTAMP_IN_FUTURE']});
 }finally{await f.close();}
});
test('a stale matched backup cannot start isolated restore scratch',async()=>{
 const f=await fixture();try{
  const old=new Date(f.options.now-f.options.staleAfterMs-90_000);
  await utimes(f.options.backupFile,old,old);
  const r=await rehearseTelegramTrialRollback({...f.options,sandboxDir:f.sandboxDir});
  assert.equal(r.status,'BLOCKED');
  assert.equal(r.rollback,'NOT_ATTEMPTED');
  assert.deepEqual(r.reasons,['BACKUP_TOO_OLD']);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close();}
});
test('future-dated rollback anchor cannot start isolated restore scratch',async()=>{
 const f=await fixture();try{
  const future=new Date(f.options.now+300_000);
  await utimes(f.options.backupFile,future,future);
  const r=await rehearseTelegramTrialRollback({...f.options,sandboxDir:f.sandboxDir});
  assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.reasons,['BACKUP_TIMESTAMP_IN_FUTURE']);
  assert.deepEqual(await readdir(f.sandboxDir),[]);
 }finally{await f.close();}
});
