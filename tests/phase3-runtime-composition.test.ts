import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {createPhase3ModerationRuntime} from '../src/phase3-moderation-runtime.js';
import {GroupPermissionLockService} from '../src/group-permission-lock.js';
import {GROUP_PERMISSION_KEYS,type GroupPermissions} from '../src/group-permission-model.js';
import {isOfficialGroupPermissionGateway,telegramGroupPermissionGateway} from '../src/telegram-group-permission-gateway.js';
import {FakeModerationGateway,ModerationService} from '../src/moderation.js';
import {loadLiveTelegramConfig} from '../src/telegram-live-server.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
for(const engine of ['json','sqlite'] as const){
 test(engine+' runtime constructs offline, keeps timers opt-in, survives restart and preserves official permission provenance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase3-composition-'));try{
   let now=100000,running=true,calls=0,writes=0;
   const file=join(dir,'state.'+engine),store=new BotStore(file,{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);
   const original=Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])) as GroupPermissions;let permissions=structuredClone(original);
   const request=(async(url:unknown,init:RequestInit)=>{
    calls++;const method=String(url).split('/').at(-1),body=JSON.parse(String(init.body));let result:unknown;
    if(method==='getChat')result={id:-100,type:'supergroup',permissions};
    else if(method==='getChatMember')result={status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:true};
    else{assert.equal(method,'setChatPermissions');writes++;permissions=body.permissions;result=true;}
    return Response.json({ok:true,result});
   }) as typeof fetch;
   const runtime=await createPhase3ModerationRuntime(store,policy,TOKEN,request,async()=>running,()=>now);assert.equal(calls,0);
   const job=await runtime.groupPermissions.preview('100','-100','LOCK','PHOTOS',60);assert.ok(job);assert.equal(job.gatewayOrigin,'TELEGRAM_API');
   assert.equal(await runtime.groupPermissions.confirm('100',job.id),'CONFIRMED');assert.equal(writes,1);
   now=160000;await runtime.tick();assert.equal(writes,1);running=false;await runtime.tick(true);assert.equal(writes,1);running=true;
   const reopened=await createPhase3ModerationRuntime(new BotStore(file,{engine}),policy,TOKEN,request,async()=>running,()=>now);await reopened.tick(true);assert.equal(writes,2);assert.deepEqual(permissions,original);await reopened.tick(true);assert.equal(writes,2);
   assert.ok((await store.snapshot()).groupPermissionJobs!.every(j=>j.gatewayOrigin==='TELEGRAM_API'));
   const official=telegramGroupPermissionGateway(TOKEN,request);assert.equal(isOfficialGroupPermissionGateway(official),true);assert.equal(isOfficialGroupPermissionGateway({...official}),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' official permission service refuses preview and restoration baselines created by unproven ports',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase3-origin-'));try{
   let now=100000;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);
   let permissions=Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])) as GroupPermissions,writes=0;
   const fake=new GroupPermissionLockService(store,policy,{read:async()=>permissions,apply:async(_c,_b,a)=>{permissions=a;return 'CONFIRMED';}},()=>now);
   const old=await fake.preview('100','-100','LOCK','PHOTOS');assert.ok(old);
   const request=(async(url:unknown)=>{const method=String(url).split('/').at(-1);if(method==='setChatPermissions')writes++;return Response.json({ok:true,result:method==='getChat'?{id:-100,type:'supergroup',permissions}:{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:true}});}) as typeof fetch;
   const runtime=await createPhase3ModerationRuntime(store,policy,TOKEN,request,async()=>true,()=>now);
   assert.equal(await runtime.groupPermissions.confirm('100',old.id),'DENIED');assert.equal(writes,0);
   assert.equal(await fake.confirm('100',old.id),'CONFIRMED');now++;
   assert.equal(await runtime.groupPermissions.preview('100','-100','RESTORE'),null);assert.equal(writes,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' runtime rejects mixed simulation sanction history offline without changing the store',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase3-history-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>100000);await policy.approveChat('100','-100',['moderation']);
   const fake=new ModerationService(store,policy,new FakeModerationGateway(),()=>100000);await fake.addManualReason('100','-100','300','simulated','MUTE');
   const before=await store.snapshot();let calls=0;const request=(async()=>{calls++;throw Error('network forbidden');}) as typeof fetch;
   await assert.rejects(createPhase3ModerationRuntime(store,policy,TOKEN,request),/PHASE3_UNPROVEN_MODERATION_HISTORY/);assert.equal(calls,0);assert.deepEqual(await store.snapshot(),before);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
test('live phase-three and timer options require exact independent opt-ins',()=>{
 const env={BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',BOT_OWNER_ID:'100',BOT_ID:'runtime',BOT_USERNAME:'ManaratakBot',BOT_STATE_FILE:join(tmpdir(),'runtime.sqlite'),TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_WEBHOOK_SECRET:'abcdefghijklmnopqrstuvwxyz1234567890',TELEGRAM_LISTEN_PORT:'8787',TELEGRAM_WEBHOOK_PUBLIC_URL:'https://webhook.manaratak-ops.net/telegram/webhook',TELEGRAM_SAFETY_FILE:join(tmpdir(),'runtime-safety.flag')};
 assert.equal(loadLiveTelegramConfig(env).phase3ModerationEnabled,undefined);assert.equal(loadLiveTelegramConfig(env).phase3TimersEnabled,undefined);
 assert.throws(()=>loadLiveTelegramConfig({...env,TELEGRAM_PHASE3_TIMERS_ENABLED:'true'}),/LIVE_TELEGRAM_CONFIG_INVALID/);
 for(const value of ['TRUE','1','yes',''])assert.throws(()=>loadLiveTelegramConfig({...env,TELEGRAM_PHASE3_MODERATION_ENABLED:value}),/LIVE_TELEGRAM_CONFIG_INVALID/);
 const enabled=loadLiveTelegramConfig({...env,TELEGRAM_PHASE3_MODERATION_ENABLED:'true',TELEGRAM_PHASE3_TIMERS_ENABLED:'true'});assert.equal(enabled.phase3ModerationEnabled,true);assert.equal(enabled.phase3TimersEnabled,true);
});
