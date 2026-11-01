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
import {tickGroupPermissionRestores} from '../src/group-permission-timers.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {isValidProtectionPolicy,type ProtectionPolicy} from '../src/protection-rules.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const config:ProtectionPolicy={chatId:'-100',revision:1,mode:'ENFORCE',rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],flood:{enabled:true,limit:5,windowMs:3000,action:'WARN'},raid:{enabled:true,minimumMembers:2,minimumMessages:4,lockSeconds:60}};
const route=(s:OwnerInlineScreen|null,p:string)=>{const b=s?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('AntiRaid schema requires bounded temporary protection and an enabled observed traffic window',()=>{
 assert.ok(isValidProtectionPolicy(config));for(const patch of [{flood:{...config.flood!,enabled:false}},{raid:{...config.raid!,lockSeconds:601}},{raid:{...config.raid!,minimumMembers:1}},{raid:{...config.raid!,minimumMessages:1}},{raid:{...config.raid!,action:'BAN'}}])assert.equal(isValidProtectionPolicy({...config,...patch}),false);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'antiraid-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=100000,calls=0;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);const original=Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])) as GroupPermissions;let permissions=structuredClone(original),hook:(()=>Promise<void>)|undefined;
  const locks=new GroupPermissionLockService(store,policy,{read:async()=>{if(hook){const f=hook;hook=undefined;await f();}return structuredClone(permissions);},apply:async(_c,b,a,current)=>{assert.deepEqual(b,permissions);if(!await current())return 'FAILED_CONFIRMED';calls++;permissions=structuredClone(a);return 'CONFIRMED';}},()=>now);
  const moderation=new ModerationService(store,policy,new FakeModerationGateway(),()=>now),port=moderationProtectionEnforcer(moderation,locks),service=new GroupProtectionPolicyService(store,policy,()=>now,port);
  const observe=(id:number,member='300',count=true)=>service.observeIncomingText(member,'-100','hello',[],'b3-webhook:raid:'+id,count);
  return {store,policy,locks,service,observe,editor:new TelegramProtectionEditor(store,policy,()=>now,port),calls:()=>calls,current:()=>permissions,original,time:(n:number)=>{now=n;},before:(h:()=>Promise<void>)=>{hook=h;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' one group raid claim locks temporarily and restores the exact original snapshot without member bans',async()=>{
  const f=await fixture();try{
   assert.equal((await new GroupProtectionPolicyService(f.store,f.policy,()=>100000,moderationProtectionEnforcer(new ModerationService(f.store,f.policy,new FakeModerationGateway()))).save('100',config,1,0)).status,'ENFORCEMENT_NOT_CONNECTED');
   await f.service.save('100',config,1,0);await f.observe(1);await f.observe(2);await f.observe(3,'301');assert.equal(f.calls(),0);
   assert.equal(await f.observe(4,'301'),'ENFORCEMENT_ATTEMPTED');assert.equal(f.calls(),1);assert.equal(f.current().can_send_messages,false);
   assert.equal(await f.observe(4,'301'),'DUPLICATE');await f.observe(5,'302');assert.equal(f.calls(),1);
   let s=await f.store.snapshot();assert.equal(s.moderationReasons.length,0);assert.equal(s.moderationOperations.length,0);assert.equal(s.groupPermissionJobs![0]!.restoreAt,160000);
   f.time(160000);await tickGroupPermissionRestores(f.store,f.locks,160000,true);assert.equal(f.calls(),2);assert.deepEqual(f.current(),f.original);
  }finally{await f.close();}
 });
 test(engine+' AntiRaid excludes edits and exempt members, refuses stale policy and never replaces a human preview',async()=>{
  for(const scenario of ['edit','exempt','policy','preview'] as const){const f=await fixture();try{
   await f.service.save('100',{...config,...(scenario==='exempt'?{exemptMemberIds:['301']}:{})},1,0);
   await f.observe(1);await f.observe(2);await f.observe(3,'301');
   let previewId:string|undefined;if(scenario==='preview'){const p=await f.locks.preview('100','-100','LOCK','PHOTOS');previewId=p!.id;}
   if(scenario==='policy')f.before(async()=>{await f.store.transaction(s=>{s.protectionPolicies![0]!.policy.mode='OFF';});});
   await f.observe(4,'301',scenario!=='edit');assert.equal(f.calls(),0);
   if(previewId)assert.equal((await f.store.snapshot()).groupPermissionJobs!.find(j=>j.id===previewId)!.status,'PREVIEW');
  }finally{await f.close();}}
 });
 test(engine+' AntiRaid settings are disabled initially, validate bounds and retain working cancel/back/toggle',async()=>{
  const f=await fixture();try{
   let g=await f.editor.handle((await f.editor.link('100','-100'))!,'100'),view=await f.editor.handle(route(g,'pr:1:J:'),'100');const begin=route(view,'pr:1:K:');await f.editor.handle(begin,'100');
   assert.equal((await f.editor.handleText('100','1 4 60',false))!.reason,'PROTECTION_EDITOR_INPUT_REJECTED');await f.editor.handleText('100','2 4 60',false);assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.raid!.enabled,false);
   let c=(await f.store.snapshot()).protectionPolicies![0]!.policy;await f.service.save('100',{...c,revision:2,flood:config.flood},1,1);
   g=await f.editor.handle((await f.editor.link('100','-100'))!,'100');view=await f.editor.handle(route(g,'pr:1:J:'),'100');const toggle=route(view,'pr:1:L:');await f.editor.handle(toggle,'100');assert.equal(await f.editor.handle(toggle,'100'),null);
   c=(await f.store.snapshot()).protectionPolicies![0]!.policy;assert.equal(c.raid!.enabled,true);assert.equal(c.mode,'OFF');assert.equal((await f.service.save('100',{...c,revision:c.revision+1,flood:{...c.flood!,enabled:false}},1,c.revision)).status,'INVALID');
   g=await f.editor.handle((await f.editor.link('100','-100'))!,'100');view=await f.editor.handle(route(g,'pr:1:J:'),'100');assert.ok(await f.editor.handle(route(view,'pr:1:g:'),'100'));
  }finally{await f.close();}
 });
}
