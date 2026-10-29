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
import {TelegramBotApiTextSender,TelegramBotApiCallbackAcker} from '../src/telegram-replies.js';
import {ownerInlineHome,ownerInlineRender,ownerInlineSections,isValidTelegramInlineKeyboard,ownerInlineLinkedReadOnly} from '../src/telegram-inline-owner.js';

import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const message=(updateId:number,actor:number,text:string)=>({
 update_id:updateId,message:{message_id:updateId,chat:{id:actor,type:'private'},
 from:{id:actor,is_bot:false},text}
});
const callback=(updateId:number,actor:number,data:string,group=false)=>({
 update_id:updateId,callback_query:{id:'cb_'+updateId,from:{id:actor,is_bot:false},data,
 message:{message_id:55,chat:{id:group?-100123:actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}}
});
const buttons=(screen:{keyboard:{inline_keyboard:readonly (readonly {text:string;callback_data:string}[])[]}})=>
 screen.keyboard.inline_keyboard.flat();
async function fixture(engine:'json'|'sqlite'='json',inlineDefault=false){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-inline-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,'100'),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const migrationOptions=inlineDefault?{ownerMenuMode:'inline' as const}:{};
 const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,...migrationOptions,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {store,app,close:()=>rm(dir,{recursive:true,force:true})};
}
test('inline spec mirrors the 16 owner sections and all 253 approved subordinate labels',()=>{
 assert.equal(ownerInlineSections.length,16);
 assert.deepEqual(ownerInlineSections.map(s=>s.items.length),
  [12,16,16,16,16,17,16,16,16,16,16,16,16,16,16,16]);
 assert.equal(ownerInlineSections.reduce((sum,s)=>sum+s.items.length,0),253);
 assert.equal(ownerInlineSections[0]?.title,'👥 المجموعات والشبكات');
 assert.equal(ownerInlineSections[9]?.items[2],'🩺 التخصصات الدراسية');
 assert.equal(ownerInlineSections[15]?.items[15],'⚙️ إجراءات التشغيل');
});
test('owner inline home and section pagination are strict bounded Telegram markups',()=>{
 const home=ownerInlineHome();
 assert.equal(isValidTelegramInlineKeyboard(home.keyboard),true);
 assert.equal(buttons(home).filter(b=>/^mi:1:s:/.test(b.callback_data)).length,8);
 const second=ownerInlineRender('mi:1:p:1');
 assert.ok(second);assert.equal(buttons(second).filter(b=>/^mi:1:s:/.test(b.callback_data)).length,8);
 for(let n=1;n<=16;n++){
  const key=String(n).padStart(2,'0');
  const section=ownerInlineRender('mi:1:s:'+key+':0');
  assert.ok(section);
  assert.equal(isValidTelegramInlineKeyboard(section.keyboard),true);
  const items=buttons(section).filter(b=>/^mi:1:i:/.test(b.callback_data));
  assert.equal(items.length,8);
  assert.ok(ownerInlineRender('mi:1:i:'+key+':01'));
 }
 for(const bad of ['mi:1:p:2','mi:1:p:01','mi:1:s:00:0','mi:1:s:01:3',
   'mi:1:i:01:13','mi:1:i:01:00','mi:1:p:0:extra','mi:1:i:99:01',
   'mi:1:h\n','mi:1:s:01:-1','mi:2:h'])assert.equal(ownerInlineRender(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('inline mode opens approved owner dashboard from existing button and preserves legacy tools ('+engine+')',async()=>{
  const f=await fixture(engine,true);try{
   const opened=await f.app.handle(message(200,100,'🔐 لوحة المالك'));
   assert.equal(opened.status,'APPLIED');
   assert.equal(isValidTelegramInlineKeyboard(opened.plan?.inlineMarkup),true);
   assert.equal(opened.plan?.replyMarkup,undefined);
   const legacy=await f.app.handle(message(201,100,'/ownerlegacy'));
   assert.equal(legacy.status,'APPLIED');
   assert.ok(legacy.plan?.replyMarkup);
   let updateId=202;
   for(const command of ['🔐 لوحة المالك','/ownerlegacy','/ownerinline'])
    assert.equal((await f.app.handle(message(updateId++,300,command))).status,'DENIED');
  }finally{await f.close();}
 });
 test('start explains how to open transparent menus without exposing owner entry to students ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const owner=await f.app.handle(message(100,100,'/start'));
   assert.match(owner.plan?.text??'',/\/ownerinline/);
   assert.match(owner.plan?.text??'',/\/studentinline/);
   const student=await f.app.handle(message(101,300,'/start'));
   assert.match(student.plan?.text??'',/\/studentinline/);
   assert.doesNotMatch(student.plan?.text??'',/\/ownerinline/);
  }finally{await f.close();}
 });
 test('inline callback re-authorizes owner every time and does not execute admin action ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const opened=await f.app.handle(message(1,100,'/ownerinline'));
   assert.equal(opened.status,'APPLIED');
   assert.equal(isValidTelegramInlineKeyboard(opened.plan?.inlineMarkup),true);
   const next=await f.app.handle(callback(2,100,'mi:1:p:1'));
   assert.equal(next.status,'APPLIED');
   assert.equal(next.callbackQueryId,'cb_2');
   assert.equal(next.plan?.editMessageId,55);
   assert.match(next.plan?.text??'',/الصفحة الثانية/);
   const section=await f.app.handle(callback(3,100,'mi:1:s:10:0'));
   assert.equal(section.status,'APPLIED');
   assert.match(section.plan?.text??'',/التعليم والمكتبة/);
   const item=await f.app.handle(callback(4,100,'mi:1:i:10:03'));
   assert.equal(item.status,'APPLIED');
   assert.match(item.plan?.text??'',/التخصصات الدراسية/);
   assert.match(item.plan?.text??'',/غير مفع/);
   assert.equal((await f.store.snapshot()).educationResources.length,0);
   assert.equal((await f.app.handle(callback(4,100,'mi:1:i:10:03'))).status,'DUPLICATE');
   const intruder=await f.app.handle(callback(5,300,'mi:1:p:0'));
   assert.equal(intruder.status,'DENIED');
   assert.equal(intruder.callbackQueryId,'cb_5');
   assert.equal(intruder.plan,undefined);
   assert.equal((await f.app.handle(callback(6,100,'mi:1:s:01:0',true))).status,'DENIED');
   assert.equal((await f.app.handle(callback(7,100,'mi:1:s:99:0'))).status,'DENIED');
   const old=await f.app.handle(message(8,100,'🔐 لوحة المالك'));
   assert.equal(old.status,'APPLIED');assert.ok(old.plan?.replyMarkup);
  }finally{await f.close();}
 });
}
test('inline Bot API serialization uses the fixed inline markup and never calls Telegram for invalid markup',async()=>{
 const calls:Record<string,unknown>[]=[];
 const sender=new TelegramBotApiTextSender(TOKEN,async(_url,init)=>{
  const b=JSON.parse(String(init?.body)) as Record<string,unknown>;
  calls.push(b);
  return new Response(JSON.stringify({ok:true,result:{message_id:3,chat:{id:100}}}),{status:200});
 });
 const screen=ownerInlineHome();
 assert.equal((await sender.send({chatId:'100',parseMode:'HTML',text:screen.text,inlineMarkup:screen.keyboard})).status,'CONFIRMED');
 assert.equal(((calls[0]?.reply_markup as Record<string,unknown>)?.inline_keyboard as unknown[]).length>0,true);
 assert.equal(calls[0]?.reply_markup!==undefined,true);
 assert.equal((await sender.send({chatId:'100',parseMode:'HTML',text:'x',
  inlineMarkup:{inline_keyboard:[[{text:'x',callback_data:'a'.repeat(65)}]]}})).status,'FAILED_CONFIRMED');
 assert.equal(calls.length,1);
});
test('inline callback edits only its own verified message and rejects conflicting markup',async()=>{
 let url='',body:Record<string,unknown>={};
 const sender=new TelegramBotApiTextSender(TOKEN,async(u,init)=>{
  url=String(u);body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  return new Response(JSON.stringify({ok:true,result:{message_id:55,chat:{id:100}}}),{status:200});
 });
 const view=ownerInlineHome();
 assert.deepEqual(await sender.send({chatId:'100',parseMode:'HTML',text:view.text,
  inlineMarkup:view.keyboard,editMessageId:55}),{status:'CONFIRMED',messageId:55});
 assert.match(url,/editMessageText$/);
 assert.equal(body.message_id,55);
 assert.equal(body.protect_content,undefined);
 assert.equal(body.reply_markup!==undefined,true);
 assert.deepEqual(await sender.send({chatId:'100',parseMode:'HTML',text:'x',
  replyMarkup:{keyboard:[[{text:'x'}]],resize_keyboard:true,is_persistent:true},
  inlineMarkup:view.keyboard,editMessageId:55}),{status:'FAILED_CONFIRMED'});
});
test('callback acknowledgement validates IDs and never reports false success',async()=>{
 const requests:string[]=[];
 const acker=new TelegramBotApiCallbackAcker(TOKEN,async(url,init)=>{
  requests.push(String(url));
  const body=JSON.parse(String(init?.body)) as Record<string,string>;
  assert.equal(body.callback_query_id,'cb_77');
  return new Response(JSON.stringify({ok:true,result:true}),{status:200});
 });
 await acker.answer('cb_77');
 await acker.answer('unsafe\nquery');
 assert.equal(requests.length,1);
 assert.match(requests[0]??'',/answerCallbackQuery$/);
});

test('linked owner inline read-only actions are exact documented selectors',()=>{
 const linked:readonly (readonly [string,string])[]=[
  ['mi:1:i:01:01',ownerMenuLabels.groups],
  ['mi:1:i:04:05',ownerMenuLabels.subscriptionHealth],
  ['mi:1:i:10:08',ownerMenuLabels.faq],
  ['mi:1:i:10:09',ownerMenuLabels.library],
  ['mi:1:i:13:01',ownerMenuLabels.delivery],
  ['mi:1:i:15:01',ownerMenuLabels.settings]
 ];
 for(const [callbackData,route] of linked)
  assert.equal(ownerInlineLinkedReadOnly(callbackData),route);
 for(const bad of ['mi:1:p:0','mi:1:i:02:02','mi:1:i:04:04','mi:1:i:10:07',
  'mi:1:i:13:02','mi:1:i:15:02','mi:1:i:13:01x','mi:2:i:13:01'])
  assert.equal(ownerInlineLinkedReadOnly(bad),null);
});
test('owner inline live local read-only views reuse existing authorization and audited state',async()=>{
 const f=await fixture('sqlite');try{
  let id=100;
  for(const [data,content] of [
   ['mi:1:i:01:01',/المجموعات/],
   ['mi:1:i:04:05',/سلامة قواعد الاشتراك/],
   ['mi:1:i:10:08',/الأسئلة/],
   ['mi:1:i:10:09',/المكتبة/],
   ['mi:1:i:13:01',/حالة الرسائل/],
   ['mi:1:i:15:01',/إعدادات التشغيل/],
  ] as const){
   const outcome=await f.app.handle(callback(++id,100,data));
   assert.equal(outcome.status,'APPLIED',data);
   assert.match(outcome.plan?.text??'',content,data);
   assert.equal(outcome.plan?.editMessageId,55);
   assert.equal(isValidTelegramInlineKeyboard(outcome.plan?.inlineMarkup),true);
   const refused=await f.app.handle(callback(++id,300,data));
   assert.equal(refused.status,'DENIED');
   assert.equal(refused.plan,undefined);
  }
  assert.equal((await f.store.snapshot()).educationResources.length,0);
 }finally{await f.close();}
});
