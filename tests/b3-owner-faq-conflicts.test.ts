import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {faqReviewFingerprint,faqApprovalConflicts} from '../src/faq-review.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
const OWNER='100',GROUP='-100123';
const msg=(n:number,text:string,actor=100)=>({update_id:n,message:{message_id:n,
 chat:{id:actor,type:'private'},from:{id:actor,is_bot:false},text}});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-faq-conflicts-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'data.sqlite':'data.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
 await policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION');
 await education.createCategory(OWNER,{id:'scholarships',scope:GROUP,title:'منح دراسية',order:1});
 const resourceId=randomUUID();
 await store.transaction(s=>s.educationResources.push({
  id:resourceId,scope:GROUP,categoryId:'scholarships',title:'Opportunity',
  university:'University',cycle:'2026',degree:'Bachelor',seats:1,
  sourceImportId:randomUUID(),sourceLocator:'test',reviewedBy:OWNER,status:'PUBLISHED'
 }));
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {store,policy,education,faq,app,resourceId,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': duplicated normalized question/alias cannot be approved through owner action',async()=>{
  const f=await fixture(engine);try{
   const first=await f.faq.submit(OWNER,GROUP,{
    question:'كيف أقدم على المنحة؟',aliases:['خطوات التقديم'],
    answer:'راجع صفحة التقديم',sourceResourceId:f.resourceId
   });
   const second=await f.faq.submit(OWNER,GROUP,{
    question:'فرص جديدة',aliases:[' خطوات التقديم ! '],
    answer:'جواب آخر لا نعتمده',sourceResourceId:f.resourceId
   });
   await f.faq.approve(OWNER,first.id);
   const state=await f.store.snapshot();
   assert.equal(faqApprovalConflicts(state,state.faqEntries.find(x=>x.id===second.id)!),1);
   const detail=await f.app().handle(msg(1,'❓ سؤال · '+second.id));
   assert.equal(detail.status,'APPLIED');
   assert.match(detail.plan?.text??'',/تعارض|تكرار/);
   assert.ok(!buttons(detail).some(x=>x.startsWith('🧾 معاينة اعتماد FAQ · ')));
   assert.ok(buttons(detail).some(x=>x.startsWith('🗃️ معاينة أرشفة FAQ · ')));
   assert.equal(isValidTelegramReplyKeyboard(detail.plan?.replyMarkup),true);
   const fp=faqReviewFingerprint(state,state.faqEntries.find(x=>x.id===second.id)!);
   await assert.rejects(f.faq.transitionIfCurrent(OWNER,second.id,'APPROVED',fp,1),/FAQ_REVIEW_COLLISION/);
   assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===second.id)!.status,'DRAFT');
   assert.equal((await f.faq.answerGroup('300',GROUP,'خطوات التقديم',true)).status,'ANSWER');
  }finally{await f.close();}
 });
}
test('B3 owner may review/archive a DRAFT with invalid source without publishing or releasing unrelated resources',async()=>{
 const f=await fixture();try{
  const draft=await f.faq.submit(OWNER,GROUP,{
   question:'سؤال قديم',answer:'نص قديم',sourceResourceId:f.resourceId
  });
  await f.education.setCategoryEnabled(OWNER,'scholarships',false);
  const detail=await f.app().handle(msg(11,'❓ سؤال · '+draft.id));
  assert.equal(detail.status,'APPLIED');
  assert.ok(buttons(detail).some(x=>x.startsWith('🗃️ معاينة أرشفة FAQ · ')));
  assert.equal(buttons(detail).some(x=>x.startsWith('🧾 معاينة اعتماد FAQ · ')),false);
  const review=await f.app().handle(msg(12,buttons(detail).find(x=>x.startsWith('🗃️ معاينة أرشفة FAQ · '))!));
  assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===draft.id)!.status,'DRAFT');
  const confirm=buttons(review).find(x=>x.startsWith('⛔ تأكيد أرشفة FAQ · '))!;
  assert.equal((await f.app().handle(msg(13,confirm))).status,'APPLIED');
  assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===draft.id)!.status,'ARCHIVED');
  assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
  assert.equal((await f.app().handle(msg(14,confirm))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 concurrent approval of conflicting FAQ during review invalidates old owner confirmation atomically',async()=>{
 const f=await fixture('sqlite');try{
  const first=await f.faq.submit(OWNER,GROUP,{question:'Scholarship?',answer:'A',sourceResourceId:f.resourceId});
  const second=await f.faq.submit(OWNER,GROUP,{
   question:'المنح',aliases:['scholarship'],answer:'B',sourceResourceId:f.resourceId
  });
  const detail=await f.app().handle(msg(21,'❓ سؤال · '+second.id));
  const preview=await f.app().handle(msg(22,buttons(detail).find(x=>x.startsWith('🧾 معاينة اعتماد FAQ · '))!));
  const confirm=buttons(preview).find(x=>x.startsWith('✅ تأكيد اعتماد FAQ · '))!;
  await f.faq.approve(OWNER,first.id);
  assert.equal((await f.app().handle(msg(23,confirm))).status,'DENIED');
  assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===second.id)!.status,'DRAFT');
  assert.equal((await f.faq.answerGroup('300',GROUP,'Scholarship?',true)).status,'ANSWER');
 }finally{await f.close();}
});
test('B3 resolving an approved FAQ collision by archiving old answer permits a new draft after fresh review',async()=>{
 const f=await fixture();try{
  const old=await f.faq.submit(OWNER,GROUP,{
   question:'Visa?',answer:'Old',sourceResourceId:f.resourceId
  });
  const newer=await f.faq.submit(OWNER,GROUP,{
   question:'New question',aliases:['Visa?'],answer:'Updated',sourceResourceId:f.resourceId
  });
  await f.faq.approve(OWNER,old.id);
  await f.faq.archive(OWNER,old.id);
  const details=await f.app().handle(msg(30,'❓ سؤال · '+newer.id));
  const review=await f.app().handle(msg(31,buttons(details).find(x=>x.startsWith('🧾 معاينة اعتماد FAQ · '))!));
  const confirm=buttons(review).find(x=>x.startsWith('✅ تأكيد اعتماد FAQ · '))!;
  assert.equal((await f.app().handle(msg(32,confirm))).status,'APPLIED');
  assert.deepEqual((await f.faq.answerGroup('300',GROUP,'Visa?',true)),{
   status:'ANSWER',answer:'Updated',sourceId:f.resourceId
  });
 }finally{await f.close();}
});
test('B3 owner draft archival cannot be forged by staff, even with content.publish delegation',async()=>{
 const f=await fixture();try{
  const draft=await f.faq.submit(OWNER,GROUP,{question:'Draft?',answer:'Draft',sourceResourceId:f.resourceId});
  await f.policy.grant(OWNER,'200','content.publish',GROUP,Date.now()+100000);
  const detail=await f.app().handle(msg(40,'❓ سؤال · '+draft.id));
  const review=await f.app().handle(msg(41,buttons(detail).find(x=>x.startsWith('🗃️ معاينة أرشفة FAQ · '))!));
  const confirmation=buttons(review).find(x=>x.startsWith('⛔ تأكيد أرشفة FAQ · '))!;
  assert.equal((await f.app().handle(msg(42,confirmation,200))).status,'DENIED');
  assert.equal((await f.store.snapshot()).faqEntries.find(x=>x.id===draft.id)!.status,'DRAFT');
 }finally{await f.close();}
});
test('B3 conflict checker scopes results and ignores unrelated archived/draft FAQ aliases',async()=>{
 const f=await fixture();try{
  const a=await f.faq.submit(OWNER,GROUP,{question:'Which university?',answer:'A',sourceResourceId:f.resourceId});
  const b=await f.faq.submit(OWNER,GROUP,{question:'Different',aliases:['which university!'],answer:'B',sourceResourceId:f.resourceId});
  let state=await f.store.snapshot();
  assert.equal(faqApprovalConflicts(state,state.faqEntries.find(x=>x.id===b.id)!),0);
  await f.faq.approve(OWNER,a.id);
  state=await f.store.snapshot();
  assert.equal(faqApprovalConflicts(state,state.faqEntries.find(x=>x.id===b.id)!),1);
  await f.faq.archive(OWNER,a.id);
  state=await f.store.snapshot();
  assert.equal(faqApprovalConflicts(state,state.faqEntries.find(x=>x.id===b.id)!),0);
 }finally{await f.close();}
});
