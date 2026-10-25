import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {parseOwnerInlineControlPreview} from '../src/telegram-inline-group-controls.js';

const OWNER='100', CHAT='-100123';
const callback=(update:number,actor:number,data:string,group=false)=>({
 update_id:update,callback_query:{id:'control_'+update,from:{id:actor,is_bot:false},data,
 message:{message_id:77,chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}}
});
const btn=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-group-inline-control-'));
 const path=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 const store=new BotStore(path,{engine}),policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 let now=1700000000000;
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',clock:()=>now});
 await policy.approveChat(OWNER,CHAT,['navigation','assistant','publishing','moderation']);
 await policy.configureGroupAI(OWNER,CHAT,'OWNER_MENTION');
 const current=()=>store.snapshot();
 return {store,policy,app,current,advance:(ms:number)=>{now+=ms;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
const reviewData=(version:number,op:'x'|'a'|'p')=>'mi:1:g:v:'+CHAT+':'+version+':0:'+op;
test('inline control preview grammar strict and finite; callback is never an action grant',()=>{
 assert.deepEqual(parseOwnerInlineControlPreview('mi:1:g:v:-100123:2:0:x'),
  {chatId:'-100123',version:2,page:0,operation:'aiOff'});
 assert.deepEqual(parseOwnerInlineControlPreview('mi:1:g:v:-100123:2:0:a'),
  {chatId:'-100123',version:2,page:0,operation:'restrictAssistant'});
 assert.deepEqual(parseOwnerInlineControlPreview('mi:1:g:v:-100123:2:0:p'),
  {chatId:'-100123',version:2,page:0,operation:'restrictPublishing'});
 for(const bad of ['mi:1:g:v:-100123:2:0:z','mi:1:g:v:-100123:02:0:x',
  'mi:1:g:v:-100123:2:00:p','mi:1:g:v:-100123:2:0:x\n',
  'mi:1:g:v:-100123:2:0:x:confirm','mi:1:g:v:100123:2:0:a',
  'mi:1:g:v:-100123:0:0:a','mi:2:g:v:-100123:2:0:a',
  'mi:1:g:v:-100123:2:1000:p','c_'+'z'.repeat(24)])
  assert.equal(parseOwnerInlineControlPreview(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('review does not mutate; unguessable one-shot confirmation disables only local group AI ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const before=(await f.current()).chats[0]!;
   const details=await f.app().handle(callback(1,100,'mi:1:g:d:'+CHAT+':'+before.version+':0'));
   const review=btn(details).find(b=>b.callback_data===reviewData(before.version,'x'))!;
   assert.ok(review);
   const preview=await f.app().handle(callback(2,100,review.callback_data));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/مراجعة|معاينة/);
   assert.match(preview.plan?.text??'',/محلي/);
   const confirm=btn(preview).find(b=>/^c_[A-Za-z0-9_-]{24}$/u.test(b.callback_data))!;
   assert.ok(confirm);
   assert.equal(isValidTelegramInlineKeyboard(preview.plan?.inlineMarkup),true);
   assert.equal((await f.current()).chats[0]!.version,before.version);
   assert.equal((await f.current()).chats[0]!.groupAI,'OWNER_MENTION');
   const done=await f.app().handle(callback(3,100,confirm.callback_data));
   assert.equal(done.status,'APPLIED');
   assert.match(done.plan?.text??'',/محلي/);
   assert.equal(done.plan?.editMessageId,77);
   const after=(await f.current()).chats[0]!;
   assert.equal(after.groupAI,'OFF');
   assert.equal(after.version,before.version+1);
   assert.ok((await f.current()).audit.some(x=>x.reason==='CHAT_OWNER_AI_DISABLED'));
   assert.equal((await f.app().handle(callback(3,100,confirm.callback_data))).status,'DUPLICATE');
   assert.equal((await f.app().handle(callback(4,100,confirm.callback_data))).status,'DENIED');
   assert.equal((await f.current()).chats[0]!.version,before.version+1);
  }finally{await f.close();}
 });
 test('restrict assistant or publishing only after a bound owner confirmation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   let version=(await f.current()).chats[0]!.version;
   const first=await f.app().handle(callback(10,100,reviewData(version,'p')));
   assert.equal(first.status,'APPLIED');
   const token=btn(first).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   assert.equal((await f.current()).chats[0]!.scopes.includes('publishing'),true);
   assert.equal((await f.app().handle(callback(11,100,token))).status,'APPLIED');
   assert.equal((await f.current()).chats[0]!.scopes.includes('publishing'),false);
   version=(await f.current()).chats[0]!.version;
   const second=await f.app().handle(callback(12,100,reviewData(version,'a')));
   assert.equal(second.status,'APPLIED');
   const next=btn(second).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   assert.equal((await f.app().handle(callback(13,100,next))).status,'APPLIED');
   const after=(await f.current()).chats[0]!;
   assert.equal(after.scopes.includes('assistant'),false);
   assert.equal(after.groupAI,'OFF');
   assert.equal(after.approved,true);
   assert.equal(after.scopes.includes('navigation'),true);
   assert.equal((await f.current()).moderationOperations.length,0);
   assert.ok((await f.current()).audit.some(x=>x.reason==='CHAT_OWNER_SCOPE_RESTRICTED'));
  }finally{await f.close();}
 });
 test('nonowners and forged direct confirmations cannot execute or consume authorized intent ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const before=(await f.current()).chats[0]!.version;
   assert.equal((await f.app().handle(callback(20,300,reviewData(before,'x')))).status,'DENIED');
   assert.equal((await f.app().handle(callback(21,100,reviewData(before,'x'),true))).status,'DENIED');
   assert.equal((await f.app().handle(callback(22,100,'c_'+'a'.repeat(24)))).status,'DENIED');
   const preview=await f.app().handle(callback(23,100,reviewData(before,'x')));
   const token=btn(preview).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   assert.equal((await f.app().handle(callback(24,200,token))).status,'DENIED');
   assert.equal((await f.app().handle(callback(25,300,token))).status,'DENIED');
   assert.equal((await f.current()).chats[0]!.groupAI,'OWNER_MENTION');
   assert.equal((await f.app().handle(callback(26,100,token))).status,'APPLIED');
  }finally{await f.close();}
 });
 test('stale revocation and changed revisions make issued confirmations unusable ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const v=(await f.current()).chats[0]!.version;
   const preview=await f.app().handle(callback(30,100,reviewData(v,'x')));
   const token=btn(preview).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   await f.policy.approveChat(OWNER,CHAT,['navigation','assistant','publishing']);
   assert.equal((await f.app().handle(callback(31,100,token))).status,'DENIED');
   assert.equal((await f.current()).chats[0]!.groupAI,'OWNER_MENTION');
   const freshV=(await f.current()).chats[0]!.version;
   const newPreview=await f.app().handle(callback(32,100,reviewData(freshV,'x')));
   const newToken=btn(newPreview).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   await f.policy.revokeChatAtRevision(OWNER,CHAT,freshV);
   assert.equal((await f.app().handle(callback(33,100,newToken))).status,'DENIED');
   assert.equal((await f.current()).chats[0]!.approved,false);
  }finally{await f.close();}
 });
 test('expiring owner one-shot callbacks fail closed, including after app restart ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const v=(await f.current()).chats[0]!.version;
   const preview=await f.app().handle(callback(40,100,reviewData(v,'x')));
   const token=btn(preview).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   f.advance(121000);
   assert.equal((await f.app().handle(callback(41,100,token))).status,'DENIED');
   assert.equal((await f.current()).chats[0]!.groupAI,'OWNER_MENTION');
  }finally{await f.close();}
 });
 test('distinct repeated confirmation updates race safely with a single policy mutation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const v=(await f.current()).chats[0]!.version;
   const preview=await f.app().handle(callback(50,100,reviewData(v,'x')));
   const token=btn(preview).find(b=>b.callback_data.startsWith('c_'))!.callback_data;
   const [a,b]=await Promise.all([
    f.app().handle(callback(51,100,token)),
    f.app().handle(callback(52,100,token))
   ]);
   assert.deepEqual([a.status,b.status].sort(),['APPLIED','DENIED']);
   assert.equal((await f.current()).chats[0]!.version,v+1);
  }finally{await f.close();}
 });
}
