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
import {TelegramReplyDispatcher,TelegramBotApiTextSender} from '../src/telegram-replies.js';
import {EducationCategoryEditor} from '../src/education-category-editor.js';
import {validTopicVisibility,visibleEducationCategory} from '../src/education-category-policy.js';
import type {SubscriptionGate} from '../src/subscription.js';
const NOW=1700000000000,GROUP=-100123;
const msg=(id:number,text='/categories',topic?:number)=>({update_id:id,message:{message_id:id,from:{id:300,is_bot:false},chat:{id:GROUP,type:'supergroup'},text,...(topic===undefined?{}:{message_thread_id:topic})}});
const cb=(id:number,data:string,actor=300,chat=GROUP,topic?:number)=>({update_id:id,callback_query:{id:'group-library-'+id,from:{id:actor,is_bot:false},message:{message_id:55,from:{id:999,is_bot:true},chat:{id:chat,type:chat<0?'supergroup':'private'},...(topic===undefined?{}:{message_thread_id:topic})},data}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(r:Result)=>r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const choose=(r:Result,text:string)=>{const b=buttons(r).find(b=>b.text===text);assert.ok(b,text);return b.callback_data;};
test('topic reply gateway sends into the specified thread and verifies the returned thread',async()=>{
 let calls=0,last:Record<string,unknown>={},echo=7;
 const sender=new TelegramBotApiTextSender('123456:'+'A'.repeat(35),async(input,init)=>{calls++;last=JSON.parse(String(init?.body));if(last.message_id!==undefined)assert.ok(String(input).endsWith('/editMessageText'));return new Response(JSON.stringify({ok:true,result:{message_id:55,message_thread_id:echo,chat:{id:GROUP}}}),{status:200});});
 const plan={chatId:String(GROUP),parseMode:'HTML' as const,text:'مكتبة الموضوع',messageThreadId:7,inlineMarkup:{inline_keyboard:[[{text:'الأقسام',callback_data:'gl:1:'+'A'.repeat(24)}]]}};
 assert.equal((await sender.send(plan)).status,'CONFIRMED');assert.equal(last.message_thread_id,7);
 assert.equal((await sender.send({...plan,editMessageId:55})).status,'CONFIRMED');assert.equal(last.message_thread_id,undefined);assert.equal(last.message_id,55);
 echo=8;assert.equal((await sender.send(plan)).status,'UNKNOWN_OUTCOME');const count=calls;assert.equal((await sender.send({...plan,chatId:'300'})).status,'FAILED_CONFIRMED');assert.equal(calls,count);
 for(const value of [[{topicId:7,enabled:true},{topicId:7,enabled:false}],[{topicId:0,enabled:true}],[{topicId:7,enabled:'true'}]])assert.equal(validTopicVisibility(value),false);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'group-library-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);
  await policy.approveChat('100',String(GROUP),['navigation','verification']);await policy.approveChat('100','-100456',['navigation']);
  for(let i=0;i<10;i++)await education.createCategory('100',{id:'c'+i,scope:String(GROUP),title:'قسم '+i,order:i});
  await education.createCategory('100',{id:'private',scope:'private',title:'PRIVATE_ONLY',order:0});
  await store.transaction(s=>{for(let i=0;i<10;i++)s.educationResources.push({id:'r'+i,categoryId:'c9',scope:String(GROUP),title:'مورد '+i+' <موثق>',university:'جامعة',cycle:'2026',degree:'بكالوريوس',seats:3,sourceImportId:'SECRET_IMPORT',sourceLocator:'SECRET_LOCATOR',reviewedBy:'SECRET_REVIEWER',status:'PUBLISHED'});});
  const app=(subscription?:SubscriptionGate)=>new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),clock:()=>now,botId:'group-library',botUsername:'ManaratakBot',...(subscription?{subscription}:{}),membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  return {store,policy,app,time:(value:number)=>{now=value;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' approved group catalogue paginates and returns by editing the same message without exposing private metadata',async()=>{
  const f=await fixture();try{
   const original=await f.store.snapshot();let screen=await f.app().handle(msg(1)),id=2;assert.equal(screen.status,'APPLIED');assert.equal(screen.plan!.replyMarkup,undefined);assert.equal(screen.plan!.editMessageId,undefined);assert.equal(buttons(screen).some(b=>b.text==='PRIVATE_ONLY'),false);
   screen=await f.app().handle(cb(id++,choose(screen,'التالي')));assert.equal(screen.plan!.editMessageId,55);assert.ok(screen.plan!.text.includes('الصفحة 2 من 2'));
   screen=await f.app().handle(cb(id++,choose(screen,'قسم 9')));assert.ok(screen.plan!.text.includes('الصفحة 1 من 2'));assert.ok(screen.plan!.text.includes('&lt;موثق&gt;'));
   screen=await f.app().handle(cb(id++,choose(screen,'التالي')));const selected=choose(screen,'مورد 8 <موثق>');screen=await f.app().handle(cb(id++,selected));assert.equal(screen.status,'APPLIED');assert.equal(screen.plan!.editMessageId,55);assert.ok(screen.plan!.text.includes('العنوان: مورد 8 &lt;موثق&gt;'));
   for(const secret of ['SECRET_IMPORT','SECRET_LOCATOR','SECRET_REVIEWER','PRIVATE_ONLY'])assert.equal(screen.plan!.text.includes(secret),false);
   assert.ok(buttons(screen).every(b=>Buffer.byteLength(b.callback_data)<=64));assert.ok(Buffer.byteLength(screen.plan!.text)<=4096);
   screen=await f.app().handle(cb(id++,choose(screen,'↩️ موارد القسم')));assert.ok(screen.plan!.text.includes('الصفحة 2 من 2'));
   screen=await f.app().handle(cb(id++,choose(screen,'↩️ الأقسام')));assert.ok(screen.plan!.text.includes('الصفحة 2 من 2'));
   const after=await f.store.snapshot();assert.deepEqual(after.educationResources,original.educationResources);assert.deepEqual(after.educationCategories,original.educationCategories);assert.equal(after.deliveries.length,0);
   assert.equal((await f.app().handle(msg(id++,'/resources c9'))).status,'APPLIED');
  }finally{await f.close();}
 });
 test(engine+' group callbacks reject other actors/chats, private copies, topics, stale state and expired references',async()=>{
  const f=await fixture();try{
   const screen=await f.app().handle(msg(20)),route=choose(screen,'قسم 0');
   for(const [id,actor,chat,topic] of [[21,301,GROUP,undefined],[22,300,-100456,undefined],[23,300,300,undefined],[24,300,GROUP,7]] as const)assert.equal((await f.app().handle(cb(id,route,actor,chat,topic))).status,'DENIED');
   assert.equal((await f.app().handle(msg(25,'/categories',7))).status,'DENIED');
   const ref='group-library:'+route.slice(5),record=(await f.store.snapshot()).callbacks.find(c=>c.ref===ref)!;
   await f.store.transaction(s=>{s.callbacks.push({...record});});assert.equal((await f.app().handle(cb(26,route))).status,'DENIED');
   await f.store.transaction(s=>{s.callbacks=s.callbacks.filter(c=>c.ref!==ref);s.callbacks.push({...record});s.educationCategories.find(c=>c.id==='c0')!.enabled=false;});assert.equal((await f.app().handle(cb(27,route))).status,'DENIED');
   const fresh=await f.app().handle(msg(28)),expires=choose(fresh,'قسم 1');f.time(NOW+120000);assert.equal((await f.app().handle(cb(29,expires))).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' every group tap rechecks membership and detects policy changes during verification',async()=>{
  const f=await fixture();try{
   await f.policy.approveChat('100','-100789',['verification']);await f.store.transaction(s=>{s.subscriptionRequirements.push({chatId:String(GROUP),channelIds:['-100789'],mode:'ALL',version:1});});
   let calls=0,status='MEMBER',mutate=false;
   const gate={verify:async()=>{calls++;if(mutate)await f.policy.revokeChat('100',String(GROUP));return {status,channels:[]};}} as unknown as SubscriptionGate;
   const screen=await f.app(gate).handle(msg(40)),route=choose(screen,'قسم 0');assert.equal(calls,1);
   assert.equal((await f.app(gate).handle(cb(41,route,301))).status,'DENIED');assert.equal(calls,1);
   status='NOT_MEMBER';assert.equal((await f.app(gate).handle(cb(42,route))).reason,'SUBSCRIPTION_REQUIRED');assert.equal(calls,2);
   status='NOT_REQUIRED';assert.equal((await f.app(gate).handle(cb(43,route))).reason,'SUBSCRIPTION_UNAVAILABLE');
   status='MEMBER';mutate=true;assert.equal((await f.app(gate).handle(cb(44,route))).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' queued group inline edits are withheld after content withdrawal or approval loss',async()=>{
  const f=await fixture();try{
   let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},()=>NOW);
   const list=await f.app().handle(msg(60));assert.equal((await dispatcher.dispatch(list.deliveryKey!)).status,'CONFIRMED');
   const next=await f.app().handle(cb(61,choose(list,'التالي')));await f.store.transaction(s=>{s.educationResources.find(r=>r.id==='r0')!.status='ARCHIVED';});assert.equal((await dispatcher.dispatch(next.deliveryKey!)).status,'FAILED_CONFIRMED');
   const current=await f.app().handle(msg(62));await f.policy.revokeChat('100',String(GROUP));assert.equal((await dispatcher.dispatch(current.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
  }finally{await f.close();}
 });
 test(engine+' topic visibility defaults closed, persists independently and fences callbacks and queued destinations',async()=>{
  const f=await fixture();try{
   assert.equal((await f.app().handle(msg(80,'/categories',7))).status,'DENIED');
   const editor=new EducationCategoryEditor(f.store,f.policy,()=>NOW);await assert.rejects(editor.begin('100','TOPIC','private',0));
   await editor.begin('100','TOPIC','c0',0);const review=await editor.preview('100','٧ تفعيل');assert.ok(review);assert.ok(review.name.includes('الموضوع 7'));assert.equal((await f.app().handle(msg(81,'/categories',7))).status,'DENIED');
   await editor.confirm('100',review.ref);const disk=await new BotStore(f.store.file,{engine}).snapshot();assert.deepEqual(disk.educationCategories.find(c=>c.id==='c0')!.topicVisibility,[{topicId:7,enabled:true}]);
   await editor.begin('100','GENERAL','c0',0);const generalOff=await editor.preview('100','إيقاف');await editor.confirm('100',generalOff!.ref);assert.equal((await f.app().handle(msg(90,'/resources c0'))).status,'DENIED');
   const list=await f.app().handle(msg(82,'/categories',7));assert.equal(list.status,'APPLIED');assert.equal(list.plan!.messageThreadId,7);assert.equal(buttons(list).filter(b=>b.text.startsWith('قسم ')).length,1);const route=choose(list,'قسم 0');
   assert.equal((await f.app().handle(cb(83,route,300,GROUP,8))).status,'DENIED');assert.equal((await f.app().handle(cb(84,route))).status,'DENIED');
   const opened=await f.app().handle(cb(85,route,300,GROUP,7));assert.equal(opened.status,'APPLIED');assert.equal(opened.plan!.editMessageId,55);assert.equal(opened.plan!.messageThreadId,7);
   const general=await f.app().handle(msg(86));assert.equal(general.status,'APPLIED');assert.equal(buttons(general).some(b=>b.text==='قسم 0'),false);assert.equal((await f.app().handle(msg(87,'/categories',8))).status,'DENIED');
   let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},()=>NOW);
   await f.store.transaction(s=>{s.telegramReplyJobs!.find(j=>j.updateKey===list.deliveryKey)!.plan!.messageThreadId=8;});assert.equal((await dispatcher.dispatch(list.deliveryKey!)).status,'FAILED_CONFIRMED');
   await editor.begin('100','TOPIC','c0',0);const off=await editor.preview('100','7 إيقاف');await editor.confirm('100',off!.ref);assert.equal((await dispatcher.dispatch(opened.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,0);assert.equal((await f.app().handle(cb(88,route,300,GROUP,7))).status,'DENIED');
   assert.equal((await f.app().handle(msg(89))).status,'APPLIED');
  }finally{await f.close();}
 });
 test(engine+' topic child visibility requires its parent in the same topic and rejects malformed stored rules',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{const c=s.educationCategories.find(c=>c.id==='c1')!;c.parentId='c0';c.topicVisibility=[{topicId:7,enabled:true}];});
   let state=await f.store.snapshot();assert.equal(visibleEducationCategory(state,state.educationCategories.find(c=>c.id==='c1')!,7),false);
   await f.store.transaction(s=>{const parent=s.educationCategories.find(c=>c.id==='c0')!;parent.topicVisibility=[{topicId:7,enabled:true}];parent.groupVisible=false;});state=await f.store.snapshot();assert.equal(visibleEducationCategory(state,state.educationCategories.find(c=>c.id==='c1')!,7),true);assert.equal(visibleEducationCategory(state,state.educationCategories.find(c=>c.id==='c1')!),false);assert.equal(visibleEducationCategory(state,state.educationCategories.find(c=>c.id==='c1')!,8),false);
   await assert.rejects(f.store.transaction(s=>{s.educationCategories.find(c=>c.id==='c0')!.topicVisibility=[{topicId:7,enabled:true},{topicId:7,enabled:false}];}),/Unsupported state schema/u);assert.deepEqual((await f.store.snapshot()).educationCategories.find(c=>c.id==='c0')!.topicVisibility,[{topicId:7,enabled:true}]);
  }finally{await f.close();}
 });
}
