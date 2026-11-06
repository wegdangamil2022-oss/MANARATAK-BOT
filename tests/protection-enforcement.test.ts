import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {moderationProtectionEnforcer} from '../src/protection-enforcement.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {protectionRuleFingerprint,type ProtectionPolicy,type ProtectionAction} from '../src/protection-rules.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';

for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'enforcement-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=100000;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);
  const gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>now),port=moderationProtectionEnforcer(moderation);
  const service=new GroupProtectionPolicyService(store,policy,()=>now,port);
  const config=(action:ProtectionAction='WARN',revision=1):ProtectionPolicy=>({chatId:'-100',revision,mode:'ENFORCE',rules:[{id:'spam',kind:'WORD',value:'spam',enabled:true,action}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]});
  const epoch=policy.chatRevision(await store.snapshot(),'-100');
  const observe=(id=1,member='300',text='spam PRIVATE_SAMPLE')=>service.observeIncomingText(member,'-100',text,[],'b3-webhook:enforcement:'+id);
  return {store,policy,gateway,moderation,port,service,config,epoch,observe,clock:()=>now,time:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' enforcement is opt-in, refuses unsupported deletion and deduplicates a persisted warning claim',async()=>{
  const f=await fixture();try{
   assert.equal((await new GroupProtectionPolicyService(f.store,f.policy,f.clock).save('100',f.config(),f.epoch,0)).status,'ENFORCEMENT_NOT_CONNECTED');
   assert.equal((await f.service.save('100',f.config('DELETE'),f.epoch,0)).status,'ENFORCEMENT_NOT_CONNECTED');
   assert.equal((await f.service.save('100',f.config(),f.epoch,0)).status,'SAVED');
   assert.equal(await f.observe(),'ENFORCEMENT_ATTEMPTED');assert.equal(await f.observe(),'DUPLICATE');
   const state=await f.store.snapshot();assert.equal(state.warnings.length,1);assert.equal(f.gateway.calls.length,0);
   assert.equal(JSON.stringify(state).includes('PRIVATE_SAMPLE'),false);
   const reopened=new GroupProtectionPolicyService(f.store,f.policy,f.clock,f.port);
   assert.equal(await reopened.observeIncomingText('300','-100','spam',[],'b3-webhook:enforcement:1'),'DUPLICATE');
   const disconnected=new GroupProtectionPolicyService(f.store,f.policy,f.clock);
   assert.equal(await disconnected.observeIncomingText('300','-100','spam',[],'b3-webhook:enforcement:2'),'ENFORCEMENT_NOT_CONNECTED');
  }finally{await f.close();}
 });
 test(engine+' automatic mute uses the existing reason ledger and a bounded deadline; exemptions survive',async()=>{
  const f=await fixture();try{
   await f.service.save('100',{...f.config('MUTE'),exemptMemberIds:['301']},f.epoch,0);
   assert.equal(await f.observe(1,'100'),'EXEMPT');assert.equal(await f.observe(2,'301'),'EXEMPT');
   f.gateway.protectedMembers.add('-100:302');assert.equal(await f.observe(3,'302'),'ENFORCEMENT_ATTEMPTED');assert.equal(f.gateway.calls.length,0);
   assert.equal(await f.observe(4),'ENFORCEMENT_ATTEMPTED');const state=await f.store.snapshot();
   assert.equal(state.moderationReasons.length,1);assert.equal(state.moderationReasons[0]!.expiresAt,160000);assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 });
 test(engine+' policy changes, grant revocation and expired evaluation witnesses reject mutations after awaited authority reads',async()=>{
  for(const change of ['policy','grant','time'] as const){
   const f=await fixture();try{
    await f.policy.grant('100','200','chat.manage','-100',999999);
    await f.service.save('200',f.config(),f.epoch,0);
    f.gateway.canRestrict=async()=>{await f.store.transaction(s=>{
     if(change==='policy'){s.protectionPolicies![0]!.policy.mode='OFF';}
     if(change==='grant')s.grants.find(g=>g.actor==='200')!.revoked=true;
    });if(change==='time')f.time(105000);return true;};
    assert.equal(await f.observe(),'ENFORCEMENT_ATTEMPTED');assert.equal((await f.store.snapshot()).warnings.length,0);assert.equal(f.gateway.calls.length,0);
   }finally{await f.close();}
  }
 });
 test(engine+' adding a rule exception during authority lookup prevents the old enforcement attempt',async()=>{
  const f=await fixture();try{
   const original=f.config();assert.equal((await f.service.save('100',original,f.epoch,0)).status,'SAVED');
   f.gateway.canRestrict=async()=>{const current=(await f.store.snapshot()).protectionPolicies![0]!.policy;const result=await f.service.save('100',{...current,revision:current.revision+1,ruleExemptions:[{memberId:'300',ruleId:'spam',ruleDigest:protectionRuleFingerprint(current.rules[0]!),createdAt:f.clock(),expiresAt:f.clock()+60000,grantedBy:'100'}]},f.epoch,current.revision);assert.equal(result.status,'SAVED');return true;};
   assert.equal(await f.observe(),'ENFORCEMENT_ATTEMPTED');assert.equal((await f.store.snapshot()).warnings.length,0);assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' enforcement requires separate UI confirmation and stale confirmations cannot reactivate old policies',async()=>{
  const f=await fixture();try{
   await f.service.save('100',{...f.config(),mode:'MONITOR'},f.epoch,0);
   const editor=new TelegramProtectionEditor(f.store,f.policy,f.clock,f.port);
   const group=await editor.openOwnerGroup('100','-100',f.epoch);assert.ok(group);
   const button=(s:typeof group,prefix:string)=>s!.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix))!.callback_data;
   const review=await editor.handle(button(group,'pr:1:H:'),'100');assert.ok(review);
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.mode,'MONITOR');
   const confirm=button(review,'pr:1:I:');assert.equal(await editor.handle(confirm,'300'),null);
   assert.ok(await editor.handle(confirm,'100'));assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.mode,'ENFORCE');
   assert.equal(await editor.handle(confirm,'100'),null);
  }finally{await f.close();}
 });
 test(engine+' policy revocation after reserving a mute intent cancels dispatch without retry',async()=>{
  const f=await fixture();try{
   await f.service.save('100',f.config('MUTE'),f.epoch,0);
   f.moderation.beforeDispatch=async()=>{await f.store.transaction(s=>{s.protectionPolicies![0]!.policy.mode='OFF';});};
   assert.equal(await f.observe(),'ENFORCEMENT_ATTEMPTED');assert.equal(f.gateway.calls.length,0);
   const s=await f.store.snapshot();assert.equal(s.moderationReasons.length,1);assert.equal(s.moderationOperations[0]!.status,'CANCELLED');
   assert.equal(s.moderationReasons[0]!.expiresAt,160000);
   assert.equal(await f.observe(),'DISABLED');assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' enforcement review expires and back/replacement/navigation invalidate its one-shot confirmation and queued proof',async()=>{
  const f=await fixture();try{
   await f.service.save('100',{...f.config(),mode:'MONITOR'},f.epoch,0);
   const editor=new TelegramProtectionEditor(f.store,f.policy,f.clock,f.port);
   const group=await editor.openOwnerGroup('100','-100',f.epoch);assert.ok(group);
   const find=(s:NonNullable<typeof group>,prefix:string)=>s.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix))!.callback_data;
   const start=find(group,'pr:1:H:');
   let review=await editor.handle(start,'100');assert.ok(review);let confirm=find(review,'pr:1:I:');
   await editor.handle(find(review,'pr:1:g:'),'100');assert.equal(await editor.handle(confirm,'100'),null);assert.equal(await editor.witness('100',review.keyboard),null);
   review=await editor.handle(start,'100');assert.ok(review);confirm=find(review,'pr:1:I:');
   await editor.handle(start,'100');assert.equal(await editor.handle(confirm,'100'),null);
   review=await editor.handle(start,'100');assert.ok(review);confirm=find(review,'pr:1:I:');f.time(220000);assert.equal(await editor.handle(confirm,'100'),null);f.time(100000);
   review=await editor.handle(start,'100');assert.ok(review);confirm=find(review,'pr:1:I:');await editor.cancelNavigation('100');assert.equal(await editor.handle(confirm,'100'),null);
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.mode,'MONITOR');
  }finally{await f.close();}
 });
 test(engine+' injected enforcement receives group text, media captions and edits through the real update application',async()=>{
  const f=await fixture();try{
   await f.service.save('100',f.config(),f.epoch,0);
   const education=new EducationService(f.store,f.policy,f.clock);
   const app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.clock),
    faq:new ApprovedAnswerService(f.store,f.policy,f.clock),links:new ResourceLinkService(f.store,f.policy,f.clock),clock:f.clock,
    botId:'enforcement',botUsername:'ManaratakBot',protectionEnforcer:f.port,membership:async()=>{throw Error('Unexpected network');}});
   const base={chat:{id:-100,type:'supergroup'},from:{id:300,is_bot:false}};
   await app.handle({update_id:1,message:{...base,message_id:1,text:'spam'}});
   await app.handle({update_id:2,message:{...base,message_id:2,caption:'spam',photo:[{file_id:'photo',file_unique_id:'unique',width:1,height:1}]}});
   await app.handle({update_id:3,edited_message:{...base,message_id:1,text:'spam',edit_date:100}});
   assert.equal((await f.store.snapshot()).warnings.length,3);assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
}
