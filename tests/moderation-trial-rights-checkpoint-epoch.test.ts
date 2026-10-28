import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,rename,unlink,chmod,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {inspectIsolatedModerationRightsReadOnly} from '../src/moderation-trial-rights.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const BOT=123456789,OWNER='100',CHAT='-100123';
const rights=()=>new Response(JSON.stringify({ok:true,result:{
 status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true
}}),{status:200,headers:{'content-type':'application/json'}});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-rights-checkpoint-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),
  safetyFile=join(dir,'stop.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.setPresence(CHAT,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 const options=()=>({stateFile,backupFile,safetyFile,trialChatId:CHAT,
  now:Date.now(),staleAfterMs:900_000});
 return {dir,store,stateFile,backupFile,safetyFile,options,
  close:()=>rm(dir,{recursive:true,force:true})};
}
const trusted=(atRead:(call:number)=>Promise<void>)=>{
 const calls:string[]=[];
 const gateway=new TelegramBotApiModerationGateway(TOKEN,(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  calls.push(method);
  assert.equal(method,'getChatMember');
  assert.deepEqual(JSON.parse(String(init?.body)),{chat_id:CHAT,user_id:BOT});
  await atRead(calls.length);
  return rights();
 }) as typeof fetch);
 return {calls,gateway};
};
const blocked=(reason:string)=>({
 stage:'READ_ONLY_MODERATION_RIGHTS',status:'BLOCKED',safety:'STOP',
 rollback:'MATCH',botRights:'NOT_CHECKED',reasons:[reason]
});
test('an immutable STOP, SQLite and backup checkpoint allows two read-only rights observations',async()=>{
 const f=await fixture();try{
  const before=await Promise.all([readFile(f.stateFile),readFile(f.backupFile),readFile(f.safetyFile)]);
  const t=trusted(async()=>undefined);
  const report=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.deepEqual(report,{stage:'READ_ONLY_MODERATION_RIGHTS',status:'PASS',
   safety:'STOP',rollback:'MATCH',botRights:'GRANTED',reasons:[]});
  assert.deepEqual(t.calls,['getChatMember','getChatMember']);
  assert.deepEqual(await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]),before);
 }finally{await f.close();}
});
test('a different STOP inode appearing during first Telegram rights read cannot inherit PASS',async()=>{
 const f=await fixture();try{
  const old=await lstat(f.safetyFile);
  const before=await Promise.all([readFile(f.stateFile),readFile(f.backupFile)]);
  const t=trusted(async count=>{
   if(count===1){
    const path=join(f.dir,'replacement-stop.flag');
    await writeFile(path,'STOP\n',{mode:0o600});
    await rename(path,f.safetyFile);
    assert.notEqual((await lstat(f.safetyFile)).ino,old.ino);
   }
  });
  const report=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.deepEqual(report,blocked('TRIAL_CHECKPOINT_CHANGED'));
  assert.deepEqual(t.calls,['getChatMember']);
  assert.equal(await readFile(f.safetyFile,'utf8'),'STOP\n');
  assert.deepEqual(await Promise.all([readFile(f.stateFile),readFile(f.backupFile)]),before);
 }finally{await f.close();}
});
test('a different STOP inode appearing during second rights read cannot inherit PASS',async()=>{
 const f=await fixture();try{
  const t=trusted(async count=>{
   if(count===2){
    const path=join(f.dir,'second-stop.flag');
    await writeFile(path,'STOP\n',{mode:0o600});
    await rename(path,f.safetyFile);
   }
  });
  const report=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.deepEqual(report,blocked('TRIAL_CHECKPOINT_CHANGED'));
  assert.deepEqual(t.calls,['getChatMember','getChatMember']);
 }finally{await f.close();}
});
test('reprovisioning a matching SQLite rollback anchor between rights reads must BLOCK',async()=>{
 const f=await fixture();try{
  const old=await lstat(f.backupFile);
  const state=await readFile(f.stateFile);
  const t=trusted(async count=>{
   if(count===1){
    const newBackup=join(f.dir,'other-rollback.sqlite');
    await BotStore.backupSqlite(f.stateFile,newBackup);
    await chmod(newBackup,0o600);
    await rename(newBackup,f.backupFile);
    assert.notEqual((await lstat(f.backupFile)).ino,old.ino);
   }
  });
  const report=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.deepEqual(report,blocked('TRIAL_CHECKPOINT_CHANGED'));
  assert.deepEqual(t.calls,['getChatMember']);
  assert.deepEqual(await readFile(f.stateFile),state);
  assert.deepEqual((await BotStore.snapshotSqliteReadOnly(f.stateFile)),
   (await BotStore.snapshotSqliteReadOnly(f.backupFile)));
 }finally{await f.close();}
});
test('same STOP inode rewritten with same bytes during rights read invalidates epoch',async()=>{
 const f=await fixture();try{
  const old=await lstat(f.safetyFile,{bigint:true});
  const t=trusted(async count=>{
   if(count===1){
    await writeFile(f.safetyFile,'STOP\n');
    const next=await lstat(f.safetyFile,{bigint:true});
    assert.equal(next.ino,old.ino);
    assert.notEqual(next.ctimeNs,old.ctimeNs);
   }
  });
  const report=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.deepEqual(report,blocked('TRIAL_CHECKPOINT_CHANGED'));
  assert.deepEqual(t.calls,['getChatMember']);
 }finally{await f.close();}
});
test('rewritten source and renewed matching backup during remote read invalidate checkpoint',async()=>{
 const f=await fixture();try{
  const before=await BotStore.snapshotSqliteReadOnly(f.stateFile);
  const t=trusted(async count=>{
   if(count===1){
    await f.store.transaction(()=>undefined);
    const temporary=join(f.dir,'updated-rollback.sqlite');
    await BotStore.backupSqlite(f.stateFile,temporary);
    await chmod(temporary,0o600);
    await rename(temporary,f.backupFile);
   }
  });
  const report=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.deepEqual(report,blocked('TRIAL_CHECKPOINT_CHANGED'));
  assert.deepEqual(t.calls,['getChatMember']);
  assert.deepEqual(await BotStore.snapshotSqliteReadOnly(f.stateFile),before);
  assert.deepEqual(await BotStore.snapshotSqliteReadOnly(f.backupFile),before);
 }finally{await f.close();}
});
test('an invalid STOP swap still returns the existing specific offline blocker, not new false PASS',async()=>{
 const f=await fixture();try{
  const t=trusted(async count=>{
   if(count===1)await writeFile(f.safetyFile,'RUN\n');
  });
  const report=await inspectIsolatedModerationRightsReadOnly(f.options(),t.gateway);
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,['SAFETY_NOT_STOP']);
  assert.deepEqual(t.calls,['getChatMember']);
 }finally{await f.close();}
});
