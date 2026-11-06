import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramGroupRules} from '../src/telegram-group-rules.js';
import {TelegramRuleWarningPolicy,validRuleWarningPolicyRoute} from '../src/telegram-rule-warning-policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {ModerationCommandReview} from '../src/telegram-moderation-command-review.js';
import {ruleWarningPolicy,paragraphWarningCount,warningActive,RULE_WARNING_POLICY_PREFIX} from '../src/group-rule-warning-policy.js';
import {protectionUIEpoch} from '../src/protection-ui-access.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
const NOW=1700000000000,CHAT='-100';
test('warning policy selectors reject malformed, unsafe and copied shapes',()=>{
 for(const value of ['rw:1:g:0','rw:1:g:-01','rw:1:g:-9999999999999999','rw:1:g:-100\n','rw:1:c:short','rw:1:x:'+'a'.repeat(25),'rw:1:g:-100:extra'])assert.equal(validRuleWarningPolicyRoute(value),false,value);
 assert.equal(validRuleWarningPolicyRoute('rw:1:g:-100'),true);
});
const button=(screen:OwnerInlineScreen|null,prefix:string)=>{const b=screen?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b,'missing '+prefix);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'law-warning-policy-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=NOW;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation','navigation']);await policy.grant('100','301','chat.manage',CHAT,NOW+60*86400000);
  const rules=new TelegramGroupRules(store,policy,()=>now),ui=new TelegramRuleWarningPolicy(store,policy,()=>now),gateway=new FakeModerationGateway(),service=new ModerationService(store,policy,gateway,()=>now);
  const draft=await rules.preview('301','/setrules -100\nاحترام الأعضاء\nمنع الإعلانات');assert.ok(await rules.handle('301',button(draft,'rl:1:c:')));
  return {store,file,policy,rules,ui,gateway,service,time:(n:number)=>{now=n;},now:()=>now,configure:async(cap=2,seconds=60)=>{const d=await ui.preview('301','/rulewarnings -100 1 '+cap+' '+seconds);assert.ok(d);const saved=await ui.handle('301',button(d,'rw:1:c:'));assert.ok(saved);return saved;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' paragraph policy requires private confirmation and supports readback, cancellation and restart',async()=>{const f=await fixture();try{
  const preview=await f.ui.preview('301','/rulewarnings -100 1 2 60');assert.ok(preview);assert.equal(ruleWarningPolicy(await f.store.snapshot(),CHAT,'law_v1_p1_m1',NOW).status,'NONE');
  assert.equal(await f.ui.handle('100',button(preview,'rw:1:c:')),null);assert.ok(await f.ui.handle('301',button(preview,'rw:1:x:')));assert.equal(await f.ui.handle('301',button(preview,'rw:1:c:')),null);
  const saved=await f.configure();assert.equal(saved.access.epoch,protectionUIEpoch(await f.store.snapshot(),f.policy,'301',NOW));assert.ok(isValidTelegramInlineKeyboard(saved.keyboard));
  const read=await f.ui.handle('301',button(saved,'rw:1:g:'));assert.match(read!.text,/الفقرة 1: السقف 2 · المدة 60/u);assert.ok(await f.rules.handle('301',button(read,'rl:1:h:')));
  const reopened=new BotStore(f.file,{engine});assert.equal(ruleWarningPolicy(await reopened.snapshot(),CHAT,'law_v1_p1_m42',NOW).status,'CONFIGURED');assert.equal(ruleWarningPolicy(await reopened.snapshot(),CHAT,'law_v1_p2_m42',NOW).status,'NONE');
 }finally{await f.close();}});
 test(engine+' concurrent warnings obey one atomic paragraph cap and expiration does not rewrite or replay cases',async()=>{const f=await fixture();try{
  await f.configure(1,60);const results=await Promise.all([f.service.issueWarning('301',CHAT,'400','law_v1_p1_m41'),f.service.issueWarning('301',CHAT,'400','law_v1_p1_m42')]);assert.equal(results.filter(r=>r.status==='ADDED').length,1);
  let s=await f.store.snapshot();const warning=structuredClone(s.warnings[0]!);assert.equal(warning.expiresAt,NOW+60000);assert.equal(paragraphWarningCount(s,CHAT,'400','law_v1_p1_m99',NOW+59999),1);
  const review=new ModerationCommandReview(f.store,f.policy,f.service,f.now),blocked=await review.preview('301',CHAT,{kind:'warn',memberId:'400',reference:'law_v1_p1_m99'});assert.equal(blocked?.reason,'RULE_WARNING_CAP_REACHED');assert.equal(blocked?.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('mc:1:c:')),false);assert.ok(isValidTelegramInlineKeyboard(blocked!.keyboard));
  await f.service.addManualReason('301',CHAT,'400','independent','MUTE');const reasons=structuredClone((await f.store.snapshot()).moderationReasons);
  f.time(NOW+60000);assert.equal(warningActive(warning,f.now()),false);const fresh=await review.preview('301',CHAT,{kind:'warn',memberId:'400',reference:'law_v1_p1_m43'});assert.match(fresh!.text,/إنذارات هذه الفقرة المحتسبة: 0 من 1/u);assert.match(fresh!.text,/60 ثانية من إصدار الإنذار/u);assert.equal((await f.service.issueWarning('301',CHAT,'400','law_v1_p1_m43')).status,'ADDED');
  assert.equal((await f.service.issueWarning('301',CHAT,'400',warning.reference)).status,'NO_CHANGE');s=await f.store.snapshot();assert.deepEqual(s.warnings[0],warning);assert.deepEqual(s.moderationReasons,reasons);assert.equal(s.warnings.length,2);
  const home=await f.rules.handle('301','rl:1:h:0'),detail=await f.rules.handle('301',button(home,'rl:1:g:')),report=await f.rules.handle('301',button(detail,'rl:1:r:'));assert.match(report!.text,/إنذارات السجل الأسبوعي المنتهية دون إلغاء: 1/u);
 }finally{await f.close();}});
 test(engine+' policy edits preserve existing warning deadlines and invalidate old action previews',async()=>{const f=await fixture();try{
  await f.configure(3,60);await f.service.issueWarning('301',CHAT,'400','law_v1_p1_m41');
  const review=new ModerationCommandReview(f.store,f.policy,f.service,f.now),action=await review.preview('301',CHAT,{kind:'warn',memberId:'401',reference:'law_v1_p1_m42'});assert.ok(action);
  f.time(NOW+1000);await f.configure(2,120);assert.equal(await review.handle('301',button(action,'mc:1:c:')),null);
  await f.service.issueWarning('301',CHAT,'400','law_v1_p1_m43');const s=await f.store.snapshot();assert.equal(s.warnings[0]!.expiresAt,NOW+60000);assert.equal(s.warnings[1]!.expiresAt,NOW+121000);
 }finally{await f.close();}});
 test(engine+' expired, navigated, revoked and source-changed policy previews cannot commit',async()=>{
  for(const variant of ['expiry','navigation','grant','version','concurrent'] as const){const f=await fixture();try{
   const preview=await f.ui.preview('301','/rulewarnings -100 1 2 60');assert.ok(preview);const confirm=button(preview,'rw:1:c:');
   if(variant==='expiry')f.time(NOW+120000);if(variant==='navigation')await f.ui.cancel('301');if(variant==='grant')await f.store.transaction(s=>{s.grants[0]!.revoked=true;});
   if(variant==='version'){const d=await f.rules.preview('301','/setrules -100\nنسخة جديدة');await f.rules.handle('301',button(d,'rl:1:c:'));}
   if(variant==='concurrent')await f.configure(3,120);
   assert.equal(await f.ui.handle('301',confirm),null);
  }finally{await f.close();}}
 });
 test(engine+' malformed and ambiguous policy history blocks new warnings instead of falling back to legacy behavior',async()=>{
  for(const variant of ['duplicate','future','corrupt'] as const){const f=await fixture();try{
   await f.configure();await f.store.transaction(s=>{const a=s.audit.find(a=>a.updateKey.startsWith(RULE_WARNING_POLICY_PREFIX))!;if(variant==='duplicate')s.audit.push({...a});if(variant==='future')a.at=NOW+1;if(variant==='corrupt')a.reason='RULE_WARNING_POLICY:{}';});
   assert.equal(ruleWarningPolicy(await f.store.snapshot(),CHAT,'law_v1_p1_m42',NOW).status,'INVALID');assert.equal((await f.service.issueWarning('301',CHAT,'400','law_v1_p1_m42')).status,'DENIED');assert.equal((await f.store.snapshot()).warnings.length,0);
  }finally{await f.close();}}
 });
 test(engine+' legacy warnings and a new law version retain their original behavior',async()=>{const f=await fixture();try{
  await f.service.issueWarning('301',CHAT,'400','law_v1_p1_m41');await f.configure(2,60);const old=(await f.store.snapshot()).warnings[0]!;assert.equal(old.expiresAt,undefined);assert.equal(warningActive(old,NOW+30*86400000),true);
  const d=await f.rules.preview('301','/setrules -100\nنسخة جديدة');await f.rules.handle('301',button(d,'rl:1:c:'));assert.equal(ruleWarningPolicy(await f.store.snapshot(),CHAT,'law_v2_p1_m42',NOW).status,'NONE');
  assert.equal((await f.service.issueWarning('301',CHAT,'400','law_v2_p1_m42')).status,'ADDED');assert.equal((await f.store.snapshot()).warnings.at(-1)!.expiresAt,undefined);
 }finally{await f.close();}});
 test(engine+' transport exposes scoped policy buttons, confirms once and cancels on navigation',async()=>{const f=await fixture();try{
  const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),moderation:f.service,membership:async()=> 'VERIFIED',clock:f.now,botId:'rule-warning-policy',botUsername:'ManaratakBot'});
  let id=100;const tap=(data:string,actor=301)=>app.handle({update_id:id++,callback_query:{id:'policy_'+id,from:{id:actor,is_bot:false},data,message:{message_id:90,from:{id:999,is_bot:true},chat:{id:actor,type:'private'}}}});
  const input=(text:string)=>app.handle({update_id:id++,message:{message_id:id,from:{id:301,is_bot:false},chat:{id:301,type:'private'},text}});
  const select=(result:Awaited<ReturnType<typeof tap>>,prefix:string)=>{const b=result.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b,'missing '+prefix);return b.callback_data;};
  const home=await tap('rl:1:h:0'),detail=await tap(select(home,'rl:1:g:')),settings=await tap(select(detail,'rw:1:g:'));assert.equal(settings.status,'APPLIED');assert.ok(select(settings,'rl:1:h:'));
  const draft=await input('/rulewarnings -100 1 1 60'),confirm=select(draft,'rw:1:c:');assert.equal((await tap(confirm,400)).status,'DENIED');assert.equal((await tap(confirm)).status,'APPLIED');assert.equal((await tap(confirm)).status,'DENIED');
  const next=await input('/rulewarnings -100 1 2 120'),stale=select(next,'rw:1:c:');await tap('rl:1:h:0');assert.equal((await tap(stale)).status,'DENIED');
  assert.equal((await input('/rulewarnings -100 1 0 60')).status,'DENIED');assert.equal((await input('/rulewarnings -100 1 1 59')).status,'DENIED');
 }finally{await f.close();}});
}
