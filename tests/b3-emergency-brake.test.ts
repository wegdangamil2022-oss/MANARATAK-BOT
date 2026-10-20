import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,symlink,unlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramReplyDispatcher,type TelegramReplySender} from '../src/telegram-replies.js';
import {readTelegramSafetySwitch,createTelegramSafetyGate} from '../src/telegram-safety-switch.js';
import {loadLiveTelegramConfig,preflightLiveTelegram,createLiveTelegramServer} from '../src/telegram-live-server.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const SECRET='valid_secret_value_abcdefghijklmnopqrstuvwxyz123';
const URL='https://webhook.manaratak-ops.net/telegram/webhook';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-live-brake-'));
 const stateFile=join(dir,'state.sqlite'),safetyFile=join(dir,'safety.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 await store.transaction(()=>undefined);await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 const env={
  BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
  BOT_OWNER_ID:'100',BOT_ID:'bot-main',BOT_USERNAME:'ManaratakBot',
  BOT_STATE_FILE:stateFile,TELEGRAM_BOT_TOKEN:TOKEN,
  TELEGRAM_WEBHOOK_SECRET:SECRET,TELEGRAM_LISTEN_PORT:'8787',
  TELEGRAM_WEBHOOK_PUBLIC_URL:URL,TELEGRAM_SAFETY_FILE:safetyFile
 };
 return {dir,stateFile,safetyFile,store,env,close:()=>rm(dir,{force:true,recursive:true})};
}
const msg=(id:number)=>({update_id:id,message:{chat:{id:300,type:'private'},
 from:{id:300,is_bot:false},text:'/start'}});
async function withServer(server:ReturnType<typeof createServer>,fn:(url:string)=>Promise<void>){
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const address=server.address();if(!address||typeof address==='string')throw Error('NO_ADDRESS');
  await fn('http://127.0.0.1:'+address.port+'/telegram/webhook');
 }finally{server.close();await once(server,'close');}
}
function inbound(url:string,id:number){
 return fetch(url,{method:'POST',headers:{'content-type':'application/json',
  'x-telegram-bot-api-secret-token':SECRET},body:JSON.stringify(msg(id))});
}
test('brake file STOP is durable across reads and RUN is the only permissive value',async()=>{
 const f=await fixture();try{
  assert.equal(await readTelegramSafetySwitch(f.safetyFile),'STOP');
  assert.equal(await createTelegramSafetyGate(f.safetyFile)(),false);
  await writeFile(f.safetyFile,'RUN\n');
  assert.equal(await readTelegramSafetySwitch(f.safetyFile),'RUN');
  assert.equal(await createTelegramSafetyGate(f.safetyFile)(),true);
  await writeFile(f.safetyFile,'STOP\n');
  assert.equal(await createTelegramSafetyGate(f.safetyFile)(),false);
 }finally{await f.close();}
});
test('brake fails closed for missing, malformed, public, symlinked or alias paths',async()=>{
 const f=await fixture();try{
  for(const invalid of ['run','RUN','RUN\nSTOP\n','STOP \n','',JSON.stringify({enabled:true})]){
   await writeFile(f.safetyFile,invalid);
   await assert.rejects(readTelegramSafetySwitch(f.safetyFile),/LIVE_TELEGRAM_SAFETY_INVALID/);
   assert.equal(await createTelegramSafetyGate(f.safetyFile)(),false);
  }
  await writeFile(f.safetyFile,'RUN\n');
  await chmod(f.safetyFile,0o644);
  await assert.rejects(readTelegramSafetySwitch(f.safetyFile),/LIVE_TELEGRAM_SAFETY_INVALID/);
  await chmod(f.safetyFile,0o600);
  const link=join(f.dir,'link.flag');await symlink(f.safetyFile,link);
  await assert.rejects(readTelegramSafetySwitch(link),/LIVE_TELEGRAM_SAFETY_INVALID/);
  await assert.rejects(readTelegramSafetySwitch('relative.flag'),/LIVE_TELEGRAM_SAFETY_INVALID/);
  await unlink(f.safetyFile);
  assert.equal(await createTelegramSafetyGate(f.safetyFile)(),false);
  await assert.rejects(access(f.safetyFile),{code:'ENOENT'});
 }finally{await f.close();}
});
test('live config and preflight require protected existing safety switch even for production',async()=>{
 const f=await fixture();try{
  const cfg=loadLiveTelegramConfig(f.env);
  assert.equal(cfg.safetySwitchFile,f.safetyFile);
  assert.deepEqual(await preflightLiveTelegram(f.env),{
   ready:true,httpsWebhook:true,privateSqlite:true,listener:'LOOPBACK_ONLY',telegramNetworkCalls:0});
  assert.throws(()=>loadLiveTelegramConfig({...f.env,TELEGRAM_SAFETY_FILE:undefined}),
   /LIVE_TELEGRAM_CONFIG_INVALID/);
  assert.throws(()=>loadLiveTelegramConfig({...f.env,TELEGRAM_SAFETY_FILE:'relative.flag'}),
   /LIVE_TELEGRAM_CONFIG_INVALID/);
  await unlink(f.safetyFile);
  await assert.rejects(preflightLiveTelegram(f.env),/LIVE_TELEGRAM_SAFETY_INVALID/);
  await writeFile(f.safetyFile,'STOP\n',{mode:0o600});
  assert.equal((await preflightLiveTelegram(f.env)).ready,true);
 }finally{await f.close();}
});
test('paused safety gate blocks QUEUED dispatch without attempt, sender or receipt',async()=>{
 const f=await fixture();let calls=0;try{
  await f.store.transaction(s=>{s.telegramReplyJobs=[{
   updateKey:'b3-webhook:bot-main:44',status:'QUEUED',queuedAt:Date.now()-200,
   plan:{chatId:'300',parseMode:'HTML',text:'Sensitive text'}
  }];});
  const sender:TelegramReplySender={send:async()=>{calls++;return {status:'CONFIRMED',messageId:99};}};
  const dispatch=new TelegramReplyDispatcher(f.store,new Policy(f.store,'100'),sender,
   Date.now,createTelegramSafetyGate(f.safetyFile));
  assert.equal((await dispatch.dispatch('b3-webhook:bot-main:44')).status,'PAUSED');
  assert.equal(calls,0);
  let job=(await f.store.snapshot()).telegramReplyJobs?.[0];
  assert.equal(job?.status,'QUEUED');assert.equal(job?.attemptId,undefined);
  assert.equal(job?.plan?.text,'Sensitive text');
  await writeFile(f.safetyFile,'RUN\n');
  assert.equal((await dispatch.dispatch('b3-webhook:bot-main:44')).status,'CONFIRMED');
  assert.equal(calls,1);
  await writeFile(f.safetyFile,'STOP\n');
  assert.equal((await dispatch.dispatch('b3-webhook:bot-main:44')).status,'SENT');
  job=(await f.store.snapshot()).telegramReplyJobs?.[0];
  assert.equal(job?.status,'SENT');assert.equal(job?.plan,undefined);
  assert.equal(calls,1);
 }finally{await f.close();}
});
test('a rejecting safety gate fails closed without altering a queued intent',async()=>{
 const f=await fixture();let calls=0;try{
  await f.store.transaction(s=>{s.telegramReplyJobs=[{
   updateKey:'b3-webhook:bot-main:55',status:'QUEUED',queuedAt:Date.now(),
   plan:{chatId:'300',parseMode:'HTML',text:'Restricted student text'}
  }];});
  const sender:TelegramReplySender={send:async()=>{calls++;return {status:'CONFIRMED',messageId:1};}};
  const dispatch=new TelegramReplyDispatcher(f.store,new Policy(f.store,'100'),sender,Date.now,
   async()=>{throw Error('SECRET_FAILED');});
  assert.equal((await dispatch.dispatch('b3-webhook:bot-main:55')).status,'PAUSED');
  assert.equal(calls,0);
  assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.status,'QUEUED');
 }finally{await f.close();}
});
test('live webhook stays paused until explicit switch change and never replays denied updates',async()=>{
 const f=await fixture();let sends=0;try{
  const fake=(async(url:string|URL|Request,init?:RequestInit)=>{
   assert.ok(String(url).endsWith('/sendMessage'));
   sends++;
   const data=JSON.parse(String(init?.body)) as {chat_id:string};
   return new Response(JSON.stringify({ok:true,result:{message_id:100+sends,
    chat:{id:Number(data.chat_id)}}}),{status:200});
  }) as typeof fetch;
  const server=await createLiveTelegramServer(loadLiveTelegramConfig(f.env),fake);
  await withServer(server,async url=>{
   assert.equal((await inbound(url,1)).status,503);
   assert.equal((await f.store.snapshot()).updates.length,0);assert.equal(sends,0);
   await writeFile(f.safetyFile,'RUN\n');
   assert.equal((await inbound(url,2)).status,200);
   assert.equal((await f.store.snapshot()).updates.length,1);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.status,'SENT');
   assert.equal(sends,1);
   await writeFile(f.safetyFile,'STOP\n');
   assert.equal((await inbound(url,3)).status,503);
   assert.equal(sends,1);
   assert.equal((await f.store.snapshot()).updates.length,1);
   // Fail closed if an operator removes or corrupts the switch while serving.
   await unlink(f.safetyFile);
   assert.equal((await inbound(url,4)).status,503);
   assert.equal((await f.store.snapshot()).updates.length,1);
  });
 }finally{await f.close();}
});
test('invalid protected brake is rejected before runtime construction, not silently defaulted to RUN',async()=>{
 const f=await fixture();try{
  await chmod(f.safetyFile,0o666);
  await assert.rejects(createLiveTelegramServer(loadLiveTelegramConfig(f.env)),
   /LIVE_TELEGRAM_SAFETY_INVALID/);
  await chmod(f.safetyFile,0o600);
  await writeFile(f.safetyFile,'RUN');
  await assert.rejects(createLiveTelegramServer(loadLiveTelegramConfig(f.env)),
   /LIVE_TELEGRAM_SAFETY_INVALID/);
 }finally{await f.close();}
});
