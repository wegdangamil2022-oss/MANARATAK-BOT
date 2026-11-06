import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramMessageMetadataCollector} from '../src/telegram-message-metadata.js';
import {ModerationPurgeService,FakePurgeGateway} from '../src/moderation-purge.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
const NOW=1700000000000,CHAT='-100123';
for(const engine of ['json','sqlite'] as const){
 test(engine+' observed message metadata is private, ordered, protected and expires',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'message-metadata-'));try{
   let now=NOW;const clock=()=>now,store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',clock);await policy.approveChat('100',CHAT,['moderation']);
   const metadata=new TelegramMessageMetadataCollector(store,policy,clock),education=new EducationService(store,policy,clock),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,clock),faq:new ApprovedAnswerService(store,policy,clock),links:new ResourceLinkService(store,policy,clock),membership:async()=> 'VERIFIED',botId:'metadata-test',botUsername:'ManaratakBot',messageMetadata:metadata,clock});
   const message={message_id:42,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'private words https://example.test'};
   await app.handle({update_id:20,message});let state=await store.snapshot();assert.equal(state.rollingMessageMeta.length,1);assert.equal(state.rollingMessageMeta[0]!.hasLinks,true);assert.equal(state.rollingMessageMeta[0]!.protectionUnverified,true);assert.equal(JSON.stringify(state.rollingMessageMeta).includes('private words'),false);assert.equal(JSON.stringify(state.rollingMessageMeta).includes('example.test'),false);
   now+=1000;await app.handle({update_id:22,edited_message:{...message,text:'new text',edit_date:now/1000}});await app.handle({update_id:21,edited_message:{...message,text:'older https://example.test',edit_date:now/1000}});state=await store.snapshot();assert.equal(state.rollingMessageMeta[0]!.sourceUpdateId,22);assert.equal(state.rollingMessageMeta[0]!.hasLinks,false);
   const purge=new ModerationPurgeService(store,policy,new FakePurgeGateway(),clock);await assert.rejects(purge.preview('100',CHAT,{limit:1}),/NO_ELIGIBLE_OBSERVED_MESSAGES/);
   await app.handle({update_id:23,message:{...message,message_id:43,chat:{id:-999,type:'supergroup'}}});assert.equal((await store.snapshot()).rollingMessageMeta.length,1);
   now=NOW+48*3600000;assert.equal(await metadata.prune(),1);assert.equal((await store.snapshot()).rollingMessageMeta.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' conflicting or unverified restored sources cannot downgrade message protection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'message-metadata-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100',CHAT,['moderation']);const collector=new TelegramMessageMetadataCollector(store,policy,()=>NOW);
   const row={chatId:CHAT,senderId:'300',messageId:10,sentAt:NOW-1000,updateId:1,contentType:'TEXT' as const,hasLinks:false};assert.equal(await collector.observe(row),'STORED');assert.equal(await collector.observe({...row,updateId:2,senderId:'301'}),'CONFLICT');
   await store.transaction(s=>{s.rollingMessageMeta.push(structuredClone(s.rollingMessageMeta[0]!));});assert.equal(await collector.observe({...row,updateId:3}),'CONFLICT');
   const gateway=new FakePurgeGateway(),purge=new ModerationPurgeService(store,policy,gateway,()=>NOW);await assert.rejects(purge.preview('100',CHAT,{limit:1}),/NO_ELIGIBLE_OBSERVED_MESSAGES/);assert.equal(gateway.calls.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' a pinned-message service update protects an observed target and invalidates a pending deletion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'message-pin-'));try{
   const clock=()=>NOW,store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',clock);await policy.approveChat('100',CHAT,['moderation']);
   const metadata=new TelegramMessageMetadataCollector(store,policy,clock),gateway=new FakePurgeGateway(),purge=new ModerationPurgeService(store,policy,gateway,clock),education=new EducationService(store,policy,clock),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,clock),faq:new ApprovedAnswerService(store,policy,clock),links:new ResourceLinkService(store,policy,clock),membership:async()=> 'VERIFIED',botId:'pin-test',botUsername:'ManaratakBot',messageMetadata:metadata,clock});
   await purge.observe({chatId:CHAT,messageId:42,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});const job=await purge.preview('100',CHAT,{limit:1});
   const msg={message_id:80,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:100,is_bot:false},pinned_message:{message_id:42,chat:{id:Number(CHAT),type:'supergroup'}}};
   assert.equal((await app.handle({update_id:30,message:{...msg,pinned_message:{message_id:42,chat:{id:-999,type:'supergroup'}}}})).reason,'INVALID_GROUP_PIN');assert.equal((await store.snapshot()).rollingMessageMeta[0]!.pinned,false);
   assert.equal((await app.handle({update_id:31,message:msg})).reason,'PIN_OBSERVATION_ONLY');assert.equal((await store.snapshot()).rollingMessageMeta[0]!.pinned,true);await assert.rejects(purge.confirm('100',job.id),/PREVIEW_STALE/);assert.equal(gateway.calls.length,0);
   await purge.observe({chatId:CHAT,messageId:43,senderKind:'USER',senderId:'301',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});
   assert.equal((await app.handle({update_id:32,message:{...msg,message_id:81,from:{id:999,is_bot:true},pinned_message:{message_id:43,chat:{id:Number(CHAT),type:'supergroup'}}}})).reason,'PIN_OBSERVATION_ONLY');assert.equal((await store.snapshot()).rollingMessageMeta.find(m=>m.messageId===43)!.pinned,true);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
