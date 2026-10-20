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
import {FakeMembershipGateway,SubscriptionGate} from '../src/subscription.js';
import {FakeModerationGateway,ModerationService} from '../src/moderation.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
import {parseOwnerGroupAction} from '../src/telegram-owner-groups.js';

const OWNER='100',CHAT='-100111',CHANNEL_A='-100222',CHANNEL_B='-100333';
const message=(id:number,text:string,actor=100,group=false)=>({
 update_id:id,message:{message_id:id,chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
const labels=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-sub-ui-')),file=join(dir,engine==='sqlite'?'db.sqlite':'db.json');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 for(const id of [CHAT,CHANNEL_A,CHANNEL_B])await policy.approveChat(OWNER,id,['navigation','verification']);
 const fake=new FakeMembershipGateway();
 const mod=new ModerationService(store,policy,new FakeModerationGateway());
 const gate=new SubscriptionGate(store,policy,fake,mod);
 await gate.configure(OWNER,CHAT,[CHANNEL_A,CHANNEL_B],'ALL');
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
   botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,file,store,policy,gate,app,fake,close:()=>rm(dir,{recursive:true,force:true})};
}
test('owner group detail shows actual saved subscription channels, ALL/ANY and distinct verification limits',async()=>{
 const f=await fixture();try{
  const r=await f.app().handle(message(1,'🏷️ محادثة · '+CHAT));
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/اشتراك/);
  assert.match(r.plan?.text??'',/ALL/);
  assert.match(r.plan?.text??'',/2/);
  assert.ok(labels(r).some(b=>b.startsWith('🧊 مراجعة تعليق الاشتراك · '+CHAT+':')));
  assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
  const d=await f.app().handle(message(2,'📋 تفاصيل الاشتراك · '+CHAT));
  assert.equal(d.status,'APPLIED');assert.match(d.plan?.text??'',/ALL/);
  assert.match(d.plan?.text??'',new RegExp(CHANNEL_A));
  assert.match(d.plan?.text??'',new RegExp(CHANNEL_B));
  assert.match(d.plan?.text??'',/ليس.*Telegram|لا.*تحقق.*حي/);
  assert.equal(isValidTelegramReplyKeyboard(d.plan?.replyMarkup),true);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('owner '+engine+': explicit subscription suspension clears requirements without unmuting or Telegram calls',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot(),c=before.chats.find(x=>x.id===CHAT)!;
   const config=before.subscriptionRequirements.find(x=>x.chatId===CHAT)!;
   await f.store.transaction(s=>s.moderationReasons.push({
    chatId:CHAT,memberId:'400',source:'SUBSCRIPTION',reference:'subscription-gate',
    kind:'MUTE',createdBy:'100',active:true
   }));
   const detail=await f.app().handle(message(3,'🏷️ محادثة · '+CHAT));
   const review=labels(detail).find(x=>x.startsWith('🧊 مراجعة تعليق الاشتراك · '))!;
   const preview=await f.app().handle(message(4,review));
   assert.equal(preview.status,'APPLIED');
   assert.equal((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds.length,2);
   assert.ok(labels(preview).some(x=>x.startsWith('✅ تأكيد تعليق الاشتراك · ')));
   const confirm=labels(preview).find(x=>x.startsWith('✅ تأكيد تعليق الاشتراك · '))!;
   const done=await f.app().handle(message(5,confirm));
   assert.equal(done.status,'APPLIED');assert.match(done.plan?.text??'',/محلي/);
   const after=await f.store.snapshot();
   assert.deepEqual(after.subscriptionRequirements[0]!.channelIds,[]);
   assert.equal(after.subscriptionRequirements[0]!.version,config.version+1);
   assert.equal(after.chats.find(x=>x.id===CHAT)!.version,c.version+1);
   assert.equal(after.moderationReasons[0]!.active,true);
   assert.equal(after.moderationOperations.length,0);
   assert.equal((await f.gate.verify(CHAT,'400')).status,'NOT_REQUIRED');
   assert.equal((await f.app().handle(message(6,confirm))).status,'DENIED');
  }finally{await f.close();}
 });
}
test('owner suspension CAS fails stale when subscription version changes even if chat version stays same',async()=>{
 const f=await fixture();try{
  const before=await f.store.snapshot(),rev=before.chats.find(c=>c.id===CHAT)!.version;
  const config=before.subscriptionRequirements[0]!;
  const button='✅ تأكيد تعليق الاشتراك · '+CHAT+':'+rev+':'+config.version;
  await f.gate.configure(OWNER,CHAT,[CHANNEL_A],'ANY');
  const stale=await f.app().handle(message(7,button));
  assert.equal(stale.status,'DENIED');
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[CHANNEL_A]);
 }finally{await f.close();}
});
test('owner suspension CAS fails stale when group policy changed or verification disabled',async()=>{
 const f=await fixture();try{
  const before=await f.store.snapshot(),rev=before.chats.find(c=>c.id===CHAT)!.version;
  const config=before.subscriptionRequirements[0]!.version;
  await f.policy.approveChat(OWNER,CHAT,['navigation','verification']);
  await assert.rejects(f.policy.pauseSubscriptionAtRevision(OWNER,CHAT,rev,config),/STALE/);
  await f.policy.restrictChatScopeAtRevision(OWNER,CHAT,'verification',rev+1);
  await assert.rejects(f.policy.pauseSubscriptionAtRevision(OWNER,CHAT,rev+2,config),/NOT_APPROVED|NO_VERIFICATION|NOT_ACTIVE/);
 }finally{await f.close();}
});
test('owner-only UI prevents student/delegate/group actor view or mutation by copied message labels',async()=>{
 const f=await fixture();try{
  const d=await f.app().handle(message(10,'🏷️ محادثة · '+CHAT));
  const review=labels(d).find(x=>x.startsWith('🧊 مراجعة تعليق الاشتراك · '))!;
  const prev=await f.app().handle(message(11,review));
  const confirm=labels(prev).find(x=>x.startsWith('✅ تأكيد تعليق الاشتراك · '))!;
  const all=['📋 تفاصيل الاشتراك · '+CHAT,review,confirm];
  for(const [i,button] of all.entries())for(const actor of [200,300]){
   const result=await f.app().handle(message(30+i*10+actor,button,actor));
   assert.equal(result.status,'DENIED',button);assert.equal(result.plan,undefined);
  }
  const ingroup=await f.app().handle(message(100,confirm,100,true));
  assert.equal(ingroup.plan,undefined);
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[CHANNEL_A,CHANNEL_B]);
 }finally{await f.close();}
});
test('subscription UI parser rejects malformed IDs, versions, extra claims and activation labels',async()=>{
 for(const s of ['📋 تفاصيل الاشتراك · '+CHAT,
   '🧊 مراجعة تعليق الاشتراك · '+CHAT+':1:2',
   '✅ تأكيد تعليق الاشتراك · '+CHAT+':1:2'])assert.ok(parseOwnerGroupAction(s),s);
 for(const s of ['📋 تفاصيل الاشتراك · @channel',
   '✅ تأكيد تعليق الاشتراك · '+CHAT+':01:2',
   '✅ تأكيد تعليق الاشتراك · '+CHAT+':1:0',
   '✅ تأكيد تعليق الاشتراك · '+CHAT+':1:2:3',
   '✅ تأكيد تعليق الاشتراك · '+CHAT+':1:2\n',
   '✅ تفعيل الاشتراك · '+CHAT+':1:2'])assert.equal(parseOwnerGroupAction(s),null,s);
});
test('no subscription config: detail explicitly says not configured and offers no suspension control',async()=>{
 const f=await fixture();try{
  await f.policy.pauseSubscriptionAtRevision(OWNER,CHAT,1,1);
  const r=await f.app().handle(message(110,'🏷️ محادثة · '+CHAT));
  assert.match(r.plan?.text??'',/غير مفعّل|معلّق|لا توجد/);
  assert.equal(labels(r).some(x=>x.includes('مراجعة تعليق الاشتراك')),false);
 }finally{await f.close();}
});
test('policy: revoking group or verification scope permanently clears saved subscription requirements',async()=>{
 const f=await fixture();try{
  const old=(await f.store.snapshot()).subscriptionRequirements[0]!.version;
  await f.policy.restrictChatScopeAtRevision(OWNER,CHAT,'verification',1);
  const x=await f.store.snapshot();
  assert.deepEqual(x.subscriptionRequirements[0]!.channelIds,[]);
  assert.equal(x.subscriptionRequirements[0]!.version,old+1);
  await f.policy.approveChat(OWNER,CHAT,['navigation','verification']);
  assert.equal((await f.gate.verify(CHAT,'400')).status,'NOT_REQUIRED');
  await f.gate.configure(OWNER,CHAT,[CHANNEL_B],'ALL');
  const rev=(await f.store.snapshot()).chats.find(c=>c.id===CHAT)!.version;
  await f.policy.revokeChatAtRevision(OWNER,CHAT,rev);
  await f.policy.approveChat(OWNER,CHAT,['navigation','verification']);
  assert.equal((await f.gate.verify(CHAT,'400')).status,'NOT_REQUIRED');
 }finally{await f.close();}
});
test('policy: revoking mandatory channel approval invalidates subscribing groups fail-closed on reapproval',async()=>{
 const f=await fixture();try{
  await f.policy.revokeChat(OWNER,CHANNEL_A);
  assert.equal((await f.gate.verify(CHAT,'400')).status,'NOT_REQUIRED');
  await f.policy.approveChat(OWNER,CHANNEL_A,['verification']);
  assert.equal((await f.gate.verify(CHAT,'400')).status,'NOT_REQUIRED');
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[]);
 }finally{await f.close();}
});
