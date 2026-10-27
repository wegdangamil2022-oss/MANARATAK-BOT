import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,link,unlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {inspectOfflineModerationTrialScope} from '../src/moderation-trial-scope.js';
import {inspectIsolatedModerationRightsReadOnly} from '../src/moderation-trial-rights.js';

const OWNER='100',TRIAL='-100123';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-stop-trial-hardlink-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite');
 const safetyFile=join(dir,'safety.flag'),alias=join(dir,'alias.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,TRIAL,['moderation']);
 await policy.setPresence(TRIAL,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 const options=()=>({stateFile,backupFile,safetyFile,now:Date.now(),
  staleAfterMs:900_000,trialChatId:TRIAL});
 return {dir,options,safetyFile,alias,stateFile,backupFile,
  close:()=>rm(dir,{recursive:true,force:true})};
}

test('an aliased STOP file cannot certify a clean isolated trial as safe',async()=>{
 const f=await fixture();try{
  const source=await readFile(f.stateFile),rollback=await readFile(f.backupFile);
  assert.equal((await inspectOfflineModerationTrialScope(f.options())).status,'PASS');
  await link(f.safetyFile,f.alias);
  await assert.rejects(inspectOfflineModerationTrialScope(f.options()),
   /TRIAL_ACCEPTANCE_INVALID_SAFETY/);
  assert.deepEqual(await readFile(f.stateFile),source);
  assert.deepEqual(await readFile(f.backupFile),rollback);
  await unlink(f.alias);
  assert.equal((await inspectOfflineModerationTrialScope(f.options())).status,'PASS');
 }finally{await f.close();}
});

test('rights preflight refuses a hard-linked switch before ANY Telegram read',async()=>{
 const f=await fixture();try{
  let calls=0;
  const gateway={inspectBotModerationRights:async(_chatId:string)=>{
   calls++;return 'GRANTED' as const;
  }};
  await link(f.safetyFile,f.alias);
  await assert.rejects(inspectIsolatedModerationRightsReadOnly(f.options(),gateway),
   /TRIAL_ACCEPTANCE_INVALID_SAFETY/);
  assert.equal(calls,0);
  await unlink(f.alias);
  const report=await inspectIsolatedModerationRightsReadOnly(f.options(),gateway);
  assert.equal(report.status,'PASS');
  assert.equal(report.botRights,'GRANTED');
  assert.equal(calls,2);
 }finally{await f.close();}
});
