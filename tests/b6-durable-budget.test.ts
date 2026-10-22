import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {B6DurableBudget} from '../src/b6-durable-budget.js';
const NOW=1_800_000_000_000;
const limits={maxDailyAttempts:3,maxDailyReservedTokens:600,maxConcurrent:2,leaseMs:60_000};
const key=(n:number)=>'request-'+String(n).padStart(8,'0');
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'b6-durable-ledger-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine});
 let now=NOW;
 const budget=(s=store,l=limits)=>new B6DurableBudget(s,l,()=>now);
 return {dir,store,file,budget,setNow:(time:number)=>{now=time;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': a reservation and complete persist after rebuilding store and budget instances',async()=>{
  const f=await fixture(engine);try{
   const original=f.budget();
   const a=await original.reserve(key(1),100);
   assert.equal(a.status,'RESERVED');
   if(a.status!=='RESERVED')return;
   assert.match(a.attemptId,/^[a-f0-9-]{36}$/);
   assert.equal(a.leaseUntil,NOW+60_000);
   assert.equal(await original.finish(key(1),a.attemptId,'COMPLETED'),'COMPLETED');
   const recreated=f.budget(new BotStore(f.file,{engine}));
   assert.deepEqual(await recreated.inspect(),{
    durable:true,day:new Date(NOW).toISOString().slice(0,10),
    attemptsToday:1,reservedTokensToday:100,active:0,unknownCount:0
   });
   assert.deepEqual(await recreated.reserve(key(1),100),{status:'DUPLICATE'});
   assert.equal(await recreated.finish(key(1),a.attemptId,'COMPLETED'),'STALE');
  }finally{await f.close();}
 });
 test('B6 '+engine+': request key replay is denied on same and next day, never issues another attempt',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.budget().reserve(key(1),100)).status,'RESERVED');
   assert.deepEqual(await f.budget().reserve(key(1),100),{status:'DUPLICATE'});
   f.setNow(NOW+86_400_000);
   assert.deepEqual(await f.budget().reserve(key(1),100),{status:'DUPLICATE'});
   assert.equal((await f.budget().reserve(key(2),100)).status,'RESERVED');
  }finally{await f.close();}
 });
 test('B6 '+engine+': expired in-flight requests become UNKNOWN_OUTCOME; attempts and tokens never refunded or auto retried',async()=>{
  const f=await fixture(engine);try{
   const a=await f.budget().reserve(key(1),200);
   assert.equal(a.status,'RESERVED');
   if(a.status!=='RESERVED')return;
   f.setNow(NOW+60_001);
   assert.equal(await f.budget().recoverExpired(),1);
   assert.equal(await f.budget().recoverExpired(),0);
   const snapshot=await f.store.snapshot();
   assert.equal(snapshot.b6BudgetAttempts?.[0]?.status,'UNKNOWN_OUTCOME');
   assert.deepEqual(await f.budget().reserve(key(1),200),{status:'DUPLICATE'});
   const summary=await f.budget().inspect();
   assert.equal(summary.attemptsToday,1);
   assert.equal(summary.reservedTokensToday,200);
   assert.equal(summary.unknownCount,1);
   assert.equal(summary.active,0);
   assert.equal(await f.budget().finish(key(1),a.attemptId,'COMPLETED'),'STALE');
  }finally{await f.close();}
 });
 test('B6 '+engine+': active reservation enforces concurrency and amount budgets atomically',async()=>{
  const f=await fixture(engine);try{
   const b=f.budget(f.store,{...limits,maxConcurrent:1,maxDailyReservedTokens:250});
   const a=await b.reserve(key(1),200);
   assert.equal(a.status,'RESERVED');
   assert.deepEqual(await b.reserve(key(2),50),{status:'BUSY'});
   if(a.status!=='RESERVED')return;
   assert.equal(await b.finish(key(1),a.attemptId,'COMPLETED'),'COMPLETED');
   assert.deepEqual(await b.reserve(key(2),100),{status:'BUDGET_EXHAUSTED'});
   assert.equal((await b.reserve(key(2),50)).status,'RESERVED');
   assert.deepEqual(await b.reserve(key(3),1),{status:'BUDGET_EXHAUSTED'});
  }finally{await f.close();}
 });
 test('B6 '+engine+': two simultaneous reservations from separate BotStore instances cannot overspend',async()=>{
  const f=await fixture(engine);try{
   const b1=f.budget(f.store,{...limits,maxDailyAttempts:1,maxConcurrent:2});
   const b2=f.budget(new BotStore(f.file,{engine}),{...limits,maxDailyAttempts:1,maxConcurrent:2});
   const both=await Promise.all([b1.reserve(key(1),10),b2.reserve(key(2),10)]);
   assert.equal(both.filter(x=>x.status==='RESERVED').length,1);
   assert.equal(both.filter(x=>x.status==='BUDGET_EXHAUSTED').length,1);
   assert.equal((await f.budget().inspect()).attemptsToday,1);
  }finally{await f.close();}
 });
 test('B6 '+engine+': successful, failed or unknown provider outcomes retain conservative full reserved token amount',async()=>{
  const f=await fixture(engine);try{
   const b=f.budget();
   const a=await b.reserve(key(1),300);
   assert.equal(a.status,'RESERVED');
   if(a.status!=='RESERVED')return;
   assert.equal(await b.finish(key(1),a.attemptId,'UNKNOWN_OUTCOME'),'UNKNOWN_OUTCOME');
   assert.equal((await b.inspect()).reservedTokensToday,300);
   assert.equal((await b.inspect()).unknownCount,1);
   assert.deepEqual(await b.reserve(key(2),301),{status:'BUDGET_EXHAUSTED'});
   assert.equal((await b.reserve(key(2),300)).status,'RESERVED');
  }finally{await f.close();}
 });
 test('B6 '+engine+': wrong attempt ID and duplicate finish cannot terminate another pending reservation',async()=>{
  const f=await fixture(engine);try{
   const b=f.budget(),a=await b.reserve(key(1),100);
   assert.equal(a.status,'RESERVED');
   if(a.status!=='RESERVED')return;
   assert.equal(await b.finish(key(1),'00000000-0000-4000-8000-000000000000','COMPLETED'),'STALE');
   assert.equal(await b.finish(key(2),a.attemptId,'COMPLETED'),'STALE');
   assert.equal((await b.inspect()).active,1);
   assert.equal(await b.finish(key(1),a.attemptId,'COMPLETED'),'COMPLETED');
   assert.equal(await b.finish(key(1),a.attemptId,'UNKNOWN_OUTCOME'),'STALE');
   assert.equal((await b.inspect()).active,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': monotonic high-water clock rejects rollback even if all requests finished',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.budget().reserve(key(1),100)).status,'RESERVED');
   f.setNow(NOW-1000);
   assert.deepEqual(await f.budget().reserve(key(2),100),{status:'CLOCK_ROLLBACK'});
   f.setNow(NOW);
   assert.equal((await f.budget().inspect()).attemptsToday,1);
  }finally{await f.close();}
 });
 test('B6 '+engine+': midnight resets calendar budgets, but old request key replay stays denied',async()=>{
  const f=await fixture(engine);try{
   const b=f.budget(f.store,{...limits,maxDailyAttempts:1});
   assert.equal((await b.reserve(key(1),600)).status,'RESERVED');
   assert.deepEqual(await b.reserve(key(2),1),{status:'BUDGET_EXHAUSTED'});
   f.setNow(NOW+86_400_000);
   assert.equal((await b.reserve(key(2),600)).status,'RESERVED');
   assert.deepEqual(await b.reserve(key(1),1),{status:'DUPLICATE'});
   assert.equal((await b.inspect()).attemptsToday,1);
  }finally{await f.close();}
 });
 test('B6 '+engine+': invalid request keys, units and limits are rejected before any durable write',async()=>{
  const f=await fixture(engine);try{
   const b=f.budget();
   for(const [k,units] of [['no',100],['../unsafe',100],[key(1),0],[key(1),-1],[key(1),1.5],[key(1),8193]] as const){
    assert.deepEqual(await b.reserve(k,units),{status:'INVALID_REQUEST'});
   }
   assert.deepEqual((await f.store.snapshot()).b6BudgetAttempts??[],[]);
   for(const config of [
    {...limits,maxDailyAttempts:0},{...limits,maxConcurrent:0},
    {...limits,maxDailyReservedTokens:0},{...limits,leaseMs:1},
    {...limits,maxDailyAttempts:1.5}
   ])assert.throws(()=>f.budget(f.store,config),/INVALID_B6_BUDGET_LIMITS/);
  }finally{await f.close();}
 });
 test('B6 '+engine+': corrupt persisted budget schema is fail-closed and never silently discarded',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=true;});
   await assert.rejects(()=>f.store.transaction(s=>{
    s.b6BudgetAttempts=[{
     requestKey:key(1),attemptId:'NOT_UUID',day:'2026-10-22',
     reservedTokens:100,reservedAt:NOW,leaseUntil:NOW+10,status:'RESERVED'
    }];
   }),/Unsupported state schema/);
   assert.deepEqual((await f.store.snapshot()).b6BudgetAttempts??[],[]);
  }finally{await f.close();}
 });
}
test('B6 independent SQLite budget ledger reopens without source code changes or plaintext user prompts',async()=>{
 const f=await fixture('sqlite');try{
  await f.budget().reserve(key(1),123);
  const state=await f.store.snapshot();
  const raw=JSON.stringify(state.b6BudgetAttempts);
  assert.doesNotMatch(raw,/actor|prompt|question|answer|tokenSecret|apiKey|userId/);
  assert.equal(state.schemaVersion,8);
  assert.equal((await new BotStore(f.file,{engine:'sqlite'}).snapshot()).b6BudgetAttempts?.length,1);
 }finally{await f.close();}
});
