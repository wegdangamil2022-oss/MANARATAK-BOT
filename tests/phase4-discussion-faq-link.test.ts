import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {discussionMemberScreen} from '../src/phase4-discussion-member.js';
import {discussionOwnerScreen} from '../src/phase4-discussion-owner.js';

const GROUP='-1001234',OWNER='100',MEMBER='201',NOW=1_700_000_000_000;
const FAQ='a1000000-0000-4000-8000-000000000001';
for(const engine of ['json','sqlite'] as const){
 test('DISCUSS-014 '+engine+': owner binds a current approved source-backed FAQ and member reads only their own answer in private',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase4-faq-link-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   let now=NOW;const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const service=new Phase4DiscussionService(store,policy,()=>now,async()=> 'VERIFIED');
   const session=await service.draft(OWNER,GROUP,{title:'أسئلة المنح',durationMinutes:60,maxQuestions:4});
   assert.equal(await service.open(OWNER,session.id,1),true);
   const submitted=await service.ask(MEMBER,session.id,'هل توجد منح لدراسة الهندسة؟');
   assert.equal(submitted.status,'RECEIVED');
   const id=submitted.questionId!;
   await store.transaction(s=>{
    s.educationCategories.push({id:'cat-1',scope:GROUP,parentId:null,title:'المنح',order:1,enabled:true});
    s.educationResources.push({id:'res-1',categoryId:'cat-1',scope:GROUP,title:'دليل الجامعة',
     university:'جامعة',cycle:'2027',degree:'Bachelor',seats:null,
     sourceImportId:'import-1',sourceLocator:'https://example.edu',reviewedBy:OWNER,status:'PUBLISHED'});
    s.faqEntries.push({id:FAQ,scope:GROUP,question:'هل توجد منح؟',aliases:[],
     answer:'نعم، راجع إعلان الجامعة الرسمي <موثق>',sourceResourceId:'res-1',
     createdBy:OWNER,approvedBy:OWNER,status:'APPROVED',createdAt:now});
   });
   assert.equal(await service.answerFromFAQ(MEMBER,id,1,FAQ),false);
   assert.equal(await service.answerFromFAQ(OWNER,id,1,FAQ),false); // must first review
   assert.equal(await service.moderate(OWNER,id,'APPROVED',1),true);
   assert.equal(await service.answerFromFAQ(OWNER,id,2,FAQ),true);
   assert.equal(await service.answerFromFAQ(OWNER,id,2,FAQ),false);
   assert.equal((await service.myApprovedAnswer('202',id)),null);
   assert.deepEqual(await service.myApprovedAnswer(MEMBER,id),
    {answer:'نعم، راجع إعلان الجامعة الرسمي <موثق>',sourceId:'res-1'});
   const screen=await discussionMemberScreen(service,MEMBER,'/discussanswer '+id);
   assert.match(screen?.text??'',/&lt;موثق&gt;/);
   assert.doesNotMatch(screen?.text??'',/<موثق>/);
   assert.equal((await store.snapshot()).telegramReplyJobs?.length??0,0);
   await store.transaction(s=>{s.faqEntries[0]!.status='ARCHIVED';});
   assert.equal(await service.myApprovedAnswer(MEMBER,id),null);
   assert.doesNotMatch((await discussionMemberScreen(service,MEMBER,'/discussanswer '+id))?.text??'',/راجع إعلان/);
   // Historical reference cannot resurrect a withdrawn or archived FAQ.
   const st=await new BotStore(store.file,{engine}).snapshot();
   assert.equal(st.phase4Discussions?.questions[0]?.faqId,FAQ);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('DISCUSS-015 '+engine+': FAQ binding rejects cross-group, draft or unpublished sources, and expired sessions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase4-faq-gates-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const service=new Phase4DiscussionService(store,policy,()=>now,async()=> 'VERIFIED');
   const session=await service.draft(OWNER,GROUP,{title:'أسئلة الجامعات',durationMinutes:15,maxQuestions:5});
   await service.open(OWNER,session.id,1);
   const q=(await service.ask(MEMBER,session.id,'ما هو موعد امتحان القبول؟')).questionId!;
   await service.moderate(OWNER,q,'APPROVED',1);
   await store.transaction(s=>{s.faqEntries.push({id:FAQ,scope:'private',
    question:'ما الموعد؟',aliases:[],answer:'لا تتوفر معلومات مؤكدة',sourceResourceId:'bad',
    createdBy:OWNER,approvedBy:OWNER,status:'APPROVED',createdAt:now});});
   assert.equal(await service.answerFromFAQ(OWNER,q,2,FAQ),false);
   await policy.revokeChat(OWNER,GROUP);
   assert.equal(await service.answerFromFAQ(OWNER,q,2,FAQ),false);
   now+=900_001;
   assert.equal(await service.myApprovedAnswer(MEMBER,q),null);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
