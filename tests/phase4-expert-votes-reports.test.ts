import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {Phase4ExpertService} from '../src/phase4-experts.js';
import {expertMemberScreen} from '../src/phase4-expert-member.js';
import {expertOwnerScreen} from '../src/phase4-expert-owner.js';
const OWNER='100',GROUP='-1001234',USER='201',NOW=1_700_000_000_000;
for(const engine of ['json','sqlite'] as const){
 test('AMA-002 '+engine+': individual reviewed-question votes are atomic, one per member, never self-votes, anonymous ranking only',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ama-vote-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const verify=async()=> 'VERIFIED' as const;
   const questions=new Phase4DiscussionService(store,policy,()=>NOW,verify);
   const service=new Phase4ExpertService(store,policy,()=>NOW,verify);
   const profile=await service.draftProfile(OWNER,GROUP,{
    displayName:'مستشارة تعليم',specialty:'المنح الجامعية',evidenceUrl:'https://university.example.edu/speaker'});
   await service.reviewProfile(OWNER,profile.id,1);
   const q=await questions.draft(OWNER,GROUP,{title:'جلسة الأسئلة',durationMinutes:60,maxQuestions:20});
   await questions.open(OWNER,q.id,1);
   const ama=await service.draftSession(OWNER,profile.id,q.id);
   await service.openSession(OWNER,ama.id,1);
   const question=(await questions.ask(USER,q.id,'متى يبدأ التقديم للمنح؟')).questionId!;
   const second=(await questions.ask('202',q.id,'ما متطلبات القبول باللغة؟')).questionId!;
   await questions.moderate(OWNER,question,'APPROVED',1);
   await questions.moderate(OWNER,second,'APPROVED',1);
   assert.equal((await service.voteQuestion(USER,ama.id,question)).status,'SELF_VOTE');
   const concurrent=await Promise.all(Array.from({length:80},(_,i)=>
    service.voteQuestion(String(300+i%20),ama.id,question)));
   assert.equal(concurrent.filter(x=>x.status==='CAST').length,20);
   assert.equal(concurrent.filter(x=>x.status==='ALREADY_VOTED').length,60);
   assert.equal((await service.voteQuestion('300',ama.id,second)).status,'CAST');
   assert.equal((await service.voteQuestion('300',ama.id,second)).status,'ALREADY_VOTED');
   const ranking=await service.ownerRanking(OWNER,ama.id);
   assert.equal(ranking?.[0]?.questionId,question);
   assert.equal(ranking?.[0]?.votes,20);
   assert.equal(ranking?.[1]?.votes,1);
   assert.equal(JSON.stringify(ranking).includes('memberId'),false);
   assert.equal(await service.ownerRanking(USER,ama.id),null);
   assert.equal(await service.withdrawVote('300',ama.id,question),true);
   assert.equal(await service.withdrawVote('300',ama.id,question),false);
   assert.equal((await service.voteQuestion('300',ama.id,question)).status,'ALREADY_VOTED');
   const ballot=(await new BotStore(store.file,{engine}).snapshot()).phase4Experts?.votes?.
    find(x=>x.memberId==='300'&&x.questionId===question);
   assert.equal(ballot?.status,'WITHDRAWN');
   assert.equal((await service.ownerRanking(OWNER,ama.id))?.[0]?.votes,19);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('AMA-006 '+engine+': member reports are reason-only, duplicate-safe, with no public complainant disclosure',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ama-report-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const verify=async()=> 'VERIFIED' as const;
   const questions=new Phase4DiscussionService(store,policy,()=>NOW,verify);
   const service=new Phase4ExpertService(store,policy,()=>NOW,verify);
   const profile=await service.draftProfile(OWNER,GROUP,{
    displayName:'أستاذ زائر',specialty:'التوجيه الأكاديمي',evidenceUrl:'https://university.example.edu/speaker'});
   await service.reviewProfile(OWNER,profile.id,1);
   const q=await questions.draft(OWNER,GROUP,{title:'أسئلة الملتقى',durationMinutes:60,maxQuestions:10});
   await questions.open(OWNER,q.id,1);
   const ama=await service.draftSession(OWNER,profile.id,q.id);
   await service.openSession(OWNER,ama.id,1);
   const question=(await questions.ask(USER,q.id,'هل توجد استشارات طبية؟')).questionId!;
   assert.equal((await service.reportQuestion('202',ama.id,question,'UNLICENSED_ADVICE')).status,'NOT_APPROVED');
   await questions.moderate(OWNER,question,'APPROVED',1);
   const reports=await Promise.all(Array.from({length:12},()=>
    service.reportQuestion('202',ama.id,question,'UNLICENSED_ADVICE')));
   assert.equal(reports.filter(x=>x.status==='REPORTED').length,1);
   assert.equal(reports.filter(x=>x.status==='ALREADY_REPORTED').length,11);
   assert.equal((await service.reportQuestion('203',ama.id,question,'CONTACT_DETAILS')).status,'REPORTED');
   assert.equal((await service.reportQuestion('204',ama.id,question,'OTHER')).status,'INVALID');
   const rollup=await service.ownerReports(OWNER,ama.id);
   assert.deepEqual(rollup,[{questionId:question,count:2,
    reasons:{CONTACT_DETAILS:1,UNLICENSED_ADVICE:1,HARASSMENT:0}}]);
   assert.equal(await service.ownerReports('202',ama.id),null);
   const snapshot=await store.snapshot();
   assert.equal(snapshot.phase4Experts?.reports?.length,2);
   assert.equal(JSON.stringify(rollup).includes('reporterId'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('AMA-002 '+engine+': unverified and stale-requirement votes fail closed; student private commands',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ama-vote-race-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>{entered=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const verify=async()=>{entered();await gate;return 'VERIFIED' as const;};
   const questions=new Phase4DiscussionService(store,policy,()=>NOW,async()=> 'VERIFIED');
   const service=new Phase4ExpertService(store,policy,()=>NOW,verify);
   const profile=await service.draftProfile(OWNER,GROUP,{
    displayName:'متحدث جامعي',specialty:'التعليم الدولي',evidenceUrl:'https://university.example.edu/staff'});
   await service.reviewProfile(OWNER,profile.id,1);
   const q=await questions.draft(OWNER,GROUP,{title:'أسئلة القبول',durationMinutes:60,maxQuestions:10});
   await questions.open(OWNER,q.id,1);
   const ama=await service.draftSession(OWNER,profile.id,q.id);
   await service.openSession(OWNER,ama.id,1);
   const question=(await questions.ask(USER,q.id,'هل توجد منح ماجستير؟')).questionId!;
   await questions.moderate(OWNER,question,'APPROVED',1);
   const pending=service.voteQuestion('202',ama.id,question);
   await started;
   await store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:['-1004321'],mode:'ALL',version:1});});
   release();
   assert.equal((await pending).status,'STALE');
   assert.equal((await store.snapshot()).phase4Experts?.votes?.length??0,0);
   const unavailable=new Phase4ExpertService(store,policy,()=>NOW,async()=> 'UNKNOWN');
   assert.match((await expertMemberScreen(unavailable,'202','/amavote '+ama.id+' '+question))?.text??'',/تعذّر|لم يُسجّل/);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('AMA-010 '+engine+': session closing and expiry scrub votes and reporter identifiers after 24 hours',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ama-vote-retention-'));try{
   let now=NOW;const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const verify=async()=> 'VERIFIED' as const;
   const questions=new Phase4DiscussionService(store,policy,()=>now,verify);
   const service=new Phase4ExpertService(store,policy,()=>now,verify);
   const p=await service.draftProfile(OWNER,GROUP,{displayName:'ضيف أكاديمي',
    specialty:'الدراسات العليا',evidenceUrl:'https://university.example.edu/staff'});
   await service.reviewProfile(OWNER,p.id,1);
   const q=await questions.draft(OWNER,GROUP,{title:'أسئلة قبل اللقاء',durationMinutes:15,maxQuestions:10});
   await questions.open(OWNER,q.id,1);
   const a=await service.draftSession(OWNER,p.id,q.id);
   await service.openSession(OWNER,a.id,1);
   const question=(await questions.ask(USER,q.id,'هل يوجد سكن للطالب؟')).questionId!;
   await questions.moderate(OWNER,question,'APPROVED',1);
   await service.voteQuestion('202',a.id,question);
   await service.reportQuestion('203',a.id,question,'CONTACT_DETAILS');
   await service.closeSession(OWNER,a.id,2);
   now+=86_400_001;
   await service.expire();
   const st=(await new BotStore(store.file,{engine}).snapshot()).phase4Experts;
   assert.deepEqual(st?.votes,[]);
   assert.deepEqual(st?.reports,[]);
   assert.equal(JSON.stringify(st).includes('"202"'),false);
   assert.equal(JSON.stringify(st).includes('"203"'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
