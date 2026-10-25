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
import {parseOwnerInlineDelegationRoute} from '../src/telegram-inline-delegations.js';
const OWNER='100',CHAT='-100123';
const cb=(i:number,actor:number,data:string,group=false)=>({
 update_id:i,callback_query:{id:'deleg_'+i,from:{id:actor,is_bot:false},data,
 message:{message_id:55,chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}}
});
const btn=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-delegation-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 let now=1700000000000;
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',clock:()=>now});
 return {store,policy,app,advance:(delta:number)=>{now+=delta;},now:()=>now,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('owner delegation callback selectors are canonical and bounded',()=>{
 assert.deepEqual(parseOwnerInlineDelegationRoute('mi:1:d:p:0'),{kind:'list',page:0});
 assert.deepEqual(parseOwnerInlineDelegationRoute('mi:1:d:i:1:2:abcdef012345'),
  {kind:'detail',page:1,ordinal:2,digest:'abcdef012345'});
 for(const bad of ['mi:1:d:p:01','mi:1:d:p:1000','mi:1:d:p:-1',
  'mi:1:d:i:1:0:abcdef012345','mi:1:d:i:1:9:abcdef012345',
  'mi:1:d:i:1:2:ABCDEF012345','mi:1:d:i:1:2:abcdef012345\\n',
  'mi:1:d:i:1:2:abcdef012345:confirm','mi:2:d:p:0',
  'mi:1:d:p:0\\n'])assert.equal(parseOwnerInlineDelegationRoute(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('owner can see scoped saved grants with accurate local status and details ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['navigation']);
   await f.policy.grant(OWNER,'301','chat.manage',CHAT,f.now()+30000);
   await f.policy.grant(OWNER,'302','ai.ask',CHAT,f.now()+50000);
   const first=await f.app().handle(cb(1,100,'mi:1:i:03:01'));
   assert.equal(first.status,'APPLIED');
   assert.match(first.plan?.text??'',/التفويضات|المشرفين/);
   assert.match(first.plan?.text??'',/داخل المدة|ساري/);
   assert.equal(isValidTelegramInlineKeyboard(first.plan?.inlineMarkup),true);
   assert.equal(first.plan?.editMessageId,55);
   const detailData=btn(first).find(b=>b.callback_data.startsWith('mi:1:d:i:'))!.callback_data;
   const detail=await f.app().handle(cb(2,100,detailData));
   assert.equal(detail.status,'APPLIED');
   assert.match(detail.plan?.text??'',/301|302/);
   assert.match(detail.plan?.text??'',/صلاحية|قدرة/);
   assert.match(detail.plan?.text??'',/حقوق Telegram|صلاحيات Telegram/);
   assert.equal(btn(detail).some(b=>b.callback_data==='mi:1:d:p:0'),true);
   assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason.includes('GRANT')).length,0);
  }finally{await f.close();}
 });
 test('paginates 19 grants; detail bound to the current slot and state ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['navigation']);
   for(let n=0;n<19;n++)await f.policy.grant(OWNER,String(500+n),'chat.manage',CHAT,f.now()+60000);
   const a=await f.app().handle(cb(10,100,'mi:1:d:p:0'));
   assert.equal(btn(a).filter(b=>b.callback_data.startsWith('mi:1:d:i:')).length,8);
   const b=await f.app().handle(cb(11,100,'mi:1:d:p:1'));
   assert.equal(btn(b).filter(b=>b.callback_data.startsWith('mi:1:d:i:')).length,8);
   const c=await f.app().handle(cb(12,100,'mi:1:d:p:2'));
   assert.equal(btn(c).filter(b=>b.callback_data.startsWith('mi:1:d:i:')).length,3);
   assert.equal((await f.app().handle(cb(13,100,'mi:1:d:p:3'))).status,'DENIED');
   const selected=btn(b).find(x=>x.callback_data.startsWith('mi:1:d:i:'))!.callback_data;
   const before=await f.app().handle(cb(14,100,selected));
   assert.equal(before.status,'APPLIED');
   // Move a new grant into the beginning; old callback must not switch people.
   await f.policy.grant(OWNER,'100','chat.manage',CHAT,f.now()+60000);
   assert.equal((await f.app().handle(cb(15,100,selected))).status,'DENIED');
  }finally{await f.close();}
 });
 test('revoked or expired grant invalidates its old detail button ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['navigation']);
   await f.policy.grant(OWNER,'301','chat.manage',CHAT,f.now()+30000);
   const list=await f.app().handle(cb(20,100,'mi:1:i:03:01'));
   const token=btn(list).find(x=>x.callback_data.startsWith('mi:1:d:i:'))!.callback_data;
   await f.policy.revokeGrant(OWNER,'301','chat.manage',CHAT);
   assert.equal((await f.app().handle(cb(21,100,token))).status,'DENIED');
   const fresh=await f.app().handle(cb(22,100,'mi:1:d:p:0'));
   assert.match(fresh.plan?.text??'',/ملغى/);
   const revoked=btn(fresh).find(x=>x.callback_data.startsWith('mi:1:d:i:'))!.callback_data;
   f.advance(40000);
   // Revoked grant stays revoked; expiration changes its status without lifting restrictions.
   assert.equal((await f.app().handle(cb(23,100,revoked))).status,'APPLIED');
   assert.match((await f.app().handle(cb(24,100,'mi:1:d:p:0'))).plan?.text??'',/ملغى/);
  }finally{await f.close();}
 });
 test('owner-only private context blocks all student/staff/group access ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['navigation']);
   await f.policy.grant(OWNER,'301','chat.manage',CHAT,f.now()+30000);
   const list=await f.app().handle(cb(30,100,'mi:1:i:03:01'));
   const token=btn(list).find(x=>x.callback_data.startsWith('mi:1:d:i:'))!.callback_data;
   for(const [i,data] of ['mi:1:i:03:01','mi:1:d:p:0',token].entries()){
    for(const actor of [200,301]){
     const outcome=await f.app().handle(cb(40+i*10+actor,data));
     assert.equal(outcome.status,'DENIED',data);
     assert.equal(outcome.plan,undefined);
    }
    assert.equal((await f.app().handle(cb(70+i,100,data,true))).status,'DENIED');
   }
   assert.equal((await f.store.snapshot()).grants.length,1);
  }finally{await f.close();}
 });
}
