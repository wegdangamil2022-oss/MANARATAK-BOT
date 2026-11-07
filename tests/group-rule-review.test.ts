import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramGroupRules} from '../src/telegram-group-rules.js';
import {ModerationCommandReview} from '../src/telegram-moderation-command-review.js';
import {TelegramModerationReports} from '../src/telegram-moderation-reports.js';
import {parseReplyModerationCommand} from '../src/telegram-moderation-commands.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {TelegramRuleExemptions} from '../src/telegram-rule-exemptions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {ruleReviewReports} from '../src/moderation-report-model.js';
const NOW=1700000000000;
const button=(v:OwnerInlineScreen|null,p:string)=>{const b=v?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'law-review-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation','navigation']);await policy.grant('100','301','chat.manage','-100',NOW+86400000);const rules=new TelegramGroupRules(store,policy,()=>now),gateway=new FakeModerationGateway(),service=new ModerationService(store,policy,gateway,()=>now),review=new ModerationCommandReview(store,policy,service,()=>now),reports=new TelegramModerationReports(store,policy,()=>now);const d=await rules.preview('301','/setrules -100\nاحترام الأعضاء');await rules.handle('301',button(d,'rl:1:c:'));return {store,policy,rules,gateway,service,review,reports,time:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' paragraph review confirms privately once and closes through existing report buttons without sanctions',async()=>{const f=await fixture();try{
  const command={kind:'review' as const,memberId:'400',reference:'law_v1_p1_m42'},d=await f.review.preview('301','-100',command);assert.ok(d);assert.match(d.text,/احترام الأعضاء/u);assert.ok(isValidTelegramInlineKeyboard(d.keyboard));assert.equal((await f.store.snapshot()).audit.some(a=>a.reason.startsWith('MODERATION_REPORT:')),false);
  assert.equal(await f.review.handle('400',button(d,'mc:1:c:')),null);const result=await f.review.handle('301',button(d,'mc:1:c:'));assert.equal(result?.status,'APPLIED');assert.equal(await f.review.handle('301',button(d,'mc:1:c:')),null);
  const duplicate=await f.review.preview('301','-100',command);assert.equal((await f.review.handle('301',button(duplicate,'mc:1:c:')))?.status,'IGNORED');
  const home=await f.reports.handle('301','rp:1:r:0'),detail=await f.reports.handle('301',button(home,'rp:1:d:'));assert.match(detail!.text,/مراجعة فقرة/u);assert.match(detail!.text,/القانون 1 · الإصدار 1: احترام الأعضاء/u);assert.ok(isValidTelegramInlineKeyboard(detail!.keyboard));assert.equal(await f.reports.handle('400',button(home,'rp:1:d:')),null);
  const close=await f.reports.handle('301',button(detail,'rp:1:x:'));assert.ok(await f.reports.handle('301',button(close,'rp:1:c:')));const s=await f.store.snapshot();assert.equal(s.warnings.length,0);assert.equal(s.moderationReasons.length,0);assert.equal(s.moderationOperations.length,0);
  const laws=await f.rules.handle('301',button(await f.rules.handle('301','rl:1:h:0'),'rl:1:g:')),weekly=await f.rules.handle('301',button(laws,'rl:1:r:'));assert.match(weekly!.text,/مراجعات الفقرات المسجلة خلال الأسبوع: 1/u);assert.match(weekly!.text,/المغلق منها: 1/u);
 }finally{await f.close();}});
 test(engine+' paragraph review rejects stale, expired and protected targets and respects exemptions',async()=>{for(const variant of ['expiry','version','grant','protected','exemption'] as const){const f=await fixture();try{
  const d=await f.review.preview('301','-100',{kind:'review',memberId:'400',reference:'law_v1_p1_m42'});assert.ok(d);
  if(variant==='expiry')f.time(NOW+120000);if(variant==='grant')await f.store.transaction(s=>{s.grants[0]!.revoked=true;});if(variant==='protected')f.gateway.protectedMembers.add('-100:400');
  if(variant==='version'){const next=await f.rules.preview('301','/setrules -100\nقانون جديد');await f.rules.handle('301',button(next,'rl:1:c:'));}
  if(variant==='exemption'){const ui=new TelegramRuleExemptions(f.store,f.policy,()=>NOW),e=await ui.preview('301','/exemptrule -100 400 1 60');assert.ok(await ui.handle('301',button(e,'le:1:c:')));}
  const result=await f.review.handle('301',button(d,'mc:1:c:'));assert.ok(result===null||result.status==='DENIED');assert.equal((await f.store.snapshot()).audit.some(a=>a.reason.startsWith('MODERATION_REPORT:')),false);
 }finally{await f.close();}}});
 test(engine+' concurrent review requests preserve one durable case and reject corrupt duplicate history',async()=>{const f=await fixture();try{
  const results=await Promise.all([f.service.requestRuleReview('301','-100','400','law_v1_p1_m42'),f.service.requestRuleReview('301','-100','400','law_v1_p1_m42')]);assert.deepEqual(results.sort(),['DUPLICATE','RECORDED']);
  assert.equal(ruleReviewReports(await f.store.snapshot()).length,1);
  await f.store.transaction(s=>{const r=s.audit.find(a=>a.reason.startsWith('MODERATION_REPORT:'))!;s.audit.push({...r});});assert.equal(await f.service.requestRuleReview('301','-100','400','law_v1_p1_m42'),'DENIED');
 }finally{await f.close();}});
 test(engine+' review retains historical law explanation safely and checks the deadline after awaited rights reads',async()=>{const f=await fixture();try{
  const law=await f.rules.preview('301','/setrules -100\nلا <إعلان>');await f.rules.handle('301',button(law,'rl:1:c:'));
  const d=await f.review.preview('301','-100',{kind:'review',memberId:'400',reference:'law_v2_p1_m42'});assert.ok(await f.review.handle('301',button(d,'mc:1:c:')));
  const next=await f.rules.preview('301','/setrules -100\nقانون آخر');await f.rules.handle('301',button(next,'rl:1:c:'));
  const home=await f.reports.handle('301','rp:1:r:0'),detail=await f.reports.handle('301',button(home,'rp:1:d:'));assert.match(detail!.text,/لا &lt;إعلان&gt;/u);assert.equal(detail!.text.includes('<إعلان>'),false);
  assert.equal(await f.service.requestRuleReview('301','-100','400','law_v2_p1_m43'),'DENIED');
  const current=await f.review.preview('301','-100',{kind:'review',memberId:'401',reference:'law_v3_p1_m43'});let calls=0;f.gateway.isProtected=async()=>{if(++calls===2)f.time(NOW+120000);return false;};
  assert.equal((await f.review.handle('301',button(current,'mc:1:c:')))?.status,'DENIED');assert.equal(ruleReviewReports(await f.store.snapshot()).length,1);
 }finally{await f.close();}});
 test(engine+' group review command always opens a private confirmation even in direct mode and navigation cancels it',async()=>{const f=await fixture();try{
  const education=new EducationService(f.store,f.policy,()=>NOW),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,()=>NOW),faq:new ApprovedAnswerService(f.store,f.policy,()=>NOW),links:new ResourceLinkService(f.store,f.policy,()=>NOW),moderation:f.service,moderationCommandMode:'direct',membership:async()=> 'VERIFIED',clock:()=>NOW,botId:'rule-review',botUsername:'ManaratakBot'});
  let id=100;const tap=(data:string)=>app.handle({update_id:id++,callback_query:{id:'review_'+id,from:{id:301,is_bot:false},data,message:{message_id:90,from:{id:999,is_bot:true},chat:{id:301,type:'private'}}}});
  const input=(text:string)=>app.handle({update_id:id++,message:{message_id:100+id,from:{id:301,is_bot:false},chat:{id:-100,type:'supergroup'},text,reply_to_message:{message_id:42,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}}}});
  const d=await input('/reviewrule 1');assert.equal(d.plan?.chatId,'301');const confirm=d.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:c:'))?.callback_data;assert.ok(confirm);assert.equal(ruleReviewReports(await f.store.snapshot()).length,0);assert.equal((await tap(confirm)).status,'APPLIED');assert.equal(ruleReviewReports(await f.store.snapshot()).length,1);
  const next=await input('/reviewrule 1'),stale=next.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:c:'))?.callback_data;assert.ok(stale);await tap('rl:1:h:0');assert.equal((await tap(stale)).status,'DENIED');assert.equal((await input('/reviewrule 2')).status,'DENIED');
 }finally{await f.close();}});
}
test('paragraph review parser requires exact human reply and law message reference',()=>{
 const reply={message_id:42,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}};
 assert.equal(parseReplyModerationCommand('/review law_v1_p1_m42','ManaratakBot','-100',43,reply).status,'COMMAND');
 assert.equal(parseReplyModerationCommand('/review law_v1_p1_m41','ManaratakBot','-100',43,reply).status,'INVALID');
 assert.equal(parseReplyModerationCommand('/review arbitrary','ManaratakBot','-100',43,reply).status,'INVALID');
 assert.equal(parseReplyModerationCommand('/review law_v1_p1_m42','ManaratakBot','-100',43,{...reply,forward_origin:{}}).status,'INVALID');
});
