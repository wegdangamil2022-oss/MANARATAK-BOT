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
import {menuLabels,isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
import {privateFAQBrowseLabel,parsePrivateFAQPage,parsePrivateFAQSelection,privateFAQButton} from '../src/telegram-private-faq.js';
const OWNER='100',STUDENT=300,GROUP='-100123';
const msg=(id:number,text:string,actor=STUDENT,group=false)=>({
 update_id:id,message:{message_id:id,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-faq-student-browse-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'store.sqlite':'store.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
 await education.createCategory(OWNER,{id:'guide',scope:'private',title:'دليل المنح',order:1});
 await education.createCategory(OWNER,{id:'restricted',scope:GROUP,title:'مكتبة خاصة بالمجموعة',order:1});
 const privateResource=randomUUID(),groupResource=randomUUID();
 await store.transaction(s=>{
  for(const [id,scope,categoryId] of [[privateResource,'private','guide'],[groupResource,GROUP,'restricted']] as const)
   s.educationResources.push({id,scope,categoryId,title:'Reviewed source',university:'Uni',
    cycle:'2026',degree:'Bachelor',seats:1,sourceImportId:randomUUID(),
    sourceLocator:'test',reviewedBy:OWNER,status:'PUBLISHED'});
  s.privateFeatures['content.upload']=true;
 });
 const privateFAQ=await faq.submit(OWNER,'private',{
  question:'ما شروط التسجيل <الأساسية>؟',answer:'المتطلبات & المعايير <الرسمية>',
  sourceResourceId:privateResource});
 await faq.approve(OWNER,privateFAQ.id);
 const groupFAQ=await faq.submit(OWNER,GROUP,{
  question:'SECRET_GROUP_QUESTION',answer:'PRIVATE_GROUP_ANSWER',sourceResourceId:groupResource});
 await faq.approve(OWNER,groupFAQ.id);
 const draft=await faq.submit(OWNER,'private',{
  question:'سؤال مسودة غير معتمدة',answer:'DRAFT_SECRET',sourceResourceId:privateResource});
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {dir,store,policy,education,faq,app,privateFAQ,groupFAQ,draft,privateResource,
  close:()=>rm(dir,{force:true,recursive:true})};
}
test('B3 private FAQ page/answer button parser rejects forged, unbounded and noncanonical requests',()=>{
 assert.deepEqual(parsePrivateFAQPage('➡️ التالي · pf:1'),{page:1,direction:'next'});
 assert.deepEqual(parsePrivateFAQPage('⬅️ السابق · pf:0'),{page:0,direction:'previous'});
 for(const command of ['➡️ التالي · pf:01','➡️ التالي · pf:1000','➡️ التالي · pf:-1',
  '⬅️ السابق · pf:','➡️ التالي · pf:1 extra','⬅️ السابق · pf:1\n'])
  assert.equal(parsePrivateFAQPage(command),null,command);
 const id=randomUUID();
 const choice=privateFAQButton(id);
 assert.match(choice,/^📖 سؤال · ~[a-f0-9]{16}$/u);
 assert.ok(parsePrivateFAQSelection(choice));
 for(const fake of ['📖 سؤال · '+id,'📖 سؤال · ~abcdef',
  choice+'!',choice+'\n','📖 سؤال · ~000000000000000G'])
  assert.equal(parsePrivateFAQSelection(fake),null,fake);
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': student assistant exposes navigable, private-scope-only approved FAQ with safe answer buttons',async()=>{
  const f=await fixture(engine);try{
   const screen=await f.app().handle(msg(1,menuLabels.assistant));
   assert.equal(screen.status,'APPLIED');
   assert.ok(buttons(screen).includes(privateFAQBrowseLabel));
   assert.equal(isValidTelegramReplyKeyboard(screen.plan?.replyMarkup),true);
   const index=await f.app().handle(msg(2,privateFAQBrowseLabel));
   assert.equal(index.status,'APPLIED');
   assert.match(index.plan?.text??'',/ما شروط التسجيل &lt;الأساسية&gt;؟/);
   assert.equal((index.plan?.text??'').includes(f.privateFAQ.id),false);
   assert.equal((index.plan?.text??'').includes('SECRET_GROUP_QUESTION'),false);
   assert.equal((index.plan?.text??'').includes('سؤال مسودة'),false);
   assert.equal(isValidTelegramReplyKeyboard(index.plan?.replyMarkup),true);
   const choice=buttons(index).find(x=>x.startsWith('📖 سؤال · '))!;
   assert.ok(choice);assert.equal(buttons(index).filter(x=>x.startsWith('📖 سؤال · ')).length,1);
   const result=await f.app().handle(msg(3,choice));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/المتطلبات &amp; المعايير &lt;الرسمية&gt;/);
   assert.equal((result.plan?.text??'').includes(f.privateFAQ.id),false);
   assert.equal((result.plan?.text??'').includes(f.privateResource),false);
   assert.ok(buttons(result).includes(privateFAQBrowseLabel));
   assert.equal((await f.store.snapshot()).privateAI,'OFF');
  }finally{await f.close();}
 });
}
test('B3 13 approved private FAQs paginate 10+4 and reject forged/stale/cross-direction requests',async()=>{
 const f=await fixture();try{
  for(let i=0;i<13;i++){
   const q=await f.faq.submit(OWNER,'private',{question:'Published FAQ '+i,
    answer:'Approved answer '+i,sourceResourceId:f.privateResource});
   await f.faq.approve(OWNER,q.id);
  }
  const page1=await f.app().handle(msg(10,privateFAQBrowseLabel));
  assert.equal(buttons(page1).filter(x=>x.startsWith('📖 سؤال · ')).length,10);
  assert.match(page1.plan?.text??'',/صفحة 1 من 2/);
  const second=await f.app().handle(msg(11,'➡️ التالي · pf:1'));
  assert.equal(second.status,'APPLIED');
  assert.equal(buttons(second).filter(x=>x.startsWith('📖 سؤال · ')).length,4);
  assert.equal(isValidTelegramReplyKeyboard(second.plan?.replyMarkup),true);
  assert.match(second.plan?.text??'',/صفحة 2 من 2/);
  assert.equal((await f.app().handle(msg(12,'⬅️ السابق · pf:0'))).status,'APPLIED');
  for(const [i,command] of ['➡️ التالي · pf:0','➡️ التالي · pf:999',
   '⬅️ السابق · pf:1','➡️ التالي · pf:01','➡️ التالي · pf:-1'].entries()){
   const r=await f.app().handle(msg(20+i,command));
   assert.equal(r.status,'DENIED',command);
   assert.equal(r.plan,undefined);
  }
 }finally{await f.close();}
});
test('B3 stale reviewed FAQ button is denied immediately after source category hide, FAQ archival or source archive',async()=>{
 const f=await fixture('sqlite');try{
  const index=await f.app().handle(msg(40,privateFAQBrowseLabel));
  const choice=buttons(index).find(x=>x.startsWith('📖 سؤال · '))!;
  await f.education.setCategoryEnabled(OWNER,'guide',false);
  const hidden=await f.app().handle(msg(41,choice));
  assert.equal(hidden.status,'DENIED');assert.equal(hidden.plan,undefined);
  await f.education.setCategoryEnabled(OWNER,'guide',true);
  const returned=await f.app().handle(msg(42,choice));
  assert.equal(returned.status,'APPLIED');
  await f.faq.archive(OWNER,f.privateFAQ.id);
  const archived=await f.app().handle(msg(43,choice));
  assert.equal(archived.status,'DENIED');assert.equal(archived.plan,undefined);
  const list=await f.app().handle(msg(44,privateFAQBrowseLabel));
  assert.equal(buttons(list).some(x=>x.startsWith('📖 سؤال · ')),false);
 }finally{await f.close();}
});
test('B3 student private FAQ browser honors navigation feature off on both new and old buttons',async()=>{
 const f=await fixture();try{
  const index=await f.app().handle(msg(50,privateFAQBrowseLabel));
  const button=buttons(index).find(x=>x.startsWith('📖 سؤال · '))!;
  await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
  for(const [i,c] of [privateFAQBrowseLabel,button,'➡️ التالي · pf:1'].entries()){
   const r=await f.app().handle(msg(51+i,c));
   assert.equal(r.status,'DENIED');assert.equal(r.plan,undefined);
  }
 }finally{await f.close();}
});
test('B3 arbitrary text or group commands cannot access private FAQ browsing',async()=>{
 const f=await fixture();try{
  const r=await f.app().handle(msg(60,privateFAQBrowseLabel,STUDENT,true));
  assert.equal(r.plan,undefined);
  const forged=await f.app().handle(msg(61,'📖 سؤال · ~1111111111111111'));
  assert.equal(forged.status,'DENIED');
  assert.equal(forged.plan,undefined);
  const ordinary=await f.app().handle(msg(62,'ما شروط التسجيل؟'));
  assert.equal(ordinary.status,'IGNORED');
 }finally{await f.close();}
});
