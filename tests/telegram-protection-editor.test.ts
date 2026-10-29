import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import type {ProtectionMessageType} from '../src/protection-rules.js';
import {protectionInlineRoute} from '../src/protection-inline-route.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
const NOW=1700000000000,CHAT='-100123';
const cb=(i:number,data:string,actor=100,group=false)=>({update_id:i,callback_query:{id:'rules_'+i,from:{id:actor,is_bot:false},data,
 message:{message_id:77,from:{id:999,is_bot:true},chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'}}}});
const msg=(i:number,text:string,actor=100)=>({update_id:i,message:{message_id:i,from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const route=(r:Result,prefix:string)=>{const found=r.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(found,'missing '+prefix);return found.callback_data;};
test('protection routes reject extra fields, ambiguous numbers and oversized selectors',()=>{
 for(const bad of ['pr:1:p:00','pr:1:g:0:0:abcdef0123456789','pr:1:a:0:1:abcdef0123456789:0:1:q',
  'pr:1:g:0:1:abcdef0123456789:other','pr:1:h\n','pr:2:h','pr:1:z:short','pr:1:'+('x'.repeat(65))])
  assert.equal(protectionInlineRoute(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'protection-editor-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy);
  await policy.approveChat('100',CHAT,['moderation']);
  const app=()=>new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education),
   faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),botId:'editor-local',botUsername:'ManaratakBot',clock:()=>now,
   membership:async()=>{throw Error('no network in editor');}});
  return {store,policy,app,setTime:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('link and media approved entries open the scoped editor without changing policies ('+engine+')',async()=>{
  const f=await fixture();try{
   for(const [i,data] of ['mi:1:i:02:05','mi:1:i:02:06'].entries()){
    const root=await f.app().handle(cb(i+1,data));
    assert.equal(root.status,'APPLIED');
    const group=await f.app().handle(cb(i+10,route(root,'pr:1:g:')));
    assert.ok(route(group,'pr:1:b:'));assert.ok(route(group,'pr:1:y:'));
   }
   assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
   assert.equal((await f.app().handle(cb(30,'mi:1:i:02:06',200))).status,'DENIED');
  }finally{await f.close();}
 });
 test('all-link rules start disabled and cannot duplicate the same target ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   const added=await f.app().handle(cb(3,route(group,'pr:1:b:')));
   assert.equal(added.status,'APPLIED');
   let cfg=(await f.store.snapshot()).protectionPolicies![0]!.policy;
   assert.equal(cfg.rules.length,1);assert.equal(cfg.rules[0]!.kind,'LINK');
   assert.equal(cfg.rules[0]!.enabled,false);assert.equal(cfg.mode,'OFF');
   assert.equal((cfg.rules[0] as {hosts:string}).hosts,'*');
   await f.app().handle(cb(4,route(added,'pr:1:b:')));
   cfg=(await f.store.snapshot()).protectionPolicies![0]!.policy;
   assert.equal(cfg.rules.length,1);assert.equal(cfg.revision,1);
  }finally{await f.close();}
 });
 test('specific link host input rejects URLs and credentials then saves a bounded host ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:j:')));
   for(const [i,bad] of ['https://evil.test/path','school.edu@evil.test','UPPER.TEST','evil.test\nother.test'].entries()){
    const retry=await f.app().handle(msg(i+4,bad));assert.equal(retry.reason,'PROTECTION_EDITOR_INPUT_REJECTED');
    assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
   }
   assert.equal((await f.app().handle(msg(10,'evil.test'))).status,'APPLIED');
   const rule=(await f.store.snapshot()).protectionPolicies![0]!.policy.rules[0]!;
   assert.equal(rule.kind,'LINK');assert.deepEqual((rule as {hosts:string[]}).hosts,['evil.test']);
   assert.equal(rule.enabled,false);assert.equal(rule.action,'REVIEW');
   assert.equal(JSON.stringify(await f.store.snapshot()).includes('school.edu@evil.test'),false);
  }finally{await f.close();}
 });
 test('type picker pages through every supported type and saves one disabled selected rule ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   const first=await f.app().handle(cb(3,route(group,'pr:1:y:')));
   assert.equal(first.plan!.inlineMarkup!.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('pr:1:n:')).length,8);
   const next=first.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pr:1:y:')&&b.callback_data.endsWith(':1'))!;
   assert.ok(next);const second=await f.app().handle(cb(4,next.callback_data));
   const choices=second.plan!.inlineMarkup!.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('pr:1:n:'));
   assert.equal(choices.length,5);assert.ok(isValidTelegramInlineKeyboard(second.plan!.inlineMarkup));
   const contact=choices[1]!;assert.match(contact.text,/اتصال/);
   const added=await f.app().handle(cb(5,contact.callback_data));
   assert.equal(added.status,'APPLIED');
   const rule=(await f.store.snapshot()).protectionPolicies![0]!.policy.rules[0]!;
   assert.equal(rule.kind,'TYPE');assert.equal((rule as {type:string}).type,'CONTACT');assert.equal(rule.enabled,false);
   assert.equal((await f.app().handle(cb(6,choices[0]!.callback_data))).status,'DENIED');
   const list=await f.app().handle(cb(7,route(added,'pr:1:l:')));
   const detail=await f.app().handle(cb(8,route(list,'pr:1:r:')));
   assert.match(detail.plan!.text,/اتصال/);assert.equal(detail.plan!.inlineMarkup!.inline_keyboard.flat().some(b=>b.callback_data.startsWith('pr:1:v:')),false);
  }finally{await f.close();}
 });
 test('allow-list controls validate domain and phrase inputs without persisting invalid values ('+engine+')',async()=>{
  const f=await fixture();try{
   const root=await f.app().handle(cb(1,'mi:1:i:02:12'));
   const group=await f.app().handle(cb(2,route(root,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:c:')));
   assert.equal((await f.app().handle(msg(4,'school.edu@evil.test'))).reason,'PROTECTION_EDITOR_INPUT_REJECTED');
   const saved=await f.app().handle(msg(5,'school.edu'));
   let cfg=(await f.store.snapshot()).protectionPolicies![0]!.policy;
   assert.deepEqual(cfg.allowedDomains,['school.edu']);assert.equal(cfg.mode,'OFF');
   await f.app().handle(cb(6,route(saved,'pr:1:u:')));
   assert.equal((await f.app().handle(msg(7,'درس طبي حساس'))).status,'APPLIED');
   cfg=(await f.store.snapshot()).protectionPolicies![0]!.policy;
   assert.deepEqual(cfg.allowedPhrases,['درس طبي حساس']);
   assert.equal(JSON.stringify(await f.store.snapshot()).includes('school.edu@evil.test'),false);
  }finally{await f.close();}
 });
 test('allow-list removal needs confirmation and rejects a reused stale confirmation ('+engine+')',async()=>{
  const f=await fixture();try{
   const root=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(root,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:c:')));
   const saved=await f.app().handle(msg(4,'school.edu'));
   const list=await f.app().handle(cb(5,route(saved,'pr:1:s:')));
   assert.match(list.plan!.text,/school.edu/);
   const preview=await f.app().handle(cb(6,route(list,'pr:1:q:')));
   assert.deepEqual((await f.store.snapshot()).protectionPolicies![0]!.policy.allowedDomains,['school.edu']);
   const confirm=route(preview,'pr:1:k:');
   assert.equal((await f.app().handle(cb(7,confirm))).status,'APPLIED');
   assert.deepEqual((await f.store.snapshot()).protectionPolicies![0]!.policy.allowedDomains,[]);
   assert.equal((await f.app().handle(cb(8,confirm))).status,'DENIED');
  }finally{await f.close();}
 });
 test('allow-list pending edits cannot survive permission revocation or duplicate a saved entry ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.policy.grant('100','200','chat.manage',CHAT,NOW+600000);
   let home=await f.app().handle(cb(1,'pr:1:h',200));
   let group=await f.app().handle(cb(2,route(home,'pr:1:g:'),200));
   await f.app().handle(cb(3,route(group,'pr:1:c:'),200));
   const saved=await f.app().handle(msg(4,'school.edu',200));
   await f.app().handle(cb(5,route(saved,'pr:1:c:'),200));
   assert.equal((await f.app().handle(msg(6,'school.edu',200))).reason,'PROTECTION_EDITOR_INPUT_REJECTED');
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.revision,1);
   await f.policy.revokeGrant('100','200','chat.manage',CHAT);
   assert.equal((await f.app().handle(msg(7,'secret.edu',200))).status,'DENIED');
   assert.equal(JSON.stringify(await f.store.snapshot()).includes('secret.edu'),false);
  }finally{await f.close();}
 });
 test('escaped long allow-list entries remain readable and paginated within Telegram limits ('+engine+')',async()=>{
  const f=await fixture();try{
   const values=Array.from({length:9},(_,i)=>'"'.repeat(119)+i);
   const service=new GroupProtectionPolicyService(f.store,f.policy,()=>NOW);
   await service.save('100',{chatId:CHAT,revision:1,mode:'OFF',rules:[],allowedDomains:[],allowedPhrases:values,exemptMemberIds:[]},f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const root=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(root,'pr:1:g:')));
   const open=group.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pr:1:s:')&&b.callback_data.endsWith(':2'))!;
   const first=await f.app().handle(cb(3,open.callback_data));
   assert.equal(first.status,'APPLIED');assert.ok(Buffer.byteLength(first.plan!.text)<=4096);
   assert.equal(first.plan!.inlineMarkup!.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('pr:1:q:')).length,8);
   const next=first.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.text.includes('التالي'))!;
   const second=await f.app().handle(cb(4,next.callback_data));
   assert.equal(second.plan!.inlineMarkup!.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('pr:1:q:')).length,1);
   assert.ok(isValidTelegramInlineKeyboard(second.plan!.inlineMarkup));
  }finally{await f.close();}
 });
 test('approved keyword button opens groups and persists a disabled reviewed word ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'mi:1:i:02:07'));
   assert.equal(home.status,'APPLIED');assert.ok(isValidTelegramInlineKeyboard(home.plan?.inlineMarkup));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   const prompt=await f.app().handle(cb(3,route(group,'pr:1:w:')));
   assert.match(prompt.plan?.text??'',/كلمة/);
   assert.equal((await f.app().handle(msg(4,'إعلان'))).status,'APPLIED');
   const saved=(await f.store.snapshot()).protectionPolicies?.[0]?.policy;
   assert.equal(saved?.mode,'OFF');assert.equal(saved?.rules.length,1);
   assert.deepEqual(saved?.rules.map(r=>[r.kind,r.enabled,r.action]),[['WORD',false,'REVIEW']]);
  }finally{await f.close();}
 });
 test('dry run evaluates a draft without storing student text or enabling rules ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:w:')));
   const added=await f.app().handle(msg(4,'إعلان'));
   await f.app().handle(cb(5,route(added,'pr:1:t:')));
   const before=(await f.store.snapshot()).protectionPolicies;
   const sample='إعلان PRIVATE_STUDENT_SAMPLE';
   const result=await f.app().handle(msg(6,sample));
   assert.equal(result.status,'APPLIED');assert.match(result.plan?.text??'',/مطابقة/);
   const state=await f.store.snapshot();assert.deepEqual(state.protectionPolicies,before);
   assert.equal(JSON.stringify(state).includes('PRIVATE_STUDENT_SAMPLE'),false);
  }finally{await f.close();}
 });
 test('scope revocation and foreign callbacks cannot save a pending word ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.policy.grant('100','200','chat.manage',CHAT,NOW+600000);
   const home=await f.app().handle(cb(1,'pr:1:h',200));
   const groupRoute=route(home,'pr:1:g:');
   assert.equal((await f.app().handle(cb(2,groupRoute,300))).status,'DENIED');
   assert.equal((await f.app().handle(cb(3,groupRoute,200,true))).status,'DENIED');
   const group=await f.app().handle(cb(4,groupRoute,200));
   await f.app().handle(cb(5,route(group,'pr:1:w:'),200));
   await f.policy.revokeGrant('100','200','chat.manage',CHAT);
   assert.equal((await f.app().handle(msg(6,'spam',200))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
  }finally{await f.close();}
 });
 test('invalid word retries safely and concurrent messages cannot append twice ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:w:')));
   const invalid=await f.app().handle(msg(4,'two words'));
   assert.equal(invalid.status,'APPLIED');assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
   await Promise.all([f.app().handle(msg(5,'spam')),f.app().handle(msg(6,'fraud'))]);
   assert.equal((await f.store.snapshot()).protectionPolicies?.[0]?.policy.rules.length,1);
  }finally{await f.close();}
 });
 test('restored expiry extension is rejected without saving an operator input ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:w:')));
   await f.store.transaction(s=>{s.wizards[0]!.expiresAt+=100000;});f.setTime(NOW+100000);
   assert.equal((await f.app().handle(msg(4,'must_not_save'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
  }finally{await f.close();}
 });
 test('existing custom rule identifiers cannot block adding a valid word ('+engine+')',async()=>{
  const f=await fixture();try{
   const service=new GroupProtectionPolicyService(f.store,f.policy,()=>NOW);
   await service.save('100',{chatId:CHAT,revision:1,mode:'OFF',rules:[{id:'draft',kind:'WORD',value:'old',enabled:false,action:'REVIEW'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:w:')));
   assert.equal((await f.app().handle(msg(4,'new'))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).protectionPolicies?.[0]?.policy.rules.length,2);
  }finally{await f.close();}
 });
 test('rule activation, proposed action and deletion confirmation update only the chosen local policy ('+engine+')',async()=>{
  const f=await fixture();try{
   let id=1;
   const home=await f.app().handle(cb(id++,'pr:1:h'));
   const group=await f.app().handle(cb(id++,route(home,'pr:1:g:')));
   await f.app().handle(cb(id++,route(group,'pr:1:f:')));
   let current=await f.app().handle(msg(id++,'عبارة اختبار'));
   let list=await f.app().handle(cb(id++,route(current,'pr:1:l:')));
   let detail=await f.app().handle(cb(id++,route(list,'pr:1:r:')));
   const proposedDelete=detail.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pr:1:a:')&&b.callback_data.endsWith(':d'))!;
   current=await f.app().handle(cb(id++,proposedDelete.callback_data));
   list=await f.app().handle(cb(id++,route(current,'pr:1:l:')));
   detail=await f.app().handle(cb(id++,route(list,'pr:1:r:')));
   current=await f.app().handle(cb(id++,route(detail,'pr:1:e:')));
   current=await f.app().handle(cb(id++,route(current,'pr:1:m:')));
   const cfg=(await f.store.snapshot()).protectionPolicies![0]!.policy;
   assert.equal(cfg.mode,'MONITOR');assert.equal(cfg.rules[0]?.enabled,true);assert.equal(cfg.rules[0]?.action,'DELETE');
   list=await f.app().handle(cb(id++,route(current,'pr:1:l:')));
   detail=await f.app().handle(cb(id++,route(list,'pr:1:r:')));
   const deletePreview=await f.app().handle(cb(id++,route(detail,'pr:1:d:')));
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.rules.length,1);
   const confirm=route(deletePreview,'pr:1:x:');
   assert.equal((await f.app().handle(cb(id++,confirm))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.rules.length,0);
   assert.equal((await f.app().handle(cb(id++,confirm))).status,'DENIED');
   assert.equal((await f.store.snapshot()).moderationOperations.length,0);
  }finally{await f.close();}
 });
 test('a policy revision changed during a prompt rejects its pending input ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:w:')));
   const service=new GroupProtectionPolicyService(f.store,f.policy,()=>NOW);
   await service.save('100',{chatId:CHAT,revision:1,mode:'OFF',rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   assert.equal((await f.app().handle(msg(4,'PRIVATE_UNSAVED_INPUT'))).status,'DENIED');
   assert.equal(JSON.stringify(await f.store.snapshot()).includes('PRIVATE_UNSAVED_INPUT'),false);
  }finally{await f.close();}
 });
 test('authorized staff enter the correct group editor from their existing staff card ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.policy.grant('100','200','chat.manage',CHAT,NOW+600000);
   const home=await f.app().handle(msg(1,'/staffinline',200));
   const card=await f.app().handle(cb(2,route(home,'ms:1:g:'),200));
   const editor=await f.app().handle(cb(3,route(card,'pr:1:g:'),200));
   assert.equal(editor.status,'APPLIED');assert.match(editor.plan?.text??'',/الكلمات والعبارات/);
  }finally{await f.close();}
 });
 test('an expiry or navigation to another inline area cancels input capture ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:w:')));
   await f.app().handle(cb(4,'mi:1:h'));
   await f.app().handle(msg(5,'must_not_save'));
   assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
   await f.app().handle(cb(6,route(group,'pr:1:w:')));f.setTime(NOW+300000);
   assert.equal((await f.app().handle(msg(7,'also_not_saved'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
  }finally{await f.close();}
 });
 test('ambiguous restored input sessions do not consume or store a private sample ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:w:')));
   await f.store.transaction(s=>{s.wizards.push(structuredClone(s.wizards[0]!));});
   assert.equal((await f.app().handle(msg(4,'PRIVATE_DUPLICATE_SESSION'))).status,'DENIED');
   const state=await f.store.snapshot();assert.ok(state.wizards.every(w=>w.status==='ACTIVE'));
   assert.equal(JSON.stringify(state).includes('PRIVATE_DUPLICATE_SESSION'),false);
  }finally{await f.close();}
 });
 test('editing a word preserves its identifier and chosen settings ('+engine+')',async()=>{
  const f=await fixture();try{
   const service=new GroupProtectionPolicyService(f.store,f.policy,()=>NOW);
   await service.save('100',{chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'stable',kind:'WORD',value:'old',enabled:true,action:'DELETE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   const list=await f.app().handle(cb(3,route(group,'pr:1:l:')));
   const detail=await f.app().handle(cb(4,route(list,'pr:1:r:')));
   await f.app().handle(cb(5,route(detail,'pr:1:v:')));
   assert.equal((await f.app().handle(msg(6,'new'))).status,'APPLIED');
   const rules=(await f.store.snapshot()).protectionPolicies![0]!.policy.rules;
   assert.deepEqual(rules,[{id:'stable',kind:'WORD',value:'new',enabled:true,action:'DELETE'}]);
  }finally{await f.close();}
 });
 test('queued editor screens are reauthorized before delivery after a staff grant is revoked ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.policy.grant('100','200','chat.manage',CHAT,NOW+600000);
   const home=await f.app().handle(cb(1,'pr:1:h',200));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:'),200));
   await f.policy.revokeGrant('100','200','chat.manage',CHAT);
   let sends=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:99};}},()=>NOW);
   assert.equal((await dispatcher.dispatch(group.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(sends,0);
   const job=(await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===group.deliveryKey)!;
   assert.equal(job.plan,undefined);assert.equal('adminUIAccess' in job,false);
  }finally{await f.close();}
 });
 test('a current editor reply delivers and its administrative witness is redacted ('+engine+')',async()=>{
  const f=await fixture();try{
   const result=await f.app().handle(cb(1,'pr:1:h'));
   const job=(await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===result.deliveryKey)!;
   assert.equal('adminUIAccess' in result,false);
   assert.equal(job.privateReplyKind,'ADMIN_SCOPED');
   let sends=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:99};}},()=>NOW);
   assert.equal((await dispatcher.dispatch(result.deliveryKey!)).status,'CONFIRMED');assert.equal(sends,1);
   const after=(await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===result.deliveryKey)!;
   assert.equal('adminUIAccess' in after,false);assert.equal(after.privateReplyKind,undefined);
  }finally{await f.close();}
 });
 test('queued administrative views reject stale epochs, clock rollback and extended expiry ('+engine+')',async()=>{
  for(const kind of ['CHANGED','ROLLBACK','EXPIRED','EXTENDED']){
   const f=await fixture();try{
    const result=await f.app().handle(cb(1,'pr:1:h'));
    if(kind==='CHANGED')await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
     chatId:CHAT,revision:1,mode:'OFF',rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
    },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
    if(kind==='EXTENDED')await f.store.transaction(s=>{s.telegramReplyJobs![0]!.adminUIAccess!.expiresAt++;});
    let sends=0;
    const at=kind==='ROLLBACK'?NOW-1:kind==='EXPIRED'?NOW+120000:NOW;
    const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:99};}},()=>at);
    assert.equal((await dispatcher.dispatch(result.deliveryKey!)).status,'FAILED_CONFIRMED',kind);assert.equal(sends,0);
   }finally{await f.close();}
  }
 });
 test('administrative origin cannot lose its guard or be recast as an unscoped private reply ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.app().handle(cb(1,'pr:1:h'));
   const before=await f.store.snapshot();
   await assert.rejects(f.store.transaction(s=>{delete s.telegramReplyJobs![0]!.adminUIAccess;}),/Unsupported state schema/);
   await assert.rejects(f.store.transaction(s=>{s.telegramReplyJobs![0]!.privateReplyKind='LOCAL';}),/Unsupported state schema/);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('monitor mode records one privacy-limited observation for a real incoming text update ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'word',kind:'WORD',value:'spam',enabled:true,action:'DELETE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const incoming={update_id:700,message:{message_id:700,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'spam PRIVATE_INCOMING_SAMPLE'}};
   await f.app().handle(incoming);await f.app().handle(incoming);
   const state=await f.store.snapshot();
   assert.equal(state.audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,1);
   assert.equal(state.moderationOperations.length,0);
   assert.equal(JSON.stringify(state).includes('PRIVATE_INCOMING_SAMPLE'),false);
  }finally{await f.close();}
 });
 test('hidden text-link entities are monitored and malformed UTF-16 ranges are not treated as clear ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'links',kind:'LINK',hosts:'*',enabled:true,action:'REVIEW'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const base={message_id:700,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false}};
   await f.app().handle({update_id:700,message:{...base,text:'اضغط هنا',entities:[{type:'text_link',offset:0,length:8,url:'https://external.test/'}]}});
   await f.app().handle({update_id:701,message:{...base,text:'😀x',entities:[{type:'url',offset:1,length:1}]}});
   const audit=(await f.store.snapshot()).audit;
   assert.equal(audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,1);
   assert.equal(audit.filter(a=>a.reason==='PROTECTION_MONITOR_INPUT_UNAVAILABLE').length,1);
  }finally{await f.close();}
 });
 test('revoked groups and protected operators do not enter incoming text analysis ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'word',kind:'WORD',value:'spam',enabled:true,action:'REVIEW'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const incoming=(id:number,actor:number)=>({update_id:id,message:{message_id:id,chat:{id:Number(CHAT),type:'supergroup'},from:{id:actor,is_bot:false},text:'spam'}});
   await f.app().handle(incoming(700,100));await f.policy.revokeChat('100',CHAT);await f.app().handle(incoming(701,300));
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_')).length,0);
  }finally{await f.close();}
 });
 test('incoming supported media are monitored once without downloading or storing payloads ('+engine+')',async()=>{
  const f=await fixture();try{
   const variants:[string,ProtectionMessageType,unknown][]=[
    ['photo','PHOTO',[{file_id:'PRIVATE_MEDIA_FILE_ID'}]],['video','VIDEO',{file_id:'PRIVATE_MEDIA_FILE_ID'}],
    ['animation','ANIMATION',{file_id:'PRIVATE_MEDIA_FILE_ID'}],['sticker','STICKER',{file_id:'PRIVATE_MEDIA_FILE_ID'}],
    ['document','DOCUMENT',{file_id:'PRIVATE_MEDIA_FILE_ID',file_name:'secret.bin'}],['audio','AUDIO',{file_id:'PRIVATE_MEDIA_FILE_ID'}],
    ['voice','VOICE',{file_id:'PRIVATE_MEDIA_FILE_ID'}],['video_note','VIDEO_NOTE',{file_id:'PRIVATE_MEDIA_FILE_ID'}],
    ['contact','CONTACT',{phone_number:'+967_PRIVATE_PHONE',first_name:'PRIVATE_CONTACT'}],
    ['location','LOCATION',{latitude:15.1,longitude:44.2}],['poll','POLL',{id:'PRIVATE_POLL_ID',question:'PRIVATE_POLL_QUESTION',options:[{text:'yes'},{text:'no'}]}]
   ];
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:variants.map(([_,type])=>({id:type,kind:'TYPE' as const,type,enabled:true,action:'DELETE' as const})),allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   for(const [i,[field,_,value]] of variants.entries()){
    const incoming={update_id:800+i,message:{message_id:800+i,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},[field]:value}};
    const result=await f.app().handle(incoming);assert.equal(result.plan,undefined);
    assert.equal((await f.app().handle(incoming)).status,'DUPLICATE');
   }
   const state=await f.store.snapshot();
   assert.equal(state.audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,11);
   for(const secret of ['PRIVATE_MEDIA_FILE_ID','+967_PRIVATE_PHONE','PRIVATE_CONTACT','PRIVATE_POLL_ID','PRIVATE_POLL_QUESTION'])assert.equal(JSON.stringify(state).includes(secret),false,secret);
   assert.equal(state.moderationOperations.length,0);
  }finally{await f.close();}
 });
 test('caption, hidden link and media-type matches combine into one strongest observation ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'photo',kind:'TYPE',type:'PHOTO',enabled:true,action:'DELETE'},
     {id:'word',kind:'WORD',value:'spam',enabled:true,action:'WARN'},{id:'link',kind:'LINK',hosts:'*',enabled:true,action:'MUTE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const incoming={update_id:850,message:{message_id:850,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},
    photo:[{file_id:'PRIVATE_PHOTO_ID'}],caption:'spam PRIVATE_CAPTION',caption_entities:[{type:'text_link',offset:5,length:15,url:'https://private.test/'}]}};
   await f.app().handle(incoming);
   const audit=(await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH'));
   assert.equal(audit.length,1);assert.match(audit[0]!.reason,/action=MUTE;rules=3/);
   assert.equal(JSON.stringify(await f.store.snapshot()).includes('PRIVATE_'),false);
  }finally{await f.close();}
 });
 test('ambiguous media and private media cannot invoke group monitoring ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'photo',kind:'TYPE',type:'PHOTO',enabled:true,action:'DELETE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const base={message_id:870,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},photo:[{file_id:'PRIVATE_ID'}]};
   for(const [i,extra] of [{text:'/ban x'},{video:{file_id:'OTHER'}},{photo:[]},{photo:[null]},{caption:42},{caption:'x'.repeat(4097)},{caption:'x\u0000y'},{sender_chat:{id:Number(CHAT)}}].entries()){
    assert.equal((await f.app().handle({update_id:870+i,message:{...base,...extra}})).status,'DENIED');
   }
   await f.app().handle({update_id:880,message:{...base,chat:{id:300,type:'private'}}});
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,0);
  }finally{await f.close();}
 });
 test('media monitoring respects allow-list boundaries and invalid caption entities ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'photo',kind:'TYPE',type:'PHOTO',enabled:true,action:'DELETE'},
     {id:'word',kind:'WORD',value:'حساس',enabled:true,action:'WARN'},{id:'link',kind:'LINK',hosts:'*',enabled:true,action:'MUTE'}],
     allowedDomains:['school.edu'],allowedPhrases:['درس طبي حساس'],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const base={message_id:900,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},photo:[{file_id:'HIDDEN_FILE_ID'}]};
   await f.app().handle({update_id:900,message:{...base,caption:'درس طبي حساس https://school.edu/lesson'}});
   await f.app().handle({update_id:901,message:{...base,caption:'😀',caption_entities:[{type:'url',offset:1,length:1}]}});
   const audit=(await f.store.snapshot()).audit;
   assert.equal(audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,1);
   assert.ok(audit.some(a=>a.reason.endsWith('action=DELETE;rules=1')));
   assert.equal(audit.filter(a=>a.reason==='PROTECTION_MONITOR_INPUT_UNAVAILABLE').length,1);
   await f.policy.revokeChat('100',CHAT);
   await f.app().handle({update_id:902,message:{...base,caption:'حساس'}});
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,1);
  }finally{await f.close();}
 });
 test('Telegram animation with its compatibility document is classified once as animation ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'animation',kind:'TYPE',type:'ANIMATION',enabled:true,action:'REVIEW'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   await f.app().handle({update_id:950,message:{message_id:950,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},animation:{file_id:'ANIMATION_ID'},document:{file_id:'ANIMATION_ID'}}});
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,1);
  }finally{await f.close();}
 });
 test('edited group text is monitored without executing its command or replying ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'word',kind:'WORD',value:'spam',enabled:true,action:'DELETE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const incoming={update_id:1000,edited_message:{message_id:10,edit_date:Math.floor(NOW/1000),chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'/warn spam PRIVATE_EDIT_TEXT',reply_to_message:{message_id:9,from:{id:400,is_bot:false}}}};
   const result=await f.app().handle(incoming);assert.equal(result.status,'IGNORED');assert.equal(result.plan,undefined);
   assert.equal((await f.app().handle(incoming)).status,'DUPLICATE');
   const state=await f.store.snapshot();assert.equal(state.audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,1);
   assert.equal(state.moderationOperations.length,0);assert.equal(JSON.stringify(state).includes('PRIVATE_EDIT_TEXT'),false);
  }finally{await f.close();}
 });
 test('edited media captions use the same monitor and never enter admin upload ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'word',kind:'WORD',value:'spam',enabled:true,action:'DELETE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const result=await f.app().handle({update_id:1001,edited_message:{message_id:10,edit_date:Math.floor(NOW/1000),chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},
    document:{file_id:'PRIVATE_EDIT_FILE_ID',file_name:'config.json'},caption:'/upload private spam PRIVATE_EDIT_CAPTION'}});
   assert.equal(result.plan,undefined);const state=await f.store.snapshot();
   assert.equal(state.audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH')).length,1);
   assert.equal(state.importRuns.length,0);assert.equal(JSON.stringify(state).includes('PRIVATE_EDIT_CAPTION'),false);
   assert.equal(JSON.stringify(state).includes('PRIVATE_EDIT_FILE_ID'),false);
  }finally{await f.close();}
 });
 test('private, malformed or ambiguous edit envelopes cannot enter monitoring ('+engine+')',async()=>{
  const f=await fixture();try{
   const base={message_id:10,edit_date:Math.floor(NOW/1000),chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'spam'};
   const bodies=[{edited_message:{...base,chat:{id:300,type:'private'}}},{edited_message:{...base,edit_date:0}},
    {edited_message:{...base,message_id:-1}},{edited_message:{...base,edit_date:'now'}},{edited_message:{...base,forward_origin:{type:'user'}}},
    {edited_message:base,message:{...base,text:'/start'}},{edited_message:base,callback_query:{id:'fake'}}];
   for(const [i,body] of bodies.entries())assert.equal((await f.app().handle({update_id:1010+i,...body})).status,'DENIED');
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_')).length,0);
  }finally{await f.close();}
 });
 test('a forwarded command is monitored only and retains its original content type ('+engine+')',async()=>{
  const f=await fixture();try{
   await new GroupProtectionPolicyService(f.store,f.policy,()=>NOW).save('100',{
    chatId:CHAT,revision:1,mode:'MONITOR',rules:[{id:'forward',kind:'FORWARD',enabled:true,action:'REVIEW'},{id:'photo',kind:'TYPE',type:'PHOTO',enabled:true,action:'DELETE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },f.policy.chatRevision(await f.store.snapshot(),CHAT),0);
   const base={message_id:1100,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false}};
   const origins=[{type:'user',date:1700000000,sender_user:{id:400,first_name:'PRIVATE_FORWARD_NAME'}},{type:'hidden_user',date:1700000000,sender_user_name:'PRIVATE_FORWARD_NAME'},
    {type:'chat',date:1700000000,sender_chat:{id:-100400,title:'PRIVATE_CHAT_TITLE'}},{type:'channel',date:1700000000,chat:{id:-100400,title:'PRIVATE_CHAT_TITLE'},message_id:1}];
   for(const [i,origin] of origins.entries()){
    const result=await f.app().handle({update_id:1100+i,message:{...base,text:'/ban private-case',forward_origin:origin}});
    assert.equal(result.status,'DENIED');assert.equal(result.plan,undefined);
   }
   await f.app().handle({update_id:1105,message:{...base,photo:[{file_id:'PRIVATE_FORWARD_PHOTO'}],forward_date:1700000000}});
   const state=await f.store.snapshot(),matches=state.audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH'));
   assert.equal(matches.length,5);assert.ok(matches.some(a=>a.reason.endsWith('action=DELETE;rules=2')));
   assert.equal(state.moderationOperations.length,0);
   for(const secret of ['PRIVATE_FORWARD_NAME','PRIVATE_CHAT_TITLE','PRIVATE_FORWARD_PHOTO'])assert.equal(JSON.stringify(state).includes(secret),false);
  }finally{await f.close();}
 });
 test('forward monitoring refuses malformed origins, private forwards and linked-channel automatic forwards ('+engine+')',async()=>{
  const f=await fixture();try{
   const base={message_id:1200,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'sample'};
   for(const [i,extra] of [{forward_origin:{}},{forward_origin:{type:'unknown',date:1}},{forward_origin:{type:'user',date:-1}},
    {forward_date:'today'},{forward_origin:{type:'user',date:1},forward_date:2},{forward_date:1,is_automatic_forward:true},
    {forward_date:1,chat:{id:300,type:'private'}},{forward_date:1,sender_chat:{id:-100400}},{forward_date:1,via_bot:{id:400}}].entries()){
    assert.equal((await f.app().handle({update_id:1200+i,message:{...base,...extra}})).status,'DENIED');
   }
  }finally{await f.close();}
 });
 test('the forwarding policy is configurable from the scoped type picker ('+engine+')',async()=>{
  const f=await fixture();try{
   const root=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(root,'pr:1:g:')));
   const first=await f.app().handle(cb(3,route(group,'pr:1:y:')));
   const next=first.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.text.includes('التالي'))!;
   const second=await f.app().handle(cb(4,next.callback_data));
   const forward=second.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.text==='إعادة توجيه')!;
   const added=await f.app().handle(cb(5,forward.callback_data));assert.equal(added.status,'APPLIED');
   const rule=(await f.store.snapshot()).protectionPolicies![0]!.policy.rules[0]!;
   assert.equal(rule.kind,'FORWARD');assert.equal(rule.enabled,false);assert.equal(rule.action,'REVIEW');
   const list=await f.app().handle(cb(6,route(added,'pr:1:l:')));
   const detail=await f.app().handle(cb(7,route(list,'pr:1:r:')));
   assert.match(detail.plan!.text,/معاد توجيهها/);
  }finally{await f.close();}
 });
 test('home cancels a pending editor before further private text ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(cb(1,'pr:1:h'));
   const group=await f.app().handle(cb(2,route(home,'pr:1:g:')));
   await f.app().handle(cb(3,route(group,'pr:1:w:')));
   await f.app().handle(msg(4,'🏠 الرئيسية'));
   await f.app().handle(msg(5,'not_saved'));
   assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
  }finally{await f.close();}
 });
}
