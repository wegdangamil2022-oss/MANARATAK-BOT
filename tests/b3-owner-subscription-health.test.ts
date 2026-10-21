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
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
const OWNER='100',GROUP='-100123',CHANNEL='-100200';
const m=(id:number,text:string,actor=100,group=false)=>({
 update_id:id,message:{message_id:id,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
const keys=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function setup(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-health-screen-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','verification']);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 await store.transaction(s=>{
  s.subscriptionRequirements=[{chatId:GROUP,channelIds:[CHANNEL],mode:'ALL',version:1}];
 });
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {store,policy,app,close:()=>rm(dir,{recursive:true,force:true})};
}
test('B3 owner /admin private dashboard offers an actual safely sized subscription integrity button',async()=>{
 const f=await setup();try{
  const r=await f.app().handle(m(1,'🔐 لوحة المالك'));
  assert.equal(r.status,'APPLIED');
  assert.ok(keys(r).includes(ownerMenuLabels.subscriptionHealth));
  assert.ok(keys(r).includes('🏠 الرئيسية'));
  assert.ok(isValidTelegramReplyKeyboard(r.plan?.replyMarkup));
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': owner report has only aggregate local health and current authorized group/channel counts',async()=>{
  const f=await setup(engine);try{
   const before=await f.store.snapshot();
   const r=await f.app().handle(m(2,ownerMenuLabels.subscriptionHealth));
   assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/PASS/);
   assert.match(r.plan?.text??'',/OFFLINE_ONLY/);
   assert.match(r.plan?.text??'',/1/);
   assert.match(r.plan?.text??'',/لا.*تحقق.*حي|ليس.*تحقق.*حي/);
   assert.equal((r.plan?.text??'').includes(GROUP),false);
   assert.equal((r.plan?.text??'').includes(CHANNEL),false);
   assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
   assert.ok(keys(r).includes(ownerMenuLabels.groups));
   const after=await f.store.snapshot();
   assert.deepEqual(after.subscriptionRequirements,before.subscriptionRequirements);
   assert.deepEqual(after.chats,before.chats);
   assert.deepEqual(after.moderationReasons,before.moderationReasons);
   // Telegram ingress correctly appends its own one-shot reply/outbox audit.
  }finally{await f.close();}
 });
}
test('B3 owner report re-checks fresh state every tap and warns of revoked channel without exposing IDs',async()=>{
 const f=await setup();try{
  const healthy=await f.app().handle(m(3,ownerMenuLabels.subscriptionHealth));
  assert.match(healthy.plan?.text??'',/PASS/);
  await f.store.transaction(s=>{s.chats.find(c=>c.id===CHANNEL)!.scopes=[];});
  const blocked=await f.app().handle(m(4,ownerMenuLabels.subscriptionHealth));
  assert.equal(blocked.status,'APPLIED');assert.match(blocked.plan?.text??'',/BLOCKED/);
  assert.match(blocked.plan?.text??'',/CHANNEL_NOT_VERIFIABLE/);
  assert.ok(!(blocked.plan?.text??'').includes(CHANNEL));
  assert.ok(!(blocked.plan?.text??'').includes(GROUP));
  assert.equal(isValidTelegramReplyKeyboard(blocked.plan?.replyMarkup),true);
 }finally{await f.close();}
});
test('B3 owner health screen has no activation, repair, unmute or apply button',async()=>{
 const f=await setup();try{
  await f.store.transaction(s=>{s.chats.find(c=>c.id===GROUP)!.approved=false;});
  const r=await f.app().handle(m(5,ownerMenuLabels.subscriptionHealth));
  const labels=keys(r);
  assert.ok(labels.length>=2);
  assert.equal(labels.some(t=>/RUN|تفعيل|إصلاح تلقائي|إزالة كل|فك كتم|نشر/.test(t)),false);
  assert.equal((r.plan?.text??'').includes(GROUP),false);
  assert.match(r.plan?.text??'',/GROUP_NOT_VERIFIABLE/);
 }finally{await f.close();}
});
test('B3 students and delegated staff cannot inspect aggregate owner subscription health or forge its label',async()=>{
 const f=await setup();try{
  await f.policy.grant(OWNER,'200','content.publish',GROUP,Date.now()+100000);
  for(const [i,actor] of [200,300].entries()){
   const r=await f.app().handle(m(10+i,ownerMenuLabels.subscriptionHealth,actor));
   assert.equal(r.status,'DENIED');assert.equal(r.plan,undefined);
  }
  assert.equal((await f.app().handle(m(12,ownerMenuLabels.subscriptionHealth,100,true))).plan,undefined);
 }finally{await f.close();}
});
test('B3 owner audit counts paused rules without reactivation; reads only and reveals no raw moderation reasons',async()=>{
 const f=await setup('sqlite');try{
  await f.policy.pauseSubscriptionAtRevision(OWNER,GROUP,1,1);
  await f.store.transaction(s=>s.moderationReasons.push({
   chatId:GROUP,memberId:'300',source:'SUBSCRIPTION',reference:'subscription-gate',
   kind:'MUTE',createdBy:OWNER,active:true
  }));
  const state=await f.store.snapshot();
  const r=await f.app().handle(m(20,ownerMenuLabels.subscriptionHealth));
  assert.match(r.plan?.text??'',/PASS/);
  assert.match(r.plan?.text??'',/المعلّقة.*1|غير النشطة.*1/);
  assert.equal((r.plan?.text??'').includes('300'),false);
  const after=await f.store.snapshot();
  assert.deepEqual(after.subscriptionRequirements,state.subscriptionRequirements);
  assert.deepEqual(after.moderationReasons,state.moderationReasons);
  assert.deepEqual(after.chats,state.chats);
 }finally{await f.close();}
});
