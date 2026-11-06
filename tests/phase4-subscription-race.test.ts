import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4PollService} from '../src/phase4-polls.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
const OWNER='100',GROUP='-1001234',USER='201',NOW=1_700_000_000_000;
for(const engine of ['json','sqlite'] as const){
 test('PHASE4-SECURITY '+engine+': a required channel activated mid-verification blocks poll and discussion commits',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'p4-subscription-race-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   let signal!:()=>void,release!:()=>void;
   const arrived=new Promise<void>(r=>{signal=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const verify=async()=>{signal();await gate;return 'VERIFIED' as const;};
   const polls=new Phase4PollService(store,policy,()=>NOW,verify);
   const discussions=new Phase4DiscussionService(store,policy,()=>NOW,verify);
   const survey=await polls.draft(OWNER,GROUP,{kind:'NEEDS',
    question:'ما مجال الدراسة الأكثر طلبًا؟',options:['الصحة','التقنية'],durationMinutes:60});
   await polls.open(OWNER,survey.id,1);
   const session=await discussions.draft(OWNER,GROUP,{
    title:'أسئلة المستقبل الأكاديمي',durationMinutes:60,maxQuestions:10});
   await discussions.open(OWNER,session.id,1);
   const pendingPoll=polls.vote(USER,survey.id,0);
   await arrived;
   await store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:['-10054321'],mode:'ALL',version:1});});
   release();
   assert.equal((await pendingPoll).status,'STALE');
   assert.equal((await store.snapshot()).phase4Polls?.ballots.length,0);
   // Simulate another delayed membership witness in a fresh service, then
   // revise the same subscription without altering group approval revision.
   let started!:()=>void,continueCheck!:()=>void;
   const seen=new Promise<void>(r=>{started=r;});
   const secondGate=new Promise<void>(r=>{continueCheck=r;});
   const delayed=new Phase4DiscussionService(store,policy,()=>NOW,
    async()=>{started();await secondGate;return 'VERIFIED';});
   const pendingQuestion=delayed.ask(USER,session.id,'متى يبدأ التقديم للدراسات العليا؟');
   await seen;
   await store.transaction(s=>{s.subscriptionRequirements[0]!.version=2;});
   continueCheck();
   assert.equal((await pendingQuestion).status,'STALE');
   assert.equal((await store.snapshot()).phase4Discussions?.questions.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
