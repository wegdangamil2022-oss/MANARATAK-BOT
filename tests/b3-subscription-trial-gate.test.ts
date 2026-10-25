import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';
const OWNER='100',GROUP='-100101',CHANNEL='-100202';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-trial-subscription-'));
 const file=join(dir,'state.sqlite'),backup=join(dir,'backup.sqlite'),safety=join(dir,'switch.flag');
 const store=new BotStore(file,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,GROUP,['navigation','verification']);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 await store.transaction(s=>s.subscriptionRequirements.push({
  chatId:GROUP,channelIds:[CHANNEL],mode:'ALL',version:1
 }));
 await chmod(file,0o600);await writeFile(safety,'STOP\n',{mode:0o600});
 const snapshot=async()=>{await BotStore.backupSqlite(file,backup);await chmod(backup,0o600);};
 const check=()=>inspectTelegramTrialAcceptanceReadOnly({
  stateFile:file,backupFile:backup,safetyFile:safety,now:Date.now(),staleAfterMs:900000
 });
 return {dir,file,backup,safety,store,policy,snapshot,check,close:()=>rm(dir,{recursive:true,force:true})};
}
test('B3 trial: locally valid mandatory subscription is accepted only as offline gate; no host activation',async()=>{
 const f=await fixture();try{
  await f.snapshot();
  const before=await readFile(f.file),backup=await readFile(f.backup);
  const result=await f.check();
  assert.deepEqual(result,{stage:'OFFLINE_ONLY',status:'PASS',safety:'STOP',
   rollback:'MATCH',reasons:[]});
  assert.deepEqual(await readFile(f.file),before);
  assert.deepEqual(await readFile(f.backup),backup);
 }finally{await f.close();}
});
test('B3 trial: locally revoked group with stale mandatory-channel rule BLOCKS even when rollback matches',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.chats.find(c=>c.id===GROUP)!.approved=false;});
  await f.snapshot();
  const r=await f.check();
  assert.equal(r.status,'BLOCKED');assert.equal(r.rollback,'MATCH');
  assert.deepEqual(r.reasons,['INVALID_SUBSCRIPTION_REQUIREMENTS']);
  assert.equal(JSON.stringify(r).includes(GROUP),false);
 }finally{await f.close();}
});
test('B3 trial: missing approval on mandatory channel is blocked, including verification-scope regression',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.chats.find(c=>c.id===CHANNEL)!.scopes=[];});
  await f.snapshot();
  const r=await f.check();
  assert.deepEqual(r.reasons,['INVALID_SUBSCRIPTION_REQUIREMENTS']);
  assert.equal(r.status,'BLOCKED');assert.equal(JSON.stringify(r).includes(CHANNEL),false);
 }finally{await f.close();}
});
test('B3 trial: duplicate/overlimit and bad-mode mandatory subscription still fail closed even when backup matches',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   const cfg=s.subscriptionRequirements[0]!;
   cfg.mode='BROKEN' as 'ALL';
   cfg.channelIds=[CHANNEL,CHANNEL,...Array.from({length:9},(_,i)=>'-100'+(400+i))];
  });
  await f.snapshot();
  const r=await f.check();
  assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.reasons,['INVALID_SUBSCRIPTION_REQUIREMENTS']);
 }finally{await f.close();}
});
test('B3 trial: paused/cleared requirements are not false blockers, nor do they release moderation',async()=>{
 const f=await fixture();try{
  await f.policy.pauseSubscriptionAtRevision(OWNER,GROUP,1,1);
  await f.store.transaction(s=>s.moderationReasons.push({
   chatId:GROUP,memberId:'300',source:'SUBSCRIPTION',reference:'subscription-gate',
   kind:'MUTE',createdBy:OWNER,active:true
  }));
  await f.snapshot();
  const r=await f.check();
  assert.equal(r.status,'PASS');
  assert.deepEqual(r.reasons,[]);
  assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);
 }finally{await f.close();}
});
test('B3 trial: overlapping safety STOP violation and invalid subscription must report both independently',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.chats.find(c=>c.id===CHANNEL)!.approved=false;});
  await f.snapshot();
  await writeFile(f.safety,'RUN\n');
  const r=await f.check();
  assert.deepEqual(r.reasons,['SAFETY_NOT_STOP','INVALID_SUBSCRIPTION_REQUIREMENTS']);
  assert.equal(r.status,'BLOCKED');
 }finally{await f.close();}
});
