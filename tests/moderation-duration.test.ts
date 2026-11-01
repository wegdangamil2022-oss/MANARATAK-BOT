import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {parseReplyModerationCommand} from '../src/telegram-moderation-commands.js';
import {tickModerationExpiry} from '../src/moderation-expiry.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
const NOW=1700000000000,CHAT='-100123';
test('duration grammar is canonical, bounded and limited to ban/mute',()=>{
 const reply={message_id:10,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false}};
 const parse=(text:string)=>parseReplyModerationCommand(text,'ManaratakBot',CHAT,20,reply);
 for(const [suffix,seconds] of [['60s',60],['10m',600],['2h',7200],['30d',2592000]] as const){const r=parse('/mute case '+suffix);assert.equal(r.status,'COMMAND');if(r.status==='COMMAND')assert.equal(r.command.durationSeconds,seconds);}
 for(const text of ['/mute case 0m','/mute case 01m','/mute case 59s','/ban case 31d','/mute case 1w','/warn case 1m','/unban case 1m','/mute case 1.5h','/mute case 60s\n'])assert.equal(parse(text).status,'INVALID',text);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'moderation-duration-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;const policy=new Policy(store,'100',()=>now),gateway=new FakeModerationGateway(),service=new ModerationService(store,policy,gateway,()=>now);await policy.approveChat('100',CHAT,['moderation']);return {dir,store,policy,gateway,service,time:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' deadline persists, duplicate cannot renew, expiry respects overlapping reasons and does not repeat',async()=>{
  const f=await fixture();try{
   assert.equal((await f.service.addManualReason('100',CHAT,'300','timed','MUTE',undefined,60)).status,'APPLIED');f.time(NOW+1000);
   await f.service.addManualReason('100',CHAT,'300','timed','MUTE',undefined,120);assert.equal((await new BotStore(f.store.file,{engine}).snapshot()).moderationReasons[0]!.expiresAt,NOW+60000);
   await f.service.addManualReason('100',CHAT,'300','independent','MUTE');f.time(NOW+60000);const before=f.gateway.calls.length;assert.equal((await f.service.expireManualReasons('100',CHAT,'300')).status,'NO_CHANGE');assert.equal(f.gateway.calls.length,before);const s=await f.store.snapshot();assert.equal(s.moderationReasons.find(r=>r.reference==='timed')!.active,false);assert.equal(s.moderationReasons.find(r=>r.reference==='independent')!.active,true);
   await f.service.expireManualReasons('100',CHAT,'300');assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='MODERATION_REASONS_EXPIRED').length,1);
  }finally{await f.close();}
 });
 test(engine+' explicit tick is disabled by default, bounded and quarantines unknown release without retry',async()=>{
  const f=await fixture();try{
   await f.service.addManualReason('100',CHAT,'300','timed','MUTE',undefined,60);f.time(NOW+60000);let r=await tickModerationExpiry(f.store,f.policy,f.service,NOW+60000);assert.equal(r.status,'DISABLED');assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);
   f.gateway.outcome='UNKNOWN_OUTCOME';r=await tickModerationExpiry(f.store,f.policy,f.service,NOW+60000,true,1);assert.equal(r.processed,1);assert.equal(r.unresolved,1);assert.equal(f.gateway.calls.at(-1)!.kind,'NONE');const sent=f.gateway.calls.length;
   await tickModerationExpiry(f.store,f.policy,f.service,NOW+60000,true,1);assert.equal(f.gateway.calls.length,sent);assert.equal((await f.service.addManualReason('100',CHAT,'300','retry','BAN')).status,'BLOCKED_UNKNOWN');
  }finally{await f.close();}
 });
 test(engine+' deadline drift or expiry before STARTED prevents a stale sanction',async()=>{
  const f=await fixture();try{
   f.service.beforeDispatch=async()=>{await f.store.transaction(s=>{s.moderationReasons[0]!.expiresAt=NOW+120000;});};assert.equal((await f.service.addManualReason('100',CHAT,'300','drift','MUTE',undefined,60)).status,'DENIED');assert.equal(f.gateway.calls.length,0);
   f.service.beforeDispatch=async()=>{f.time(NOW+60000);};assert.equal((await f.service.addManualReason('100',CHAT,'301','late','MUTE',undefined,60)).status,'DENIED');assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' malformed deadline writes are rejected and old permanent reasons remain valid',async()=>{
  const f=await fixture();try{
   await f.service.addManualReason('100',CHAT,'300','permanent','MUTE');assert.equal(Object.hasOwn((await f.store.snapshot()).moderationReasons[0]!,'expiresAt'),false);
   for(const deadline of [0,-1,NaN,8640000000000001])await assert.rejects(f.store.transaction(s=>{s.moderationReasons[0]!.expiresAt=deadline;}));
   for(const seconds of [0,59,60.5,2592001])assert.equal((await f.service.addManualReason('100',CHAT,'301','bad','BAN',undefined,seconds)).status,'DENIED');assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 });
 test(engine+' unsupported live durations cannot become permanent sanctions',async()=>{
  const f=await fixture();try{
   let calls=0;const gateway=new TelegramBotApiModerationGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',(async()=>{calls++;throw Error('NETWORK_FORBIDDEN');}) as typeof fetch,async()=>true),service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const result=await service.addManualReason('100',CHAT,'300','timed','MUTE',undefined,60);assert.equal(result.reason,'DURATION_PROVIDER_UNSUPPORTED');assert.equal(calls,0);assert.equal((await f.store.snapshot()).moderationReasons.length,0);
  }finally{await f.close();}
 });
}
