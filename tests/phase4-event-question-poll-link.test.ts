import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4EventService} from '../src/phase4-events.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {Phase4PollService} from '../src/phase4-polls.js';
import {validEventState} from '../src/phase4-event-model.js';
import {eventOwnerScreen} from '../src/phase4-event-owner.js';
import {eventMemberScreen} from '../src/phase4-event-member.js';

const OWNER='100',GROUP='-1001234',OTHER='-1004567',MEMBER='201',NOW=1_700_000_000_000;
for(const engine of ['json','sqlite'] as const){
 test('EVENT-003 '+engine+': owner preview then binds one pre-event discussion and one poll; member sees only active references',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'event-link-'));
  try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const eventSvc=new Phase4EventService(store,policy,()=>now,async()=> 'VERIFIED');
   const discussions=new Phase4DiscussionService(store,policy,()=>now,async()=> 'VERIFIED');
   const polls=new Phase4PollService(store,policy,()=>now,async()=> 'VERIFIED');
   const e=await eventSvc.draft(OWNER,GROUP,{title:'ندوة إرشادية للطلاب الدوليين',
    startsAt:now+10_800_000,durationMinutes:60,capacity:15,
    link:'https://university.example.edu/education'});
   await eventSvc.open(OWNER,e.id,1);
   const q=await discussions.draft(OWNER,GROUP,{title:'الأسئلة المسبقة للندوة',
    durationMinutes:90,maxQuestions:20});
   await discussions.open(OWNER,q.id,1);
   const p=await polls.draft(OWNER,GROUP,{kind:'NEEDS',
    question:'ما محور المحاضرة الأكثر أهمية؟',options:['القبول','التمويل'],durationMinutes:90});
   await polls.open(OWNER,p.id,1);
   const review=await eventOwnerScreen(eventSvc,OWNER,'/eventquestions '+e.id+' '+q.id);
   assert.match(review?.text??'',/مراجعة|تأكيد/);
   assert.ok(review?.keyboard.inline_keyboard.flat().some(x=>
    x.callback_data==='ev:1:q:'+e.id+':'+q.id+':2'));
   assert.equal(await eventSvc.bindQuestionSession(MEMBER,e.id,q.id,2),false);
   assert.equal(await eventSvc.bindQuestionSession(OWNER,e.id,q.id,1),false);
   const confirmed=await eventOwnerScreen(eventSvc,OWNER,'ev:1:q:'+e.id+':'+q.id+':2');
   assert.match(confirmed?.text??'',/أسئلة الطلاب المسبقة/);
   const reviewPoll=await eventOwnerScreen(eventSvc,OWNER,'/eventpoll '+e.id+' '+p.id);
   assert.match(reviewPoll?.text??'',/الاستطلاع|المراجعة/);
   assert.equal(await eventSvc.bindPoll(OWNER,e.id,p.id,2),true);
   assert.equal(await eventSvc.bindPoll(OWNER,e.id,p.id,2),false);
   const linked=(await new BotStore(store.file,{engine}).snapshot()).phase4Events!.events[0]!;
   assert.equal(linked.questionSessionId,q.id);assert.equal(linked.pollId,p.id);
   const user=await eventSvc.eventInfo(MEMBER,e.id);
   assert.deepEqual({questionSessionId:user?.questionSessionId,pollId:user?.pollId},
    {questionSessionId:q.id,pollId:p.id});
   const screen=await eventMemberScreen(eventSvc,MEMBER,'/eventinfo '+e.id);
   assert.match(screen?.text??'',new RegExp(q.id));
   assert.match(screen?.text??'',new RegExp(p.id));
   assert.equal((await store.snapshot()).telegramReplyJobs?.length??0,0);
   now+=5_400_001; await discussions.expire(); await polls.expire();
   const expired=await eventSvc.eventInfo(MEMBER,e.id);
   assert.equal(expired?.questionSessionId,undefined);assert.equal(expired?.pollId,undefined);
  }finally{await rm(dir,{force:true,recursive:true});}
 });
 test('EVENT-003 '+engine+': cross-group, late, forged or previously closed references fail closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'event-crossref-'));
  try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   await policy.approveChat(OWNER,OTHER,['navigation']);
   const events=new Phase4EventService(store,policy,()=>now,async()=> 'VERIFIED');
   const discussions=new Phase4DiscussionService(store,policy,()=>now,async()=> 'VERIFIED');
   const polls=new Phase4PollService(store,policy,()=>now,async()=> 'VERIFIED');
   const e=await events.draft(OWNER,GROUP,{title:'جلسة تمويل التعليم الدولي',
    startsAt:now+7_200_000,durationMinutes:30,capacity:50,
    link:'https://university.example.edu/education'});
   await events.open(OWNER,e.id,1);
   const foreign=await discussions.draft(OWNER,OTHER,{title:'مجموعة أخرى',
    durationMinutes:60,maxQuestions:10});
   await discussions.open(OWNER,foreign.id,1);
   const otherPoll=await polls.draft(OWNER,OTHER,{kind:'NEEDS',
    question:'من يرغب في اللقاء القادم؟',options:['الأولى','الثانية'],durationMinutes:60});
   await polls.open(OWNER,otherPoll.id,1);
   assert.equal(await events.bindQuestionSession(OWNER,e.id,foreign.id,2),false);
   assert.equal(await events.bindPoll(OWNER,e.id,otherPoll.id,2),false);
   const expired=await discussions.draft(OWNER,GROUP,{title:'أسئلة المدة الطويلة',
    durationMinutes:180,maxQuestions:10});
   await discussions.open(OWNER,expired.id,1);
   assert.equal(await events.bindQuestionSession(OWNER,e.id,expired.id,2),false);
   const legit=await discussions.draft(OWNER,GROUP,{title:'أسئلة في الموعد المسموح',
    durationMinutes:60,maxQuestions:10});
   await discussions.open(OWNER,legit.id,1);
   await policy.revokeChat(OWNER,GROUP);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal(await events.bindQuestionSession(OWNER,e.id,legit.id,2),false);
   const forged=(await store.snapshot()).phase4Events!;
   forged.events[0]!.questionSessionId='not-an-id';
   assert.equal(validEventState(forged),false);
  }finally{await rm(dir,{force:true,recursive:true});}
 });
}
