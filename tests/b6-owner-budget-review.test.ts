import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {B6DurableBudget} from '../src/b6-durable-budget.js';
import {B6OwnerBudgetReview} from '../src/b6-owner-budget-review.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const OWNER='100',STUDENT='300',NOW=1_800_000_000_000;
const KEY=(n:number)=>'opaque-request-'+String(n).padStart(3,'0');
const msg=(n:number,actor:number,text:string,group=false)=>({
 update_id:n,message:{message_id:n,from:{id:actor,is_bot:false},
 chat:{id:group?-100555:actor,type:group?'supergroup':'private'},text}
});
const buttons=(result:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 result.plan?.replyMarkup?.keyboard.flat().map(v=>v.text)??[];
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'b6-owner-budget-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'budget.sqlite':'budget.json'),{engine});
 let now=NOW;
 const clock=()=>now;
 const policy=new Policy(store,OWNER,clock);
 const education=new EducationService(store,policy,clock);
 const admin=new EducationAdminFacade(store,policy,education,clock);
 const faq=new ApprovedAnswerService(store,policy,clock);
 const links=new ResourceLinkService(store,policy,clock);
 const limits={maxDailyAttempts:40,maxDailyReservedTokens:100000,maxConcurrent:30,leaseMs:1000};
 const budget=new B6DurableBudget(store,limits,clock);
 const review=new B6OwnerBudgetReview(store,policy,clock);
 const app=()=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,membership:async()=> 'UNKNOWN',
  botId:'main',botUsername:'ManaratakBot',clock
 });
 const reserve=async(n:number,units=50)=>{
  const made=await budget.reserve(KEY(n),units);
  assert.equal(made.status,'RESERVED');
  if(made.status!=='RESERVED')throw Error('not reserved');
  return made.attemptId;
 };
 return {dir,store,policy,budget,review,app,reserve,
  advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': owner sees redacted in-flight ledger without mutation or raw request keys',async()=>{
  const f=await setup(engine);try{
   const id=await f.reserve(1),before=await f.store.snapshot();
   const report=await f.review.report(OWNER,0);
   assert.equal(report.status,'REPORT');
   if(report.status==='REPORT'){
    assert.equal(report.attemptsToday,1);
    assert.equal(report.reservedTokensToday,50);
    assert.equal(report.active,1);
    assert.equal(report.rows[0]?.attemptId,id);
    assert.equal(report.rows[0]?.status,'RESERVED');
    assert.equal(JSON.stringify(report).includes(KEY(1)),false);
   }
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B6 '+engine+': elapsed lease is listed as uncertain but report never writes or refunds',async()=>{
  const f=await setup(engine);try{
   await f.reserve(1);
   f.advance(1001);
   const before=await f.store.snapshot();
   const report=await f.review.report(OWNER,0);
   assert.equal(report.status,'REPORT');
   if(report.status==='REPORT'){
    assert.equal(report.rows[0]?.status,'EXPIRED_UNRESOLVED');
    assert.equal(report.unknown,1);
    assert.equal(report.active,0);
   }
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B6 '+engine+': owner isolates expired attempts without refund, removing request evidence, or retry',async()=>{
  const f=await setup(engine);try{
   const attemptId=await f.reserve(1);
   f.advance(1001);
   const result=await f.review.quarantineExpired(OWNER);
   assert.deepEqual(result,{status:'QUARANTINED',count:1});
   assert.equal((await f.store.snapshot()).b6BudgetAttempts?.[0]?.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.review.quarantineExpired(OWNER)).status,'QUARANTINED');
   assert.equal((await f.budget.reserve(KEY(1),50)).status,'DUPLICATE');
   assert.equal((await f.review.acknowledge(OWNER,attemptId)).status,'ACKNOWLEDGED');
   const state=await f.store.snapshot();
   assert.equal(state.b6BudgetAttempts?.[0]?.status,'UNKNOWN_OUTCOME');
   assert.equal(state.b6BudgetAttempts?.[0]?.operatorReview?.reviewedBy,OWNER);
   assert.equal((await f.review.acknowledge(OWNER,attemptId)).status,'STALE');
   assert.equal((await f.budget.inspect()).reservedTokensToday,50);
  }finally{await f.close();}
 });
 test('B6 '+engine+': concurrent review clicks produce exactly one review acknowledgement',async()=>{
  const f=await setup(engine);try{
   const id=await f.reserve(1);
   f.advance(1001);await f.review.quarantineExpired(OWNER);
   const [a,b]=await Promise.all([f.review.acknowledge(OWNER,id),f.review.acknowledge(OWNER,id)]);
   assert.deepEqual([a.status,b.status].sort(),['ACKNOWLEDGED','STALE']);
   const audit=(await f.store.snapshot()).audit.filter(x=>x.reason==='B6_UNKNOWN_OUTCOME_ACKNOWLEDGED');
   assert.equal(audit.length,1);
   assert.equal((await f.store.snapshot()).b6BudgetAttempts?.[0]?.status,'UNKNOWN_OUTCOME');
  }finally{await f.close();}
 });
 test('B6 '+engine+': nonowner, stale attempt ID and dashboard revocation deny all mutations',async()=>{
  const f=await setup(engine);try{
   const id=await f.reserve(1);
   assert.deepEqual(await f.review.report(STUDENT,0),{status:'DENIED'});
   assert.deepEqual(await f.review.quarantineExpired(STUDENT),{status:'DENIED'});
   assert.deepEqual(await f.review.acknowledge(STUDENT,id),{status:'DENIED'});
   f.advance(1001);
   assert.deepEqual(await f.review.acknowledge(OWNER,id),{status:'STALE'});
   assert.deepEqual(await f.review.acknowledge(OWNER,'not-uuid'),{status:'STALE'});
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.deepEqual(await f.review.quarantineExpired(OWNER),{status:'DENIED'});
   assert.deepEqual(await f.review.acknowledge(OWNER,id),{status:'DENIED'});
   assert.deepEqual(await f.review.report(OWNER,0),{status:'DENIED'});
   assert.equal((await f.store.snapshot()).b6BudgetAttempts?.[0]?.status,'RESERVED');
  }finally{await f.close();}
 });
 test('B6 '+engine+': paginated owner listing is deterministic, bounded, and rejects invalid pages',async()=>{
  const f=await setup(engine);try{
   for(let n=0;n<13;n++){
    const id=await f.reserve(n);
    assert.ok(id);
    assert.equal(await f.budget.finish(KEY(n),id,'UNKNOWN_OUTCOME'),'UNKNOWN_OUTCOME');
   }
   const first=await f.review.report(OWNER,0),second=await f.review.report(OWNER,1);
   assert.equal(first.status,'REPORT');assert.equal(second.status,'REPORT');
   if(first.status==='REPORT'&&second.status==='REPORT'){
    assert.equal(first.rows.length,8);assert.equal(second.rows.length,5);
    assert.equal(first.pages,2);assert.equal(second.pages,2);
    assert.equal(first.unknown,13);
    assert.equal(new Set([...first.rows,...second.rows].map(x=>x.attemptId)).size,13);
    assert.equal(JSON.stringify(first).includes(KEY(12)),false);
   }
   assert.deepEqual(await f.review.report(OWNER,2),{status:'INVALID_PAGE'});
  }finally{await f.close();}
 });
 test('B6 '+engine+': Telegram private owner sees report, explicit quarantine then two-step UNKNOWN acknowledgement',async()=>{
  const f=await setup(engine);try{
   const id=await f.reserve(1),before=await f.store.snapshot();
   const panel=await f.app().handle(msg(1,100,ownerMenuLabels.b6Budget));
   assert.equal(panel.status,'APPLIED');
   assert.match(panel.plan?.text??'',/ميزانية|الحجوزات/);
   assert.doesNotMatch(panel.plan?.text??'',/opaque-request/);
   assert.equal(isValidTelegramReplyKeyboard(panel.plan?.replyMarkup),true);
   assert.deepEqual((await f.store.snapshot()).b6BudgetAttempts,before.b6BudgetAttempts);
   f.advance(1001);
   const expired=await f.app().handle(msg(2,100,ownerMenuLabels.b6Budget));
   assert.match(expired.plan?.text??'',/مجهول|انتهت/);
   const quarantine=buttons(expired).find(x=>x==='🧯 عزل المحاولات المنتهية')!;
   assert.ok(quarantine);
   assert.equal((await f.app().handle(msg(3,100,quarantine))).status,'APPLIED');
   const current=await f.app().handle(msg(4,100,ownerMenuLabels.b6Budget));
   const reviewButton=buttons(current).find(x=>x==='⚠️ مراجعة محاولة · '+id)!;
   assert.ok(reviewButton);
   const preview=await f.app().handle(msg(5,100,reviewButton));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/لا يعيد|لا يرد|لا تُعاد/);
   const confirmation=buttons(preview).find(x=>x==='✅ إقرار المراجعة · '+id)!;
   assert.ok(confirmation);
   assert.equal((await f.app().handle(msg(6,100,confirmation))).status,'APPLIED');
   assert.equal((await f.app().handle(msg(7,100,confirmation))).status,'DENIED');
   assert.equal((await f.store.snapshot()).b6BudgetAttempts?.[0]?.status,'UNKNOWN_OUTCOME');
  }finally{await f.close();}
 });
 test('B6 '+engine+': copied buttons rejected for students and group chat, no mutation',async()=>{
  const f=await setup(engine);try{
   const id=await f.reserve(1),before=await f.store.snapshot();
   const labels=[ownerMenuLabels.b6Budget,'🧯 عزل المحاولات المنتهية',
    '⚠️ مراجعة محاولة · '+id,'✅ إقرار المراجعة · '+id,'➡️ التالي · b6b:1'];
   for(let n=0;n<labels.length;n++){
    assert.equal((await f.app().handle(msg(40+n,300,labels[n]!))).status,'DENIED');
    assert.equal((await f.app().handle(msg(50+n,100,labels[n]!,true))).status,'DENIED');
   }
   assert.deepEqual((await f.store.snapshot()).b6BudgetAttempts,before.b6BudgetAttempts);
  }finally{await f.close();}
 });
}
test('B6 saved optional operator review is strict and cannot change reservation status or delete history',async()=>{
 const f=await setup('sqlite');try{
  await f.reserve(1);f.advance(1001);
  await f.review.quarantineExpired(OWNER);
  const id=(await f.store.snapshot()).b6BudgetAttempts![0]!.attemptId;
  await f.review.acknowledge(OWNER,id);
  const after=await f.store.snapshot();
  assert.equal((await new BotStore(f.store.file,{engine:'sqlite'}).snapshot()).b6BudgetAttempts?.[0]?.operatorReview?.reviewedBy,OWNER);
  await assert.rejects(()=>f.store.transaction(s=>{
   s.b6BudgetAttempts![0]!.operatorReview={reviewedBy:'other',reviewedAt:-1};
  }),/Unsupported state schema/);
  assert.deepEqual((await f.store.snapshot()).b6BudgetAttempts,after.b6BudgetAttempts);
 }finally{await f.close();}
});
