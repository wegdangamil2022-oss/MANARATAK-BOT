import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {SubscriptionRightsMonitor} from '../src/subscription-rights-monitor.js';
import {SubscriptionChangeAlertDispatcher,subscriptionChangeAlerts} from '../src/subscription-change-alert.js';
import {recordChannelIdentity} from '../src/subscription-channel-identity.js';
const NOW=1700000000000,G='-100100',C='-100200';
for(const engine of ['json','sqlite'] as const)test(engine+' username drift uses same approved channel, survives restart and sends a single guarded owner notice',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'channel-identity-'));try{
  const store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,name:string|null='firstchannel';const clock=()=>now,policy=new Policy(store,'100',clock);for(const id of [G,C])await policy.approveChat('100',id,['verification']);await store.transaction(s=>s.subscriptionRequirements.push({chatId:G,channelIds:[C],mode:'ALL',version:1}));
  const probe={inspectChannelRights:async()=> 'ADMIN' as const,inspectChannelUsername:async()=>({username:name})};
  await new SubscriptionRightsMonitor(store,policy,probe,clock,async()=>true).tick();assert.equal(subscriptionChangeAlerts(await store.snapshot(),now).length,0);
  now+=600000;name='secondchannel';await new SubscriptionRightsMonitor(store,policy,probe,clock,async()=>true).tick();let state=await store.snapshot(),alerts=subscriptionChangeAlerts(state,now);assert.equal(alerts.length,1);assert.equal(alerts[0]!.identityChannel,C);assert.doesNotMatch(JSON.stringify(state.subscriptionChannelIdentities),/firstchannel|secondchannel/);
  let sends=0;const dispatcher=new SubscriptionChangeAlertDispatcher(store,policy,{send:async()=>({status:'UNKNOWN_OUTCOME'}),sendTemporaryPrivate:async(plan,verify)=>{assert.equal(await verify(),true);assert.match(plan.text,/المعرف العام/u);sends++;return {status:'CONFIRMED',messageId:91};}},clock,async()=>true);await dispatcher.drain();await dispatcher.drain();assert.equal(sends,1);
  now+=600000;await new SubscriptionRightsMonitor(store,policy,probe,clock,async()=>true).tick();assert.equal(subscriptionChangeAlerts(await store.snapshot(),now).length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
for(const engine of ['json','sqlite'] as const)test(engine+' unavailable, stopped, stale, unapproved and corrupt identity reads cannot create a change alert',async()=>{
 for(const scenario of ['unavailable','stop','stale','reapproved','corrupt'] as const){const dir=await mkdtemp(join(tmpdir(),'identity-rejection-'));try{
  const store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,run=true,name='firstchannel',second=false;const clock=()=>now,policy=new Policy(store,'100',clock);for(const id of [G,C])await policy.approveChat('100',id,['verification']);await store.transaction(s=>s.subscriptionRequirements.push({chatId:G,channelIds:[C],mode:'ALL',version:1}));
  const probe={inspectChannelRights:async()=> 'ADMIN' as const,inspectChannelUsername:async()=>{if(second){if(scenario==='unavailable')return null;if(scenario==='stop')run=false;if(scenario==='stale')await store.transaction(s=>s.subscriptionRequirements[0]!.version++);}return {username:name};}};
  await new SubscriptionRightsMonitor(store,policy,probe,clock,async()=>run).tick();now+=600000;name='secondchannel';second=true;
  if(scenario==='reapproved')await policy.approveChat('100',C,['verification']);if(scenario==='corrupt')await store.transaction(s=>{s.subscriptionChannelIdentities={bad:true};});
  await new SubscriptionRightsMonitor(store,policy,probe,clock,async()=>run).tick();assert.equal(subscriptionChangeAlerts(await store.snapshot(),now).length,0);
 }finally{await rm(dir,{recursive:true,force:true});}}
});
for(const engine of ['json','sqlite'] as const)test(engine+' late username response cannot overwrite newer same-clock evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'identity-race-'));try{
  const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);for(const id of [G,C])await policy.approveChat('100',id,['verification']);await store.transaction(s=>{s.subscriptionRequirements.push({chatId:G,channelIds:[C],mode:'ALL',version:1});recordChannelIdentity(s,'100',G,C,1,1,1,'firstchannel',NOW,NOW);});
  const probe={inspectChannelRights:async()=> 'ADMIN' as const,inspectChannelUsername:async()=>{await store.transaction(s=>recordChannelIdentity(s,'100',G,C,1,1,1,'newestchannel',NOW,NOW));return {username:'olderchannel'};}};
  await new SubscriptionRightsMonitor(store,policy,probe,()=>NOW,async()=>true).tick();assert.equal(subscriptionChangeAlerts(await store.snapshot(),NOW).length,1);
  await new SubscriptionRightsMonitor(store,policy,{inspectChannelRights:async()=> 'ADMIN',inspectChannelUsername:async()=>({username:'newestchannel'})},()=>NOW,async()=>true).tick();assert.equal(subscriptionChangeAlerts(await store.snapshot(),NOW).length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
