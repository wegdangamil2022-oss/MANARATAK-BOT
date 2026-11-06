import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramGroupRules} from '../src/telegram-group-rules.js';
import {TelegramRuleExemptions} from '../src/telegram-rule-exemptions.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {ModerationCommandReview} from '../src/telegram-moderation-command-review.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {activeRuleExemptions,ruleExemptionDigest,type RuleExemption} from '../src/group-rule-exemption-model.js';
const NOW=1700000000000,CHAT='-100';
test('future, tampered or duplicated revocations do not remove a valid exemption',()=>{
 const entry:RuleExemption={id:'moderation:rule-exemption:abcdefghijklmnopqrstuvwx',chat:CHAT,member:'400',version:1,paragraph:1,until:NOW+60000,actor:'301',at:NOW,policyVersion:1};
 const grant={updateKey:entry.id,actorId:entry.actor,decision:'ALLOW',reason:'RULE_EXEMPTION:'+JSON.stringify({chat:entry.chat,member:entry.member,version:1,paragraph:1,until:entry.until}),policyVersion:1,at:NOW};
 const revoke={updateKey:entry.id+':revoked',actorId:'301',decision:'ALLOW',reason:'RULE_EXEMPTION_REVOKED:'+ruleExemptionDigest(entry),policyVersion:1,at:NOW+1000};
 const state=(audit:unknown[])=>({audit} as never);
 assert.equal(activeRuleExemptions(state([grant,revoke]),NOW).length,1);assert.equal(activeRuleExemptions(state([grant,revoke]),NOW+1000).length,0);
 assert.equal(activeRuleExemptions(state([grant,{...revoke,reason:'INVALID'}]),NOW+1000).length,1);assert.equal(activeRuleExemptions(state([grant,revoke,revoke]),NOW+1000).length,1);
});
for(const engine of ['json','sqlite'] as const){
 test(engine+' group-specific exemption help returns to the selected group and rejects stale context',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-exempt-context-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100',CHAT,['moderation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);
   const rules=new TelegramGroupRules(store,policy,()=>NOW),ui=new TelegramRuleExemptions(store,policy,()=>NOW),menu=await rules.handle('301','rl:1:h:0');assert.ok(menu);
   const selected=menu.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:g:'))!.callback_data,group=await rules.handle('301',selected);assert.ok(group);
   const help=group.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:h:'))!.callback_data,view=await ui.handle('301',help);assert.ok(view&&isValidTelegramInlineKeyboard(view.keyboard));assert.ok(view.keyboard.inline_keyboard.flat().some(b=>b.callback_data===selected));assert.equal(await ui.handle('100',help),null);
   const draft=await rules.preview('301','/setrules -100\nchanged');assert.ok(draft);assert.ok(await rules.handle('301',draft.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data));assert.equal(await ui.handle('301',help),null);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' group-specific exemption help rejects revoked group even when another remains authorized',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-exempt-context-grant-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);for(const chat of [CHAT,'-200']){await policy.approveChat('100',chat,['moderation']);await policy.grant('100','301','chat.manage',chat,NOW+600000);}
   const rules=new TelegramGroupRules(store,policy,()=>NOW),ui=new TelegramRuleExemptions(store,policy,()=>NOW),menu=await rules.handle('301','rl:1:h:0');assert.ok(menu);const groupButton=menu.keyboard.inline_keyboard.flat().find(b=>b.text.includes(CHAT));assert.ok(groupButton);const details=await rules.handle('301',groupButton.callback_data);assert.ok(details);const help=details.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:h:'))!.callback_data;assert.ok(await ui.handle('301',help));
   await store.transaction(s=>{const grant=s.grants.find(g=>g.chatId===CHAT&&g.actor==='301');assert.ok(grant);grant.revoked=true;});assert.equal(await ui.handle('301',help),null);assert.ok(await ui.handle('301','le:1:h'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' paragraph exemption is scoped, expires, and does not carry to a new rule version',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-exempt-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation','navigation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);
   const rules=new TelegramGroupRules(store,policy,()=>now),draft=await rules.preview('301','/setrules -100\nfirst\nsecond');assert.ok(draft);const publish=draft.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!;assert.ok(await rules.handle('301',publish.callback_data));
   const ui=new TelegramRuleExemptions(store,policy,()=>now),preview=await ui.preview('301','/exemptrule -100 400 1 60');assert.ok(preview);const confirm=preview.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:c:'))!;assert.equal(await ui.handle('100',confirm.callback_data),null);assert.ok(await ui.handle('301',confirm.callback_data));assert.equal(await ui.handle('301',confirm.callback_data),null);
   const reopened=new BotStore(join(dir,'state.'+engine),{engine}),service=new ModerationService(reopened,policy,new FakeModerationGateway(),()=>now);assert.equal((await service.issueWarning('301',CHAT,'400','law_v1_p1_m1')).status,'DENIED');now-=1000;assert.equal((await service.issueWarning('301',CHAT,'400','law_v1_p1_m6')).status,'DENIED');now=NOW;assert.equal((await service.issueWarning('301',CHAT,'400','law_v1_p2_m2')).status,'ADDED');assert.equal((await service.issueWarning('301',CHAT,'401','law_v1_p1_m3')).status,'ADDED');
   now+=60000;assert.equal((await service.issueWarning('301',CHAT,'400','law_v1_p1_m4')).status,'ADDED');
   const next=await rules.preview('301','/setrules -100\nchanged');assert.ok(next);assert.ok(await rules.handle('301',next.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data));assert.equal((await service.issueWarning('301',CHAT,'400','law_v2_p1_m5')).status,'ADDED');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' exemption confirmation rejects revoked manager, changed rules and explicit cancel',async()=>{
  for(const variant of ['revoked','changed','cancel'] as const){const dir=await mkdtemp(join(tmpdir(),'rule-exempt-stale-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100',CHAT,['moderation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);
   const rules=new TelegramGroupRules(store,policy,()=>NOW),publish=await rules.preview('301','/setrules -100\nfirst');assert.ok(publish);await rules.handle('301',publish.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data);
   const ui=new TelegramRuleExemptions(store,policy,()=>NOW),preview=await ui.preview('301','/exemptrule -100 400 1 60');assert.ok(preview);const confirm=preview.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:c:'))!.callback_data;
   if(variant==='revoked')await store.transaction(s=>{s.grants[0]!.revoked=true;});if(variant==='changed'){const next=await rules.preview('100','/setrules -100\nnew');assert.ok(next);await rules.handle('100',next.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data);}if(variant==='cancel')assert.ok(await ui.handle('301',preview.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:x:'))!.callback_data));
   assert.equal(await ui.handle('301',confirm),null);assert.equal((await store.snapshot()).audit.some(a=>a.updateKey.startsWith('moderation:rule-exemption:')),false);
  }finally{await rm(dir,{recursive:true,force:true});}}
 });
 test(engine+' authorized manager reviews active exemptions and explicitly revokes one without touching another',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-exempt-revoke-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100',CHAT,['moderation','navigation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);
   const rules=new TelegramGroupRules(store,policy,()=>NOW),draft=await rules.preview('301','/setrules -100\nfirst\nsecond');assert.ok(draft);await rules.handle('301',draft.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data);
   const ui=new TelegramRuleExemptions(store,policy,()=>NOW);for(const para of [1,2]){const p=await ui.preview('301','/exemptrule -100 400 '+para+' 60');assert.ok(p);assert.ok(await ui.handle('301',p.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:c:'))!.callback_data));}
   const home=await ui.handle('301','le:1:h');assert.ok(home);const listButton=home.keyboard.inline_keyboard.flat().find(b=>b.callback_data==='le:1:l:0');assert.ok(listButton);const list=await ui.handle('301',listButton.callback_data);assert.ok(list&&isValidTelegramInlineKeyboard(list.keyboard));const select=list.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:v:'))!;
   assert.equal(await ui.handle('300',select.callback_data),null);const preview=await ui.handle('301',select.callback_data);assert.ok(preview);assert.match(preview.text,/إلغاء الإعفاء/u);const confirm=preview.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:r:'))!;assert.ok(confirm);assert.equal(await ui.handle('100',confirm.callback_data),null);assert.ok(await ui.handle('301',confirm.callback_data));assert.equal(await ui.handle('301',confirm.callback_data),null);
   const service=new ModerationService(store,policy,new FakeModerationGateway(),()=>NOW);const selected=/الفقرة: ([12])/u.exec(preview.text);assert.ok(selected);const removed=Number(selected[1]),remaining=removed===1?2:1;assert.equal((await service.issueWarning('301',CHAT,'400','law_v1_p'+removed+'_m1')).status,'ADDED');assert.equal((await service.issueWarning('301',CHAT,'400','law_v1_p'+remaining+'_m2')).status,'DENIED');
   const reopened=new BotStore(join(dir,'state.'+engine),{engine});assert.equal((await new ModerationService(reopened,policy,new FakeModerationGateway(),()=>NOW).issueWarning('301',CHAT,'400','law_v1_p'+removed+'_m3')).status,'ADDED');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' revocation rejects changed authorization, expiry, cancellation and conflicting audit',async()=>{
  for(const variant of ['authority','expiry','cancel','conflict'] as const){const dir=await mkdtemp(join(tmpdir(),'rule-exempt-revoke-stale-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);
   const rules=new TelegramGroupRules(store,policy,()=>now),draft=await rules.preview('301','/setrules -100\nfirst');assert.ok(draft);await rules.handle('301',draft.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data);
   const ui=new TelegramRuleExemptions(store,policy,()=>now),grant=await ui.preview('301','/exemptrule -100 400 1 3600');assert.ok(grant);await ui.handle('301',grant.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:c:'))!.callback_data);
   const list=await ui.handle('301','le:1:l:0');assert.ok(list);const preview=await ui.handle('301',list.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:v:'))!.callback_data);assert.ok(preview);const confirm=preview.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:r:'))!.callback_data;
   if(variant==='authority')await store.transaction(s=>{s.grants[0]!.revoked=true;});if(variant==='expiry')now+=120000;if(variant==='cancel')assert.ok(await ui.handle('301',preview.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:z:'))!.callback_data));if(variant==='conflict')await store.transaction(s=>{const row=s.audit.find(a=>/^moderation:rule-exemption:[A-Za-z0-9_-]{24}$/u.test(a.updateKey))!;s.audit.push({updateKey:row.updateKey+':revoked',actorId:'301',decision:'ALLOW',reason:'INVALID',policyVersion:row.policyVersion,at:NOW});});
   assert.equal(await ui.handle('301',confirm),null);const ownerService=new ModerationService(store,policy,new FakeModerationGateway(),()=>now);assert.equal((await ownerService.issueWarning('100',CHAT,'400','law_v1_p1_m1')).status,'DENIED');
  }finally{await rm(dir,{recursive:true,force:true});}}
 });
 test(engine+' real buttons enforce private authority, navigation cancellation and stale warning review',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-exempt-ui-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation','navigation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);
   const rules=new TelegramGroupRules(store,policy,()=>now),draft=await rules.preview('301','/setrules -100\nfirst');assert.ok(draft);await rules.handle('301',draft.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data);
   const moderation=new ModerationService(store,policy,new FakeModerationGateway(),()=>now),review=new ModerationCommandReview(store,policy,moderation,()=>now),warning=await review.preview('301',CHAT,{kind:'warn',memberId:'400',reference:'law_v1_p1_m1'});assert.ok(warning);
   const education=new EducationService(store,policy,()=>now),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),moderation,membership:async()=> 'VERIFIED',clock:()=>now,botId:'rule-exemption',botUsername:'ManaratakBot'});
   const text=(id:number,value:string,actor=301)=>app.handle({update_id:id,message:{message_id:id,chat:{id:actor,type:'private'},from:{id:actor,is_bot:false},text:value}});
   const tap=(id:number,data:string,actor=301,group=false)=>app.handle({update_id:id,callback_query:{id:'le'+id,from:{id:actor,is_bot:false},data,message:{message_id:9,from:{id:999,is_bot:true},chat:group?{id:-100,type:'supergroup'}:{id:actor,type:'private'}}}});
   const menu=await text(1,'/grouprules'),select=menu.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:g:'))!.callback_data,details=await tap(2,select),help=details.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:h:'))!;assert.ok(help);const helpView=await tap(3,help.callback_data);assert.equal(helpView.status,'APPLIED');const back=helpView.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data===select);assert.ok(back);assert.match((await tap(23,back.callback_data)).plan!.text,/setrules/u);assert.equal((await tap(24,help.callback_data,300)).status,'DENIED');
   let preview=await text(4,'/exemptrule -100 400 1 60');assert.equal(preview.reason,'RULE_EXEMPTION_PREVIEW');assert.equal(isValidTelegramInlineKeyboard(preview.plan?.inlineMarkup),true);let confirm=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:c:'))!.callback_data;
   assert.equal((await tap(5,confirm,301,true)).status,'DENIED');assert.equal((await tap(6,confirm,300)).status,'DENIED');await text(7,'/grouprules');assert.equal((await tap(8,confirm)).status,'DENIED');let sent=0;const dispatcher=new TelegramReplyDispatcher(store,policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:50};}},()=>now);assert.equal((await dispatcher.dispatch(preview.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,0);
   preview=await text(9,'/exemptrule -100 400 1 60');confirm=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:c:'))!.callback_data;assert.equal((await tap(10,confirm)).status,'APPLIED');assert.equal(await review.handle('301',warning.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:c:'))!.callback_data),null);assert.equal((await store.snapshot()).warnings.length,0);
   const opened=await tap(14,'le:1:l:0');assert.equal(opened.status,'APPLIED');let selected=opened.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:v:'))!.callback_data;let remove=await tap(15,selected);assert.equal(remove.status,'APPLIED');let revoke=remove.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:r:'))!.callback_data;assert.equal((await tap(16,revoke,301,true)).status,'DENIED');await text(17,'/grouprules');assert.equal((await tap(18,revoke)).status,'DENIED');
   const reopened=await tap(19,'le:1:l:0');selected=reopened.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:v:'))!.callback_data;remove=await tap(20,selected);revoke=remove.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:r:'))!.callback_data;assert.equal((await tap(21,revoke)).status,'APPLIED');assert.equal((await tap(22,revoke)).status,'DENIED');assert.equal((await moderation.issueWarning('301',CHAT,'400','law_v1_p1_m7')).status,'ADDED');
   const denied=await text(11,'/exemptrule -100 400 2 60');assert.equal(denied.status,'DENIED');const expiring=await text(12,'/exemptrule -100 400 1 60');const stale=expiring.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('le:1:c:'))!.callback_data;now+=120000;assert.equal((await tap(13,stale)).status,'DENIED');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
