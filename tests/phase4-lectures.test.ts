import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4LectureService,lectureBlocksAutomation} from '../src/phase4-lectures.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {validLectureState} from '../src/phase4-lecture-model.js';
import {lectureOwnerScreen} from '../src/phase4-lecture-owner.js';
import {startPhase4LectureMaintenance} from '../src/phase4-lecture-maintenance.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
const OWNER='100',GROUP='-1001234',OTHER='-1005678',USER='200',NOW=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-lecture-'));let now=NOW;
 const store=new BotStore(join(dir,'s.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 const lectures=new Phase4LectureService(store,policy,()=>now);
 const community=new Phase4CommunityService(store,policy,()=>now);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=> 'VERIFIED',ownerMenuMode:'inline',community});
 const callback=(n:number,actor:string,data:string)=>({
  update_id:n,callback_query:{id:'cb'+n,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:10,chat:{id:Number(actor),type:'private'},from:{id:900,is_bot:true}}}
 });
 return {dir,store,policy,lectures,community,app,callback,
  now:()=>now,advance:(delta:number)=>{now+=delta;},close:()=>rm(dir,{force:true,recursive:true})};
}
test('LECTURE-001: reject malformed persisted mode, time windows and cross-group owner refs',()=>{
 assert.equal(validLectureState({sessions:[]}),true);
 for(const x of [null,{},[],{sessions:[{id:'x'}]},
  {sessions:[],unexpected:true}])assert.equal(validLectureState(x),false);
});
for(const engine of ['json','sqlite'] as const){
 test('LECTURE-001 '+engine+': owner previews, starts one temporary session and does not mutate protection or community policies',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   await assert.rejects(f.lectures.draft(USER,GROUP,60),/LECTURE_DENIED/);
   await assert.rejects(f.lectures.draft(OWNER,GROUP,8),/LECTURE_INVALID/);
   const mode=await f.lectures.draft(OWNER,GROUP,60);
   assert.equal(mode.status,'DRAFT');
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),GROUP,f.now()),false);
   assert.equal(await f.lectures.start(USER,mode.id,1),false);
   assert.equal(await f.lectures.start(OWNER,mode.id,1),true);
   assert.equal(await f.lectures.start(OWNER,mode.id,1),false);
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),GROUP,f.now()),true);
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),OTHER,f.now()),false);
   const after=await f.store.snapshot();
   assert.deepEqual(after.phase4Community,before.phase4Community);
   assert.deepEqual(after.groupProtection,before.groupProtection);
   assert.equal((after.telegramReplyJobs??[]).length,0);
  }finally{await f.close();}
 });
 test('LECTURE-002 '+engine+': preexisting user-reviewed reply is suppressed during lecture and automatically restored after deadline',async()=>{
  const f=await fixture(engine);try{
   const reply=await f.community.pending(OWNER,{kind:'REPLIES_ON'},GROUP);
   await f.community.approve(OWNER,reply.id);
   const response=await f.community.pending(OWNER,{kind:'REPLY_ADD',
    trigger:'مصادر',match:'WORD',text:'راجع المصادر الرسمية للجامعة'},GROUP);
   await f.community.approve(OWNER,response.id);
   const ev=(i:number)=>({kind:'TEXT' as const,chatId:GROUP,actorId:USER,
    memberName:'طالب',groupName:'مجموعة منارتك',messageText:'مصادر'});
   const first=await f.community.propose(ev(1),'b3-webhook:bot-main:101');
   assert.ok(first);
   const mode=await f.lectures.draft(OWNER,GROUP,30);
   await f.lectures.start(OWNER,mode.id,1);
   assert.equal(await f.community.propose(ev(2),'b3-webhook:bot-main:102'),null);
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),GROUP,f.now()),true);
   f.advance(30*60_000+1);
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),GROUP,f.now()),false);
   const again=await f.community.propose(ev(3),'b3-webhook:bot-main:103');
   assert.ok(again);
   const stored=(await new BotStore(f.store.file,{engine}).snapshot());
   assert.equal(stored.phase4Community?.configs[0]?.repliesEnabled,true);
  }finally{await f.close();}
 });
 test('LECTURE-003 '+engine+': group approval epoch invalidates old mode; stale buttons cannot stop new period',async()=>{
  const f=await fixture(engine);try{
   const one=await f.lectures.draft(OWNER,GROUP,45);
   await f.lectures.start(OWNER,one.id,1);
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),GROUP,f.now()),false);
   assert.equal(await f.lectures.stop(OWNER,one.id,2),false);
   const two=await f.lectures.draft(OWNER,GROUP,30);
   assert.equal(await f.lectures.start(OWNER,two.id,1),true);
   assert.equal(await f.lectures.stop(OWNER,one.id,2),false);
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),GROUP,f.now()),true);
   assert.equal(await f.lectures.stop(OWNER,two.id,2),true);
   assert.equal(await f.lectures.stop(OWNER,two.id,2),false);
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),GROUP,f.now()),false);
  }finally{await f.close();}
 });
 test('LECTURE-004 '+engine+': old draft confirmation and second active session fail closed under 30 concurrent clicks',async()=>{
  const f=await fixture(engine);try{
   const mode=await f.lectures.draft(OWNER,GROUP,60);
   const result=await Promise.all(Array.from({length:30},()=>f.lectures.start(OWNER,mode.id,1)));
   assert.equal(result.filter(Boolean).length,1);
   await assert.rejects(f.lectures.draft(OWNER,GROUP,45),/LECTURE_CONFLICT/);
   f.advance(60*60_000+1);
   await f.lectures.expire();
   const next=await f.lectures.draft(OWNER,GROUP,40);
   assert.equal(await f.lectures.start(OWNER,next.id,1),true);
  }finally{await f.close();}
 });
 test('LECTURE-005 '+engine+': owner inline menu routes only from private and expiration worker drains mode',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(f.callback(1,OWNER,'mi:1:i:09:14'));
   assert.equal(home.status,'APPLIED');assert.equal(home.reason,'PHASE4_LECTURE_OWNER');
   const draft=await lectureOwnerScreen(f.lectures,OWNER,'/lecturenew '+GROUP+' 25');
   assert.match(draft?.text??'',/محاضرة|المحاضرة/);
   const mode=(await f.store.snapshot()).phase4Lectures?.sessions[0]!;
   assert.equal((await f.app().handle(f.callback(2,OWNER,'lc:1:a:'+mode.id+':1'))).status,'APPLIED');
   f.advance(25*60_000+1);
   const worker=startPhase4LectureMaintenance(f.lectures,()=>()=>{});
   await worker.stop();
   assert.equal((await f.store.snapshot()).phase4Lectures?.sessions[0]?.status,'ENDED');
   assert.equal(lectureBlocksAutomation(await f.store.snapshot(),GROUP,f.now()),false);
  }finally{await f.close();}
 });
}
