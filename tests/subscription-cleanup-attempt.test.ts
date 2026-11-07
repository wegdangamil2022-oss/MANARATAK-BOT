import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore,type TelegramReplyJob} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramReplyDispatcher,type TelegramReplySender} from '../src/telegram-replies.js';
import {recordCleanupAttempt} from '../src/subscription-cleanup-attempt.js';
import {subscriptionFallbackReceiptDigest} from '../src/subscription-fallback-receipt.js';
const NOW=1700000000000,KEY='b3-webhook:cleanup-attempt:1';
const SEND='11111111-1111-1111-1111-111111111111',DELETE='22222222-2222-2222-2222-222222222222';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'cleanup-attempt-')),path=join(dir,'state.'+engine),store=new BotStore(path,{engine});let now=NOW+60000;
  // Synthetic confirmed-send evidence for isolated worker tests only.
  await store.transaction(s=>{
   const job:TelegramReplyJob={updateKey:KEY,status:'SENT',attemptId:SEND,messageId:88,verificationCleanup:{chatId:'300',scope:'-100',messageId:88,sendAttemptId:SEND,createdAt:NOW,deleteAfter:NOW+60000,status:'WAITING'}};
   (s.telegramReplyJobs??=[]).push(job);s.audit.push({updateKey:KEY+':fallback-sent',actorId:'300',decision:'ALLOW',reason:'SUBSCRIPTION_FALLBACK_SENT:'+subscriptionFallbackReceiptDigest(job.verificationCleanup!),policyVersion:0,at:NOW});
  });
  return {store,time:(n:number)=>{now=n;},now:()=>now,reopen:()=>new BotStore(path,{engine}),dispatcher:(sender:TelegramReplySender,safety:()=>Promise<boolean>=async()=>true,other=store)=>new TelegramReplyDispatcher(other,new Policy(other,'100'),sender,()=>now,safety,undefined,undefined,undefined,true),close:()=>rm(dir,{recursive:true,force:true})};
 }
 for(const outcome of ['ACKNOWLEDGED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','NOT_SENT'] as const){
  test(engine+' cleanup audits '+outcome+' and retries only a proven non-send',async()=>{const f=await fixture();try{
   let calls=0;const sender:TelegramReplySender={send:async()=>{throw Error('unexpected send');},deleteOwnPrivate:async(_chat,_message,verify)=>{assert.equal(await verify(),true);calls++;return outcome;}};
   const dispatcher=f.dispatcher(sender);await dispatcher.cleanupVerificationFallbacks();let s=await f.store.snapshot();
   assert.equal(s.audit.filter(a=>a.reason.startsWith('SUBSCRIPTION_CLEANUP_STARTED:')).length,1);
   assert.equal(s.audit.filter(a=>a.reason.startsWith('SUBSCRIPTION_CLEANUP_'+outcome+':')).length,1);
   assert.equal(s.telegramReplyJobs![0]!.verificationCleanup!.status,outcome==='NOT_SENT'?'WAITING':outcome);
   await dispatcher.cleanupVerificationFallbacks();assert.equal(calls,outcome==='NOT_SENT'?2:1);
   if(outcome==='NOT_SENT'){s=await f.store.snapshot();assert.equal(s.audit.filter(a=>a.reason.startsWith('SUBSCRIPTION_CLEANUP_STARTED:')).length,2);}
  }finally{await f.close();}});
 }
 test(engine+' cleanup expiration is local unsent evidence, survives reload and never calls Telegram',async()=>{const f=await fixture();try{
  f.time(NOW+48*3600000);let calls=0;const sender:TelegramReplySender={send:async()=>{throw Error('unexpected send');},deleteOwnPrivate:async()=>{calls++;return 'ACKNOWLEDGED';}};
  assert.equal((await f.dispatcher(sender).cleanupVerificationFallbacks()).checked,1);assert.equal(calls,0);
  const s=await f.reopen().snapshot();assert.equal(s.telegramReplyJobs![0]!.verificationCleanup!.status,'EXPIRED_UNSENT');
  assert.equal(s.audit.filter(a=>a.reason.startsWith('SUBSCRIPTION_CLEANUP_EXPIRED_UNSENT:')).length,1);
  assert.equal((await f.dispatcher(sender,undefined,f.reopen()).cleanupVerificationFallbacks()).checked,0);
 }finally{await f.close();}});
 test(engine+' expiration during the adapter wait prevents deletion and expires on the next tick',async()=>{const f=await fixture();try{
  f.time(NOW+48*3600000-1);let calls=0;
  const dispatcher=f.dispatcher({send:async()=>{throw Error('unexpected send');},deleteOwnPrivate:async(_chat,_message,verify)=>{f.time(NOW+48*3600000);if(!await verify())return 'NOT_SENT';calls++;return 'ACKNOWLEDGED';}});
  await dispatcher.cleanupVerificationFallbacks();assert.equal(calls,0);await dispatcher.cleanupVerificationFallbacks();
  assert.equal((await f.store.snapshot()).telegramReplyJobs![0]!.verificationCleanup!.status,'EXPIRED_UNSENT');
 }finally{await f.close();}});
 test(engine+' interrupted cleanup becomes uncertain after timeout without retry, including after restart',async()=>{const f=await fixture();try{
  await f.store.transaction(s=>{const job=s.telegramReplyJobs![0]!,receipt=job.verificationCleanup!;receipt.status='DELETING';receipt.attemptId=DELETE;assert.equal(recordCleanupAttempt(s,job,receipt,NOW+60000),true);});
  let calls=0;const dispatcher=f.dispatcher({send:async()=>{throw Error('unexpected send');},deleteOwnPrivate:async()=>{calls++;return 'ACKNOWLEDGED';}},undefined,f.reopen());
  f.time(NOW+89999);assert.equal((await dispatcher.cleanupVerificationFallbacks()).checked,0);
  f.time(NOW+90000);const result=await dispatcher.cleanupVerificationFallbacks();assert.equal(result.unresolved,1);assert.equal(result.checked,1);assert.equal(calls,0);
  assert.equal((await dispatcher.cleanupVerificationFallbacks()).checked,0);
  const s=await f.reopen().snapshot();assert.equal(s.telegramReplyJobs![0]!.verificationCleanup!.status,'UNKNOWN_OUTCOME');assert.equal(s.audit.filter(a=>a.reason.startsWith('SUBSCRIPTION_CLEANUP_UNKNOWN_OUTCOME:')).length,1);
 }finally{await f.close();}});
 test(engine+' interrupted cleanup refuses missing or duplicated start witnesses and STOP',async()=>{
  for(const variant of ['missing','duplicate','stop'] as const){const f=await fixture();try{
   await f.store.transaction(s=>{const job=s.telegramReplyJobs![0]!,receipt=job.verificationCleanup!;receipt.status='DELETING';receipt.attemptId=DELETE;if(variant!=='missing'){assert.equal(recordCleanupAttempt(s,job,receipt,NOW+60000),true);if(variant==='duplicate')s.audit.push({...s.audit.at(-1)!});}});
   f.time(NOW+90000);const result=await f.dispatcher({send:async()=>{throw Error('unexpected send');},deleteOwnPrivate:async()=>{throw Error('unexpected delete');}},async()=>variant!=='stop').cleanupVerificationFallbacks();assert.equal(result.checked,0);assert.equal((await f.store.snapshot()).telegramReplyJobs![0]!.verificationCleanup!.status,'DELETING');
  }finally{await f.close();}}
 });
 test(engine+' a late acknowledgement cannot replace a recovered uncertain result',async()=>{const f=await fixture();try{
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),waiting=new Promise<void>(r=>{release=r;});let calls=0;
  const dispatcher=f.dispatcher({send:async()=>{throw Error('unexpected send');},deleteOwnPrivate:async(_chat,_message,verify)=>{assert.equal(await verify(),true);calls++;entered();await waiting;return 'ACKNOWLEDGED';}});
  const first=dispatcher.cleanupVerificationFallbacks();await started;f.time(NOW+90000);assert.equal((await dispatcher.cleanupVerificationFallbacks()).unresolved,1);release();assert.equal((await first).acknowledged,0);assert.equal(calls,1);
  const s=await f.store.snapshot();assert.equal(s.telegramReplyJobs![0]!.verificationCleanup!.status,'UNKNOWN_OUTCOME');assert.equal(s.audit.filter(a=>a.reason.startsWith('SUBSCRIPTION_CLEANUP_ACKNOWLEDGED:')).length,0);
 }finally{await f.close();}});
 test(engine+' clock rollback after claiming blocks the request and keeps uncertainty until a safe recovery',async()=>{const f=await fixture();try{
  let calls=0;const dispatcher=f.dispatcher({send:async()=>{throw Error('unexpected send');},deleteOwnPrivate:async(_chat,_message,verify)=>{f.time(NOW+59999);assert.equal(await verify(),false);calls++;return 'NOT_SENT';}});
  await assert.rejects(dispatcher.cleanupVerificationFallbacks(),/VERIFICATION_CLEANUP_AUDIT_CONFLICT/);
  assert.equal((await f.store.snapshot()).telegramReplyJobs![0]!.verificationCleanup!.status,'DELETING');
  f.time(NOW+90000);assert.equal((await dispatcher.cleanupVerificationFallbacks()).unresolved,1);assert.equal(calls,1);
  assert.equal((await dispatcher.cleanupVerificationFallbacks()).checked,0);
 }finally{await f.close();}});
 test(engine+' batch bounds apply across interrupted and waiting receipts',async()=>{const f=await fixture();try{
  await f.store.transaction(s=>{
   const first=s.telegramReplyJobs![0]!,second=structuredClone(first);second.updateKey='b3-webhook:cleanup-attempt:2';second.messageId=89;second.verificationCleanup!.messageId=89;
   s.telegramReplyJobs!.push(second);s.audit.push({updateKey:second.updateKey+':fallback-sent',actorId:'300',decision:'ALLOW',reason:'SUBSCRIPTION_FALLBACK_SENT:'+subscriptionFallbackReceiptDigest(second.verificationCleanup!),policyVersion:0,at:NOW});
   first.verificationCleanup!.status='DELETING';first.verificationCleanup!.attemptId=DELETE;assert.equal(recordCleanupAttempt(s,first,first.verificationCleanup!,NOW+60000),true);
  });
  f.time(NOW+90000);let calls=0;const dispatcher=f.dispatcher({send:async()=>{throw Error('unexpected send');},deleteOwnPrivate:async(_chat,_message,verify)=>{assert.equal(await verify(),true);calls++;return 'ACKNOWLEDGED';}});
  assert.equal((await dispatcher.cleanupVerificationFallbacks(1)).unresolved,1);assert.equal(calls,0);
  assert.equal((await dispatcher.cleanupVerificationFallbacks(1)).acknowledged,1);assert.equal(calls,1);
 }finally{await f.close();}});
}
