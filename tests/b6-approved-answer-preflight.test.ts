import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ApprovedAnswerService} from '../src/education-interactions.js';
import {B6AnswerPreflight,LocalFAQKnowledgeSource,
 type KnowledgeSourcePort} from '../src/b6-approved-answer-preflight.js';

const OWNER='100',STUDENT='300',GROUP='-100987',OTHER='-100654';
const QUESTION='ما شروط المنحة؟';
const ANSWER='الشرط معتمد ومراجع لدى المالك فقط.';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-b6-faq-first-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER),faq=new ApprovedAnswerService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
 await policy.approveChat(OWNER,OTHER,['navigation','assistant']);
 await policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION');
 await policy.configureGroupAI(OWNER,OTHER,'ALL_MENTION');
 await policy.configurePrivateAI(OWNER,'ALL_OPT_IN');
 const privateResource=randomUUID(),groupResource=randomUUID();
 await store.transaction(s=>{
  s.privateFeatures['content.upload']=true;
  s.educationCategories.push(
   {id:'private-grants',scope:'private',parentId:null,title:'منح',order:0,enabled:true},
   {id:'group-grants',scope:GROUP,parentId:null,title:'منح المجموعة',order:0,enabled:true});
  s.educationResources.push(
   {id:privateResource,scope:'private',categoryId:'private-grants',title:'منحة خاصة',
    university:'University',cycle:'2027',degree:'Bachelor',seats:null,
    sourceImportId:randomUUID(),sourceLocator:'private',reviewedBy:OWNER,status:'PUBLISHED'},
   {id:groupResource,scope:GROUP,categoryId:'group-grants',title:'منحة مجموعة',
    university:'University',cycle:'2027',degree:'Bachelor',seats:null,
    sourceImportId:randomUUID(),sourceLocator:'group',reviewedBy:OWNER,status:'PUBLISHED'});
 });
 const privateFAQ=await faq.submit(OWNER,'private',{question:QUESTION,
  aliases:['شروط المنحة'],answer:ANSWER,sourceResourceId:privateResource});
 const groupFAQ=await faq.submit(OWNER,GROUP,{question:QUESTION,
  answer:'الرد المعتمد في المجموعة',sourceResourceId:groupResource});
 await faq.approve(OWNER,privateFAQ.id);
 await faq.approve(OWNER,groupFAQ.id);
 const localSource=new LocalFAQKnowledgeSource(store);
 const router=(source:KnowledgeSourcePort=localSource)=>
  new B6AnswerPreflight(store,policy,faq,source);
 const privateRequest={actor:STUDENT,scope:'private',question:QUESTION,optedIn:true};
 const groupRequest={actor:STUDENT,scope:GROUP,question:QUESTION,explicitMention:true};
 return {store,policy,faq,privateFAQ,groupFAQ,privateResource,groupResource,router,
  localSource,privateRequest,groupRequest,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': opted-in private request resolves only current approved local FAQ and never writes prompt logs',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   const res=await f.router().prepare(f.privateRequest);
   assert.deepEqual(res,{status:'APPROVED_ANSWER',answer:ANSWER,sourceId:f.privateResource});
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B6 '+engine+': explicit group mention uses only that group approved source, never private or another group',async()=>{
  const f=await fixture(engine);try{
   const group=await f.router().prepare(f.groupRequest);
   assert.deepEqual(group,{status:'APPROVED_ANSWER',
    answer:'الرد المعتمد في المجموعة',sourceId:f.groupResource});
   const other=await f.router().prepare({...f.groupRequest,scope:OTHER});
   assert.equal(other.status,'NO_APPROVED_SOURCE');
   assert.equal(JSON.stringify(other).includes(ANSWER),false);
  }finally{await f.close();}
 });
 test('B6 '+engine+': absent private opt-in, disabled modes, and unmentioned group prevent even querying knowledge port',async()=>{
  const f=await fixture(engine);try{
   let calls=0;
   const source:KnowledgeSourcePort={lookup:async()=>{calls++;return {status:'NO_MATCH'};}};
   const planner=f.router(source);
   assert.equal((await planner.prepare({...f.privateRequest,optedIn:false})).status,'DENIED');
   assert.equal((await planner.prepare({...f.groupRequest,explicitMention:false})).status,'DENIED');
   await f.policy.configurePrivateAI(OWNER,'OFF');
   assert.equal((await planner.prepare(f.privateRequest)).status,'DENIED');
   await f.policy.configureGroupAI(OWNER,GROUP,'OFF');
   assert.equal((await planner.prepare(f.groupRequest)).status,'DENIED');
   assert.equal(calls,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': missing answer never invokes a generative fallback or stores student question',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   const res=await f.router().prepare({...f.privateRequest,question:'سؤال جديد لا يوجد'});
   assert.deepEqual(res,{status:'NO_APPROVED_SOURCE'});
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B6 '+engine+': source adapter that returns fabricated or other-scope FAQ cannot override the trusted local review',async()=>{
  const f=await fixture(engine);try{
   const malicious:KnowledgeSourcePort={lookup:async()=>({
    status:'ANSWER',answer:'حقن مصدر خارجي غير معتمد',sourceId:f.groupResource
   })};
   const res=await f.router(malicious).prepare(f.privateRequest);
   assert.deepEqual(res,{status:'STALE'});
   assert.doesNotMatch(JSON.stringify(res),/حقن|المجموعة/);
  }finally{await f.close();}
 });
 test('B6 '+engine+': approved FAQ archived between awaited source retrieval and final check is never returned',async()=>{
  const f=await fixture(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r);
   const waiting=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async query=>{
    entered();await waiting;return f.localSource.lookup(query);
   }};
   const pending=f.router(source).prepare(f.privateRequest);
   await started;await f.faq.archive(OWNER,f.privateFAQ.id);release();
   assert.notEqual((await pending).status,'APPROVED_ANSWER');
  }finally{await f.close();}
 });
 test('B6 '+engine+': revoked chat assistant scope while source is waiting denies group response',async()=>{
  const f=await fixture(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r);
   const waiting=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async q=>{entered();await waiting;return f.localSource.lookup(q);}};
   const pending=f.router(source).prepare(f.groupRequest);
   await started;await f.policy.revokeChat(OWNER,GROUP);release();
   assert.deepEqual(await pending,{status:'DENIED'});
  }finally{await f.close();}
 });
 test('B6 '+engine+': provider errors and malformed answers fail closed, not converted to approved claims',async()=>{
  const f=await fixture(engine);try{
   const throwing:KnowledgeSourcePort={lookup:async()=>{throw Error('UPSTREAM_PRIVATE_INTERNAL');}};
   assert.deepEqual(await f.router(throwing).prepare(f.privateRequest),{status:'UNAVAILABLE'});
   const oversized:KnowledgeSourcePort={lookup:async()=>({
    status:'ANSWER',answer:'x'.repeat(5000),sourceId:f.privateResource
   })};
   assert.deepEqual(await f.router(oversized).prepare(f.privateRequest),{status:'UNAVAILABLE'});
  }finally{await f.close();}
 });
 test('B6 '+engine+': invalid question, actor or scope are rejected before reading any port or leaking a source',async()=>{
  const f=await fixture(engine);try{
   let calls=0;
   const s:KnowledgeSourcePort={lookup:async()=>{calls++;return {status:'NO_MATCH'};}};
   for(const input of [
    {...f.privateRequest,question:'a'.repeat(241)},
    {...f.privateRequest,question:'?'},
    {...f.privateRequest,question:'\u202eescape'},
    {...f.privateRequest,actor:'not-user'},
    {...f.privateRequest,scope:'../../private'},
    {...f.privateRequest,scope:'-1001'}
   ]){
    const result=await f.router(s).prepare(input);
    assert.notEqual(result.status,'APPROVED_ANSWER');
   }
   assert.equal(calls,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': genuine ambiguity needs clarification rather than selecting one approved answer',async()=>{
  const f=await fixture(engine);try{
   const second=await f.faq.submit(OWNER,'private',{question:QUESTION,
    answer:'جواب معتمد آخر مختلف',sourceResourceId:f.privateResource});
   await f.faq.approve(OWNER,second.id);
   assert.deepEqual(await f.router().prepare(f.privateRequest),{status:'AMBIGUOUS'});
  }finally{await f.close();}
 });
 test('B6 '+engine+': category disabled between lookup and final read hides the previously approved answer',async()=>{
  const f=await fixture(engine);try{
   let entered!:()=>void,release!:()=>void;
   const enteredPromise=new Promise<void>(r=>entered=r);
   const waiting=new Promise<void>(r=>release=r);
   const s:KnowledgeSourcePort={lookup:async q=>{
    const candidate=await f.localSource.lookup(q);entered();await waiting;return candidate;
   }};
   const pending=f.router(s).prepare(f.privateRequest);
   await enteredPromise;
   await f.store.transaction(state=>{
    state.educationCategories.find(c=>c.id==='private-grants')!.enabled=false;
   });
   release();
   assert.notEqual((await pending).status,'APPROVED_ANSWER');
  }finally{await f.close();}
 });
}
test('B6 knowledge port receives scope and question only: no Telegram actor, token or full chat history',async()=>{
 const f=await fixture('json');try{
  let received:unknown;
  const source:KnowledgeSourcePort={lookup:async query=>{
   received=query;return f.localSource.lookup(query);
  }};
  const res=await f.router(source).prepare(f.privateRequest);
  assert.equal(res.status,'APPROVED_ANSWER');
  assert.deepEqual(received,{scope:'private',question:QUESTION});
 }finally{await f.close();}
});
