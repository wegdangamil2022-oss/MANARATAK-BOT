import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startProtectionMaintenance} from '../src/protection-maintenance.js';
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {createLiveTelegramServer,stopLiveTelegramServer,loadLiveTelegramConfig} from '../src/telegram-live-server.js';
test('maintenance runs immediately, skips overlapping ticks and drains its active cleanup on stop',async()=>{
 let tick!:()=>void,calls=0,stopped=false,release!:()=>void;
 const waiting=new Promise<void>(resolve=>{release=resolve;});
 const loop=startProtectionMaintenance(async()=>{calls++;await waiting;},callback=>{tick=callback;return ()=>{stopped=true;};});
 assert.equal(calls,1);tick();assert.equal(calls,1);
 let finished=false;const drained=loop.stop().then(()=>{finished=true;});
 await Promise.resolve();assert.equal(finished,false);assert.equal(stopped,true);
 tick();assert.equal(calls,1);release();await drained;assert.equal(finished,true);
 await loop.stop();assert.equal(calls,1);
});
test('maintenance retries after a cleanup error without exposing the underlying error',async()=>{
 let tick!:()=>void,calls=0,failures=0;
 const loop=startProtectionMaintenance(async()=>{calls++;if(calls===1)throw Error('PRIVATE_DATABASE_DETAIL');},callback=>{tick=callback;return ()=>{};},()=>{failures++;});
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(failures,1);
 tick();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(failures,1);
 await loop.stop();tick();assert.equal(calls,2);
});
test('runtime cleans expired local flood windows on startup and drains without Telegram requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'protection-maintenance-'));let server:Server|undefined,calls=0;
 try{
  const path=join(dir,'state.sqlite'),safetyFile=join(dir,'safety.flag'),store=new BotStore(path,{engine:'sqlite'}),now=Date.now()-5000;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100123',['moderation']);
  const service=new GroupProtectionPolicyService(store,policy,()=>now);
  await service.save('100',{chatId:'-100123',revision:1,mode:'MONITOR',rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],flood:{enabled:true,limit:2,windowMs:1000,action:'REVIEW'}},policy.chatRevision(await store.snapshot(),'-100123'),0);
  await service.observeIncomingText('300','-100123','x',undefined,'b3-webhook:idle-test:1');
  assert.equal((await store.snapshot()).protectionFloodWindows?.length,1);
  await chmod(path,0o600);await writeFile(safetyFile,'STOP\n',{mode:0o600});
  server=await createLiveTelegramServer(loadLiveTelegramConfig({BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
   BOT_OWNER_ID:'100',BOT_ID:'idle-test',BOT_USERNAME:'ManaratakBot',BOT_STATE_FILE:path,
   TELEGRAM_BOT_TOKEN:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',TELEGRAM_WEBHOOK_SECRET:'abcdefghijklmnopqrstuvwx_123456789ABCDE',
   TELEGRAM_LISTEN_PORT:'18443',TELEGRAM_WEBHOOK_PUBLIC_URL:'https://bot.example.org/telegram/webhook',TELEGRAM_SAFETY_FILE:safetyFile}),
   (async()=>{calls++;throw Error('no Telegram requests');}) as typeof fetch);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  assert.equal(await stopLiveTelegramServer(server), 'STOPPED');
  assert.deepEqual((await store.snapshot()).protectionFloodWindows,[]);assert.equal(calls,0);
 }finally{if(server?.listening)await stopLiveTelegramServer(server);await rm(dir,{recursive:true,force:true});}
});
