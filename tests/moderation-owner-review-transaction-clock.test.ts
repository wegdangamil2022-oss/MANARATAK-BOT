import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const NOW=1_800_000_000_000;
const OWNER='100',CHAT='-100123',TARGET='300';
const MAX_TIME=8_640_000_000_000_000;
type View=ModerationUnknownOwnerReview;
type Screen=Awaited<ReturnType<View['handle']>>;
function token(screen:Screen,prefix:string):string{
 const key=screen?.keyboard.inline_keyboard.flat()
  .find(b=>b.callback_data.startsWith(prefix))?.callback_data;
 assert.ok(key,'expected '+prefix);
 return key;
}
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-review-clock-recheck-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 const version=policy.chatRevision(await store.snapshot(),CHAT);
 await store.transaction(s=>s.moderationOperations.push({
  id:'PRIVATE_OWNER_CASE',chatId:CHAT,memberId:TARGET,actorId:OWNER,
  kind:'MUTE',status:'UNKNOWN_OUTCOME',
  reasonFingerprint:'PRIVATE_CASE_EVIDENCE',policyVersion:version,
  createdAt:NOW-10_000,attemptGateway:'TELEGRAM_API'
 }));
 let observation=NOW;
 let sequence:number[]=[];
 const clock=()=>sequence.length?sequence.shift()!:observation;
 const handle=(route:string)=>new ModerationUnknownOwnerReview(
  new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,()=>NOW),
  clock).handle(route,OWNER);
 const previewRoute=async()=>{
  const list=await handle('mr:1:h');
  const detail=await handle(token(list,'mr:1:d:'));
  return token(detail,'mr:1:v:');
 };
 const issue=async()=>{
  const key=await previewRoute();
  const view=await handle(key);
  return token(view,'c_');
 };
 const state=()=>store.snapshot();
 return {store,handle,previewRoute,issue,state,
  setNow:(now:number)=>{observation=now;sequence=[];},
  setSequence:(...n:number[])=>{sequence=[...n];},
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' preview cannot mint a review nonce after its observed clock rolls backward at transaction commit',async()=>{
  const f=await fixture(engine);try{
   const preview=await f.previewRoute();
   const before=await f.state();
   f.setSequence(NOW,NOW-1000);
   assert.equal(await f.handle(preview),null);
   const after=await f.state();
   assert.equal(after.callbacks.length,0);
   assert.deepEqual(after.moderationOperations,before.moderationOperations);
   assert.deepEqual(after.audit,before.audit);
  }finally{await f.close();}
 });
 test(engine+' preview cannot mint a review nonce if database queue delay exceeds two minutes',async()=>{
  const f=await fixture(engine);try{
   const preview=await f.previewRoute();
   f.setSequence(NOW,NOW+120001);
   assert.equal(await f.handle(preview),null);
   assert.equal((await f.state()).callbacks.length,0);
  }finally{await f.close();}
 });
 test(engine+' preview must date its confirmation expiry from the verified transaction clock',async()=>{
  const f=await fixture(engine);try{
   const preview=await f.previewRoute();
   f.setSequence(NOW,NOW+30_000);
   const issued=await f.handle(preview);
   const key=token(issued,'c_');
   const row=(await f.state()).callbacks.find(x=>x.ref===key);
   assert.ok(row);
   assert.equal(row.expiresAt,NOW+30_000+120000);
   assert.equal(row.used,false);
  }finally{await f.close();}
 });
 test(engine+' confirmation cannot record an audit in the future after clock rollback during store transaction',async()=>{
  const f=await fixture(engine);try{
   const key=await f.issue();
   const before=await f.state();
   f.setSequence(NOW+2000,NOW-1000);
   assert.equal(await f.handle(key),null);
   const after=await f.state();
   assert.equal(after.callbacks.find(c=>c.ref===key)?.used,false);
   assert.equal(after.moderationOperations[0]?.review,undefined);
   assert.deepEqual(after.audit,before.audit);
  }finally{await f.close();}
 });
 test(engine+' confirmation must reject a token that expires while waiting for transaction commit',async()=>{
  const f=await fixture(engine);try{
   const key=await f.issue();
   const before=await f.state();
   f.setSequence(NOW+1000,NOW+120000);
   assert.equal(await f.handle(key),null);
   const after=await f.state();
   assert.equal(after.callbacks.find(c=>c.ref===key)?.used,false);
   assert.deepEqual(after.moderationOperations,before.moderationOperations);
   assert.deepEqual(after.audit,before.audit);
  }finally{await f.close();}
 });
 test(engine+' a valid confirmed review records its actual atomic commit clock, not an earlier entry time',async()=>{
  const f=await fixture(engine);try{
   const key=await f.issue();
   f.setSequence(NOW+1000,NOW+30_000);
   const response=await f.handle(key);
   assert.match(response?.text??'',/تم حفظ مراجعة/);
   const state=await f.state();
   const o=state.moderationOperations[0]!;
   const receipt=state.audit.find(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED');
   assert.ok(receipt);
   assert.equal(o.review?.reviewedAt,NOW+30_000);
   assert.equal(receipt.at,NOW+30_000);
   assert.equal(o.status,'UNKNOWN_OUTCOME');
   assert.equal(state.callbacks.find(c=>c.ref===key)?.used,true);
   assert.equal(await f.handle(key),null,'nonce cannot be replayed');
   const gateway=new FakeModerationGateway();
   const result=await new ModerationService(f.store,new Policy(f.store,OWNER,()=>NOW),
    gateway,()=>NOW+30_000).reconcile(OWNER,CHAT,TARGET);
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' stable clock keeps normal owner review flow intact',async()=>{
  const f=await fixture(engine);try{
   const key=await f.issue();
   const accepted=await f.handle(key);
   assert.match(accepted?.text??'',/تم حفظ مراجعة/);
   const state=await f.state();
   assert.equal(state.moderationOperations[0]?.review?.reviewedAt,NOW);
   assert.equal(state.callbacks.find(c=>c.ref===key)?.used,true);
   assert.equal(state.audit.filter(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED').length,1);
  }finally{await f.close();}
 });
}
for(const [name,bad] of [
 ['not a number',Number.NaN],
 ['infinity',Number.POSITIVE_INFINITY],
 ['negative',-5],
 ['fraction',NOW+0.5],
 ['beyond supported epoch',MAX_TIME+1],
] as const){
 test('invalid preview transaction clock '+name+' never creates a confirmation nonce',async()=>{
  const f=await fixture('json');try{
   const key=await f.previewRoute();
   f.setSequence(NOW,bad);
   assert.equal(await f.handle(key),null);
   assert.equal((await f.state()).callbacks.length,0);
  }finally{await f.close();}
 });
 test('invalid confirmation transaction clock '+name+' never consumes nonce or audit',async()=>{
  const f=await fixture('json');try{
   const key=await f.issue();
   f.setSequence(NOW+1000,bad);
   assert.equal(await f.handle(key),null);
   const state=await f.state();
   assert.equal(state.callbacks.find(c=>c.ref===key)?.used,false);
   assert.equal(state.moderationOperations[0]?.review,undefined);
   assert.equal(state.audit.some(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED'),false);
  }finally{await f.close();}
 });
}
