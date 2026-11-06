import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {Phase4ExpertService} from '../src/phase4-experts.js';
import {startPhase4ExpertPrivacyMaintenance} from '../src/phase4-expert-maintenance.js';

const OWNER='100',GROUP='-1001234',MEMBER='200',START=1_700_000_000_000;
const profile={displayName:'مستشار زائر',specialty:'شؤون المنح الدولية',
 evidenceUrl:'https://university.example.edu/staff/advisor'};
for(const engine of ['json','sqlite'] as const){
 test('AMA-007 '+engine+': delayed verification must not reveal approved summary after a new subscription requirement',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ama-subscription-race-'));try{
   let now=START;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   const questions=new Phase4DiscussionService(store,policy,()=>now,async()=> 'VERIFIED');
   const svc=new Phase4ExpertService(store,policy,()=>now,async()=> 'VERIFIED');
   const p=await svc.draftProfile(OWNER,GROUP,profile);await svc.reviewProfile(OWNER,p.id,1);
   const q=await questions.draft(OWNER,GROUP,{title:'أسئلة المتحدث الزائر',
    durationMinutes:60,maxQuestions:10});
   await questions.open(OWNER,q.id,1);
   const ama=await svc.draftSession(OWNER,p.id,q.id);
   await svc.openSession(OWNER,ama.id,1);
   await svc.closeSession(OWNER,ama.id,2);
   await svc.draftSummary(OWNER,ama.id,'ملخص تعليمي لمصادر وشروط التقديم الدولي.',
    ['https://university.example.edu/scholarships']);
   await svc.approveSummary(OWNER,ama.id,1);
   let started!:()=>void,release!:()=>void;
   const entered=new Promise<void>(r=>{started=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const delayed=new Phase4ExpertService(store,policy,()=>now,async()=>{
    started();await gate;return 'VERIFIED';});
   const pending=delayed.memberSummary(MEMBER,ama.id);
   await entered;
   await store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:['-1004567'],mode:'ALL',version:1});});
   release();
   assert.equal(await pending,null);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('AMA-008 '+engine+': autonomous cleanup closes original question inbox and erases text after expiry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ama-expiry-'));try{
   let now=START;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const questions=new Phase4DiscussionService(store,policy,()=>now,async()=> 'VERIFIED');
   const svc=new Phase4ExpertService(store,policy,()=>now,async()=> 'VERIFIED');
   const p=await svc.draftProfile(OWNER,GROUP,profile);await svc.reviewProfile(OWNER,p.id,1);
   const q=await questions.draft(OWNER,GROUP,{title:'أسئلة الطالبة قبل اللقاء',
    durationMinutes:15,maxQuestions:10});
   await questions.open(OWNER,q.id,1);
   const ama=await svc.draftSession(OWNER,p.id,q.id);
   await svc.openSession(OWNER,ama.id,1);
   assert.equal((await questions.ask(MEMBER,q.id,'سؤالي الشخصي عن قبول الدراسة')).status,'RECEIVED');
   now+=900_001;
   let stopCount=0,trigger!:()=>void;
   const cleaner=startPhase4ExpertPrivacyMaintenance(svc,tick=>{
    trigger=tick;return ()=>{stopCount++;};
   });
   await cleaner.stop();
   assert.equal(stopCount,1);
   const restored=await new BotStore(store.file,{engine}).snapshot();
   assert.equal(restored.phase4Experts?.sessions[0]?.status,'CLOSED');
   assert.equal(restored.phase4Discussions?.sessions[0]?.status,'CLOSED');
   assert.equal(restored.phase4Discussions?.questions[0]?.text,undefined);
   assert.doesNotMatch(JSON.stringify(restored.phase4Discussions),/سؤالي الشخصي/);
   now+=30*86_400_000+1;
   const cleaner2=startPhase4ExpertPrivacyMaintenance(svc,()=>()=>{});
   await cleaner2.stop();
   const pruned=(await new BotStore(store.file,{engine}).snapshot()).phase4Experts!;
   assert.deepEqual(pruned,{profiles:[],sessions:[],decisions:[],summaries:[]});
   trigger();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
test('AMA-009 cleanup coalesces overlapping sweeps and drains the current task before shutdown',async()=>{
 let count=0,finished=0,stops=0;
 let tick!:()=>void,release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const cleaner=startPhase4ExpertPrivacyMaintenance({
  expire:async()=>{count++;await gate;finished++;return 1;}
 } as Phase4ExpertService,t=>{tick=t;return ()=>{stops++;};});
 tick();tick();assert.equal(count,1);
 release();await cleaner.stop();
 assert.equal(finished,1);assert.equal(stops,1);
 tick();assert.equal(count,1);
});
