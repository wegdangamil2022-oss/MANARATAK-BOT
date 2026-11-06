import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {validDiscussionState} from '../src/phase4-discussion-model.js';
import {parseDiscussionMemberCommand,discussionMemberScreen} from '../src/phase4-discussion-member.js';
import {discussionOwnerScreen} from '../src/phase4-discussion-owner.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-1001234',USER='200',USER2='201',START=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-discuss-'));let now=START;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 let membership:'VERIFIED'|'UNKNOWN'|'NOT_MEMBER'='VERIFIED';
 const verify=async()=>membership;
 const service=new Phase4DiscussionService(store,policy,()=>now,verify);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  membership:async()=>membership,botId:'bot-main',botUsername:'ManaratakBot',
  ownerMenuMode:'inline',clock:()=>now});
 const incoming=(id:number,chatId:string,actor:string,text:string,opts?:{callback?:string;forwarded?:boolean})=>({
  update_id:id,message:opts?.callback===undefined?{
   message_id:id,chat:{id:Number(chatId),type:chatId===GROUP?'supergroup':'private'},
   from:{id:Number(actor),is_bot:false,first_name:'Student'},text,
   ...(opts?.forwarded?{forward_origin:{type:'user',sender_user:{id:900,is_bot:false}}}:{})
  }:undefined,
  ...(opts?.callback!==undefined?{callback_query:{
   id:'callback-'+id,from:{id:Number(actor),is_bot:false,first_name:'Admin'},
   message:{message_id:10,chat:{id:Number(chatId),type:'private'}},
   data:opts.callback}}:{})
 });
 return {dir,store,policy,service,app,incoming,setMembership:(x:typeof membership)=>{membership=x;},
  clock:()=>now,advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
test('DISCUSS-001 strict state rejects forged fields, unknown statuses and duplicate identities',()=>{
 assert.equal(validDiscussionState({sessions:[],questions:[]}),true);
 for(const bad of [null,{},[],{sessions:[],questions:[],secret:'x'},
  {sessions:[],questions:[{id:'a'}]}, {sessions:[{id:'x'}],questions:[]}]){
  assert.equal(validDiscussionState(bad),false);
 }
});
test('DISCUSS-002 member parser is exact, bounded and never accepts multiline commands',()=>{
 const id='abcdef123456abcdef123456';
 assert.deepEqual(parseDiscussionMemberCommand('/discussask '+id+' كيف أجد المصادر الرسمية؟'),
  {kind:'ASK',sessionId:id,text:'كيف أجد المصادر الرسمية؟'});
 assert.deepEqual(parseDiscussionMemberCommand('/discusswithdraw '+id),
  {kind:'WITHDRAW',questionId:id});
 assert.deepEqual(parseDiscussionMemberCommand('/discussstatus '+id),
  {kind:'STATUS',questionId:id});
 for(const x of ['/discussask abc hi','/discussask '+id+' bad\n/ban 4',
  '/discusswithdraw '+id+' x','/discussstatus '+id.toUpperCase()]){
  assert.equal(parseDiscussionMemberCommand(x),null);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('DISCUSS-002 '+engine+': owner creates and opens approved group question session only after review',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.service.draft(USER,GROUP,{title:'جلسة معلومات المنح',durationMinutes:60,maxQuestions:2}),/DISCUSS_DENIED/);
   const d=await f.service.draft(OWNER,GROUP,{title:'جلسة معلومات المنح',durationMinutes:60,maxQuestions:2,topicId:14});
   assert.equal(d.status,'DRAFT');assert.equal(d.topicId,14);
   assert.equal((await f.service.ask(USER,d.id,'أين رابط الدليل الرسمي؟')).status,'CLOSED');
   assert.equal(await f.service.open(OWNER,d.id,1),true);
   assert.equal(await f.service.open(OWNER,d.id,1),false);
   assert.equal((await f.store.snapshot()).phase4Discussions?.sessions[0]?.status,'OPEN');
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('DISCUSS-003 '+engine+': rejects unverified membership and prevents bypass of pending provider',async()=>{
  const f=await fixture(engine);try{
   const s=await f.service.draft(OWNER,GROUP,{title:'جلسة معلومات المنح',durationMinutes:60,maxQuestions:2});
   await f.service.open(OWNER,s.id,1);
   f.setMembership('UNKNOWN');
   assert.equal((await f.service.ask(USER,s.id,'أين أجد مواعيد التقديم؟')).status,'VERIFICATION_REQUIRED');
   assert.equal((await f.store.snapshot()).phase4Discussions?.questions.length,0);
   f.setMembership('VERIFIED');
   assert.equal((await f.service.ask(USER,s.id,'أين أجد مواعيد التقديم؟')).status,'RECEIVED');
   assert.equal((await f.service.ask(USER,s.id,'كيف أسجل مجددًا في نفس الجلسة؟')).status,'ALREADY_SUBMITTED');
   assert.equal((await f.store.snapshot()).phase4Discussions?.questions.length,1);
  }finally{await f.close();}
 });
 test('DISCUSS-003 '+engine+': parallel submissions respect capacity atomically and do not leak questions',async()=>{
  const f=await fixture(engine);try{
   const s=await f.service.draft(OWNER,GROUP,{title:'أسئلة الطلبة الآن',durationMinutes:60,maxQuestions:2});
   await f.service.open(OWNER,s.id,1);
   const outcomes=await Promise.all(Array.from({length:30},(_,i)=>
    f.service.ask(String(300+i),s.id,'ما شروط المنحة لهذا العام؟')));
   assert.equal(outcomes.filter(x=>x.status==='RECEIVED').length,2);
   assert.equal(outcomes.filter(x=>x.status==='FULL').length,28);
   const questions=(await f.store.snapshot()).phase4Discussions?.questions??[];
   assert.equal(questions.length,2);
   assert.equal((await f.service.myQuestion(USER,questions[0]!.id)),null);
   const member=questions[0]!.memberId;
   assert.equal((await f.service.myQuestion(member,questions[0]!.id))?.status,'PENDING');
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('DISCUSS-004 '+engine+': review changes are revision fenced and visible only to authorized owner',async()=>{
  const f=await fixture(engine);try{
   const s=await f.service.draft(OWNER,GROUP,{title:'جلسة أسئلة الدراسات العليا',durationMinutes:60,maxQuestions:3});
   await f.service.open(OWNER,s.id,1);
   const a=await f.service.ask(USER,s.id,'هل يوجد اختبار قبول رسمي؟');
   assert.equal(a.status,'RECEIVED');assert.ok(a.questionId);
   assert.equal((await f.service.ownerQuestions(USER,s.id)),null);
   const questions=await f.service.ownerQuestions(OWNER,s.id);
   assert.equal(questions?.[0]?.text,'هل يوجد اختبار قبول رسمي؟');
   assert.equal(JSON.stringify(questions).includes('memberId'),false);
   assert.equal(await f.service.moderate(USER,a.questionId!,'APPROVED',1),false);
   assert.equal(await f.service.moderate(OWNER,a.questionId!,'APPROVED',1),true);
   assert.equal(await f.service.moderate(OWNER,a.questionId!,'REJECTED',1),false);
   assert.equal(await f.service.moderate(OWNER,a.questionId!,'ANSWERED',2),true);
   assert.equal((await f.service.myQuestion(USER,a.questionId!))?.status,'ANSWERED');
  }finally{await f.close();}
 });
 test('DISCUSS-005 '+engine+': private withdrawal scrubs content even after group revocation',async()=>{
  const f=await fixture(engine);try{
   const s=await f.service.draft(OWNER,GROUP,{title:'أسئلة الطلاب الجدد',durationMinutes:60,maxQuestions:5});
   await f.service.open(OWNER,s.id,1);
   const q=await f.service.ask(USER,s.id,'هل يمكنني معرفة الجامعة المناسبة؟');
   assert.equal(q.status,'RECEIVED');
   await f.policy.revokeChat(OWNER,GROUP);
   f.setMembership('UNKNOWN');
   assert.equal(await f.service.withdraw(USER,q.questionId!),true);
   const state=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Discussions!;
   assert.equal(state.questions[0]?.status,'WITHDRAWN');
   assert.equal(state.questions[0]?.text,undefined);
   assert.equal(await f.service.withdraw(USER2,q.questionId!),false);
   assert.doesNotMatch(JSON.stringify(state),/الجامعة المناسبة/);
  }finally{await f.close();}
 });
 test('DISCUSS-006 '+engine+': expiry after delayed membership cannot admit questions',async()=>{
  const f=await fixture(engine);try{
   const s=await f.service.draft(OWNER,GROUP,{title:'جلسة الدراسة في الخارج',durationMinutes:15,maxQuestions:3});
   await f.service.open(OWNER,s.id,1);
   let entered!:()=>void,release!:()=>void;
   const arrived=new Promise<void>(resolve=>{entered=resolve;});
   const gate=new Promise<void>(resolve=>{release=resolve;});
   const delayed=new Phase4DiscussionService(f.store,f.policy,f.clock,async()=>{entered();await gate;return 'VERIFIED';});
   const pending=delayed.ask(USER,s.id,'هل تتطلب المنح شهادة لغة؟');
   await arrived;f.advance(900_001);release();
   assert.equal((await pending).status,'EXPIRED');
   assert.equal((await f.store.snapshot()).phase4Discussions?.questions.length,0);
  }finally{await f.close();}
 });
 test('DISCUSS-007 '+engine+': closing and expiry scrub all question texts and prune after 24h',async()=>{
  const f=await fixture(engine);try{
   const s=await f.service.draft(OWNER,GROUP,{title:'جلسة أسئلة الماجستير',durationMinutes:15,maxQuestions:3});
   await f.service.open(OWNER,s.id,1);
   const q=await f.service.ask(USER,s.id,'هل يوجد تمويل للسكن الجامعي؟');
   assert.equal(q.status,'RECEIVED');
   f.advance(900_001);assert.equal(await f.service.expire(),1);
   const st=(await f.store.snapshot()).phase4Discussions!;
   assert.equal(st.sessions[0]?.status,'CLOSED');
   assert.equal(st.questions[0]?.status,'ARCHIVED');
   assert.doesNotMatch(JSON.stringify(st),/السكن الجامعي/);
   f.advance(86_400_001);await f.service.expire();
   assert.deepEqual((await f.store.snapshot()).phase4Discussions,{sessions:[],questions:[]});
  }finally{await f.close();}
 });
 test('DISCUSS-008 '+engine+': private Telegram member access rejects group/forwarded and no question text in receipts',async()=>{
  const f=await fixture(engine);try{
   const s=await f.service.draft(OWNER,GROUP,{title:'جلسة أسئلة المنح',durationMinutes:60,maxQuestions:3});
   await f.service.open(OWNER,s.id,1);
   const t='/discussask '+s.id+' هل تتوفر منح لدراسة الطب؟';
   const res=await f.app().handle(f.incoming(100,USER,USER,t));
   assert.equal(res.status,'APPLIED');
   assert.equal(res.reason,'PHASE4_DISCUSSION_MEMBER');
   assert.doesNotMatch(res.plan?.text??'',/دراسة الطب/);
   const group=await f.app().handle(f.incoming(101,GROUP,USER,t));
   assert.notEqual(group.reason,'PHASE4_DISCUSSION_MEMBER');
   const forged=await f.app().handle(f.incoming(102,USER,USER2,t));
   assert.equal(forged.status,'DENIED');
   const forwarded=await f.app().handle(f.incoming(103,USER,USER,t,{forwarded:true}));
   assert.equal(forwarded.status,'DENIED');
  }finally{await f.close();}
 });
 test('DISCUSS-009 '+engine+': owner inline review routes open session and moderate without sending to group',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(f.incoming(110,OWNER,OWNER,'',{callback:'mi:1:i:09:07'}));
   assert.equal(home.status,'APPLIED');assert.equal(home.reason,'PHASE4_DISCUSSION_OWNER');
   const created=await discussionOwnerScreen(f.service,OWNER,'/discussionnew '+GROUP+' 60 3 أسئلة منح الصين');
   assert.match(created?.text??'',/مسودة|الجلسة/);
   const s=(await f.store.snapshot()).phase4Discussions?.sessions[0]!;
   const opened=await f.app().handle(f.incoming(111,OWNER,OWNER,'',{callback:'dq:1:o:'+s.id+':1'}));
   assert.equal(opened.status,'APPLIED');assert.equal((await f.store.snapshot()).phase4Discussions?.sessions[0]?.status,'OPEN');
   const asked=await discussionMemberScreen(f.service,USER,'/discussask '+s.id+' هل يلزم اختبار اللغة الصينية؟');
   assert.match(asked?.text??'',/استلام|سؤال/);
   const q=(await f.store.snapshot()).phase4Discussions?.questions[0]!;
   const approved=await f.app().handle(f.incoming(112,OWNER,OWNER,'',{callback:'dq:1:a:'+q.id+':1'}));
   assert.equal(approved.status,'APPLIED');
   assert.equal((await f.store.snapshot()).phase4Discussions?.questions[0]?.status,'APPROVED');
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.some(j=>j.plan?.chatId===GROUP),false);
  }finally{await f.close();}
 });
}
