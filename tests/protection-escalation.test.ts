import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {moderationProtectionEnforcer} from '../src/protection-enforcement.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {isValidProtectionPolicy,type ProtectionPolicy} from '../src/protection-rules.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const config:ProtectionPolicy={chatId:'-100',revision:1,mode:'ENFORCE',rules:[{id:'spam',kind:'WORD',value:'spam',enabled:true,action:'WARN'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],escalation:{enabled:true,afterWarnings:2,windowMs:60000}};
const route=(s:OwnerInlineScreen|null,p:string)=>{const b=s?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('escalation schema rejects unsafe windows and unsupported actions',()=>{
 assert.ok(isValidProtectionPolicy(config));for(const escalation of [{enabled:true,afterWarnings:0,windowMs:60000},{enabled:true,afterWarnings:21,windowMs:60000},{enabled:true,afterWarnings:2,windowMs:59999},{enabled:true,afterWarnings:2,windowMs:86400001},{enabled:true,afterWarnings:2,windowMs:60000,action:'BAN'}])assert.equal(isValidProtectionPolicy({...config,escalation}),false);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'escalation-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=100000;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);const gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>now),port=moderationProtectionEnforcer(moderation),service=new GroupProtectionPolicyService(store,policy,()=>now,port);
  return {store,policy,gateway,service,moderation,editor:new TelegramProtectionEditor(store,policy,()=>now,port),time:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' escalation emits one bounded sanction, deduplicates, respects window, active warnings and exemptions',async()=>{
  const f=await fixture();try{
   await f.service.save('100',config,1,0);const observe=(id:number,member='300')=>f.service.observeIncomingText(member,'-100','spam',[],'b3-webhook:test:'+id);
   await observe(1);await observe(2);assert.equal((await f.store.snapshot()).warnings.length,2);assert.equal(f.gateway.calls.length,0);
   await observe(3);let s=await f.store.snapshot();assert.equal(s.warnings.length,2);assert.equal(s.moderationReasons.length,1);assert.equal(s.moderationReasons[0]!.expiresAt,160000);assert.equal(f.gateway.calls.length,1);
   assert.equal(await observe(3),'DUPLICATE');assert.equal(f.gateway.calls.length,1);
   f.time(160000);await observe(4,'301');assert.equal((await f.store.snapshot()).warnings.length,3);
   await f.moderation.issueWarning('100','-100','302','manual-a');await f.moderation.issueWarning('100','-100','302','manual-b');
   await f.store.transaction(s=>{s.warnings.find(w=>w.reference==='manual-b')!.active=false;});await observe(5,'302');assert.equal(f.gateway.calls.length,1);
   s=await f.store.snapshot();const c=s.protectionPolicies![0]!.policy;await f.service.save('100',{...c,revision:2,temporaryExemptions:[{memberId:'303',createdAt:160000,expiresAt:220000}]},1,1);
   assert.equal(await observe(6,'303'),'EXEMPT');
  }finally{await f.close();}
 });
 test(engine+' escalation rechecks warning source and window at the last authority boundary',async()=>{
  for(const change of ['warning','expiry'] as const){const f=await fixture();try{
   await f.service.save('100',config,1,0);await f.moderation.issueWarning('100','-100','300','a');await f.moderation.issueWarning('100','-100','300','b');
   const original=f.gateway.isProtected.bind(f.gateway);let changed=false;f.gateway.isProtected=async(c,m)=>{if(!changed){changed=true;if(change==='expiry')f.time(160000);else await f.store.transaction(s=>{s.warnings[0]!.active=false;});}return original(c,m);};
   await f.service.observeIncomingText('300','-100','spam',[],'b3-webhook:test:1');assert.equal(f.gateway.calls.length,0);assert.equal((await f.store.snapshot()).moderationReasons.length,0);
  }finally{await f.close();}}
 });
 test(engine+' escalation editor starts disabled, validates, cancels and rejects stale toggles',async()=>{
  const f=await fixture();try{
   let g=await f.editor.handle((await f.editor.link('100','-100'))!,'100');let view=await f.editor.handle(route(g,'pr:1:B:'),'100');
   const begin=route(view,'pr:1:C:');await f.editor.handle(begin,'100');await f.editor.cancelNavigation('100');assert.equal(await f.editor.handleText('100','2 60',false),null);
   await f.editor.handle(begin,'100');assert.equal((await f.editor.handleText('100','21 60',false))?.reason,'PROTECTION_EDITOR_INPUT_REJECTED');await f.editor.handleText('100','2 60',false);
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.escalation!.enabled,false);
   g=await f.editor.handle((await f.editor.link('100','-100'))!,'100');view=await f.editor.handle(route(g,'pr:1:B:'),'100');const toggle=route(view,'pr:1:D:');await f.editor.handle(toggle,'100');assert.equal(await f.editor.handle(toggle,'100'),null);
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.mode,'OFF');assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.escalation!.enabled,true);
  }finally{await f.close();}
 });
}
