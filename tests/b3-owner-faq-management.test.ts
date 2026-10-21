import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {parseOwnerFAQAction,parseOwnerFAQPage} from '../src/telegram-owner-faq.js';
import {faqReviewFingerprint} from '../src/faq-review.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
const OWNER='100',STUDENT='300',GROUP='-100123',OTHER='-100456';
const msg=(id:number,text:string,actor=100,group=false)=>({update_id:id,message:{
 message_id:id,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-faq-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER);
 const edu=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,edu);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant','publishing']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 await policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION');
 await edu.createCategory(OWNER,{id:'scholarships',scope:GROUP,title:'منح <الرسمية> & دول',order:1});
 const resourceId=randomUUID();
 await store.transaction(s=>s.educationResources.push({
  id:resourceId,scope:GROUP,categoryId:'scholarships',
  title:'Published resource',university:'University',cycle:'2026',degree:'Bachelor',seats:1,
  sourceImportId:randomUUID(),sourceLocator:'test-source',reviewedBy:OWNER,status:'PUBLISHED'
 }));
 const draft=await faq.submit(OWNER,GROUP,{
  question:'ما المنح <المميزة>؟',aliases:['المنح الرسمية'],
  answer:'تفاصيل & روابط معتمدة <لا ترسل الجواز>',sourceResourceId:resourceId
 });
 const second=await faq.submit(OWNER,GROUP,{question:'مواعيد الاختبارات؟',answer:'راجع الجامعة',sourceResourceId:resourceId});
 const app=()=>new TelegramUpdateApplication({store,policy,education:edu,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,store,policy,edu,faq,app,resourceId,draft,second,close:()=>rm(dir,{recursive:true,force:true})};
}
test('B3 owner dashboard exposes functional FAQ review screen and safely bounded real buttons',async()=>{
 const f=await fixture();try{
  const root=await f.app().handle(msg(1,'🔐 لوحة المالك'));
  assert.ok(buttons(root).includes(ownerMenuLabels.faq));
  assert.equal(isValidTelegramReplyKeyboard(root.plan?.replyMarkup),true);
  const list=await f.app().handle(msg(2,ownerMenuLabels.faq));
  assert.equal(list.status,'APPLIED');assert.match(list.plan?.text??'',/الأسئلة الشائعة/);
  assert.equal(buttons(list).filter(s=>s.startsWith('❓ سؤال · ')).length,2);
  assert.equal(isValidTelegramReplyKeyboard(list.plan?.replyMarkup),true);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': two-stage FAQ draft approval makes approved group answer usable, with exactly one audit',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.faq.answerGroup(STUDENT,GROUP,f.draft.question,true)).status,'NO_MATCH');
   const detail=await f.app().handle(msg(3,'❓ سؤال · '+f.draft.id));
   assert.equal(detail.status,'APPLIED');
   assert.match(detail.plan?.text??'',/المنح &lt;المميزة&gt;/);
   assert.match(detail.plan?.text??'',/&amp; روابط/);
   const review=buttons(detail).find(x=>x.startsWith('🧾 معاينة اعتماد FAQ · '))!;
   const snap=await f.store.snapshot();
   const page=await f.app().handle(msg(4,review));
   assert.equal(page.status,'APPLIED');
   assert.deepEqual((await f.store.snapshot()).faqEntries,snap.faqEntries);
   const confirm=buttons(page).find(x=>x.startsWith('✅ تأكيد اعتماد FAQ · '))!;
   const approved=await f.app().handle(msg(5,confirm));
   assert.equal(approved.status,'APPLIED');
   assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===f.draft.id)!.status,'APPROVED');
   const answer=await f.faq.answerGroup(STUDENT,GROUP,f.draft.question,true);
   assert.equal(answer.status,'ANSWER');
   assert.equal((await f.app().handle(msg(6,confirm))).status,'DENIED');
   assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='FAQ_OWNER_APPROVED').length,1);
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
}
test('B3 deliberate FAQ archive stops answers without touching original source or Telegram',async()=>{
 const f=await fixture('sqlite');try{
  await f.faq.approve(OWNER,f.draft.id);
  const detail=await f.app().handle(msg(10,'❓ سؤال · '+f.draft.id));
  const review=buttons(detail).find(x=>x.startsWith('🗃️ معاينة أرشفة FAQ · '))!;
  const view=await f.app().handle(msg(11,review));
  assert.equal(view.status,'APPLIED');
  assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===f.draft.id)!.status,'APPROVED');
  const confirm=buttons(view).find(x=>x.startsWith('⛔ تأكيد أرشفة FAQ · '))!;
  assert.equal((await f.app().handle(msg(12,confirm))).status,'APPLIED');
  assert.equal((await f.faq.answerGroup(STUDENT,GROUP,f.draft.question,true)).status,'NO_MATCH');
  assert.equal((await f.store.snapshot()).educationResources.find(x=>x.id===f.resourceId)!.status,'PUBLISHED');
  assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='FAQ_OWNER_ARCHIVED').length,1);
  assert.equal((await f.app().handle(msg(13,confirm))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 FAQ approval must recheck current published source and enabled parent category at confirmation',async()=>{
 const f=await fixture();try{
  const d=await f.app().handle(msg(20,'❓ سؤال · '+f.draft.id));
  const p=await f.app().handle(msg(21,buttons(d).find(x=>x.startsWith('🧾 معاينة اعتماد FAQ · '))!));
  const confirm=buttons(p).find(x=>x.startsWith('✅ تأكيد اعتماد FAQ · '))!;
  await f.edu.setCategoryEnabled(OWNER,'scholarships',false);
  assert.equal((await f.app().handle(msg(22,confirm))).status,'DENIED');
  assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===f.draft.id)!.status,'DRAFT');
  await f.edu.setCategoryEnabled(OWNER,'scholarships',true);
  assert.equal((await f.app().handle(msg(23,confirm))).status,'DENIED');
  const fresh=await f.app().handle(msg(24,'❓ سؤال · '+f.draft.id));
  const p2=await f.app().handle(msg(25,buttons(fresh).find(x=>x.startsWith('🧾 معاينة اعتماد FAQ · '))!));
  await f.edu.archiveResource(OWNER,f.resourceId);
  assert.equal((await f.app().handle(msg(26,buttons(p2).find(x=>x.startsWith('✅ تأكيد اعتماد FAQ · '))!))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 owner FAQ confirmation rejected after group revoke/reapprove even with identical grants',async()=>{
 const f=await fixture();try{
  const d=await f.app().handle(msg(30,'❓ سؤال · '+f.draft.id));
  const preview=await f.app().handle(msg(31,buttons(d).find(x=>x.startsWith('🧾 معاينة اعتماد FAQ · '))!));
  const confirm=buttons(preview).find(x=>x.startsWith('✅ تأكيد اعتماد FAQ · '))!;
  await f.policy.revokeChat(OWNER,GROUP);
  assert.equal((await f.app().handle(msg(32,confirm))).status,'DENIED');
  await f.policy.approveChat(OWNER,GROUP,['navigation','assistant','publishing']);
  assert.equal((await f.app().handle(msg(33,confirm))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 changed FAQ content or status invalidates old owner approval token',async()=>{
 const f=await fixture();try{
  const d=await f.app().handle(msg(40,'❓ سؤال · '+f.draft.id));
  const preview=await f.app().handle(msg(41,buttons(d).find(x=>x.startsWith('🧾 معاينة اعتماد FAQ · '))!));
  const confirm=buttons(preview).find(x=>x.startsWith('✅ تأكيد اعتماد FAQ · '))!;
  await f.store.transaction(s=>{s.faqEntries.find(x=>x.id===f.draft.id)!.answer='new answer';});
  assert.equal((await f.app().handle(msg(42,confirm))).status,'DENIED');
  assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===f.draft.id)!.status,'DRAFT');
 }finally{await f.close();}
});
test('B3 FAQ owner list pages through 13 records and rejects malformed or stale navigation',async()=>{
 const f=await fixture();try{
  for(let i=0;i<11;i++)await f.faq.submit(OWNER,GROUP,{
   question:'سؤال رقم '+i,answer:'جواب '+i,sourceResourceId:f.resourceId
  });
  const first=await f.app().handle(msg(50,ownerMenuLabels.faq));
  assert.match(first.plan?.text??'',/صفحة 1 من 2/);
  assert.equal(buttons(first).filter(x=>x.startsWith('❓ سؤال · ')).length,10);
  const second=await f.app().handle(msg(51,'➡️ التالي · o:f:1'));
  assert.match(second.plan?.text??'',/صفحة 2 من 2/);
  assert.equal(buttons(second).filter(x=>x.startsWith('❓ سؤال · ')).length,3);
  assert.equal(isValidTelegramReplyKeyboard(second.plan?.replyMarkup),true);
  assert.equal((await f.app().handle(msg(52,'⬅️ السابق · o:f:0'))).status,'APPLIED');
  for(const [i,cmd] of ['➡️ التالي · o:f:0','⬅️ السابق · o:f:1',
   '➡️ التالي · o:f:01','➡️ التالي · o:f:999'].entries()){
   assert.equal((await f.app().handle(msg(60+i,cmd))).status,'DENIED');
  }
 }finally{await f.close();}
});
test('B3 copied FAQ actions are denied to student and delegated staff and cannot be sent from group',async()=>{
 const f=await fixture();try{
  await f.policy.grant(OWNER,'200','content.publish',GROUP,Date.now()+100000);
  const d=await f.app().handle(msg(80,'❓ سؤال · '+f.draft.id));
  const review=buttons(d).find(x=>x.startsWith('🧾 معاينة اعتماد FAQ · '))!;
  const p=await f.app().handle(msg(81,review));
  const confirm=buttons(p).find(x=>x.startsWith('✅ تأكيد اعتماد FAQ · '))!;
  for(const [i,cmd] of [ownerMenuLabels.faq,review,confirm].entries()){
   for(const actor of [200,300]){
    const result=await f.app().handle(msg(90+i*5+actor,cmd,actor));
    assert.equal(result.status,'DENIED');assert.equal(result.plan,undefined);
   }
  }
  assert.equal((await f.app().handle(msg(160,confirm,100,true))).plan,undefined);
  assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===f.draft.id)!.status,'DRAFT');
 }finally{await f.close();}
});
test('B3 FAQ action parser and direct transaction reject malformed commands, unauthorized owner and old source',async()=>{
 const f=await fixture();try{
  const state=await f.store.snapshot(),q=state.faqEntries.find(x=>x.id===f.draft.id)!;
  const fp=faqReviewFingerprint(state,q);
  assert.deepEqual(parseOwnerFAQAction('❓ سؤال · '+q.id),{kind:'detail',id:q.id});
  for(const t of ['✅ تأكيد اعتماد FAQ · '+q.id+':'+fp+':01',
   '✅ تأكيد اعتماد FAQ · '+q.id+':'+fp+':-1',
   '✅ تأكيد اعتماد FAQ · '+q.id+':'+fp+':1\n',
   '✅ تفعيل FAQ · '+q.id+':'+fp+':1',
   '❓ سؤال · '+q.id+' extra'])assert.equal(parseOwnerFAQAction(t),null);
  assert.equal(parseOwnerFAQPage('➡️ التالي · o:f:01'),null);
  await assert.rejects(f.faq.transitionIfCurrent(STUDENT,q.id,'APPROVED',fp,1),/OWNER_ONLY/);
  await f.policy.revokeChat(OWNER,GROUP);
  await assert.rejects(f.faq.transitionIfCurrent(OWNER,q.id,'APPROVED',fp,1),/FAQ_REVIEW_STALE/);
 }finally{await f.close();}
});
