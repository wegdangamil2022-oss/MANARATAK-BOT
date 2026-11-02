import type {GroupPermissionPort} from '../src/telegram-group-permission-gateway.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {GroupPermissionLockService} from '../src/group-permission-lock.js';
import {GROUP_PERMISSION_KEYS,type GroupPermissions} from '../src/group-permission-model.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {moderationProtectionEnforcer} from '../src/protection-enforcement.js';
import {observeProtectionJoins} from '../src/protection-join-raid.js';
import {tickGroupPermissionRestores} from '../src/group-permission-timers.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {isValidProtectionPolicy,type ProtectionPolicy} from '../src/protection-rules.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
const NOW=100000,CHAT='-100',config=():ProtectionPolicy=>({chatId:CHAT,revision:1,mode:'ENFORCE',rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],joinRaid:{enabled:true,minimumMembers:3,windowMs:10000,lockSeconds:60}});
const route=(s:OwnerInlineScreen|null,p:string)=>{assert.ok(s&&isValidTelegramInlineKeyboard(s.keyboard));const b=s.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('join raid has separate bounded disabled-by-default configuration',()=>{assert.ok(isValidProtectionPolicy(config()));for(const patch of [{minimumMembers:2},{windowMs:4999},{windowMs:60001},{lockSeconds:601},{action:'BAN'}])assert.equal(isValidProtectionPolicy({...config(),joinRaid:{...config().joinRaid!,...patch}}),false);});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'join-raid-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=NOW,calls=0,hook:(()=>Promise<void>)|undefined;const policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation']);const original=Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])) as GroupPermissions;let permissions=structuredClone(original);
  const gateway:GroupPermissionPort={read:async()=>{if(hook){const h=hook;hook=undefined;await h();}return structuredClone(permissions);},apply:async(_c,b,a,current)=>{assert.deepEqual(b,permissions);if(!await current())return 'FAILED_CONFIRMED';calls++;permissions=structuredClone(a);return 'CONFIRMED';}},locks=new GroupPermissionLockService(store,policy,gateway,()=>now),moderation=new ModerationService(store,policy,new FakeModerationGateway(),()=>now),port=moderationProtectionEnforcer(moderation,locks),service=new GroupProtectionPolicyService(store,policy,()=>now,port);
  const education=new EducationService(store,policy,()=>now),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),clock:()=>now,botId:'joins',botUsername:'ManaratakBot',protectionEnforcer:port,membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  return {store,file,policy,locks,gateway,port,service,app,now:()=>now,time:(v:number)=>{now=v;},calls:()=>calls,current:()=>permissions,original,before:(h:()=>Promise<void>)=>{hook=h;},observe:(id:number,members:string[])=>observeProtectionJoins(store,policy,()=>now,port,CHAT,members,now,'b3-webhook:joins:'+id),close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' distinct service-message joins make one temporary lock and restore the exact snapshot after restart',async()=>{
  const f=await fixture();try{
   await f.service.save('100',config(),1,0);assert.equal(await f.observe(1,['300']),'OBSERVED');assert.equal(await f.observe(2,['300']),'OBSERVED');assert.equal(await f.observe(2,['301']),'DUPLICATE');assert.equal(await f.observe(3,['301']),'OBSERVED');assert.equal(await f.observe(4,['302']),'ENFORCEMENT_CONFIRMED');assert.equal(f.calls(),1);assert.equal(f.current().can_send_messages,false);assert.equal(await f.observe(5,['303']),'COOLDOWN');
   const state=await f.store.snapshot();assert.equal(state.moderationReasons.length,0);assert.equal(state.moderationOperations.length,0);assert.ok(state.groupPermissionJobs![0]!.automationKey);assert.equal(state.audit.filter(a=>a.reason.startsWith('PROTECTION_JOIN_OBSERVED:')).some(a=>a.reason.includes('"300"')),false);
   f.time(NOW+60000);const reopenedStore=new BotStore(f.file,{engine}),reopened=new GroupPermissionLockService(reopenedStore,f.policy,f.gateway,f.now);assert.equal((await tickGroupPermissionRestores(reopenedStore,reopened,f.now(),true)).confirmed,1);assert.deepEqual(f.current(),f.original);assert.equal(f.calls(),2);assert.equal((await tickGroupPermissionRestores(reopenedStore,reopened,f.now(),true)).attempted,0);
  }finally{await f.close();}
 });
 test(engine+' monitor, exempt accounts, source drift and human preview never authorize join sanctions',async()=>{
  for(const reason of ['monitor','exempt','policy','preview'] as const){const f=await fixture();try{
   const c=config();if(reason==='monitor')c.mode='MONITOR';if(reason==='exempt')c.exemptMemberIds=['302'];await f.service.save('100',c,1,0);
   if(reason==='preview')assert.ok(await f.locks.preview('100',CHAT,'LOCK','MEDIA'));
   if(reason==='policy')f.before(async()=>{const next=config();next.revision=2;next.mode='OFF';await f.service.save('100',next,1,1);});
   await f.observe(11,['100','300','301','302']);assert.equal(f.calls(),0);assert.equal((await f.store.snapshot()).moderationReasons.length,0);
  }finally{await f.close();}}
 });
 test(engine+' join envelope rejects edits, forwards, bots-only, private and ambiguous service payloads',async()=>{
  const f=await fixture();try{
   const c=config();c.mode='MONITOR';await f.service.save('100',c,1,0);const msg={message_id:10,date:100,chat:{id:-100,type:'supergroup'},from:{id:500,is_bot:false},new_chat_members:[{id:300,is_bot:false},{id:301,is_bot:false},{id:302,is_bot:false}]};
   const valid=await f.app.handle({update_id:20,message:msg});assert.equal(valid.reason,'PROTECTION_JOINS_MONITORED');assert.equal(valid.plan,undefined);
   for(const [i,patch] of [{text:'mixed'},{forward_origin:{type:'user',date:100}},{chat:{id:500,type:'private'}},{new_chat_members:[{id:300,is_bot:false},{id:300,is_bot:false}]}].entries())assert.equal((await f.app.handle({update_id:30+i,message:{...msg,...patch}})).status,'DENIED');
   assert.equal((await f.app.handle({update_id:40,edited_message:{...msg,edit_date:100}})).reason,'INVALID_GROUP_JOINS');assert.equal((await f.app.handle({update_id:41,message:{...msg,new_chat_members:[{id:900,is_bot:true}]}})).reason,'PROTECTION_JOINS_EXEMPT');assert.equal(f.calls(),0);
  }finally{await f.close();}
 });
 test(engine+' join editor starts disabled, rejects bounds and keeps cancel and return working',async()=>{
  const f=await fixture();try{
   const ui=new TelegramProtectionEditor(f.store,f.policy,f.now,f.port);let g=await ui.handle((await ui.link('100',CHAT))!,'100'),raid=await ui.handle(route(g,'pr:1:J:'),'100'),join=await ui.handle(route(raid,'pr:1:U:'),'100');await ui.handle(route(join,'pr:1:V:'),'100');assert.equal((await ui.handleText('100','2 30 60',false))?.reason,'PROTECTION_EDITOR_INPUT_REJECTED');await ui.handleText('100','5 30 120',false);assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.joinRaid!.enabled,false);
   g=await ui.handle((await ui.link('100',CHAT))!,'100');raid=await ui.handle(route(g,'pr:1:J:'),'100');join=await ui.handle(route(raid,'pr:1:U:'),'100');await ui.handle(route(join,'pr:1:W:'),'100');assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.joinRaid!.enabled,true);
  }finally{await f.close();}
 });
}
