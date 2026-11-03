import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {createPhase3ModerationRuntime} from '../src/phase3-moderation-runtime.js';
import {TelegramMessageMetadataCollector} from '../src/telegram-message-metadata.js';
import {ModerationPurgeService,FakePurgeGateway} from '../src/moderation-purge.js';
import {TelegramBotApiPurgeGateway} from '../src/telegram-purge-gateway.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',NOW=1700000000000;
for(const engine of ['json','sqlite'] as const){
 test(engine+' purge runtime is offline on construction and rejects unverified collected messages',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase3-purge-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100','-100',['moderation']);let calls=0;
   const request=(async()=>{calls++;throw Error('unexpected network');}) as typeof fetch,runtime=await createPhase3ModerationRuntime(store,policy,TOKEN,request,async()=>true,()=>NOW);assert.equal(calls,0);assert.equal(runtime.protectionEnforcer.supports('DELETE'),true);
   await new TelegramMessageMetadataCollector(store,policy,()=>NOW).observe({chatId:'-100',senderId:'300',messageId:10,sentAt:NOW-1000,updateId:1,contentType:'TEXT',hasLinks:false});await assert.rejects(runtime.purge.preview('100','-100',{limit:1}),/NO_ELIGIBLE/);assert.equal(calls,0);
   const restarted=await createPhase3ModerationRuntime(store,policy,TOKEN,request,async()=>true,()=>NOW);await assert.rejects(restarted.purge.preview('100','-100',{limit:1}),/NO_ELIGIBLE/);assert.equal(calls,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' official reviewed purge binds gateway origin, survives restart, and never retries unknown delivery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase3-purge-official-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100','-100',['moderation']);let deletes=0;
   const request=(async(url:unknown)=>{if(String(url).endsWith('/getChatMember'))return Response.json({ok:true,result:{status:'administrator',user:{id:123456789,is_bot:true},can_delete_messages:true}});assert.ok(String(url).endsWith('/deleteMessage'));deletes++;throw Error('lost response');}) as typeof fetch;
   const runtime=await createPhase3ModerationRuntime(store,policy,TOKEN,request,async()=>true,()=>NOW);
   // Trusted test fixture only. The production collector never grants these flags.
   await runtime.purge.observe({chatId:'-100',messageId:10,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});await store.transaction(s=>{s.rollingMessageMeta[0]!.sourceUpdateId=1;});
   const job=await runtime.purge.preview('100','-100',{limit:1});assert.equal(job.gatewayOrigin,'TELEGRAM_API');await runtime.purge.confirm('100',job.id);assert.equal((await runtime.purge.dispatchNext(job.id)).status,'UNKNOWN_OUTCOME');assert.equal(deletes,1);
   const restart=await createPhase3ModerationRuntime(new BotStore(store.file,{engine}),policy,TOKEN,request,async()=>true,()=>NOW);assert.equal((await restart.purge.dispatchNext(job.id)).status,'BLOCKED_UNKNOWN');assert.equal(deletes,1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' simulated purge plans cannot be resumed by the official service or runtime',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase3-purge-mixed-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100','-100',['moderation']);const fake=new ModerationPurgeService(store,policy,new FakePurgeGateway(),()=>NOW);await fake.observe({chatId:'-100',messageId:10,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});const job=await fake.preview('100','-100',{limit:1});await fake.confirm('100',job.id);
   let calls=0;const request=(async()=>{calls++;throw Error('network forbidden');}) as typeof fetch,before=await store.snapshot();await assert.rejects(createPhase3ModerationRuntime(store,policy,TOKEN,request),/PHASE3_UNPROVEN_DELETE_HISTORY/);assert.deepEqual(await store.snapshot(),before);const live=new ModerationPurgeService(store,policy,new TelegramBotApiPurgeGateway(TOKEN,request,async()=>true),()=>NOW);assert.equal((await live.dispatchNext(job.id)).status,'BLOCKED');assert.equal(calls,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' official purge review cannot survive a gateway method replacement',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'purge-origin-shadow-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100','-100',['moderation']);let calls=0;const request=(async()=>{calls++;throw Error('network forbidden');}) as typeof fetch,gateway=new TelegramBotApiPurgeGateway(TOKEN,request,async()=>true),service=new ModerationPurgeService(store,policy,gateway,()=>NOW);await service.observe({chatId:'-100',messageId:10,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});const job=await service.preview('100','-100',{limit:1});await service.confirm('100',job.id);gateway.deleteMessage=async()=> 'ACKNOWLEDGED';assert.equal(TelegramBotApiPurgeGateway.isOfficial(gateway),false);assert.equal((await service.dispatchNext(job.id)).status,'BLOCKED');assert.equal(calls,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
