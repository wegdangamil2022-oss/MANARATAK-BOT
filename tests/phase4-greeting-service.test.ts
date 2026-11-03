import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4GreetingService} from '../src/phase4-greeting-service.js';
import {defaultGreetingSettings,type GreetingSettings,type InteractionEvent} from '../src/phase4-welcome-engine.js';
const OWNER='100',GROUP='-100123',OTHER='-200123';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-phase4-greet-'));
 const file=join(dir,engine==='json'?'bot.json':'bot.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 let on=false;
 const service=new Phase4GreetingService(store,policy,{clock:()=>1_000_000,allowSending:()=>on});
 const template:GreetingSettings={...defaultGreetingSettings(GROUP),enabled:true,welcomeMode:'GROUP',
  welcomeTemplateId:'hello',templates:[{id:'hello',language:'ar',text:'مرحباً {العضو}!'}]};
 const event=(key='p4:event-one',actor='300'):InteractionEvent=>({
  updateKey:key,chatId:GROUP,actorId:actor,kind:'JOIN',trusted:true,chatApproved:true,
  at:1_000_000,memberName:'آمنة & محمد',verified:true});
 return {dir,file,store,policy,service,template,event,enable:()=>{on=true;},
  cleanup:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('phase4 '+engine+': owner-only setting, preview and CAS reject stale revisions',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.service.preview('300',f.template),/OWNER_ONLY/);
   await assert.rejects(f.service.confirm('300',f.template),/OWNER_ONLY/);
   assert.equal((await f.service.preview(OWNER,f.template)).revision,1);
   await f.service.confirm(OWNER,f.template);
   await assert.rejects(f.service.confirm(OWNER,f.template),/STALE_GREETING_REVISION/);
   const updated={...f.template,revision:2,welcomeMode:'OFF' as const};
   await f.service.confirm(OWNER,updated);
   assert.equal((await f.service.status(OWNER,GROUP)).settings?.revision,2);
   await assert.rejects(f.service.status('300',GROUP),/OWNER_ONLY/);
  }finally{await f.cleanup();}
 });
 test('phase4 '+engine+': durable decision, duplicate event and member cooldown',async()=>{
  const f=await fixture(engine);try{
   await f.service.confirm(OWNER,f.template);
   const first=await f.service.evaluate(f.event());
   assert.equal(first.status,'QUEUED');assert.match(first.templateHtml??'',/آمنة &amp; محمد/);
   assert.equal((await f.service.evaluate(f.event())).status,'REPLAY');
   assert.equal((await f.service.evaluate(f.event('p4:event-two'))).status,'RATE_LIMIT');
   const restarted=new Phase4GreetingService(new BotStore(f.file,{engine}),f.policy);
   assert.equal((await restarted.status(OWNER,GROUP)).counts.QUEUED,1);
  }finally{await f.cleanup();}
 });
 test('phase4 '+engine+': disabled sender cannot send; confirmed send happens once',async()=>{
  const f=await fixture(engine);try{
   await f.service.confirm(OWNER,f.template);
   const item=await f.service.evaluate(f.event());assert.equal(item.status,'QUEUED');
   let calls=0;
   const sender={send:async(plan:{chatId:string;text:string})=>{
    calls++;assert.equal(plan.chatId,GROUP);assert.equal(plan.text.includes('<script>'),false);
    return {status:'CONFIRMED' as const,messageId:11};
   }};
   assert.equal((await f.service.deliver(item.jobId!,sender)).status,'PAUSED');
   assert.equal(calls,0);
   f.enable();
   assert.equal((await f.service.deliver(item.jobId!,sender)).status,'SENT');
   assert.equal(calls,1);
   assert.equal((await f.service.deliver(item.jobId!,sender)).status,'SENT');
   assert.equal(calls,1);
   assert.equal((await f.service.status(OWNER,GROUP)).counts.SENT,1);
  }finally{await f.cleanup();}
 });
 test('phase4 '+engine+': unknown send is retained and never retried',async()=>{
  const f=await fixture(engine);try{
   await f.service.confirm(OWNER,f.template);const item=await f.service.evaluate(f.event());
   f.enable();let calls=0;
   const sender={send:async()=>{calls++;return {status:'UNKNOWN_OUTCOME' as const};}};
   assert.equal((await f.service.deliver(item.jobId!,sender)).status,'UNKNOWN_OUTCOME');
   assert.equal((await f.service.deliver(item.jobId!,sender)).status,'UNKNOWN_OUTCOME');
   assert.equal(calls,1);
   assert.equal((await f.service.status(OWNER,GROUP)).counts.UNKNOWN_OUTCOME,1);
  }finally{await f.cleanup();}
 });
 test('phase4 '+engine+': policy revision cancels stale queued replies',async()=>{
  const f=await fixture(engine);try{
   await f.service.confirm(OWNER,f.template);const first=await f.service.evaluate(f.event());
   await f.service.confirm(OWNER,{...f.template,revision:2,enabled:false});
   f.enable();let calls=0;
   const sender={send:async()=>{calls++;return {status:'CONFIRMED' as const,messageId:1};}};
   assert.equal((await f.service.deliver(first.jobId!,sender)).status,'CANCELLED');
   assert.equal(calls,0);
  }finally{await f.cleanup();}
 });
 test('phase4 '+engine+': concurrent duplicated event queues only one response',async()=>{
  const f=await fixture(engine);try{
   await f.service.confirm(OWNER,f.template);
   const result=await Promise.all(Array.from({length:8},()=>f.service.evaluate(f.event())));
   assert.equal(result.filter(x=>x.status==='QUEUED').length,1);
   assert.equal(result.filter(x=>x.status==='REPLAY').length,7);
   assert.equal((await f.service.status(OWNER,GROUP)).counts.QUEUED,1);
  }finally{await f.cleanup();}
 });
 test('phase4 '+engine+': pending send on restart quarantines without replay',async()=>{
  const f=await fixture(engine);try{
   await f.service.confirm(OWNER,f.template);
   const one=await f.service.evaluate(f.event());f.enable();
   let start!:()=>void;const started=new Promise<void>(resolve=>start=resolve);
   let resolveSend!:(r:{status:'CONFIRMED';messageId:number})=>void;
   const pending=new Promise<{status:'CONFIRMED';messageId:number}>(resolve=>resolveSend=resolve);
   const flight=f.service.deliver(one.jobId!,{send:async()=>{start();return pending;}});
   await started;
   assert.equal(await f.service.quarantineInterrupted(OWNER),1);
   assert.equal((await f.service.status(OWNER,GROUP)).counts.UNKNOWN_OUTCOME,1);
   resolveSend({status:'CONFIRMED',messageId:2});
   assert.equal((await flight).status,'UNKNOWN_OUTCOME');
   assert.equal((await f.service.deliver(one.jobId!,{send:async()=>{throw Error('REPLAY');}})).status,'UNKNOWN_OUTCOME');
  }finally{await f.cleanup();}
 });
 test('phase4 '+engine+': nonapproved group and invalid input fail closed',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.service.confirm(OWNER,{...f.template,chatId:OTHER}),/GROUP_NOT_APPROVED/);
   await f.service.confirm(OWNER,f.template);
   assert.equal((await f.service.evaluate({...f.event(),chatApproved:false})).status,'UNAPPROVED');
   assert.equal((await f.service.evaluate({...f.event(),updateKey:'malformed'})).status,'INVALID_UPDATE');
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal((await f.service.evaluate(f.event())).status,'UNAPPROVED');
  }finally{await f.cleanup();}
 });
}
