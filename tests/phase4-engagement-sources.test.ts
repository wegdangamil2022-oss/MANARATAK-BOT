import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4EngagementReportsService} from '../src/phase4-engagement-reports.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {Phase4PollService} from '../src/phase4-polls.js';
import {Phase4EventService} from '../src/phase4-events.js';
import {Phase4StudyPeersService} from '../src/phase4-study-peers.js';
import {Phase4BadgesService} from '../src/phase4-badges.js';

const OWNER='100',GROUP='-1001234',MEMBER='200',NOW=1_700_000_000_000;
for(const engine of ['json','sqlite'] as const){
 test('REPORT-009 '+engine+': count 09:07, 09:08, 09:09, 09:11 and 09:12 from real approved records, not inferred Telegram activity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'p4-report-sources-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const verifier=async()=> 'VERIFIED' as const;
   const discussions=new Phase4DiscussionService(store,policy,()=>NOW,verifier);
   const polls=new Phase4PollService(store,policy,()=>NOW,verifier);
   const events=new Phase4EventService(store,policy,()=>NOW,verifier);
   const peers=new Phase4StudyPeersService(store,policy,()=>NOW,verifier);
   const badges=new Phase4BadgesService(store,policy,()=>NOW,verifier);
   const reports=new Phase4EngagementReportsService(store,policy,()=>NOW);
   const discussion=await discussions.draft(OWNER,GROUP,{
    title:'أسئلة المنح والجامعات',durationMinutes:60,maxQuestions:20});
   assert.equal(await discussions.open(OWNER,discussion.id,1),true);
   assert.equal((await discussions.ask(MEMBER,discussion.id,
    'ما أفضل طريقة لتنظيم خطوات التقديم؟')).status,'RECEIVED');
   // Closing automatically archives text; this is NOT owner moderation.
   assert.equal(await discussions.close(OWNER,discussion.id,2),true);
   const poll=await polls.draft(OWNER,GROUP,{
    kind:'NEEDS',question:'ما المجال الذي يحتاج دعمًا تعليميًا أكبر؟',
    options:['التقديم للطب البشري','التحضير للاختبارات'],durationMinutes:60});
   assert.equal(await polls.open(OWNER,poll.id,1),true);
   assert.equal((await polls.vote(MEMBER,poll.id,0)).status,'CAST');
   const event=await events.draft(OWNER,GROUP,{
    title:'لقاء شرح التقديم للمنح',startsAt:NOW+86_400_000,
    durationMinutes:60,capacity:8,link:'https://university.edu/study'});
   assert.equal(await events.open(OWNER,event.id,1),true);
   assert.equal((await events.register(MEMBER,event.id,false)).status,'REGISTERED');
   const circle=await peers.draft(OWNER,GROUP,{
    topic:'مهارات كتابة خطاب الدافع',level:'BEGINNER',
    startsAt:NOW+86_400_000,durationMinutes:60,capacity:8});
   assert.equal(await peers.open(OWNER,circle.id,1),true);
   assert.equal((await peers.join(MEMBER,circle.id)).status,'JOINED');
   assert.equal((await badges.consent(MEMBER,GROUP,true)).status,'ENABLED');
   const badge=await badges.draft(OWNER,GROUP,MEMBER,'RESOURCE_GUIDE');
   assert.equal(await badges.approve(OWNER,badge.id,1),true);
   const result=await reports.report(OWNER,GROUP,'DAY');
   assert.ok(result);
   const value=(name:string)=>result.metrics.find(x=>x.key===name)?.count;
   for(const name of [
    'discussionQuestions','pollsOpened','pollBallotsActive',
    'eventsOpened','eventRegistrationsActive','studyCirclesOpened',
    'studyMembersActive','badgesAwarded'])
    assert.equal(value(name),1,name);
   assert.equal(value('postLikesActive'),0);
   assert.equal(result.metrics.some(x=>x.key==='messageViews'),false);
   assert.equal(JSON.stringify(result).includes('"memberId"'),false);
   assert.equal(JSON.stringify(result).includes('أفضل طريقة لتنظيم'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
