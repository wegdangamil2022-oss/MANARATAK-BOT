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
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4ServiceCleanupDispatcher} from '../src/phase4-service-cleanup.js';
import {parsePhase4CommunityCommand} from '../src/phase4-community-ui.js';
import {defaultCommunityConfig,validCommunityConfig} from '../src/phase4-community-model.js';

const GROUP='-1001234',OWNER='100',STUDENT='300';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-reply-cleanup-')),file=join(dir,engine==='json'?'state.json':'state.sqlite');
 let now=1_800_000;const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.setPresence(GROUP,true);
 const community=new Phase4CommunityService(store,policy,clock),education=new EducationService(store,policy,clock);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',community,clock});
 const apply=async(request:Parameters<Phase4CommunityService['pending']>[1])=>
  community.approve(OWNER,(await community.pending(OWNER,request,GROUP)).id);
 const plan=async(id:number)=>{
  const inbound={update_id:id,message:{message_id:id,
   chat:{id:Number(GROUP),type:'supergroup',title:'منارتك'},
   from:{id:Number(STUDENT),is_bot:false,first_name:'طالب'},text:'منحة'}};
  const reply=await app.handle(inbound);assert.equal(reply.status,'APPLIED');assert.ok(reply.deliveryKey);
  return reply.deliveryKey!;
 };
 const prepare=async()=>{
  await apply({kind:'REPLY_ADD',match:'WORD',trigger:'منحة',text:'راجع الدليل'});
  await apply({kind:'REPLIES_ON'});
 };
 return {dir,file,store,policy,community,apply,prepare,plan,clock,
  advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}

test('P4 reply cleanup commands are strict and default setting is disabled',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/replycleanup '+GROUP+' 45'),{
  kind:'EDIT',chatId:GROUP,request:{kind:'REPLY_CLEANUP_DELAY',delayMs:45000}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/replycleanupon '+GROUP),{
  kind:'EDIT',chatId:GROUP,request:{kind:'REPLY_CLEANUP_ON'}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/replycleanupoff '+GROUP),{
  kind:'EDIT',chatId:GROUP,request:{kind:'REPLY_CLEANUP_OFF'}
 });
 assert.equal(parsePhase4CommunityCommand('/replycleanup '+GROUP+' 0'),null);
 assert.equal(parsePhase4CommunityCommand('/replycleanup '+GROUP+' 3601'),null);
 assert.equal(validCommunityConfig(defaultCommunityConfig(GROUP)),true);
 assert.equal(validCommunityConfig({...defaultCommunityConfig(GROUP),
  replyCleanup:{enabled:true,delayMs:10000}}),false);
});

for(const engine of ['json','sqlite'] as const){
 test('P4 '+engine+': only confirmed bot-owned replies enqueue one delayed deletion after owner approval',async()=>{
  const f=await fixture(engine);try{
   await f.prepare();
   await f.apply({kind:'REPLY_CLEANUP_ON'});
   await f.apply({kind:'REPLY_CLEANUP_DELAY',delayMs:30000});
   await assert.rejects(f.community.pending(STUDENT,{kind:'REPLY_CLEANUP_OFF'},GROUP),/COMMUNITY_OWNER_DENIED/);
   const deliveryKey=await f.plan(1001);
   let sends=0,deletes=0;
   const sender=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{
    sends++;return {status:'CONFIRMED',messageId:777};}},f.clock);
   assert.equal((await sender.dispatch(deliveryKey)).status,'CONFIRMED');
   assert.equal(sends,1);
   assert.equal((await sender.dispatch(deliveryKey)).status,'SENT');
   assert.equal(sends,1);
   const jobs=(await f.store.snapshot()).phase4Community?.cleanupJobs??[];
   assert.equal(jobs.length,1);
   assert.equal(jobs[0]?.kind,'AUTOMATIC_REPLY');
   assert.equal(jobs[0]?.messageId,777);
   assert.equal(jobs[0]?.status,'QUEUED');
   assert.equal(jobs[0]?.dueAt,f.clock()+30000);
   const gateway={canDelete:async()=>true,deleteMessage:async(chatId:string,messageId:number)=>{
    deletes++;assert.equal(chatId,GROUP);assert.equal(messageId,777);return 'CONFIRMED' as const;}};
   const dispatcher=new Phase4ServiceCleanupDispatcher(f.store,f.policy,gateway,f.clock);
   assert.equal((await dispatcher.runDue()).attempted,0);
   f.advance(30001);
   assert.deepEqual((await dispatcher.runDue()).results,['CONFIRMED']);
   assert.equal((await dispatcher.runDue()).attempted,0);
   assert.equal(deletes,1);
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.cleanupJobs?.[0]?.status,'CONFIRMED');
  }finally{await f.close()}
 });
 test('P4 '+engine+': disabled cleanup or ambiguous send never creates a deletion intent',async()=>{
  const f=await fixture(engine);try{
   await f.prepare();
   const key=await f.plan(2001);
   const sender=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>({
    status:'CONFIRMED',messageId:901
   })},f.clock);
   assert.equal((await sender.dispatch(key)).status,'CONFIRMED');
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length??0,0);
   await f.apply({kind:'REPLY_CLEANUP_ON'});
   f.advance(9000);
   const unknownKey=await f.plan(2002);
   const unknown=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>({
    status:'UNKNOWN_OUTCOME'
   })},f.clock);
   assert.equal((await unknown.dispatch(unknownKey)).status,'UNKNOWN_OUTCOME');
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length??0,0);
  }finally{await f.close()}
 });
 test('P4 '+engine+': reviewed policy change after confirmation prevents destructive old cleanup',async()=>{
  const f=await fixture(engine);try{
   await f.prepare();
   await f.apply({kind:'REPLY_CLEANUP_ON'});
   const key=await f.plan(3001);
   const sender=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>({
    status:'CONFIRMED',messageId:888
   })},f.clock);
   await sender.dispatch(key);
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.[0]?.status,'QUEUED');
   await f.apply({kind:'REPLY_CLEANUP_OFF'});
   f.advance(120001);
   let attempts=0;
   const dispatcher=new Phase4ServiceCleanupDispatcher(f.store,f.policy,{
    canDelete:async()=>true,deleteMessage:async()=>{attempts++;return 'CONFIRMED';}
   },f.clock);
   assert.deepEqual((await dispatcher.runDue()).results,['SKIPPED']);
   assert.equal(attempts,0);
  }finally{await f.close()}
 });
}
