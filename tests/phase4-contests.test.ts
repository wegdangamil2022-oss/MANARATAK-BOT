import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4ContestService} from '../src/phase4-contests.js';
import {validContestState} from '../src/phase4-contest-model.js';
import {Phase4QuizService} from '../src/phase4-quizzes.js';
import type {QuizInput} from '../src/phase4-quiz-model.js';
import {contestOwnerScreen} from '../src/phase4-contest-owner.js';
import {contestMemberScreen,parseContestMemberCommand}
 from '../src/phase4-contest-member.js';
import {ownerInlineConnection,isValidTelegramInlineKeyboard}
 from '../src/telegram-inline-owner.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-1001234',GROUP2='-1005678',STUDENT='200';
const NOW=1_700_000_000_000;
const question:QuizInput={category:'SCHOLARSHIPS',durationMinutes:10,
 title:'الاختبار الأول للمنح',question:'ما الوثيقة التي تشرح مقترح البحث بالتفصيل؟',
 options:['تذكرة السفر','المقترح البحثي','بطاقة البنك','شهادة الميلاد'],
 correctIndex:1,explanation:'المقترح البحثي يقدم الأهداف والمنهج وخطة البحث.',
 sourceUrl:'https://www.example.edu/graduate/research'};
async function fixture(engine:'json'|'sqlite'){
 const folder=await mkdtemp(join(tmpdir(),'p4-contests-'));
 let now=NOW,member:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 const store=new BotStore(join(folder,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,GROUP2,['navigation']);
 const svc=new Phase4ContestService(store,policy,()=>now,async()=>member);
 const quiz=new Phase4QuizService(store,policy,()=>now,async()=>member);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy);
 const links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',clock:()=>now,
  ownerMenuMode:'inline',membership:async()=>member});
 const cb=(n:number,actor:string,data:string)=>({
  update_id:n,callback_query:{id:'q'+n,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:20,chat:{id:Number(actor),type:'private'},from:{id:901,is_bot:true}}}
 });
 const msg=(n:number,actor:string,text:string)=>({
  update_id:n,message:{message_id:n,chat:{id:Number(actor),type:'private'},
   from:{id:Number(actor),is_bot:false,first_name:'Student'},text}
 });
 return {folder,store,policy,svc,quiz,app,cb,msg,
  now:()=>now,advance:(delta:number)=>{now+=delta;},
  setMember:(v:typeof member)=>{member=v;},
  close:()=>rm(folder,{recursive:true,force:true})};
}
const setup=async(f:Awaited<ReturnType<typeof fixture>>)=>{
 const contest=await f.svc.draft(OWNER,GROUP,'مسابقة المنح التفاعلية',
  'جولتان تدريبيتان للتحقق من معلومات المنح الدولية');
 assert.equal(await f.svc.addRound(OWNER,contest.id,1,question),true);
 assert.equal(await f.svc.addRound(OWNER,contest.id,2,
  {...question,title:'الجولة الثانية التدريبية',question:'ما العنصر الأساسي في خطاب الدافع؟'}),true);
 assert.equal(await f.svc.openRegistration(OWNER,contest.id,3,10),true);
 return contest.id;
};
test('GAME-002 competition schema strictly rejects forged states and member commands',()=>{
 assert.equal(validContestState({contests:[],members:[]}),true);
 for(const bad of [null,{},[],{contests:[],members:[],extra:1},
  {contests:[{id:'fake'}],members:[]},{contests:[],members:[{id:'fake'}]}])
  assert.equal(validContestState(bad),false);
 assert.equal(ownerInlineConnection('mi:1:i:08:02'),'EDITOR');
 assert.deepEqual(parseContestMemberCommand('/contestjoin '+'a'.repeat(24)),
  {kind:'JOIN',id:'a'.repeat(24)});
 assert.equal(parseContestMemberCommand('/contestjoin '+'a'.repeat(24)+'\n/ban'),null);
});
for(const engine of ['json','sqlite'] as const){
 test('GAME-002 '+engine+': two owner-approved contest rounds, private signups, quiz eligibility and persistence',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.svc.draft(STUDENT,GROUP,'مسابقة المنح التفاعلية',
    'جولتان تدريبيتان للتحقق من معلومات المنح الدولية'),/CONTEST_DENIED/);
   const id=await setup(f);
   const before=await f.svc.info(STUDENT,id);
   assert.equal(before?.title,'مسابقة المنح التفاعلية');
   assert.equal(JSON.stringify(before).includes('correctIndex'),false);
   assert.equal((await f.svc.join(STUDENT,id)).status,'REGISTERED');
   assert.equal((await f.svc.join(STUDENT,id)).status,'ALREADY_REGISTERED');
   f.advance(11*60_000);
   const started=await f.svc.start(OWNER,id,4);
   assert.equal(started.status,'STARTED');
   assert.ok(started.quizId);
   assert.equal((await f.quiz.info(STUDENT,started.quizId!))?.question,question.question);
   assert.equal(await f.quiz.info('201',started.quizId!),null);
   assert.equal((await f.quiz.answer('201',started.quizId!,1)).status,'VERIFICATION_REQUIRED');
   assert.equal((await f.quiz.answer(STUDENT,started.quizId!,1)).status,'RECORDED');
   assert.equal((await f.quiz.answer(STUDENT,started.quizId!,0)).status,'ALREADY_ANSWERED');
   assert.equal((await f.svc.join('202',id)).status,'CLOSED');
   f.advance(11*60_000);
   const next=await f.svc.advance(OWNER,id,5);
   assert.equal(next.status,'NEXT');
   assert.notEqual(next.quizId,started.quizId);
   assert.equal((await f.quiz.info(STUDENT,next.quizId!))?.question,'ما العنصر الأساسي في خطاب الدافع؟');
   assert.equal((await f.quiz.info(STUDENT,started.quizId!))?.answer?.correctIndex,1);
   f.advance(11*60_000);
   assert.equal((await f.svc.advance(OWNER,id,6)).status,'FINISHED');
   assert.equal((await f.svc.advance(OWNER,id,7)).status,'DENIED');
   const saved=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Contests;
   assert.equal(saved?.contests[0]?.status,'CLOSED');
   assert.equal(saved?.contests[0]?.quizIds.length,2);
   assert.equal(saved?.members.length,1);
  }finally{await f.close();}
 });
 test('GAME-002 '+engine+': withdrawing contest signup also redacts previous round choices',async()=>{
  const f=await fixture(engine);try{
   const id=await setup(f);
   assert.equal((await f.svc.join(STUDENT,id)).status,'REGISTERED');
   f.advance(11*60_000);
   const first=await f.svc.start(OWNER,id,4);
   assert.equal(first.status,'STARTED');
   assert.equal((await f.quiz.answer(STUDENT,first.quizId!,1)).status,'RECORDED');
   assert.equal(await f.svc.withdraw(STUDENT,id),true);
   assert.equal((await f.quiz.info(STUDENT,first.quizId!)),null);
   const state=await f.store.snapshot();
   assert.equal(state.phase4Quizzes?.answers[0]?.status,'WITHDRAWN');
   assert.equal(state.phase4Quizzes?.answers[0]?.choice,undefined);
   assert.equal((await f.svc.join(STUDENT,id)).status,'CLOSED');
  }finally{await f.close();}
 });
 test('GAME-012 '+engine+': signup membership fails closed and concurrent policy revocation invalidates signup',async()=>{
  const f=await fixture(engine);try{
   const id=await setup(f);
   f.setMember('UNKNOWN');
   assert.equal((await f.svc.join(STUDENT,id)).status,'VERIFICATION_REQUIRED');
   f.setMember('VERIFIED');
   assert.equal((await f.svc.join(STUDENT,id)).status,'REGISTERED');
   assert.equal(await f.svc.withdraw(STUDENT,id),true);
   assert.equal((await f.svc.join(STUDENT,id)).status,'ALREADY_REGISTERED');
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal((await f.svc.join('201',id)).status,'STALE');
   assert.equal(await f.svc.info(STUDENT,id),null);
  }finally{await f.close();}
 });
 test('GAME-012 '+engine+': stale consent and wrong-round callbacks cannot launch or modify contest',async()=>{
  const f=await fixture(engine);try{
   const id=await setup(f);
   assert.equal((await f.svc.start(OWNER,id,3)).status,'DENIED');
   assert.equal((await f.svc.start(STUDENT,id,4)).status,'DENIED');
   const duplicate=await f.svc.draft(OWNER,GROUP,'مسابقة ثانية للدراسة',
    'وصف المسابقة الثانية للاختبارات والمراجعة');
   assert.equal(await f.svc.addRound(OWNER,duplicate.id,1,question),true);
   assert.equal(await f.svc.addRound(OWNER,duplicate.id,2,
    {...question,title:'اختبار ثانٍ بالمنح',question:'كيف يراجع الطالب شروط القبول لكل جامعة؟'}),true);
   assert.equal(await f.svc.openRegistration(OWNER,duplicate.id,3,10),false);
   const old=await contestOwnerScreen(f.svc,OWNER,'ct:1:v:'+id);
   assert.equal(old!==null&&isValidTelegramInlineKeyboard(old.keyboard),true);
   const outsider=await f.app().handle(f.cb(91,STUDENT,'ct:1:s:'+id+':4'));
   assert.equal(outsider.status,'DENIED');
   const owner=await f.app().handle(f.cb(92,OWNER,'mi:1:i:08:02'));
   assert.equal(owner.status,'APPLIED');
  }finally{await f.close();}
 });
 test('GAME-002 '+engine+': cancel closes live round, signup erased after seven days, no unattended Telegram sends',async()=>{
  const f=await fixture(engine);try{
   const id=await setup(f);
   assert.equal((await f.svc.join(STUDENT,id)).status,'REGISTERED');
   f.advance(11*60_000);
   const start=await f.svc.start(OWNER,id,4);assert.equal(start.status,'STARTED');
   assert.equal(await f.svc.cancel(OWNER,id,5),true);
   assert.equal(await f.svc.cancel(OWNER,id,6),false);
   assert.equal((await f.quiz.answer(STUDENT,start.quizId!,1)).status,'CLOSED');
   f.advance(8*86_400_000);
   assert.ok(await f.svc.expire()>0);
   const stored=await f.store.snapshot();
   assert.equal(stored.phase4Contests?.members.length,0);
   assert.equal(stored.phase4Contests?.contests.length,0);
  }finally{await f.close();}
 });
 test('GAME-002 '+engine+': cancel early registration revokes signup immediately and is idempotent',async()=>{
  const f=await fixture(engine);try{
   const id=await setup(f);
   assert.equal((await f.svc.join(STUDENT,id)).status,'REGISTERED');
   assert.equal(await f.svc.cancel(OWNER,id,3),false);
   assert.equal(await f.svc.cancel(OWNER,id,4),true);
   assert.equal(await f.svc.cancel(OWNER,id,4),false);
   assert.equal((await f.svc.join('201',id)).status,'CLOSED');
   const row=await f.svc.view(OWNER,id);
   assert.equal(row?.status,'CANCELLED');
   assert.equal(row?.startedAt,undefined);
  }finally{await f.close();}
 });
 test('GAME-012 '+engine+': signup verification race invalidated by group approval change',async()=>{
  const f=await fixture(engine);try{
   const id=await setup(f);
   let entered!:()=>void,release!:()=>void;
   const ready=new Promise<void>(r=>{entered=r;});
   const waiting=new Promise<void>(r=>{release=r;});
   const slow=new Phase4ContestService(f.store,f.policy,f.now,
    async()=>{entered();await waiting;return 'VERIFIED';});
   const join=slow.join(STUDENT,id);await ready;
   await f.policy.revokeChat(OWNER,GROUP);
   release();
   assert.equal((await join).status,'STALE');
  }finally{await f.close();}
 });
}
