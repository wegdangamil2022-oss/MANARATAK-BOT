import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4LectureService} from '../src/phase4-lectures.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';

const OWNER='100',GROUP='-1001234',STUDENT=300,NOW=1_700_000_000_000;
for(const engine of ['json','sqlite'] as const){
 test('LECTURE-006 '+engine+': previously queued automatic reply cannot pass send gate after lecture activation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lecture-dispatch-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   await policy.setPresence(GROUP,true);
   const community=new Phase4CommunityService(store,policy,()=>now);
   const add=await community.pending(OWNER,{kind:'REPLY_ADD',
    trigger:'منحة',match:'WORD',text:'راجع صفحة المنح الرسمية'},GROUP);
   await community.approve(OWNER,add.id);
   await community.approve(OWNER,(await community.pending(OWNER,{kind:'REPLIES_ON'},GROUP)).id);
   const education=new EducationService(store,policy,()=>now);
   const admin=new EducationAdminFacade(store,policy,education);
   const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
   const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
    botId:'bot-main',botUsername:'ManaratakBot',clock:()=>now,
    community,membership:async()=> 'VERIFIED'});
   const event=(n:number)=>({update_id:n,message:{message_id:n,
    chat:{id:Number(GROUP),type:'supergroup',title:'منارتك'},text:'منحة دراسية',
    from:{id:STUDENT,is_bot:false,first_name:'طالب'}}});
   const queued=await app.handle(event(870));
   assert.equal(queued.status,'APPLIED');
   assert.ok(queued.deliveryKey);
   const lecture=new Phase4LectureService(store,policy,()=>now);
   const draft=await lecture.draft(OWNER,GROUP,30);
   assert.equal(await lecture.start(OWNER,draft.id,1),true);
   assert.equal((await community.diagnose(OWNER,GROUP,'منحة دراسية')).status,'LECTURE_MODE');
   let sendCount=0;
   const dispatcher=new TelegramReplyDispatcher(store,policy,{
    send:async()=>{sendCount++;return {status:'CONFIRMED' as const,messageId:870};}
   },()=>now);
   assert.equal((await dispatcher.dispatch(queued.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(sendCount,0);
   assert.equal((await dispatcher.dispatch(queued.deliveryKey!)).status,'FAILED_CONFIRMED');
   now+=30*60_000+1;
   assert.equal((await community.diagnose(OWNER,GROUP,'منحة دراسية')).status,'MATCH');
   const newReply=await app.handle(event(871));
   assert.ok(newReply.deliveryKey);
   assert.equal((await dispatcher.dispatch(newReply.deliveryKey!)).status,'CONFIRMED');
   assert.equal(sendCount,1);
   const rows=(await store.snapshot()).telegramReplyJobs??[];
   assert.equal(rows.some(x=>x.updateKey===queued.deliveryKey&&x.status==='SENT'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('LECTURE-007 '+engine+': lecture never suspends subscription gating or silently rewrites existing rule',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lecture-policy-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   const original=await store.snapshot();
   const lecture=new Phase4LectureService(store,policy,()=>now);
   const draft=await lecture.draft(OWNER,GROUP,45);
   await lecture.start(OWNER,draft.id,1);
   const snap=await store.snapshot();
   assert.deepEqual(snap.chats,original.chats);
   assert.deepEqual(snap.subscriptionRequirements,original.subscriptionRequirements);
   await policy.revokeChat(OWNER,GROUP);
   assert.equal(await lecture.stop(OWNER,draft.id,2),false);
   now+=45*60_000+1;
   await lecture.expire();
   assert.equal((await store.snapshot()).phase4Lectures?.sessions[0]?.status,'ENDED');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
