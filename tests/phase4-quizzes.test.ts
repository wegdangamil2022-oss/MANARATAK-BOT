import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4QuizService} from '../src/phase4-quizzes.js';
import {validQuizState} from '../src/phase4-quiz-model.js';
import {parseQuizOwnerCommand,quizOwnerScreen} from '../src/phase4-quiz-owner.js';
import {parseQuizMemberCommand,quizMemberScreen} from '../src/phase4-quiz-member.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-1001234',USER='200',OTHER='201';
const NOW=1_700_000_000_000;
const input={category:'SCHOLARSHIPS' as const,durationMinutes:60,
 title:'اختبار منح الدراسات العليا',question:'ما الوثيقة الأكثر ارتباطًا بخطة البحث؟',
 options:['جواز السفر','مقترح البحث','بطاقة المكتبة','شهادة الميلاد'],
 correctIndex:1,explanation:'مقترح البحث يوضح المشكلة والمنهج والجدول الزمني.',
 sourceUrl:'https://www.example.edu/admissions/research'};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-quiz-'));let now=NOW;
 let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 const svc=new Phase4QuizService(store,policy,()=>now,async()=>membership);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy);
 const links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',clock:()=>now,
  ownerMenuMode:'inline',membership:async()=>membership});
 const msg=(n:number,actor:string,text:string,forward=false)=>({
  update_id:n,message:{message_id:n,chat:{id:Number(actor),type:'private'},
   from:{id:Number(actor),is_bot:false,first_name:'Student'},text,
   ...(forward?{forward_origin:{type:'user',date:1700000000,sender_user:{id:901,is_bot:false}}}:{})}
 });
 const cb=(n:number,actor:string,data:string)=>({
  update_id:n,callback_query:{id:'q'+n,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:20,chat:{id:Number(actor),type:'private'},from:{id:901,is_bot:true}}}
 });
 return {store,policy,svc,app,msg,cb,setMember:(x:typeof membership)=>{membership=x;},
  clock:()=>now,advance:(n:number)=>{now+=n;},close:()=>rm(dir,{force:true,recursive:true})};
}
test('GAME-002 strict schema and command parsing reject malformed answers and forged callbacks',()=>{
 assert.equal(validQuizState({quizzes:[],answers:[]}),true);
 for(const bad of [null,{},[],{quizzes:[],answers:[],extra:true},
  {quizzes:[{id:'fake'}],answers:[]},{quizzes:[],answers:[{id:'fake'}]}])
  assert.equal(validQuizState(bad),false);
 assert.deepEqual(parseQuizMemberCommand('/quizanswer '+ 'a'.repeat(24)+' 2'),
  {kind:'ANSWER',quizId:'a'.repeat(24),choice:1});
 assert.equal(parseQuizMemberCommand('/quizanswer '+'a'.repeat(24)+' 2\n/ban'),null);
 assert.equal(parseQuizOwnerCommand('/quiznew '+GROUP+' SCHOLARSHIPS 60 https://x.org | سؤال طويل | خيار 1 | خيار 2 | خيار 3 | خيار 4 | 2 | شرح طويل'),null);
});
for(const engine of ['json','sqlite'] as const){
 test('GAME-002 '+engine+': owner-reviewed quiz, answer hidden, unique atomic grading and privacy floor',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.svc.draft(USER,GROUP,input),/QUIZ_DENIED/);
   const q=await f.svc.draft(OWNER,GROUP,input);
   assert.equal(q.status,'DRAFT');
   assert.equal((await f.svc.info(USER,q.id)),null);
   assert.equal(await f.svc.open(OWNER,q.id,1),true);
   assert.equal(await f.svc.open(OWNER,q.id,1),false);
   const info=await f.svc.info(USER,q.id);
   assert.equal(info?.question,input.question);
   assert.equal(JSON.stringify(info).includes('correctIndex'),false);
   assert.equal(JSON.stringify(info).includes('explanation'),false);
   const answers=await Promise.all(Array.from({length:20},()=>f.svc.answer(USER,q.id,1)));
   assert.equal(answers.filter(x=>x.status==='RECORDED').length,1);
   assert.equal(answers.filter(x=>x.status==='ALREADY_ANSWERED').length,19);
   assert.equal((await f.svc.results(OWNER,q.id)),null);
   assert.equal(await f.svc.close(OWNER,q.id,2),true);
   assert.equal(await f.svc.close(OWNER,q.id,2),false);
   assert.deepEqual((await f.svc.info(USER,q.id))?.answer,{correctIndex:1,explanation:input.explanation});
   assert.equal((await f.svc.answer(OTHER,q.id,0)).status,'CLOSED');
   const saved=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Quizzes;
   assert.equal(saved?.answers.length,1);
   assert.equal(saved?.answers[0]?.choice,1);
  }finally{await f.close();}
 });
 test('GAME-012 '+engine+': membership fails closed and revoked group epoch cancels pending verification',async()=>{
  const f=await fixture(engine);try{
   const q=await f.svc.draft(OWNER,GROUP,input);await f.svc.open(OWNER,q.id,1);
   f.setMember('UNKNOWN');
   assert.equal((await f.svc.answer(USER,q.id,0)).status,'VERIFICATION_REQUIRED');
   f.setMember('VERIFIED');
   const yes=await f.svc.answer(USER,q.id,0);
   assert.equal(yes.status,'RECORDED');
   assert.equal((await f.svc.answer(USER,q.id,1)).status,'ALREADY_ANSWERED');
   assert.equal((await f.svc.withdraw(USER,q.id)),true);
   assert.equal((await f.svc.answer(USER,q.id,1)).status,'ALREADY_ANSWERED');
   assert.equal((await f.svc.info(USER,q.id))?.answer,undefined);
   const rows=(await f.store.snapshot()).phase4Quizzes?.answers;
   assert.deepEqual(rows?.map(x=>x.choice),[undefined]);
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal((await f.svc.answer(OTHER,q.id,1)).status,'STALE');
   assert.equal((await f.svc.info(USER,q.id)),null);
  }finally{await f.close();}
 });
 test('GAME-011 '+engine+': expiration and retention remove identifiers and obsolete quiz evidence',async()=>{
  const f=await fixture(engine);try{
   const q=await f.svc.draft(OWNER,GROUP,input);await f.svc.open(OWNER,q.id,1);
   assert.equal((await f.svc.answer(USER,q.id,1)).status,'RECORDED');
   f.advance(61*60_000);
   assert.equal((await f.svc.answer(OTHER,q.id,0)).status,'EXPIRED');
   assert.equal(await f.svc.expire(),1);
   assert.equal((await f.svc.info(USER,q.id))?.answer?.correctIndex,1);
   f.advance(8*86_400_000);
   assert.ok(await f.svc.expire()>=1);
   const s=await f.store.snapshot();
   assert.equal(s.phase4Quizzes?.quizzes.length,0);
   assert.equal(s.phase4Quizzes?.answers.length,0);
  }finally{await f.close();}
 });
 test('GAME-002 '+engine+': private owner and student command routes never disclose correct option before closing',async()=>{
  const f=await fixture(engine);try{
   const create='/quiznew '+GROUP+' SCHOLARSHIPS 60 '+input.sourceUrl+' | '+
    input.title+' | '+input.question+' | '+input.options.join(' | ')+' | 2 | '+input.explanation;
   const owner=await quizOwnerScreen(f.svc,OWNER,create);
   assert.match(owner?.text??'',/تأكيد/);
   const q=(await f.svc.list(OWNER))[0]!;
   assert.equal((await quizMemberScreen(f.svc,USER,'/quizinfo '+q.id))?.text.includes(input.question),false);
   await f.svc.open(OWNER,q.id,1);
   const member=await quizMemberScreen(f.svc,USER,'/quizinfo '+q.id);
   assert.match(member?.text??'',/ما الوثيقة/);
   assert.doesNotMatch(member?.text??'',/مقترح البحث يوضح/);
   const update=await f.app().handle(f.msg(91,USER,'/quizanswer '+q.id+' 2'));
   assert.equal(update.status,'APPLIED');
   const malicious=await f.app().handle(f.msg(92,USER,'/quizanswer '+q.id+' 1',true));
   assert.equal(malicious.status,'DENIED');
   const intruder=await f.app().handle(f.cb(93,USER,'qz:1:o:'+q.id+':1'));
   assert.equal(intruder.status,'DENIED');
  }finally{await f.close();}
 });
}
