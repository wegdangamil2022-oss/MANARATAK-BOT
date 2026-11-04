import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupServiceMessageCleanup} from '../src/group-service-message-cleanup.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {CaptchaService} from '../src/captcha.js';
import {TelegramCaptchaOwner} from '../src/telegram-captcha-owner.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const NOW=1700000000000,G='-100123',OWNER='100';
const pick=(view:OwnerInlineScreen|null,label:string)=>{assert.ok(view);const b=view.keyboard.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(b,label);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'group-service-cleanup-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW,run=true,deleteRight:'GRANTED'|'DENIED'|'UNKNOWN'='GRANTED',result:'ACKNOWLEDGED'|'UNKNOWN_OUTCOME'|'FAILED_CONFIRMED'|'NOT_SENT'='ACKNOWLEDGED';
  let duringDelete:(()=>Promise<void>)|undefined;
  const calls:{chat:string;messageId:number}[]=[];
  const policy=new Policy(store,OWNER,()=>now);await policy.approveChat(OWNER,G,['moderation','verification','navigation']);
  const service=new GroupServiceMessageCleanup(store,policy,{
   delete:async(chat,messageId,verify)=>{if(!await verify())return 'NOT_SENT' as const;calls.push({chat,messageId});if(duringDelete){const f=duringDelete;duringDelete=undefined;await f();}return result;}
  },()=>now,async()=>run,async()=>deleteRight);
  const enable=async()=>assert.equal(await service.configure(OWNER,G,true,service.epoch(await store.snapshot(),G)),true);
  const observe=async(kind:'JOIN'|'LEAVE'='JOIN',messageId=41,updateId=12,at=now)=>
   service.observeService(G,kind,messageId,'b3-webhook:service-cleanup:'+updateId,at);
  const education=new EducationService(store,policy,()=>now);
  const captcha=new CaptchaService(store,policy,async()=> 'VERIFIED',()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),
   faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),
   membership:async()=> 'VERIFIED',clock:()=>now,botId:'service-cleanup',botUsername:'ManaratakBot',serviceCleanup:service});
  return {store,policy,service,captcha,app,calls,enable,observe,now:()=>now,advance:(n:number)=>{now+=n;},stop:()=>{run=false;},start:()=>{run=true;},
   rights:(v:'GRANTED'|'DENIED'|'UNKNOWN')=>{deleteRight=v;},result:(v:typeof result)=>{result=v;},during:(f:()=>Promise<void>)=>{duringDelete=f;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' original Telegram service message cleanup is disabled by default',async()=>{const f=await fixture();try{
  assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
  assert.equal(await f.observe(),0);f.advance(60000);
  assert.deepEqual(await f.service.cleanup(),{deleted:0,unresolved:0});
  assert.equal(f.calls.length,0);
 }finally{await f.close();}});
 test(engine+' joined and left service messages are deleted after owner authorization and delay',async()=>{const f=await fixture();try{
  await f.enable();assert.equal(await f.observe('JOIN',41,12),1);
  assert.equal(await f.observe('LEAVE',42,13),1);
  assert.equal((await f.service.cleanup()).deleted,0);
  f.advance(60000);
  assert.deepEqual(await f.service.cleanup(),{deleted:2,unresolved:0});
  assert.deepEqual(f.calls,[{chat:G,messageId:41},{chat:G,messageId:42}]);
  assert.equal((await f.service.cleanup()).deleted,0);
 }finally{await f.close();}});
 test(engine+' duplicate and forged update keys cannot enqueue the same service message',async()=>{const f=await fixture();try{
  await f.enable();assert.equal(await f.observe('JOIN',44,21),1);
  assert.equal(await f.observe('JOIN',44,21),0);
  assert.equal(await f.observe('LEAVE',44,22),0);
  assert.equal(await f.service.observeService(G,'JOIN',44,'fake',f.now()),0);
  assert.equal(await f.service.observeService(G,'JOIN',0,'b3-webhook:service-cleanup:23',f.now()),0);
  assert.equal((await f.store.snapshot()).audit.filter(a=>/^group:service-message-job:[a-f0-9]{64}$/u.test(a.updateKey)).length,1);
 }finally{await f.close();}});
 test(engine+' STOP and unavailable delete rights cannot invoke Telegram',async()=>{for(const mode of ['stop','denied','unknown'] as const){
  const f=await fixture();try{
   await f.enable();await f.observe();f.advance(60000);
   if(mode==='stop')f.stop();else f.rights(mode==='denied'?'DENIED':'UNKNOWN');
   assert.equal((await f.service.cleanup()).deleted,0);assert.equal(f.calls.length,0);
   f.start();f.rights('GRANTED');
   assert.equal((await f.service.cleanup()).deleted,1);
  }finally{await f.close();}
 }});
 test(engine+' interrupted delete and UNKNOWN response are terminal across restart',async()=>{for(const cause of ['crash','unknown'] as const){
  const f=await fixture();try{
   await f.enable();await f.observe();f.advance(60000);
   if(cause==='crash')await f.store.transaction(s=>{
    const root=s.audit.find(a=>/^group:service-message-job:[a-f0-9]{64}$/u.test(a.updateKey))!;
    s.audit.push({actorId:OWNER,updateKey:root.updateKey+':started',decision:'ALLOW',reason:'GROUP_SERVICE_DELETE_STARTED',policyVersion:root.policyVersion,at:f.now()});
   });else f.result('UNKNOWN_OUTCOME');
   const run=await f.service.cleanup();
   assert.equal(run.deleted,0);assert.equal(run.unresolved,cause==='crash'?0:1);
   const second=new GroupServiceMessageCleanup(new BotStore(f.store.file,{engine}),f.policy,
    {delete:async()=>{throw Error('duplicate Telegram delete prohibited');}},()=>f.now(),async()=>true,async()=> 'GRANTED');
   assert.equal((await second.cleanup()).deleted,0);
   assert.equal(f.calls.length,cause==='crash'?0:1);
  }finally{await f.close();}
 }});
 test(engine+' changed consent or group approval blocks queued deletion',async()=>{for(const mode of ['off','approval'] as const){
  const f=await fixture();try{
   await f.enable();await f.observe();f.advance(60000);
   if(mode==='off')assert.equal(await f.service.configure(OWNER,G,false,f.service.epoch(await f.store.snapshot(),G)),true);
   else await f.store.transaction(s=>{s.chats.find(x=>x.id===G)!.version++;});
   assert.equal((await f.service.cleanup()).deleted,0);
   assert.equal(f.calls.length,0);
  }finally{await f.close();}
 }});
 test(engine+' disabling during Telegram delete never triggers a retry after uncertain attempt',async()=>{const f=await fixture();try{
  await f.enable();await f.observe();f.advance(60000);
  f.during(async()=>{assert.equal(await f.service.configure(OWNER,G,false,f.service.epoch(await f.store.snapshot(),G)),true);});
  assert.equal((await f.service.cleanup()).deleted,0);
  assert.equal((await f.service.cleanup()).deleted,0);
  assert.equal(f.calls.length,1);
 }finally{await f.close();}});
 test(engine+' service message after 24 hours is never deleted by maintenance',async()=>{const f=await fixture();try{
  await f.enable();await f.observe();f.advance(86400001);
  assert.equal((await f.service.cleanup()).deleted,0);assert.equal(f.calls.length,0);
 }finally{await f.close();}});
 test(engine+' Telegram join and leave updates route service cleanup while text and forged service updates are ignored',async()=>{const f=await fixture();try{
  await f.enable();const at=f.now();
  const joined=await f.app.handle({update_id:61,message:{message_id:61,date:at/1000,from:{id:100,is_bot:false},chat:{id:Number(G),type:'supergroup'},new_chat_members:[{id:301,is_bot:false}]}});
  const left=await f.app.handle({update_id:62,message:{message_id:62,date:at/1000,from:{id:301,is_bot:false},chat:{id:Number(G),type:'supergroup'},left_chat_member:{id:301,is_bot:false}}});
  assert.equal(joined.status,'IGNORED');assert.equal(left.status,'IGNORED');
  const invalid=await f.app.handle({update_id:63,message:{message_id:63,date:at/1000,from:{id:301,is_bot:false},chat:{id:Number(G),type:'supergroup'},left_chat_member:{id:301,is_bot:false},text:'hello'}});
  assert.equal(invalid.status,'DENIED');
  f.advance(60000);assert.equal((await f.service.cleanup()).deleted,2);
  assert.deepEqual(f.calls,[{chat:G,messageId:61},{chat:G,messageId:62}]);
 }finally{await f.close();}});
 test(engine+' owner settings include separate service join/leave cleanup confirmation without enabling CAPTCHA',async()=>{const f=await fixture();try{
  const ui=new TelegramCaptchaOwner(f.store,f.policy,f.captcha,()=>f.now(),undefined,undefined,f.service);
  const root=await ui.handle(OWNER,'mi:1:i:04:07'),edit=await ui.handle(OWNER,pick(root,G));
  assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
  const preview=await ui.handle(OWNER,pick(edit,'تفعيل حذف رسائل الدخول والخروج'));
  assert.match(preview!.text,/معاينة/u);
  const confirm=pick(preview,'تأكيد');assert.ok(await ui.handle(OWNER,confirm));
  assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,true);
  assert.equal(await ui.handle(OWNER,confirm),null);
  const renewed=await ui.handle(OWNER,'mi:1:i:04:07'),selected=await ui.handle(OWNER,pick(renewed,G));
  const off=await ui.handle(OWNER,pick(selected,'إيقاف حذف رسائل الدخول والخروج'));
  assert.ok(await ui.handle(OWNER,pick(off,'تأكيد')));
  assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
 }finally{await f.close();}});

 test(engine+' owner welcome and farewell section opens actual group-specific cleanup controls',async()=>{const f=await fixture();try{
  const view=await f.app.handle({update_id:70,callback_query:{id:'service-owner-root',from:{id:100,is_bot:false},
   data:'mi:1:i:09:04',message:{message_id:70,from:{id:999,is_bot:true},chat:{id:100,type:'private'}}}});
  assert.equal(view.status,'APPLIED');
  assert.equal(view.reason,'CAPTCHA_OWNER_VIEW');
  assert.match(view.plan!.text,/الدخول والخروج/u);
  assert.ok(view.plan!.inlineMarkup!.inline_keyboard.flat().some(x=>x.text===G));
 }finally{await f.close();}});
 test(engine+' tampered consent or duplicated restored message identity cannot authorize deletion',async()=>{for(const caseType of ['consent','duplicate'] as const){
  const f=await fixture();try{
   await f.enable();await f.observe();f.advance(60000);
   await f.store.transaction(s=>{
    if(caseType==='consent')s.audit.find(a=>a.updateKey==='group:service-cleanup-policy:'+G)!.actorId='777';
    else{const original=s.audit.find(a=>/^group:service-message-job:[a-f0-9]{64}$/u.test(a.updateKey))!;
      s.audit.push({...original,updateKey:original.updateKey,reason:original.reason});}
   });
   assert.equal((await f.service.cleanup()).deleted,0);assert.equal(f.calls.length,0);
  }finally{await f.close();}
 }});
}
