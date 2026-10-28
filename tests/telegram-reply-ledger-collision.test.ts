import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type TelegramReplyJob} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramReplyDispatcher,type TelegramReplySender} from '../src/telegram-replies.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';

const OWNER='100',CHAT='300',UPDATE='b3-webhook:bot-test:91281';
const other='b3-webhook:bot-test:91282';
const reply=(key=UPDATE,text='PRIVATE_REPLY_BODY'):TelegramReplyJob=>({
 updateKey:key,status:'QUEUED',queuedAt:Date.now()-1000,
 privateReplyKind:'LOCAL',plan:{chatId:CHAT,parseMode:'HTML',text}
});
const terminal=(key=UPDATE):TelegramReplyJob=>({
 updateKey:key,status:'SENT',messageId:32,startedAt:Date.now()-1000,
 attemptId:'private-attempt-opaque',redactedAt:Date.now()-500
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-reply-ledger-collision-'));
 const stateFile=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 const backupFile=join(dir,'backup.sqlite'),safetyFile=join(dir,'safety.flag');
 const store=new BotStore(stateFile,{engine});
 await store.transaction(()=>undefined);
 if(engine==='sqlite')await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 const snapshot=async()=>{
  await BotStore.backupSqlite(stateFile,backupFile);
  await chmod(backupFile,0o600);
 };
 const options=()=>({stateFile,backupFile,safetyFile,
  now:Date.now(),staleAfterMs:900_000});
 return {dir,store,stateFile,backupFile,safetyFile,snapshot,options,
  close:()=>rm(dir,{force:true,recursive:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' duplicate QUEUED reply keys must not dispatch or change either stored plan',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.telegramReplyJobs=[
    reply(),reply(UPDATE,'OTHER_PRIVATE_BODY')
   ];});
   const before=await f.store.snapshot();
   let sends=0;
   const sender:TelegramReplySender={send:async()=>{
    sends++;return {status:'CONFIRMED',messageId:44};
   }};
   const dispatcher=new TelegramReplyDispatcher(f.store,
    new Policy(f.store,OWNER),sender);
   await assert.rejects(dispatcher.dispatch(UPDATE),/REPLY_DUPLICATE_UPDATE_KEY/);
   assert.equal(sends,0);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' contradictory finished reply receipts with the same key cannot be selected',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.telegramReplyJobs=[
    terminal(),{...terminal(),status:'FAILED_CONFIRMED'}
   ];});
   let sends=0;
   const sender:TelegramReplySender={send:async()=>{
    sends++;return {status:'CONFIRMED',messageId:44};
   }};
   const before=await f.store.snapshot();
   await assert.rejects(new TelegramReplyDispatcher(f.store,
    new Policy(f.store,OWNER),sender).dispatch(UPDATE),
    /REPLY_DUPLICATE_UPDATE_KEY/);
   assert.equal(sends,0);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' collision introduced during external send cannot manufacture SENT evidence',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.telegramReplyJobs=[reply()];});
   let sends=0;
   const sender:TelegramReplySender={send:async()=>{
    sends++;
    await f.store.transaction(s=>{
     const current=s.telegramReplyJobs![0]!;
     assert.equal(current.status,'SENDING');
     s.telegramReplyJobs!.push({...current,status:'FAILED_CONFIRMED',
      attemptId:'different-private-attempt'});
    });
    return {status:'CONFIRMED',messageId:44};
   }};
   await assert.rejects(new TelegramReplyDispatcher(f.store,
    new Policy(f.store,OWNER),sender).dispatch(UPDATE),
    /REPLY_DUPLICATE_UPDATE_KEY/);
   assert.equal(sends,1);
   const after=await f.store.snapshot();
   assert.equal(after.telegramReplyJobs?.length,2);
   assert.equal(after.telegramReplyJobs?.[0]?.status,'SENDING');
   assert.equal(after.telegramReplyJobs?.some(j=>j.messageId===44),false);
  }finally{await f.close();}
 });
}
test('matching SQLite backup cannot certify a colliding terminal reply ledger as PASS',async()=>{
 const f=await fixture('sqlite');try{
  await f.store.transaction(s=>{s.telegramReplyJobs=[
   terminal(),{...terminal(),status:'FAILED_CONFIRMED'}
  ];});
  await f.snapshot();
  const before=await Promise.all([readFile(f.stateFile),
   readFile(f.backupFile),readFile(f.safetyFile)]);
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.options());
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.rollback,'MATCH');
  assert.deepEqual(report.reasons,['UNSAFE_REPLY_LEDGER']);
  assert.equal(JSON.stringify(report).includes(UPDATE),false);
  assert.deepEqual(await Promise.all([readFile(f.stateFile),
   readFile(f.backupFile),readFile(f.safetyFile)]),before);
 }finally{await f.close();}
});
test('malformed terminal reply must not hide behind the absence of active sends',async()=>{
 const f=await fixture('sqlite');try{
  await f.store.transaction(s=>{s.telegramReplyJobs=[
   {...terminal(),updateKey:'FORGED_PRIVATE_KEY'} as TelegramReplyJob
  ];});
  await f.snapshot();
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.options());
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,['UNSAFE_REPLY_LEDGER']);
 }finally{await f.close();}
});
test('distinct valid terminal reply keys and unrelated FAQ audit retain offline PASS',async()=>{
 const f=await fixture('sqlite');try{
  await f.store.transaction(s=>{
   s.telegramReplyJobs=[terminal(),terminal(other)];
   s.audit.push({updateKey:'owner:faq:ordinary',actorId:OWNER,
    decision:'ALLOW',reason:'FAQ_APPROVED',policyVersion:1,at:Date.now()});
  });
  await f.snapshot();
  assert.deepEqual((await inspectTelegramTrialAcceptanceReadOnly(f.options())).reasons,[]);
  assert.equal((await inspectTelegramTrialAcceptanceReadOnly(f.options())).status,'PASS');
 }finally{await f.close();}
});
test('offline acceptance CLI redacts duplicate reply keys and returns BLOCKED',async()=>{
 const f=await fixture('sqlite');try{
  await f.store.transaction(s=>{s.telegramReplyJobs=[
   terminal(),{...terminal(),status:'FAILED_CONFIRMED'}
  ];});
  await f.snapshot();
  const result=spawnSync(process.execPath,[
   'dist/src/telegram-trial-acceptance-cli.js','--offline-only',
   '--state',f.stateFile,'--backup',f.backupFile,'--safety',f.safetyFile,
   '--stale-ms','900000'
  ],{encoding:'utf8',timeout:15000,env:{...process.env,
   TELEGRAM_ENABLED:'false',TELEGRAM_BOT_TOKEN:'PRIVATE_TEST_SECRET'}});
  assert.equal(result.status,2,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).reasons,['UNSAFE_REPLY_LEDGER']);
  for(const secret of [UPDATE,f.dir,'PRIVATE_TEST_SECRET','private-attempt-opaque'])
   assert.equal((result.stdout+result.stderr).includes(secret),false);
 }finally{await f.close();}
});
