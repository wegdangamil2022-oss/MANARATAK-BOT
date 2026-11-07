import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {AdminRoomLinks} from '../src/admin-room-links.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {AdminRoomNoticeDispatcher,TelegramAdminRoomNoticeSender} from '../src/admin-room-notices.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',NOW=1700000000000;
for(const engine of ['json','sqlite'] as const){
 for(const outcome of ['CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME'] as const)test(engine+' official '+outcome+' moderation outcome queues a classified private-data-free notice once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'room-operation-'));try{
   const path=join(dir,'state.'+engine),store=new BotStore(path,{engine}),policy=new Policy(store,'100',()=>NOW);for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);
   const links=new AdminRoomLinks(store,policy,()=>NOW),id=await links.propose('100','-100','-200','NOTIFICATIONS');assert.ok(id);await links.approve('100',id,'GROUP');await links.approve('100',id,'ROOM');let posts=0,mutations=0;const bodies:Record<string,unknown>[]=[];
   const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));
    if(method==='getChatMember')return Response.json({ok:true,result:{status:body.user_id===123456789?'administrator':'member',user:{id:body.user_id,is_bot:body.user_id===123456789},...(body.user_id===123456789?{can_restrict_members:true}:{})}});
    if(method==='banChatMember'){mutations++;if(outcome==='UNKNOWN_OUTCOME')throw Error('unknown remote outcome');if(outcome==='FAILED_CONFIRMED')return Response.json({ok:false,error_code:403},{status:403});return Response.json({ok:true,result:true});}
    if(method==='getChat')return Response.json({ok:true,result:{id:-200,type:'supergroup'}});
    assert.equal(method,'sendMessage');posts++;bodies.push(body);return Response.json({ok:true,result:{chat:{id:-200},from:{id:123456789,is_bot:true},message_id:55}});
   }) as typeof fetch;
   const gateway=new TelegramBotApiModerationGateway(TOKEN,request,async()=>true,()=>NOW),moderation=new ModerationService(store,policy,gateway,()=>NOW);
   const result=await moderation.addManualReason('100','-100','300','PRIVATE_CASE_REFERENCE','BAN');assert.equal(result.status,outcome==='CONFIRMED'?'APPLIED':outcome);assert.equal(mutations,1);
   const state=await store.snapshot(),kind=outcome==='CONFIRMED'?'ACTION':outcome==='FAILED_CONFIRMED'?'FAILURE':'INCIDENT',notice=state.audit.find(a=>a.reason.startsWith('ADMIN_ROOM_'+kind+'_NOTICE:'));assert.ok(notice);
   const summary=await links.summary('100',id);assert.ok(summary);assert.equal(summary.actions,outcome==='CONFIRMED'?1:0);assert.equal(summary.failures,outcome==='FAILED_CONFIRMED'?1:0);assert.equal(summary.incidents,outcome==='UNKNOWN_OUTCOME'?1:0);
   const payload=JSON.parse(notice.reason.slice(('ADMIN_ROOM_'+kind+'_NOTICE:').length));assert.deepEqual(Object.keys(payload).sort(),['group','link','operation','room','setting']);assert.match(payload.operation,/^[a-f0-9]{64}$/u);assert.equal(notice.reason.includes('PRIVATE_CASE_REFERENCE'),false);
   const make=(source:BotStore)=>new AdminRoomNoticeDispatcher(source,policy,gateway,new TelegramAdminRoomNoticeSender(TOKEN,request),()=>NOW,async()=>true);
   assert.equal(await make(store).drain(),1);assert.equal(await make(new BotStore(path,{engine})).drain(),0);assert.equal(posts,1);assert.equal(mutations,1);
   assert.match(String(bodies[0]!.text),outcome==='CONFIRMED'?/إجراء/u:outcome==='FAILED_CONFIRMED'?/نظام/u:/عاجل/u);assert.equal(Object.hasOwn(bodies[0]!,'reply_markup'),false);assert.equal(JSON.stringify(bodies).includes('PRIVATE_CASE_REFERENCE'),false);assert.equal(JSON.stringify(bodies).includes('300'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 for(const variant of ['simulation','revoked','quiet','public','changed','duplicate','stopped'] as const)test(engine+' operation notice '+variant+' cannot send a stale or unauthorized event',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'room-operation-guard-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);const links=new AdminRoomLinks(store,policy,()=>NOW),id=await links.propose('100','-100','-200','NOTIFICATIONS');assert.ok(id);await links.approve('100',id,'GROUP');await links.approve('100',id,'ROOM');let posts=0;
   const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));if(method==='getChatMember')return Response.json({ok:true,result:{status:body.user_id===123456789?'administrator':'member',user:{id:body.user_id,is_bot:body.user_id===123456789},can_restrict_members:true}});if(method==='banChatMember')return Response.json({ok:true,result:true});if(method==='getChat')return Response.json({ok:true,result:{id:-200,type:'supergroup',...(variant==='public'?{username:'PublicRoom'}:{})}});posts++;throw Error('must not send');}) as typeof fetch;
   const gateway=new TelegramBotApiModerationGateway(TOKEN,request,async()=>true,()=>NOW),moderation=new ModerationService(store,policy,variant==='simulation'?new FakeModerationGateway():gateway,()=>NOW);assert.equal((await moderation.addManualReason('100','-100','300','PRIVATE_REFERENCE','BAN')).status,'APPLIED');
   if(variant==='simulation')assert.equal((await store.snapshot()).audit.some(a=>a.reason.startsWith('ADMIN_ROOM_ACTION_NOTICE:')),false);
   if(variant==='revoked')assert.equal(await links.revoke('100',id),true);
   if(variant==='quiet')assert.equal(await links.setQuiet('100',id,'0',true),true);
   if(variant==='changed')await store.transaction(s=>{s.moderationOperations[0]!.status='UNKNOWN_OUTCOME';});
   if(variant==='duplicate')await store.transaction(s=>{s.moderationOperations.push({...s.moderationOperations[0]!});});
   const worker=new AdminRoomNoticeDispatcher(store,policy,gateway,new TelegramAdminRoomNoticeSender(TOKEN,request),()=>NOW,async()=>variant!=='stopped');assert.equal(await worker.drain(),0);assert.equal(await worker.drain(),0);assert.equal(posts,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
