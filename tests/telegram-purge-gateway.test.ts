import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TelegramBotApiPurgeGateway} from '../src/telegram-purge-gateway.js';
import {ModerationPurgeService} from '../src/moderation-purge.js';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',CHAT='-100123',OWNER='100',NOW=30*86400000;
const response=(result:unknown,status=200)=>new Response(JSON.stringify({ok:status===200,...(status===200?{result}:result as object)}),{status,headers:{'content-type':'application/json'}});
const rights=()=>response({status:'administrator',user:{id:123456789,is_bot:true},can_delete_messages:true});
const requester=(fn:(method:string,body:Record<string,unknown>)=>Response|Promise<Response>)=>{
 const calls:string[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;calls.push(method);
  return fn(method,JSON.parse(String(init?.body)));
 }) as typeof fetch;
 return {request,calls};
};
test('delete adapter requires independent gate and durable authority before sending',async()=>{
 const f=requester(()=>rights());
 const disabled=new TelegramBotApiPurgeGateway(TOKEN,f.request);
 assert.equal(await disabled.canDelete(CHAT),false);
 assert.equal(await disabled.deleteMessage(CHAT,10,'attempt'), 'FAILED_CONFIRMED');
 assert.equal(f.calls.length,0);
 const enabled=new TelegramBotApiPurgeGateway(TOKEN,f.request,async()=>true);
 assert.equal(await enabled.deleteMessage(CHAT,10,'attempt'),'FAILED_CONFIRMED');
 assert.equal(f.calls.length,0,'missing authority must not reach Telegram');
 assert.equal(await enabled.deleteMessage(CHAT,10,'attempt',async()=>false),'FAILED_CONFIRMED');
 assert.equal(f.calls.filter(m=>m==='deleteMessage').length,0);
});
test('delete adapter sends exact reviewed ID and only reports request acknowledgement',async()=>{
 const f=requester((method,body)=>{
  if(method==='getChatMember')return rights();
  assert.equal(method,'deleteMessage');assert.deepEqual(body,{chat_id:CHAT,message_id:10});
  return response(true);
 });
 const gateway=new TelegramBotApiPurgeGateway(TOKEN,f.request,async()=>true);
 assert.equal(await gateway.deleteMessage(CHAT,10,'attempt',async()=>true),'ACKNOWLEDGED');
 assert.equal(f.calls.filter(m=>m==='deleteMessage').length,1);
 assert.equal(await gateway.verifyEvidence({evidenceId:'x',chatId:CHAT,messageId:10,attemptId:'attempt',outcome:'ACKNOWLEDGED'}),false);
});
test('STOP or revoked authority during rights lookup prevents deletion',async()=>{
 let running=true,authorized=true;
 const f=requester(()=>{running=false;authorized=false;return rights();});
 const gateway=new TelegramBotApiPurgeGateway(TOKEN,f.request,async()=>running);
 assert.equal(await gateway.deleteMessage(CHAT,10,'attempt',async()=>authorized),'FAILED_CONFIRMED');
 assert.equal(f.calls.filter(m=>m==='deleteMessage').length,0);
});
test('rights lost while local authority is read cannot authorize a late delete',async()=>{
 let permitted=true;
 const f=requester(method=>method==='getChatMember'?response({status:'administrator',user:{id:123456789,is_bot:true},can_delete_messages:permitted}):response(true));
 const gateway=new TelegramBotApiPurgeGateway(TOKEN,f.request,async()=>true);
 assert.equal(await gateway.deleteMessage(CHAT,10,'attempt',async()=>{permitted=false;return true;}),'FAILED_CONFIRMED');
 assert.equal(f.calls.filter(m=>m==='deleteMessage').length,0);
});
test('delete adapter distinguishes explicit rate rejection, confirmed failure and unknown outcomes',async()=>{
 for(const [reply,expected] of [
  [()=>response({error_code:429,parameters:{retry_after:2}},429),{status:'RATE_LIMITED',retryAfterMs:2000}],
  [()=>response({error_code:429,parameters:{retry_after:'2'}},429),'UNKNOWN_OUTCOME'],
  [()=>response({error_code:403},403),'FAILED_CONFIRMED'],
  [()=>response(true,500),'UNKNOWN_OUTCOME'],
  [()=>{throw Error('timeout');},'UNKNOWN_OUTCOME'],
  [()=>response(false),'UNKNOWN_OUTCOME']
 ] as const){
  const f=requester(method=>method==='getChatMember'?rights():reply());
  const gateway=new TelegramBotApiPurgeGateway(TOKEN,f.request,async()=>true);
  assert.deepEqual(await gateway.deleteMessage(CHAT,10,'attempt',async()=>true),expected);
  assert.equal(f.calls.filter(m=>m==='deleteMessage').length,1);
 }
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'telegram-purge-'));
  const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,OWNER,()=>NOW);
  await policy.approveChat(OWNER,CHAT,['moderation']);
  return {store,policy,close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('reviewed purge uses the adapter and never retries an unknown delete ('+engine+')',async()=>{
  const f=await fixture();try{
   const r=requester(method=>{if(method==='getChatMember')return rights();throw Error('timeout');});
   const service=new ModerationPurgeService(f.store,f.policy,new TelegramBotApiPurgeGateway(TOKEN,r.request,async()=>true),()=>NOW);
   await service.observe({chatId:CHAT,messageId:10,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});
   const job=await service.preview(OWNER,CHAT,{limit:1});await service.confirm(OWNER,job.id);
   assert.equal((await service.dispatchNext(job.id)).status,'UNKNOWN_OUTCOME');
   assert.equal((await service.dispatchNext(job.id)).status,'BLOCKED_UNKNOWN');
   assert.equal(r.calls.filter(m=>m==='deleteMessage').length,1);
  }finally{await f.close();}
 });
 test('late deletion acceptance after group revocation is quarantined ('+engine+')',async()=>{
  const f=await fixture();try{
   const r=requester(async method=>{
    if(method==='getChatMember')return rights();
    await f.policy.revokeChat(OWNER,CHAT);return response(true);
   });
   const service=new ModerationPurgeService(f.store,f.policy,new TelegramBotApiPurgeGateway(TOKEN,r.request,async()=>true),()=>NOW);
   await service.observe({chatId:CHAT,messageId:10,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});
   const job=await service.preview(OWNER,CHAT,{limit:1});await service.confirm(OWNER,job.id);
   assert.equal((await service.dispatchNext(job.id)).status,'UNKNOWN_OUTCOME');
   assert.equal((await f.store.snapshot()).purgeJobs[0]?.items[0]?.status,'UNKNOWN_OUTCOME');
  }finally{await f.close();}
 });
}
