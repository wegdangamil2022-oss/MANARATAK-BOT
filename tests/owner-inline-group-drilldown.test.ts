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
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {parseOwnerInlineGroupRoute} from '../src/telegram-inline-groups.js';

const OWNER='100', GROUP='-100123';
const cb=(update:number,actor:number,data:string,kind:'private'|'supergroup'='private')=>({
 update_id:update,callback_query:{
  id:'group_'+update,from:{id:actor,is_bot:false},data,
  message:{message_id:57,chat:{id:kind==='private'?actor:Number(GROUP),type:kind},
   from:{id:999,is_bot:true}}
 }
});
const msg=(update:number,text:string)=>({
 update_id:update,message:{message_id:update,chat:{id:100,type:'private'},
 from:{id:100,is_bot:false},text}
});
const buttons=(response:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 response.plan?.inlineMarkup?.inline_keyboard.flat()??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-inline-groups-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {store,policy,app,close:()=>rm(dir,{recursive:true,force:true})};
}
test('group callback grammar is canonical, bounded, versioned, and read-only',()=>{
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:p:0'),{kind:'list',page:0});
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:d:-100123:4:0'),
  {kind:'details',chatId:'-100123',version:4,page:0});
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:u:-100123:4:2'),
  {kind:'subscription',chatId:'-100123',version:4,page:2});
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:a:-100123:4:2'),
  {kind:'access',chatId:'-100123',version:4,page:2});
 for(const invalid of ['mi:1:g:p:01','mi:1:g:p:1000','mi:1:g:d:-100123:0:0',
  'mi:1:g:d:-100123:04:0','mi:1:g:d:-100123:1:01','mi:1:g:d:-0:1:0',
  'mi:1:g:d:100123:1:0','mi:1:g:d:-100123:1:1000',
  'mi:1:g:d:-100123:1:0:confirm','mi:1:g:x:-100123:1:0',
  'mi:1:g:d:-100123:1:0\n','mi:1:g:p:-1','mi:2:g:p:0',
  'mi:1:g:d:-'+('9'.repeat(30))+':1:0']){
  assert.equal(parseOwnerInlineGroupRoute(invalid),null,invalid);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('inline approved groups: first page, details, local scopes/subscriptions and navigation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','assistant','moderation','verification']);
   await f.policy.setPresence(GROUP,true);
   await f.policy.configureGroupAI(OWNER,GROUP,'OWNER_MENTION');
   const version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   const list=await f.app().handle(cb(1,100,'mi:1:i:01:01'));
   assert.equal(list.status,'APPLIED');
   assert.match(list.plan?.text??'',/المجموعات المعتمدة/);
   assert.match(list.plan?.text??'',/محفوظ/);
   assert.equal(isValidTelegramInlineKeyboard(list.plan?.inlineMarkup),true);
   const detailsButton=buttons(list).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!;
   assert.equal(detailsButton.callback_data,'mi:1:g:d:'+GROUP+':'+version+':0');
   const detail=await f.app().handle(cb(2,100,detailsButton.callback_data));
   assert.equal(detail.status,'APPLIED');
   assert.equal(detail.plan?.editMessageId,57);
   assert.match(detail.plan?.text??'',/navigation/);
   assert.match(detail.plan?.text??'',/OWNER_MENTION/);
   assert.match(detail.plan?.text??'',/لا.*تحقق حي/);
   const accessButton=buttons(detail).find(b=>b.callback_data.startsWith('mi:1:g:a:'))!;
   const access=await f.app().handle(cb(3,100,accessButton.callback_data));
   assert.equal(access.status,'APPLIED');
   assert.match(access.plan?.text??'',/moderation/);
   const subsButton=buttons(detail).find(b=>b.callback_data.startsWith('mi:1:g:u:'))!;
   const subs=await f.app().handle(cb(4,100,subsButton.callback_data));
   assert.equal(subs.status,'APPLIED');
   assert.match(subs.plan?.text??'',/الاشتراك/);
   assert.equal(buttons(subs).some(b=>b.callback_data===detailsButton.callback_data),true);
   const back=buttons(detail).find(b=>b.callback_data==='mi:1:g:p:0')!;
   const returned=await f.app().handle(cb(5,100,back.callback_data));
   assert.equal(returned.status,'APPLIED');
   assert.match(returned.plan?.text??'',/المجموعات المعتمدة/);
   assert.equal((await f.store.snapshot()).chats.find(c=>c.id===GROUP)?.approved,true);
   assert.equal((await f.store.snapshot()).chats.find(c=>c.id===GROUP)?.version,version);
  }finally{await f.close();}
 });
 test('inline group pagination survives 19 groups, rejects out-of-range and stale page members ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<19;i++)
    await f.policy.approveChat(OWNER,'-100'+String(1000+i),['navigation']);
   const first=await f.app().handle(cb(20,100,'mi:1:i:01:01'));
   assert.equal(buttons(first).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,8);
   const p1=await f.app().handle(cb(21,100,'mi:1:g:p:1'));
   assert.equal(p1.status,'APPLIED');
   assert.equal(buttons(p1).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,8);
   const p2=await f.app().handle(cb(22,100,'mi:1:g:p:2'));
   assert.equal(p2.status,'APPLIED');
   assert.equal(buttons(p2).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,3);
   const chosen=buttons(p2).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!;
   const shifted=buttons(p1).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).at(-1)!;
   assert.equal((await f.app().handle(cb(23,100,chosen.callback_data))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(24,100,'mi:1:g:p:3'))).status,'DENIED');
   const wrongPage=chosen.callback_data.replace(/:2$/u,':0');
   assert.equal((await f.app().handle(cb(25,100,wrongPage))).status,'DENIED');
   // A newly approved chat can move the selected group out of its old page.
   await f.policy.approveChat(OWNER,'-1000999',['navigation']);
   assert.equal((await f.app().handle(cb(26,100,shifted.callback_data))).status,'DENIED');
  }finally{await f.close();}
 });
 test('inline group details fail closed after policy changes, revocation and foreign scope ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','verification']);
   const list=await f.app().handle(cb(30,100,'mi:1:g:p:0'));
   const original=buttons(list).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!;
   assert.equal((await f.app().handle(cb(31,200,original.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(cb(32,300,original.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(cb(33,100,original.callback_data,'supergroup'))).status,'DENIED');
   const originalVersion=(await f.store.snapshot()).chats[0]!.version;
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.app().handle(cb(34,100,original.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(cb(35,100,original.callback_data.replace(':d:',':a:')))).status,'DENIED');
   assert.equal((await f.app().handle(cb(36,100,original.callback_data.replace(':d:',':u:')))).status,'DENIED');
   const next=await f.app().handle(cb(37,100,'mi:1:g:p:0'));
   const fresh=buttons(next).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!;
   assert.notEqual(fresh.callback_data,original.callback_data);
   await f.policy.revokeChatAtRevision(OWNER,GROUP,originalVersion+1);
   assert.equal((await f.app().handle(cb(38,100,fresh.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(cb(39,100,'mi:1:g:p:0'))).status,'APPLIED');
   assert.equal(buttons(await f.app().handle(cb(40,100,'mi:1:g:p:0'))).some(b=>b.callback_data.startsWith('mi:1:g:d:')),false);
  }finally{await f.close();}
 });
}
test('inline group empty state has safe way back and no fake action',async()=>{
 const f=await fixture('sqlite');try{
  const r=await f.app().handle(msg(51,'/ownerinline'));
  assert.equal(r.status,'APPLIED');
  const list=await f.app().handle(cb(52,100,'mi:1:i:01:01'));
  assert.equal(list.status,'APPLIED');
  assert.match(list.plan?.text??'',/لا توجد/);
  assert.equal(buttons(list).some(b=>b.callback_data==='mi:1:s:01:0'),true);
  assert.equal(buttons(list).some(b=>b.callback_data==='mi:1:h'),true);
  assert.equal(buttons(list).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,0);
  assert.equal((await f.app().handle(cb(53,100,'mi:1:g:p:1'))).status,'DENIED');
 }finally{await f.close();}
});
test('duplicate Telegram callback is acknowledged but is not reprocessed',async()=>{
 const f=await fixture('json');try{
  await f.policy.approveChat(OWNER,GROUP,['navigation']);
  const input=cb(61,100,'mi:1:g:p:0');
  const first=await f.app().handle(input);
  const same=await f.app().handle(input);
  assert.equal(first.status,'APPLIED');
  assert.equal(same.status,'DUPLICATE');
  assert.equal(same.callbackQueryId,'group_61');
  assert.equal(same.plan,undefined);
 }finally{await f.close();}
});
