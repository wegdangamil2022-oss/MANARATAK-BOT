import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore,type TelegramReplyJob} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {OwnerTelegramMenu,ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {groupMenuEpochDigest,privateGroupEpochDigest} from '../src/telegram-group-access.js';
import {summarizeOutboxAccessDenials} from '../src/telegram-outbox-access-summary.js';

const OWNER='100',STUDENT='300',GROUP='-100987';
const key=(n:number)=>'b3-webhook:bot-main:'+n;
const privatePlan=(text:string)=>({chatId:STUDENT,parseMode:'HTML' as const,text});
const groupPlan=(text:string)=>({chatId:GROUP,parseMode:'HTML' as const,text});

async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-access-summary-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 let sends=0,providerFailed=false;
 const dispatcher=(member:'VERIFIED'|'NOT_MEMBER'='VERIFIED')=>
  new TelegramReplyDispatcher(store,policy,{
   send:async()=>{sends++;return providerFailed?{status:'FAILED_CONFIRMED' as const}:
    {status:'CONFIRMED' as const,messageId:777};}
  },Date.now,undefined,undefined,async()=>member);
 const insert=async(rows:TelegramReplyJob[])=>store.transaction(s=>{
  s.telegramReplyJobs=rows.map(r=>structuredClone(r));
 });
 const menu=()=>new OwnerTelegramMenu(store,policy,education,admin);
 return {store,policy,dispatcher,insert,menu,close:()=>rm(dir,{recursive:true,force:true}),
  failProvider:()=>{providerFailed=true;},sent:()=>sends};
}
for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': private and group legacy provenance denials are counted without raw message values',async()=>{
  const f=await setup(engine);try{
   const secret='Private student source <very sensitive>';
   await f.insert([
    {updateKey:key(1),status:'QUEUED',plan:privatePlan(secret)},
    {updateKey:key(2),status:'QUEUED',plan:groupPlan(secret)}
   ]);
   assert.equal((await f.dispatcher().dispatch(key(1))).status,'FAILED_CONFIRMED');
   assert.equal((await f.dispatcher().dispatch(key(2))).status,'FAILED_CONFIRMED');
   const report=await summarizeOutboxAccessDenials(f.store,f.policy,OWNER);
   assert.deepEqual(report,{totalFailed:2,legacyUnverifiable:2,
    accessRecheckFailed:0,groupUnavailable:0,otherConfirmedFailures:0});
   assert.equal(f.sent(),0);
   assert.equal(JSON.stringify(report).includes(secret),false);
   assert.equal(JSON.stringify(report).includes(STUDENT),false);
   assert.equal(JSON.stringify(report).includes(key(1)),false);
   assert.deepEqual(await summarizeOutboxAccessDenials(f.store,f.policy,OWNER),report);
  }finally{await f.close();}
 });
 test('B6 '+engine+': lost group membership is summarized as unverifiable access, not a claimed precise cause',async()=>{
  const f=await setup(engine);try{
   const epoch=privateGroupEpochDigest(await f.store.snapshot(),GROUP);
   await f.insert([{updateKey:key(3),status:'QUEUED',
    plan:privatePlan('Group-only approved resource'),
    privateReplyKind:'GROUP_SCOPED',
    privateGroupAccess:{actorId:STUDENT,scope:GROUP,epoch,expiresAt:Date.now()+90_000}}]);
   assert.equal((await f.dispatcher('NOT_MEMBER').dispatch(key(3))).status,'FAILED_CONFIRMED');
   const r=await summarizeOutboxAccessDenials(f.store,f.policy,OWNER);
   assert.equal(r.accessRecheckFailed,1);
   assert.equal(r.legacyUnverifiable,0);
   assert.equal(r.totalFailed,1);
   assert.equal(f.sent(),0);
   const row=(await f.store.snapshot()).telegramReplyJobs?.[0];
   assert.equal(row?.plan,undefined);
   assert.equal(row?.privateGroupAccess,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': revoked group permission is separate from legacy and provider send failure',async()=>{
  const f=await setup(engine);try{
   const epoch=groupMenuEpochDigest(await f.store.snapshot(),GROUP);
   await f.insert([{updateKey:key(4),status:'QUEUED',plan:groupPlan('Group menu <sensitive>'),
    groupReplyKind:'GENERAL',groupMenuAccess:{actorId:STUDENT,epoch,expiresAt:Date.now()+90_000}},
    {updateKey:key(5),status:'QUEUED',plan:privatePlan('Unrelated private menu'),
     privateReplyKind:'LOCAL'}]);
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal((await f.dispatcher().dispatch(key(4))).status,'FAILED_CONFIRMED');
   f.failProvider();
   assert.equal((await f.dispatcher().dispatch(key(5))).status,'FAILED_CONFIRMED');
   const r=await summarizeOutboxAccessDenials(f.store,f.policy,OWNER);
   assert.deepEqual(r,{totalFailed:2,legacyUnverifiable:0,
    accessRecheckFailed:0,groupUnavailable:1,otherConfirmedFailures:1});
   assert.equal(f.sent(),1);
  }finally{await f.close();}
 });
 test('B6 '+engine+': owner-only dashboard displays safe counters, no student text or identifiers',async()=>{
  const f=await setup(engine);try{
   await f.insert([{updateKey:key(6),status:'QUEUED',plan:privatePlan('Secret grant 77')}]);
   await f.dispatcher().dispatch(key(6));
   const ctx={origin:'TELEGRAM_PRIVATE' as const,actorId:OWNER,chatId:OWNER,verified:true};
   const screen=await f.menu().handle(ownerMenuLabels.delivery,ctx);
   assert.ok(screen);
   assert.match(screen.text,/غير موثوق|مجهولة المصدر|المنشأ/);
   assert.match(screen.text,/1/);
   assert.doesNotMatch(screen.text,/Secret grant 77|b3-webhook|300/);
   assert.equal(await f.menu().handle(ownerMenuLabels.delivery,{...ctx,actorId:STUDENT,chatId:STUDENT}),null);
   assert.equal(await f.menu().handle(ownerMenuLabels.delivery,{...ctx,verified:false}),null);
   assert.equal(await f.menu().handle(ownerMenuLabels.delivery,{...ctx,chatId:STUDENT}),null);
  }finally{await f.close();}
 });
 test('B6 '+engine+': owner reporting refuses nonowner or a disabled owner dashboard',async()=>{
  const f=await setup(engine);try{
   await assert.rejects(summarizeOutboxAccessDenials(f.store,f.policy,STUDENT),/OWNER_ONLY/);
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   await assert.rejects(summarizeOutboxAccessDenials(f.store,f.policy,OWNER),/OWNER_DASHBOARD_DISABLED/);
   const ctx={origin:'TELEGRAM_PRIVATE' as const,actorId:OWNER,chatId:OWNER,verified:true};
   assert.equal(await f.menu().handle(ownerMenuLabels.delivery,ctx),null);
  }finally{await f.close();}
 });
 test('B6 '+engine+': denial reasons have a strict finite enum and cannot be attached to non-failed jobs',async()=>{
  const f=await setup(engine);try{
   await f.insert([{updateKey:key(7),status:'FAILED_CONFIRMED',redactedAt:10}]);
   const good=await f.store.snapshot();
   for(const code of ['',null,17,'UNKNOWN','Secret student message',{},['LEGACY_UNVERIFIABLE']]){
    await assert.rejects(f.store.transaction(s=>{
     (s.telegramReplyJobs![0] as unknown as Record<string,unknown>).accessDenialCode=code;
    }),/Unsupported state schema/);
    assert.deepEqual(await f.store.snapshot(),good);
   }
   await assert.rejects(f.store.transaction(s=>{
    s.telegramReplyJobs![0]!.status='SENT';
    s.telegramReplyJobs![0]!.accessDenialCode='LEGACY_UNVERIFIABLE';
   }),/Unsupported state schema/);
   assert.deepEqual(await f.store.snapshot(),good);
  }finally{await f.close();}
 });
}
