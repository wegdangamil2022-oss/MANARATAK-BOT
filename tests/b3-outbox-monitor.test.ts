import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,lstat,readFile,symlink,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore} from '../src/store.js';
import {inspectTelegramOutboxReadOnly} from '../src/telegram-outbox-monitor.js';
const NOW=1_800_000_000_000;
const id=(n:number)=>'b3-webhook:bot-main:'+n;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-outbox-monitor-'));
 const stateFile=join(dir,'live.sqlite');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 await store.transaction(s=>{
  s.telegramReplyJobs=[
   {updateKey:id(1),status:'SENT',messageId:99,attemptId:'sent-attempt-1',startedAt:NOW-3_000_000},
   {updateKey:id(2),status:'QUEUED',queuedAt:NOW-10_000,plan:{chatId:'300',parseMode:'HTML',text:'Sensitive scholarship reply'}},
  ];
 });
 await chmod(stateFile,0o600);
 return {dir,stateFile,store,close:()=>rm(dir,{force:true,recursive:true})};
}
function cli(file:string, extra:string[]=[]){
 return spawnSync(process.execPath,['dist/src/telegram-outbox-monitor-cli.js','--once','--state',file,
  '--stale-ms','900000',...extra],{encoding:'utf8',timeout:15_000,
  env:{...process.env,TELEGRAM_BOT_TOKEN:'should_not_be_needed',TELEGRAM_ENABLED:'false'}});
}
test('read-only state snapshot can inspect private SQLite without requiring live bot configuration',async()=>{
 const f=await fixture();try{
  const before=await readFile(f.stateFile);
  const report=await inspectTelegramOutboxReadOnly(f.stateFile,{now:NOW,staleAfterMs:900_000});
  assert.deepEqual(report,{state:'OK',total:2,queued:1,sending:0,
   sent:1,failedConfirmed:0,unknownOutcome:0,staleQueued:0,staleSending:0,
   manualReviewRequired:0,awaitingFirstReview:0,reviewedUnresolved:0});
  assert.deepEqual(await readFile(f.stateFile),before);
  assert.equal((await f.store.snapshot()).telegramReplyJobs?.[1]?.plan?.text,'Sensitive scholarship reply');
 }finally{await f.close();}
});
test('monitor is read-only and never acknowledges, retries or resolves UNKNOWN outcomes',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.telegramReplyJobs!.push(
   {updateKey:id(3),status:'UNKNOWN_OUTCOME',attemptId:'unknown-attempt-3',startedAt:NOW-100_000});
  });
  const before=await f.store.snapshot();
  const r=await inspectTelegramOutboxReadOnly(f.stateFile,{now:NOW,staleAfterMs:900_000});
  assert.equal(r.state,'ATTENTION_REQUIRED');
  assert.equal(r.unknownOutcome,1);
  assert.equal(r.manualReviewRequired,1);
  assert.equal(r.awaitingFirstReview,1);
  assert.equal(JSON.stringify(r).includes('unknown-attempt-3'),false);
  assert.deepEqual(await f.store.snapshot(),before);
 }finally{await f.close();}
});
test('stale SENDING and QUEUED independently trigger attention without resending',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.telegramReplyJobs![1]!.queuedAt=NOW-2_000_000;
   s.telegramReplyJobs!.push({updateKey:id(4),status:'SENDING',
    attemptId:'stale-attempt-4',startedAt:NOW-2_000_000});
  });
  const r=await inspectTelegramOutboxReadOnly(f.stateFile,{now:NOW,staleAfterMs:900_000});
  assert.equal(r.state,'ATTENTION_REQUIRED');assert.equal(r.staleQueued,1);
  assert.equal(r.staleSending,1);assert.equal(r.manualReviewRequired,1);
  assert.equal(r.awaitingFirstReview,1);
 }finally{await f.close();}
});
test('reviewed unresolved remains alert-worthy and never becomes SENT',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.telegramReplyJobs!.push({
   updateKey:id(5),status:'UNKNOWN_OUTCOME',attemptId:'unknown-5',startedAt:NOW-100_000,
   manualReview:{attemptId:'unknown-5',decision:'ESCALATED',reviewedAt:NOW-50_000,reviewedBy:'100'}
  });});
  const report=await inspectTelegramOutboxReadOnly(f.stateFile,{now:NOW,staleAfterMs:900_000});
  assert.equal(report.state,'ATTENTION_REQUIRED');
  assert.equal(report.reviewedUnresolved,1);assert.equal(report.awaitingFirstReview,0);
  assert.equal(report.unknownOutcome,1);assert.equal(report.sent,1);
 }finally{await f.close();}
});
test('monitor rejects missing, symlinked, malformed, and world-readable state paths',async()=>{
 const f=await fixture();try{
  const missing=join(f.dir,'missing.sqlite');
  await assert.rejects(inspectTelegramOutboxReadOnly(missing,{now:NOW,staleAfterMs:900_000}),
   /TELEGRAM_OUTBOX_STATE_INVALID/);
  await assert.rejects(access(missing),{code:'ENOENT'});
  const alias=join(f.dir,'alias.sqlite');await symlink(f.stateFile,alias);
  await assert.rejects(inspectTelegramOutboxReadOnly(alias,{now:NOW,staleAfterMs:900_000}),
   /TELEGRAM_OUTBOX_STATE_INVALID/);
  await chmod(f.stateFile,0o644);
  await assert.rejects(inspectTelegramOutboxReadOnly(f.stateFile,{now:NOW,staleAfterMs:900_000}),
   /TELEGRAM_OUTBOX_STATE_INVALID/);
  await chmod(f.stateFile,0o600);
  const bogus=join(f.dir,'bogus.sqlite');await writeFile(bogus,'forged sqlite', {mode:0o600});
  await assert.rejects(inspectTelegramOutboxReadOnly(bogus,{now:NOW,staleAfterMs:900_000}),
   /TELEGRAM_OUTBOX_STATE_INVALID/);
 }finally{await f.close();}
});
test('monitor rejects relative paths, unauthorized object properties and stale threshold forgery',async()=>{
 const f=await fixture();try{
  for(const p of ['relative.sqlite',f.stateFile+'/../alias.sqlite',f.dir]){
   await assert.rejects(inspectTelegramOutboxReadOnly(p,{now:NOW,staleAfterMs:900_000}),
    /TELEGRAM_OUTBOX_STATE_INVALID/);
  }
  for(const o of [{now:-1,staleAfterMs:900000},{now:NOW,staleAfterMs:1},
   {now:NOW,staleAfterMs:900000,actorId:'100'},{now:NOW,staleAfterMs:900000,autoRetry:true}]){
   await assert.rejects(inspectTelegramOutboxReadOnly(f.stateFile,o),
    /TELEGRAM_OUTBOX_OPTIONS_INVALID/);
  }
 }finally{await f.close();}
});
test('outbox CLI healthy result is aggregate JSON, no Telegram token, text, path or identifiers',async()=>{
 const f=await fixture();try{
  const r=cli(f.stateFile);
  assert.equal(r.status,0,r.stderr);
  const report=JSON.parse(r.stdout) as {state:string;queued:number;sent:number};
  assert.equal(report.state,'OK');assert.equal(report.queued,1);assert.equal(report.sent,1);
  for(const sensitive of ['Sensitive scholarship reply',f.stateFile,'bot-main:1',
   'sent-attempt-1','300','should_not_be_needed']){
   assert.equal(r.stdout.includes(sensitive),false);
  }
 }finally{await f.close();}
});
test('outbox CLI returns ATTENTION_REQUIRED and distinct exit code for UNKNOWN',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.telegramReplyJobs!.push({
   updateKey:id(6),status:'UNKNOWN_OUTCOME',attemptId:'private-6',startedAt:Date.now()-100_000
  });});
  const r=cli(f.stateFile);
  assert.equal(r.status,2,r.stderr);
  const report=JSON.parse(r.stdout) as {state:string;unknownOutcome:number;manualReviewRequired:number};
  assert.equal(report.state,'ATTENTION_REQUIRED');assert.equal(report.unknownOutcome,1);
  assert.equal(report.manualReviewRequired,1);
  assert.equal(JSON.stringify(report).includes('private-6'),false);
 }finally{await f.close();}
});
test('outbox CLI rejects invalid/missing flags, path and threshold without leaking details',async()=>{
 const f=await fixture();try{
  for(const argv of [['--once','--state',f.stateFile,'--stale-ms','1'],['--state',f.stateFile],
   ['--once','--state',f.stateFile,'--stale-ms','900000','--send'],
   ['--once','--state',f.stateFile,'--stale-ms','900000','--actor','100']]){
    const result=spawnSync(process.execPath,['dist/src/telegram-outbox-monitor-cli.js',...argv],
     {encoding:'utf8',timeout:15_000});
    assert.equal(result.status,1,result.stderr);
    assert.equal(result.stdout,'');
    assert.match(result.stderr,/MANARATAK_OUTBOX_INVALID_REQUEST/);
    assert.equal(result.stderr.includes(f.stateFile),false);
  }
 }finally{await f.close();}
});
test('outbox CLI state failure does not fabricate an empty database or expose paths',async()=>{
 const f=await fixture();try{
  const missing=join(f.dir,'absent.sqlite');
  const result=cli(missing);
  assert.equal(result.status,1);
  assert.match(result.stderr,/MANARATAK_OUTBOX_INVALID_STATE/);
  assert.equal(result.stdout,'');
  assert.equal(result.stderr.includes(f.dir),false);
  await assert.rejects(access(missing),{code:'ENOENT'});
 }finally{await f.close();}
});
