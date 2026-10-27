import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {summarizeModerationRecovery,inspectModerationRecoveryReadOnly} from '../src/moderation-recovery-monitor.js';

const OWNER='100',CHAT='-100123',TARGET='300',NOW=1_800_000_000_000;
const STALE=900_000;
const options=()=>({now:NOW,staleAfterMs:STALE});
function pending(status:'INTENT'|'STARTED',id='opaque-case'):ModerationOperation{
 return {id,chatId:CHAT,memberId:TARGET,actorId:OWNER,kind:'BAN',
  reasonFingerprint:'no-provider-claim',policyVersion:1,
  createdAt:NOW-1_000,status};
}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-crash-recovery-'));
 const file=join(dir,'bot.sqlite');
 const store=new BotStore(file,{engine:'sqlite'});
 await store.transaction(s=>{s.moderationOperations=[];});
 await chmod(file,0o600);
 return {dir,file,store,close:()=>rm(dir,{recursive:true,force:true})};
}

for(const status of ['INTENT','STARTED'] as const){
 test('offline recovery cannot mark fresh '+status+' as healthy after process restart',()=>{
  const r=summarizeModerationRecovery({moderationOperations:[pending(status)]},options());
  assert.equal(r.state,'ATTENTION_REQUIRED');
  assert.equal(r.manualAttention,1);
  assert.equal(r.staleIntent,0);
  assert.equal(r.staleStarted,0);
  assert.equal(r.unknownOutcome,0);
  assert.equal(r.distinctBlockedTargets,1);
 });
 test('read-only SQLite recovery treats fresh '+status+' as attention-worthy without touching evidence',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>s.moderationOperations.push(pending(status)));
   const before=await readFile(f.file);
   const report=await inspectModerationRecoveryReadOnly(f.file,options());
   assert.equal(report.state,'ATTENTION_REQUIRED');
   assert.equal(report.manualAttention,1);
   assert.equal(report.totalOperations,1);
   assert.deepEqual(await readFile(f.file),before);
  }finally{await f.close();}
 });
}
test('two fresh pending attempts and one acknowledged UNKNOWN still require three manual investigations',()=>{
 const r=summarizeModerationRecovery({moderationOperations:[
  pending('INTENT','intent'),
  {...pending('STARTED','started'),memberId:'301'},
  {...pending('STARTED','unknown'),memberId:'302',status:'UNKNOWN_OUTCOME',
   review:{decision:'ACKNOWLEDGED_UNRESOLVED',reviewedBy:OWNER,reviewedAt:NOW}}
 ]},options());
 assert.equal(r.state,'ATTENTION_REQUIRED');
 assert.equal(r.intent,1);
 assert.equal(r.started,1);
 assert.equal(r.unknownOutcome,1);
 assert.equal(r.manualAttention,3);
 assert.equal(r.distinctBlockedTargets,3);
});

test('CLI after restart exits with attention status for fresh STARTED, never emits private evidence or mutates DB',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.moderationOperations.push({
   ...pending('STARTED'),createdAt:Date.now()-1000,
   reasonFingerprint:'CRASH_CASE_PRIVATE_DIGEST'
  }));
  const before=await readFile(f.file);
  const x=spawnSync(process.execPath,[
   'dist/src/moderation-recovery-monitor-cli.js','--once','--state',f.file,
   '--stale-ms',String(STALE)
  ],{encoding:'utf8',timeout:15_000,env:{...process.env,
   TELEGRAM_BOT_TOKEN:'SECRET_TOKEN_CANNOT_APPEAR',TELEGRAM_ENABLED:'false'}});
  assert.equal(x.status,2,x.stderr);
  const report=JSON.parse(x.stdout) as {state:string;started:number;manualAttention:number;staleStarted:number};
  assert.equal(report.state,'ATTENTION_REQUIRED');
  assert.equal(report.started,1);
  assert.equal(report.manualAttention,1);
  assert.equal(report.staleStarted,0);
  for(const secret of ['CRASH_CASE_PRIVATE_DIGEST','SECRET_TOKEN_CANNOT_APPEAR',
   TARGET,CHAT,OWNER,f.file])assert.equal((x.stdout+x.stderr).includes(secret),false);
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});

test('restarted service never retries fresh unresolved STARTED or INTENT for original target',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'manaratak-crash-restart-lock-'));
 try{
  for(const engine of ['json','sqlite'] as const){
   const file=join(dir,engine==='json'?'state.json':'state.sqlite');
   const store=new BotStore(file,{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,CHAT,['moderation']);
   const version=policy.chatRevision(await store.snapshot(),CHAT);
   await store.transaction(s=>{
    s.moderationReasons.push({chatId:CHAT,memberId:TARGET,source:'MANUAL',
     reference:'case',kind:'BAN',createdBy:OWNER,active:true});
    s.moderationOperations.push({...pending('STARTED',engine+'-started'),policyVersion:version});
   });
   const restarted=new BotStore(file,{engine});
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(restarted,new Policy(restarted,OWNER,()=>NOW),gateway,()=>NOW);
   const answer=await service.reconcile(OWNER,CHAT,TARGET);
   assert.equal(answer.status,'BLOCKED_PENDING');
   assert.equal(gateway.calls.length,0);
   const rows=(await restarted.snapshot()).moderationOperations;
   assert.equal(rows.length,1);
   assert.equal(rows[0]?.status,'STARTED');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
