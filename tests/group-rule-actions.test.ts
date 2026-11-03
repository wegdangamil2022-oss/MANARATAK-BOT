import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramGroupRules} from '../src/telegram-group-rules.js';
import {TelegramRuleWarningPolicy} from '../src/telegram-rule-warning-policy.js';
import {ModerationCommandReview} from '../src/telegram-moderation-command-review.js';
import {RuleNoticeDispatcher,ruleNotices} from '../src/group-rule-notices.js';
import {TelegramRuleActions} from '../src/telegram-rule-actions.js';
import {ruleWarningPolicy} from '../src/group-rule-warning-policy.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const NOW=1700000000000,button=(s:OwnerInlineScreen|null,p:string)=>{const b=s?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'rule-actions-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;const clock=()=>now,policy=new Policy(store,'100',clock);await policy.approveChat('100','-100',['moderation','navigation']);await policy.grant('100','301','chat.manage','-100',NOW+604800000);const rules=new TelegramGroupRules(store,policy,clock),ui=new TelegramRuleWarningPolicy(store,policy,clock),gateway=new FakeModerationGateway(),service=new ModerationService(store,policy,gateway,clock),review=new ModerationCommandReview(store,policy,service,clock);const p=await rules.preview('301','/setrules -100\nاحترام <الأعضاء>');await rules.handle('301',button(p,'rl:1:c:'));return {store,policy,rules,ui,gateway,service,review,clock,time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' first notice is privately reviewed, durable, expires without warnings and cannot replay a case',async()=>{const f=await fixture();try{
  const draft=await f.review.preview('301','-100',{kind:'notice',memberId:'400',reference:'law_v1_p1_m42'});assert.ok(draft);assert.ok(isValidTelegramInlineKeyboard(draft.keyboard));assert.equal(ruleNotices(await f.store.snapshot(),NOW).length,0);
  assert.equal((await f.review.handle('301',button(draft,'mc:1:c:')))?.status,'APPLIED');assert.equal(ruleNotices(await f.store.snapshot(),NOW).length,1);assert.equal((await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m43')),'NO_CHANGE');
  let sends=0;const dispatcher=new RuleNoticeDispatcher(f.store,f.policy,f.service,{send:async p=>{sends++;assert.equal(p.chatId,'400');assert.match(p.text,/&lt;الأعضاء&gt;/u);return {status:'CONFIRMED',messageId:91};}},f.clock,async()=>true);assert.equal(await dispatcher.drain(),1);assert.equal(await dispatcher.drain(),0);assert.equal(sends,1);const s=await f.store.snapshot();assert.equal(s.warnings.length,0);assert.equal(s.moderationReasons.length,0);assert.equal(ruleNotices(s,NOW)[0]?.delivery,'CONFIRMED');
  f.time(NOW+86400000);assert.equal(await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m42'),'NO_CHANGE');
  assert.equal(await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m44'),'ADDED');
 }finally{await f.close();}});
 test(engine+' notice receipts cannot certify two notices to the same private chat',async()=>{const f=await fixture();try{
  await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m42');
  const dispatcher=new RuleNoticeDispatcher(f.store,f.policy,f.service,{send:async()=>({status:'CONFIRMED',messageId:91})},f.clock,async()=>true);
  await dispatcher.drain();f.time(NOW+86400000);
  await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m43');await dispatcher.drain();
  assert.deepEqual(ruleNotices(await f.store.snapshot(),f.clock()).map(n=>n.delivery),['CONFIRMED','UNKNOWN_OUTCOME']);
  await f.service.issueRuleNotice('301','-100','401','law_v1_p1_m44');await dispatcher.drain();
  assert.equal(ruleNotices(await f.store.snapshot(),f.clock()).at(-1)?.delivery,'CONFIRMED');
  assert.equal(await dispatcher.drain(),0);
 }finally{await f.close();}});
 test(engine+' conflicting stored notice receipts are quarantined without replay',async()=>{const f=await fixture();try{
  let messageId=90,sends=0;
  const dispatcher=new RuleNoticeDispatcher(f.store,f.policy,f.service,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:++messageId};}},f.clock,async()=>true);
  await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m42');await dispatcher.drain();f.time(NOW+86400000);
  await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m43');await dispatcher.drain();
  assert.deepEqual(ruleNotices(await f.store.snapshot(),f.clock()).map(n=>n.delivery),['CONFIRMED','CONFIRMED']);
  await f.store.transaction(s=>{const r=s.audit.find(a=>a.reason.startsWith('RULE_NOTICE_RECEIPT:92:'))!;r.reason=r.reason.replace('RECEIPT:92:','RECEIPT:91:');});
  assert.deepEqual(ruleNotices(await f.store.snapshot(),f.clock()).map(n=>n.delivery),['UNKNOWN_OUTCOME','UNKNOWN_OUTCOME']);
  assert.equal(await dispatcher.drain(),0);assert.equal(sends,2);
 }finally{await f.close();}});
 test(engine+' action order is confirmed and policy edits preserve ceilings while excluding disabled actions',async()=>{const f=await fixture();try{
  const ceiling=await f.ui.preview('301','/rulewarnings -100 1 5 60');await f.ui.handle('301',button(ceiling,'rw:1:c:'));
  const p=await f.ui.preview('301','/ruleactions -100 1 review,notice,warn 300');assert.ok(p);assert.ok(await f.ui.handle('301',button(p,'rw:1:c:')));
  const setting=ruleWarningPolicy(await f.store.snapshot(),'-100','law_v1_p1_m42',NOW);assert.equal(setting.status==='CONFIGURED'&&setting.policy.cap,5);assert.equal(setting.status==='CONFIGURED'&&setting.policy.seconds,60);
  assert.equal((await f.service.addManualReason('301','-100','400','law_v1_p1_m42','MUTE',undefined,300)).status,'DENIED');
  const view=await f.ui.handle('301','rw:1:g:-100');assert.match(view!.text,/review → notice → warn/u);
  for(const text of ['/ruleactions -100 1 warn,warn 300','/ruleactions -100 1 ban 300','/ruleactions -100 1 notice,mute 59'])assert.equal(await f.ui.preview('301',text),null);
 }finally{await f.close();}});
 test(engine+' ordered choices are actor-bound, one-shot and require a second confirmation without automatic escalation',async()=>{const f=await fixture();try{
  const p=await f.ui.preview('301','/ruleactions -100 1 review,notice,warn,mute 300');await f.ui.handle('301',button(p,'rw:1:c:'));
  const ui=new TelegramRuleActions(f.store,f.policy,f.service,f.clock),choice=await ui.choose('301','-100','400','law_v1_p1_m42');assert.ok(choice);assert.ok(isValidTelegramInlineKeyboard(choice.keyboard));assert.deepEqual(choice.keyboard.inline_keyboard.slice(0,4).map(r=>r[0]!.callback_data[5]),['r','n','w','m']);
  assert.equal(await ui.handle('400',button(choice,'ra:1:n:')),null);const preview=await ui.handle('301',button(choice,'ra:1:n:'));assert.ok(preview);assert.equal(ruleNotices(await f.store.snapshot(),NOW).length,0);assert.equal(await ui.handle('301',button(choice,'ra:1:w:')),null);assert.equal((await f.review.handle('301',button(preview,'mc:1:c:')))?.status,'APPLIED');assert.equal((await f.store.snapshot()).moderationOperations.length,0);
  const selected=await ui.choose('301','-100','401','law_v1_p1_m43');await ui.cancel('301');assert.equal(await ui.handle('301',button(selected,'ra:1:m:')),null);
 }finally{await f.close();}});
 test(engine+' policy changes invalidate choices and pending notices rather than inheriting new action settings',async()=>{const f=await fixture();try{
  const ui=new TelegramRuleActions(f.store,f.policy,f.service,f.clock),choice=await ui.choose('301','-100','401','law_v1_p1_m43');assert.equal(await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m42'),'ADDED');
  const p=await f.ui.preview('301','/ruleactions -100 1 review 300');await f.ui.handle('301',button(p,'rw:1:c:'));assert.equal(await ui.handle('301',button(choice,'ra:1:w:')),null);
  assert.equal((await f.service.issueWarning('301','-100','402','law_v1_p1_m44')).status,'DENIED');assert.equal(await f.service.issueRuleNotice('301','-100','402','law_v1_p1_m44'),'DENIED');
  let sends=0;const d=new RuleNoticeDispatcher(f.store,f.policy,f.service,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:1};}},f.clock,async()=>true);await d.drain();assert.equal(sends,0);
 }finally{await f.close();}});
 test(engine+' notice receipt is bound to its original job and late or altered acknowledgement remains unknown',async()=>{for(const variant of ['receipt','late','alter','failed'] as const){const f=await fixture();try{
  await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m42');let sends=0;
  const d=new RuleNoticeDispatcher(f.store,f.policy,f.service,{send:async()=>{sends++;if(variant==='late')f.time(NOW+30000);if(variant==='alter')await f.store.transaction(s=>{const a=s.audit.find(a=>a.reason.startsWith('RULE_NOTICE:'))!;const n=JSON.parse(a.reason.slice('RULE_NOTICE:'.length));n.reference='law_v1_p1_m43';a.reason='RULE_NOTICE:'+JSON.stringify(n);});return variant==='failed'?{status:'FAILED_CONFIRMED'}:{status:'CONFIRMED',messageId:91};}},f.clock,async()=>true);
  await d.drain();if(variant==='receipt')await f.store.transaction(s=>{s.audit=s.audit.filter(a=>!a.updateKey.endsWith(':receipt'));});assert.equal(ruleNotices(await f.store.snapshot(),f.clock())[0]?.delivery,variant==='failed'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME');await d.drain();assert.equal(sends,1);
 }finally{await f.close();}}});
 test(engine+' notice authorization is rechecked after awaited safety before sending',async()=>{for(const variant of ['grant','policy','law','start','expiry'] as const){const f=await fixture();try{
  await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m42');let gates=0,sends=0;
  const d=new RuleNoticeDispatcher(f.store,f.policy,f.service,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:91};}},f.clock,async()=>{
   if(++gates===2){if(variant==='grant')await f.store.transaction(s=>{s.grants[0]!.revoked=true;});if(variant==='expiry')f.time(NOW+120000);if(variant==='start')await f.store.transaction(s=>{const a=s.audit.find(a=>a.reason==='RULE_NOTICE_STARTED')!;s.audit.push({...a});});if(variant==='policy'){const p=await f.ui.preview('301','/ruleactions -100 1 review 300');await f.ui.handle('301',button(p,'rw:1:c:'));}if(variant==='law'){const p=await f.rules.preview('301','/setrules -100\nقانون جديد');await f.rules.handle('301',button(p,'rl:1:c:'));}}
   return true;
  });await d.drain();await d.drain();assert.equal(sends,0);
 }finally{await f.close();}}});
 test(engine+' transport connects configuration, reply choices and private confirmation in direct mode',async()=>{const f=await fixture();try{
  const education=new EducationService(f.store,f.policy,f.clock),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.clock),faq:new ApprovedAnswerService(f.store,f.policy,f.clock),links:new ResourceLinkService(f.store,f.policy,f.clock),moderation:f.service,moderationCommandMode:'direct',membership:async()=> 'VERIFIED',clock:f.clock,botId:'rule-actions',botUsername:'ManaratakBot'});
  let id=100;const tap=(data:string)=>app.handle({update_id:id++,callback_query:{id:'actions_'+id,from:{id:301,is_bot:false,first_name:'<Moderator>'},data,message:{message_id:90,from:{id:999,is_bot:true},chat:{id:301,type:'private'}}}}),input=(text:string,group=false)=>app.handle({update_id:id++,message:{message_id:100+id,from:{id:301,is_bot:false},chat:{id:group?-100:301,type:group?'supergroup':'private'},text,...(group?{reply_to_message:{message_id:42,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}}}:{})}});
  const selected=(v:Awaited<ReturnType<typeof tap>>,p:string)=>{const b=v.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
  const config=await input('/ruleactions -100 1 notice,review 300');assert.equal((await tap(selected(config,'rw:1:c:'))).status,'APPLIED');const choice=await input('/actrule 1',true);assert.equal(choice.plan?.chatId,'301');const preview=await tap(selected(choice,'ra:1:n:'));assert.match(preview.plan!.text,/&lt;Moderator&gt;/u);assert.match(preview.plan!.text,/start=law_100_1/u);assert.equal(ruleNotices(await f.store.snapshot(),NOW).length,0);assert.equal((await tap(selected(preview,'mc:1:c:'))).status,'APPLIED');assert.equal(ruleNotices(await f.store.snapshot(),NOW).length,1);
  const next=await input('/actrule 1',true),stale=selected(next,'ra:1:r:');await tap('rl:1:h:0');assert.equal((await tap(stale)).status,'DENIED');
 }finally{await f.close();}});
 test(engine+' ambiguous and interrupted notice delivery never retries, and STOP or revoked grants suppresses send',async()=>{for(const variant of ['unknown','interrupted','stop','revoked'] as const){const f=await fixture();try{
  assert.equal(await f.service.issueRuleNotice('301','-100','400','law_v1_p1_m42'),'ADDED');let sends=0;
  if(variant==='revoked')await f.store.transaction(s=>{s.grants[0]!.revoked=true;});
  if(variant==='interrupted')await f.store.transaction(s=>{const n=ruleNotices(s,NOW)[0]!;s.audit.push({actorId:'301',updateKey:n.id+':started',decision:'ALLOW',reason:'RULE_NOTICE_STARTED',policyVersion:1,at:NOW});});
  f.time(NOW+30001);const d=new RuleNoticeDispatcher(f.store,f.policy,f.service,{send:async()=>{sends++;return {status:'UNKNOWN_OUTCOME'};}},f.clock,async()=>variant!=='stop');await d.drain();await d.drain();assert.equal(sends,variant==='unknown'?1:0);
 }finally{await f.close();}}});
}
