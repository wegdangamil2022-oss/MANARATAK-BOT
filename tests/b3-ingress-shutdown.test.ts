import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type RequestListener,type Server} from 'node:http';
import {createConnection} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication,telegramWebhookListener} from '../src/telegram-transport.js';
import {TelegramMiniAppAuth,telegramAdminWebListener} from '../src/web-admin-auth.js';
import {createHmac} from 'node:crypto';
import {loadLiveTelegramConfig,createLiveTelegramServer,stopLiveTelegramServer} from '../src/telegram-live-server.js';
const SECRET='valid_secret_value_abcdefghijklmnopqrstuvwxyz123';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const NOW=1_800_000_000_000;
const webhook=(id:number,text='/start')=>({update_id:id,message:{chat:{id:300,type:'private'},from:{id:300,is_bot:false},text}});
const headers={'content-type':'application/json','x-telegram-bot-api-secret-token':SECRET};
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-ingress-'));
 const stateFile=join(dir,'state.'+(engine==='sqlite'?'sqlite':'json'));
 const safetyFile=join(dir,'safety.flag');await writeFile(safetyFile,'RUN\n',{mode:0o600});
 const store=new BotStore(stateFile,{engine});
 const policy=new Policy(store,'100',()=>NOW);
 const education=new EducationService(store,policy,()=>NOW);
 const admin=new EducationAdminFacade(store,policy,education,()=>NOW);
 const faq=new ApprovedAnswerService(store,policy,()=>NOW);
 const links=new ResourceLinkService(store,policy,()=>NOW);
 await store.transaction(()=>undefined);
 if(engine==='sqlite')await chmod(stateFile,0o600);
 const app=(membership:()=>Promise<'VERIFIED'|'UNKNOWN'>=async()=> 'VERIFIED')=>
  new TelegramUpdateApplication({store,policy,education,admin,faq,links,botId:'bot-main',
   botUsername:'ManaratakBot',membership,clock:()=>NOW});
 const auth=new TelegramMiniAppAuth(TOKEN,()=>NOW);
 return {dir,stateFile,safetyFile,store,policy,education,admin,app,auth,close:()=>rm(dir,{force:true,recursive:true})};
}
async function withServer(listener:RequestListener,run:(base:string,server:Server)=>Promise<void>){
 const server=createServer(listener);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const a=server.address();if(!a||typeof a==='string')throw Error('PORT');
  await run('http://127.0.0.1:'+a.port,server);}
 finally{server.close();await once(server,'close');}
}
function sign(user:number){
 const v=new URLSearchParams({auth_date:String(NOW/1000),user:JSON.stringify({id:user,first_name:'Test'})});
 const text=[...v].sort(([a],[b])=>a.localeCompare(b)).map(([k,s])=>k+'='+s).join('\n');
 const key=createHmac('sha256','WebAppData').update(TOKEN).digest();
 v.append('hash',createHmac('sha256',key).update(text).digest('hex'));return v.toString();
}
async function post(base:string,id:number,h:Record<string,string>={},body:string|Buffer=JSON.stringify(webhook(id))){
 return fetch(base+'/telegram/webhook',{method:'POST',headers:{...headers,...h},body});
}
test('B3 ingress: reject malformed UTF-8 *before* storing an update',async()=>{
 const f=await fixture();try{await withServer(telegramWebhookListener(f.app(),SECRET),async base=>{
  const bad=Buffer.concat([Buffer.from('{"x":"'),Buffer.from([0xff]),Buffer.from('"}')]);
  assert.equal((await post(base,1,{},bad)).status,400);
  const bom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify(webhook(1)))]);
  assert.equal((await post(base,1,{},bom)).status,400);
  assert.equal((await f.store.snapshot()).updates.length,0);
 });}finally{await f.close();}
});
test('B3 ingress: reject unexpected content encoding and keep no user data',async()=>{
 const f=await fixture();try{await withServer(telegramWebhookListener(f.app(),SECRET),async base=>{
  assert.equal((await post(base,1,{'content-encoding':'gzip'})).status,415);
  assert.equal((await f.store.snapshot()).updates.length,0);
 });}finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': concurrency saturation rejects BEFORE durable update claim and recovers',async()=>{
  const f=await fixture(engine);let unblock!:()=>void;let started!:()=>void;
  const gate=new Promise<void>(r=>{unblock=r;});
  const startedPromise=new Promise<void>(r=>{started=r;});
  let calls=0;
  const app=f.app(async()=>{calls++;started();await gate;return 'VERIFIED'});
  try{await withServer(telegramWebhookListener(app,SECRET,undefined,{maxActive:1}),async base=>{
   // Group-scoped command invokes the asynchronous membership port.
   await f.policy.approveChat('100','-100123',['navigation']);
   await f.education.createCategory('100',{id:'scholarships',scope:'-100123',title:'Offers',order:1});
   const browse=(id:number)=>({update_id:id,message:{chat:{id:300,type:'private'},from:{id:300,is_bot:false},text:'/categories -100123'}});
   const first=post(base,10,{},JSON.stringify(browse(10)));
   await startedPromise;
   const second=await post(base,11,{},JSON.stringify(browse(11)));
   assert.equal(second.status,503);
   assert.deepEqual(await second.json(),{ok:false});
   assert.equal(calls,1);
   assert.equal((await f.store.snapshot()).updates.length,1);
   unblock();
   assert.equal((await first).status,200);
   assert.equal((await post(base,12,{},JSON.stringify(browse(12)))).status,200);
   assert.equal(calls,2);
   assert.equal((await f.store.snapshot()).updates.length,2);
  });}finally{unblock?.();await f.close();}
 });
}
test('B3 webhook: unauthenticated requests do not consume a capacity slot',async()=>{
 const f=await fixture();try{
  const listener=telegramWebhookListener(f.app(),SECRET,undefined,{maxActive:1});
  await withServer(listener,async base=>{
   assert.equal((await post(base,20,{'x-telegram-bot-api-secret-token':'bad'})).status,401);
   assert.equal((await post(base,21)).status,200);
   assert.equal((await f.store.snapshot()).updates.length,1);
  });
 }finally{await f.close();}
});
test('B3 webhook: invalid capacity/time thresholds fail startup rather than weakening limits',async()=>{
 const f=await fixture();try{
  for(const opts of [{maxActive:0},{maxActive:65},{maxActive:1.5},
   {inactivityTimeoutMs:100},{inactivityTimeoutMs:90_000},{maxActive:1,extra:true}]){
   assert.throws(()=>telegramWebhookListener(f.app(),SECRET,undefined,opts),/INVALID_INGRESS_OPTIONS/);
  }
 }finally{await f.close();}
});
test('B3 webhook: stalled partial body closes socket without creating update',async()=>{
 const f=await fixture();try{
  await withServer(telegramWebhookListener(f.app(),SECRET,undefined,{inactivityTimeoutMs:300}),async(_base,srv)=>{
   const port=(srv.address() as {port:number}).port;
   const client=createConnection({port,host:'127.0.0.1'});await once(client,'connect');
   client.write('POST /telegram/webhook HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'+
    'x-telegram-bot-api-secret-token: '+SECRET+'\r\nContent-Length: 200\r\n\r\n{"update_id":');
   await Promise.race([once(client,'close'),new Promise<never>((_,reject)=>
    setTimeout(()=>reject(Error('SOCKET_STALL_NOT_CLOSED')),3000))]);
   assert.equal((await f.store.snapshot()).updates.length,0);
  });
 }finally{await f.close();}
});
test('B3 admin: signed-owner requests share bounded ingress with no route regressions',async()=>{
 const f=await fixture();try{
  const original=f.admin.panel.bind(f.admin);
  let release!:()=>void,enter!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  const started=new Promise<void>(r=>{enter=r;});
  f.admin.panel=async(...args)=>{enter();await gate;return original(...args);};
  await withServer(telegramAdminWebListener(f.auth,f.admin,undefined,{maxActive:1}),async base=>{
   const send=(actor:number)=>fetch(base+'/admin/panel',{method:'POST',headers:{
    'content-type':'application/json','x-telegram-init-data':sign(actor)},
    body:JSON.stringify({scope:'private'})});
   const first=send(100);await started;
   const overloaded=await send(100);assert.equal(overloaded.status,503);
   const forged=await send(300);assert.equal(forged.status,503);
   release();assert.equal((await first).status,200);
   assert.equal((await send(100)).status,200);
  });
 }finally{await f.close();}
});
test('B3 admin: invalid UTF8, content encoding, malformed custom options are rejected',async()=>{
 const f=await fixture();try{
  for(const opts of [{maxActive:0},{maxActive:65},{inactivityTimeoutMs:20},{maxActive:2,notes:'bad'}])
   assert.throws(()=>telegramAdminWebListener(f.auth,f.admin,undefined,opts),/INVALID_INGRESS_OPTIONS/);
  await withServer(telegramAdminWebListener(f.auth,f.admin),async base=>{
   const h={'content-type':'application/json','x-telegram-init-data':sign(100)};
   const bad=Buffer.concat([Buffer.from('{"scope":"'),Buffer.from([0xff]),Buffer.from('"}')]);
   assert.equal((await fetch(base+'/admin/panel',{method:'POST',headers:h,body:bad})).status,400);
   assert.equal((await fetch(base+'/admin/panel',{method:'POST',headers:{...h,'content-encoding':'gzip'},body:'{}'})).status,415);
  });
 }finally{await f.close();}
});
test('B3 live runtime: strict socket budget is configured before listener activation',async()=>{
 const f=await fixture('sqlite');try{
  const cfg=loadLiveTelegramConfig({BOT_ENV:'production',TELEGRAM_ENABLED:'true',
   TELEGRAM_REPLY_DELIVERY_ENABLED:'true',BOT_OWNER_ID:'100',BOT_ID:'bot-main',
   BOT_USERNAME:'ManaratakBot',BOT_STATE_FILE:f.stateFile,TELEGRAM_BOT_TOKEN:TOKEN,
   TELEGRAM_WEBHOOK_SECRET:SECRET,TELEGRAM_LISTEN_PORT:'8787',
   TELEGRAM_WEBHOOK_PUBLIC_URL:'https://webhook.manaratak-ops.net/telegram/webhook',
   TELEGRAM_SAFETY_FILE:f.safetyFile});
  const server=await createLiveTelegramServer(cfg,(async()=>{throw Error('NO_NETWORK');}) as typeof fetch);
  assert.equal(server.listening,false);
  assert.equal(server.requestTimeout,15_000);
  assert.equal(server.headersTimeout,10_000);
  assert.equal(server.timeout,15_000);
  assert.equal(server.keepAliveTimeout,2_000);
  assert.equal(server.maxHeadersCount,32);
  assert.equal(server.maxRequestsPerSocket,50);
  assert.equal(server.maxConnections,128);
  server.close();
 }finally{await f.close();}
});
test('B3 shutdown: drain does not forcibly close an active request or pretend completion',async()=>{
 let accepted!:()=>void;
 const started=new Promise<void>(r=>{accepted=r;});
 let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const server=createServer((_req,res)=>{
  accepted();void gate.then(()=>{res.writeHead(200);res.end('DONE');});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const port=(server.address() as {port:number}).port;
  const request=fetch('http://127.0.0.1:'+port,{method:'POST',body:'{}'});
  await started;
  assert.equal(await stopLiveTelegramServer(server,200),'DRAINING');
  assert.equal(server.listening,false);
  release();
  assert.equal((await request).status,200);
  assert.equal(await stopLiveTelegramServer(server,2_000),'STOPPED');
 }finally{release?.();if(server.listening){server.close();await once(server,'close');}}
});
test('B3 shutdown: concurrent callers share one safe drain, non-listening server is a no-op',async()=>{
 const server=createServer((_req,res)=>res.end('ok'));
 assert.equal(await stopLiveTelegramServer(server,100),'STOPPED');
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const results=await Promise.all([stopLiveTelegramServer(server,1_000),stopLiveTelegramServer(server,1_000)]);
  assert.deepEqual(results,['STOPPED','STOPPED']);
 }finally{if(server.listening){server.close();await once(server,'close');}}
});
test('B3 shutdown: bounded drain timeout validation fail closed',async()=>{
 const server=createServer((_req,res)=>res.end('ok'));
 for(const n of [0,50,90_000,1.5,NaN]){
  await assert.rejects(stopLiveTelegramServer(server,n),/INVALID_DRAIN_TIMEOUT/);
 }
});
