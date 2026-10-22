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
import {B6EphemeralCallBudget,B6GenerationDraftService,type AnswerGenerationPort} from '../src/b6-generation-draft.js';
import {B6TelegramIntentKeys,B6TelegramDraftEntrypoint} from '../src/b6-telegram-intent.js';

const SECRET='a30c7d291b8e460f'.repeat(4);
const OTHER_SECRET='90a457bc12de683f'.repeat(4);
const NOW=1_800_000_000_000;
const OWNER='100',STUDENT='300',GROUP='-100777';
const QUESTION='ما شروط المنحة؟';
const verified={botId:'manaratak_bot',updateId:123456789};
const keys=()=>new B6TelegramIntentKeys(SECRET);
const allowed=/^b6tg1_[A-Za-z0-9_-]{43}$/u;

test('B6 Telegram intent key requires a durable, explicit 256-bit hex secret',()=>{
 for(const value of ['', 'test-token','ab'.repeat(31),'ab'.repeat(33),
  'Z'.repeat(64),'0'.repeat(64),123,null,undefined]){
  assert.throws(()=>new B6TelegramIntentKeys(value as string),/INVALID_B6_TELEGRAM_INTENT_SECRET/);
 }
 assert.ok(keys());
});
test('B6 Telegram intent key is deterministic across process recreation, opaque, and URL-safe',()=>{
 const first=keys().derive(verified);
 const recreated=keys().derive({...verified});
 assert.equal(first,recreated);
 assert.match(first!,allowed);
 assert.equal(first!.includes(verified.botId),false);
 assert.equal(first!.includes(String(verified.updateId)),false);
 assert.equal(first!.includes(SECRET),false);
});
test('B6 Telegram intent key separates bot, update number and key material',()=>{
 const a=keys().derive(verified);
 const variants=[
  keys().derive({...verified,botId:'other_bot'}),
  keys().derive({...verified,updateId:verified.updateId+1}),
  new B6TelegramIntentKeys(OTHER_SECRET).derive(verified),
  keys().derive({botId:'bot-1',updateId:23}),
  keys().derive({botId:'bot-12',updateId:3})
 ];
 assert.equal(new Set([a,...variants]).size,variants.length+1);
});
test('B6 Telegram intent rejects forged, ambiguous or malformed fields before any budget admission',()=>{
 const invalid:unknown[]=[
  null,{},[],{botId:'',updateId:1},{botId:'a',updateId:-1},
  {botId:'a',updateId:1.25},{botId:'a',updateId:Number.MAX_SAFE_INTEGER+1},
  {botId:'a',updateId:'1'},{botId:'a',updateId:true},
  {botId:'a'.repeat(81),updateId:1},{botId:'bad:id',updateId:1},
  {botId:'a',updateId:1,requestKey:'fake-bypass'},
  {botId:'a',updateId:1,text:'hijack'},
  {botId:'a',updateId:1,actorId:STUDENT}
 ];
 for(const item of invalid)assert.equal(keys().derive(item),null,JSON.stringify(item));
 assert.match(keys().derive({botId:'bot',updateId:0})!,allowed);
});

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-b6-intent-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(path,{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 const faq=new ApprovedAnswerService(store,policy,()=>NOW);
 await policy.configurePrivateAI(OWNER,'ALL_OPT_IN');
 const sourceId=randomUUID();
 await store.transaction(s=>{
  s.privateFeatures['content.upload']=true;
  s.educationCategories.push({id:'scholar',scope:'private',parentId:null,
   title:'منح',order:0,enabled:true});
  s.educationResources.push({id:sourceId,categoryId:'scholar',scope:'private',title:'منحة',
   university:'جامعة',cycle:'2027',degree:'Bachelor',seats:null,sourceImportId:randomUUID(),
   sourceLocator:'approved',reviewedBy:OWNER,status:'PUBLISHED'});
 });
 const entry=await faq.submit(OWNER,'private',{
  question:QUESTION,answer:'الجواب الرسمي المعتمد',sourceResourceId:sourceId});
 await faq.approve(OWNER,entry.id);
 let calls=0,seen:unknown;
 const generation:AnswerGenerationPort={generate:async prompt=>{
  calls++;seen=prompt;
  return {schema:'b6-reviewed-draft-v1',sourceId:prompt.sourceId,
   text:'مسودة للمراجعة فقط',usage:{inputTokens:20,outputTokens:10}};
 }};
 const service=(s=store,durable=true,enabled=true)=>{
  const preflight=new B6AnswerPreflight(s,policy,faq,new LocalFAQKnowledgeSource(s));
  const budget=new B6EphemeralCallBudget({maxCallsPerUtcDay:5,maxConcurrent:2},()=>NOW);
  const ledger=durable?new B6DurableBudget(s,{
   maxDailyAttempts:5,maxDailyReservedTokens:5*8192,maxConcurrent:2,leaseMs:60000},()=>NOW):undefined;
  return new B6GenerationDraftService(preflight,generation,budget,{enabled},ledger);
 };
 return {store,path,engine,policy,service,calls:()=>calls,seen:()=>seen,
  request:{actor:STUDENT,scope:'private',question:QUESTION,optedIn:true},
  close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': same Telegram update cannot regenerate even after reconstructing budget and service',async()=>{
  const f=await fixture(engine);try{
   const original=new B6TelegramDraftEntrypoint(keys(),f.service());
   assert.equal((await original.prepare(f.request,verified)).status,'DRAFT');
   const reopened=new BotStore(f.path,{engine});
   const recreated=new B6TelegramDraftEntrypoint(keys(),f.service(reopened));
   assert.deepEqual(await recreated.prepare(f.request,verified),{status:'DUPLICATE'});
   assert.equal(f.calls(),1);
   const rows=(await f.store.snapshot()).b6BudgetAttempts!;
   assert.equal(rows.length,1);
   assert.match(rows[0]!.requestKey,allowed);
   assert.equal(JSON.stringify(rows).includes('"actor":"300"'),false);
   assert.equal(JSON.stringify(rows).includes('manaratak_bot'),false);
   assert.equal(JSON.stringify(rows).includes('ما شروط المنحة'),false);
   assert.equal(JSON.stringify(rows).includes('الجواب الرسمي المعتمد'),false);
  }finally{await f.close();}
 });
 test('B6 '+engine+': distinct verified update has a unique durable reservation',async()=>{
  const f=await fixture(engine);try{
   const gate=new B6TelegramDraftEntrypoint(keys(),f.service());
   assert.equal((await gate.prepare(f.request,verified)).status,'DRAFT');
   assert.equal((await gate.prepare(f.request,{...verified,updateId:verified.updateId+1})).status,'DRAFT');
   assert.equal(f.calls(),2);
   const rows=(await f.store.snapshot()).b6BudgetAttempts!;
   assert.equal(new Set(rows.map(r=>r.requestKey)).size,2);
  }finally{await f.close();}
 });
 test('B6 '+engine+': trusted Telegram entrypoint never executes with nonpersistent budget',async()=>{
  const f=await fixture(engine);try{
   const gate=new B6TelegramDraftEntrypoint(keys(),f.service(f.store,false));
   assert.deepEqual(await gate.prepare(f.request,verified),{status:'UNAVAILABLE'});
   assert.equal(f.calls(),0);
   assert.equal((await f.store.snapshot()).b6BudgetAttempts?.length??0,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': rejected event cannot call fake model or touch reserved ledger',async()=>{
  const f=await fixture(engine);try{
   const gate=new B6TelegramDraftEntrypoint(keys(),f.service());
   for(const event of [null,{...verified,updateId:-1},
    {...verified,requestKey:'forged-retry-id'}, {...verified,text:'altered'}]){
    assert.deepEqual(await gate.prepare(f.request,event),{status:'INVALID_REQUEST'});
   }
   assert.equal(f.calls(),0);
   assert.equal((await f.store.snapshot()).b6BudgetAttempts?.length??0,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': disabled AI and revoked policy never consume a verified Telegram event',async()=>{
  const f=await fixture(engine);try{
   const off=new B6TelegramDraftEntrypoint(keys(),f.service(f.store,true,false));
   assert.deepEqual(await off.prepare(f.request,verified),{status:'DISABLED'});
   const live=new B6TelegramDraftEntrypoint(keys(),f.service());
   await f.policy.configurePrivateAI(OWNER,'OFF');
   assert.deepEqual(await live.prepare(f.request,verified),{status:'DENIED'});
   assert.equal(f.calls(),0);
   assert.equal((await f.store.snapshot()).b6BudgetAttempts?.length??0,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': same update cannot be reused to obtain a draft for a different approved scope',async()=>{
  const f=await fixture(engine);try{
   const gate=new B6TelegramDraftEntrypoint(keys(),f.service());
   assert.equal((await gate.prepare(f.request,verified)).status,'DRAFT');
   assert.deepEqual(await gate.prepare({...f.request,actor:STUDENT},verified),{status:'DUPLICATE'});
   assert.equal(f.calls(),1);
  }finally{await f.close();}
 });
}
