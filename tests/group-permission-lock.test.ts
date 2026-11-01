import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {GroupPermissionLockService} from '../src/group-permission-lock.js';
import {GROUP_PERMISSION_KEYS,readGroupPermissions,lockedGroupPermissions,type GroupPermissions} from '../src/group-permission-model.js';
import {telegramGroupPermissionGateway,type GroupPermissionPort} from '../src/telegram-group-permission-gateway.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
const NOW=1700000000000,CHAT='-100123',BASE={...Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])),can_invite_users:false,can_change_info:false,can_pin_messages:false,can_manage_topics:false,can_edit_tag:false} as GroupPermissions;
test('permission snapshots preserve default dependencies and refuse unknown future fields',()=>{
 const p=readGroupPermissions({can_send_messages:true,can_pin_messages:true})!;assert.equal(p.can_react_to_messages,true);assert.equal(p.can_manage_topics,true);assert.equal(p.can_edit_tag,true);assert.equal(readGroupPermissions({can_send_messages:'true'}),null);assert.equal(readGroupPermissions({can_send_future:true}),null);assert.equal(lockedGroupPermissions(BASE,'LINKS').can_send_messages,true);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'group-lock-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,id=0,current=structuredClone(BASE),calls=0,unknown=false;let beforeApply:(()=>Promise<void>)|undefined,afterApply:(()=>Promise<void>)|undefined;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);await policy.approveChat('100',CHAT,['moderation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);
  const port:GroupPermissionPort={read:async()=>structuredClone(current),apply:async(_chat,before,after,valid)=>{if(beforeApply)await beforeApply();if(!await valid())return 'FAILED_CONFIRMED';assert.deepEqual(current,before);calls++;current=structuredClone(after);if(afterApply)await afterApply();return unknown?'UNKNOWN_OUTCOME':'CONFIRMED';}};
  const service=new GroupPermissionLockService(store,policy,port,()=>now),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),groupPermissions:service,clock:()=>now,botId:'group-lock',botUsername:'ManaratakBot',ownerMenuMode:'inline',studentMenuMode:'inline',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  const command=(text:string,actor=301)=>app.handle({update_id:++id,message:{message_id:id,from:{id:actor,is_bot:false},chat:{id:Number(CHAT),type:'supergroup'},text}});
  const click=(data:string,actor=301,group=false)=>app.handle({update_id:++id,callback_query:{id:'lock-'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'}}}});
  return {store,policy,service,port,command,click,current:()=>current,change:(v:GroupPermissions)=>{current=v;},calls:()=>calls,time:(v:number)=>{now=v;},now:()=>now,setUnknown:()=>{unknown=true;},before:(f:()=>Promise<void>)=>{beforeApply=f;},after:(f:()=>Promise<void>)=>{afterApply=f;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 type Result=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['command']>>;
 const choose=(r:Result,starts:string)=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.text.startsWith(starts));assert.ok(b,JSON.stringify(r));return b.callback_data;};
 test(engine+' lock and restore require private confirmation and restore exact original permissions',async()=>{
  const f=await fixture();try{
   let r=await f.command('/lock');assert.equal(r.plan!.chatId,'301');assert.equal(f.calls(),0);const route=choose(r,'✅');assert.equal((await f.click(route,302)).status,'DENIED');assert.equal((await f.click(route,301,true)).status,'DENIED');assert.equal((await f.click(route)).status,'APPLIED');assert.equal(f.current().can_send_messages,false);assert.equal(f.current().can_invite_users,false);assert.equal((await f.click(route)).status,'DENIED');assert.equal(f.calls(),1);
   f.time(NOW+1);r=await f.command('/unlock');assert.equal(f.calls(),1);assert.equal((await f.click(choose(r,'✅'))).status,'APPLIED');assert.deepEqual(f.current(),BASE);assert.equal(f.calls(),2);assert.equal((await f.command('/unlock')).status,'DENIED');assert.ok((await new BotStore(f.store.file,{engine}).snapshot()).groupPermissionJobs!.every(j=>j.status==='CONFIRMED'));
  }finally{await f.close();}
 });
 test(engine+' expiry, navigation cancellation and remote permission drift prevent stale changes',async()=>{
  const f=await fixture();try{
   let r=await f.command('/lock'),route=choose(r,'✅');f.time(NOW+120000);assert.equal((await f.click(route)).status,'DENIED');f.time(NOW);
   r=await f.command('/lock');route=choose(r,'✅');await f.click('pn:1:h');assert.equal((await f.click(route)).status,'DENIED');let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},f.now);assert.equal((await dispatcher.dispatch(r.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,0);
   r=await f.command('/lock');route=choose(r,'✅');f.change({...BASE,can_invite_users:true});assert.equal((await f.click(route)).status,'DENIED');assert.equal(f.calls(),0);
  }finally{await f.close();}
 });
 test(engine+' unknown effects and rewritten receipts quarantine further group changes',async()=>{
  const f=await fixture();try{
   const job=await f.service.preview('301',CHAT,'LOCK');assert.ok(job);f.after(async()=>{await f.store.transaction(s=>{s.groupPermissionJobs![0]!.mode='MEDIA';});});assert.equal(await f.service.confirm('301',job.id),'UNKNOWN_OUTCOME');assert.equal(f.calls(),1);assert.ok((await f.store.snapshot()).groupPermissionJobs!.some(j=>j.status==='UNKNOWN_OUTCOME'));assert.equal(await f.service.preview('301',CHAT,'RESTORE'),null);assert.equal(await f.service.confirm('301',job.id),'DENIED');assert.equal(f.calls(),1);
  }finally{await f.close();}
 });
 test(engine+' grant revocation during preflight and changed restore baseline do not dispatch',async()=>{
  const f=await fixture();try{
   let job=await f.service.preview('301',CHAT,'LOCK','MEDIA');assert.ok(job);f.before(async()=>{await f.store.transaction(s=>{s.grants[0]!.revoked=true;});});assert.equal(await f.service.confirm('301',job.id),'FAILED_CONFIRMED');assert.equal(f.calls(),0);
   job=await f.service.preview('100',CHAT,'LOCK','MEDIA');assert.ok(job);assert.equal(await f.service.confirm('100',job.id),'CONFIRMED');f.change({...f.current(),can_send_messages:false});assert.equal(await f.service.preview('100',CHAT,'RESTORE'),null);assert.equal(f.calls(),1);
  }finally{await f.close();}
 });
 test(engine+' owner picker and staff entry use bounded inline routes with working return',async()=>{
  const f=await fixture();try{
   let r=await f.click('mi:1:i:02:04',100);assert.equal(r.status,'APPLIED');r=await f.click(choose(r,'👥'),100);r=await f.click(choose(r,'🎞️'),100);assert.equal(r.plan!.chatId,'100');assert.ok(r.plan!.text.includes('الصور'));assert.equal((await f.click(choose(r,'↩️ المجموعة'),100)).status,'APPLIED');assert.equal(f.calls(),0);
   r=await f.click('ms:1:h');assert.ok(choose(r,'🔐 قفل'));assert.equal((await f.click(choose(r,'🔐 قفل'))).status,'APPLIED');
  }finally{await f.close();}
 });
}
test('official permission gateway checks rights, STOP, source and readback without retry',async()=>{
 let current=structuredClone(BASE),run=false,writes=0,unknown=false;
 const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));if(method==='getChatMember')return Response.json({ok:true,result:{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:true}});if(method==='getChat')return Response.json({ok:true,result:{id:Number(CHAT),type:'supergroup',permissions:current}});assert.equal(method,'setChatPermissions');assert.equal(body.use_independent_chat_permissions,true);writes++;current=body.permissions;if(unknown)throw Error('NETWORK_UNKNOWN');return Response.json({ok:true,result:true});}) as typeof fetch;
 const gateway=telegramGroupPermissionGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>run),after=lockedGroupPermissions(BASE,'MESSAGES');assert.ok(Object.isFrozen(gateway));assert.equal(await gateway.read(CHAT),null);run=true;assert.deepEqual(await gateway.read(CHAT),BASE);assert.equal(await gateway.apply(CHAT,BASE,after,async()=>false),'FAILED_CONFIRMED');assert.equal(writes,0);assert.equal(await gateway.apply(CHAT,BASE,after,async()=>true),'CONFIRMED');assert.equal(writes,1);
 unknown=true;assert.equal(await gateway.apply(CHAT,after,BASE,async()=>true),'UNKNOWN_OUTCOME');assert.equal(writes,2);run=false;assert.equal(await gateway.apply(CHAT,BASE,after,async()=>true),'FAILED_CONFIRMED');assert.equal(writes,2);
});
test('permission gateway rejects wrong chat identity, unknown permissions, lost rights and oversized metadata',async()=>{
 for(const failure of ['identity','permissions','rights','large'] as const){let writes=0,reads=0;
  const request=(async(url:unknown)=>{const method=String(url).split('/').at(-1)!;if(method==='getChatMember'){reads++;return Response.json({ok:true,result:{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:failure!=='rights'||reads<2}});}if(method==='getChat')return failure==='large'?Response.json({ok:true,result:{id:Number(CHAT),type:'supergroup',permissions:BASE,padding:'x'.repeat(20000)}}):Response.json({ok:true,result:{id:failure==='identity'?-100999:Number(CHAT),type:'supergroup',permissions:failure==='permissions'?{...BASE,can_future_permission:true}:BASE}});writes++;return Response.json({ok:true,result:true});}) as typeof fetch;
  const gateway=telegramGroupPermissionGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>true);assert.equal(await gateway.read(CHAT),null,failure);assert.equal(writes,0);
 }
});
test('a provider acknowledgement with mismatching permission readback is unknown',async()=>{
 let writes=0;const request=(async(url:unknown)=>{const method=String(url).split('/').at(-1)!;if(method==='getChatMember')return Response.json({ok:true,result:{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:true}});if(method==='getChat')return Response.json({ok:true,result:{id:Number(CHAT),type:'supergroup',permissions:BASE}});writes++;return Response.json({ok:true,result:true});}) as typeof fetch;
 const gateway=telegramGroupPermissionGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>true);assert.equal(await gateway.apply(CHAT,BASE,lockedGroupPermissions(BASE,'MESSAGES'),async()=>true),'UNKNOWN_OUTCOME');assert.equal(writes,1);
});
