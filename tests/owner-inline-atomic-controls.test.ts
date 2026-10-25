import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {parseOwnerInlineControlPreview} from '../src/telegram-inline-group-controls.js';

const CHAT='-100123',OWNER='100';
const event=(id:number,actor:number,data:string,group=false)=>({
 update_id:id,callback_query:{id:'inline_'+id,from:{id:actor,is_bot:false},data,
 message:{message_id:77,chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-inline-atomic-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 let clock=1700000000000;
 const policy=new Policy(store,OWNER,()=>clock);
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,CHAT,['navigation','assistant','publishing','verification','moderation']);
 await policy.configureGroupAI(OWNER,CHAT,'ALL_MENTION');
 await store.transaction(s=>{s.subscriptionRequirements.push({chatId:CHAT,channelIds:['-100456','-100457'],mode:'ALL',version:3});});
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',clock:()=>clock});
 return {store,policy,app,advance:(ms:number)=>{clock+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
const preview=(v:number,op:'x'|'a'|'p'|'s'|'r')=>'mi:1:g:v:'+CHAT+':'+v+':0:'+op;
test('new sensitive preview grammar is exact and no direct mutation is accepted',()=>{
 assert.deepEqual(parseOwnerInlineControlPreview(preview(2,'s')),
  {chatId:CHAT,version:2,page:0,operation:'pauseSubscription'});
 assert.deepEqual(parseOwnerInlineControlPreview(preview(2,'r')),
  {chatId:CHAT,version:2,page:0,operation:'revokeChat'});
 for(const d of [preview(2,'r')+'x',preview(2,'s')+'\n',
  'mi:1:g:v:-100123:02:0:r','mi:1:g:v:-100123:2:0:K'])
  assert.equal(parseOwnerInlineControlPreview(d),null);
});
for(const engine of ['json','sqlite'] as const){
 test('pause subscription preview is immutable; owner one-shot confirmation atomically updates rule and audit ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const version=(await f.store.snapshot()).chats[0]!.version;
   const card=await f.app().handle(event(1,100,'mi:1:g:d:'+CHAT+':'+version+':0'));
   assert.ok(buttons(card).some(b=>b.callback_data===preview(version,'s')));
   const pending=await f.app().handle(event(2,100,preview(version,'s')));
   assert.equal(pending.status,'APPLIED');
   assert.match(pending.plan?.text??'',/تعليق الاشتراك/);
   const t=buttons(pending).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   let snap=await f.store.snapshot();
   assert.equal(snap.subscriptionRequirements[0]!.version,3);
   assert.deepEqual(snap.subscriptionRequirements[0]!.channelIds,['-100456','-100457']);
   const record=snap.callbacks.find(c=>c.ref===t)!;
   assert.equal(record.requirementVersion,3);
   assert.equal(record.used,false);
   assert.equal((await f.app().handle(event(3,300,t))).status,'DENIED');
   assert.equal((await f.app().handle(event(4,100,t))).status,'APPLIED');
   snap=await f.store.snapshot();
   assert.deepEqual(snap.subscriptionRequirements[0]!.channelIds,[]);
   assert.equal(snap.subscriptionRequirements[0]!.version,4);
   assert.equal(snap.chats[0]!.version,version+1);
   assert.equal(snap.callbacks.find(c=>c.ref===t)?.used,true);
   assert.equal(snap.moderationOperations.length,0);
   assert.ok(snap.audit.some(a=>a.reason==='SUBSCRIPTION_REQUIREMENT_PAUSED_LOCALLY'));
   assert.equal((await f.app().handle(event(5,100,t))).status,'DENIED');
  }finally{await f.close();}
 });
 test('rule-only change invalidates pause token without consuming it or touching policy ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const v=(await f.store.snapshot()).chats[0]!.version;
   const p=await f.app().handle(event(10,100,preview(v,'s')));
   const t=buttons(p).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   await f.store.transaction(s=>{s.subscriptionRequirements[0]!.mode='ANY';s.subscriptionRequirements[0]!.version++;});
   assert.equal((await f.app().handle(event(11,100,t))).status,'DENIED');
   const snap=await f.store.snapshot();
   assert.equal(snap.callbacks.find(c=>c.ref===t)?.used,false);
   assert.equal(snap.chats[0]!.version,v);
   assert.equal(snap.subscriptionRequirements[0]!.channelIds.length,2);
  }finally{await f.close();}
 });
 test('revoke chat requires one-shot review and invalidates dependent subscription policies ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const v=(await f.store.snapshot()).chats[0]!.version;
   const card=await f.app().handle(event(20,100,'mi:1:g:d:'+CHAT+':'+v+':0'));
   assert.ok(buttons(card).some(b=>b.callback_data===preview(v,'r')));
   const p=await f.app().handle(event(21,100,preview(v,'r')));
   const token=buttons(p).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   assert.match(p.plan?.text??'',/إلغاء/);
   assert.equal((await f.store.snapshot()).chats[0]!.approved,true);
   assert.equal((await f.app().handle(event(22,100,token))).status,'APPLIED');
   const snap=await f.store.snapshot();
   assert.equal(snap.chats[0]!.approved,false);
   assert.equal(snap.chats[0]!.groupAI,'OFF');
   assert.equal(snap.chats[0]!.version,v+1);
   assert.equal(snap.subscriptionRequirements[0]!.channelIds.length,0);
   assert.equal(snap.callbacks.find(c=>c.ref===token)!.used,true);
   assert.ok(snap.audit.some(a=>a.reason==='CHAT_OWNER_REVOKED_LOCALLY'));
   assert.equal(snap.operations.length,0);
   assert.equal((await f.app().handle(event(23,100,token))).status,'DENIED');
  }finally{await f.close();}
 });
 test('original AI-off action is still one-shot and never consumes on stale CAS ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const v=(await f.store.snapshot()).chats[0]!.version;
   const first=await f.app().handle(event(31,100,preview(v,'x')));
   const token=buttons(first).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   await f.policy.approveChat(OWNER,CHAT,['navigation','assistant','publishing','verification','moderation']);
   assert.equal((await f.app().handle(event(32,100,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.find(c=>c.ref===token)?.used,false);
   assert.equal((await f.store.snapshot()).chats[0]?.groupAI,'ALL_MENTION');
  }finally{await f.close();}
 });
 test('parallel independent owner confirmations permit only one transition, no orphan consumption ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const v=(await f.store.snapshot()).chats[0]!.version;
   const p1=await f.app().handle(event(41,100,preview(v,'x')));
   const p2=await f.app().handle(event(42,100,preview(v,'x')));
   const t1=buttons(p1).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   const t2=buttons(p2).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   const [a,b]=await Promise.all([f.app().handle(event(43,100,t1)),f.app().handle(event(44,100,t2))]);
   assert.deepEqual([a.status,b.status].sort(),['APPLIED','DENIED']);
   const snap=await f.store.snapshot();
   assert.equal(snap.chats[0]!.version,v+1);
   assert.equal(snap.callbacks.filter(c=>[t1,t2].includes(c.ref)&&c.used).length,1);
   assert.equal(snap.audit.filter(x=>x.reason==='CHAT_OWNER_AI_DISABLED').length,1);
  }finally{await f.close();}
 });
 test('expired or nonowner tokens fail before atomic policy changes ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const v=(await f.store.snapshot()).chats[0]!.version;
   const p=await f.app().handle(event(51,100,preview(v,'r')));
   const t=buttons(p).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   assert.equal((await f.app().handle(event(52,300,t))).status,'DENIED');
   assert.equal((await f.app().handle(event(53,100,t,true))).status,'DENIED');
   f.advance(121000);
   assert.equal((await f.app().handle(event(54,100,t))).status,'DENIED');
   const snap=await f.store.snapshot();
   assert.equal(snap.chats[0]!.approved,true);
   assert.equal(snap.callbacks.find(c=>c.ref===t)?.used,false);
  }finally{await f.close();}
 });
}
