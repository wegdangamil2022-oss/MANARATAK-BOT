import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,chmod,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {inspectOfflineModerationTrialScope} from '../src/moderation-trial-scope.js';

const OWNER='100',TRIAL='-100123',OTHER='-100234';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-moderation-trial-scope-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite');
 const safetyFile=join(dir,'stop.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,TRIAL,['moderation']);
 await policy.setPresence(TRIAL,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 const snapshot=async()=>{
  await BotStore.backupSqlite(stateFile,backupFile);await chmod(backupFile,0o600);
 };
 const options=()=>({stateFile,backupFile,safetyFile,now:Date.now(),
  staleAfterMs:900_000,trialChatId:TRIAL});
 const check=()=>inspectOfflineModerationTrialScope(options());
 return {dir,stateFile,backupFile,safetyFile,store,policy,options,snapshot,check,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('a single clean, approved, present moderation group passes ONLY local scope review',async()=>{
 const f=await fixture();try{
  await f.snapshot();
  const before=await readFile(f.stateFile),backup=await readFile(f.backupFile);
  assert.deepEqual(await f.check(),{stage:'OFFLINE_MODERATION_TRIAL',status:'PASS',
   safety:'STOP',rollback:'MATCH',reasons:[]});
  assert.deepEqual(await readFile(f.stateFile),before);
  assert.deepEqual(await readFile(f.backupFile),backup);
 }finally{await f.close();}
});
test('a revoked trial group can never pass local isolation review',async()=>{
 const f=await fixture();try{
  await f.policy.revokeChat(OWNER,TRIAL);await f.snapshot();
  const r=await f.check();
  assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.reasons,['TRIAL_GROUP_NOT_APPROVED']);
 }finally{await f.close();}
});
test('a group not locally present cannot claim isolated trial readiness',async()=>{
 const f=await fixture();try{
  await f.policy.setPresence(TRIAL,false);await f.snapshot();
  const r=await f.check();assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.reasons,['TRIAL_GROUP_NOT_PRESENT']);
 }finally{await f.close();}
});
test('an approved group without moderation scope is blocked',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,TRIAL,['navigation']);await f.snapshot();
  const r=await f.check();assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.reasons,['TRIAL_MODERATION_SCOPE_MISSING']);
 }finally{await f.close();}
});
test('any second approved moderation group violates one-group isolation',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,OTHER,['moderation']);await f.snapshot();
  const r=await f.check();assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.reasons,['OTHER_MODERATION_GROUP_APPROVED']);
  assert.equal(JSON.stringify(r).includes(OTHER),false);
 }finally{await f.close();}
});
test('even a navigation-only approved second group violates strict single-chat trial isolation',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,OTHER,['navigation']);await f.snapshot();
  const r=await f.check();assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.reasons,['OTHER_APPROVED_CHAT_PRESENT']);
 }finally{await f.close();}
});
test('a supposedly fresh trial group with old moderation operations/reasons is blocked',async()=>{
 const f=await fixture();try{
  const version=(await f.store.snapshot()).chats.find(c=>c.id===TRIAL)!.version;
  await f.store.transaction(s=>{
   s.moderationOperations.push({id:'old-sanction',chatId:TRIAL,
    memberId:'300',actorId:OWNER,kind:'BAN',policyVersion:version,
    reasonFingerprint:'opaque',status:'CONFIRMED',createdAt:Date.now(),
    attemptGateway:'SIMULATION'});
   s.moderationReasons.push({chatId:TRIAL,memberId:'300',
    source:'MANUAL',reference:'old-case',kind:'BAN',createdBy:OWNER,active:false});
  });
  await f.snapshot();
  const r=await f.check();
  assert.deepEqual(r.reasons,['TRIAL_GROUP_HAS_MODERATION_HISTORY',
   'TRIAL_GROUP_HAS_MODERATION_REASONS']);
  assert.equal(r.status,'BLOCKED');
  assert.equal(JSON.stringify(r).includes('300'),false);
  assert.equal(JSON.stringify(r).includes('old-case'),false);
 }finally{await f.close();}
});
test('isolation result cannot bypass existing STOP or stale rollback evidence',async()=>{
 const f=await fixture();try{
  await f.snapshot();await writeFile(f.safetyFile,'RUN\n');
  let r=await f.check();
  assert.deepEqual(r.reasons,['SAFETY_NOT_STOP']);
  assert.equal(r.status,'BLOCKED');
  await writeFile(f.safetyFile,'STOP\n');
  const old=new Date(Date.now()-1_200_000);
  await utimes(f.backupFile,old,old);
  r=await f.check();
  assert.deepEqual(r.reasons,['BACKUP_TOO_OLD']);
  assert.equal(r.status,'BLOCKED');
 }finally{await f.close();}
});
test('operator-facing moderation trial CLI is status-only and rejects forged group selectors',async()=>{
 const f=await fixture();try{
  await f.snapshot();
  const command=(trialChatId:string,extra:string[]=[])=>spawnSync(process.execPath,[
   'dist/src/moderation-trial-scope-cli.js','--offline-only',
   '--state',f.stateFile,'--backup',f.backupFile,
   '--safety',f.safetyFile,'--stale-ms','900000','--trial-chat',trialChatId,
   ...extra
  ],{encoding:'utf8',timeout:15_000,env:{...process.env,
   TELEGRAM_ENABLED:'false',TELEGRAM_BOT_TOKEN:'FAKE_TOKEN_NEVER_ECHO'}});
  const ok=command(TRIAL);
  assert.equal(ok.status,0,ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout),{stage:'OFFLINE_MODERATION_TRIAL',
   status:'PASS',safety:'STOP',rollback:'MATCH',reasons:[]});
  const bad=command(OTHER);
  assert.equal(bad.status,2,bad.stderr);
  assert.deepEqual(JSON.parse(bad.stdout).reasons,[
   'TRIAL_GROUP_NOT_APPROVED','OTHER_MODERATION_GROUP_APPROVED']);
  for(const invalid of ['0','-0','-01','-9999999999999999','-100123;rm /']){
   const out=command(invalid);assert.equal(out.status,1);assert.equal(out.stdout,'');
   assert.match(out.stderr,/MANARATAK_MODERATION_TRIAL_INVALID_REQUEST/);
  }
  const extra=command(TRIAL,['--enable']);
  assert.equal(extra.status,1);assert.equal(extra.stdout,'');
  for(const v of [f.dir,TRIAL,'FAKE_TOKEN_NEVER_ECHO']){
   assert.equal(ok.stdout.includes(v),false);
   assert.equal(bad.stdout.includes(v),false);
  }
 }finally{await f.close();}
});
