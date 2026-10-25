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
import {staffInlineRoute} from '../src/telegram-inline-staff.js';

const CHAT='-100123', OWNER='100', STAFF='301';
const msg=(id:number,actor:number,text:string)=>({update_id:id,message:{
 message_id:id,chat:{id:actor,type:'private'},from:{id:actor,is_bot:false},text}});
const cb=(id:number,actor:number,data:string,group=false)=>({update_id:id,callback_query:{
 id:'staff_'+id,from:{id:actor,is_bot:false},data,
 message:{message_id:57,chat:{id:group?-100123:actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}
}});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-staff-inline-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'test.sqlite':'test.json'),{engine});
 let now=1700000000000;
 const policy=new Policy(store,OWNER,()=>now),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
 botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',clock:()=>now});
 return {store,policy,app,now:()=>now,advance:(delta:number)=>{now+=delta},
 close:()=>rm(dir,{recursive:true,force:true})};
}
test('staff callback routes accept only canonical bounded selectors',()=>{
 assert.deepEqual(staffInlineRoute('ms:1:h'),{kind:'list',page:0});
 assert.deepEqual(staffInlineRoute('ms:1:p:2'),{kind:'list',page:2});
 assert.deepEqual(staffInlineRoute('ms:1:g:-100123:4:2'),
  {kind:'detail',chatId:'-100123',version:4,page:2});
 for(const bad of ['ms:1:p:00','ms:1:p:1000','ms:1:p:-1',
  'ms:1:g:100123:4:2','ms:1:g:-100123:0:2',
  'ms:1:g:-100123:04:2','ms:1:g:-100123:4:02',
  'ms:1:g:-100123:4:2:ban','ms:1:g:-100123:4:2\n',
  'ms:1:p:0\n','ms:2:h','mi:1:h','ms:1:x',
  'ms:1:g:-'+('9'.repeat(30))+':1:0'])
   assert.equal(staffInlineRoute(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('staff with scoped local moderation grant can browse ONLY approved authorized group ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['navigation','moderation']);
   await f.policy.approveChat(OWNER,'-100234',['moderation']);
   await f.policy.approveChat(OWNER,'-100345',['navigation','moderation']);
   await f.policy.grant(OWNER,STAFF,'chat.manage',CHAT,f.now()+60000);
   await f.policy.grant(OWNER,STAFF,'ai.ask','-100345',f.now()+60000);
   const home=await f.app().handle(msg(1,301,'/staffinline'));
   assert.equal(home.status,'APPLIED');
   assert.match(home.plan?.text??'',/المشرف|التفويض/);
   assert.equal(isValidTelegramInlineKeyboard(home.plan?.inlineMarkup),true);
   const groups=buttons(home).filter(b=>b.callback_data.startsWith('ms:1:g:'));
   assert.equal(groups.length,1);
   assert.match(groups[0]!.callback_data,/ms:1:g:-100123:/);
   assert.equal((await f.store.snapshot()).moderationOperations.length,0);
   const detail=await f.app().handle(cb(2,301,groups[0]!.callback_data));
   assert.equal(detail.status,'APPLIED');
   assert.equal(detail.plan?.editMessageId,57);
   assert.match(detail.plan?.text??'',/داخل منارتك|محلي/);
   assert.match(detail.plan?.text??'',/لا.*Telegram|ليست.*Telegram/);
   assert.equal(buttons(detail).some(b=>b.callback_data==='ms:1:p:0'),true);
   assert.equal(buttons(detail).some(b=>b.callback_data==='ms:1:h'),true);
   assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason.includes('MODERATION')).length,0);
  }finally{await f.close();}
 });
 test('student and insufficiently authorized staff get no menu or callback data ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['moderation']);
   await f.policy.grant(OWNER,STAFF,'ai.ask',CHAT,f.now()+60000);
   assert.equal((await f.app().handle(msg(10,301,'/staffinline'))).status,'DENIED');
   assert.equal((await f.app().handle(msg(11,200,'/staffinline'))).status,'DENIED');
   for(const actor of [200,301]){
    const result=await f.app().handle(cb(20+actor,actor,'ms:1:h'));
    assert.equal(result.status,'DENIED');
    assert.equal(result.plan,undefined);
   }
   assert.equal((await f.app().handle(cb(40,301,'mi:1:h'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(41,301,'c_'+'a'.repeat(24)))).status,'DENIED');
   assert.equal((await f.app().handle(cb(42,301,'ms:1:h',true))).status,'DENIED');
  }finally{await f.close();}
 });
 test('revocation, expiration and lost group moderation scope deny old callback ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['moderation']);
   await f.policy.grant(OWNER,STAFF,'chat.manage',CHAT,f.now()+5000);
   const opened=await f.app().handle(msg(100,301,'/staffinline'));
   const token=buttons(opened).find(x=>x.callback_data.startsWith('ms:1:g:'))!.callback_data;
   await f.policy.revokeGrant(OWNER,STAFF,'chat.manage',CHAT);
   assert.equal((await f.app().handle(cb(101,301,token))).status,'DENIED');
   assert.equal((await f.app().handle(cb(102,301,'ms:1:h'))).status,'DENIED');
   await f.policy.grant(OWNER,STAFF,'chat.manage',CHAT,f.now()+3000);
   const newHome=await f.app().handle(msg(103,301,'/staffinline'));
   assert.equal(newHome.status,'APPLIED');
   f.advance(4000);
   assert.equal((await f.app().handle(cb(104,301,token))).status,'DENIED');
   // Test a fresh active grant on another chat and then remove its moderation scope.
   await f.policy.approveChat(OWNER,'-100234',['moderation']);
   await f.policy.grant(OWNER,STAFF,'chat.manage','-100234',f.now()+30000);
   const after=await f.app().handle(msg(105,301,'/staffinline'));
   const item=buttons(after).find(x=>x.callback_data.includes('-100234:'))!.callback_data;
   const beforeVersion=(await f.store.snapshot()).chats.find(c=>c.id==='-100234')!.version;
   await f.policy.restrictChatScopeAtRevision(OWNER,'-100234','moderation',beforeVersion);
   assert.equal((await f.app().handle(cb(106,301,item))).status,'DENIED');
  }finally{await f.close();}
 });
 test('staff paging shows 8 groups at a time and stale page membership never leaks another group ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<18;i++){
    const id='-100'+String(1000+i);
    await f.policy.approveChat(OWNER,id,['moderation']);
    await f.policy.grant(OWNER,STAFF,'chat.manage',id,f.now()+60000);
   }
   const home=await f.app().handle(msg(200,301,'/staffinline'));
   assert.equal(buttons(home).filter(b=>b.callback_data.startsWith('ms:1:g:')).length,8);
   const middle=await f.app().handle(cb(201,301,'ms:1:p:1'));
   assert.equal(buttons(middle).filter(b=>b.callback_data.startsWith('ms:1:g:')).length,8);
   const last=await f.app().handle(cb(202,301,'ms:1:p:2'));
   assert.equal(buttons(last).filter(b=>b.callback_data.startsWith('ms:1:g:')).length,2);
   assert.equal((await f.app().handle(cb(203,301,'ms:1:p:3'))).status,'DENIED');
   const old=buttons(middle).find(b=>b.callback_data.startsWith('ms:1:g:'))!.callback_data;
   await f.policy.approveChat(OWNER,'-1000999',['moderation']);
   await f.policy.grant(OWNER,STAFF,'chat.manage','-1000999',f.now()+60000);
   assert.equal((await f.app().handle(cb(204,301,old))).status,'DENIED');
  }finally{await f.close();}
 });
 test('owner can access staff view without delegating but still requires an approved moderation scope ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.app().handle(msg(300,100,'/staffinline'))).status,'DENIED');
   await f.policy.approveChat(OWNER,CHAT,['moderation']);
   const out=await f.app().handle(msg(301,100,'/staffinline'));
   assert.equal(out.status,'APPLIED');
   assert.equal(buttons(out).filter(b=>b.callback_data.startsWith('ms:1:g:')).length,1);
   assert.equal((await f.app().handle(cb(302,100,'mi:1:h'))).status,'APPLIED');
  }finally{await f.close();}
 });
 test('duplicate callback is ACK-able but does not queue a second edit ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['moderation']);
   await f.policy.grant(OWNER,STAFF,'chat.manage',CHAT,f.now()+10000);
   const request=cb(500,301,'ms:1:h');
   const a=await f.app().handle(request),b=await f.app().handle(request);
   assert.equal(a.status,'APPLIED');assert.equal(b.status,'DUPLICATE');
   assert.equal(b.callbackQueryId,'staff_500');assert.equal(b.plan,undefined);
  }finally{await f.close();}
 });
}
