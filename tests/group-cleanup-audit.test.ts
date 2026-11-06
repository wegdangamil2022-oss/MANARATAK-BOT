import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {AdminRoomLinks} from '../src/admin-room-links.js';
import {GroupServiceMessageCleanup} from '../src/group-service-message-cleanup.js';
import {GroupAdminCommandCleanup} from '../src/group-admin-command-cleanup.js';
import {GroupCleanupAudit,TelegramGroupCleanupAuditSender} from '../src/group-cleanup-audit.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {TelegramCaptchaOwner} from '../src/telegram-captcha-owner.js';
import {CaptchaService} from '../src/captcha.js';
import {protectionUIEpoch} from '../src/protection-ui-access.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const NOW=1700000000000,G='-100',ROOM='-200',OWNER='100',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const button=(s:OwnerInlineScreen|null,label:string)=>{assert.ok(s);const b=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(label));assert.ok(b,label);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'cleanup-audit-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW,run=true,privacy:'PRIVATE'|'PUBLIC'|'UNKNOWN'='PRIVATE',sending:'CONFIRMED'|'UNKNOWN'='CONFIRMED',right=true;
  let beforeRead:(()=>Promise<void>)|undefined,beforeSend:(()=>Promise<void>)|undefined;
  const calls:{method:string;body?:Record<string,unknown>}[]=[];
  const policy=new Policy(store,OWNER,()=>now);
  for(const g of [G,ROOM])await policy.approveChat(OWNER,g,['moderation','verification','navigation']);
  await policy.grant(OWNER,'301','chat.manage',G,now+86400000);
  await policy.grant(OWNER,'302','chat.manage',ROOM,now+86400000);
  const links=new AdminRoomLinks(store,policy,()=>now);
  const service=new GroupServiceMessageCleanup(store,policy,{delete:async(_g,_m,verify)=>await verify()?'ACKNOWLEDGED':'NOT_SENT'},()=>now,async()=>run,async()=>right?'GRANTED':'DENIED');
  const admin=new GroupAdminCommandCleanup(store,policy,{delete:async(_g,_m,verify)=>await verify()?'ACKNOWLEDGED':'NOT_SENT'},()=>now,async()=>run,async()=>right?'GRANTED':'DENIED');
  const request=(async(url:unknown,init?:RequestInit)=>{
   const method=String(url).split('/').at(-1)!;
   const body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined;
   calls.push({method,...(body?{body}:{})});
   if(method==='getChat'){if(beforeRead){const f=beforeRead;beforeRead=undefined;await f();}if(privacy==='UNKNOWN')throw Error('room lookup unavailable');
    return Response.json({ok:true,result:{id:-200,type:'supergroup',...(privacy==='PUBLIC'?{username:'PublicAuditRoom'}:{})}});}
   assert.equal(method,'sendMessage');
   if(beforeSend){const f=beforeSend;beforeSend=undefined;await f();}
   if(sending==='UNKNOWN')throw Error('Telegram response lost');
   return Response.json({ok:true,result:{message_id:42,from:{id:123456789,is_bot:true},chat:{id:-200,type:'supergroup'}}});
  }) as typeof fetch;
  const gateway=new TelegramBotApiModerationGateway(TOKEN,request,async()=>run,()=>now);
  const audit=new GroupCleanupAudit(store,policy,service,admin,gateway,new TelegramGroupCleanupAuditSender(TOKEN,request),()=>now,async()=>run);
  const link=async()=>{
   const id=await links.propose('301',G,ROOM,'NOTIFICATIONS');assert.ok(id);
   assert.equal(await links.approve('301',id,'GROUP'),'PENDING');
   assert.equal(await links.approve('302',id,'ROOM'),'ACTIVE');return id;
  };
  const enableAudit=async()=>assert.equal(await audit.configure(OWNER,G,true,audit.epoch(await store.snapshot(),G)),true);
  const submitService=async(id=201,kind:'JOIN'|'PIN'|'GROUP_TITLE'|'TOPIC_CREATED'='JOIN')=>{
   if(kind==='JOIN')assert.equal(await service.configure(OWNER,G,true,service.epoch(await store.snapshot(),G)),true);
   else if(kind==='PIN')assert.equal(await service.configurePin(OWNER,G,true,service.epochPin(await store.snapshot(),G)),true);
   else if(kind==='GROUP_TITLE')assert.equal(await service.configureGroupChanges(OWNER,G,true,service.epochGroupChanges(await store.snapshot(),G)),true);
   else assert.equal(await service.configureForum(OWNER,G,true,service.epochForum(await store.snapshot(),G)),true);
   assert.equal(await service.observeService(G,kind,id,'b3-webhook:cleanup-audit:'+id,now),1);
   now+=60000;assert.equal((await service.cleanup()).deleted,1);
  };
  const submitAdmin=async(id=551)=>{
   assert.equal(await admin.configure(OWNER,G,true,admin.epoch(await store.snapshot(),G)),true);
   const key='b3-webhook:cleanup-audit-admin:'+id,reason='MODERATION_PREVIEW_ONLY';
   await store.transaction(s=>{s.updates.push({key,status:'DONE',leaseUntil:now});
    s.audit.push({updateKey:key,decision:'ALLOW',reason,policyVersion:0,at:now});
    s.telegramReplyJobs??=[];s.telegramReplyJobs.push({updateKey:key,plan:{chatId:OWNER,parseMode:'HTML',text:'PRIVATE_PREVIEW'},
     privateReplyKind:'ADMIN_SCOPED',status:'QUEUED',queuedAt:now,
     adminUIAccess:{actorId:OWNER,epoch:protectionUIEpoch(s,policy,OWNER,now)??'a'.repeat(64),expiresAt:now+120000}});
   });
   assert.equal(await admin.observeApproved(G,id,OWNER,key,'MODERATION',reason,now),1);
   await store.transaction(s=>{const job=s.telegramReplyJobs!.find(j=>j.updateKey===key)!;job.status='SENT';job.messageId=id+1000;
    job.startedAt=now;job.redactedAt=now;job.attemptId='11111111-2222-4333-8444-555555555555';
    delete job.plan;delete job.privateReplyKind;delete job.adminUIAccess;});
   now+=120000;assert.equal((await admin.cleanup()).deleted,1);
  };
  const nextMinute=()=>{now=Math.floor(now/60000)*60000+61000;};
  return {dir,store,policy,links,service,admin,audit,calls,link,enableAudit,submitService,submitAdmin,nextMinute,
   now:()=>now,advance:(ms:number)=>{now+=ms;},run:(on:boolean)=>{run=on;},right:(value:boolean)=>{right=value;},
   privacy:(p:typeof privacy)=>{privacy=p;},sendResult:(v:typeof sending)=>{sending=v;},
   beforeRead:(f:()=>Promise<void>)=>{beforeRead=f;},beforeSend:(f:()=>Promise<void>)=>{beforeSend=f;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' cleanup audit is OFF without an explicitly double-approved notifications room',async()=>{const f=await fixture();try{
  assert.equal(f.audit.policy(await f.store.snapshot(),G)?.enabled,false);
  assert.equal(await f.audit.configure(OWNER,G,true,f.audit.epoch(await f.store.snapshot(),G)),false);
  await f.link();
  assert.equal(await f.audit.configure('301',G,true,f.audit.epoch(await f.store.snapshot(),G)),false);
  await f.submitService();f.nextMinute();
  assert.deepEqual(await f.audit.drain(),{sent:0,unresolved:0});
  assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);
 }finally{await f.close();}});
 test(engine+' verified service deletion is summarized in a private authorized room only',async()=>{const f=await fixture();try{
  await f.link();await f.enableAudit();await f.submitService(221,'GROUP_TITLE');f.nextMinute();
  assert.deepEqual(await f.audit.drain(),{sent:1,unresolved:0});
  const sent=f.calls.filter(x=>x.method==='sendMessage');assert.equal(sent.length,1);
  assert.equal(sent[0]!.body?.chat_id,ROOM);
  assert.equal(sent[0]!.body?.protect_content,true);
  assert.match(String(sent[0]!.body?.text),/تدقيق|تنظيف/u);
  assert.ok(!JSON.stringify(sent[0]!.body).includes('221'));
  assert.equal(await f.audit.drain().then(x=>x.sent),0);
  assert.ok((await f.store.snapshot()).audit.some(a=>a.reason==='CLEANUP_AUDIT_SENT_CONFIRMED'));
 }finally{await f.close();}});
 test(engine+' owner-reviewed admin command deletion and service notices share one compact audit summary',async()=>{const f=await fixture();try{
  await f.link();await f.enableAudit();await f.submitService(241,'PIN');await f.submitAdmin(251);f.nextMinute();
  // The reports can fall into distinct time windows; each is sent at most once.
  const first=await f.audit.drain(5);
  assert.equal(first.sent>=1,true);assert.equal(first.unresolved,0);
  const posts=f.calls.filter(x=>x.method==='sendMessage');
  assert.ok(posts.length>=1&&posts.length<=2);
  assert.equal(posts.some(x=>String(x.body?.text).includes('PRIVATE_PREVIEW')),false);
  assert.equal(posts.some(x=>String(x.body?.text).includes('251')),false);
 }finally{await f.close();}});
 test(engine+' opt-in at the same millisecond as a completed deletion never backfills its previous result',async()=>{const f=await fixture();try{
  await f.link();
  await f.submitService(601,'JOIN');
  await f.enableAudit(); // Owner confirmation arrives after the deletion, at the same clock tick.
  f.nextMinute();
  assert.deepEqual(await f.audit.drain(),{sent:0,unresolved:0});
  assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);
 }finally{await f.close();}});
 test(engine+' private-room proof blocks public, unknown, STOP and revoked notification links',async()=>{for(const mode of ['public','unknown','stop','revoked'] as const){
  const f=await fixture();try{const id=await f.link();await f.enableAudit();await f.submitService();f.nextMinute();
   if(mode==='public')f.privacy('PUBLIC');if(mode==='unknown')f.privacy('UNKNOWN');if(mode==='stop')f.run(false);
   if(mode==='revoked')assert.equal(await f.links.revoke('302',id),true);
   const done=await f.audit.drain();assert.equal(done.sent,0);
   assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);
  }finally{await f.close();}
 }});
 test(engine+' quiet mode and consent OFF cancel old audit windows even after reactivation',async()=>{for(const mode of ['quiet','off'] as const){
  const f=await fixture();try{const id=await f.link();await f.enableAudit();await f.submitService();f.nextMinute();
   if(mode==='quiet'){const row=(await f.links.visible('301')).find(x=>x.id===id)!;
    assert.equal(await f.links.setQuiet('301',id,row.quietWitness!,true),true);}
   else assert.equal(await f.audit.configure(OWNER,G,false,f.audit.epoch(await f.store.snapshot(),G)),true);
   assert.equal((await f.audit.drain()).sent,0);
   if(mode==='quiet'){const row=(await f.links.visible('301')).find(x=>x.id===id)!;
    assert.equal(await f.links.setQuiet('301',id,row.quietWitness!,false),true);}
   else await f.enableAudit();
   assert.equal((await f.audit.drain()).sent,0);
  }finally{await f.close();}
 }});
 test(engine+' race-time revocation during Telegram privacy preflight never sends a stale audit',async()=>{const f=await fixture();try{
  const id=await f.link();await f.enableAudit();await f.submitService();f.nextMinute();
  f.beforeRead(async()=>{assert.equal(await f.links.revoke('302',id),true);});
  assert.equal((await f.audit.drain()).sent,0);
  assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);
 }finally{await f.close();}});
 test(engine+' ambiguous audit delivery is terminal and does not retry after restart',async()=>{const f=await fixture();try{
  await f.link();await f.enableAudit();await f.submitService();f.nextMinute();f.sendResult('UNKNOWN');
  assert.deepEqual(await f.audit.drain(),{sent:0,unresolved:1});
  assert.equal((await f.audit.drain()).unresolved,0);
  const before=f.calls.filter(x=>x.method==='sendMessage').length;assert.equal(before,1);
  const reopened=new BotStore(f.store.file,{engine});
  // The persisted started/outcome marker prevents a second transmission.
  await f.store.snapshot();assert.ok((await reopened.snapshot()).audit.some(a=>a.reason==='CLEANUP_AUDIT_SENT_UNKNOWN_OUTCOME'));
 }finally{await f.close();}});
 test(engine+' forged and duplicate deletion outcome rows are not valid audit evidence',async()=>{for(const type of ['duplicate','forged'] as const){
  const f=await fixture();try{await f.link();await f.enableAudit();await f.submitService();f.nextMinute();
   await f.store.transaction(s=>{const row=s.audit.find(a=>a.updateKey.endsWith(':outcome')&&a.reason==='GROUP_SERVICE_DELETE_ACKNOWLEDGED')!;
    if(type==='duplicate')s.audit.push({...row});else row.actorId='999';});
   assert.equal((await f.audit.drain()).sent,0);
   assert.equal(f.calls.filter(x=>x.method==='sendMessage').length,0);
  }finally{await f.close();}
 }});
 test(engine+' owner is guided to establish a notification room before audit can be enabled',async()=>{const f=await fixture();try{
  const captcha=new CaptchaService(f.store,f.policy,async()=> 'VERIFIED',()=>f.now());
  const ui=new TelegramCaptchaOwner(f.store,f.policy,captcha,()=>f.now(),undefined,undefined,f.service,undefined,f.audit);
  const root=await ui.handle(OWNER,'mi:1:i:09:04');
  const group=await ui.handle(OWNER,button(root,G));
  assert.match(group?.text??'',/غرفة إدارة|الإشعارات/u);
  assert.equal(group?.keyboard.inline_keyboard.flat().some(b=>b.text.includes('تفعيل تدقيق الحذف')),false);
  assert.equal(f.audit.policy(await f.store.snapshot(),G)?.enabled,false);
 }finally{await f.close();}});
 test(engine+' owner audit controls enforce preview, one-shot confirmation and independent OFF',async()=>{const f=await fixture();try{
  await f.link();const captcha=new CaptchaService(f.store,f.policy,async()=> 'VERIFIED',()=>f.now());
  const ui=new TelegramCaptchaOwner(f.store,f.policy,captcha,()=>f.now(),undefined,undefined,f.service,undefined,f.audit);
  const root=await ui.handle(OWNER,'mi:1:i:09:04'),group=await ui.handle(OWNER,button(root,G));
  assert.equal(f.audit.policy(await f.store.snapshot(),G)?.enabled,false);
  const preview=await ui.handle(OWNER,button(group,'تفعيل تدقيق الحذف'));
  assert.match(preview?.text??'',/معاينة/u);
  const confirm=button(preview,'تأكيد');assert.ok(await ui.handle(OWNER,confirm));
  assert.equal(await ui.handle(OWNER,confirm),null);
  assert.equal(f.audit.policy(await f.store.snapshot(),G)?.enabled,true);
  const next=await ui.handle(OWNER,'mi:1:i:09:04'),edit=await ui.handle(OWNER,button(next,G));
  const off=await ui.handle(OWNER,button(edit,'إيقاف تدقيق الحذف'));
  assert.ok(await ui.handle(OWNER,button(off,'تأكيد')));
  assert.equal(f.audit.policy(await f.store.snapshot(),G)?.enabled,false);
 }finally{await f.close();}});
}
