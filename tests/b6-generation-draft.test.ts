import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ApprovedAnswerService} from '../src/education-interactions.js';
import {LocalFAQKnowledgeSource,B6AnswerPreflight} from '../src/b6-approved-answer-preflight.js';
import {B6DurableBudget} from '../src/b6-durable-budget.js';
import {B6EphemeralCallBudget,B6GenerationDraftService,
 type AnswerGenerationPort} from '../src/b6-generation-draft.js';

const OWNER='100',ACTOR='300',GROUP='-100777';
const QUESTION='ما شروط المنحة؟';
const ANSWER='المنحة تحتاج موافقة الجامعة المعتمدة.';
const NOW=1_800_000_000_000;
const draft=(sourceId:string,text='صياغة مسودة تراجعها الإدارة.')=>({
 schema:'b6-reviewed-draft-v1',sourceId,text,usage:{inputTokens:30,outputTokens:24}
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-b6-draft-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER,()=>NOW),faq=new ApprovedAnswerService(store,policy,()=>NOW);
 await policy.configurePrivateAI(OWNER,'ALL_OPT_IN');
 await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
 await policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION');
 const privateResource=randomUUID(),groupResource=randomUUID();
 await store.transaction(s=>{
  s.privateFeatures['content.upload']=true;
  s.educationCategories.push(
   {id:'pr',scope:'private',title:'منح',enabled:true,parentId:null,order:0},
   {id:'gr',scope:GROUP,title:'منح المجموعة',enabled:true,parentId:null,order:0});
  for(const [id,scope,cat] of [[privateResource,'private','pr'],[groupResource,GROUP,'gr']] as const)
   s.educationResources.push({id,scope,categoryId:cat,title:'منحة',university:'جامعة',
    cycle:'2027',degree:'Bachelor',seats:null,sourceImportId:randomUUID(),
    sourceLocator:'fake',reviewedBy:OWNER,status:'PUBLISHED'});
 });
 const privateFaq=await faq.submit(OWNER,'private',{question:QUESTION,answer:ANSWER,sourceResourceId:privateResource});
 const groupFaq=await faq.submit(OWNER,GROUP,{question:QUESTION,answer:'جواب المجموعة حصري',sourceResourceId:groupResource});
 await faq.approve(OWNER,privateFaq.id);await faq.approve(OWNER,groupFaq.id);
 let now=NOW,calls=0,seen:unknown;
 let port:AnswerGenerationPort={generate:async prompt=>{
  calls++;seen=prompt;return draft(prompt.sourceId);
 }};
 const preflight=new B6AnswerPreflight(store,policy,faq,new LocalFAQKnowledgeSource(store));
 const budget=(maxCallsPerUtcDay=3,maxConcurrent=2)=>
  new B6EphemeralCallBudget({maxCallsPerUtcDay,maxConcurrent},()=>now);
 const service=(enabled=true,b=budget(),generation:AnswerGenerationPort=port)=>
  new B6GenerationDraftService(preflight,generation,b,{enabled,maxOutputChars:400});
 const request={actor:ACTOR,scope:'private',question:QUESTION,optedIn:true};
 return {store,policy,faq,privateFaq,privateResource,groupResource,
  service,budget,request,setNow:(n:number)=>now=n,calls:()=>calls,seen:()=>seen,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': generation draft is explicit and disabled by default even with approved FAQ',async()=>{
  const f=await fixture(engine);try{
   const s=new B6GenerationDraftService(
    new B6AnswerPreflight(f.store,f.policy,f.faq,new LocalFAQKnowledgeSource(f.store)),
    {generate:async()=>{throw Error('SHOULD_NOT_RUN');}},f.budget());
   assert.deepEqual(await s.prepareDraft(f.request),{status:'DISABLED'});
  }finally{await f.close();}
 });
 test('B6 '+engine+': admitted local fake gets only one reviewed source and returns a DRAFT, never a published answer',async()=>{
  const f=await fixture(engine);try{
   const state=await f.store.snapshot();
   const r=await f.service().prepareDraft(f.request);
   assert.equal(r.status,'DRAFT');
   if(r.status==='DRAFT'){
    assert.equal(r.reviewState,'OWNER_REVIEW_REQUIRED');
    assert.equal(r.sourceId,f.privateResource);
    assert.match(r.draftText,/صياغة مسودة/);
    assert.equal(r.safeHtml,r.draftText);
    assert.deepEqual(r.usage,{inputTokens:30,outputTokens:24});
   }
   assert.deepEqual(f.seen(),{
    schema:'b6-reviewed-draft-v1',scope:'private',question:QUESTION,
    approvedAnswer:ANSWER,sourceId:f.privateResource,maxOutputChars:400
   });
   assert.deepEqual(await f.store.snapshot(),state);
  }finally{await f.close();}
 });
 test('B6 '+engine+': group mention is scoped and no private answers or actor identifiers reach the generation port',async()=>{
  const f=await fixture(engine);try{
   const r=await f.service().prepareDraft({actor:ACTOR,scope:GROUP,question:QUESTION,explicitMention:true});
   assert.equal(r.status,'DRAFT');
   const p=JSON.stringify(f.seen());
   assert.match(p,/جواب المجموعة حصري/);
   assert.doesNotMatch(p,/المنحة تحتاج موافقة/);
   assert.doesNotMatch(p,/"actor"|"chatHistory"|"userId"|"botToken"/);
   assert.ok(p.includes(f.groupResource));
  }finally{await f.close();}
 });
 test('B6 '+engine+': no opt-in, disabled AI, or unmentioned group prevents provider and budget use',async()=>{
  const f=await fixture(engine);try{
   const b=f.budget(1);
   const s=f.service(true,b);
   assert.equal((await s.prepareDraft({...f.request,optedIn:false})).status,'DENIED');
   assert.equal((await s.prepareDraft({actor:ACTOR,scope:GROUP,question:QUESTION,explicitMention:false})).status,'DENIED');
   await f.policy.configurePrivateAI(OWNER,'OFF');
   assert.equal((await s.prepareDraft(f.request)).status,'DENIED');
   assert.equal(f.calls(),0);
   assert.equal(b.summary().attemptsToday,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': no approved source, ambiguity, or malformed question cannot consume model budget',async()=>{
  const f=await fixture(engine);try{
   const b=f.budget(1),s=f.service(true,b);
   assert.equal((await s.prepareDraft({...f.request,question:'سؤال غير موجود'})).status,'NO_APPROVED_SOURCE');
   assert.equal((await s.prepareDraft({...f.request,question:'<secret>\u202e'})).status,'DENIED');
   const other=await f.faq.submit(OWNER,'private',{question:QUESTION,answer:'إجابة مختلفة',sourceResourceId:f.privateResource});
   await f.faq.approve(OWNER,other.id);
   assert.equal((await s.prepareDraft(f.request)).status,'AMBIGUOUS');
   assert.equal(f.calls(),0);assert.equal(b.summary().attemptsToday,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': daily attempts are bounded; successful and failed calls consume attempts without retry',async()=>{
  const f=await fixture(engine);try{
   const b=f.budget(2),s=f.service(true,b);
   assert.equal((await s.prepareDraft(f.request)).status,'DRAFT');
   assert.equal((await s.prepareDraft(f.request)).status,'DRAFT');
   assert.deepEqual(await s.prepareDraft(f.request),{status:'BUDGET_EXHAUSTED'});
   assert.equal(f.calls(),2);
   assert.equal(b.summary().attemptsToday,2);
   f.setNow(NOW+86_400_000);
   assert.equal((await s.prepareDraft(f.request)).status,'DRAFT');
   assert.equal(b.summary().attemptsToday,1);
   assert.equal(f.calls(),3);
  }finally{await f.close();}
 });
 test('B6 '+engine+': concurrent calls use one slot and cannot exceed call or concurrency cap',async()=>{
  const f=await fixture(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>release=r);
   const p:AnswerGenerationPort={generate:async req=>{entered();await waiting;return draft(req.sourceId);}};
   const b=f.budget(1,1),s=f.service(true,b,p);
   const pending=s.prepareDraft(f.request);
   await started;
   assert.deepEqual(await s.prepareDraft(f.request),{status:'BUSY'});
   release();
   assert.equal((await pending).status,'DRAFT');
   assert.deepEqual(await s.prepareDraft(f.request),{status:'BUDGET_EXHAUSTED'});
   assert.equal(b.summary().active,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': exceptions and ambiguous network outcome consume an attempt; no free blind retry',async()=>{
  const f=await fixture(engine);try{
   let calls=0;
   const p:AnswerGenerationPort={generate:async()=>{calls++;throw Error('PRIVATE_PROVIDER_API_KEY=secret');}};
   const b=f.budget(1),s=f.service(true,b,p);
   assert.deepEqual(await s.prepareDraft(f.request),{status:'UNAVAILABLE'});
   assert.deepEqual(await s.prepareDraft(f.request),{status:'BUDGET_EXHAUSTED'});
   assert.equal(calls,1);assert.equal(b.summary().active,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': source archival while fake generator is in flight yields no draft text',async()=>{
  const f=await fixture(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>release=r);
   const p:AnswerGenerationPort={generate:async req=>{
    entered();await waiting;return draft(req.sourceId,'Do not disclose stale data');
   }};
   const pending=f.service(true,f.budget(1),p).prepareDraft(f.request);
   await started;await f.faq.archive(OWNER,f.privateFaq.id);release();
   assert.deepEqual(await pending,{status:'STALE'});
  }finally{await f.close();}
 });
 test('B6 '+engine+': scope or opt-in revoked while generator runs cannot return a draft',async()=>{
  const f=await fixture(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>release=r);
   const p:AnswerGenerationPort={generate:async req=>{entered();await waiting;return draft(req.sourceId);}};
   const pending=f.service(true,f.budget(1),p).prepareDraft(f.request);
   await started;await f.policy.configurePrivateAI(OWNER,'OFF');release();
   assert.deepEqual(await pending,{status:'DENIED'});
  }finally{await f.close();}
 });
 test('B6 '+engine+': output schema, source binding, token quantities and Unicode controls fail closed',async()=>{
  const f=await fixture(engine);try{
   const variants:unknown[]=[
    {schema:'unknown',sourceId:f.privateResource,text:'invalid',usage:{inputTokens:2,outputTokens:2}},
    draft(f.groupResource),
    {...draft(f.privateResource),extra:'override'},
    {...draft(f.privateResource),text:'x'.repeat(401)},
    {...draft(f.privateResource),text:'text\u202eunsafe'},
    {...draft(f.privateResource),usage:{inputTokens:0,outputTokens:5}},
    {...draft(f.privateResource),usage:{inputTokens:999999,outputTokens:2}},
    {...draft(f.privateResource),usage:{inputTokens:2,outputTokens:0}},
    {...draft(f.privateResource),usage:{inputTokens:2,outputTokens:1000}},
    {...draft(f.privateResource),text:'  padded  '},
    null,
    'not an object'
   ];
   for(const output of variants){
    const p:AnswerGenerationPort={generate:async()=>output};
    assert.deepEqual(await f.service(true,f.budget(1),p).prepareDraft(f.request),
     {status:'INVALID_OUTPUT'});
   }
  }finally{await f.close();}
 });
 test('B6 '+engine+': HTML-like untrusted draft output can only be returned as safely escaped owner preview',async()=>{
  const f=await fixture(engine);try{
   const p:AnswerGenerationPort={generate:async req=>draft(req.sourceId,'<b>غير معتمد</b> & نص')};
   const response=await f.service(true,f.budget(),p).prepareDraft(f.request);
   assert.equal(response.status,'DRAFT');
   if(response.status==='DRAFT'){
    assert.equal(response.safeHtml,'&lt;b&gt;غير معتمد&lt;/b&gt; &amp; نص');
    assert.equal(response.reviewState,'OWNER_REVIEW_REQUIRED');
   }
  }finally{await f.close();}
 });
}
test('B6 ephemeral budget rejects malformed settings and does not masquerade as durable billing',()=>{
 for(const value of [{maxCallsPerUtcDay:0,maxConcurrent:1},
  {maxCallsPerUtcDay:1,maxConcurrent:0},{maxCallsPerUtcDay:1.5,maxConcurrent:1},
  {maxCallsPerUtcDay:100000,maxConcurrent:1}]){
  assert.throws(()=>new B6EphemeralCallBudget(value));
 }
 const budget=new B6EphemeralCallBudget({maxCallsPerUtcDay:1,maxConcurrent:1},()=>NOW);
 assert.equal(budget.summary().durable,false);
 assert.equal(budget.summary().attemptsToday,0);
});

for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': durable fake generation needs a stable request key and blocks replay after recreating services',async()=>{
  const f=await fixture(engine);try{
   const mk=(store=f.store)=>new B6DurableBudget(store,{
    maxDailyAttempts:2,maxDailyReservedTokens:16384,maxConcurrent:1,leaseMs:60000},()=>NOW);
   // A real fake port is explicitly supplied; absence of a key is denied BEFORE provider.
   const fake:AnswerGenerationPort={generate:async input=>draft(input.sourceId)};
   const s=new B6GenerationDraftService(
    new B6AnswerPreflight(f.store,f.policy,f.faq,new LocalFAQKnowledgeSource(f.store)),
    fake,f.budget(),{enabled:true},mk());
   assert.deepEqual(await s.prepareDraft(f.request),{status:'INVALID_REQUEST'});
   const made=await s.prepareDraft(f.request,'draft-request-0001');
   assert.equal(made.status,'DRAFT');
   const recreatedStore=new BotStore(f.store.file,{engine});
   const service=new B6GenerationDraftService(
    new B6AnswerPreflight(recreatedStore,f.policy,f.faq,new LocalFAQKnowledgeSource(recreatedStore)),
    fake,f.budget(),{enabled:true},mk(recreatedStore));
   assert.deepEqual(await service.prepareDraft(f.request,'draft-request-0001'),{status:'DUPLICATE'});
   assert.equal((await mk().inspect()).attemptsToday,1);
  }finally{await f.close();}
 });
 test('B6 '+engine+': thrown fake provider retains full reserved charge as UNKNOWN and denies repeat',async()=>{
  const f=await fixture(engine);try{
   let calls=0;
   const stable=new B6DurableBudget(f.store,{
    maxDailyAttempts:1,maxDailyReservedTokens:8192,maxConcurrent:1,leaseMs:60000},()=>NOW);
   const failing:AnswerGenerationPort={generate:async()=>{calls++;throw Error('untrusted provider issue');}};
   const service=new B6GenerationDraftService(
    new B6AnswerPreflight(f.store,f.policy,f.faq,new LocalFAQKnowledgeSource(f.store)),
    failing,f.budget(),{enabled:true},stable);
   assert.deepEqual(await service.prepareDraft(f.request,'draft-request-0002'),{status:'UNAVAILABLE'});
   assert.deepEqual(await service.prepareDraft(f.request,'draft-request-0002'),{status:'DUPLICATE'});
   assert.equal(calls,1);
   const totals=await stable.inspect();
   assert.equal(totals.unknownCount,1);
   assert.equal(totals.reservedTokensToday,8192);
   assert.equal(totals.active,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': fake provider response after expired durable lease cannot yield a draft',async()=>{
  const f=await fixture(engine);try{
   let release!:()=>void,entered!:()=>void;
   const waiting=new Promise<void>(r=>release=r);
   const started=new Promise<void>(r=>entered=r);
   let now=NOW;
   const ledger=new B6DurableBudget(f.store,{
    maxDailyAttempts:1,maxDailyReservedTokens:8192,maxConcurrent:1,leaseMs:1000},()=>now);
   const generation:AnswerGenerationPort={generate:async q=>{
    entered();await waiting;return draft(q.sourceId);
   }};
   const service=new B6GenerationDraftService(
    new B6AnswerPreflight(f.store,f.policy,f.faq,new LocalFAQKnowledgeSource(f.store)),
    generation,f.budget(),{enabled:true},ledger);
   const pending=service.prepareDraft(f.request,'draft-request-0003');
   await started;
   now+=1001;release();
   assert.deepEqual(await pending,{status:'UNAVAILABLE'});
   assert.equal(await ledger.recoverExpired(),1);
   assert.equal((await ledger.inspect()).unknownCount,1);
  }finally{await f.close();}
 });
 test('B6 '+engine+': revoked source during fake generation still consumes durable attempt and hides draft',async()=>{
  const f=await fixture(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>release=r);
   const ledger=new B6DurableBudget(f.store,{
    maxDailyAttempts:1,maxDailyReservedTokens:8192,maxConcurrent:1,leaseMs:60000},()=>NOW);
   const generation:AnswerGenerationPort={generate:async q=>{entered();await waiting;return draft(q.sourceId);}};
   const service=new B6GenerationDraftService(
    new B6AnswerPreflight(f.store,f.policy,f.faq,new LocalFAQKnowledgeSource(f.store)),
    generation,f.budget(),{enabled:true},ledger);
   const pending=service.prepareDraft(f.request,'draft-request-0004');
   await started;await f.faq.archive(OWNER,f.privateFaq.id);release();
   assert.deepEqual(await pending,{status:'STALE'});
   assert.equal((await ledger.inspect()).attemptsToday,1);
   assert.equal((await ledger.inspect()).active,0);
  }finally{await f.close();}
 });
}
