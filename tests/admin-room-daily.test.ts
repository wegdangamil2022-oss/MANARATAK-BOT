import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {AdminRoomLinks} from '../src/admin-room-links.js';
import {TelegramModerationReports} from '../src/telegram-moderation-reports.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {AdminRoomDailyDispatcher,TelegramAdminRoomNoticeSender} from '../src/admin-room-notices.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',START=1700000000000,DAY=86400000;
for(const engine of ['json','sqlite'] as const){
 for(const variant of ['confirmed','unknown','public','revoked','disabled','changed','stop','quiet','late'] as const)test(engine+' daily summary '+variant+' is bounded and never replays a slot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'room-daily-'));try{
   let now=START,running=true,posts=0,reads=0,body='';const file=join(dir,'state.'+engine),store=new BotStore(file,{engine}),policy=new Policy(store,'100',()=>now);for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);await policy.grant('100','301','chat.manage','-100',now+5*DAY);await policy.grant('100','302','chat.manage','-200',now+5*DAY);
   const links=new AdminRoomLinks(store,policy,()=>now),id=await links.propose('301','-100','-200','NOTIFICATIONS');assert.ok(id);assert.equal(await links.approve('301',id,'GROUP'),'PENDING');assert.equal(await links.approve('302',id,'ROOM'),'ACTIVE');assert.equal(await links.setDaily('303',id,'0',true),false);assert.equal(await links.setDaily('301',id,'0',true),true);
   if(variant==='quiet')assert.equal(await links.setQuiet('301',id,'0',true),true);const reports=new TelegramModerationReports(store,policy,()=>now);assert.equal(await reports.submit('300','-100',101,{message_id:1,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false},text:'STUDENT_SECRET'}),'RECORDED');assert.equal((await new ModerationService(store,policy,new FakeModerationGateway(),()=>now).issueWarning('301','-100','401','SECRET_REFERENCE')).status,'ADDED');
   const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!;if(method==='getChat'){reads++;if(variant==='revoked')await links.revoke('302',id);if(variant==='changed')await store.transaction(s=>{s.warnings.push({...s.warnings[0]!});});if(variant==='disabled'){const row=(await links.visible('301')).find(x=>x.id===id)!;assert.equal(await links.setDaily('301',id,row.dailyWitness!,false),true);}return Response.json({ok:true,result:{id:-200,type:'supergroup',...(variant==='public'?{username:'PublicRoom'}:{})}});}assert.equal(method,'sendMessage');posts++;body=String(init.body);if(variant==='unknown')throw Error('lost');return Response.json({ok:true,result:{chat:{id:-200},from:{id:123456789,is_bot:true},message_id:77}});}) as typeof fetch;
   const make=(source:BotStore)=>new AdminRoomDailyDispatcher(source,policy,new TelegramBotApiModerationGateway(TOKEN,request),new TelegramAdminRoomNoticeSender(TOKEN,request),()=>now,async()=>running);const worker=make(store);assert.equal(await worker.drain(),0);assert.equal(reads,0);now+=variant==='late'?3*DAY:DAY;
   if(variant==='stop'){running=false;assert.equal(await worker.drain(),0);assert.equal(reads,0);running=true;}
   assert.equal(await worker.drain(),['confirmed','unknown','stop','quiet','late'].includes(variant)?1:0);assert.equal(await make(new BotStore(file,{engine})).drain(),0);assert.equal(posts,['confirmed','unknown','stop','quiet','late'].includes(variant)?1:0);
   if(variant==='late'){now-=DAY;assert.equal(await worker.drain(),0);assert.equal(posts,1);}
   if(posts){assert.match(body,/نظام/u);assert.ok(body.includes('البلاغات: '+(variant==='late'?0:1)));assert.ok(body.includes('التحذيرات: '+(variant==='late'?0:1)));assert.equal(body.includes('STUDENT_SECRET'),false);assert.equal(body.includes('SECRET_REFERENCE'),false);assert.equal(body.includes('400'),false);assert.equal(body.includes('401'),false);}
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' daily summary is disabled by default and quiet mode does not enable it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'room-daily-off-'));try{
   let now=START,calls=0;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);await policy.grant('100','301','chat.manage','-100',now+5*DAY);await policy.grant('100','302','chat.manage','-200',now+5*DAY);const links=new AdminRoomLinks(store,policy,()=>now),id=await links.propose('301','-100','-200','NOTIFICATIONS');assert.ok(id);await links.approve('301',id,'GROUP');await links.approve('302',id,'ROOM');assert.equal(await links.setQuiet('301',id,'0',true),true);now+=2*DAY;
   const request=(async()=>{calls++;throw Error('unexpected');}) as typeof fetch,worker=new AdminRoomDailyDispatcher(store,policy,new TelegramBotApiModerationGateway(TOKEN,request),new TelegramAdminRoomNoticeSender(TOKEN,request),()=>now,async()=>true);assert.equal(await worker.drain(),0);assert.equal(calls,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' disabling the schedule during the last safety check prevents sending',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'room-daily-race-'));try{
   let now=START,checks=0,posts=0;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);await policy.grant('100','301','chat.manage','-100',now+5*DAY);await policy.grant('100','302','chat.manage','-200',now+5*DAY);const links=new AdminRoomLinks(store,policy,()=>now),id=await links.propose('301','-100','-200','NOTIFICATIONS');assert.ok(id);await links.approve('301',id,'GROUP');await links.approve('302',id,'ROOM');assert.equal(await links.setDaily('301',id,'0',true),true);now+=DAY;
   const request=(async(url:unknown)=>{if(String(url).endsWith('/getChat'))return Response.json({ok:true,result:{id:-200,type:'supergroup'}});posts++;throw Error('must not send');}) as typeof fetch;
   const safe=async()=>{if(++checks===5){const row=(await links.visible('301')).find(x=>x.id===id)!;assert.equal(await links.setDaily('301',id,row.dailyWitness!,false),true);}return true;};const worker=new AdminRoomDailyDispatcher(store,policy,new TelegramBotApiModerationGateway(TOKEN,request),new TelegramAdminRoomNoticeSender(TOKEN,request),()=>now,safe);assert.equal(await worker.drain(),0);assert.ok(checks>=5);assert.equal(posts,0);assert.equal(await worker.drain(),0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' concurrent workers claim a daily slot at most once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'room-daily-concurrent-'));try{
   let now=START,posts=0;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);await policy.grant('100','301','chat.manage','-100',now+5*DAY);await policy.grant('100','302','chat.manage','-200',now+5*DAY);const links=new AdminRoomLinks(store,policy,()=>now),id=await links.propose('301','-100','-200','NOTIFICATIONS');assert.ok(id);await links.approve('301',id,'GROUP');await links.approve('302',id,'ROOM');assert.equal(await links.setDaily('301',id,'0',true),true);now+=DAY;
   const request=(async(url:unknown)=>{if(String(url).endsWith('/getChat'))return Response.json({ok:true,result:{id:-200,type:'supergroup'}});posts++;return Response.json({ok:true,result:{chat:{id:-200},from:{id:123456789,is_bot:true},message_id:77}});}) as typeof fetch,make=()=>new AdminRoomDailyDispatcher(store,policy,new TelegramBotApiModerationGateway(TOKEN,request),new TelegramAdminRoomNoticeSender(TOKEN,request),()=>now,async()=>true);
   const result=await Promise.all([make().drain(),make().drain()]);assert.equal(result[0]!+result[1]!,1);assert.equal(posts,1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
