import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupPermissionLockService} from '../src/group-permission-lock.js';
import {GROUP_PERMISSION_KEYS,type GroupPermissions} from '../src/group-permission-model.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {moderationProtectionEnforcer} from '../src/protection-enforcement.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {protectionNightWindow,tickProtectionNight} from '../src/protection-night.js';
import {tickGroupPermissionRestores} from '../src/group-permission-timers.js';
import {isValidProtectionPolicy,type ProtectionPolicy} from '../src/protection-rules.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const nowAt=(s:string)=>Date.parse(s),night={enabled:true,startMinute:1320,endMinute:360,offsetMinutes:180};
const config:ProtectionPolicy={chatId:'-100',revision:1,mode:'ENFORCE',rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],night};
const route=(s:OwnerInlineScreen|null,p:string)=>{const b=s?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('night windows cross midnight at the configured fixed offset and have exclusive end boundaries',()=>{
 assert.equal(protectionNightWindow(night,nowAt('2026-11-02T18:59:59Z')),null);
 const expected={start:nowAt('2026-11-02T19:00:00Z'),end:nowAt('2026-11-03T03:00:00Z')};
 assert.deepEqual(protectionNightWindow(night,expected.start),expected);assert.deepEqual(protectionNightWindow(night,expected.end-1),expected);assert.equal(protectionNightWindow(night,expected.end),null);
 assert.equal(protectionNightWindow(night,NaN),null);
 assert.ok(isValidProtectionPolicy(config));for(const n of [{...night,startMinute:1440},{...night,endMinute:1320},{...night,offsetMinutes:841},{...night,offsetMinutes:0.5},{...night,extra:true}])assert.equal(isValidProtectionPolicy({...config,night:n}),false);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'night-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=nowAt('2026-11-02T19:00:00Z'),calls=0,unknown=false,hook:(()=>Promise<void>)|undefined;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);const original=Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])) as GroupPermissions;let permissions=structuredClone(original);
  const locks=new GroupPermissionLockService(store,policy,{read:async()=>{if(hook){const h=hook;hook=undefined;await h();}return structuredClone(permissions);},apply:async(_c,_b,a,current)=>{if(!await current())return 'FAILED_CONFIRMED';calls++;permissions=structuredClone(a);return unknown?'UNKNOWN_OUTCOME':'CONFIRMED';}},()=>now),moderation=new ModerationService(store,policy,new FakeModerationGateway(),()=>now),port=moderationProtectionEnforcer(moderation,locks),service=new GroupProtectionPolicyService(store,policy,()=>now,port);
  return {store,file,policy,locks,service,editor:new TelegramProtectionEditor(store,policy,()=>now,port),clock:()=>now,time:(n:number)=>{now=n;},calls:()=>calls,current:()=>permissions,original,unknown:()=>{unknown=true;},before:(h:()=>Promise<void>)=>{hook=h;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' recurring night makes one durable attempt per window, restores the exact snapshot and resumes next day',async()=>{
  const f=await fixture();try{
   await f.service.save('100',config,1,0);f.before(async()=>{f.time(f.clock()+3000);});assert.equal((await tickProtectionNight(f.store,f.policy,f.locks,f.clock)).attempted,0);assert.equal(f.calls(),0);
   assert.equal((await tickProtectionNight(f.store,f.policy,f.locks,f.clock,true)).confirmed,1);assert.equal(f.calls(),1);
   let s=await f.store.snapshot();assert.equal(s.groupPermissionJobs![0]!.restoreAt,nowAt('2026-11-03T03:00:00Z'));assert.ok(s.groupPermissionJobs![0]!.automationKey);
   const reopened=new BotStore(f.file,{engine});assert.equal((await tickProtectionNight(reopened,f.policy,f.locks,f.clock,true)).attempted,0);assert.equal(f.calls(),1);
   f.time(nowAt('2026-11-03T03:00:00Z'));await tickGroupPermissionRestores(f.store,f.locks,f.clock(),true);assert.deepEqual(f.current(),f.original);assert.equal(f.calls(),2);
   assert.equal((await tickProtectionNight(f.store,f.policy,f.locks,f.clock,true)).attempted,0);
   f.time(nowAt('2026-11-03T19:00:00Z'));assert.equal((await tickProtectionNight(f.store,f.policy,f.locks,f.clock,true)).confirmed,1);assert.equal(f.calls(),3);
   s=await f.store.snapshot();assert.equal(new Set(s.groupPermissionJobs!.filter(j=>j.kind==='LOCK').map(j=>j.automationKey)).size,2);
  }finally{await f.close();}
 });
 test(engine+' night does not replace human previews, ignores stopped/stale policies and never retries an uncertain mutation',async()=>{
  for(const mode of ['preview','otherPreview','policy','late','unknown'] as const){const f=await fixture();try{
   await f.service.save('100',config,1,0);
   let id:string|undefined;if(mode==='otherPreview')await f.policy.grant('100','200','chat.manage','-100',f.clock()+999999);if(mode==='preview'||mode==='otherPreview')id=(await f.locks.preview(mode==='otherPreview'?'200':'100','-100','LOCK','PHOTOS'))!.id;
   if(mode==='policy')f.before(async()=>{await f.store.transaction(s=>{s.protectionPolicies![0]!.policy.mode='OFF';});});
   if(mode==='late')f.time(nowAt('2026-11-03T02:59:30Z'));if(mode==='unknown')f.unknown();
   const result=await tickProtectionNight(f.store,f.policy,f.locks,f.clock,true);assert.equal(result.confirmed,0);assert.equal(f.calls(),mode==='unknown'?1:0);
   await tickProtectionNight(f.store,f.policy,f.locks,f.clock,true);assert.equal(f.calls(),mode==='unknown'?1:0);
   if(id)assert.equal((await f.store.snapshot()).groupPermissionJobs!.find(j=>j.id===id)!.status,'PREVIEW');
  }finally{await f.close();}}
 });
 test(engine+' night editor validates the time and offset and keeps execution independently disabled',async()=>{
  const f=await fixture();try{
   let g=await f.editor.handle((await f.editor.link('100','-100'))!,'100'),v=await f.editor.handle(route(g,'pr:1:N:'),'100');await f.editor.handle(route(v,'pr:1:O:'),'100');
   assert.equal((await f.editor.handleText('100','25:00 06:00 180',false))!.reason,'PROTECTION_EDITOR_INPUT_REJECTED');await f.editor.handleText('100','22:00 06:00 180',false);
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.night!.enabled,false);
   g=await f.editor.handle((await f.editor.link('100','-100'))!,'100');v=await f.editor.handle(route(g,'pr:1:N:'),'100');const toggle=route(v,'pr:1:P:');await f.editor.handle(toggle,'100');assert.equal(await f.editor.handle(toggle,'100'),null);
   const c=(await f.store.snapshot()).protectionPolicies![0]!.policy;assert.deepEqual(c.night,night);assert.equal(c.mode,'OFF');
  }finally{await f.close();}
 });
}
