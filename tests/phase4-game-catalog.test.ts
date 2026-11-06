import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4GameCatalogService,gameCatalogAllowsQuiz} from '../src/phase4-game-catalog.js';
import {validGameCatalogState} from '../src/phase4-game-catalog-model.js';
import {gameCatalogOwnerScreen,validGameCatalogOwnerRoute} from '../src/phase4-game-catalog-owner.js';
import {ownerInlineConnection,isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {Phase4QuizService} from '../src/phase4-quizzes.js';
import type {QuizInput} from '../src/phase4-quiz-model.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',MEMBER='200',OTHER='201',GROUP='-1001234',GROUP2='-1005678';
const START=1_700_000_000_000;
const question:QuizInput={category:'SCHOLARSHIPS',durationMinutes:90,title:'تمرين تعلم المنح',
 question:'أي وثيقة تشرح خطة البحث بوضوح للجامعة؟',
 options:['تذكرة الطيران','مقترح البحث','بطاقة البنك','بطاقة مكتبة'],
 correctIndex:1,explanation:'يوضح المقترح المشكلة البحثية والمنهج وخطة التنفيذ.',
 sourceUrl:'https://www.example.edu/graduate/admissions'};
async function fixture(engine:'json'|'sqlite'){
 const folder=await mkdtemp(join(tmpdir(),'phase4-game-catalog-'));
 let now=START,membership:'VERIFIED'|'UNKNOWN'|'NOT_MEMBER'='VERIFIED';
 const store=new BotStore(join(folder,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,GROUP2,['navigation']);
 const catalog=new Phase4GameCatalogService(store,policy,()=>now);
 const quiz=new Phase4QuizService(store,policy,()=>now,async()=>membership);
 const edu=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,edu);
 const faq=new ApprovedAnswerService(store,policy);
 const links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education:edu,
  admin,faq,links,botId:'bot-main',botUsername:'ManaratakBot',clock:()=>now,
  ownerMenuMode:'inline',membership:async()=>membership});
 const cb=(i:number,actor:string,data:string)=>({
  update_id:i,callback_query:{id:'cat'+i,data,
   from:{id:Number(actor),is_bot:false},
   message:{message_id:20,chat:{id:Number(actor),type:'private'},
    from:{id:901,is_bot:true}}}
 });
 return {folder,store,policy,catalog,quiz,app,cb,
  setTime:(x:number)=>{now=x;},now:()=>now,advance:(x:number)=>{now+=x;},
  setMembership:(x:typeof membership)=>{membership=x;},
  close:()=>rm(folder,{recursive:true,force:true})};
}

test('GAME-001 strict catalog schema and callbacks never register unimplemented game modes',()=>{
 assert.equal(validGameCatalogState({groups:[]}),true);
 assert.equal(ownerInlineConnection('mi:1:i:08:01'),'EDITOR');
 assert.equal(validGameCatalogOwnerRoute('gc:1:h'),true);
 assert.equal(validGameCatalogOwnerRoute('gc:1:g:'+GROUP),true);
 assert.equal(validGameCatalogOwnerRoute('gc:1:c:'+GROUP+':1:off'),true);
 assert.equal(validGameCatalogOwnerRoute('gc:1:c:'+GROUP+':1:ban'),false);
 assert.equal(isValidTelegramInlineKeyboard({inline_keyboard:[[
  {text:'وقف الألعاب',callback_data:'gc:1:p:'+GROUP+':0:off'}]]}),true);
 for(const bad of [null,{},[],{groups:[],extra:true},{groups:[{chatId:GROUP}]},
  {groups:[{chatId:GROUP,chatVersion:1,revision:1,quizEnabled:true,
   dailyLimit:5,quietStartUtcMinute:0,quietEndUtcMinute:0,updatedAt:START}]}])
  assert.equal(validGameCatalogState(bad),false);
});

for(const engine of ['json','sqlite'] as const){
 test('GAME-001 '+engine+': owner CAS config per approved group and persistence across restart',async()=>{
  const f=await fixture(engine);try{
   const initial=await f.catalog.view(OWNER,GROUP);
   assert.equal(initial?.quizEnabled,true); // existing owner-approved 08:03 stays compatible
   assert.equal(initial?.revision,0);
   assert.equal(await f.catalog.view(MEMBER,GROUP),null);
   assert.equal(await f.catalog.update(MEMBER,GROUP,0,{quizEnabled:false,dailyLimit:2}),false);
   assert.equal(await f.catalog.update(OWNER,GROUP,0,{quizEnabled:false,dailyLimit:2}),true);
   assert.equal(await f.catalog.update(OWNER,GROUP,0,{quizEnabled:true,dailyLimit:2}),false);
   assert.equal((await f.catalog.view(OWNER,GROUP))?.revision,1);
   assert.equal((await f.catalog.view(OWNER,GROUP2))?.quizEnabled,true);
   const raw=(await new BotStore(f.store.file,{engine}).snapshot()).phase4GameCatalog;
   assert.equal(validGameCatalogState(raw),true);
   assert.equal(raw?.groups[0]?.quizEnabled,false);
   assert.equal(await f.catalog.update(OWNER,GROUP,1,{quizEnabled:true,dailyLimit:3}),true);
   const a=await f.catalog.view(OWNER,GROUP);
   assert.equal(a?.revision,2);assert.equal(a?.dailyLimit,3);
  }finally{await f.close();}
 });
 test('GAME-001 '+engine+': disabled quizzes reject open, lookup and answers atomically',async()=>{
  const f=await fixture(engine);try{
   const q=await f.quiz.draft(OWNER,GROUP,question);
   assert.equal(await f.catalog.update(OWNER,GROUP,0,{quizEnabled:false,dailyLimit:5}),true);
   assert.equal(await f.quiz.open(OWNER,q.id,1),false);
   assert.equal(await f.catalog.update(OWNER,GROUP,1,{quizEnabled:true,dailyLimit:5}),true);
   assert.equal(await f.quiz.open(OWNER,q.id,1),true);
   assert.equal((await f.quiz.info(MEMBER,q.id))?.question,question.question);
   assert.equal(await f.catalog.update(OWNER,GROUP,2,{quizEnabled:false,dailyLimit:5}),true);
   assert.equal(await f.quiz.info(MEMBER,q.id),null);
   assert.equal((await f.quiz.answer(MEMBER,q.id,1)).status,'STALE');
   assert.equal((await f.store.snapshot()).phase4Quizzes?.answers.length??0,0);
  }finally{await f.close();}
 });
 test('GAME-001 '+engine+': concurrency and policy revision stop stale mid-flight membership checks',async()=>{
  const f=await fixture(engine);try{
   const q=await f.quiz.draft(OWNER,GROUP,question);await f.quiz.open(OWNER,q.id,1);
   let ready!:()=>void,release!:()=>void;
   const entered=new Promise<void>(resolve=>{ready=resolve;});
   const waiting=new Promise<void>(resolve=>{release=resolve;});
   const slow=new Phase4QuizService(f.store,f.policy,f.now,async()=>{
    ready();await waiting;return 'VERIFIED';
   });
   const pending=slow.answer(MEMBER,q.id,1);
   await entered;
   assert.equal(await f.catalog.update(OWNER,GROUP,0,{quizEnabled:false,dailyLimit:5}),true);
   release();
   assert.equal((await pending).status,'STALE');
   assert.equal((await f.store.snapshot()).phase4Quizzes?.answers.length??0,0);
  }finally{await f.close();}
 });
 test('GAME-001 '+engine+': daily quiz limit and UTC quiet window are enforced without losing previous answers',async()=>{
  const f=await fixture(engine);try{
   const utcMinute=Math.floor((f.now()%86_400_000)/60_000);
   const start=(utcMinute+1439)%1440,stop=(utcMinute+1)%1440;
   assert.equal(await f.catalog.update(OWNER,GROUP,0,
    {quizEnabled:true,dailyLimit:1,quietStartUtcMinute:start,quietEndUtcMinute:stop}),true);
   const blocked=await f.quiz.draft(OWNER,GROUP,question);
   assert.equal(await f.quiz.open(OWNER,blocked.id,1),false);
   assert.equal(await f.catalog.update(OWNER,GROUP,1,{quizEnabled:true,dailyLimit:1}),true);
   assert.equal(await f.quiz.open(OWNER,blocked.id,1),true);
   const later=await f.quiz.draft(OWNER,GROUP,{...question,title:'تمرين ثان للبحث'});
   assert.equal(await f.quiz.open(OWNER,later.id,1),false);
   assert.equal(gameCatalogAllowsQuiz(await f.store.snapshot(),GROUP,f.now(),'ANSWER'),true);
   f.advance(86_400_000); // policy same; day cap resets, but first session still open
   assert.equal(await f.quiz.open(OWNER,later.id,1),true);
  }finally{await f.close();}
 });
 test('GAME-001 '+engine+': owner review, versioned confirmation, and students forbidden from catalog callback',async()=>{
  const f=await fixture(engine);try{
   const home=await gameCatalogOwnerScreen(f.catalog,OWNER,'gc:1:h');
   assert.ok(home?.text.includes('الأسئلة'));
   assert.equal(home!==null&&isValidTelegramInlineKeyboard(home.keyboard),true);
   const owner=await f.app().handle(f.cb(100,OWNER,'mi:1:i:08:01'));
   assert.equal(owner.status,'APPLIED');
   const intruder=await f.app().handle(f.cb(101,MEMBER,'mi:1:i:08:01'));
   assert.equal(intruder.status,'DENIED');
   const before=await gameCatalogOwnerScreen(f.catalog,OWNER,'gc:1:g:'+GROUP);
   assert.equal(before!==null&&isValidTelegramInlineKeyboard(before.keyboard),true);
   const preview=await gameCatalogOwnerScreen(f.catalog,OWNER,'gc:1:p:'+GROUP+':0:off');
   assert.match(preview?.text??'',/تأكيد/);
   assert.equal((await f.catalog.view(OWNER,GROUP))?.quizEnabled,true);
   const confirm=await gameCatalogOwnerScreen(f.catalog,OWNER,'gc:1:c:'+GROUP+':0:off');
   assert.equal(confirm!==null,true);
   assert.equal((await f.catalog.view(OWNER,GROUP))?.quizEnabled,false);
   assert.equal(await gameCatalogOwnerScreen(f.catalog,OWNER,'gc:1:c:'+GROUP+':0:off'),null);
  }finally{await f.close();}
 });
}
