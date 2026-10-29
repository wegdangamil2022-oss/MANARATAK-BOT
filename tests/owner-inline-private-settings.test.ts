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
import {validPrivateSettingsRoute} from '../src/telegram-inline-private-settings.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
test('private settings callback grammar rejects trailing control characters and oversize data',()=>{
 for(const text of ['ps:1:h\n','ps:1:h\r','ps:1:h\u2028','ps:1:c:'+'A'.repeat(25),'ps:1:r:e:1:'+'a'.repeat(16)+'\r'])assert.equal(validPrivateSettingsRoute(text),false);
 assert.equal(validPrivateSettingsRoute('ps:1:h'),true);
});
const event=(id:number,data:string,actor=100,group=false)=>({update_id:id,callback_query:{id:'private_'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
const message=(id:number,text:string,actor=100)=>({update_id:id,message:{message_id:id,date:1700000000,from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const select=(r:Result,text:string)=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(x=>x.text.includes(text));assert.ok(b,'missing '+text);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'private-settings-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=1700000000000;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now),admin=new EducationAdminFacade(store,policy,education,()=>now);
  await education.createCategory('100',{id:'section',scope:'private',title:'القسم',order:1});
  const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),botId:'private-local',botUsername:'ManaratakBot',clock:()=>now,membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  return {store,policy,education,admin,app,time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('private settings change independently and affect their real gates ('+engine+')',async()=>{
  const f=await fixture();try{
   let page=await f.app().handle(event(1,'mi:1:i:11:03'));assert.ok(isValidTelegramInlineKeyboard(page.plan!.inlineMarkup));
   let review=await f.app().handle(event(2,select(page,'رفع الملفات')));page=await f.app().handle(event(3,select(review,'تأكيد')));
   const ctx={origin:'TELEGRAM_PRIVATE' as const,actorId:'100',chatId:'100',verified:true};assert.equal((await f.admin.panel(ctx,'private')).canUpload,true);
   review=await f.app().handle(event(4,select(page,'تصفح التعليم')));page=await f.app().handle(event(5,select(review,'تأكيد')));
   assert.deepEqual(await f.education.listCategories('100','private'),[]);assert.equal((await f.app().handle(message(6,'/studentinline'))).status,'DENIED');
   assert.equal((await f.admin.panel(ctx,'private')).canUpload,true);let s=await f.store.snapshot();assert.equal(f.policy.privateFeature(s,'subscription.verify','100'),true);assert.equal(f.policy.privateFeature(s,'owner.dashboard','100'),true);
   review=await f.app().handle(event(7,select(page,'الدعم')));page=await f.app().handle(event(8,select(review,'تأكيد')));
   review=await f.app().handle(event(9,select(page,'المستخدم الذي وافق')));page=await f.app().handle(event(10,select(review,'تأكيد')));
   s=await f.store.snapshot();assert.equal(f.policy.privateFeature(s,'support.use','100'),false);assert.equal(f.policy.privateFeature(s,'subscription.verify','100'),true);assert.equal(f.policy.mayAskPrivate(s,'100',false),false);assert.equal(f.policy.mayAskPrivate(s,'100',true),true);assert.equal((await f.admin.panel(ctx,'private')).canUpload,true);
   assert.equal(s.deliveries.length,0);assert.ok(page.plan?.text.includes('مفاتيح خدمات الخاص'));
  }finally{await f.close();}
 });
 test('owner can safely disable and recover dashboard without disabling student navigation ('+engine+')',async()=>{
  const f=await fixture();try{
   const page=await f.app().handle(event(20,'mi:1:i:11:03'));const review=await f.app().handle(event(21,select(page,'لوحة المالك')));const disabled=await f.app().handle(event(22,select(review,'تأكيد')));
   assert.ok(disabled.plan!.text.includes('استعادة لوحة المالك'));assert.equal((await f.app().handle(message(23,'/ownerinline'))).status,'DENIED');assert.equal((await f.app().handle(event(24,'mi:1:i:10:16'))).status,'DENIED');
   assert.equal((await f.app().handle(message(25,'/studentinline'))).status,'APPLIED');assert.equal((await f.app().handle(message(26,'/ownerrecover',300))).status,'DENIED');
   const recovery=await f.app().handle(message(27,'/ownerrecover'));const confirmView=await f.app().handle(event(28,select(recovery,'إعادة تفعيل')));
   assert.equal((await f.app().handle(event(29,select(confirmView,'تأكيد')))).status,'APPLIED');assert.equal((await f.app().handle(message(30,'/ownerinline'))).status,'APPLIED');
  }finally{await f.close();}
 });
 test('queued owner screens are withheld after dashboard revocation while student and recovery screens remain usable ('+engine+')',async()=>{
  const f=await fixture();try{
   const category=await f.app().handle(event(60,'mi:1:i:10:16')),student=await f.app().handle(message(61,'/studentinline'));assert.equal(category.status,'APPLIED');assert.equal(student.status,'APPLIED');
   const before=await f.store.snapshot();assert.equal(before.telegramReplyJobs!.find(j=>j.updateKey===category.deliveryKey)!.privateReplyKind,'ADMIN_SCOPED');assert.equal(before.telegramReplyJobs!.find(j=>j.updateKey===student.deliveryKey)!.privateReplyKind,'LIBRARY_SCOPED');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});let sends=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:99};}},()=>1700000000000);
   assert.equal((await dispatcher.dispatch(category.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sends,0);
   assert.equal((await dispatcher.dispatch(student.deliveryKey!)).status,'CONFIRMED');assert.equal(sends,1);
   const recovery=await f.app().handle(message(62,'/ownerrecover'));assert.equal((await dispatcher.dispatch(recovery.deliveryKey!)).status,'CONFIRMED');assert.equal(sends,2);
  }finally{await f.close();}
 });
 test('queued owner views become stale when a private setting is changed ('+engine+')',async()=>{
  const f=await fixture();try{
   const old=await f.app().handle(event(70,'mi:1:i:10:16')),settings=await f.app().handle(event(71,'ps:1:h')),review=await f.app().handle(event(72,select(settings,'الدعم')));
   assert.equal((await f.app().handle(event(73,select(review,'تأكيد')))).status,'APPLIED');let sends=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:99};}},()=>1700000000000);
   assert.equal((await dispatcher.dispatch(old.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sends,0);
  }finally{await f.close();}
 });
 test('private settings confirmations reject replay, stale revisions, expiry and invalid flags ('+engine+')',async()=>{
  const f=await fixture();try{
   let page=await f.app().handle(event(40,'ps:1:h'));const first=await f.app().handle(event(41,select(page,'تصفح التعليم')));const second=await f.app().handle(event(42,select(page,'الدعم')));
   const confirm=select(first,'تأكيد');const concurrent=await Promise.all([f.app().handle(event(43,confirm)),f.app().handle(event(44,confirm))]);assert.equal(concurrent.filter(x=>x.status==='APPLIED').length,1);assert.equal((await f.app().handle(event(45,select(second,'تأكيد')))).status,'DENIED');
   page=await f.app().handle(event(46,'ps:1:h'));let review=await f.app().handle(event(47,select(page,'الدعم')));const old=select(review,'تأكيد');f.time(1700000120000);assert.equal((await f.app().handle(event(48,old))).status,'DENIED');
   page=await f.app().handle(event(49,'ps:1:h'));review=await f.app().handle(event(50,select(page,'الدعم')));const bad=select(review,'تأكيد');await f.store.transaction(s=>{s.callbacks.find(c=>c.ref==='c_'+bad.slice(7))!.oneShot='true' as unknown as boolean;});assert.equal((await f.app().handle(event(51,bad))).status,'DENIED');
   page=await f.app().handle(event(52,'ps:1:h'));review=await f.app().handle(event(53,select(page,'الدعم')));await f.policy.configurePrivateAI('100','STAFF_ONLY');await f.policy.configurePrivateAI('100','OFF');assert.equal((await f.app().handle(event(54,select(review,'تأكيد')))).status,'DENIED');
   assert.equal((await f.app().handle(event(55,'ps:1:h',300))).status,'DENIED');assert.equal((await f.app().handle(event(56,'ps:1:h',100,true))).status,'DENIED');
  }finally{await f.close();}
 });
}
