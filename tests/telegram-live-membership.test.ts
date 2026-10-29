import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {TelegramBotApiMembershipGateway} from '../src/telegram-membership.js';
import {loadLiveTelegramConfig,createLiveTelegramServer} from '../src/telegram-live-server.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const SECRET='abcdefghijklmnopqrstuvwx_123456789ABCDE',GROUP='-100123',CHANNEL='-100999',STUDENT='300',OWNER='100';
const reply=(status:string,id:number=300,more:Record<string,unknown>={})=>new Response(JSON.stringify({
 ok:true,result:{status,user:{id,is_bot:false,first_name:'person'},...more}
}),{status:200,headers:{'content-type':'application/json'}});
const admin=(id=123456789)=>reply('administrator',id);
function fakeRequester(fn:(url:string,body:Record<string,unknown>)=>Response|Promise<Response>):{
 request:typeof fetch;calls:{url:string;body:Record<string,unknown>;init:RequestInit}[] }{
 const calls:{url:string;body:Record<string,unknown>;init:RequestInit}[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  calls.push({url:String(url),body,init:init??{}});
  return fn(String(url),body);
 }) as typeof fetch;
 return {request,calls};
}
test('membership gateway rejects invalid token and malformed IDs before any network call',async()=>{
 let calls=0;const fetchStub=(async()=>{calls++;throw new Error('network must not be used')}) as typeof fetch;
 for(const token of ['', '123:broken', '123456789:short','123456789:A/B'])assert.throws(
  ()=>new TelegramBotApiMembershipGateway(token,fetchStub),/INVALID_TELEGRAM_TOKEN/);
 const gw=new TelegramBotApiMembershipGateway(TOKEN,fetchStub);
 for(const chat of ['private','1','-0','-100foo','--100','-9007199254740999','-100/123']){
  assert.equal(await gw.canVerifyChannel(chat),false);
  assert.equal(await gw.getMember(chat,STUDENT),'UNKNOWN');
  assert.equal(await gw.verifyMembership(chat,STUDENT),'UNKNOWN');
 }
 for(const user of ['0','-1','abc','2.2','9007199254740992','10/11','01']){
  assert.equal(await gw.getMember(GROUP,user),'UNKNOWN');
  assert.equal(await gw.verifyMembership(GROUP,user),'UNKNOWN');
 }
 assert.equal(calls,0);
});
test('canVerifyChannel requires matching bot id with administrator or creator status',async()=>{
 for(const status of ['administrator','creator','member','restricted','left','kicked','mystery']){
  const {request,calls}=fakeRequester(()=>reply(status,123456789));
  const gateway=new TelegramBotApiMembershipGateway(TOKEN,request);
  assert.equal(await gateway.canVerifyChannel(GROUP),status==='administrator'||status==='creator');
  assert.equal(calls.length,1);
  assert.equal(calls[0]?.url,'https://api.telegram.org/bot'+TOKEN+'/getChatMember');
  assert.equal(calls[0]?.init.method,'POST');
  assert.equal(calls[0]?.init.redirect,'error');
  assert.deepEqual(calls[0]?.body,{chat_id:GROUP,user_id:123456789});
 }
 const mismatch=fakeRequester(()=>admin(123456780));
 assert.equal(await new TelegramBotApiMembershipGateway(TOKEN,mismatch.request).canVerifyChannel(GROUP),false);
});
test('membership result mapping is strict, including restricted member flag',async()=>{
 const cases:[
  string,boolean|undefined,'MEMBER'|'NOT_MEMBER'|'UNKNOWN'
 ][]=[
 ['member',undefined,'MEMBER'],['administrator',undefined,'MEMBER'],['creator',undefined,'MEMBER'],
 ['restricted',true,'MEMBER'],['restricted',false,'NOT_MEMBER'],['restricted',undefined,'UNKNOWN'],
 ['left',undefined,'NOT_MEMBER'],['kicked',undefined,'NOT_MEMBER'],['unrecognized',undefined,'UNKNOWN']
 ];
 for(const [status,is_member,expected] of cases){
  const {request}=fakeRequester(()=>reply(status,300,is_member===undefined?{}:{is_member}));
  assert.equal(await new TelegramBotApiMembershipGateway(TOKEN,request).getMember(GROUP,STUDENT),expected,status);
 }
});
test('gateway rejects forged user identity, unexpected bots, malformed JSON and API denial as unknown',async()=>{
 const responses=[
  reply('member',301),
  reply('member',300,{user:{id:300,is_bot:true}}),
  new Response(JSON.stringify({ok:true,result:{status:'member'}}),{status:200}),
  new Response(JSON.stringify({ok:false,error_code:403,description:'token='+TOKEN}),{status:403}),
  new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:30}}),{status:429}),
  new Response('not json',{status:200}),
  new Response(JSON.stringify({ok:true,result:{status:'member',user:{id:'300'}}}),{status:200}),
  new Response('a'.repeat(18000),{status:200}),
  new Response(JSON.stringify({ok:true,result:{status:'member',user:{id:300}}}),{status:503})
 ];
 let calls=0;
 const {request}=fakeRequester(()=>{const r=responses[calls++];if(!r)throw Error('out of responses');return r});
 const gw=new TelegramBotApiMembershipGateway(TOKEN,request);
 for(let i=0;i<responses.length;i++)assert.equal(await gw.getMember(GROUP,STUDENT),'UNKNOWN');
 assert.equal(calls,responses.length);
 const down=new TelegramBotApiMembershipGateway(TOKEN,(async()=>{throw new Error('private-token-'+TOKEN)}) as typeof fetch);
 assert.equal(await down.getMember(GROUP,STUDENT),'UNKNOWN');
 assert.equal(await down.canVerifyChannel(GROUP),false);
 assert.equal(await down.verifyMembership(GROUP,STUDENT),'UNKNOWN');
});
test('verifyMembership requires fresh administrator preflight and does not check user if bot is not admin',async()=>{
 const {request,calls}=fakeRequester((_,b)=>b.user_id===123456789?reply('member',123456789):reply('member',300));
 const gw=new TelegramBotApiMembershipGateway(TOKEN,request);
 assert.equal(await gw.verifyMembership(GROUP,STUDENT),'UNKNOWN');
 assert.equal(calls.length,1);
 const yes=fakeRequester((_,b)=>b.user_id===123456789?admin():reply('restricted',300,{is_member:true}));
 assert.equal(await new TelegramBotApiMembershipGateway(TOKEN,yes.request).verifyMembership(GROUP,STUDENT),'VERIFIED');
 assert.deepEqual(yes.calls.map(x=>x.body.user_id),[123456789,300]);
 const no=fakeRequester((_,b)=>b.user_id===123456789?admin():reply('left',300));
 assert.equal(await new TelegramBotApiMembershipGateway(TOKEN,no.request).verifyMembership(GROUP,STUDENT),'NOT_MEMBER');
});
test('live webhook checks actual membership for private group catalog, sends reply and never discloses token',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'manaratak-live-member-'));const path=join(directory,'state.sqlite');
 const safetyFile=join(directory,'safety.flag');await writeFile(safetyFile,'RUN\n',{mode:0o600});
 const store=new BotStore(path,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);await policy.approveChat(OWNER,GROUP,['navigation','verification']);
 const education=new EducationService(store,policy);
 await education.createCategory(OWNER,{id:'grants',scope:GROUP,title:'Approved scholarships',order:1});
 const env={BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
  BOT_OWNER_ID:OWNER,BOT_ID:'manaratak-test-bot',BOT_USERNAME:'ManaratakBot',
  BOT_STATE_FILE:path,TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_WEBHOOK_SECRET:SECRET,
  TELEGRAM_LISTEN_PORT:'8787',TELEGRAM_WEBHOOK_PUBLIC_URL:'https://webhook.manaratak-ops.net/telegram/webhook',
  TELEGRAM_SAFETY_FILE:safetyFile};
 const {request,calls}=fakeRequester((url,body)=>{
  if(url.endsWith('/getChatMember'))return body.user_id===123456789?admin():reply('member',300);
  if(url.endsWith('/sendMessage'))return new Response(JSON.stringify({ok:true,
    result:{message_id:91,chat:{id:300}}}),{status:200});
  throw Error('UNEXPECTED_METHOD');
 });
 await chmod(path,0o600);
 const server=await createLiveTelegramServer(loadLiveTelegramConfig(env),request);
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address();if(!addr||typeof addr==='string')throw Error('missing port');
  const endpoint='http://127.0.0.1:'+addr.port+'/telegram/webhook';
  const body={update_id:101,message:{message_id:101,chat:{id:300,type:'private'},
    from:{id:300,is_bot:false},text:'/categories '+GROUP}};
  const call=()=>fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',
    'x-telegram-bot-api-secret-token':SECRET},body:JSON.stringify(body)});
  const first=await call();
  assert.deepEqual(await first.json(),{ok:true,status:'APPLIED'});
  assert.equal(first.status,200);
  assert.deepEqual(calls.map(c=>c.url.split('/').at(-1)),['getChatMember','getChatMember','getChatMember','getChatMember','sendMessage']);
  assert.equal(calls[4]?.body.chat_id,'300');
  assert.match(String(calls[4]?.body.text),/Approved scholarships/);
  assert.equal((await call()).status,200);
  assert.equal(calls.length,5);
  const snapshot=await store.snapshot();assert.equal(snapshot.telegramReplyJobs?.[0]?.status,'SENT');
  assert.equal(JSON.stringify(snapshot.telegramReplyJobs).includes(TOKEN),false);
 }finally{server.close();await once(server,'close');await rm(directory,{recursive:true,force:true})}
});
test('live denied membership cannot generate private scoped reply and never calls sendMessage',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'manaratak-live-refuse-'));const path=join(directory,'state.sqlite');
 const safetyFile=join(directory,'safety.flag');await writeFile(safetyFile,'RUN\n',{mode:0o600});
 const store=new BotStore(path,{engine:'sqlite'}),policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,GROUP,['navigation','verification']);
 await new EducationService(store,policy).createCategory(OWNER,{id:'grants',scope:GROUP,title:'Scholarships',order:1});
 const env={BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
  BOT_OWNER_ID:OWNER,BOT_ID:'manaratak-test-bot',BOT_USERNAME:'ManaratakBot',
  BOT_STATE_FILE:path,TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_WEBHOOK_SECRET:SECRET,
  TELEGRAM_LISTEN_PORT:'8787',TELEGRAM_WEBHOOK_PUBLIC_URL:'https://webhook.manaratak-ops.net/telegram/webhook',
  TELEGRAM_SAFETY_FILE:safetyFile};
 const {request,calls}=fakeRequester((url,body)=>{
  if(!url.endsWith('/getChatMember'))throw Error('unexpected send');
  return body.user_id===123456789?admin():reply('left',300);
 });
 await chmod(path,0o600);
 const server=await createLiveTelegramServer(loadLiveTelegramConfig(env),request);
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address();if(!addr||typeof addr==='string')throw Error('PORT');
  const endpoint='http://127.0.0.1:'+addr.port+'/telegram/webhook';
  const resp=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',
   'x-telegram-bot-api-secret-token':SECRET},body:JSON.stringify({update_id:99,message:{
   message_id:99,chat:{id:300,type:'private'},from:{id:300,is_bot:false},
   text:'/categories '+GROUP}})});
  assert.equal(resp.status,200);
  assert.deepEqual(await resp.json(),{ok:true,status:'DENIED'});
  assert.equal(calls.length,2);
  assert.equal((await store.snapshot()).telegramReplyJobs?.length??0,0);
 }finally{server.close();await once(server,'close');await rm(directory,{recursive:true,force:true})}
});
test('live membership preflight honors group approval revoked during asynchronous provider call',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'manaratak-live-revoke-'));const path=join(directory,'state.sqlite');
 const safetyFile=join(directory,'safety.flag');await writeFile(safetyFile,'RUN\n',{mode:0o600});
 const store=new BotStore(path,{engine:'sqlite'}),policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,GROUP,['navigation','verification']);
 await new EducationService(store,policy).createCategory(OWNER,{id:'grants',scope:GROUP,title:'Scholarships',order:1});
 const gwRequester=fakeRequester(async(_,body)=>{
  if(body.user_id===123456789)return admin();
  await policy.revokeChat(OWNER,GROUP);
  return reply('member',300);
 });
 const gw=new TelegramBotApiMembershipGateway(TOKEN,gwRequester.request);
 assert.equal(await gw.verifyMembership(GROUP,STUDENT),'VERIFIED');
 // Trusted Telegram membership cannot override local revocation; application rechecks the store.
 const {EducationAdminFacade}=await import('../src/education-admin.js');
 const {ApprovedAnswerService,ResourceLinkService}=await import('../src/education-interactions.js');
 const {TelegramUpdateApplication}=await import('../src/telegram-transport.js');
 const edu=new EducationService(store,policy),ctx={store,policy,education:edu,
  admin:new EducationAdminFacade(store,policy,edu),
  faq:new ApprovedAnswerService(store,policy),
  links:new ResourceLinkService(store,policy),botId:'safe-bot',botUsername:'ManaratakBot',
  membership:(scope:string,user:string)=>gw.verifyMembership(scope,user)};
 const app=new TelegramUpdateApplication(ctx);
 const x=await app.handle({update_id:25,message:{message_id:25,chat:{id:300,type:'private'},
  from:{id:300,is_bot:false},text:'/categories '+GROUP}});
 assert.equal(x.status,'DENIED');assert.equal(x.deliveryKey,undefined);
 await rm(directory,{recursive:true,force:true});
});

test('live server uses inline owner and student entries while preserving legacy owner tools (offline HTTP)',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'manaratak-inline-entry-'));
 const path=join(directory,'state.sqlite'),safetyFile=join(directory,'safety.flag');
 let server:Awaited<ReturnType<typeof createLiveTelegramServer>>|undefined;
 try{
  await writeFile(safetyFile,'RUN\n',{mode:0o600});
  await new BotStore(path,{engine:'sqlite'}).transaction(()=>{});
  await chmod(path,0o600);
  const env={BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
   BOT_OWNER_ID:OWNER,BOT_ID:'inline-test-bot',BOT_USERNAME:'ManaratakBot',BOT_STATE_FILE:path,
   TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_WEBHOOK_SECRET:SECRET,TELEGRAM_LISTEN_PORT:'8787',
   TELEGRAM_WEBHOOK_PUBLIC_URL:'https://webhook.manaratak-ops.net/telegram/webhook',TELEGRAM_SAFETY_FILE:safetyFile};
  const {request,calls}=fakeRequester((url,body)=>{
   assert.ok(url.endsWith('/sendMessage'),'unexpected external method');
   return new Response(JSON.stringify({ok:true,result:{message_id:91,chat:{id:Number(body.chat_id)}}}),{status:200});
  });
  server=await createLiveTelegramServer(loadLiveTelegramConfig(env),request);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const endpoint='http://127.0.0.1:'+addr.port+'/telegram/webhook';
  let update=500;
  for(const [actor,text] of [[100,'🔐 لوحة المالك'],[100,'/ownerlegacy'],[300,'📂 التعليم والموارد']] as const){
   const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',
    'x-telegram-bot-api-secret-token':SECRET},body:JSON.stringify({update_id:update++,message:{
     message_id:500,from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text}})});
   assert.equal(response.status,200);
   assert.deepEqual(await response.json(),{ok:true,status:'APPLIED'});
  }
  assert.equal(calls.length,3);
  const inline=calls[0]!.body.reply_markup as {inline_keyboard?:unknown;keyboard?:unknown};
  assert.ok(Array.isArray(inline.inline_keyboard));assert.equal(inline.keyboard,undefined);
  const legacy=calls[1]!.body.reply_markup as {keyboard?:unknown};
  assert.ok(Array.isArray(legacy.keyboard));
  const student=calls[2]!.body.reply_markup as {inline_keyboard:{callback_data:string}[][]};
  assert.ok(student.inline_keyboard.flat().some(b=>b.callback_data==='si:2:a:h'));
  assert.equal(calls[2]!.body.chat_id,'300');
 }finally{
  if(server?.listening){server.close();await once(server,'close');}
  await rm(directory,{recursive:true,force:true});
 }
});
