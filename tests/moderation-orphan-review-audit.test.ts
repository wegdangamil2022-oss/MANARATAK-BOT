import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type ModerationOperation,type AuditRecord} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {moderationLedgerSafeForDispatch} from '../src/moderation-review-integrity.js';
import {summarizeModerationRecovery,inspectModerationRecoveryReadOnly} from '../src/moderation-recovery-monitor.js';

const NOW=1_800_000_000_000,STALE=900_000,OWNER='100',CHAT='-100123',TARGET='300';
const opts=()=>({now:NOW,staleAfterMs:STALE});
function op(id='original-private-id',status:ModerationOperation['status']='UNKNOWN_OUTCOME'):ModerationOperation{
 return {id,chatId:CHAT,memberId:TARGET,actorId:OWNER,kind:'BAN',status,
  reasonFingerprint:'PRIVATE_REVIEW_EVIDENCE',policyVersion:1,
  createdAt:NOW-100_000,attemptGateway:'TELEGRAM_API'};
}
function audit(id='original-private-id'):AuditRecord{
 return {updateKey:'owner:moderation:review:'+
  createHash('sha256').update('MODERATION:REVIEW:'+id).digest('hex').slice(0,32),
  actorId:OWNER,decision:'ALLOW',reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
  policyVersion:1,at:NOW-50_000};
}
const other:AuditRecord={updateKey:'telegram:other-business-event',
 reason:'RESPONSE_PLANNED_ONLY',policyVersion:1,at:NOW-100,
 decision:'ALLOW'};
const orphans=(r:ReturnType<typeof summarizeModerationRecovery>):number|undefined=>
 Reflect.get(r,'orphanReviewAuditReceipts') as number|undefined;
function report(operations:ModerationOperation[],audits:AuditRecord[]){
 return summarizeModerationRecovery({moderationOperations:operations,audit:audits},opts());
}

test('orphan owner-review audit with empty moderation ledger is NOT a clean recovery',()=>{
 const r=report([],[audit()]);
 assert.equal(r.state,'ATTENTION_REQUIRED');
 assert.equal(r.totalOperations,0);
 assert.equal(r.unknownOutcome,0);
 assert.equal(r.manualAttention,0,'do not fabricate a moderation operation');
 assert.equal(orphans(r),1);
 assert.equal(r.untrustedReviewEvidence,0);
 assert.equal(r.distinctBlockedTargets,0);
});
test('duplicate missing-history receipts count individually with no invented Telegram delivery',()=>{
 const a=audit();
 const r=report([],[a,{...a},audit('another-private-id')]);
 assert.equal(orphans(r),3);
 assert.equal(r.state,'ATTENTION_REQUIRED');
 assert.equal(r.totalOperations,0);
});
test('mismatched or malformed owner-review correlation hashes cannot hide as clean',()=>{
 for(const updateKey of ['owner:moderation:review:'+'0'.repeat(32),
  'owner:moderation:review:TAMPERED_PRIVATE_CORRELATION']){
  const r=report([op()],[{...audit(),updateKey}]);
  assert.equal(orphans(r),1);
  assert.equal(r.state,'ATTENTION_REQUIRED');
 }
});
test('an owner review bound to terminal CONFIRMED after restoring a changed status is orphaned',()=>{
 const r=report([op('original-private-id','CONFIRMED')],[audit()]);
 assert.equal(orphans(r),1);
 assert.equal(r.state,'ATTENTION_REQUIRED');
});
test('non-moderation audits and optional audit omission do not fabricate orphan records',()=>{
 const r=report([],[other]);
 assert.equal(r.state,'OK');
 assert.equal(orphans(r),0);
 assert.equal(orphans(summarizeModerationRecovery({moderationOperations:[]},opts())),0);
});
test('a matching UNKNOWN receipt, even unreviewed, is not an orphan audit key',()=>{
 const r=report([op()],[audit()]);
 assert.equal(orphans(r),0);
 assert.equal(r.untrustedReviewEvidence,1,'the unreviewed operation still conflicts with existing audit');
 assert.equal(r.unknownOutcome,1);
});
test('orphan review audit globally blocks new moderation dispatch before adding reason',()=>{
 const s={moderationOperations:[],audit:[audit()]};
 assert.equal(moderationLedgerSafeForDispatch(s),false);
 const unrelated={moderationOperations:[],audit:[other]};
 assert.equal(moderationLedgerSafeForDispatch(unrelated),true);
 const matched={moderationOperations:[op()],audit:[audit()]};
 assert.equal(moderationLedgerSafeForDispatch(matched),true);
});

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-orphan-review-'));
 const file=join(dir,engine==='json'?'bot.json':'bot.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await store.transaction(s=>{s.audit.push(audit());});
 if(engine==='sqlite')await chmod(file,0o600);
 const view=()=>new ModerationUnknownOwnerReview(new BotStore(file,{engine}),
  new Policy(new BotStore(file,{engine}),OWNER,()=>NOW),()=>NOW);
 return {dir,file,store,policy,view,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' restored orphan receipt blocks a NEW simulated moderation attempt without mutating evidence',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(new BotStore(f.file,{engine}),
    new Policy(new BotStore(f.file,{engine}),OWNER,()=>NOW),gateway,()=>NOW);
   const result=await service.addManualReason(OWNER,CHAT,TARGET,'fresh-case','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
   const after=await f.store.snapshot();
   assert.deepEqual(after.moderationOperations,before.moderationOperations);
   assert.deepEqual(after.moderationReasons,before.moderationReasons);
   assert.deepEqual(after.audit,before.audit);
  }finally{await f.close();}
 });
 test(engine+' owner sees orphan audit warning, never a selectable operation or raw correlation key',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   const screen=await f.view().handle('mr:1:h',OWNER);
   assert.ok(screen);
   assert.match(screen.text,/يتيم|مفقود|منفصل|معزول/);
   assert.match(screen.text,/1/);
   assert.equal(screen.keyboard.inline_keyboard.flat().some(x=>
    x.callback_data.startsWith('mr:1:d:')),false);
   for(const secret of ['original-private-id','PRIVATE_REVIEW_EVIDENCE',audit().updateKey,TARGET]){
    assert.equal(screen.text.includes(secret),false);
   }
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
}
test('SQLite read-only recovery reports orphan audit without writes or fabricated operations',async()=>{
 const f=await fixture('sqlite');try{
  const before=await readFile(f.file);
  const r=await inspectModerationRecoveryReadOnly(f.file,opts());
  assert.equal(orphans(r),1);
  assert.equal(r.totalOperations,0);
  assert.equal(r.state,'ATTENTION_REQUIRED');
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
test('CLI after orphan audit restore exits 2 with only aggregate data, no Telegram keys or paths',async()=>{
 const f=await fixture('sqlite');try{
  const before=await readFile(f.file);
  const child=spawnSync(process.execPath,[
   'dist/src/moderation-recovery-monitor-cli.js','--once','--state',f.file,
   '--stale-ms',String(STALE)
  ],{encoding:'utf8',timeout:15_000,env:{...process.env,
   TELEGRAM_BOT_TOKEN:'PRIVATE_TELEGRAM_TOKEN',TELEGRAM_ENABLED:'false'}});
  assert.equal(child.status,2,child.stderr);
  const r=JSON.parse(child.stdout) as {orphanReviewAuditReceipts:number;totalOperations:number;state:string};
  assert.equal(r.orphanReviewAuditReceipts,1);
  assert.equal(r.totalOperations,0);
  assert.equal(r.state,'ATTENTION_REQUIRED');
  for(const secret of ['PRIVATE_TELEGRAM_TOKEN',f.file,
   audit().updateKey,'original-private-id',CHAT,TARGET]){
   assert.equal((child.stdout+child.stderr).includes(secret),false);
  }
  assert.deepEqual(await readFile(f.file),before);
 }finally{await f.close();}
});
