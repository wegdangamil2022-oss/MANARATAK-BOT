import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {defaultCommunityConfig,validCommunityConfig,inCommunityQuietHours} from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand} from '../src/phase4-community-ui.js';
import {groupMenuEpochDigest} from '../src/telegram-group-access.js';

const GROUP='-1001234',OWNER='100',NOW=Date.parse('2026-11-04T23:30:00.000Z');
const message=(actorId:string,topicId?:number)=>({
 kind:'TEXT' as const,chatId:GROUP,actorId,memberName:'طالب',groupName:'منارتك',
 messageText:'منحة',...(topicId===undefined?{}:{topicId})
});
async function fixture(engine:'json'|'sqlite',startAt=NOW){
 const dir=await mkdtemp(join(tmpdir(),'p4-quiet-topic-')),file=join(dir,engine==='json'?'state.json':'state.sqlite');
 let now=startAt;
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.setPresence(GROUP,true);
 const service=new Phase4CommunityService(store,policy,clock);
 const apply=async(request:Parameters<Phase4CommunityService['pending']>[1])=>
  service.approve(OWNER,(await service.pending(OWNER,request,GROUP)).id);
 return {dir,store,policy,service,apply,clock,set:(n:number)=>{now=n;},
  close:()=>rm(dir,{recursive:true,force:true})};
}

test('P4 quiet hours: overnight, same-day, start-inclusive end-exclusive, local offset and invalid ranges',()=>{
 const config=defaultCommunityConfig(GROUP);
 assert.equal(validCommunityConfig({...config,quietHours:{startMinute:1320,endMinute:420}}),true);
 assert.equal(validCommunityConfig({...config,quietHours:{startMinute:100,endMinute:100}}),false);
 assert.equal(validCommunityConfig({...config,quietHours:{startMinute:-1,endMinute:100}}),false);
 assert.equal(validCommunityConfig({...config,quietHours:{startMinute:100,endMinute:1440}}),false);
 assert.equal(inCommunityQuietHours({startMinute:120,endMinute:240},NOW,180),true);
 assert.equal(inCommunityQuietHours({startMinute:120,endMinute:240},Date.parse('2026-11-05T01:00:00Z'),180),false);
 assert.equal(inCommunityQuietHours({startMinute:1320,endMinute:420},Date.parse('2026-11-04T23:00:00Z'),180),true);
 assert.equal(inCommunityQuietHours({startMinute:1320,endMinute:420},Date.parse('2026-11-05T04:00:00Z'),180),false);
 assert.equal(inCommunityQuietHours({startMinute:420,endMinute:1320},Date.parse('2026-11-05T04:00:00Z'),180),true);
});

test('P4 community commands: owner-reviewed quiet hours and scoped topic rate reject unsafe inputs',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/replyquiet '+GROUP+' 02:00 04:00'),{
  kind:'EDIT',chatId:GROUP,request:{kind:'QUIET_HOURS_SET',startMinute:120,endMinute:240}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/replyquietoff '+GROUP),{
  kind:'EDIT',chatId:GROUP,request:{kind:'QUIET_HOURS_CLEAR'}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/replytopicrate '+GROUP+' 777 2'),{
  kind:'EDIT',chatId:GROUP,request:{kind:'TOPIC_COOLDOWN_SET',topicId:777,cooldownMs:2000}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/replytopicclear '+GROUP+' 777'),{
  kind:'EDIT',chatId:GROUP,request:{kind:'TOPIC_COOLDOWN_CLEAR',topicId:777}
 });
 for(const bad of [
  '/replyquiet '+GROUP+' 25:00 04:00',
  '/replyquiet '+GROUP+' 02:00 02:00',
  '/replyquiet '+GROUP+' 03:60 04:00',
  '/replytopicrate '+GROUP+' 0 2',
  '/replytopicrate '+GROUP+' 777 0',
  '/replytopicrate '+GROUP+' 777 601',
  '/replytopicclear '+GROUP+' 0'
 ])assert.equal(parsePhase4CommunityCommand(bad),null,bad);
});

for(const engine of ['json','sqlite'] as const){
 test('P4 '+engine+': quiet hours block text replies but not joining, persist and invalidate queued epoch',async()=>{
  const f=await fixture(engine);try{
   await f.apply({kind:'REPLY_ADD',match:'WORD',trigger:'منحة',text:'أهلًا'});
   await f.apply({kind:'REPLIES_ON'});
   await f.apply({kind:'WELCOME_ON'});
   const before=groupMenuEpochDigest(await f.store.snapshot(),GROUP);
   const draft=await f.service.pending(OWNER,{kind:'QUIET_HOURS_SET',startMinute:120,endMinute:240},GROUP);
   assert.equal((await f.service.view(OWNER,GROUP)).quietHours,undefined);
   await f.service.approve(OWNER,draft.id);
   assert.notEqual(groupMenuEpochDigest(await f.store.snapshot(),GROUP),before);
   assert.equal((await f.service.diagnose(OWNER,GROUP,'منحة')).status,'QUIET_HOURS');
   assert.equal(await f.service.propose(message('301'),'b3-webhook:bot-main:100'),null);
   const joined=await f.service.propose({kind:'JOIN',chatId:GROUP,actorId:'302',memberName:'ضيف',groupName:'منارتك'},
    'b3-webhook:bot-main:101');
   assert.ok(joined?.text);
   f.set(Date.parse('2026-11-05T01:00:00Z'));
   assert.equal((await f.service.diagnose(OWNER,GROUP,'منحة')).status,'MATCH');
   assert.ok(await f.service.propose(message('303'),'b3-webhook:bot-main:102'));
   const restored=new Phase4CommunityService(new BotStore(join(f.dir,engine==='json'?'state.json':'state.sqlite'),{engine}),f.policy,f.clock);
   assert.deepEqual((await restored.view(OWNER,GROUP)).quietHours,{startMinute:120,endMinute:240});
   await f.apply({kind:'QUIET_HOURS_CLEAR'});
   assert.equal((await f.service.view(OWNER,GROUP)).quietHours,undefined);
  }finally{await f.close()}
 });
 test('P4 '+engine+': per-topic limits isolate topics without breaking group-wide flood cap',async()=>{
  const f=await fixture(engine);try{
   await f.apply({kind:'REPLY_ADD',match:'WORD',trigger:'منحة',text:'أهلًا'});
   await f.apply({kind:'REPLIES_ON'});
   await f.apply({kind:'TOPIC_COOLDOWN_SET',topicId:777,cooldownMs:2000});
   await f.apply({kind:'TOPIC_COOLDOWN_SET',topicId:888,cooldownMs:2000});
   const first=await f.service.propose(message('301',777),'b3-webhook:bot-main:1');
   assert.ok(first);
   f.set(NOW+1000);
   const anotherTopic=await f.service.propose(message('302',888),'b3-webhook:bot-main:2');
   assert.ok(anotherTopic,'another topic has a separate cooldown');
   assert.equal(await f.service.propose(message('303',777),'b3-webhook:bot-main:3'),null);
   f.set(NOW+2100);
   assert.ok(await f.service.propose(message('304',777),'b3-webhook:bot-main:4'));
   assert.deepEqual((await f.service.view(OWNER,GROUP)).topicCooldowns,[
    {topicId:777,cooldownMs:2000},{topicId:888,cooldownMs:2000}
   ]);
   await f.apply({kind:'TOPIC_COOLDOWN_CLEAR',topicId:777});
   assert.deepEqual((await f.service.view(OWNER,GROUP)).topicCooldowns,[{topicId:888,cooldownMs:2000}]);
   // The global eight-per-minute cap still protects the group even when topics have custom rates.
   for(let i=0;i<20;i++){f.set(NOW+4000+i*2100);
    await f.service.propose(message(String(500+i),i%2?777:888),'b3-webhook:bot-main:'+(10+i));
   }
   const active=(await f.store.snapshot()).phase4Community?.receipts.filter(x=>x.at>=NOW)??[];
   assert.ok(active.length<=8);
   assert.ok(active.some(x=>x.topicId===777));
  }finally{await f.close()}
 });
 test('P4 '+engine+': invalid or stale topic configurations are rejected atomically',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.service.pending(OWNER,{kind:'TOPIC_COOLDOWN_SET',topicId:0,cooldownMs:1000},GROUP),/COMMUNITY_TOPIC_INVALID/);
   await assert.rejects(f.service.pending(OWNER,{kind:'QUIET_HOURS_SET',startMinute:60,endMinute:60},GROUP),/COMMUNITY_QUIET_HOURS_INVALID/);
   const old=await f.service.pending(OWNER,{kind:'TOPIC_COOLDOWN_SET',topicId:777,cooldownMs:3000},GROUP);
   await f.apply({kind:'QUIET_HOURS_SET',startMinute:120,endMinute:240});
   await assert.rejects(f.service.approve(OWNER,old.id),/COMMUNITY_DRAFT_NOT_FOUND|COMMUNITY_DRAFT_STALE/);
  }finally{await f.close()}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('P4 '+engine+': text reply queued before quiet hour must not send after crossing the quiet boundary',async()=>{
  const t0=Date.parse('2026-11-04T22:59:30Z');
  const f=await fixture(engine,t0);try{
   await f.apply({kind:'REPLY_ADD',match:'WORD',trigger:'منحة',text:'أهلًا'});
   await f.apply({kind:'REPLIES_ON'});
   await f.apply({kind:'QUIET_HOURS_SET',startMinute:120,endMinute:240});
   const education=new EducationService(f.store,f.policy,f.clock);
   const admin=new EducationAdminFacade(f.store,f.policy,education);
   const faq=new ApprovedAnswerService(f.store,f.policy),links=new ResourceLinkService(f.store,f.policy);
   const app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin,faq,links,
    botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',
    community:f.service,clock:f.clock});
   const inbound={update_id:987654,message:{message_id:987654,
    chat:{id:Number(GROUP),type:'supergroup',title:'منارتك'},
    from:{id:301,is_bot:false,first_name:'طالب'},text:'منحة'}};
   const queued=await app.handle(inbound);
   assert.equal(queued.status,'APPLIED');
   assert.ok(queued.deliveryKey);
   const stored=(await f.store.snapshot()).telegramReplyJobs?.find(x=>x.updateKey===queued.deliveryKey);
   assert.deepEqual(stored?.communityAutomation,{kind:'TEXT',configVersion:3});
   f.set(Date.parse('2026-11-04T23:00:00Z'));
   let sent=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{
    send:async()=>{sent++;return {status:'CONFIRMED',messageId:987};}
   },f.clock);
   assert.equal((await dispatcher.dispatch(queued.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(sent,0);
   assert.equal((await dispatcher.dispatch(queued.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.find(x=>x.updateKey===queued.deliveryKey)?.status,'FAILED_CONFIRMED');
  }finally{await f.close()}
 });
}
