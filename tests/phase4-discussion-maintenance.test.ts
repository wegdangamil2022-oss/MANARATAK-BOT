import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {startPhase4DiscussionPrivacyMaintenance} from '../src/phase4-discussion-maintenance.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
const OWNER='100',GROUP='-1001234',USER='200',START=1_700_000_000_000;
for(const engine of ['json','sqlite'] as const){
 test('DISCUSS-010 '+engine+': required channels fail closed when provider verification is missing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'p4-discuss-subscription-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>START);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   await policy.approveChat(OWNER,'-1008888',['verification']);
   const service=new Phase4DiscussionService(store,policy,()=>START,async()=> 'VERIFIED');
   const session=await service.draft(OWNER,GROUP,{title:'جلسة منح الدراسات العليا',durationMinutes:60,maxQuestions:3});
   await service.open(OWNER,session.id,1);
   await store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:['-1008888'],mode:'ALL',version:1});});
   const education=new EducationService(store,policy,()=>START);
   const admin=new EducationAdminFacade(store,policy,education);
   const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
   const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
    botId:'bot-main',botUsername:'ManaratakBot',clock:()=>START,
    membership:async()=> 'VERIFIED'});
   const message={update_id:50,message:{message_id:50,
    chat:{id:Number(USER),type:'private'},from:{id:Number(USER),first_name:'Student',is_bot:false},
    text:'/discussask '+session.id+' هل تتوفر منح للماجستير؟'}};
   const result=await app.handle(message);
   assert.equal(result.status,'APPLIED');assert.equal(result.reason,'PHASE4_DISCUSSION_MEMBER');
   assert.match(result.plan?.text??'',/التحقق/);
   assert.equal((await store.snapshot()).phase4Discussions?.questions.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('DISCUSS-011 '+engine+': stale group reapproval during membership check cannot record question',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'p4-discuss-epoch-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>START);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   let entered!:()=>void,release!:()=>void;
   const arrived=new Promise<void>(resolve=>{entered=resolve;});
   const gate=new Promise<void>(resolve=>{release=resolve;});
   const service=new Phase4DiscussionService(store,policy,()=>START,async()=>{entered();await gate;return 'VERIFIED';});
   const session=await service.draft(OWNER,GROUP,{title:'جلسة المنح الدراسية',durationMinutes:60,maxQuestions:3});
   await service.open(OWNER,session.id,1);
   const request=service.ask(USER,session.id,'ما آخر موعد لهذه المنحة؟');
   await arrived;
   await policy.revokeChat(OWNER,GROUP);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   release();
   assert.equal((await request).status,'STALE');
   assert.equal((await store.snapshot()).phase4Discussions?.questions.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('DISCUSS-012 '+engine+': privacy sweeper scrubs expired student text without owner menu',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'p4-discuss-sweeper-'));try{
   let now=START;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const service=new Phase4DiscussionService(store,policy,()=>now,async()=> 'VERIFIED');
   const session=await service.draft(OWNER,GROUP,{title:'جلسة أسئلة المنح',durationMinutes:15,maxQuestions:3});
   await service.open(OWNER,session.id,1);
   assert.equal((await service.ask(USER,session.id,'MY PRIVATE QUESTION TEXT')).status,'RECEIVED');
   now+=900_001;
   let cancelCount=0;
   const cleaner=startPhase4DiscussionPrivacyMaintenance(service,tick=>{
    assert.equal(typeof tick,'function');return ()=>{cancelCount++;};
   });
   await cleaner.stop();
   assert.equal(cancelCount,1);
   const restored=(await new BotStore(store.file,{engine}).snapshot()).phase4Discussions!;
   assert.equal(restored.questions[0]?.text,undefined);
   assert.doesNotMatch(JSON.stringify(restored),/MY PRIVATE QUESTION TEXT/);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
test('DISCUSS-012 maintenance does not overlap and stop waits for the in-flight sweep',async()=>{
 let count=0,finished=0,stopCalled=0;
 let trigger!:()=>void,release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const cleaner=startPhase4DiscussionPrivacyMaintenance({
  expire:async()=>{count++;await gate;finished++;return 1;}
 } as Phase4DiscussionService,tick=>{trigger=tick;return ()=>{stopCalled++;};});
 trigger();trigger();assert.equal(count,1);
 release();await cleaner.stop();
 assert.equal(finished,1);assert.equal(stopCalled,1);
 trigger();assert.equal(count,1);
});
