import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {localModerationTrialBlockers,inspectOfflineModerationTrialScope} from '../src/moderation-trial-scope.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {inspectIsolatedModerationRightsReadOnly} from '../src/moderation-trial-rights.js';
const OWNER='100',TRIAL='-100123',OTHER='-100234',MEMBER='300';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-strict-moderation-isolation-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite'),safetyFile=join(dir,'safety.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'}),policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,TRIAL,['moderation']);
 await policy.setPresence(TRIAL,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 const backup=async()=>{await BotStore.backupSqlite(stateFile,backupFile);await chmod(backupFile,0o600);};
 const options=()=>({stateFile,backupFile,safetyFile,now:Date.now(),staleAfterMs:900_000,trialChatId:TRIAL});
 return {dir,stateFile,backupFile,safetyFile,store,policy,backup,options,
  check:()=>inspectOfflineModerationTrialScope(options()),
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('only one locally approved chat of ANY scope may coexist with a trial',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,OTHER,['navigation','publishing']);
  await f.backup();
  const state=await f.store.snapshot();
  assert.deepEqual(localModerationTrialBlockers(state,TRIAL),['OTHER_APPROVED_CHAT_PRESENT']);
  const report=await f.check();
  assert.equal(report.status,'BLOCKED');
  assert.deepEqual(report.reasons,['OTHER_APPROVED_CHAT_PRESENT']);
  assert.equal(JSON.stringify(report).includes(OTHER),false);
 }finally{await f.close();}
});
test('unapproved other chats are permitted when they have no moderation evidence',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,OTHER,['navigation']);
  await f.policy.revokeChat(OWNER,OTHER);
  await f.backup();
  assert.deepEqual((await f.check()).reasons,[]);
 }finally{await f.close();}
});
test('an unrelated moderation-approved chat returns single existing precise reason, not duplicate',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,OTHER,['moderation']);
  await f.backup();
  assert.deepEqual((await f.check()).reasons,['OTHER_MODERATION_GROUP_APPROVED']);
 }finally{await f.close();}
});
for(const [name,mutate,expected] of [
 ['past moderation operation',(s:any)=>{
  s.moderationOperations.push({id:'out-of-scope',chatId:OTHER,memberId:MEMBER,actorId:OWNER,
   kind:'BAN',reasonFingerprint:'opaque',policyVersion:1,status:'CONFIRMED',createdAt:1});
 },'OTHER_MODERATION_HISTORY'],
 ['inactive moderation reason',(s:any)=>{
  s.moderationReasons.push({chatId:OTHER,memberId:MEMBER,source:'MANUAL',reference:'other',
   kind:'BAN',createdBy:OWNER,active:false});
 },'OTHER_MODERATION_REASONS'],
 ['past trial warning',(s:any)=>{
  s.warnings.push({chatId:TRIAL,memberId:MEMBER,actorId:OWNER,reference:'prior',at:1,active:false});
 },'TRIAL_GROUP_HAS_WARNINGS'],
 ['warning in other chat',(s:any)=>{
  s.warnings.push({chatId:OTHER,memberId:MEMBER,actorId:OWNER,reference:'prior',at:1,active:false});
 },'OTHER_MODERATION_WARNINGS'],
 ['trial moderator delegation',(s:any)=>{
  s.grants.push({actor:MEMBER,capability:'chat.manage',chatId:TRIAL,
   expiresAt:Date.now()+900000,grantedBy:OWNER,revoked:false});
 },'TRIAL_GROUP_HAS_MODERATION_GRANTS'],
 ['other-chat moderator delegation',(s:any)=>{
  s.grants.push({actor:MEMBER,capability:'chat.manage',chatId:OTHER,
   expiresAt:Date.now()+900000,grantedBy:OWNER,revoked:false});
 },'OTHER_MODERATION_GRANTS']
] as const){
 test('offline isolation refuses '+name+' even if no second chat is approved',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>mutate(s));
   await f.backup();
   const out=await f.check();
   assert.equal(out.status,'BLOCKED');
   assert.deepEqual(out.reasons,[expected]);
   assert.equal(JSON.stringify(out).includes(MEMBER),false);
   assert.equal(JSON.stringify(out).includes(OTHER),false);
  }finally{await f.close();}
 });
}
test('revoked moderation delegation does not remain a live authority blocker',async()=>{
 const f=await fixture();try{
  await f.policy.grant(OWNER,MEMBER,'chat.manage',TRIAL,Date.now()+900000);
  await f.policy.revokeGrant(OWNER,MEMBER,'chat.manage',TRIAL);
  await f.backup();
  assert.deepEqual((await f.check()).reasons,[]);
 }finally{await f.close();}
});
test('all new blockers refuse remote Telegram reads in read-only rights preflight',async()=>{
 const f=await fixture();try{
  await f.policy.approveChat(OWNER,OTHER,['navigation']);
  await f.backup();
  let calls=0;
  const request=(async()=>{calls++;throw Error('MUST_NOT_CONTACT_REMOTE');}) as typeof fetch;
  const gw=new TelegramBotApiModerationGateway(
   '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request);
  const before=await readFile(f.stateFile);
  const out=await inspectIsolatedModerationRightsReadOnly(f.options(),gw);
  assert.equal(out.status,'BLOCKED');
  assert.equal(out.botRights,'NOT_CHECKED');
  assert.deepEqual(out.reasons,['OTHER_APPROVED_CHAT_PRESENT']);
  assert.equal(calls,0);
  assert.deepEqual(await readFile(f.stateFile),before);
 }finally{await f.close();}
});
