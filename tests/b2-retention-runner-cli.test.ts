import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationPurgeService,FakePurgeGateway} from '../src/moderation-purge.js';
import {runRetentionReviewCli} from '../src/retention-review-cli.js';

const OWNER='100',DAY=86_400_000,START=100*DAY;
async function fixture(engine:'json'|'sqlite'='json') {
 const dir=await mkdtemp(join(tmpdir(),'retention-cli-'));
 const file=join(dir,engine==='sqlite'?'bot.sqlite':'bot.json');
 let now=START;
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 // Explicit persisted, approved bot state. CLI must not bootstrap missing files.
 await policy.approveChat(OWNER,'-100',['moderation']);
 await chmod(file,0o600);
 const gateway=new FakePurgeGateway();
 const service=()=>new ModerationPurgeService(new BotStore(file,{engine}),
   new Policy(new BotStore(file,{engine}),OWNER,clock),gateway,clock);
 const args=['--review-only','--store',file,'--engine',engine];
 const env={MANARATAK_OWNER_ID:OWNER};
 return {dir,file,store,policy,gateway,service,args,env,clock,advance:(ms:number)=>{now+=ms},
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const) {
 test(`B2 retention CLI ${engine}: fail-closed disabled state, no gateway and no owner info in output`,async()=>{
  const f=await fixture(engine);try {
   const before=await f.store.snapshot();
   const result=await runRetentionReviewCli(f.args,f.env,f.clock);
   assert.deepEqual(result,{status:'DISABLED'});
   assert.equal(JSON.stringify(result).includes(OWNER),false);
   assert.deepEqual(await f.store.snapshot(),before);
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close()}
 });
 test(`B2 retention CLI ${engine}: due tick emits aggregate counts and cannot compact`,async()=>{
  const f=await fixture(engine);try {
   await f.service().observe({chatId:'-100',messageId:7,sentAt:f.clock()-DAY*2,observedAt:f.clock(),
    senderKind:'USER',senderId:'300',contentType:'TEXT',hasLinks:true,
    pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false}); // too old rejected
   await f.service().observe({chatId:'-100',messageId:8,sentAt:f.clock()-1000,observedAt:f.clock(),
    senderKind:'USER',senderId:'300',contentType:'TEXT',hasLinks:true,
    pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});
   await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
   assert.deepEqual(await runRetentionReviewCli(f.args,f.env,f.clock),{status:'NOT_DUE'});
   f.advance(DAY*3);
   const due=await runRetentionReviewCli(f.args,f.env,f.clock);
   assert.deepEqual(due,{status:'READY',expiredObserved:1,eligibleJobs:0,
     reasonsToRedact:0,evidenceIdsToRedact:0,senderFiltersToRedact:0});
   assert.equal(JSON.stringify(due).includes('300'),false);
   assert.equal(JSON.stringify(due).includes('messageId'),false);
   assert.equal(JSON.stringify(due).includes('digest'),false);
   assert.equal((await f.store.snapshot()).rollingMessageMeta.length,1);
   assert.deepEqual(await runRetentionReviewCli(f.args,f.env,f.clock),{status:'NOT_DUE'});
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close()}
 });
 test(`B2 retention CLI ${engine}: strict positional/flag grammar rejects all destructive aliases`,async()=>{
  const f=await fixture(engine);try{
   for(const flags of [
    [],['--store',f.file,'--engine',engine],
    ['--review-only','--store',f.file,'--engine',engine,'--compact'],
    ['--review-only','--store',f.file,'--engine',engine,'--delete'],
    ['--review-only','--store',f.file,'--engine',engine,'--owner',OWNER],
    ['--review-only','--store',f.file,'--engine',engine,'--store',f.file],
    ['--review-only','--store',f.file,'--engine',engine,'--review-only'],
    ['--review-only','--store',f.file,'--engine',engine,'--unknown'],
    ['--review-only','--store',f.file,'--engine'],
    ['--review-only','--store','relative-path','--engine',engine],
   ])await assert.rejects(runRetentionReviewCli(flags,f.env,f.clock),/RETENTION_RUNNER_INVALID_ARGUMENTS/);
   for(const id of ['', '0', 'alice', '100\n200'])await assert.rejects(
     runRetentionReviewCli(f.args,{MANARATAK_OWNER_ID:id},f.clock),/RETENTION_RUNNER_OWNER_REQUIRED/);
   assert.equal((await f.store.snapshot()).purgeRetentionReview,undefined);
  }finally{await f.close()}
 });
 test(`B2 retention CLI ${engine}: rejects missing, link and overly permissive state files without creating data`,async()=>{
  const f=await fixture(engine);try{
   const missing=join(f.dir,'missing.'+(engine==='sqlite'?'sqlite':'json'));
   const symlinkPath=join(f.dir,'linked-state');
   const before=await f.store.snapshot();
   await assert.rejects(runRetentionReviewCli(['--review-only','--store',missing,'--engine',engine],f.env,f.clock),
     /RETENTION_RUNNER_UNSAFE_STATE_FILE/);
   await assert.rejects(lstat(missing),{code:'ENOENT'});
   await symlink(f.file,symlinkPath);
   await assert.rejects(runRetentionReviewCli(['--review-only','--store',symlinkPath,'--engine',engine],f.env,f.clock),
     /RETENTION_RUNNER_UNSAFE_STATE_FILE/);
   await chmod(f.file,0o644);
   await assert.rejects(runRetentionReviewCli(f.args,f.env,f.clock),/RETENTION_RUNNER_UNSAFE_STATE_FILE/);
   await chmod(f.file,0o600);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close()}
 });
}
test('B2 retention CLI: actual Node subprocess uses JSON stdout only and exits nonzero on malicious args',async()=>{
 const f=await fixture('sqlite');try{
  await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
  await f.store.transaction(s=>{s.purgeRetentionReview!.nextCheckAt=0;});
  const exec=promisify(execFile),script=fileURLToPath(new URL('../src/retention-review-cli.js',import.meta.url));
  const opts={env:{...process.env,MANARATAK_OWNER_ID:OWNER},timeout:20_000};
  const ok=await exec(process.execPath,[script,...f.args],opts);
  assert.equal(JSON.parse(ok.stdout).status,'READY');
  assert.equal(ok.stderr,'');
  const after=await f.store.snapshot();
  assert.equal(after.audit.filter(a=>a.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
  const bad=await exec(process.execPath,[script,...f.args,'--compact'],opts).then(
   ()=>null,e=>e as Error&{stdout:string;stderr:string;code:number});
  assert.ok(bad);
  assert.notEqual(bad!.code,0);
  assert.equal(bad!.stdout,'');
  assert.match(bad!.stderr,/RETENTION_RUNNER_INVALID_ARGUMENTS/);
  assert.equal(bad!.stderr.includes(f.file),false);
  assert.equal(bad!.stderr.includes(OWNER),false);
 }finally{await f.close()}
});
test('B2 retention CLI: two independent SQLite subprocesses share one due claim',async()=>{
 const f=await fixture('sqlite');try{
  await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
  await f.store.transaction(s=>{s.purgeRetentionReview!.nextCheckAt=0;});
  const exec=promisify(execFile),script=fileURLToPath(new URL('../src/retention-review-cli.js',import.meta.url));
  const opts={env:{...process.env,MANARATAK_OWNER_ID:OWNER},timeout:20_000};
  const both=await Promise.all([
   exec(process.execPath,[script,...f.args],opts),
   exec(process.execPath,[script,...f.args],opts),
  ]);
  assert.deepEqual(both.map(x=>JSON.parse(x.stdout).status).sort(),['NOT_DUE','READY']);
  assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});
