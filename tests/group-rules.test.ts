import {parseReplyModerationCommand} from '../src/telegram-moderation-commands.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {ModerationCommandReview} from '../src/telegram-moderation-command-review.js';
import {groupRuleDescription} from '../src/telegram-group-rules.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher,TelegramBotApiTextSender} from '../src/telegram-replies.js';
import {groupRulesMarkup,validGroupRulesMarkup} from '../src/telegram-group-rules-markup.js';
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
import {TelegramRuleExemptions} from '../src/telegram-rule-exemptions.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {protectionUIEpoch} from '../src/protection-ui-access.js';
import {groupMenuEpochDigest} from '../src/telegram-group-access.js';
import {TelegramModerationAppeals} from '../src/telegram-moderation-appeals.js';
const NOW=1700000000000,CHAT='-100';
const route=(s:OwnerInlineScreen|null,p:string)=>{assert.ok(s&&isValidTelegramInlineKeyboard(s.keyboard));const b=s.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('group rules reject malformed selectors',()=>{const reply={message_id:42,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}};assert.equal(parseReplyModerationCommand('/warn law_v1_p1_m41','ManaratakBot','-100',100,reply).status,'INVALID');assert.equal(parseReplyModerationCommand('/warn law_v1_p1_m42','ManaratakBot','-100',100,reply).status,'COMMAND');for(const bad of ['rl:1:h:00','rl:1:h:0\n','rl:1:g:0:0:aaaaaaaaaaaaaaaa','rl:1:c:short'])assert.equal(validGroupRulesRoute(bad),false);});
test('rules buttons serialize as bounded bot links and reject altered destinations',async()=>{
 let calls=0;const markup=groupRulesMarkup('ManaratakBot'),request=(async(_url:unknown,init:RequestInit)=>{calls++;const body=JSON.parse(String(init.body));assert.deepEqual(body.reply_markup,markup);return Response.json({ok:true,result:{chat:{id:-100},message_id:20}});}) as typeof fetch;
 const sender=new TelegramBotApiTextSender('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request),plan={chatId:'-100',parseMode:'HTML' as const,text:'rules',groupRulesMarkup:markup};
 assert.equal(validGroupRulesMarkup(markup),true);assert.equal((await sender.send(plan)).status,'CONFIRMED');assert.equal(calls,1);
 const tampered=structuredClone(markup);tampered.inline_keyboard[1][0].url='https://t.me/OtherBot?start=reports';assert.equal(validGroupRulesMarkup(tampered),false);assert.equal((await sender.send({...plan,groupRulesMarkup:tampered})).status,'FAILED_CONFIRMED');assert.equal(calls,1);
 assert.equal((await sender.send({...plan,chatId:'300'})).status,'FAILED_CONFIRMED');assert.equal(calls,1);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'group-rules-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=NOW;const policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation','navigation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);return {store,file,policy,ui:new TelegramGroupRules(store,policy,()=>now),time:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' Arabic paragraph warning shows the verified executor and a private authorized historical law link',async()=>{
  const f=await fixture();try{
   const published=await f.ui.preview('301','/setrules -100\nاحترام <الأعضاء>');await f.ui.handle('301',route(published,'rl:1:c:'));
   const education=new EducationService(f.store,f.policy,()=>NOW),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,()=>NOW),faq:new ApprovedAnswerService(f.store,f.policy,()=>NOW),links:new ResourceLinkService(f.store,f.policy,()=>NOW),moderation:new ModerationService(f.store,f.policy,new FakeModerationGateway(),()=>NOW),moderationCommandMode:'direct',clock:()=>NOW,botId:'law-warning',botUsername:'ManaratakBot',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
   const warning=await app.handle({update_id:1,message:{message_id:100,chat:{id:-100,type:'supergroup'},from:{id:301,is_bot:false,first_name:'<Admin>',last_name:'& Owner'},text:'إنذار 1',reply_to_message:{message_id:42,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}}}});
   assert.equal(warning.reason,'MODERATION_PREVIEW_ONLY');assert.equal(warning.plan?.chatId,'301');assert.match(warning.plan!.text,/&lt;Admin&gt; &amp; Owner/u);assert.match(warning.plan!.text,/tg:\/\/user\?id=301/u);assert.match(warning.plan!.text,/https:\/\/t.me\/ManaratakBot\?start=law_100_1/u);assert.equal((await f.store.snapshot()).warnings.length,0);
   let sends=0;const fake=(async(_url:unknown,init:RequestInit)=>{sends++;const body=JSON.parse(String(init.body));assert.equal(body.chat_id,'301');assert.equal(body.text,warning.plan!.text);assert.equal(body.parse_mode,'HTML');return Response.json({ok:true,result:{chat:{id:301},from:{id:123456789,is_bot:true},message_id:20}});}) as typeof fetch;
   const sender=new TelegramBotApiTextSender('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',fake);assert.equal((await sender.send(warning.plan!)).status,'CONFIRMED');assert.equal(sends,1);
   const open=(id:number,actor:number,text='/start law_100_1')=>app.handle({update_id:id,message:{message_id:id,chat:{id:actor,type:'private'},from:{id:actor,is_bot:false},text}});
   const confirm=warning.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:c:'))!.callback_data;
   assert.equal((await open(2,301)).reason,'GROUP_RULES_HISTORY_VIEW');assert.equal((await app.handle({update_id:3,callback_query:{id:'law-after-link',from:{id:301,is_bot:false},data:confirm,message:{message_id:9,from:{id:999,is_bot:true},chat:{id:301,type:'private'}}}})).status,'DENIED');assert.equal((await f.store.snapshot()).warnings.length,0);
   const next=await f.ui.preview('301','/setrules -100\nقانون جديد');await f.ui.handle('301',route(next,'rl:1:c:'));
   assert.equal((await open(4,400)).status,'DENIED');const history=await open(5,301);assert.equal(history.reason,'GROUP_RULES_HISTORY_VIEW');assert.match(history.plan!.text,/احترام &lt;الأعضاء&gt;/u);assert.doesNotMatch(history.plan!.text,/قانون جديد/u);assert.ok(history.plan!.inlineMarkup!.inline_keyboard.flat().some(b=>b.callback_data.startsWith('rl:1:h:')));
   await f.store.transaction(s=>{s.grants[0]!.revoked=true;});assert.equal((await open(6,301)).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' Arabic law warning requires a direct human reply and a private one-shot confirmation',async()=>{
  const f=await fixture();try{
   const published=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء');await f.ui.handle('301',route(published,'rl:1:c:'));
   const education=new EducationService(f.store,f.policy,()=>NOW),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,()=>NOW),faq:new ApprovedAnswerService(f.store,f.policy,()=>NOW),links:new ResourceLinkService(f.store,f.policy,()=>NOW),moderation:new ModerationService(f.store,f.policy,new FakeModerationGateway(),()=>NOW),moderationCommandMode:'direct',clock:()=>NOW,botId:'law-alias',botUsername:'ManaratakBot',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
   const input=(id:number,text:string,reply?:unknown)=>app.handle({update_id:id,message:{message_id:100+id,chat:{id:-100,type:'supergroup'},from:{id:301,is_bot:false},text,...(reply?{reply_to_message:reply}:{})}}),reply={message_id:42,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}};
   assert.equal((await input(1,'إنذار 1')).status,'DENIED');assert.equal((await input(2,'إنذار 1',{...reply,forward_origin:{type:'hidden_user'}})).status,'DENIED');assert.equal((await input(3,'إنذار 01',reply)).status,'DENIED');assert.equal((await f.store.snapshot()).warnings.length,0);
   const preview=await input(4,'إنذار 1',reply);assert.equal(preview.reason,'MODERATION_PREVIEW_ONLY');const confirm=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:c:'))!.callback_data;
   const tap=(id:number,actor:number,group=false)=>app.handle({update_id:id,callback_query:{id:'law-confirm-'+id,from:{id:actor,is_bot:false},data:confirm,message:{message_id:9,from:{id:999,is_bot:true},chat:group?{id:-100,type:'supergroup'}:{id:actor,type:'private'}}}});
   assert.equal((await tap(5,301,true)).status,'DENIED');assert.equal((await tap(6,302)).status,'DENIED');assert.equal((await f.store.snapshot()).warnings.length,0);
   assert.equal((await tap(7,301)).status,'APPLIED');assert.equal((await tap(8,301)).status,'DENIED');const saved=await f.store.snapshot();assert.equal(saved.warnings.length,1);assert.equal(saved.warnings[0]!.reference,'law_v1_p1_m42');assert.equal(saved.warnings[0]!.actorId,'301');
  }finally{await f.close();}
 });
 test(engine+' optional rule translations require review, align paragraph numbers and preserve original history',async()=>{
  const f=await fixture();try{
   const initial=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء\nمنع الإساءة');await f.ui.handle('301',route(initial,'rl:1:c:'));
   for(const input of ['/translaterules -100 en\nRespect members','/translaterules -100 EN\nRespect members\nNo abuse','/translaterules -100 __proto__\nRespect members\nNo abuse'])assert.equal(await f.ui.preview('301',input),null);
   const translated=await f.ui.preview('301','/translaterules -100 en\nRespect <members>\nNo abuse');assert.ok(translated);assert.match(translated.text,/Respect &lt;members&gt;/u);
   assert.equal(await f.ui.handle('302',route(translated,'rl:1:c:')),null);await f.ui.handle('301',route(translated,'rl:1:c:'));
   assert.match((await f.ui.publishedView(CHAT,undefined,'en'))!.text,/Respect &lt;members&gt;/u);assert.match((await f.ui.published(CHAT))!,/احترام الأعضاء/u);assert.equal(await f.ui.publishedView(CHAT,undefined,'fr'),null);
   const original=groupRuleDescription(await f.store.snapshot(),CHAT,'law_v1_p1_m42');assert.match(original!,/احترام الأعضاء/u);
   const off=await f.ui.preview('301','/disablerule -100 1');await f.ui.handle('301',route(off,'rl:1:c:'));assert.match((await f.ui.publishedView(CHAT,undefined,'en'))!.text,/معطلة.*Respect/u);
   const edit=await f.ui.preview('301','/setrules -100\nنص معدل');await f.ui.handle('301',route(edit,'rl:1:c:'));assert.equal(await f.ui.publishedView(CHAT,undefined,'en'),null);assert.equal(groupRuleDescription(await f.store.snapshot(),CHAT,'law_v1_p1_m42'),original);
  }finally{await f.close();}
 });
 test(engine+' translations enforce capacity, removal review and stale-authority checks',async()=>{
  const f=await fixture();try{
   const initial=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء');await f.ui.handle('301',route(initial,'rl:1:c:'));
   for(const language of ['en','fr','zh-CN']){const p=await f.ui.preview('301','/translaterules -100 '+language+'\nText '+language);await f.ui.handle('301',route(p,'rl:1:c:'));}
   assert.equal(await f.ui.preview('301','/translaterules -100 es\nText es'),null);
   const cancel=await f.ui.preview('301','/removerulelang -100 en');await f.ui.handle('301',route(cancel,'rl:1:x:'));assert.ok(await f.ui.publishedView(CHAT,undefined,'en'));
   const remove=await f.ui.preview('301','/removerulelang -100 en');await f.ui.handle('301',route(remove,'rl:1:c:'));assert.equal(await f.ui.publishedView(CHAT,undefined,'en'),null);
   const stale=await f.ui.preview('301','/translaterules -100 es\nText es');await f.store.transaction(s=>{s.grants[0]!.revoked=true;});assert.equal(await f.ui.handle('301',route(stale,'rl:1:c:')),null);assert.equal(await f.ui.publishedView(CHAT,undefined,'es'),null);
   await f.store.transaction(s=>{const a=s.audit.filter(a=>a.reason.startsWith('GROUP_RULES_PUBLISHED:')).at(-1)!;const value=JSON.parse(Buffer.from(a.reason.slice('GROUP_RULES_PUBLISHED:'.length),'base64url').toString('utf8'));value.translations.fr=[];a.reason='GROUP_RULES_PUBLISHED:'+Buffer.from(JSON.stringify(value)).toString('base64url');});
   assert.equal(await f.ui.published(CHAT),null);assert.equal(await f.ui.warningReference(CHAT,1,42),null);assert.ok(groupRuleDescription(await f.store.snapshot(),CHAT,'law_v1_p1_m42'));
  }finally{await f.close();}
 });
 test(engine+' full sized rules and language instructions fit Telegram message limits',async()=>{
  const f=await fixture();try{
   const paragraphs=Array.from({length:20},(_,i)=>String(i).padStart(2,'0')+'x'.repeat(117));
   const p=await f.ui.preview('301','/setrules -100\n'+paragraphs.join('\n'));assert.ok(p);assert.ok(p.text.length<=4096);await f.ui.handle('301',route(p,'rl:1:c:'));
   const home=await f.ui.handle('301','rl:1:h:0'),detail=await f.ui.handle('301',route(home,'rl:1:g:'));assert.ok(detail);assert.ok(detail.text.length<=4096,String(detail.text.length));assert.match(detail.text,/translaterules/u);assert.ok((await f.ui.published(CHAT))!.includes(paragraphs[19]!));
  }finally{await f.close();}
 });
 test(engine+' disabling a paragraph publishes a reviewed version and preserves historical violations',async()=>{
  const f=await fixture();try{
   const draft=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء\nمنع الإساءة');await f.ui.handle('301',route(draft,'rl:1:c:'));
   const disabled=await f.ui.preview('301','/disablerule -100 1');assert.ok(disabled);assert.equal(await f.ui.warningReference(CHAT,1,42),'law_v1_p1_m42');
   assert.equal(await f.ui.handle('302',route(disabled,'rl:1:c:')),null);
   await f.ui.handle('301',route(disabled,'rl:1:c:'));assert.equal(await f.ui.handle('301',route(disabled,'rl:1:c:')),null);
   assert.equal(await f.ui.warningReference(CHAT,1,42),null);assert.equal(await f.ui.warningReference(CHAT,2,42),'law_v2_p2_m42');
   const snapshot=await f.store.snapshot();assert.match(groupRuleDescription(snapshot,CHAT,'law_v1_p1_m42')!,/احترام الأعضاء/u);assert.equal(groupRuleDescription(snapshot,CHAT,'law_v2_p1_m42',true),null);
   assert.match((await f.ui.published(CHAT))!,/معطلة/u);
   const service=new ModerationService(f.store,f.policy,new FakeModerationGateway(),()=>NOW);
   assert.equal(await service.issueRuleNotice('301',CHAT,'400','law_v2_p1_m42'),'DENIED');
   assert.equal((await service.addManualReason('301',CHAT,'400','law_v2_p1_m42','MUTE',undefined,300)).status,'DENIED');
   const enabled=await f.ui.preview('301','/enablerule -100 1');assert.ok(enabled);await f.ui.handle('301',route(enabled,'rl:1:x:'));assert.equal(await f.ui.warningReference(CHAT,1,42),null);
   const next=await f.ui.preview('301','/enablerule -100 1');await f.ui.handle('301',route(next,'rl:1:c:'));assert.equal(await f.ui.warningReference(CHAT,1,42),'law_v3_p1_m42');
  }finally{await f.close();}
 });
 test(engine+' paragraph status rejects stale grants, changed versions, malformed history and invalid numbers',async()=>{
  for(const variant of ['grant','version','expiry','corrupt'] as const){const f=await fixture();try{
   const published=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء');await f.ui.handle('301',route(published,'rl:1:c:'));
   for(const command of ['/disablerule -100 0','/disablerule -100 2','/disablerule -100 01','/enablerule -100 1'])assert.equal(await f.ui.preview('301',command),null);
   const pending=await f.ui.preview('301','/disablerule -100 1');assert.ok(pending);
   if(variant==='grant')await f.store.transaction(s=>{s.grants[0]!.revoked=true;});
   if(variant==='version'){const next=await f.ui.preview('100','/setrules -100\nنص أحدث');await f.ui.handle('100',route(next,'rl:1:c:'));}
   if(variant==='expiry')f.time(NOW+120000);
   if(variant==='corrupt')await f.store.transaction(s=>{const a=s.audit.find(a=>a.reason.startsWith('GROUP_RULES_PUBLISHED:'))!;s.audit.push({...a,updateKey:'moderation:rules:published:-100:2',reason:'GROUP_RULES_PUBLISHED:'+Buffer.from(JSON.stringify({chat:CHAT,version:2,lines:['احترام الأعضاء'],disabled:[1,1]})).toString('base64url')});});
   assert.equal(await f.ui.handle('301',route(pending,'rl:1:c:')),null);
   if(variant==='corrupt'){assert.equal(await f.ui.warningReference(CHAT,1,42),null);assert.equal(await f.ui.published(CHAT),null);assert.equal(groupRuleDescription(await f.store.snapshot(),CHAT,'law_v1_p1_m42',true),null);assert.ok(groupRuleDescription(await f.store.snapshot(),CHAT,'law_v1_p1_m42'));}
  }finally{await f.close();}}
 });
 test(engine+' timed paragraph mutes use private confirmation, exact law version and immutable case references',async()=>{
  const f=await fixture();try{
   const draft=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء');await f.ui.handle('301',route(draft,'rl:1:c:'));
   const gateway=new FakeModerationGateway(),service=new ModerationService(f.store,f.policy,gateway,()=>NOW),review=new ModerationCommandReview(f.store,f.policy,service,()=>NOW);
   const view=await review.preview('301',CHAT,{kind:'mute',memberId:'400',reference:'law_v1_p1_m42',durationSeconds:300});assert.ok(view);assert.match(view.text,/احترام الأعضاء/u);assert.equal(gateway.calls.length,0);
   assert.equal((await review.handle('301',route(view,'mc:1:c:')))?.status,'APPLIED');assert.equal(gateway.calls.length,1);
   const home=await f.ui.handle('301','rl:1:h:0'),detail=await f.ui.handle('301',route(home,'rl:1:g:')),report=await f.ui.handle('301',route(detail,'rl:1:r:'));assert.ok(report);assert.match(report.text,/قيود فقرات بمحاكاة محلية: 1/u);assert.match(report.text,/قيود فقرات مؤكدة من Telegram: 0/u);
   const reason=(await f.store.snapshot()).moderationReasons[0]!;assert.equal(reason.expiresAt,NOW+300000);
   assert.equal(await review.handle('301',route(view,'mc:1:c:')),null);
   await f.store.transaction(s=>{s.moderationReasons[0]!.active=false;});
   assert.equal((await service.addManualReason('301',CHAT,'400','law_v1_p1_m42','MUTE',undefined,300)).status,'NO_CHANGE');assert.equal(gateway.calls.length,1);
   for(const [kind,duration] of [['BAN',300],['MUTE',undefined],['MUTE',86401]] as const)assert.equal((await service.addManualReason('301',CHAT,'401','law_v1_p1_m43',kind,undefined,duration)).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' paragraph exemptions and a newer law version prevent timed mutes',async()=>{
  for(const variant of ['exempt','version'] as const){const f=await fixture();try{
   const draft=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء');await f.ui.handle('301',route(draft,'rl:1:c:'));
   const gateway=new FakeModerationGateway(),service=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   if(variant==='exempt'){const ui=new TelegramRuleExemptions(f.store,f.policy,()=>NOW),preview=await ui.preview('301','/exemptrule -100 400 1 600');assert.ok(preview);await ui.handle('301',route(preview,'le:1:c:'));}
   else {const next=await f.ui.preview('301','/setrules -100\nفقرة جديدة');await f.ui.handle('301',route(next,'rl:1:c:'));}
   assert.equal((await service.addManualReason('301',CHAT,'400','law_v1_p1_m42','MUTE',undefined,300)).status,'DENIED');assert.equal(gateway.calls.length,0);assert.equal((await f.store.snapshot()).moderationReasons.length,0);
  }finally{await f.close();}}
 });
 test(engine+' paragraph mute review deadline is rechecked after the second rights lookup',async()=>{
  const f=await fixture();try{
   const draft=await f.ui.preview('301','/setrules -100\nاحترام الأعضاء');await f.ui.handle('301',route(draft,'rl:1:c:'));
   let now=NOW,reads=0;const gateway=new FakeModerationGateway();gateway.canRestrict=async()=>{if(++reads===2)now=NOW+1000;return true;};
   const service=new ModerationService(f.store,f.policy,gateway,()=>now);
   assert.equal((await service.addManualReason('301',CHAT,'400','law_v1_p1_m42','MUTE',undefined,300,undefined,NOW+1000)).status,'DENIED');assert.equal(gateway.calls.length,0);
  }finally{await f.close();}
 });
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
   assert.deepEqual(plan.plan.groupRulesMarkup,{inline_keyboard:[[{text:'📨 اعتراض أو توضيح في الخاص',url:'https://t.me/ManaratakBot?start=appeals'}],[{text:'🚩 البلاغات وطريقة الإبلاغ',url:'https://t.me/ManaratakBot?start=reports'}]]});
   const next=await f.ui.preview('301','/setrules -100\nفقرة معدلة');await f.ui.handle('301',route(next,'rl:1:c:'));let calls=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{calls++;return {status:'CONFIRMED',messageId:91};}},()=>NOW);assert.equal((await dispatcher.dispatch(plan.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(calls,0);
   const fresh=await app.handle({update_id:5,message:{message_id:11,chat:{id:-100,type:'supergroup'},from:{id:300,is_bot:false},text:'/rules'}});assert.equal((await dispatcher.dispatch(fresh.deliveryKey!)).status,'CONFIRMED');assert.equal(calls,1);
   const deep=await app.handle({update_id:50,message:{message_id:50,chat:{id:300,type:'private'},from:{id:300,is_bot:false},text:'/start appeals'}});assert.equal(deep.reason,'MODERATION_APPEAL_VIEW');assert.equal(deep.plan?.chatId,'300');assert.match(deep.plan?.text??'',/حالاتك اليدوية/u);
   const reports=await app.handle({update_id:51,message:{message_id:51,chat:{id:300,type:'private'},from:{id:300,is_bot:false},text:'/start reports'}});assert.equal(reports.reason,'MODERATION_REPORT_VIEW');assert.match(reports.plan?.text??'',/بالرد المباشر/u);
   const warning=await app.handle({update_id:6,message:{message_id:100,chat:{id:-100,type:'supergroup'},from:{id:301,is_bot:false},text:'/warnrule 1',reply_to_message:{message_id:42,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}}}});assert.equal(warning.reason,'MODERATION_PREVIEW_ONLY');assert.equal(warning.plan!.chatId,'301');assert.match(warning.plan!.text,/فقرة معدلة/u);assert.equal((await f.store.snapshot()).warnings.length,0);
   const approve=warning.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:c:'))!.callback_data;const confirmed=await app.handle({update_id:7,callback_query:{id:'rule-warning',from:{id:301,is_bot:false},data:approve,message:{message_id:9,from:{id:999,is_bot:true},chat:{id:301,type:'private'}}}});assert.equal(confirmed.status,'APPLIED');assert.equal((await f.store.snapshot()).warnings[0]!.reference,'law_v2_p1_m42');
   const mute=await app.handle({update_id:70,message:{message_id:110,chat:{id:-100,type:'supergroup'},from:{id:301,is_bot:false},text:'/muterule 1 300',reply_to_message:{message_id:43,chat:{id:-100,type:'supergroup'},from:{id:401,is_bot:false}}}});
   assert.equal(mute.reason,'MODERATION_PREVIEW_ONLY');assert.equal(mute.plan!.chatId,'301');assert.match(mute.plan!.text,/فقرة معدلة/u);assert.equal((await f.store.snapshot()).moderationReasons.length,0);
   const muteConfirm=mute.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:c:'))!.callback_data;
   assert.equal((await app.handle({update_id:71,callback_query:{id:'rule-mute',from:{id:301,is_bot:false},data:muteConfirm,message:{message_id:10,from:{id:999,is_bot:true},chat:{id:301,type:'private'}}}})).status,'APPLIED');
   assert.equal((await f.store.snapshot()).moderationReasons[0]!.reference,'law_v2_p1_m43');
   const callback=(id:number,data:string,group=false)=>app.handle({update_id:id,callback_query:{id:'rule-report-'+id,from:{id:301,is_bot:false},data,message:{message_id:9,from:{id:999,is_bot:true},chat:group?{id:-100,type:'supergroup'}:{id:301,type:'private'}}}});
   const menu=await privateText(8,'/grouprules'),select=menu.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:g:'))!.callback_data;
   const detail=await callback(9,select),report=detail.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:r:'))!.callback_data;
   assert.equal((await callback(10,report,true)).status,'DENIED');const reportView=await callback(11,report);assert.equal(reportView.status,'APPLIED');assert.match(reportView.plan?.text??'',/الفقرة 1: 1 تحذير/u);assert.equal(reportView.plan?.chatId,'301');
   const back=reportView.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:g:'))!.callback_data;assert.equal((await callback(12,back)).status,'APPLIED');
   const off=await privateText(80,'/disablerule -100 1');assert.ok(off.plan);assert.match(off.plan.text,/معطلة/u);const offConfirm=off.plan.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data;
   assert.equal((await callback(81,offConfirm,true)).status,'DENIED');assert.equal((await callback(82,offConfirm)).status,'APPLIED');assert.equal(await f.ui.warningReference(CHAT,1,42),null);
   assert.equal((await f.store.snapshot()).warnings[0]!.reference,'law_v2_p1_m42');assert.equal((await f.store.snapshot()).moderationReasons[0]!.reference,'law_v2_p1_m43');
   const on=await privateText(83,'/enablerule -100 1');assert.ok(on.plan);const onConfirm=on.plan.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data;assert.equal((await callback(84,onConfirm)).status,'APPLIED');assert.equal(await f.ui.warningReference(CHAT,1,42),'law_v4_p1_m42');
   const translation=await privateText(85,'/translaterules -100 en\nRespect <members>');assert.ok(translation.plan);const translationConfirm=translation.plan.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data;assert.equal((await callback(86,translationConfirm,true)).status,'DENIED');assert.equal((await callback(87,translationConfirm)).status,'APPLIED');
   const translated=await app.handle({update_id:88,message:{message_id:88,chat:{id:-100,type:'supergroup'},from:{id:300,is_bot:false},text:'/rules@ManaratakBot en'}});assert.equal(translated.reason,'GROUP_RULES_VIEW');assert.match(translated.plan!.text,/Respect &lt;members&gt;/u);
   const removal=await privateText(89,'/removerulelang -100 en');assert.ok(removal.plan);const removalConfirm=removal.plan.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rl:1:c:'))!.callback_data;assert.equal((await callback(90,removalConfirm)).status,'APPLIED');assert.equal((await dispatcher.dispatch(translated.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(calls,1);
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
 test(engine+' repeated navigation never creates cancellation records for cancellation records',async()=>{
  const f=await fixture();try{
   const preview=await f.ui.preview('301','/setrules -100\nفقرة');assert.ok(preview);await f.ui.cancel('301');const before=(await f.store.snapshot()).audit.filter(a=>a.updateKey.startsWith('moderation:rules:preview:'));assert.equal(before.length,2);
   for(let i=0;i<5;i++)await f.ui.cancel('301');const after=(await f.store.snapshot()).audit.filter(a=>a.updateKey.startsWith('moderation:rules:preview:'));assert.deepEqual(after,before);assert.equal(after.some(a=>a.updateKey.endsWith(':done:done')),false);
  }finally{await f.close();}
 });
 test(engine+' rules private picker and input bounds preserve usable return buttons',async()=>{
  const f=await fixture();try{
   const home=await f.ui.handle('100','mi:1:i:02:11'),detail=await f.ui.handle('100',route(home,'rl:1:g:'));assert.match(detail!.text,/setrules/u);assert.ok(await f.ui.handle('100',route(detail,'rl:1:h:')));assert.equal(await f.ui.handle('300','mi:1:i:02:11'),null);
   for(const text of ['/setrules -100\n','/setrules -100\n فقرة','/setrules -100\nنفس\nنفس','/setrules -100\n'+'ع'.repeat(121),'/setrules -100\n'+Array.from({length:21},(_,i)=>'فقرة '+i).join('\n')])assert.equal(await f.ui.preview('301',text),null);
  }finally{await f.close();}
 });
 test(engine+' weekly rule report aggregates current and historical paragraphs privately with working return',async()=>{
  const f=await fixture();try{
   let draft=await f.ui.preview('301','/setrules -100\nالفقرة الأولى\nلا <إعلان>');await f.ui.handle('301',route(draft,'rl:1:c:'));
   await f.store.transaction(s=>{s.warnings.push(
    {chatId:CHAT,memberId:'400',reference:'law_v1_p2_m1',actorId:'301',at:NOW-1000,active:true},
    {chatId:CHAT,memberId:'401',reference:'law_v1_p2_m2',actorId:'301',at:NOW-2000,active:false},
    {chatId:CHAT,memberId:'402',reference:'law_v1_p1_m3',actorId:'301',at:NOW-8*86400000,active:true},
    {chatId:CHAT,memberId:'403',reference:'law_v7_p1_m4',actorId:'301',at:NOW-1000,active:true},
    {chatId:'-200',memberId:'404',reference:'law_v1_p2_m5',actorId:'301',at:NOW-1000,active:true},
    {chatId:CHAT,memberId:'406',reference:'law_v1_p2_m7',actorId:'301',at:NOW-1000,active:true},
    {chatId:CHAT,memberId:'406',reference:'law_v1_p2_m7',actorId:'301',at:NOW-8*86400000,active:true},
    {chatId:CHAT,memberId:'9007199254740992',reference:'law_v1_p2_m8',actorId:'301',at:NOW-1000,active:true},
    {chatId:CHAT,memberId:'407',reference:'law_v1_p2_m9007199254740992',actorId:'301',at:NOW-1000,active:true},
    {chatId:CHAT,memberId:'408',reference:'law_v1_p2_m9',actorId:'301\n',at:NOW-1000,active:true}
   );});
   draft=await f.ui.preview('301','/setrules -100\nفقرة جديدة');await f.ui.handle('301',route(draft,'rl:1:c:'));
   await f.store.transaction(s=>{s.warnings.push({chatId:CHAT,memberId:'405',reference:'law_v2_p1_m6',actorId:'301',at:NOW-3000,active:true});});
   const home=await f.ui.handle('301','rl:1:h:0'),details=await f.ui.handle('301',route(home,'rl:1:g:'));const reportRoute=route(details,'rl:1:r:');
   assert.equal(await f.ui.handle('300',reportRoute),null);const report=await f.ui.handle('301',reportRoute);assert.ok(report);assert.match(report.text,/الأسبوع/u);assert.match(report.text,/الإصدار 1.*الفقرة 2.*2/u);assert.match(report.text,/&lt;إعلان&gt;/u);assert.match(report.text,/الإصدار 2.*الفقرة 1.*1/u);assert.match(report.text,/لا يمكن الجزم/u);for(const id of ['400','401','402','403','404','405'])assert.equal(report.text.includes(id),false);
   const back=await f.ui.handle('301',route(report,'rl:1:g:'));assert.ok(back);assert.match(back.text,/setrules/u);
   await f.store.transaction(s=>{s.grants[0]!.revoked=true;});assert.equal(await f.ui.handle('301',reportRoute),null);
  }finally{await f.close();}
 });
 test(engine+' weekly report counts separately confirmed cancellations with intact appeal evidence',async()=>{
  const f=await fixture();try{
   const draft=await f.ui.preview('301','/setrules -100\nفقرة أولى');await f.ui.handle('301',route(draft,'rl:1:c:'));
   const moderation=new ModerationService(f.store,f.policy,new FakeModerationGateway(),()=>NOW),appeals=new TelegramModerationAppeals(f.store,f.policy,()=>NOW);
   await moderation.issueWarning('301',CHAT,'400','law_v1_p1_m42');
   let reportMenu=await f.ui.handle('301','rl:1:h:0'),rules=await f.ui.handle('301',route(reportMenu,'rl:1:g:'));const oldReport=route(rules,'rl:1:r:');
   const own=await appeals.handle('400','ap:1:h:0'),request=await appeals.handle('400',route(own,'ap:1:d:'));await appeals.handle('400',route(request,'ap:1:c:'));
   let review=await appeals.handle('301',route(await appeals.handle('301','ap:1:r:0'),'ap:1:p:'));await appeals.handle('301',route(review,'ap:1:a:'));assert.equal(await f.ui.handle('301',oldReport),null);
   reportMenu=await f.ui.handle('301','rl:1:h:0');rules=await f.ui.handle('301',route(reportMenu,'rl:1:g:'));assert.match((await f.ui.handle('301',route(rules,'rl:1:r:')))!.text,/الإلغاءات الموثقة بعد اعتراض خلال الأسبوع: 0/u);
   review=await appeals.handle('301',route(await appeals.handle('301','ap:1:r:0'),'ap:1:p:'));const preview=await appeals.handle('301',route(review,'ap:1:u:'));assert.ok(await appeals.handle('301',route(preview,'ap:1:z:')));
   reportMenu=await f.ui.handle('301','rl:1:h:0');rules=await f.ui.handle('301',route(reportMenu,'rl:1:g:'));assert.match((await f.ui.handle('301',route(rules,'rl:1:r:')))!.text,/الإلغاءات الموثقة بعد اعتراض خلال الأسبوع: 1/u);
   await f.store.transaction(s=>{const record=s.audit.find(a=>a.reason==='MODERATION_APPEAL_WARNING_REVOKED')!;s.audit.push({...record});});
   reportMenu=await f.ui.handle('301','rl:1:h:0');rules=await f.ui.handle('301',route(reportMenu,'rl:1:g:'));assert.match((await f.ui.handle('301',route(rules,'rl:1:r:')))!.text,/الإلغاءات الموثقة بعد اعتراض خلال الأسبوع: 0/u);
  }finally{await f.close();}
 });
 test(engine+' weekly report stays within Telegram text limits even for long escaped paragraphs',async()=>{
  const f=await fixture();try{
   for(let i=1;i<=10;i++){
    const draft=await f.ui.preview('301','/setrules -100\n'+'<'.repeat(118)+i);assert.ok(draft);assert.ok(await f.ui.handle('301',route(draft,'rl:1:c:')));
    await f.store.transaction(s=>{s.warnings.push({chatId:CHAT,memberId:String(500+i),reference:'law_v'+i+'_p1_m'+i,actorId:'301',at:NOW-1000,active:true});});
   }
   const home=await f.ui.handle('301','rl:1:h:0'),details=await f.ui.handle('301',route(home,'rl:1:g:')),report=await f.ui.handle('301',route(details,'rl:1:r:'));assert.ok(report);assert.ok(report.text.length<=4096);assert.match(report.text,/تُعرض/u);assert.ok(await f.ui.handle('301',route(report,'rl:1:g:')));
  }finally{await f.close();}
 });
}
