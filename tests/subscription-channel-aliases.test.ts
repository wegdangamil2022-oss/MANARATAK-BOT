import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiMembershipGateway} from '../src/telegram-membership.js';
import {recordChannelIdentity} from '../src/subscription-channel-identity.js';
import {SubscriptionRightsMonitor} from '../src/subscription-rights-monitor.js';
import {subscriptionChangeAlerts} from '../src/subscription-change-alert.js';
const NOW=1700000000000,G='-100100',C='-100200',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'channel-aliases-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW,run=true;
  const policy=new Policy(store,'100',()=>now);
  await policy.approveChat('100',G,['verification']);
  await policy.approveChat('100',C,['verification']);
  await store.transaction(s=>s.subscriptionRequirements.push({chatId:G,channelIds:[C],mode:'ALL',version:1}));
  return {dir,store,policy,clock:()=>now,advance:(ms:number)=>{now+=ms;},safe:async()=>run,stop:()=>{run=false;},start:()=>{run=true;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' all active usernames are monitored while primary remains unchanged',async()=>{const f=await fixture();try{
  let identity={username:'mainchannel',activeUsernames:['mainchannel','bonusalias']};
  const gateway={inspectChannelRights:async()=> 'ADMIN' as const,inspectChannelUsername:async()=>identity};
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).filter(a=>a.identityChannel).length,0);
  f.advance(600000);identity={username:'mainchannel',activeUsernames:['mainchannel','bonusalias','thirdalias']};
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  const alerts=subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).filter(a=>a.identityChannel);
  assert.equal(alerts.length,1);assert.equal(alerts[0]!.identityChannel,C);
  const data=JSON.stringify((await f.store.snapshot()).subscriptionChannelIdentities);
  assert.ok(!/mainchannel|bonusalias|thirdalias/u.test(data));
  assert.ok((await f.store.snapshot()).audit.every(a=>!a.reason.includes('thirdalias')));
 }finally{await f.close();}});
 test(engine+' alias reorder and case formatting cannot invent a channel identity change',async()=>{const f=await fixture();try{
  let identity={username:'mainchannel',activeUsernames:['mainchannel','bonusalias','thirdalias']};
  const gateway={inspectChannelRights:async()=> 'ADMIN' as const,inspectChannelUsername:async()=>identity};
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  f.advance(600000);identity={username:'MainChannel',activeUsernames:['ThirdAlias','BONUSALIAS','mainchannel']};
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).length,0);
 }finally{await f.close();}});
 test(engine+' removal of only a secondary alias creates alert for the same numeric channel',async()=>{const f=await fixture();try{
  let identity={username:'mainchannel',activeUsernames:['mainchannel','bonusalias','thirdalias']};
  const gateway={inspectChannelRights:async()=> 'ADMIN' as const,inspectChannelUsername:async()=>identity};
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  f.advance(600000);identity={username:'mainchannel',activeUsernames:['mainchannel','thirdalias']};
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  assert.deepEqual(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).filter(x=>x.identityChannel).map(x=>x.identityChannel),[C]);
  assert.deepEqual((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds,[C]);
 }finally{await f.close();}});
 test(engine+' legacy single username baseline remains stable if new API repeats only primary',async()=>{const f=await fixture();try{
  await f.store.transaction(s=>assert.equal(recordChannelIdentity(s,'100',G,C,1,1,1,'mainchannel',NOW,NOW),true));
  const gateway={inspectChannelRights:async()=> 'ADMIN' as const,inspectChannelUsername:async()=>({username:'mainchannel',activeUsernames:['mainchannel']})};
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).length,0);
 }finally{await f.close();}});
 test(engine+' corrupted or contradictory alias observations do not erase valid baseline',async()=>{const f=await fixture();try{
  await f.store.transaction(s=>assert.equal(recordChannelIdentity(s,'100',G,C,1,1,1,'mainchannel',NOW,NOW),true));
  const before=JSON.stringify((await f.store.snapshot()).subscriptionChannelIdentities);
  const invalid:unknown[]=[
   {username:'mainchannel',activeUsernames:['mainchannel','MAINCHANNEL']},
   {username:'mainchannel',activeUsernames:['bonusalias']},
   {username:'mainchannel',activeUsernames:['mainchannel','\ninvalid']},
   {username:'mainchannel',activeUsernames:['mainchannel',5]},
   {username:'mainchannel',activeUsernames:'not array'},
   {username:'mainchannel',activeUsernames:Array.from({length:110},(_,i)=>'alias'+(10000+i))},
   {username:'bad name',activeUsernames:['mainchannel']},
   {username:'mainchannel',activeUsernames:['mainchannel'],spoofedId:C}
  ];
  for(const item of invalid){await f.store.transaction(s=>assert.equal(recordChannelIdentity(s,'100',G,C,1,1,1,item,NOW,NOW),false));
   assert.equal(JSON.stringify((await f.store.snapshot()).subscriptionChannelIdentities),before);}
  assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).length,0);
 }finally{await f.close();}});
 test(engine+' invalid Telegram active_usernames results are UNKNOWN rather than dropping known aliases',async()=>{const f=await fixture();try{
  let data:Record<string,unknown>={id:Number(C),type:'channel',username:'mainchannel',active_usernames:['mainchannel','bonusalias']};
  const request=(async(_url:unknown,options:RequestInit)=>{const args=JSON.parse(String(options.body));
   assert.equal(args.chat_id,C);return Response.json({ok:true,result:data});}) as typeof fetch;
  const gateway=new TelegramBotApiMembershipGateway(TOKEN,request);
  const good=await gateway.inspectChannelUsername(C);
  assert.deepEqual(good,{username:'mainchannel',activeUsernames:['mainchannel','bonusalias']});
  for(const invalid of [
   {active_usernames:['mainchannel','MAINCHANNEL']},
   {active_usernames:['bonusalias']},
   {active_usernames:'bonusalias'},
   {active_usernames:['mainchannel',7]},
   {active_usernames:['mainchannel','a']},
   {active_usernames:Array.from({length:110},(_,i)=>'alias'+(10000+i))},
   {active_usernames:['mainchannel','\ninvalid']},
   {id:-201},
   {type:'supergroup'},
  ]){data={id:Number(C),type:'channel',username:'mainchannel',active_usernames:['mainchannel','bonusalias'],...invalid};
   assert.equal(await gateway.inspectChannelUsername(C),null);}
 }finally{await f.close();}});
 test(engine+' unavailable alias inspection cannot manufacture removal or override newest evidence',async()=>{const f=await fixture();try{
  let second=false;
  let gateway={inspectChannelRights:async()=> 'ADMIN' as const,inspectChannelUsername:async()=>{
   if(second){await f.store.transaction(s=>recordChannelIdentity(s,'100',G,C,1,1,1,
    {username:'mainchannel',activeUsernames:['mainchannel','newestalias']},NOW,f.clock()));
    return {username:'mainchannel',activeUsernames:['mainchannel','stalealias']};}
   return {username:'mainchannel',activeUsernames:['mainchannel','initialalias']};
  }};
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  f.advance(600000);second=true;
  await new SubscriptionRightsMonitor(f.store,f.policy,gateway,f.clock,f.safe).tick();
  const state=await f.store.snapshot();
  assert.equal(subscriptionChangeAlerts(state,f.clock()).filter(a=>a.identityChannel).length,1);
  const hash=JSON.stringify(state.subscriptionChannelIdentities);
  await new SubscriptionRightsMonitor(f.store,f.policy,{
   inspectChannelRights:async()=> 'ADMIN',inspectChannelUsername:async()=>null},f.clock,f.safe).tick();
  assert.equal(JSON.stringify((await f.store.snapshot()).subscriptionChannelIdentities),hash);
 }finally{await f.close();}});
 test(engine+' API with no alias field retains existing primary-only identity flow',async()=>{const f=await fixture();try{
  const request=(async(_url:unknown,options:RequestInit)=>{const args=JSON.parse(String(options.body));assert.equal(args.chat_id,C);
   return Response.json({ok:true,result:{id:Number(C),type:'channel',username:'mainchannel'}});}) as typeof fetch;
  const gateway=new TelegramBotApiMembershipGateway(TOKEN,request);
  assert.deepEqual(await gateway.inspectChannelUsername(C),{username:'mainchannel'});
 }finally{await f.close();}});
}
