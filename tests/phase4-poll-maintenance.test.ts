import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4PollService} from '../src/phase4-polls.js';
import {startPhase4PollPrivacyMaintenance} from '../src/phase4-poll-maintenance.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
const GROUP='-1001234',OWNER='100',MEMBER='201',NOW=1_700_000_000_000;
const INPUT={kind:'NEEDS' as const,question:'ما الخدمات الأكاديمية المطلوبة؟',
 options:['الدروس المباشرة','مراجعة الملفات'],durationMinutes:10};
for(const engine of ['json','sqlite'] as const){
 test('POLL-008 '+engine+': no channel membership proof means no ballot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'poll-channel-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   await policy.approveChat(OWNER,'-10054321',['verification']);
   const svc=new Phase4PollService(store,policy,()=>NOW,async()=> 'VERIFIED');
   const d=await svc.draft(OWNER,GROUP,INPUT);
   await svc.open(OWNER,d.id,1);
   await store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:['-10054321'],mode:'ALL',version:1});});
   const education=new EducationService(store,policy,()=>NOW);
   const admin=new EducationAdminFacade(store,policy,education);
   const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
   const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
    botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',clock:()=>NOW});
   const result=await app.handle({update_id:100,message:{message_id:100,
    chat:{id:Number(MEMBER),type:'private'},from:{id:Number(MEMBER),is_bot:false,first_name:'Student'},
    text:'/pollvote '+d.id+' 1'}});
   assert.equal(result.reason,'PHASE4_POLL_MEMBER');
   assert.match(result.plan?.text??'',/التحقق/);
   assert.equal((await store.snapshot()).phase4Polls?.ballots.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('POLL-009 '+engine+': policy reapproval during slow Telegram membership never registers a late ballot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'poll-late-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   let arrived!:()=>void,release!:()=>void;
   const entered=new Promise<void>(r=>{arrived=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const svc=new Phase4PollService(store,policy,()=>NOW,async()=>{
    arrived();await gate;return 'VERIFIED';});
   const d=await svc.draft(OWNER,GROUP,INPUT);await svc.open(OWNER,d.id,1);
   const pending=svc.vote(MEMBER,d.id,1);
   await entered;
   await policy.revokeChat(OWNER,GROUP);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   release();
   assert.equal((await pending).status,'STALE');
   assert.equal((await store.snapshot()).phase4Polls?.ballots.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('POLL-010 '+engine+': autonomous sweep removes expired poll and voters without owner interaction',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'poll-clean-'));try{
   let now=NOW;
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const svc=new Phase4PollService(store,policy,()=>now,async()=> 'VERIFIED');
   const d=await svc.draft(OWNER,GROUP,INPUT);await svc.open(OWNER,d.id,1);
   assert.equal((await svc.vote(MEMBER,d.id,1)).status,'CAST');
   now+=600_001;
   let scheduled!:()=>void,stopped=0;
   const worker=startPhase4PollPrivacyMaintenance(svc,tick=>{scheduled=tick;return ()=>{stopped++;};});
   await worker.stop();
   assert.equal(stopped,1);
   assert.equal((await store.snapshot()).phase4Polls?.polls[0]?.status,'CLOSED');
   now+=86_400_001;
   const next=startPhase4PollPrivacyMaintenance(svc,()=>()=>{});
   await next.stop();
   const state=(await new BotStore(store.file,{engine}).snapshot()).phase4Polls;
   assert.deepEqual(state,{polls:[],ballots:[]});
   scheduled();
   assert.equal((await store.snapshot()).phase4Polls?.ballots.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
test('POLL-010 sweeper coalesces overlapping cycles and drains current operation',async()=>{
 let calls=0,finished=0,stopped=0;
 let resolve!:()=>void,trigger!:()=>void;
 const gate=new Promise<void>(r=>{resolve=r;});
 const worker=startPhase4PollPrivacyMaintenance({
  expire:async()=>{calls++;await gate;finished++;return 1;}
 } as Phase4PollService,tick=>{trigger=tick;return ()=>{stopped++;};});
 trigger();trigger();
 assert.equal(calls,1);
 resolve();await worker.stop();
 assert.equal(finished,1);assert.equal(stopped,1);
 trigger();assert.equal(calls,1);
});
