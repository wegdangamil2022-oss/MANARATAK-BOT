import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupServiceMessageCleanup} from '../src/group-service-message-cleanup.js';
import {GroupAdminCommandCleanup} from '../src/group-admin-command-cleanup.js';
import {GroupCleanupAudit,TelegramGroupCleanupAuditSender} from '../src/group-cleanup-audit.js';
import {TelegramPrivateAuditChannelReader} from '../src/telegram-private-audit-channel.js';
import {TelegramCleanupAuditChannelOwner} from '../src/telegram-cleanup-audit-channel-owner.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {AdminRoomLinks} from '../src/admin-room-links.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',OWNER='100',GROUP='-100',ROOM='-200',CHANNEL='-300',BASE=1700000000000;
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'audit-channel-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=BASE,running=true,privacy:'PRIVATE'|'PUBLIC'|'GROUP'|'MISMATCH'|'UNKNOWN'='PRIVATE',
    post:'GRANTED'|'DENIED'|'UNKNOWN'|'CREATOR'='GRANTED',response:'CONFIRMED'|'WRONG_SENDER'|'UNKNOWN'='CONFIRMED';
  let duringRead:(()=>Promise<void>)|undefined,reads=0;
  const calls:{method:string;body:Record<string,unknown>}[]=[];
  const policy=new Policy(store,OWNER,()=>now);
  await policy.approveChat(OWNER,GROUP,['moderation','verification','navigation']);
  await policy.approveChat(OWNER,ROOM,['moderation']);
  await policy.grant(OWNER,'301','chat.manage',GROUP,now+86400000);
  await policy.grant(OWNER,'302','chat.manage',ROOM,now+86400000);
  const api=(async(url:unknown,init?:RequestInit)=>{
   const method=String(url).split('/').at(-1)!,
    body=JSON.parse(String(init?.body??'{}')) as Record<string,unknown>;
   calls.push({method,body});
   if(method==='getChat'){
    if(String(body.chat_id)===CHANNEL){
     reads++;if(duringRead){const run=duringRead;duringRead=undefined;await run();}
     if(privacy==='UNKNOWN')throw Error('unknown channel status');
     return Response.json({ok:true,result:{id:privacy==='MISMATCH'?-301:Number(CHANNEL),
      type:privacy==='GROUP'?'supergroup':'channel',
      ...(privacy==='PUBLIC'?{active_usernames:['PublicAuditChannel']}:{}),title:'PRIVATE AUDIT TITLE'}});
    }
    return Response.json({ok:true,result:{id:Number(ROOM),type:'supergroup'}});
   }
   if(method==='getChatMember'){
    assert.equal(body.chat_id,CHANNEL);assert.equal(body.user_id,123456789);
    if(post==='UNKNOWN')throw Error('rights unavailable');
    return Response.json({ok:true,result:{status:post==='CREATOR'?'creator':'administrator',
     user:{id:123456789,is_bot:true},...(post==='CREATOR'?{}:{can_post_messages:post==='GRANTED'})}});
   }
   assert.equal(method,'sendMessage');
   if(response==='UNKNOWN')throw Error('lost Telegram reply');
   const isChannel=String(body.chat_id)===CHANNEL;
   return Response.json({ok:true,result:{message_id:56,chat:{id:Number(body.chat_id),type:isChannel?'channel':'supergroup'},
    ...(isChannel?{sender_chat:{id:response==='WRONG_SENDER'?-999:Number(CHANNEL),type:'channel'}}:{from:{id:123456789,is_bot:true}})}});
  }) as typeof fetch;
  const reader=new TelegramPrivateAuditChannelReader(TOKEN,api);
  const gateway=new TelegramBotApiModerationGateway(TOKEN,api,async()=>running,()=>now);
  const service=new GroupServiceMessageCleanup(store,policy,{delete:async(_g,_id,verify)=>await verify()?'ACKNOWLEDGED':'NOT_SENT'},
   ()=>now,async()=>running,async()=> 'GRANTED');
  const admin=new GroupAdminCommandCleanup(store,policy,{delete:async(_g,_id,verify)=>await verify()?'ACKNOWLEDGED':'NOT_SENT'},
   ()=>now,async()=>running,async()=> 'GRANTED');
  const audit=new GroupCleanupAudit(store,policy,service,admin,gateway,
   new TelegramGroupCleanupAuditSender(TOKEN,api),()=>now,async()=>running,reader);
  const owner=new TelegramCleanupAuditChannelOwner(store,policy,audit,()=>now);
  const links=new AdminRoomLinks(store,policy,()=>now);
  const linkRoom=async()=>{const id=await links.propose('301',GROUP,ROOM,'NOTIFICATIONS');assert.ok(id);assert.equal(await links.approve('301',id,'GROUP'),'PENDING');assert.equal(await links.approve('302',id,'ROOM'),'ACTIVE');return id;};
  const configure=async(channel:string|null=CHANNEL)=>{
   const expected=audit.channelEpoch(await store.snapshot(),GROUP);
   return audit.configureChannel(OWNER,GROUP,channel,expected);
  };
  const enable=async()=>audit.configure(OWNER,GROUP,true,audit.epoch(await store.snapshot(),GROUP));
  const deletion=async()=>{
   assert.equal(await service.configure(OWNER,GROUP,true,service.epoch(await store.snapshot(),GROUP)),true);
   assert.equal(await service.observeService(GROUP,'JOIN',310,'b3-webhook:channel-test:310',now),1);
   now+=60000;assert.equal((await service.cleanup()).deleted,1);
   now+=61000;
  };
  return {dir,store,policy,reader,gateway,service,admin,audit,owner,links,calls,configure,enable,deletion,linkRoom,
   clock:()=>now,advance:(n:number)=>{now+=n;},privacy:(v:typeof privacy)=>{privacy=v;},post:(v:typeof post)=>{post=v;},
   response:(v:typeof response)=>{response=v;},duringRead:(f:()=>Promise<void>)=>{duringRead=f;},
   reads:()=>reads,run:(v:boolean)=>{running=v;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' private channel probe verifies exact type, private identity and bot post rights',async()=>{
  const f=await fixture();try{
   assert.equal(TelegramPrivateAuditChannelReader.isOfficial(f.reader),true);
   assert.equal(await f.reader.inspect(CHANNEL),'GRANTED');
   f.post('DENIED');assert.equal(await f.reader.inspect(CHANNEL),'DENIED');
   f.post('CREATOR');assert.equal(await f.reader.inspect(CHANNEL),'GRANTED');
   f.post('UNKNOWN');assert.equal(await f.reader.inspect(CHANNEL),'UNKNOWN');
   f.post('GRANTED');f.privacy('PUBLIC');assert.equal(await f.reader.inspect(CHANNEL),'DENIED');
   f.privacy('GROUP');assert.equal(await f.reader.inspect(CHANNEL),'DENIED');
   f.privacy('MISMATCH');assert.equal(await f.reader.inspect(CHANNEL),'UNKNOWN');
   f.privacy('UNKNOWN');assert.equal(await f.reader.inspect(CHANNEL),'UNKNOWN');
   assert.equal(await f.reader.inspect(GROUP),'UNKNOWN');
  }finally{await f.close();}
 });
 test(engine+' owner explicitly registers a native channel and still must enable independent audit consent',async()=>{
  const f=await fixture();try{
   assert.equal(await f.configure(),true);
   assert.equal(f.audit.channel(await f.store.snapshot(),GROUP)?.channel,CHANNEL);
   assert.equal(f.audit.policy(await f.store.snapshot(),GROUP)?.enabled,false);
   assert.equal(await f.enable(),true);
   assert.equal(f.audit.policy(await f.store.snapshot(),GROUP)?.enabled,true);
   await f.deletion();assert.deepEqual(await f.audit.drain(),{sent:1,unresolved:0});
   const messages=f.calls.filter(x=>x.method==='sendMessage');assert.equal(messages.length,1);
   assert.equal(messages[0]!.body.chat_id,CHANNEL);
   assert.equal(messages[0]!.body.protect_content,true);
   assert.ok(!JSON.stringify(messages[0]!.body).includes('310'));
   assert.equal(await f.audit.drain().then(x=>x.sent),0);
  }finally{await f.close();}
 });
 test(engine+' channel registration fails closed for public, non-channel, unavailable rights and other actors',async()=>{
  for(const mode of ['PUBLIC','GROUP','MISMATCH','UNKNOWN'] as const){
   const f=await fixture();try{
    f.privacy(mode);assert.equal(await f.configure(),false);
    assert.equal(f.audit.channel(await f.store.snapshot(),GROUP),null);
   }finally{await f.close();}
  }
  const f=await fixture();try{
   f.post('DENIED');assert.equal(await f.configure(),false);
   f.post('UNKNOWN');assert.equal(await f.configure(),false);
   f.post('GRANTED');
   assert.equal(await f.audit.configureChannel('301',GROUP,CHANNEL,f.audit.channelEpoch(await f.store.snapshot(),GROUP)),false);
   assert.equal(await f.audit.configureChannel(OWNER,GROUP,GROUP,f.audit.channelEpoch(await f.store.snapshot(),GROUP)),false);
   assert.equal(await f.audit.configureChannel(OWNER,GROUP,CHANNEL,'0'.repeat(64)),false);
  }finally{await f.close();}
 });
 test(engine+' public/private flip or lost post rights after opt-in never sends nor falls back to a room',async()=>{
  for(const mode of ['PUBLIC','DENIED','UNKNOWN','STOP'] as const){
   const f=await fixture();try{
    await f.linkRoom();assert.equal(await f.configure(),true);assert.equal(await f.enable(),true);
    await f.deletion();
    if(mode==='PUBLIC')f.privacy('PUBLIC');
    if(mode==='DENIED')f.post('DENIED');
    if(mode==='UNKNOWN')f.privacy('UNKNOWN');
    if(mode==='STOP')f.run(false);
    assert.equal((await f.audit.drain()).sent,0);
    assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);
   }finally{await f.close();}
  }
 });
 test(engine+' revoked channel during privacy-read race has no send, no silent room fallback',async()=>{
  const f=await fixture();try{
   await f.linkRoom();await f.configure();assert.equal(await f.enable(),true);await f.deletion();
   f.duringRead(async()=>assert.equal(await f.configure(null),true));
   assert.equal((await f.audit.drain()).sent,0);
   assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);
   assert.equal(f.audit.policy(await f.store.snapshot(),GROUP)?.enabled,false);
   assert.equal(f.audit.channel(await f.store.snapshot(),GROUP)?.channel,undefined);
  }finally{await f.close();}
 });
 test(engine+' changing or removing a private channel invalidates existing owner audit consent',async()=>{
  const f=await fixture();try{
   await f.linkRoom();assert.equal(await f.configure(),true);assert.equal(await f.enable(),true);
   assert.equal(await f.configure(null),true);
   assert.equal(f.audit.policy(await f.store.snapshot(),GROUP)?.enabled,false);
   assert.equal(await f.configure(CHANNEL),true);
   assert.equal(f.audit.policy(await f.store.snapshot(),GROUP)?.enabled,false);
   assert.equal(await f.enable(),true);
   await f.deletion();f.response('WRONG_SENDER');
   assert.deepEqual(await f.audit.drain(),{sent:0,unresolved:1});
   f.response('CONFIRMED');
   assert.deepEqual(await f.audit.drain(),{sent:0,unresolved:0});
   assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,1);
  }finally{await f.close();}
 });
 test(engine+' channel owner UI previews exact group/channel and confirms once in private',async()=>{
  const f=await fixture();try{
   const screen=await f.owner.handle(OWNER,'/auditchannel '+GROUP+' '+CHANNEL);
   assert.match(screen?.text??'',/معاينة/u);
   const yes=screen?.keyboard.inline_keyboard.flat().find(x=>x.text.includes('تأكيد'));assert.ok(yes);
   assert.equal(f.audit.channel(await f.store.snapshot(),GROUP),null);
   assert.ok(await f.owner.handle(OWNER,yes.callback_data));
   assert.equal(await f.owner.handle(OWNER,yes.callback_data),null);
   assert.equal(f.audit.channel(await f.store.snapshot(),GROUP)?.channel,CHANNEL);
   const off=await f.owner.handle(OWNER,'/auditchanneloff '+GROUP);
   assert.match(off?.text??'',/معاينة/u);
   const stop=off?.keyboard.inline_keyboard.flat().find(x=>x.text.includes('تأكيد'));assert.ok(stop);
   assert.ok(await f.owner.handle(OWNER,stop.callback_data));
   assert.equal(f.audit.channel(await f.store.snapshot(),GROUP)?.channel,undefined);
   assert.equal(await f.owner.handle('301','/auditchannel '+GROUP+' '+CHANNEL),null);
  }finally{await f.close();}
 });
 test(engine+' channel owner preview becomes invalid after group revision and rejects forged callback',async()=>{
  const f=await fixture();try{
   const screen=await f.owner.handle(OWNER,'/auditchannel '+GROUP+' '+CHANNEL);
   const yes=screen?.keyboard.inline_keyboard.flat().find(x=>x.text.includes('تأكيد'));assert.ok(yes);
   assert.equal(await f.owner.handle(OWNER,'cu:1:c:AAAAAAAAAAAAAAAAAAAAAAAA'),null);
   await f.store.transaction(s=>{s.chats.find(x=>x.id===GROUP)!.version++;});
   assert.equal(await f.owner.handle(OWNER,yes.callback_data),null);
   assert.equal(f.audit.channel(await f.store.snapshot(),GROUP),null);
  }finally{await f.close();}
 });
}
