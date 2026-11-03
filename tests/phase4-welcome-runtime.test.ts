import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4GreetingService} from '../src/phase4-greeting-service.js';
import {Phase4TelegramRuntime} from '../src/phase4-telegram-runtime.js';
import {defaultGreetingSettings} from '../src/phase4-welcome-engine.js';
const OWNER='100',GROUP='-100123',MEMBER=300;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-phase4-runtime-'));
 const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 const service=new Phase4GreetingService(store,policy,{allowSending:()=>true});
 await service.confirm(OWNER,{...defaultGreetingSettings(GROUP),enabled:true,welcomeMode:'GROUP',
  welcomeTemplateId:'welcome',templates:[{id:'welcome',language:'ar',text:'أهلًا {العضو}'}]});
 let allowed=true,calls=0;
 const runtime=new Phase4TelegramRuntime(store,policy,service,{send:async plan=>{
  calls++;assert.equal(plan.chatId,GROUP);assert.match(plan.text,/أهلًا/);
  return {status:'CONFIRMED',messageId:calls};
 }},{safetyGate:async()=>allowed,clock:()=>1_000_000});
 const update=(id:number)=>({update_id:id,message:{message_id:id+100,
  chat:{id:Number(GROUP),type:'supergroup',title:'منارتك'},
  from:{id:500,is_bot:false},
  new_chat_members:[{id:MEMBER,is_bot:false,first_name:'أحمد'}]}});
 return {dir,policy,service,runtime,update,deny:()=>allowed=false,calls:()=>calls,
  cleanup:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('phase4 webhook '+engine+': trusted member join queues and sends only once',async()=>{
  const f=await fixture(engine);try{
   const primary={status:'DENIED' as const,reason:'UNSUPPORTED_MESSAGE'};
   const result=await f.runtime.handle(f.update(1),primary);
   assert.deepEqual(result,{status:'PROCESSED',queued:1,delivered:1});
   await f.runtime.handle(f.update(1),primary);
   assert.equal(f.calls(),1);
   assert.equal((await f.service.status(OWNER,GROUP)).counts.SENT,1);
  }finally{await f.cleanup();}
 });
 test('phase4 webhook '+engine+': original bot reply always wins',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.runtime.handle(f.update(2),{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY'})).status,'IGNORED');
   assert.equal(f.calls(),0);
  }finally{await f.cleanup();}
 });
 test('phase4 webhook '+engine+': emergency STOP prevents new replies',async()=>{
  const f=await fixture(engine);try{
   f.deny();const out=await f.runtime.handle(f.update(3),{status:'IGNORED',reason:'UNSUPPORTED_COMMAND'});
   assert.equal(out.status,'PAUSED');assert.equal(f.calls(),0);
  }finally{await f.cleanup();}
 });
 test('phase4 webhook '+engine+': group approval withdrawal denies automated greetings',async()=>{
  const f=await fixture(engine);try{
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal((await f.runtime.handle(f.update(4),{status:'DENIED',reason:'UNSUPPORTED_MESSAGE'})).status,'PROCESSED');
   assert.equal(f.calls(),0);
  }finally{await f.cleanup();}
 });
}