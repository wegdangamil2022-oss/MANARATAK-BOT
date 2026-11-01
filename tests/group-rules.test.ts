import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {ModerationCommandReview} from '../src/telegram-moderation-command-review.js';
import {groupRuleDescription} from '../src/telegram-group-rules.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramGroupRules,validGroupRulesRoute} from '../src/telegram-group-rules.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {protectionUIEpoch} from '../src/protection-ui-access.js';
import {groupMenuEpochDigest} from '../src/telegram-group-access.js';
const NOW=1700000000000,CHAT='-100';
const route=(s:OwnerInlineScreen|null,p:string)=>{assert.ok(s&&isValidTelegramInlineKeyboard(s.keyboard));const b=s.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('group rules reject malformed selectors',()=>{for(const bad of ['rl:1:h:00','rl:1:h:0\n','rl:1:g:0:0:aaaaaaaaaaaaaaaa','rl:1:c:short'])assert.equal(validGroupRulesRoute(bad),false);});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'group-rules-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=NOW;const policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation','navigation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);return {store,file,policy,ui:new TelegramGroupRules(store,policy,()=>now),time:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' numbered versions require confirmation, survive restart, escape HTML and invalidate queued old views',async()=>{
  const f=await fixture();try{
   const preview=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء\nلا <إعلان>');assert.ok(preview);assert.equal(await f.ui.published(CHAT),null);const confirm=route(preview,'rl:1:c:');assert.equal(await f.ui.handle('100',confirm),null);
   const before=groupMenuEpochDigest(await f.store.snapshot(),CHAT),result=await f.ui.handle('301',confirm);assert.ok(result?.access);assert.equal(result.access.epoch,protectionUIEpoch(await f.store.snapshot(),f.policy,'301',NOW));assert.equal(await f.ui.handle('301',confirm),null);
   const first=await f.ui.published(CHAT);assert.match(first!,/1\. احترام/u);assert.match(first!,/&lt;إعلان&gt;/u);assert.notEqual(groupMenuEpochDigest(await f.store.snapshot(),CHAT),before);
   const reopened=new TelegramGroupRules(new BotStore(f.file,{engine}),f.policy,()=>NOW);assert.equal(await reopened.published(CHAT),first);
   const next=await reopened.preview('301','/setrules -100\nنص جديد');await reopened.handle('301',route(next,'rl:1:c:'));assert.match((await reopened.published(CHAT))!,/الإصدار 2/u);
   const published=(await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('GROUP_RULES_PUBLISHED:'));assert.equal(published.length,2);assert.ok(published[0]!.reason.includes(Buffer.from(JSON.stringify({chat:CHAT,version:1,lines:['احترام الأعضاء','لا <إعلان>']})).toString('base64url')));
  }finally{await f.close();}
 });
 test(engine+' rules reject revoked rights, stale concurrent drafts, expired approval and cancelled navigation',async()=>{
  for(const reason of ['grant','concurrent','expiry','cancel','scope'] as const){const f=await fixture();try{
   const draft=await f.ui.preview('301','/setrules -100\nفقرة');const confirm=route(draft,'rl:1:c:');
   if(reason==='grant')await f.store.transaction(s=>{s.grants[0]!.revoked=true;});
   if(reason==='scope')await f.store.transaction(s=>{s.chats[0]!.version++;});
   if(reason==='expiry')f.time(NOW+120000);
   if(reason==='cancel')await f.ui.cancel('301');
   if(reason==='concurrent'){const second=await f.ui.preview('100','/setrules -100\nبديل');assert.ok(await f.ui.handle('100',route(second,'rl:1:c:')));}
   assert.equal(await f.ui.handle('301',confirm),null);assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('GROUP_RULES_PUBLISHED:')).length,reason==='concurrent'?1:0);
  }finally{await f.close();}}
 });
 test(engine+' transport cancels navigated previews and dispatches only the still-current published version',async()=>{
  const f=await fixture();try{
   const education=new EducationService(f.store,f.policy,()=>NOW),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,()=>NOW),faq:new ApprovedAnswerService(f.store,f.policy,()=>NOW),links:new ResourceLinkService(f.store,f.policy,()=>NOW),moderation:new ModerationService(f.store,f.policy,new FakeModerationGateway(),()=>NOW),moderationCommandMode:'direct',clock:()=>NOW,botId:'rules',botUsername:'ManaratakBot',ownerMenuMode:'inline',studentMenuMode:'inline',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
   const privateText=(id:number,text:string)=>app.handle({update_id:id,message:{message_id:id,chat:{id:301,type:'private'},from:{id:301,is_bot:false},text}});
   const preview=await privateText(1,'/setrules -100\nفقرة أولى');assert.ok(preview.plan);const confirm=preview.plan.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data;
   await privateText(2,'/grouprules');const stale=await app.handle({update_id:3,callback_query:{id:'rules-stale',from:{id:301,is_bot:false},data:confirm,message:{message_id:9,from:{id:999,is_bot:true},chat:{id:301,type:'private'}}}});assert.equal(stale.status,'DENIED');
   const draft=await f.ui.preview('301','/setrules -100\nفقرة منشورة');await f.ui.handle('301',route(draft,'rl:1:c:'));
   const group=()=>app.handle({update_id:4,message:{message_id:10,chat:{id:-100,type:'supergroup'},from:{id:300,is_bot:false},text:'/rules'}});const plan=await group();assert.equal(plan.reason,'GROUP_RULES_VIEW');assert.ok(plan.plan);
   const next=await f.ui.preview('301','/setrules -100\nفقرة معدلة');await f.ui.handle('301',route(next,'rl:1:c:'));let calls=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{calls++;return {status:'CONFIRMED',messageId:91};}},()=>NOW);assert.equal((await dispatcher.dispatch(plan.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(calls,0);
   const fresh=await app.handle({update_id:5,message:{message_id:11,chat:{id:-100,type:'supergroup'},from:{id:300,is_bot:false},text:'/rules'}});assert.equal((await dispatcher.dispatch(fresh.deliveryKey!)).status,'CONFIRMED');assert.equal(calls,1);
   const warning=await app.handle({update_id:6,message:{message_id:100,chat:{id:-100,type:'supergroup'},from:{id:301,is_bot:false},text:'/warnrule 1',reply_to_message:{message_id:42,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}}}});assert.equal(warning.reason,'MODERATION_PREVIEW_ONLY');assert.equal(warning.plan!.chatId,'301');assert.match(warning.plan!.text,/فقرة معدلة/u);assert.equal((await f.store.snapshot()).warnings.length,0);
   const approve=warning.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:c:'))!.callback_data;const confirmed=await app.handle({update_id:7,callback_query:{id:'rule-warning',from:{id:301,is_bot:false},data:approve,message:{message_id:9,from:{id:999,is_bot:true},chat:{id:301,type:'private'}}}});assert.equal(confirmed.status,'APPLIED');assert.equal((await f.store.snapshot()).warnings[0]!.reference,'law_v2_p1_m42');
  }finally{await f.close();}
 });
 test(engine+' warnings bind one message to the approved paragraph version and preserve old explanations after edits',async()=>{
  const f=await fixture();try{
   const draft=await f.ui.preview('301','/setrules -100\nلا إعلان <مدفوع>');await f.ui.handle('301',route(draft,'rl:1:c:'));
   const service=new ModerationService(f.store,f.policy,new FakeModerationGateway(),()=>NOW),review=new ModerationCommandReview(f.store,f.policy,service,()=>NOW);
   const reference=await f.ui.warningReference(CHAT,1,42);assert.equal(reference,'law_v1_p1_m42');assert.equal(await f.ui.warningReference(CHAT,2,42),null);
   const command={kind:'warn' as const,reference:reference!,memberId:'400'},preview=await review.preview('301',CHAT,command);assert.ok(preview);assert.match(preview.text,/&lt;مدفوع&gt;/u);assert.equal((await f.store.snapshot()).warnings.length,0);
   await review.handle('301',route(preview,'mc:1:c:'));assert.equal((await f.store.snapshot()).warnings[0]!.reference,reference);
   const secondPreview=await review.preview('301',CHAT,{...command,reference:'law_v1_p1_m43'});assert.ok(secondPreview);
   const next=await f.ui.preview('301','/setrules -100\nقانون جديد');await f.ui.handle('301',route(next,'rl:1:c:'));
   assert.equal(await review.handle('301',route(secondPreview,'mc:1:c:')),null);assert.equal(await review.preview('301',CHAT,{...command,reference:'law_v1_p1_m44'}),null);
   assert.match(groupRuleDescription(await f.store.snapshot(),CHAT,reference!)!,/لا إعلان/u);assert.equal((await f.store.snapshot()).warnings.length,1);
   const remove=await review.preview('301',CHAT,{...command,kind:'unwarn'});assert.ok(remove);await review.handle('301',route(remove,'mc:1:c:'));assert.equal((await f.store.snapshot()).warnings[0]!.active,false);
  }finally{await f.close();}
 });
 test(engine+' rules private picker and input bounds preserve usable return buttons',async()=>{
  const f=await fixture();try{
   const home=await f.ui.handle('100','mi:1:i:02:11'),detail=await f.ui.handle('100',route(home,'rl:1:g:'));assert.match(detail!.text,/setrules/u);assert.ok(await f.ui.handle('100',route(detail,'rl:1:h:')));assert.equal(await f.ui.handle('300','mi:1:i:02:11'),null);
   for(const text of ['/setrules -100\n','/setrules -100\n فقرة','/setrules -100\nنفس\nنفس','/setrules -100\n'+'ع'.repeat(121),'/setrules -100\n'+Array.from({length:21},(_,i)=>'فقرة '+i).join('\n')])assert.equal(await f.ui.preview('301',text),null);
  }finally{await f.close();}
 });
}
