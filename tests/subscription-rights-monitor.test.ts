import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {FakeMembershipGateway,SubscriptionGate} from '../src/subscription.js';
import {FakeModerationGateway,ModerationService} from '../src/moderation.js';
import {SubscriptionRightsMonitor} from '../src/subscription-rights-monitor.js';
import {SubscriptionChangeAlertDispatcher,subscriptionChangeAlerts} from '../src/subscription-change-alert.js';
import type {TelegramReplySender} from '../src/telegram-replies.js';
import {summarizeSubscriptionChannelIncidents} from '../src/subscription-channel-incidents.js';
const NOW=1700000000000,G='-100100',C='-100200';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'rights-monitor-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,run=true;const policy=new Policy(store,'100',()=>now);for(const chat of [G,C])await policy.approveChat('100',chat,['verification']);const gate=new SubscriptionGate(store,policy,new FakeMembershipGateway(),new ModerationService(store,policy,new FakeModerationGateway()),()=>now);await gate.configure('100',G,[C],'ALL');return {store,policy,gate,clock:()=>now,time:(n:number)=>now=n,safety:async()=>run,setRun:(v:boolean)=>run=v,close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' confirmed rights loss creates a single private alert across repeated and concurrent scans',async()=>{const f=await fixture();try{
  let reads=0,sends=0;const probe={inspectChannelRights:async()=>{reads++;return 'NOT_ADMIN' as const;}},m=new SubscriptionRightsMonitor(f.store,f.policy,probe,f.clock,f.safety);
  await Promise.all([m.tick(),m.tick()]);await m.tick();const alerts=subscriptionChangeAlerts(await f.store.snapshot(),f.clock());assert.equal(alerts.length,1);assert.equal(alerts[0]!.lostChannel,C);
  let summary=summarizeSubscriptionChannelIncidents(await f.store.snapshot(),f.policy,f.clock());assert.equal(summary.observations,1);assert.equal(summary.pending,1);assert.equal(summary.delivered,0);
  const sender:TelegramReplySender={send:async()=>({status:'UNKNOWN_OUTCOME'}),sendTemporaryPrivate:async(plan,verify)=>{assert.equal(await verify(),true);sends++;assert.equal(plan.chatId,'100');assert.match(plan.text,/ليس مشرفًا/u);return {status:'CONFIRMED',messageId:71};}};
  const worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,sender,f.clock,f.safety);assert.equal(await worker.drain(),1);assert.equal(await worker.drain(),0);assert.equal(sends,1);assert.ok(reads>0);
  const state=await f.store.snapshot();summary=summarizeSubscriptionChannelIncidents(state,f.policy,f.clock());assert.equal(summary.delivered,1);assert.equal(summary.pending,0);const corrupt=structuredClone(state),receipt=corrupt.audit.find(a=>a.updateKey===alerts[0]!.id+':receipt')!;corrupt.audit.push({...receipt});assert.equal(summarizeSubscriptionChannelIncidents(corrupt,f.policy,f.clock()).unknown,1);assert.equal(summarizeSubscriptionChannelIncidents(state,f.policy,f.clock()+86400001).observations,0);
 }finally{await f.close();}});
 test(engine+' unknown, stopped, changed configuration and revoked permissions never create a loss alert',async()=>{for(const variant of ['unknown','stopped','changed','revoked'] as const){const f=await fixture();try{
  let reads=0;const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async()=>{reads++;if(variant==='changed')await f.gate.configure('100',G,[],'ALL');if(variant==='revoked')await f.policy.revokeChat('100',G);return variant==='unknown'?'UNKNOWN':'NOT_ADMIN';}},f.clock,f.safety);
  if(variant==='stopped')f.setRun(false);await m.tick();assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).filter(a=>a.lostChannel).length,0);if(variant==='stopped')assert.equal(reads,0);
 }finally{await f.close();}}});
 test(engine+' a later monitoring interval can report continuing loss without retrying the old send',async()=>{const f=await fixture();try{
  const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async()=> 'NOT_ADMIN'},f.clock,f.safety);await m.tick();f.time(NOW+3600000);await m.tick();assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).filter(a=>a.lostChannel===C).length,2);
 }finally{await f.close();}});
 test(engine+' incident summary distinguishes failed and cancelled owner notices',async()=>{for(const variant of ['failed','cancelled'] as const){const f=await fixture();try{
  const monitor=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async()=> 'NOT_ADMIN'},f.clock,f.safety);await monitor.tick();
  if(variant==='cancelled')await f.policy.revokeChat('100',G);
  const sender:TelegramReplySender={send:async()=>({status:'UNKNOWN_OUTCOME'}),sendTemporaryPrivate:async(_plan,verify)=>{assert.equal(await verify(),true);return {status:'FAILED_CONFIRMED'};}};
  await new SubscriptionChangeAlertDispatcher(f.store,f.policy,sender,f.clock,f.safety).drain();const summary=summarizeSubscriptionChannelIncidents(await f.store.snapshot(),f.policy,f.clock());assert.equal(summary.observations,1);assert.equal(summary.failed,variant==='failed'?1:0);assert.equal(summary.cancelled,variant==='cancelled'?1:0);assert.equal(summary.delivered,0);
 }finally{await f.close();}}});
 test(engine+' independent monitors deduplicate, and a stopped or stale observation cannot be delivered',async()=>{const f=await fixture();try{
  const probe={inspectChannelRights:async()=> 'NOT_ADMIN' as const};const a=new SubscriptionRightsMonitor(f.store,f.policy,probe,f.clock,f.safety),b=new SubscriptionRightsMonitor(f.store,f.policy,probe,f.clock,f.safety);
  await Promise.all([a.tick(),b.tick()]);assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).filter(x=>x.lostChannel).length,1);
  await f.gate.configure('100',G,[],'ALL');let sends=0;const sender:TelegramReplySender={send:async()=>({status:'UNKNOWN_OUTCOME'}),sendTemporaryPrivate:async plan=>{if(plan.text.includes('ليس مشرفًا'))sends++;return {status:'CONFIRMED',messageId:72};}};
  await new SubscriptionChangeAlertDispatcher(f.store,f.policy,sender,f.clock,f.safety).drain();assert.equal(sends,0);
 }finally{await f.close();}});
 test(engine+' stop during inspection prevents recording a loss',async()=>{const f=await fixture();try{
  const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async()=>{f.setRun(false);return 'NOT_ADMIN';}},f.clock,f.safety);await m.tick();assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.clock()).filter(x=>x.lostChannel).length,0);
 }finally{await f.close();}});
 test(engine+' scan limit rotates across required channels',async()=>{const f=await fixture();try{
  const channels=[C,...Array.from({length:6},(_,i)=>'-100'+(201+i))];for(const c of channels.slice(1))await f.policy.approveChat('100',c,['verification']);await f.gate.configure('100',G,channels,'ALL');
  const seen:string[]=[];const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async c=>{seen.push(c);return 'ADMIN';}},f.clock,f.safety);await m.tick(100);assert.equal(seen.length,5);await m.tick(100);assert.deepEqual(seen,channels);
 }finally{await f.close();}});
 test(engine+' unrelated configuration churn cannot starve remaining channels',async()=>{const f=await fixture();try{
  const channels=[C,...Array.from({length:6},(_,i)=>'-100'+(201+i))];for(const c of channels.slice(1))await f.policy.approveChat('100',c,['verification']);await f.gate.configure('100',G,channels,'ALL');
  const seen:string[]=[];const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async c=>{seen.push(c);return 'ADMIN';}},f.clock,f.safety);await m.tick();await f.policy.approveChat('100','-100999',['verification']);await m.tick();assert.deepEqual(seen,channels);
 }finally{await f.close();}});
 test(engine+' STOP or revocation during a healthy check prevents later channel reads',async()=>{for(const variant of ['stop','revoke'] as const){const f=await fixture();try{
  const other='-100201';await f.policy.approveChat('100',other,['verification']);await f.gate.configure('100',G,[C,other],'ALL');const seen:string[]=[];
  const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async c=>{seen.push(c);if(variant==='stop')f.setRun(false);else await f.policy.revokeChat('100',G);return 'ADMIN';}},f.clock,f.safety);
  await m.tick();assert.deepEqual(seen,[C]);
 }finally{await f.close();}}});
 test(engine+' concurrent ticks share the same in-process cooldown before contacting Telegram',async()=>{const f=await fixture();try{
  let reads=0;const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async()=>{reads++;await new Promise(resolve=>setTimeout(resolve,20));return 'ADMIN';}},f.clock,f.safety);await Promise.all([m.tick(),m.tick()]);assert.equal(reads,1);
 }finally{await f.close();}});
}
