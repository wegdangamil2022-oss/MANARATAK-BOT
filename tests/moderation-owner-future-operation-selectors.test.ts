import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {summarizeModerationRecovery} from '../src/moderation-recovery-monitor.js';

const NOW=1_800_000_000_000,OWNER='100',CHAT='-100123',OTHER='-100456';
const futureAt=NOW+60_000;
const buttons=(screen:Awaited<ReturnType<ModerationUnknownOwnerReview['handle']>>,
 prefix='mr:1:d:')=>screen?.keyboard.inline_keyboard.flat()
 .filter(b=>b.callback_data.startsWith(prefix))??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-future-op-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.approveChat(OWNER,OTHER,['moderation']);
 let now=NOW;
 const op=(id:string,memberId:string,createdAt:number,chatId=CHAT):ModerationOperation=>({
  id,chatId,memberId,actorId:OWNER,kind:'MUTE',
  reasonFingerprint:'PRIVATE_FUTURE_OPERATION_EVIDENCE',
  policyVersion:policy.chatRevisionSnapshot(),status:'UNKNOWN_OUTCOME',
  createdAt,attemptGateway:'TELEGRAM_API'
 });
 const version=(await store.snapshot()).chats.find(c=>c.id===CHAT)!.version;
 const add=async(id:string,memberId:string,createdAt:number,chatId=CHAT)=>{
  const o:ModerationOperation={
   id,chatId,memberId,actorId:OWNER,kind:'MUTE',
   reasonFingerprint:'PRIVATE_FUTURE_OPERATION_EVIDENCE',
   policyVersion:version,status:'UNKNOWN_OUTCOME',
   createdAt,attemptGateway:'TELEGRAM_API'
  };
  await store.transaction(s=>s.moderationOperations.push(o));
 };
 const handle=(route:string)=>new ModerationUnknownOwnerReview(
  new BotStore(file,{engine}),policy,()=>now).handle(route,OWNER);
 const localService=()=>{
  const gateway=new FakeModerationGateway();
  return {gateway,service:new ModerationService(store,policy,gateway,()=>now)};
 };
 return {store,policy,add,handle,localService,setNow:(n:number)=>{now=n},
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' future unreviewed UNKNOWN must not appear as an owner selectable case',async()=>{
  const f=await fixture(engine);try{
   await f.add('private-future-case','399',futureAt);
   const before=await f.store.snapshot();
   const home=await f.handle('mr:1:h');
   assert.ok(home);
   assert.equal(buttons(home).length,0);
   assert.match(home.text,/عمليات مستقبلية محجوبة: 1/);
   assert.doesNotMatch(home.text,/private-future-case|PRIVATE_FUTURE_OPERATION_EVIDENCE|399|300/);
   assert.deepEqual(await f.store.snapshot(),before,'owner list never rewrites restored evidence');
   const {service,gateway}=f.localService();
   assert.equal((await service.reconcile(OWNER,CHAT,'399')).status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' future case hidden but unrelated past UNKNOWN remains reviewable',async()=>{
  const f=await fixture(engine);try{
   await f.add('private-past-case','300',NOW-500);
   await f.add('private-future-case','399',futureAt);
   const home=await f.handle('mr:1:h');
   assert.ok(home);
   assert.equal(buttons(home).length,1);
   assert.match(home.text,/الإجمالي القابل للعرض: 1/);
   assert.match(home.text,/عمليات مستقبلية محجوبة: 1/);
   const detail=await f.handle(buttons(home)[0]!.callback_data);
   assert.match(detail?.text??'',/UNKNOWN_OUTCOME/);
   assert.equal(buttons(detail,'mr:1:v:').length,2);
   assert.doesNotMatch(detail?.text??'',/399|private-future-case|PRIVATE_FUTURE_OPERATION_EVIDENCE/);
  }finally{await f.close();}
 });
 test(engine+' old future detail selector invalid after clock rolls back',async()=>{
  const f=await fixture(engine);try{
   await f.add('private-future-case','399',futureAt);
   f.setNow(futureAt);
   const pastView=await f.handle('mr:1:h');
   assert.equal(buttons(pastView).length,1);
   const token=buttons(pastView)[0]!.callback_data;
   f.setNow(NOW);
   assert.equal(await f.handle(token),null);
   const home=await f.handle('mr:1:h');
   assert.equal(buttons(home).length,0);
   assert.match(home?.text??'',/عمليات مستقبلية محجوبة: 1/);
   assert.equal((await f.store.snapshot()).callbacks.length,0);
  }finally{await f.close();}
 });
 test(engine+' owner review resumes exactly at the original operation timestamp',async()=>{
  const f=await fixture(engine);try{
   await f.add('private-future-case','399',futureAt);
   f.setNow(futureAt-1);
   assert.equal(buttons(await f.handle('mr:1:h')).length,0);
   f.setNow(futureAt);
   const list=await f.handle('mr:1:h');
   assert.equal(buttons(list).length,1);
   assert.match(list?.text??'',/عمليات مستقبلية محجوبة: 0/);
   const detail=await f.handle(buttons(list)[0]!.callback_data);
   assert.match(detail?.text??'',/UNKNOWN_OUTCOME/);
   assert.equal(buttons(detail,'mr:1:v:').length,2);
  }finally{await f.close();}
 });
 test(engine+' legacy reviewed future attempt is not represented as a clean review',async()=>{
  const f=await fixture(engine);try{
   await f.add('private-future-case','399',futureAt);
   const list=await f.handle('mr:1:h');
   assert.match(list?.text??'',/مستقبلية محجوبة: 1/);
   assert.equal(buttons(list).length,0);
   const state=await f.store.snapshot();
   const report=summarizeModerationRecovery(state,{now:NOW,staleAfterMs:900_000});
   assert.equal(report.clockAnomaly,1);
   assert.equal(report.state,'ATTENTION_REQUIRED');
   assert.equal(report.manualAttention,1);
  }finally{await f.close();}
 });
}
for(const now of [Number.NaN,Number.POSITIVE_INFINITY,-1,0.5,8_640_000_000_000_001]){
 test('invalid owner observation time '+String(now)+' rejects all selectors without audit mutations',async()=>{
  const f=await fixture('json');try{
   await f.add('private-past-case','300',NOW-500);
   const before=await f.store.snapshot();
   f.setNow(now);
   const list=await f.handle('mr:1:h');
   assert.ok(list);
   assert.equal(buttons(list).length,0);
   assert.match(list.text,/وقت النظام غير موثوق/);
   assert.doesNotMatch(list.text,/PRIVATE_FUTURE_OPERATION_EVIDENCE|private-past-case|300/);
   assert.equal(await f.handle('mr:1:d:0:1:abcdef012345'),null);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
}
