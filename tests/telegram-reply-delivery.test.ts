import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication,telegramWebhookListener} from '../src/telegram-transport.js';
import {TelegramBotApiTextSender,TelegramReplyDispatcher,type TelegramReplySender} from '../src/telegram-replies.js';
const OWNER='100',STUDENT='300',GROUP='-100123',SECRET='valid_secret_value_abcdefghijklmnopqrstuvwxyz123',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const incoming=(id:number,actor=300,chat=300,text='/categories private',kind='private')=>({
 update_id:id,message:{message_id:id,chat:{id:chat,type:kind},from:{id:actor,is_bot:false},text}
});
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-reply-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json'),store=new BotStore(file,{engine}),policy=new Policy(store,OWNER);
 const safetyFile=join(dir,'safety.flag');await writeFile(safetyFile,'RUN\n',{mode:0o600});
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
 await education.createCategory(OWNER,{id:'grants',scope:'private',title:'Scholarships & <more>',order:1});
 await education.createCategory(OWNER,{id:'group-grants',scope:GROUP,title:'Group grants',order:1});
 const app=()=>new TelegramUpdateApplication({store:new BotStore(file,{engine}),policy,education,admin,faq,links,botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 const sent:{chatId:string;text:string}[]=[];
 let response:'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'='CONFIRMED';
 const sender:TelegramReplySender={send:async(plan)=>{sent.push({chatId:plan.chatId,text:plan.text});return response==='CONFIRMED'?{status:'CONFIRMED',messageId:900}:{status:response}}};
 const dispatcher=()=>new TelegramReplyDispatcher(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER),sender);
 return {dir,file,safetyFile,store,policy,app,dispatcher,sent,fail:(v:typeof response)=>{response=v},close:()=>rm(dir,{force:true,recursive:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(`reply outbox ${engine}: app persists plan atomically and dispatch confirms one Telegram send`,async()=>{
  const f=await fixture(engine);try{
   const x=await f.app().handle(incoming(3));
   assert.equal(x.status,'APPLIED');assert.ok(x.plan);
   assert.equal(x.deliveryKey,'b3-webhook:bot-main:3');
   assert.equal(f.sent.length,0);
   let s=await f.store.snapshot();
   assert.equal(s.telegramReplyJobs?.length,1);
   assert.equal(s.telegramReplyJobs?.[0]?.status,'QUEUED');
   assert.equal(s.updates[0]?.status,'DONE');
   assert.equal((await f.dispatcher().dispatch(x.deliveryKey!)).status,'CONFIRMED');
   assert.equal(f.sent.length,1);
   s=await f.store.snapshot();
   assert.equal(s.telegramReplyJobs?.[0]?.status,'SENT');assert.equal(s.telegramReplyJobs?.[0]?.messageId,900);
   assert.equal((await f.app().handle(incoming(3))).status,'DUPLICATE');
   assert.equal((await f.dispatcher().dispatch(x.deliveryKey!)).status,'SENT');
   assert.equal(f.sent.length,1);
  }finally{await f.close()}
 });
 test(`reply outbox ${engine}: ambiguous post is durable UNKNOWN and never silently replayed`,async()=>{
  const f=await fixture(engine);try{
   const x=await f.app().handle(incoming(4));
   f.fail('UNKNOWN_OUTCOME');
   assert.equal((await f.dispatcher().dispatch(x.deliveryKey!)).status,'UNKNOWN_OUTCOME');
   f.fail('CONFIRMED');
   assert.equal((await f.dispatcher().dispatch(x.deliveryKey!)).status,'UNKNOWN_OUTCOME');
   assert.equal(f.sent.length,1);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.status,'UNKNOWN_OUTCOME');
  }finally{await f.close()}
 });
 test(`reply outbox ${engine}: concurrent workers claim one queue item, including across store instances`,async()=>{
  const f=await fixture(engine);try{
   const x=await f.app().handle(incoming(5));
   const results=await Promise.all([f.dispatcher().dispatch(x.deliveryKey!),f.dispatcher().dispatch(x.deliveryKey!)]);
   assert.equal(results.filter(x=>x.status==='CONFIRMED').length,1);
   assert.equal(f.sent.length,1);
  }finally{await f.close()}
 });
 test(`reply outbox ${engine}: group reply is blocked after revocation before outbound dispatch`,async()=>{
  const f=await fixture(engine);try{
   const x=await f.app().handle(incoming(6,300,Number(GROUP),'/categories','supergroup'));
   assert.equal(x.status,'APPLIED');
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal((await f.dispatcher().dispatch(x.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.status,'FAILED_CONFIRMED');
  }finally{await f.close()}
 });
 test(`reply outbox ${engine}: denied or nonreply updates never enter the outbound queue`,async()=>{
  const f=await fixture(engine);try{
   const denied=await f.app().handle(incoming(7,300,-999,'/categories','supergroup'));
   assert.equal(denied.status,'DENIED');assert.equal(denied.deliveryKey,undefined);
   const ignored=await f.app().handle(incoming(8,300,300,'unknown text'));
   assert.equal(ignored.deliveryKey,undefined);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close()}
 });
}
test('Bot API sendMessage uses POST, fixed host, HTML-safe plan and never emits token in result',async()=>{
 const calls:{url:string;method:string;payload:Record<string,unknown>}[]=[];
 const fake=(async(url:string|URL,init?:RequestInit)=>{
  calls.push({url:String(url),method:init?.method??'',payload:JSON.parse(String(init?.body)) as Record<string,unknown>});
  return new Response(JSON.stringify({ok:true,result:{message_id:66,chat:{id:300}}}),{status:200});
 }) as typeof fetch;
 const sender=new TelegramBotApiTextSender(TOKEN,fake);
 const x=await sender.send({chatId:'300',parseMode:'HTML',text:'Scholarship &amp; grants'});
 assert.deepEqual(x,{status:'CONFIRMED',messageId:66});
 assert.equal(calls.length,1);
 assert.equal(calls[0]?.url,'https://api.telegram.org/bot'+TOKEN+'/sendMessage');
 assert.equal(calls[0]?.method,'POST');
 assert.deepEqual(calls[0]?.payload,{chat_id:'300',text:'Scholarship &amp; grants',
  parse_mode:'HTML',link_preview_options:{is_disabled:true},protect_content:true});
 assert.equal(JSON.stringify(x).includes(TOKEN),false);
});
test('Bot API transport fails closed on explicit errors and unknowns, never retries internally',async()=>{
 let count=0,reply=new Response(JSON.stringify({ok:false,error_code:403,description:'token rejected'}),{status:403});
 const sender=new TelegramBotApiTextSender(TOKEN,(async()=>{count++;return reply.clone()}) as typeof fetch);
 const plan={chatId:'300',parseMode:'HTML' as const,text:'hello'};
 assert.equal((await sender.send(plan)).status,'FAILED_CONFIRMED');
 reply=new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:10}}),{status:429});
 assert.equal((await sender.send(plan)).status,'FAILED_CONFIRMED');
 reply=new Response(JSON.stringify({ok:true,result:{message_id:88,chat:{id:999}}}),{status:200});
 assert.equal((await sender.send(plan)).status,'UNKNOWN_OUTCOME');
 reply=new Response('upstream fail',{status:503});
 assert.equal((await sender.send(plan)).status,'UNKNOWN_OUTCOME');
 assert.equal(count,4);
 const timeout=new TelegramBotApiTextSender(TOKEN,(async()=>{throw new Error('network secret '+TOKEN)}) as typeof fetch);
 assert.deepEqual(await timeout.send(plan),{status:'UNKNOWN_OUTCOME'});
});
test('Bot API invalid token and invalid plan never make a network request',async()=>{
 let count=0;
 const fake=(async()=>{count++;throw new Error('should not call')}) as typeof fetch;
 for(const token of ['', 'token', '000:bad', '1:foo/bar'])assert.throws(()=>new TelegramBotApiTextSender(token,fake),/INVALID_TELEGRAM_TOKEN/);
 const sender=new TelegramBotApiTextSender(TOKEN,fake);
 for(const plan of [{chatId:'abc',parseMode:'HTML' as const,text:'Hello'},
  {chatId:'-100',parseMode:'HTML' as const,text:''},
  {chatId:'100',parseMode:'HTML' as const,text:'a'.repeat(5000)}]){
  assert.deepEqual(await sender.send(plan),{status:'FAILED_CONFIRMED'});
 }
 assert.equal(count,0);
});
test('webhook optional sender flushes persisted reply exactly once without token or HTML in HTTP response',async()=>{
 const f=await fixture();const server=createServer(telegramWebhookListener(f.app(),SECRET,f.dispatcher()));
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw Error('NO_PORT');
  const url='http://127.0.0.1:'+address.port+'/telegram/webhook';
  const post=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':SECRET},
   body:JSON.stringify(incoming(101))});
  const response=await post();
  assert.equal(response.status,200);
  const json=await response.json();
  assert.deepEqual(json,{ok:true,status:'APPLIED'});
  assert.equal(f.sent.length,1);
  assert.equal((await post()).status,200);assert.equal(f.sent.length,1);
  assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.status,'SENT');
 }finally{server.close();await once(server,'close');await f.close()}
});

test('live server configuration is fail-closed and never enables Telegram by default',async()=>{
 const {loadLiveTelegramConfig}=await import('../src/telegram-live-server.js');
 const f=await fixture('sqlite');try{
  const config={BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
   BOT_OWNER_ID:OWNER,BOT_ID:'bot-main',BOT_USERNAME:'ManaratakBot',
   BOT_STATE_FILE:f.file,TELEGRAM_BOT_TOKEN:TOKEN,
   TELEGRAM_WEBHOOK_SECRET:SECRET,TELEGRAM_LISTEN_PORT:'8787',
   TELEGRAM_WEBHOOK_PUBLIC_URL:'https://webhook.manaratak-ops.net/telegram/webhook',
   TELEGRAM_SAFETY_FILE:f.safetyFile};
  const c=loadLiveTelegramConfig(config);
  assert.equal(c.ownerId,OWNER);assert.equal(c.stateFile,f.file);assert.equal(c.listenPort,8787);
  for(const patch of [
   {TELEGRAM_ENABLED:'false'}, {TELEGRAM_REPLY_DELIVERY_ENABLED:'false'},
   {BOT_ENV:'development'}, {BOT_OWNER_ID:'student'}, {BOT_STATE_FILE:'relative.sqlite'},
   {TELEGRAM_BOT_TOKEN:'bad'}, {TELEGRAM_WEBHOOK_SECRET:'short'},
   {BOT_USERNAME:'bad'}, {TELEGRAM_LISTEN_PORT:'0'}, {TELEGRAM_LISTEN_PORT:'99999'},
   {TELEGRAM_LISTEN_PORT:'80.5'}
  ])assert.throws(()=>loadLiveTelegramConfig({...config,...patch}),/LIVE_TELEGRAM_CONFIG_INVALID/);
  assert.throws(()=>loadLiveTelegramConfig({}),/LIVE_TELEGRAM_CONFIG_INVALID/);
 }finally{await f.close()}
});
test('live server refuses missing, public and uninitialized state files before opening a port',async()=>{
 const {loadLiveTelegramConfig,createLiveTelegramServer}=await import('../src/telegram-live-server.js');
 const f=await fixture('sqlite');try{
  const env={BOT_ENV:'production',TELEGRAM_ENABLED:'true',TELEGRAM_REPLY_DELIVERY_ENABLED:'true',
   BOT_OWNER_ID:OWNER,BOT_ID:'bot-main',BOT_USERNAME:'ManaratakBot',
   BOT_STATE_FILE:f.file,TELEGRAM_BOT_TOKEN:TOKEN,
   TELEGRAM_WEBHOOK_SECRET:SECRET,TELEGRAM_LISTEN_PORT:'8787',
   TELEGRAM_WEBHOOK_PUBLIC_URL:'https://webhook.manaratak-ops.net/telegram/webhook',
   TELEGRAM_SAFETY_FILE:f.safetyFile};
  await assert.rejects(createLiveTelegramServer(loadLiveTelegramConfig({...env,BOT_STATE_FILE:join(f.dir,'absent.sqlite')})),/LIVE_TELEGRAM_STATE_INVALID/);
  const {chmod}=await import('node:fs/promises');
  await chmod(f.file,0o644);
  await assert.rejects(createLiveTelegramServer(loadLiveTelegramConfig(env)),/LIVE_TELEGRAM_STATE_INVALID/);
  await chmod(f.file,0o600);
  const server=await createLiveTelegramServer(loadLiveTelegramConfig(env));
  try{assert.equal(server.listening,false);}finally{server.close();}
 }finally{await f.close()}
});
test('private /start and /help produce user guidance without bypassing group admission',async()=>{
 const f=await fixture();try{
  const start=await f.app().handle(incoming(222,300,300,'/start'));
  assert.equal(start.status,'APPLIED');assert.match(start.plan?.text??'',/منارتك/);
  assert.ok(start.deliveryKey);
  const help=await f.app().handle(incoming(223,300,300,'/help'));
  assert.equal(help.status,'APPLIED');assert.match(help.plan?.text??'',/categories/);
  assert.equal((await f.app().handle(incoming(224,300,-999,'/start','supergroup'))).deliveryKey,undefined);
  assert.equal((await f.store.snapshot()).telegramReplyJobs?.length,2);
 }finally{await f.close()}
});


for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': queued legacy group plan without classified origin is not sent on upgraded dispatcher',async()=>{
  const f=await fixture(engine);try{
   // Simulates a v0.7.50 and earlier job left QUEUED during deployment.
   const accepted=await f.app().handle(incoming(1200,300,Number(GROUP),'/categories','supergroup'));
   assert.equal(accepted.status,'APPLIED');
   // Explicitly reconstruct a v0.7.50 group job that predates the kind
   // discriminator; a newly queued group menu correctly has GENERAL.
   await f.store.transaction(s=>{delete s.telegramReplyJobs![0]!.groupReplyKind;});
   const before=(await f.store.snapshot()).telegramReplyJobs![0]!;
   assert.equal(before.groupReplyKind,undefined);
   assert.equal(before.groupQuestionAccess,undefined);
   assert.ok(before.plan?.text);
   const result=await f.dispatcher().dispatch(accepted.deliveryKey!);
   assert.equal(result.status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
   const job=(await f.store.snapshot()).telegramReplyJobs![0]!;
   assert.equal(job.status,'FAILED_CONFIRMED');
   assert.equal(job.plan,undefined);
   assert.equal(job.groupReplyKind,undefined);
   assert.equal(job.groupQuestionAccess,undefined);
   assert.ok(job.redactedAt!==undefined);
   assert.equal(job.attemptId,undefined);
   assert.equal((await f.dispatcher().dispatch(accepted.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': newly created generic group menu job is explicitly classified and remains sendable',async()=>{
  const f=await fixture(engine);try{
   const accepted=await f.app().handle(incoming(1201,300,Number(GROUP),'/categories','supergroup'));
   assert.equal(accepted.status,'APPLIED');
   const before=(await f.store.snapshot()).telegramReplyJobs![0]!;
   assert.equal(before.groupReplyKind,'GENERAL');
   assert.equal(before.groupQuestionAccess,undefined);
   assert.equal((await f.dispatcher().dispatch(accepted.deliveryKey!)).status,'CONFIRMED');
   assert.equal(f.sent.length,1);
   const after=(await f.store.snapshot()).telegramReplyJobs![0]!;
   assert.equal(after.status,'SENT');
   assert.equal(after.groupReplyKind,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': preupgrade unclassified private response remains dispatchable',async()=>{
  const f=await fixture(engine);try{
   const accepted=await f.app().handle(incoming(1202));
   assert.equal(accepted.status,'APPLIED');
   assert.equal((await f.store.snapshot()).telegramReplyJobs![0]?.groupReplyKind,undefined);
   assert.equal((await f.dispatcher().dispatch(accepted.deliveryKey!)).status,'CONFIRMED');
   assert.equal(f.sent.length,1);
  }finally{await f.close();}
 });
 test('B6 '+engine+': invalid group classification values cannot be persisted',async()=>{
  const f=await fixture(engine);try{
   const accepted=await f.app().handle(incoming(1203,300,Number(GROUP),'/categories','supergroup'));
   assert.equal(accepted.status,'APPLIED');
   const original=await f.store.snapshot();
   for(const invalid of ['', 'FAQ', 'GENERAL ', 1, null, {}, ['GENERAL']]){
    await assert.rejects(f.store.transaction(s=>{
     (s.telegramReplyJobs![0] as unknown as Record<string,unknown>).groupReplyKind=invalid;
    }),/Unsupported state schema/);
    assert.deepEqual(await f.store.snapshot(),original);
   }
  }finally{await f.close();}
 });
 test('B6 '+engine+': group classification cannot mislabel a guarded FAQ as general or an unguarded menu as FAQ',async()=>{
  const f=await fixture(engine);try{
   await f.app().handle(incoming(1204,300,Number(GROUP),'/categories','supergroup'));
   const original=await f.store.snapshot();
   await assert.rejects(f.store.transaction(s=>{
    s.telegramReplyJobs![0]!.groupReplyKind='REVIEWED_FAQ';
   }),/Unsupported state schema/);
   assert.deepEqual(await f.store.snapshot(),original);
  }finally{await f.close();}
 });
 test('B6 '+engine+': old group sends already in SENDING or UNKNOWN_OUTCOME are never replayed',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    s.telegramReplyJobs=[
     {updateKey:'b3-webhook:bot-main:1205',status:'SENDING',attemptId:'old',startedAt:120},
     {updateKey:'b3-webhook:bot-main:1206',status:'UNKNOWN_OUTCOME',attemptId:'old',startedAt:120}
    ];
   });
   assert.equal((await f.dispatcher().dispatch('b3-webhook:bot-main:1205')).status,'UNKNOWN_OUTCOME');
   assert.equal((await f.dispatcher().dispatch('b3-webhook:bot-main:1206')).status,'UNKNOWN_OUTCOME');
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
}
