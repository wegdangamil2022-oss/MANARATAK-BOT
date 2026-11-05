import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupAdminCommandCleanup} from '../src/group-admin-command-cleanup.js';
import {TelegramAdminCommandCleanupOwner} from '../src/telegram-admin-command-cleanup-owner.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const BASE=1700000000000,G='-100123',OWNER='100',MOD='201';
const choose=(v:OwnerInlineScreen|null,label:string)=>{assert.ok(v);const x=v.keyboard.inline_keyboard.flat().find(x=>x.text.includes(label));assert.ok(x,label+' not in '+v.text);return x.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function setup(){
  const dir=await mkdtemp(join(tmpdir(),'admin-cmd-cleanup-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=BASE,stop=false,rights:'GRANTED'|'DENIED'|'UNKNOWN'='GRANTED',response:'ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'='ACKNOWLEDGED';
  let during:(()=>Promise<void>)|undefined;
  const deleted:{chat:string;messageId:number}[]=[];
  const policy=new Policy(store,OWNER,()=>now);await policy.approveChat(OWNER,G,['moderation','verification','navigation']);
  const service=new GroupAdminCommandCleanup(store,policy,{
   delete:async(chat,messageId,guard)=>{
    if(!await guard())return 'NOT_SENT' as const;
    deleted.push({chat,messageId});
    if(during){const fn=during;during=undefined;await fn();}
    return response;
   }},()=>now,async()=>!stop,async()=>rights);
  const enable=async()=>{
   assert.equal(await service.configure(OWNER,G,true,service.epoch(await store.snapshot(),G)),true);
  };
  const receipt=async(n:number,actor=OWNER,kind:'MODERATION'|'LOCK'='MODERATION',delivered=true)=>{
   const key='b3-webhook:adminclean:'+n,reason=kind==='MODERATION'?'MODERATION_PREVIEW_ONLY':'GROUP_PERMISSIONS_VIEW';
   await store.transaction(s=>{
    s.updates.push({key,status:'DONE',leaseUntil:now});
    s.audit.push({updateKey:key,decision:'ALLOW',reason,policyVersion:0,at:now});
    s.telegramReplyJobs??=[];
    s.telegramReplyJobs.push({updateKey:key,plan:{chatId:actor,parseMode:'HTML',text:'<b>مراجعة الإجراء</b>'},
     privateReplyKind:'ADMIN_SCOPED',status:delivered?'SENT':'QUEUED',queuedAt:now,...(delivered?{messageId:n+1000}:{})});
   });
   return {key,reason};
  };
  const observe=async(n=51,actor=OWNER,kind:'MODERATION'|'LOCK'='MODERATION')=>{
   const {key,reason}=await receipt(n,actor,kind);
   return service.observeApproved(G,n,actor,key,kind,reason,now);
  };
  return {dir,store,policy,service,deleted,enable,observe,receipt,at:()=>now,advance:(v:number)=>{now+=v;},
   stop:()=>{stop=true;},start:()=>{stop=false;},rights:(v:typeof rights)=>{rights=v;},
   response:(v:typeof response)=>{response=v;},during:(fn:()=>Promise<void>)=>{during=fn;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' disabled by default and only owner may configure a group',async()=>{
  const f=await setup();try{
   assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
   assert.equal(await f.observe(),0);
   assert.equal(await f.service.configure(MOD,G,true,f.service.epoch(await f.store.snapshot(),G)),false);
   f.advance(120000);
   assert.deepEqual(await f.service.cleanup(),{deleted:0,unresolved:0});
  }finally{await f.close();}
 });
 test(engine+' only privately delivered, authorized moderation previews become deletable two minutes after command',async()=>{
  const f=await setup();try{
   await f.enable();assert.equal(await f.observe(51),1);
   assert.equal((await f.service.cleanup()).deleted,0);
   f.advance(119999);assert.equal((await f.service.cleanup()).deleted,0);
   f.advance(1);assert.deepEqual(await f.service.cleanup(),{deleted:1,unresolved:0});
   assert.deepEqual(f.deleted,[{chat:G,messageId:51}]);
   assert.equal((await f.service.cleanup()).deleted,0);
  }finally{await f.close();}
 });
 test(engine+' lock previews have distinct trusted evidence and follow the same safety rules',async()=>{
  const f=await setup();try{
   await f.enable();assert.equal(await f.observe(52,OWNER,'LOCK'),1);
   f.advance(120000);assert.equal((await f.service.cleanup()).deleted,1);
   assert.deepEqual(f.deleted,[{chat:G,messageId:52}]);
  }finally{await f.close();}
 });
 test(engine+' unknown delivery, wrong-private recipient, and unauthorized reason cannot trigger cleanup',async()=>{
  for(const variant of ['queued','rejected','wrong-recipient','wrong-status','wrong-reason'] as const){
   const f=await setup();try{
    await f.enable();const {key,reason}=await f.receipt(61,OWNER);
    if(variant==='queued')await f.store.transaction(s=>{const j=s.telegramReplyJobs!.find(j=>j.updateKey===key)!;j.status='QUEUED';delete j.messageId;});
    if(variant==='rejected')await f.store.transaction(s=>{const j=s.telegramReplyJobs!.find(j=>j.updateKey===key)!;j.status='FAILED_CONFIRMED';});
    if(variant==='wrong-recipient')await f.store.transaction(s=>{s.telegramReplyJobs!.find(j=>j.updateKey===key)!.plan.chatId='999';});
    if(variant==='wrong-status')await f.store.transaction(s=>{s.audit.find(a=>a.updateKey===key)!.decision='DENY';});
    const observed=await f.service.observeApproved(G,61,OWNER,key,'MODERATION',
     variant==='wrong-reason'?'RESPONSE_PLANNED_ONLY':reason,f.at());
    if(variant==='wrong-reason'||variant==='wrong-status'||variant==='wrong-recipient')assert.equal(observed,0);
    f.advance(120000);
    assert.equal((await f.service.cleanup()).deleted,0);assert.equal(f.deleted.length,0);
   }finally{await f.close();}
  }
 });
 test(engine+' forged webhook, replay, changed target, wrong command class and untrusted epoch do not authorize deletion',async()=>{
  const f=await setup();try{
   await f.enable();const {key,reason}=await f.receipt(71);
   assert.equal(await f.service.observeApproved(G,71,OWNER,'forged','MODERATION',reason,f.at()),0);
   assert.equal(await f.service.observeApproved(G,71,OWNER,key,'LOCK',reason,f.at()),0);
   assert.equal(await f.service.observeApproved(G,71,OWNER,key,'MODERATION',reason,f.at()),1);
   assert.equal(await f.service.observeApproved(G,71,OWNER,key,'MODERATION',reason,f.at()),0);
   assert.equal(await f.service.observeApproved(G,72,OWNER,key,'MODERATION',reason,f.at()),0);
   assert.equal(await f.service.observeApproved(G,71,OWNER,key,'MODERATION',reason,f.at()-31000),0);
   f.advance(120000);assert.equal((await f.service.cleanup()).deleted,1);
  }finally{await f.close();}
 });
 test(engine+' rights and STOP gate before Telegram request; consent revocation invalidates pending work',async()=>{
  const f=await setup();try{
   await f.enable();await f.observe();f.advance(120000);
   f.stop();assert.equal((await f.service.cleanup()).deleted,0);
   f.start();f.rights('UNKNOWN');assert.equal((await f.service.cleanup()).deleted,0);
   f.rights('DENIED');assert.equal((await f.service.cleanup()).deleted,0);
   f.rights('GRANTED');assert.equal((await f.service.cleanup()).deleted,1);
   const g=await setup();try{
    await g.enable();await g.observe();g.advance(120000);
    assert.equal(await g.service.configure(OWNER,G,false,g.service.epoch(await g.store.snapshot(),G)),true);
    assert.equal((await g.service.cleanup()).deleted,0);
   }finally{await g.close();}
  }finally{await f.close();}
 });
 test(engine+' terminal unknown deletion and crash before request never retry across restart',async()=>{
  for(const variant of ['unknown','crash'] as const){
   const f=await setup();try{
    await f.enable();await f.observe();f.advance(120000);
    if(variant==='unknown')f.response('UNKNOWN_OUTCOME');else await f.store.transaction(s=>{
     const root=s.audit.find(a=>/^group:admin-command-job:[a-f0-9]{64}$/u.test(a.updateKey))!;
     s.audit.push({updateKey:root.updateKey+':started',actorId:OWNER,decision:'ALLOW',reason:'GROUP_ADMIN_COMMAND_DELETE_STARTED',policyVersion:root.policyVersion,at:f.at()});
    });
    const first=await f.service.cleanup();assert.equal(first.deleted,0);assert.equal(first.unresolved,1);
    const reopened=new GroupAdminCommandCleanup(new BotStore(f.store.file,{engine}),f.policy,
     {delete:async()=>{throw Error('unexpected replay');}},f.at,async()=>true,async()=> 'GRANTED');
    assert.equal((await reopened.cleanup()).deleted,0);
    assert.equal(f.deleted.length,variant==='unknown'?1:0);
   }finally{await f.close();}
  }
 });
 test(engine+' group version change, actor grant loss, or forged job prevents deletion',async()=>{
  const f=await setup();try{
   await f.enable();await f.observe();f.advance(120000);
   await f.store.transaction(s=>{s.chats.find(c=>c.id===G)!.version++;});
   assert.equal((await f.service.cleanup()).deleted,0);
  }finally{await f.close();}
 });
 test(engine+' old commands expire without deletion, and attempt during shutdown is terminal',async()=>{
  const f=await setup();try{
   await f.enable();await f.observe();f.advance(86400001);
   assert.equal((await f.service.cleanup()).deleted,0);
  }finally{await f.close();}
 });
 test(engine+' owner inline control previews consent, issues single-use confirmation and off switch',async()=>{
  const f=await setup();try{
   const owner=new TelegramAdminCommandCleanupOwner(f.store,f.policy,f.service,f.at);
   const home=await owner.handle(OWNER,'ac:1:h'),group=await owner.handle(OWNER,choose(home,G));
   assert.ok(isValidTelegramInlineKeyboard(group!.keyboard));
   const preview=await owner.handle(OWNER,choose(group,'تفعيل'));
   assert.match(preview!.text,/معاينة/u);
   assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
   const confirm=choose(preview,'تأكيد');assert.ok(await owner.handle(OWNER,confirm));
   assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,true);
   assert.equal(await owner.handle(OWNER,confirm),null);
   const second=await owner.handle(OWNER,'ac:1:h'),newGroup=await owner.handle(OWNER,choose(second,G));
   const off=await owner.handle(OWNER,choose(newGroup,'إيقاف'));
   assert.ok(await owner.handle(OWNER,choose(off,'تأكيد')));
   assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
  }finally{await f.close();}
 });
}
