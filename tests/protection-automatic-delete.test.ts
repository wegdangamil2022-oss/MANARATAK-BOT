import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type RollingMessageMeta} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {ModerationPurgeService,FakePurgeGateway} from '../src/moderation-purge.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {moderationProtectionEnforcer} from '../src/protection-enforcement.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import type {ProtectionPolicy} from '../src/protection-rules.js';
const NOW=1700000000000;
const config:ProtectionPolicy={chatId:'-100',revision:1,mode:'ENFORCE',rules:[{id:'spam',kind:'WORD',value:'spam',enabled:true,action:'DELETE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'auto-delete-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=NOW;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);const gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>now),purgeGateway=new FakePurgeGateway(),purge=new ModerationPurgeService(store,policy,purgeGateway,()=>now),port=moderationProtectionEnforcer(moderation,undefined,{store,purge}),service=new GroupProtectionPolicyService(store,policy,()=>now,port);
  const meta:RollingMessageMeta={chatId:'-100',messageId:10,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false};
  const observe=(id=1,delivery:{messageId:number;sentAt:number}|undefined={messageId:10,sentAt:NOW-1000})=>service.observeIncomingText('300','-100','spam PRIVATE_BODY',[],'b3-webhook:delete:'+id,true,delivery);
  return {store,file,policy,moderation,gateway,purgeGateway,purge,port,service,meta,observe,time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' automatic deletion claims one exact trusted observed message and never interprets acknowledgement as physical proof',async()=>{const f=await fixture();try{
  await f.purge.observe(f.meta);await f.service.save('100',config,1,0);assert.equal(await f.observe(),'ENFORCEMENT_ATTEMPTED');assert.equal(f.purgeGateway.calls.length,1);assert.equal(f.purgeGateway.calls[0]!.messageId,10);
  assert.equal(await f.observe(),'DUPLICATE');let s=await f.store.snapshot();assert.equal(s.warnings.length,0);assert.equal(s.moderationReasons.length,0);assert.equal(s.purgeJobs[0]!.items[0]!.status,'ACKNOWLEDGED');assert.equal(JSON.stringify(s).includes('PRIVATE_BODY'),false);assert.ok(s.audit.some(a=>a.reason==='PROTECTION_ENFORCEMENT_RESULT:ACKNOWLEDGED'));
  const restarted=new GroupProtectionPolicyService(new BotStore(f.file,{engine}),f.policy,()=>NOW,f.port);assert.equal(await restarted.observeIncomingText('300','-100','spam',[],'b3-webhook:delete:1',true,{messageId:10,sentAt:NOW-1000}),'DUPLICATE');
 }finally{await f.close();}});
 test(engine+' automatic deletion refuses missing context, identity mismatch, protected rows and protected Telegram targets',async()=>{
  for(const variant of ['missing','date','member','pinned','linkedChannel','adminLog','approvedAnnouncement','protected'] as const){const f=await fixture();try{
   let meta={...f.meta};if(variant==='date')meta.sentAt--;else if(variant==='member')meta.senderId='301';else if(['pinned','linkedChannel','adminLog','approvedAnnouncement'].includes(variant))meta={...meta,[variant]:true};if(variant==='protected')f.gateway.protectedMembers.add('-100:300');
   if(variant!=='missing')await f.purge.observe(meta);await f.service.save('100',config,1,0);await f.observe();assert.equal(f.purgeGateway.calls.length,0);
   assert.equal((await f.store.snapshot()).purgeJobs.length,0);
  }finally{await f.close();}}
 });
 test(engine+' changed policy or metadata before sending blocks deletion, and unknown results are never redelivered',async()=>{
  for(const variant of ['policy','metadata','unknown'] as const){const f=await fixture();try{
   await f.purge.observe(f.meta);await f.service.save('100',config,1,0);
   if(variant==='unknown')f.purgeGateway.throwAfterDelete=true;else f.purgeGateway.canDelete=async()=>{await f.store.transaction(s=>{if(variant==='policy')s.protectionPolicies![0]!.policy.mode='OFF';else s.rollingMessageMeta[0]!.pinned=true;});return true;};
   await f.observe();assert.equal(f.purgeGateway.calls.length,variant==='unknown'?1:0);assert.equal(await f.observe(),variant==='policy'?'DISABLED':'DUPLICATE');assert.equal(f.purgeGateway.calls.length,variant==='unknown'?1:0);
   if(variant==='unknown')assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'UNKNOWN_OUTCOME');
  }finally{await f.close();}}
 });
 test(engine+' automatic purge marker survives restart and refuses the general worker after a confirmed 429',async()=>{const f=await fixture();try{
  await f.purge.observe(f.meta);await f.service.save('100',config,1,0);f.purgeGateway.outcome={status:'RATE_LIMITED',retryAfterMs:1000};await f.observe();
  const job=(await f.store.snapshot()).purgeJobs[0]!;assert.equal(job.automatic,true);assert.equal(f.purgeGateway.calls.length,1);f.time(NOW+2000);
  const reopened=new ModerationPurgeService(new BotStore(f.file,{engine}),f.policy,f.purgeGateway,()=>NOW+2000);assert.equal((await reopened.dispatchNext(job.id)).status,'BLOCKED');assert.equal(f.purgeGateway.calls.length,1);
 }finally{await f.close();}});
 test(engine+' actual text and media transport pass only the original message identity; missing date cannot delete',async()=>{const f=await fixture();try{
  const education=new EducationService(f.store,f.policy),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education),faq:new ApprovedAnswerService(f.store,f.policy),links:new ResourceLinkService(f.store,f.policy),moderation:f.moderation,purge:f.purge,protectionEnforcer:f.port,botId:'delete',botUsername:'ManaratakBot',clock:()=>NOW,membership:async()=>{throw Error('No network');}});
  await f.service.save('100',config,1,0);await f.purge.observe(f.meta);
  const message={message_id:10,date:(NOW-1000)/1000,chat:{id:-100,type:'supergroup'},from:{id:300,is_bot:false},text:'spam'};
  await app.handle({update_id:10,message:{...message,date:undefined}});assert.equal(f.purgeGateway.calls.length,0);
  await app.handle({update_id:11,message});assert.equal(f.purgeGateway.calls.length,1);
  await f.purge.observe({...f.meta,messageId:12,contentType:'MEDIA'});const {text:ignored,...mediaMessage}=message;await app.handle({update_id:12,message:{...mediaMessage,message_id:12,photo:[{file_id:'photo',width:1,height:1}],caption:'spam'}});assert.equal(f.purgeGateway.calls.length,2);
 }finally{await f.close();}});
}
