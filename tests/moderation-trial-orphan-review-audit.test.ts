import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {BotStore,type AuditRecord} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {orphanModerationReviewAuditReceipts} from '../src/moderation-review-integrity.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';
import {localModerationTrialBlockers,inspectOfflineModerationTrialScope} from '../src/moderation-trial-scope.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {inspectIsolatedModerationRightsReadOnly} from '../src/moderation-trial-rights.js';

const OWNER='100',TRIAL='-100123',PRIVATE_MEMBER='399';
const reason='ORPHAN_MODERATION_REVIEW_AUDIT';
function orphanAudit():AuditRecord{
 return {actorId:OWNER,updateKey:'owner:moderation:review:'+
  createHash('sha256').update('MODERATION:REVIEW:private-missing-operation')
   .digest('hex').slice(0,32),
  decision:'ALLOW',reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
  policyVersion:1,at:Date.now()-1000};
}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-trial-orphan-review-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),
 safetyFile=join(dir,'stop.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'}),policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,TRIAL,['moderation']);
 await policy.setPresence(TRIAL,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 const backup=async()=>{await BotStore.backupSqlite(stateFile,backupFile);
  await chmod(backupFile,0o600);};
 const args=()=>({stateFile,backupFile,safetyFile,now:Date.now(),staleAfterMs:900_000});
 const scope=()=>({...args(),trialChatId:TRIAL});
 const addOrphan=async(count=1)=>store.transaction(s=>{
  for(let i=0;i<count;i++)s.audit.push({...orphanAudit(),at:Date.now()-1000+i});
 });
 return {dir,stateFile,backupFile,safetyFile,store,backup,args,scope,addOrphan,
  close:()=>rm(dir,{force:true,recursive:true})};
}
test('a matching backup with orphan owner review receipts is NOT clean general trial readiness',async()=>{
 const f=await fixture();try{
  await f.addOrphan();await f.backup();
  const before=await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]);
  const report=await inspectTelegramTrialAcceptanceReadOnly(f.args());
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.safety,'STOP');
  assert.equal(report.rollback,'MATCH');
  assert.deepEqual(report.reasons,[reason]);
  assert.doesNotMatch(JSON.stringify(report),/private-missing-operation|399|PRIVATE_MEMBER/);
  const after=await Promise.all([readFile(f.stateFile),readFile(f.backupFile),
   readFile(f.safetyFile)]);
  assert.deepEqual(after,before,'acceptance is read-only and preserves independent backup');
 }finally{await f.close();}
});
test('isolated trial scope with NO moderation operation still fails closed on orphan audit',async()=>{
 const f=await fixture();try{
  await f.addOrphan();await f.backup();
  const state=await f.store.snapshot();
  assert.equal(state.moderationOperations.length,0);
  assert.equal(state.moderationReasons.length,0);
  assert.equal(orphanModerationReviewAuditReceipts(state),1);
  assert.deepEqual(localModerationTrialBlockers(state,TRIAL),[reason]);
  const report=await inspectOfflineModerationTrialScope(f.scope());
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,[reason]);
  assert.equal(report.rollback,'MATCH');
 }finally{await f.close();}
});
test('two orphan receipts are one safe public blocker, not leaked counts or review keys',async()=>{
 const f=await fixture();try{
  await f.addOrphan(2);await f.backup();
  const s=await f.store.snapshot();
  assert.equal(orphanModerationReviewAuditReceipts(s),2);
  assert.deepEqual(localModerationTrialBlockers(s,TRIAL),[reason]);
  const report=await inspectOfflineModerationTrialScope(f.scope());
  assert.deepEqual(report.reasons,[reason]);
  assert.equal(JSON.stringify(report).includes(s.audit[0]!.updateKey),false);
 }finally{await f.close();}
});
test('unrelated FAQ audit noise does not obstruct isolated STOP trial',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.audit.push({
   updateKey:'owner:faq:normal-operation',actorId:OWNER,
   reason:'RESPONSE_PLANNED_ONLY',decision:'ALLOW',policyVersion:1,at:Date.now()
  }));
  await f.backup();
  const state=await f.store.snapshot();
  assert.equal(orphanModerationReviewAuditReceipts(state),0);
  assert.deepEqual(localModerationTrialBlockers(state,TRIAL),[]);
  assert.equal((await inspectTelegramTrialAcceptanceReadOnly(f.args())).status,'PASS');
  assert.equal((await inspectOfflineModerationTrialScope(f.scope())).status,'PASS');
 }finally{await f.close();}
});
test('an orphan review audit blocks remote rights probe BEFORE any network call',async()=>{
 const f=await fixture();try{
  await f.addOrphan();await f.backup();
  let network=0;
  const fetcher=(async()=>{network++;throw Error('MUST_NOT_CONTACT_TELEGRAM');}) as typeof fetch;
  const gateway=new TelegramBotApiModerationGateway(
   '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',fetcher);
  const result=await inspectIsolatedModerationRightsReadOnly(f.scope(),gateway);
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.botRights,'NOT_CHECKED');
  assert.deepEqual(result.reasons,[reason]);
  assert.equal(network,0);
 }finally{await f.close();}
});
test('generic acceptance CLI exits blocked and never prints orphan audit identifiers or secrets',async()=>{
 const f=await fixture();try{
  await f.addOrphan();await f.backup();
  const a=spawnSync(process.execPath,[
   'dist/src/telegram-trial-acceptance-cli.js','--offline-only',
   '--state',f.stateFile,'--backup',f.backupFile,'--safety',f.safetyFile,
   '--stale-ms','900000'
  ],{encoding:'utf8',timeout:15000,env:{...process.env,
   TELEGRAM_ENABLED:'false',TELEGRAM_BOT_TOKEN:'PRIVATE_TRIAL_TOKEN'}});
  assert.equal(a.status,2,a.stderr);
  assert.deepEqual(JSON.parse(a.stdout).reasons,[reason]);
  for(const secret of ['PRIVATE_TRIAL_TOKEN','private-missing-operation',f.dir,
   TRIAL,PRIVATE_MEMBER,orphanAudit().updateKey])
   assert.equal((a.stdout+a.stderr).includes(secret),false,secret);
 }finally{await f.close();}
});
test('isolated moderation trial CLI rejects orphan evidence and never reveals database path',async()=>{
 const f=await fixture();try{
  await f.addOrphan();await f.backup();
  const before=await readFile(f.stateFile);
  const a=spawnSync(process.execPath,[
   'dist/src/moderation-trial-scope-cli.js','--offline-only',
   '--state',f.stateFile,'--backup',f.backupFile,'--safety',f.safetyFile,
   '--stale-ms','900000','--trial-chat',TRIAL
  ],{encoding:'utf8',timeout:15000,env:{...process.env,
   TELEGRAM_ENABLED:'false',TELEGRAM_BOT_TOKEN:'PRIVATE_TRIAL_TOKEN'}});
  assert.equal(a.status,2,a.stderr);
  assert.deepEqual(JSON.parse(a.stdout).reasons,[reason]);
  assert.equal((a.stdout+a.stderr).includes(f.dir),false);
  assert.equal((a.stdout+a.stderr).includes(TRIAL),false);
  assert.deepEqual(await readFile(f.stateFile),before);
 }finally{await f.close();}
});
