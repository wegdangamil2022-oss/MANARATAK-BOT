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

 test(engine+' pin service cleanup requires a separate opt-in and never targets the pinned content',async()=>{const f=await fixture();try{
  await f.enable();
  assert.equal(f.service.policyPin(await f.store.snapshot(),G)?.enabled,false);
  const pinEvent={update_id:200,message:{message_id:200,date:f.now()/1000,from:{id:100,is_bot:false},
   chat:{id:Number(G),type:'supergroup'},pinned_message:{message_id:19,chat:{id:Number(G),type:'supergroup'}}}};
  assert.equal((await f.app.handle(pinEvent)).reason,'PIN_OBSERVATION_ONLY');
  f.advance(60000);assert.deepEqual(await f.service.cleanup(),{deleted:0,unresolved:0});
  assert.equal(f.calls.length,0);
  assert.equal(await f.service.configurePin(OWNER,G,true,f.service.epochPin(await f.store.snapshot(),G)),true);
  assert.equal(f.service.policyPin(await f.store.snapshot(),G)?.enabled,true);
  assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,true);
  f.advance(1000);
  const newer={...pinEvent,update_id:201,message:{...pinEvent.message,message_id:201,date:f.now()/1000}};
  assert.equal((await f.app.handle(newer)).reason,'PIN_OBSERVATION_ONLY');
  assert.equal((await f.service.cleanup()).deleted,0);
  f.advance(60000);
  assert.deepEqual(await f.service.cleanup(),{deleted:1,unresolved:0});
  assert.deepEqual(f.calls,[{chat:G,messageId:201}]);
  assert.equal(f.calls.some(x=>x.messageId===19),false);
 }finally{await f.close();}});
 test(engine+' pin-only consent does not enable joining or leaving service message cleanup',async()=>{const f=await fixture();try{
  assert.equal(await f.service.configurePin(OWNER,G,true,f.service.epochPin(await f.store.snapshot(),G)),true);
  assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
  assert.equal(await f.observe('JOIN',51,251),0);
  assert.equal(await f.observe('LEAVE',52,252),0);
  assert.equal(await f.service.observeService(G,'PIN',53,'b3-webhook:service-cleanup:253',f.now()),1);
  assert.equal(await f.service.configurePin(OWNER,G,false,f.service.epochPin(await f.store.snapshot(),G)),true);
  f.advance(60000);
  assert.equal((await f.service.cleanup()).deleted,0);
  assert.equal(f.calls.length,0);
 }finally{await f.close();}});
 test(engine+' malformed and mixed pinned service updates never enqueue deletion',async()=>{const f=await fixture();try{
  await f.service.configurePin(OWNER,G,true,f.service.epochPin(await f.store.snapshot(),G));
  const service=(messageId:number,pinnedId:number)=>({update_id:300+messageId,message:{
   message_id:messageId,date:f.now()/1000,chat:{id:Number(G),type:'supergroup'},
   from:{id:100,is_bot:false},pinned_message:{message_id:pinnedId,chat:{id:Number(G),type:'supergroup'}}}});
  assert.equal((await f.app.handle(service(90,19))).reason,'PIN_OBSERVATION_ONLY');
  assert.equal((await f.app.handle({...service(91,19),message:{...service(91,19).message,text:'unsafe'}})).reason,'INVALID_GROUP_PIN');
  assert.equal((await f.app.handle({...service(92,19),message:{...service(92,19).message,new_chat_members:[{id:301,is_bot:false}]}})).reason,'INVALID_GROUP_PIN');
  assert.equal((await f.app.handle(service(94,94))).reason,'INVALID_GROUP_PIN');
  assert.equal((await f.app.handle({...service(95,19),message:{...service(95,19).message,pinned_message:{message_id:19,chat:{id:-999,type:'supergroup'}}}})).reason,'INVALID_GROUP_PIN');
  assert.equal((await f.store.snapshot()).audit.filter(a=>/^group:service-message-job:[a-f0-9]{64}$/u.test(a.updateKey)).length,1);
  f.advance(60000);
  assert.deepEqual(await f.service.cleanup(),{deleted:1,unresolved:0});
  assert.deepEqual(f.calls,[{chat:G,messageId:90}]);
 }finally{await f.close();}});
 test(engine+' owner pin cleanup control is separately previewed and one-shot',async()=>{const f=await fixture();try{
  const ui=new TelegramCaptchaOwner(f.store,f.policy,f.captcha,()=>f.now(),undefined,undefined,f.service);
  const root=await ui.handle(OWNER,'mi:1:i:09:04'),group=await ui.handle(OWNER,pick(root,G));
  assert.equal(f.service.policyPin(await f.store.snapshot(),G)?.enabled,false);
  const preview=await ui.handle(OWNER,pick(group,'تفعيل حذف إشعارات التثبيت'));
  assert.match(preview?.text??'',/معاينة/u);
  assert.equal(f.service.policyPin(await f.store.snapshot(),G)?.enabled,false);
  const confirmation=pick(preview,'تأكيد');
  assert.ok(await ui.handle(OWNER,confirmation));
  assert.equal(f.service.policyPin(await f.store.snapshot(),G)?.enabled,true);
  assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
  assert.equal(await ui.handle(OWNER,confirmation),null);
  const newRoot=await ui.handle(OWNER,'mi:1:i:09:04');
  const newGroup=await ui.handle(OWNER,pick(newRoot,G));
  const off=await ui.handle(OWNER,pick(newGroup,'إيقاف حذف إشعارات التثبيت'));
  assert.ok(await ui.handle(OWNER,pick(off,'تأكيد')));
  assert.equal(f.service.policyPin(await f.store.snapshot(),G)?.enabled,false);
 }finally{await f.close();}});


 test(engine+' group metadata notices require their own consent and clean original service IDs only',async()=>{const f=await fixture();try{
  const mk=(id:number,part:Record<string,unknown>)=>({update_id:1200+id,message:{message_id:id,date:f.now()/1000,
   from:{id:777,is_bot:false},chat:{id:Number(G),type:'supergroup'},...part}});
  await f.enable();await f.service.configurePin(OWNER,G,true,f.service.epochPin(await f.store.snapshot(),G));
  assert.equal(f.service.policyGroupChanges(await f.store.snapshot(),G)?.enabled,false);
  const title=mk(300,{new_chat_title:'Important new name'});
  assert.equal((await f.app.handle(title)).reason,'GROUP_SERVICE_NOTICE_OBSERVED');
  f.advance(60000);assert.equal((await f.service.cleanup()).deleted,0);
  assert.equal(await f.service.configureGroupChanges(OWNER,G,true,f.service.epochGroupChanges(await f.store.snapshot(),G)),true);
  const messages=[
   mk(301,{new_chat_title:'Private student information'}),
   mk(302,{new_chat_photo:[{file_id:'photoFileId-123',file_unique_id:'photoUnique123',width:100,height:100,file_size:321}]}),
   mk(303,{delete_chat_photo:true})];
  for(const v of messages)assert.equal((await f.app.handle(v)).reason,'GROUP_SERVICE_NOTICE_OBSERVED');
  const serialized=JSON.stringify((await f.store.snapshot()).audit);
  assert.equal(serialized.includes('Private student information'),false);
  assert.equal(serialized.includes('photoFileId-123'),false);
  f.advance(60000);assert.deepEqual(await f.service.cleanup(),{deleted:3,unresolved:0});
  assert.deepEqual(f.calls.map(x=>x.messageId),[301,302,303]);
  assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,true);
  assert.equal(f.service.policyPin(await f.store.snapshot(),G)?.enabled,true);
 }finally{await f.close();}});
 test(engine+' forum service notices are separately approved, including topic and general-topic actions',async()=>{const f=await fixture();try{
  const mk=(id:number,part:Record<string,unknown>,thread=true)=>({update_id:1400+id,message:{message_id:id,date:f.now()/1000,
   from:{id:999,is_bot:true},chat:{id:Number(G),type:'supergroup'},...(thread?{message_thread_id:101}:{}),...part}});
  assert.equal(await f.service.configureGroupChanges(OWNER,G,true,f.service.epochGroupChanges(await f.store.snapshot(),G)),true);
  const created=mk(400,{forum_topic_created:{name:'Announcements',icon_color:7322096}});
  assert.equal((await f.app.handle(created)).reason,'GROUP_SERVICE_NOTICE_OBSERVED');
  f.advance(60000);assert.equal((await f.service.cleanup()).deleted,0);
  assert.equal(await f.service.configureForum(OWNER,G,true,f.service.epochForum(await f.store.snapshot(),G)),true);
  const updates=[
   mk(401,{forum_topic_created:{name:'Private internal topic',icon_color:7322096}}),
   mk(402,{forum_topic_edited:{name:'New topic name'}}),
   mk(403,{forum_topic_closed:{}}),
   mk(404,{forum_topic_reopened:{}}),
   mk(405,{general_forum_topic_hidden:{}},false),
   mk(406,{general_forum_topic_unhidden:{}},false)];
  for(const v of updates)assert.equal((await f.app.handle(v)).reason,'GROUP_SERVICE_NOTICE_OBSERVED');
  assert.equal(JSON.stringify((await f.store.snapshot()).audit).includes('Private internal topic'),false);
  f.advance(60000);assert.deepEqual(await f.service.cleanup(10),{deleted:6,unresolved:0});
  assert.deepEqual(f.calls.map(x=>x.messageId),[401,402,403,404,405,406]);
  assert.equal(f.service.policyGroupChanges(await f.store.snapshot(),G)?.enabled,true);
  assert.equal(f.service.policyForum(await f.store.snapshot(),G)?.enabled,true);
 }finally{await f.close();}});
 test(engine+' malformed and combined group-service notifications fail closed before queueing',async()=>{const f=await fixture();try{
  await f.service.configureGroupChanges(OWNER,G,true,f.service.epochGroupChanges(await f.store.snapshot(),G));
  await f.service.configureForum(OWNER,G,true,f.service.epochForum(await f.store.snapshot(),G));
  const mk=(id:number,fields:Record<string,unknown>,type='supergroup')=>({update_id:2000+id,message:{message_id:id,date:f.now()/1000,
   chat:{id:Number(G),type},from:{id:777,is_bot:false},...fields}});
  const bad=[
   mk(501,{new_chat_title:'Hello',text:'student data'}),
   mk(502,{new_chat_title:'Hello',delete_chat_photo:true}),
   mk(503,{delete_chat_photo:false}),
   mk(504,{new_chat_title:''}),
   mk(505,{new_chat_photo:[]}),
   mk(506,{new_chat_photo:[{width:30,height:30}]}),
   mk(507,{new_chat_title:'Hey',pinned_message:{message_id:90,chat:{id:Number(G),type:'supergroup'}}}),
   mk(508,{forum_topic_created:{name:'X'}}),
   mk(509,{forum_topic_edited:{}}),
   mk(510,{forum_topic_closed:{name:'Unexpected'}}),
   mk(511,{forum_topic_closed:{}},'group'),
   mk(512,{forum_topic_closed:{},text:'hello'}),
   mk(513,{forum_topic_closed:{},forward_date:100}),
   mk(514,{new_chat_photo:'not a photo array'}),
   mk(515,{forum_topic_created:{name:'ok',icon_color:-1}}),
   mk(516,{forum_topic_reopened:{},new_chat_photo:[{file_id:'photoFileId-123',width:100,height:100}]}),
   mk(517,{forum_topic_edited:{name:'hi'},document:{file_id:'doc12345678'}})
  ];
  for(const v of bad)assert.notEqual((await f.app.handle(v)).reason,'GROUP_SERVICE_NOTICE_OBSERVED');
  assert.equal((await f.store.snapshot()).audit.some(a=>a.updateKey.startsWith('group:service-message-job:')),false);
  f.advance(60000);assert.equal((await f.service.cleanup()).deleted,0);
 }finally{await f.close();}});
 test(engine+' independent metadata and forum consent revoke queued cleanup, STOP and missing rights deny deletion',async()=>{for(const scenario of ['off','version','stop','rights','unknown'] as const){
  const f=await fixture();try{
   await f.service.configureGroupChanges(OWNER,G,true,f.service.epochGroupChanges(await f.store.snapshot(),G));
   await f.service.configureForum(OWNER,G,true,f.service.epochForum(await f.store.snapshot(),G));
   assert.equal(await f.service.observeService(G,'GROUP_TITLE',521,'b3-webhook:service-cleanup:521',f.now()),1);
   assert.equal(await f.service.observeService(G,'TOPIC_CLOSED',522,'b3-webhook:service-cleanup:522',f.now()),1);
   f.advance(60000);
   if(scenario==='off')await f.service.configureGroupChanges(OWNER,G,false,f.service.epochGroupChanges(await f.store.snapshot(),G));
   if(scenario==='version')await f.store.transaction(s=>{s.chats.find(x=>x.id===G)!.version++;});
   if(scenario==='stop')f.stop();if(scenario==='rights')f.rights('DENIED');if(scenario==='unknown')f.result('UNKNOWN_OUTCOME');
   const first=await f.service.cleanup();
   if(scenario==='off'){assert.equal(first.deleted,1);assert.deepEqual(f.calls.map(x=>x.messageId),[522]);}
   else if(scenario==='version'){assert.equal(first.deleted,0);assert.equal(f.calls.length,0);}
   else if(scenario==='stop'||scenario==='rights'){assert.equal(first.deleted,0);assert.equal(f.calls.length,0);}
   else{assert.equal(first.unresolved,2);assert.equal(f.calls.length,2);}
   f.start();f.rights('GRANTED');f.result('ACKNOWLEDGED');
   const again=await f.service.cleanup();
   if(scenario==='unknown'||scenario==='version'||scenario==='off')assert.equal(again.deleted,0);
   else assert.equal(again.deleted,2);
  }finally{await f.close();}
 }});
 test(engine+' service consent scopes stay isolated when configuration audit is forged',async()=>{const f=await fixture();try{
  await f.service.configureGroupChanges(OWNER,G,true,f.service.epochGroupChanges(await f.store.snapshot(),G));
  await f.service.configureForum(OWNER,G,true,f.service.epochForum(await f.store.snapshot(),G));
  await f.service.observeService(G,'GROUP_PHOTO_REMOVED',531,'b3-webhook:service-cleanup:531',f.now());
  await f.service.observeService(G,'TOPIC_CLOSED',532,'b3-webhook:service-cleanup:532',f.now());
  await f.store.transaction(s=>{s.audit.find(a=>a.updateKey==='group:group-change-cleanup-policy:'+G)!.actorId='999';});
  f.advance(60000);
  assert.deepEqual(await f.service.cleanup(),{deleted:1,unresolved:0});
  assert.deepEqual(f.calls.map(x=>x.messageId),[532]);
 }finally{await f.close();}});
 test(engine+' owner settings expose separate preview-confirm-stop for group changes and forum notifications',async()=>{const f=await fixture();try{
  const ui=new TelegramCaptchaOwner(f.store,f.policy,f.captcha,()=>f.now(),undefined,undefined,f.service);
  const root=await ui.handle(OWNER,'mi:1:i:09:04');const group=await ui.handle(OWNER,pick(root,G));
  assert.equal(f.service.policyGroupChanges(await f.store.snapshot(),G)?.enabled,false);
  assert.equal(f.service.policyForum(await f.store.snapshot(),G)?.enabled,false);
  const preview=await ui.handle(OWNER,pick(group,'تفعيل تنظيف تغييرات المجموعة'));
  assert.match(preview?.text??'',/معاينة/u);
  assert.equal(f.service.policyGroupChanges(await f.store.snapshot(),G)?.enabled,false);
  const token=pick(preview,'تأكيد');assert.ok(await ui.handle(OWNER,token));
  assert.equal(await ui.handle(OWNER,token),null);
  assert.equal(f.service.policyGroupChanges(await f.store.snapshot(),G)?.enabled,true);
  const root2=await ui.handle(OWNER,'mi:1:i:09:04');const group2=await ui.handle(OWNER,pick(root2,G));
  const forumPreview=await ui.handle(OWNER,pick(group2,'تفعيل تنظيف إشعارات المواضيع'));
  assert.match(forumPreview?.text??'',/معاينة/u);
  assert.ok(await ui.handle(OWNER,pick(forumPreview,'تأكيد')));
  assert.equal(f.service.policyForum(await f.store.snapshot(),G)?.enabled,true);
  const root3=await ui.handle(OWNER,'mi:1:i:09:04');const group3=await ui.handle(OWNER,pick(root3,G));
  const off=await ui.handle(OWNER,pick(group3,'إيقاف تنظيف تغييرات المجموعة'));
  assert.ok(await ui.handle(OWNER,pick(off,'تأكيد')));
  assert.equal(f.service.policyGroupChanges(await f.store.snapshot(),G)?.enabled,false);
  assert.equal(f.service.policyForum(await f.store.snapshot(),G)?.enabled,true);
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
  assert.equal(await f.observe('LEAVE',45,21),0); // Same authenticated update cannot represent two different service messages
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
   assert.equal(run.deleted,0);assert.equal(run.unresolved,1);
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
