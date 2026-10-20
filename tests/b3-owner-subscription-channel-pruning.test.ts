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
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {parseOwnerGroupAction} from '../src/telegram-owner-groups.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const OWNER='100',CHAT='-100100',CHANNEL_A='-100201',CHANNEL_B='-100202',CHANNEL_C='-100203';
const message=(id:number,text:string,actor=100)=>({
 update_id:id,message:{message_id:id,chat:{id:actor,type:'private'},
 from:{id:actor,is_bot:false},text}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-prune-channel-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER),edu=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,edu);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 for(const id of [CHAT,CHANNEL_A,CHANNEL_B,CHANNEL_C])await policy.approveChat(OWNER,id,['verification','navigation']);
 const fake=new FakeMembershipGateway();
 const gateway=new FakeModerationGateway();
 const gate=new SubscriptionGate(store,policy,fake,new ModerationService(store,policy,gateway));
 await gate.configure(OWNER,CHAT,[CHANNEL_A,CHANNEL_B,CHANNEL_C],'ALL');
 const app=()=>new TelegramUpdateApplication({store,policy,education:edu,admin,faq,links,
 botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,store,policy,fake,gate,gateway,app,close:()=>rm(dir,{recursive:true,force:true})};
}
test('B3 mandatory channel detail offers a real bounded, owner-only remove-channel review button per saved channel',async()=>{
 const f=await fixture();try{
  const r=await f.app().handle(message(1,'📋 تفاصيل الاشتراك · '+CHAT));
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/ALL/);
  const keys=buttons(r);
  assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
  for(const ch of [CHANNEL_A,CHANNEL_B,CHANNEL_C])
   assert.ok(keys.some(x=>x.startsWith('🧹 مراجعة إزالة قناة · '+CHAT+':'+ch+':')),ch);
  assert.equal((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds.length,3);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+' removing one required channel is staged, CAS, auditable, and leaves remaining channels and moderation untouched',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationReasons.push({
    chatId:CHAT,memberId:'400',source:'SUBSCRIPTION',reference:'subscription-gate',
    kind:'MUTE',createdBy:OWNER,active:true
   }));
   const before=await f.store.snapshot(),chat=before.chats.find(c=>c.id===CHAT)!;
   const rule=before.subscriptionRequirements[0]!;
   const screen=await f.app().handle(message(2,'📋 تفاصيل الاشتراك · '+CHAT));
   const review=buttons(screen).find(x=>x.startsWith('🧹 مراجعة إزالة قناة · '+CHAT+':'+CHANNEL_B+':'))!;
   assert.ok(review);
   const preview=await f.app().handle(message(3,review));
   assert.equal(preview.status,'APPLIED');assert.match(preview.plan?.text??'',/مراجعة إزالة/);
   assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[CHANNEL_A,CHANNEL_B,CHANNEL_C]);
   const confirm=buttons(preview).find(x=>x.startsWith('✅ تأكيد إزالة قناة · '))!;
   const applied=await f.app().handle(message(4,confirm));
   assert.equal(applied.status,'APPLIED');assert.match(applied.plan?.text??'',/محلي/);
   const after=await f.store.snapshot();
   assert.deepEqual(after.subscriptionRequirements[0]!.channelIds,[CHANNEL_A,CHANNEL_C]);
   assert.equal(after.subscriptionRequirements[0]!.version,rule.version+1);
   assert.equal(after.subscriptionRequirements[0]!.mode,'ALL');
   assert.equal(after.chats.find(c=>c.id===CHAT)!.version,chat.version+1);
   assert.equal(after.moderationReasons[0]!.active,true);
   assert.equal(after.moderationOperations.length,0);assert.equal(f.gateway.calls.length,0);
   assert.ok(after.audit.some(x=>x.reason==='SUBSCRIPTION_REQUIRED_CHANNEL_REMOVED_LOCALLY'));
   assert.equal((await f.app().handle(message(5,confirm))).status,'DENIED');
  }finally{await f.close();}
 });
}
test('B3 one remaining required channel may be removed explicitly, resulting in locally inactive rule',async()=>{
 const f=await fixture();try{
  await f.gate.configure(OWNER,CHAT,[CHANNEL_A],'ANY');
  const r=await f.app().handle(message(11,'📋 تفاصيل الاشتراك · '+CHAT));
  const review=buttons(r).find(x=>x.includes('🧹 مراجعة إزالة قناة · '))!;
  const preview=await f.app().handle(message(12,review));
  const confirm=buttons(preview).find(x=>x.startsWith('✅ تأكيد إزالة قناة · '))!;
  assert.equal((await f.app().handle(message(13,confirm))).status,'APPLIED');
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[]);
  assert.equal((await f.gate.verify(CHAT,'400')).status,'NOT_REQUIRED');
  const after=await f.app().handle(message(14,'📋 تفاصيل الاشتراك · '+CHAT));
  assert.equal(buttons(after).some(x=>x.startsWith('🧹 مراجعة إزالة قناة')),false);
 }finally{await f.close();}
});
test('B3 owner can never add a required channel by forging a remove button',async()=>{
 const f=await fixture();try{
  for(const [i,ch] of ['-100999','100201','@channel'].entries()){
   const s=(await f.store.snapshot()).subscriptionRequirements[0]!;
   const v=(await f.store.snapshot()).chats.find(x=>x.id===CHAT)!.version;
   const token='✅ تأكيد إزالة قناة · '+CHAT+':'+ch+':'+v+':'+s.version;
   assert.equal((await f.app().handle(message(20+i,token))).status,'DENIED');
  }
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[CHANNEL_A,CHANNEL_B,CHANNEL_C]);
 }finally{await f.close();}
});
test('B3 removal CAS invalidated when another operator changes subscription mode/list or chat policy version',async()=>{
 const f=await fixture();try{
  const before=await f.store.snapshot(),chat=before.chats.find(c=>c.id===CHAT)!;
  const old=before.subscriptionRequirements[0]!;
  const token='✅ تأكيد إزالة قناة · '+CHAT+':'+CHANNEL_A+':'+chat.version+':'+old.version;
  await f.gate.configure(OWNER,CHAT,[CHANNEL_A,CHANNEL_B],'ANY');
  assert.equal((await f.app().handle(message(30,token))).status,'DENIED');
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[CHANNEL_A,CHANNEL_B]);
  const now=(await f.store.snapshot()).subscriptionRequirements[0]!;
  await f.policy.approveChat(OWNER,CHAT,['navigation','verification']);
  await assert.rejects(
   f.gate.removeRequiredChannelAtRevision(OWNER,CHAT,CHANNEL_A,chat.version,now.version),/STALE/);
 }finally{await f.close();}
});
test('B3 channel removal fails closed after group revocation and does not survive re-approval',async()=>{
 const f=await fixture();try{
  const before=await f.store.snapshot(),v=before.chats.find(x=>x.id===CHAT)!.version;
  const rule=before.subscriptionRequirements[0]!.version;
  await f.policy.revokeChatAtRevision(OWNER,CHAT,v);
  assert.equal((await f.app().handle(message(40,'✅ تأكيد إزالة قناة · '+CHAT+':'+CHANNEL_A+':'+v+':'+rule))).status,'DENIED');
  await f.policy.approveChat(OWNER,CHAT,['verification','navigation']);
  assert.equal((await f.app().handle(message(41,'✅ تأكيد إزالة قناة · '+CHAT+':'+CHANNEL_A+':'+v+':'+rule))).status,'DENIED');
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[]);
 }finally{await f.close();}
});
test('B3 verify runtime uses only revised remaining mandatory channels after confirmed removal',async()=>{
 const f=await fixture();try{
  f.fake.set(CHANNEL_A,'400','MEMBER');
  f.fake.set(CHANNEL_B,'400','NOT_MEMBER');
  f.fake.set(CHANNEL_C,'400','MEMBER');
  assert.equal((await f.gate.verify(CHAT,'400')).status,'NOT_MEMBER');
  const current=await f.store.snapshot();
  await f.gate.removeRequiredChannelAtRevision(OWNER,CHAT,CHANNEL_B,
    current.chats.find(c=>c.id===CHAT)!.version,current.subscriptionRequirements[0]!.version);
  const result=await f.gate.verify(CHAT,'400');
  assert.equal(result.status,'MEMBER');
  assert.deepEqual(result.channels,[CHANNEL_A,CHANNEL_C]);
 }finally{await f.close();}
});
test('B3 nonowner/group actor cannot inspect or confirm channel removal by copying exact owner button',async()=>{
 const f=await fixture();try{
  const scr=await f.app().handle(message(50,'📋 تفاصيل الاشتراك · '+CHAT));
  const review=buttons(scr).find(x=>x.includes('🧹 مراجعة إزالة قناة · '))!;
  const p=await f.app().handle(message(51,review));
  const confirm=buttons(p).find(x=>x.startsWith('✅ تأكيد إزالة قناة · '))!;
  for(const [i,s] of [review,confirm].entries())for(const actor of [200,300]){
   const x=await f.app().handle(message(100+i*10+actor,s,actor));
   assert.equal(x.status,'DENIED');assert.equal(x.plan,undefined);
  }
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[CHANNEL_A,CHANNEL_B,CHANNEL_C]);
 }finally{await f.close();}
});
test('B3 button parser enforces exact IDs and revisions, not arbitrary added mode values',()=>{
 const valid='✅ تأكيد إزالة قناة · '+CHAT+':'+CHANNEL_B+':1:1';
 assert.deepEqual(parseOwnerGroupAction(valid),{
  kind:'channelConfirm',chatId:CHAT,channelId:CHANNEL_B,version:1,requirementVersion:1
 });
 for(const token of [
   valid+':ALL',valid+'\n',valid.replace(':1:1',':01:1'),
   valid.replace(CHANNEL_B,'../evil'),valid.replace('✅ تأكيد','✅ إعادة تفعيل'),
   '🧹 مراجعة إزالة قناة · '+CHAT+':'+CHANNEL_B+':0:1'
 ])assert.equal(parseOwnerGroupAction(token),null,token);
});
