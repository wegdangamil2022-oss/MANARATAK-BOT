import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {SubscriptionChangeAlertDispatcher,subscriptionChangeAlerts} from '../src/subscription-change-alert.js';
import type {TelegramReplySender} from '../src/telegram-replies.js';
import {TelegramBotApiTextSender} from '../src/telegram-replies.js';
const NOW=1700000000000,GROUP='-100100',A='-100200',B='-100201';
const guarded=(send:TelegramReplySender['send']):TelegramReplySender=>({send,sendTemporaryPrivate:async(plan,verify)=>await verify()?send(plan):{status:'FAILED_CONFIRMED'}});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'subscription-change-alert-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;const policy=new Policy(store,'100',()=>now);for(const id of [GROUP,A,B])await policy.approveChat('100',id,['verification']);const gate=new SubscriptionGate(store,policy,new FakeMembershipGateway(),new ModerationService(store,policy,new FakeModerationGateway()),()=>now);await gate.configure('100',GROUP,[A],'ALL');return {store,policy,gate,now:()=>now,time:(value:number)=>{now=value;},close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' changed required channels queue one private alert with a verified receipt',async()=>{const f=await fixture();try{
  assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.now()).length,0);
  await f.gate.configure('100',GROUP,[B],'ALL');const before=subscriptionChangeAlerts(await f.store.snapshot(),f.now());assert.equal(before.length,1);assert.deepEqual(before[0]!.removed,[A]);assert.deepEqual(before[0]!.added,[B]);
  const sent:string[]=[];const worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,guarded(async plan=>{assert.equal(plan.chatId,'100');sent.push(plan.text);return {status:'CONFIRMED',messageId:92};}),f.now,async()=>true);
  assert.equal(await worker.drain(),1);assert.equal(await worker.drain(),0);assert.equal(sent.length,1);assert.match(sent[0]!,/-100200/u);assert.match(sent[0]!,/-100201/u);assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.now())[0]!.delivery,'CONFIRMED');
 }finally{await f.close();}});
 test(engine+' direct owner pruning records a change in the same transaction',async()=>{const f=await fixture();try{
  const s=await f.store.snapshot(),chat=s.chats.find(x=>x.id===GROUP)!,rule=s.subscriptionRequirements.find(x=>x.chatId===GROUP)!;await f.policy.removeSubscriptionChannelAtRevision('100',GROUP,A,chat.version,rule.version);
  const events=subscriptionChangeAlerts(await f.store.snapshot(),f.now());assert.equal(events.length,1);assert.deepEqual(events[0]!.removed,[A]);assert.deepEqual(events[0]!.added,[]);let sends=0;
  const worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,guarded(async()=>{sends++;return {status:'CONFIRMED',messageId:93};}),f.now,async()=>true);assert.equal(await worker.drain(),1);assert.equal(sends,1);
 }finally{await f.close();}});
 test(engine+' STOP, revoked scope, duplicate evidence and ambiguous delivery never cause retry',async()=>{for(const scenario of ['stop','scope','duplicate','unknown','interrupted'] as const){const f=await fixture();try{
  await f.gate.configure('100',GROUP,[B],'ALL');let sends=0,run=scenario!=='stop';const worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,guarded(async()=>{sends++;return {status:'UNKNOWN_OUTCOME'};}),f.now,async()=>run);
  if(scenario==='scope')await f.policy.revokeChat('100',GROUP);if(scenario==='duplicate')await f.store.transaction(s=>{const root=s.audit.find(a=>a.updateKey.startsWith('subscription:change-alert:')&&!a.updateKey.includes(':started'))!;s.audit.push({...root});});
  if(scenario==='interrupted')await f.store.transaction(s=>{const root=s.audit.find(a=>a.updateKey.startsWith('subscription:change-alert:'))!;s.audit.push({actorId:root.actorId!,updateKey:root.updateKey+':started',decision:'ALLOW',reason:'SUBSCRIPTION_CHANGE_ALERT_STARTED',policyVersion:root.policyVersion,at:f.now()});});
  await worker.drain();if(scenario==='stop'){assert.equal(sends,0);run=true;}if(scenario==='interrupted')f.time(NOW+30001);await worker.drain();await worker.drain();assert.equal(sends,scenario==='unknown'||scenario==='stop'?1:0);
 }finally{await f.close();}}});
 test(engine+' concurrent workers claim one alert and never repeat an in-flight send',async()=>{const f=await fixture();try{
  await f.gate.configure('100',GROUP,[B],'ALL');let release!:()=>void,started!:()=>void,sends=0;const wait=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>started=r);
  const sender=guarded(async()=>{sends++;started();await wait;return {status:'CONFIRMED' as const,messageId:94};}),one=new SubscriptionChangeAlertDispatcher(f.store,f.policy,sender,f.now,async()=>true),two=new SubscriptionChangeAlertDispatcher(f.store,f.policy,sender,f.now,async()=>true);
  const pending=one.drain();try{await begun;assert.equal(await two.drain(),0);assert.equal(sends,1);}finally{release();await pending;}assert.equal(await two.drain(),0);
 }finally{await f.close();}});
 test(engine+' STOP before send defers an unsent alert, while late acknowledgement remains unknown',async()=>{for(const variant of ['defer','fence','late'] as const){const f=await fixture();try{
  await f.gate.configure('100',GROUP,[B],'ALL');let checks=0,sends=0,run=true;
  const worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,guarded(async()=>{sends++;if(variant==='late')f.time(NOW+30000);return {status:'CONFIRMED',messageId:95};}),f.now,async()=>{checks++;if((variant==='defer'&&checks===2)||(variant==='fence'&&checks===3)){run=false;return false;}return run;});
  if(variant==='defer'||variant==='fence'){assert.equal(await worker.drain(),0);assert.equal(sends,0);assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.now())[0]!.delivery,'PENDING');run=true;assert.equal(await worker.drain(),1);assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.now())[0]!.delivery,'CONFIRMED');}
  else{assert.equal(await worker.drain(),1);assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.now())[0]!.delivery,'UNKNOWN_OUTCOME');assert.equal(await worker.drain(),0);assert.equal(sends,1);}
 }finally{await f.close();}}});
 test(engine+' scope lost during the guarded sender check prevents external delivery',async()=>{const f=await fixture();try{
  await f.gate.configure('100',GROUP,[B],'ALL');let sends=0;const sender:TelegramReplySender={send:async()=>{sends++;return {status:'CONFIRMED',messageId:96};},sendTemporaryPrivate:async(_plan,verify)=>{await f.policy.revokeChat('100',GROUP);return await verify()?{status:'CONFIRMED',messageId:96}:{status:'FAILED_CONFIRMED'};}};
  const worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,sender,f.now,async()=>true);await worker.drain();await worker.drain();assert.equal(sends,0);assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.now())[0]!.delivery,'CANCELLED');
 }finally{await f.close();}});
 test(engine+' pause and revoked channel each preserve the confirmed removal event',async()=>{for(const variant of ['pause','revoke-channel'] as const){const f=await fixture();try{
  const s=await f.store.snapshot(),chat=s.chats.find(x=>x.id===GROUP)!,rule=s.subscriptionRequirements.find(x=>x.chatId===GROUP)!;
  if(variant==='pause')await f.policy.pauseSubscriptionAtRevision('100',GROUP,chat.version,rule.version);else await f.policy.revokeChat('100',A);
  const alerts=subscriptionChangeAlerts(await f.store.snapshot(),f.now());assert.equal(alerts.length,1);assert.deepEqual(alerts[0]!.removed,[A]);let sends=0;
  const worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,guarded(async()=>{sends++;return {status:'CONFIRMED',messageId:97};}),f.now,async()=>true);assert.equal(await worker.drain(),1);assert.equal(sends,1);
 }finally{await f.close();}}});
 test(engine+' missing send authorization and reused message IDs never prove two deliveries',async()=>{for(const variant of ['no-check','duplicate-id'] as const){const f=await fixture();try{
  await f.gate.configure('100',GROUP,[B],'ALL');if(variant==='duplicate-id')await f.gate.configure('100',GROUP,[A],'ALL');
  const sender:TelegramReplySender=variant==='no-check'?{send:async()=>({status:'UNKNOWN_OUTCOME'}),sendTemporaryPrivate:async()=>({status:'CONFIRMED',messageId:98})}:guarded(async()=>({status:'CONFIRMED',messageId:98}));
  const worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,sender,f.now,async()=>true);await worker.drain();await worker.drain();const alerts=subscriptionChangeAlerts(await f.store.snapshot(),f.now());
  assert.deepEqual(alerts.map(a=>a.delivery),variant==='no-check'?['UNKNOWN_OUTCOME']:['CONFIRMED','UNKNOWN_OUTCOME']);assert.equal(await worker.drain(),0);
 }finally{await f.close();}}});
 test(engine+' corrupt legacy channels or an unavailable clock never block owner revocation',async()=>{for(const variant of ['legacy','clock'] as const){const f=await fixture();try{
  if(variant==='legacy')await f.store.transaction(s=>{s.subscriptionRequirements[0]!.channelIds={length:1} as unknown as string[];});
  const policy=variant==='clock'?new Policy(f.store,'100',()=>{throw Error('CLOCK_UNAVAILABLE');}):f.policy;
  await policy.revokeChat('100',GROUP);const state=await f.store.snapshot();assert.equal(state.chats.find(c=>c.id===GROUP)!.approved,false);assert.deepEqual(state.subscriptionRequirements[0]!.channelIds,[]);
 }finally{await f.close();}}});
 test(engine+' official sender uses a fenced protected private request and requires a matching receipt',async()=>{const f=await fixture();try{
  await f.gate.configure('100',GROUP,[B],'ALL');let calls=0;
  const request=(async(_url:unknown,init:RequestInit)=>{calls++;const body=JSON.parse(String(init.body));assert.equal(body.chat_id,'100');assert.equal(body.protect_content,true);assert.match(body.text,/-100200/u);return Response.json({ok:true,result:{chat:{id:100},from:{id:123456789,is_bot:true},message_id:99}});}) as typeof fetch;
  const sender=new TelegramBotApiTextSender('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request),worker=new SubscriptionChangeAlertDispatcher(f.store,f.policy,sender,f.now,async()=>true);
  assert.equal(await worker.drain(),1);assert.equal(calls,1);assert.equal(subscriptionChangeAlerts(await f.store.snapshot(),f.now())[0]!.delivery,'CONFIRMED');assert.equal(await worker.drain(),0);
 }finally{await f.close();}});
}
