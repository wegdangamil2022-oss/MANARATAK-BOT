import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {protectionUIEpoch} from '../src/protection-ui-access.js';
import {GroupAdminCommandCleanup,reviewedAdminCommandKind} from '../src/group-admin-command-cleanup.js';
import {TelegramAdminCommandCleanupOwner} from '../src/telegram-admin-command-cleanup-owner.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const BASE=1700000000000,G='-100123',OWNER='100',MOD='201';

test('reviewed admin cleanup recognizes only supported approved command families',()=>{
 const bot='ManaratakBot';
 for(const cmd of ['/ban','/warn','/unwarn','/unban','/unmute','/kick','/review','/notice','/mute',
  '/warnrule 2','/muterule 2 300','/reviewrule 2','/noticerule 2','إنذار 2']){
  assert.equal(reviewedAdminCommandKind(cmd,bot,'MODERATION_PREVIEW_ONLY'),'MODERATION',cmd);
 }
 for(const cmd of ['/lock messages','/unlock','/lock@ManaratakBot media']){
  assert.equal(reviewedAdminCommandKind(cmd,bot,'GROUP_PERMISSIONS_VIEW'),'LOCK',cmd);
 }
 assert.equal(reviewedAdminCommandKind('/actrule 2',bot,'RULE_ACTION_CHOICE'),'RULE');
 assert.equal(reviewedAdminCommandKind('/actrule@ManaratakBot 2',bot,'RULE_ACTION_CHOICE'),'RULE');
 for(const [cmd,reason] of [
  ['/actrule 2','MODERATION_PREVIEW_ONLY'],['/warnrule 2','RULE_ACTION_CHOICE'],
  ['/noticerule 0','MODERATION_PREVIEW_ONLY'],['/muterule 2','MODERATION_PREVIEW_ONLY'],
  ['/warnrule 2 extra','MODERATION_PREVIEW_ONLY'],['/actrule 2\n/ban','RULE_ACTION_CHOICE'],
  ['/actrule@OtherBot 2','RULE_ACTION_CHOICE'],['/warnrule@OtherBot 2','MODERATION_PREVIEW_ONLY'],
  ['/actrule 2','GROUP_PERMISSIONS_VIEW'],['/lock','MODERATION_PREVIEW_ONLY'],
  ['/delete','DELETE_PREVIEW_ONLY'],['/rules','MODERATION_PREVIEW_ONLY'],
  ['إنذار','MODERATION_PREVIEW_ONLY'],['إنذار 0','MODERATION_PREVIEW_ONLY']
 ] as const)assert.equal(reviewedAdminCommandKind(cmd,bot,reason),null,cmd+' / '+reason);
});

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
  const receipt=async(n:number,actor=OWNER,kind:'MODERATION'|'LOCK'|'RULE'='MODERATION',delivered=true)=>{
   const key='b3-webhook:adminclean:'+n,reason=kind==='MODERATION'?'MODERATION_PREVIEW_ONLY':kind==='LOCK'?'GROUP_PERMISSIONS_VIEW':'RULE_ACTION_CHOICE';
   await store.transaction(s=>{
    s.updates.push({key,status:'DONE',leaseUntil:now});
    s.audit.push({updateKey:key,decision:'ALLOW',reason,policyVersion:0,at:now});
    s.telegramReplyJobs??=[];
    s.telegramReplyJobs.push({updateKey:key,plan:{chatId:actor,parseMode:'HTML',text:'<b>مراجعة الإجراء</b>'},
     privateReplyKind:'ADMIN_SCOPED',status:'QUEUED',queuedAt:now,
     adminUIAccess:{actorId:actor,epoch:protectionUIEpoch(s,policy,actor,now)??'a'.repeat(64),expiresAt:now+120000}});
   });
   return {key,reason};
  };
  const deliver=async(key:string,n:number,status:'SENT'|'FAILED_CONFIRMED'='SENT')=>
   store.transaction(s=>{
    const job=s.telegramReplyJobs!.find(j=>j.updateKey===key)!;
    job.status=status;job.messageId=n+1000;job.startedAt=now;job.redactedAt=now;
    job.attemptId='11111111-2222-4333-8444-555555555555';
    delete job.plan;delete job.privateReplyKind;delete job.adminUIAccess;
   });
  const observe=async(n=51,actor=OWNER,kind:'MODERATION'|'LOCK'='MODERATION')=>{
   const {key,reason}=await receipt(n,actor,kind);
   const result=await service.observeApproved(G,n,actor,key,kind,reason,now);
   if(result)await deliver(key,n);
   return result;
  };
  return {dir,store,policy,service,deleted,enable,observe,receipt,deliver,at:()=>now,advance:(v:number)=>{now+=v;},
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

 test(engine+' approved rule-action selection is cleaned only after confirmed private delivery',async()=>{
  const f=await setup();try{
   await f.enable();assert.equal(await f.observe(53,OWNER,'RULE'),1);
   f.advance(120000);
   assert.deepEqual(await f.service.cleanup(),{deleted:1,unresolved:0});
   assert.deepEqual(f.deleted,[{chat:G,messageId:53}]);
  }finally{await f.close();}
 });

 test(engine+' unknown delivery, wrong-private recipient, and unauthorized reason cannot trigger cleanup',async()=>{
  for(const variant of ['queued','rejected','wrong-recipient','wrong-status','wrong-reason'] as const){
   const f=await setup();try{
    await f.enable();const {key,reason}=await f.receipt(61,OWNER);

    if(variant==='wrong-recipient')await f.store.transaction(s=>{const j=s.telegramReplyJobs!.find(j=>j.updateKey===key)!;j.plan!.chatId='999';j.adminUIAccess!.actorId='999';});
    if(variant==='wrong-status')await f.store.transaction(s=>{s.audit.find(a=>a.updateKey===key)!.decision='DENY';});
    const observed=await f.service.observeApproved(G,61,OWNER,key,'MODERATION',
     variant==='wrong-reason'?'RESPONSE_PLANNED_ONLY':reason,f.at());
    if(variant==='wrong-reason'||variant==='wrong-status'||variant==='wrong-recipient')assert.equal(observed,0);
    else assert.equal(observed,1);
    if(variant==='rejected')await f.deliver(key,61,'FAILED_CONFIRMED');
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
   // Cleanup requires the independently confirmed private preview receipt;
   // accepting the command itself must never be enough.
   await f.deliver(key,71);
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
 test(engine+' Telegram private callback routes real admin cleanup owner editor without enabling deletion on open',async()=>{
  const f=await setup();try{
   const education=new EducationService(f.store,f.policy,f.at);
   const app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,
    admin:new EducationAdminFacade(f.store,f.policy,education,f.at),
    faq:new ApprovedAnswerService(f.store,f.policy,f.at),
    links:new ResourceLinkService(f.store,f.policy,f.at),
    botId:'adminclean',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',
    clock:f.at,adminCommandCleanup:f.service,ownerMenuMode:'inline'});
   const cb=(n:number,data:string)=>({update_id:n,callback_query:{id:'cb'+n,
    from:{id:Number(OWNER),is_bot:false},data,
    message:{message_id:3,chat:{id:Number(OWNER),type:'private'},from:{id:123456,is_bot:true}}}});
   const root=await app.handle(cb(801,'ac:1:h'));
   assert.equal(root.status,'APPLIED');assert.ok(root.plan?.inlineMarkup);
   const group=await app.handle(cb(802,choose({text:root.plan!.text,keyboard:root.plan!.inlineMarkup!},G)));
   assert.equal(group.status,'APPLIED');assert.ok(group.plan?.inlineMarkup);
   const preview=await app.handle(cb(803,choose({text:group.plan!.text,keyboard:group.plan!.inlineMarkup!},'تفعيل')));
   assert.equal(preview.status,'APPLIED');assert.match(preview.plan?.text??'',/معاينة/u);
   assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,false);
   const confirm=choose({text:preview.plan!.text,keyboard:preview.plan!.inlineMarkup!},'تأكيد');
   const activated=await app.handle(cb(804,confirm));
   assert.equal(activated.status,'APPLIED');
   assert.equal(f.service.policy(await f.store.snapshot(),G)?.enabled,true);
   const replay=await app.handle(cb(805,confirm));
   assert.equal(replay.status,'DENIED');
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
