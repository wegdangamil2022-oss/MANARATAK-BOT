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
import {parsePrivateFAQQuery} from '../src/telegram-private-faq.js';
const OWNER='100',STUDENT=300,GROUP='-100123';
const msg=(id:number,text:string,actor=STUDENT,group=false)=>({
 update_id:id,message:{message_id:id,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-student-faq-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER),edu=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,edu),faq=new ApprovedAnswerService(store,policy);
 const links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
 await edu.createCategory(OWNER,{id:'scholarships',scope:'private',title:'المنح',order:1});
 await edu.createCategory(OWNER,{id:'group_catalog',scope:GROUP,title:'مجموعة خاصة',order:1});
 const resourceId=randomUUID(),groupResourceId=randomUUID();
 await store.transaction(s=>{
  for(const [id,scope,category] of [
   [resourceId,'private','scholarships'],[groupResourceId,GROUP,'group_catalog']
  ]){
   s.educationResources.push({id:id!,scope:scope!,categoryId:category!,
    title:'Approved <scholarship>',university:'University',cycle:'2026',degree:'Bachelor',
    seats:1,sourceImportId:randomUUID(),sourceLocator:'fixture',reviewedBy:OWNER,status:'PUBLISHED'});
  }
  s.privateFeatures['content.upload']=true;
 });
 const privateFAQ=await faq.submit(OWNER,'private',{
  question:'ما شروط المنحة؟',aliases:['شروط المنحة'],
  answer:'الشروط <معتمدة> & لا ترسل الجواز',sourceResourceId:resourceId});
 const groupFAQ=await faq.submit(OWNER,GROUP,{
  question:'سؤال المجموعة السري',answer:'سر خاص بالمجموعة',sourceResourceId:groupResourceId});
 await faq.approve(OWNER,groupFAQ.id);
 const app=()=>new TelegramUpdateApplication({store,policy,education:edu,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {dir,store,policy,edu,faq,app,privateFAQ,groupFAQ,resourceId,groupResourceId,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('B3 private FAQ parser accepts bounded explicit Unicode questions, never arbitrary chat text',()=>{
 for(const text of ['/faq ما شروط المنحة؟','/faq  What is CSCA?  ','/faq ١٢٣']){
  assert.ok(parsePrivateFAQQuery(text),text);
 }
 for(const text of ['/faq','/faq ','/faq    ','/faq\nمعلومات',
  '/faq <tag>\r','/faq '+('a'.repeat(241)),'/faq/other','/faqany','أريد منحة']){
  assert.equal(parsePrivateFAQQuery(text),null,text.slice(0,25));
 }
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+' student private FAQ answers reviewed local private source with AI OFF, not a generative provider',async()=>{
  const f=await fixture(engine);try{
   const welcome=await f.app().handle(msg(1,menuLabels.assistant));
   assert.equal(welcome.status,'APPLIED');
   assert.match(welcome.plan?.text??'',/\/faq/);
   assert.equal(isValidTelegramReplyKeyboard(welcome.plan?.replyMarkup),true);
   const preview=await f.app().handle(msg(2,'/faq ما شروط المنحة؟'));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/لا توجد|غير متاحة|لم نعثر/);
   await f.faq.approve(OWNER,f.privateFAQ.id);
   const answer=await f.app().handle(msg(3,'/faq شروط المنحة'));
   assert.equal(answer.status,'APPLIED');
   assert.match(answer.plan?.text??'',/الشروط &lt;معتمدة&gt; &amp; لا ترسل الجواز/);
   assert.equal((answer.plan?.text??'').includes(f.resourceId),false);
   assert.equal((answer.plan?.text??'').includes(f.groupResourceId),false);
   assert.equal((await f.store.snapshot()).privateAI,'OFF');
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
}
test('B3 FAQ explicit /faq cannot leak approved GROUP-only source into private student response',async()=>{
 const f=await fixture();try{
  const r=await f.app().handle(msg(10,'/faq سؤال المجموعة السري'));
  assert.equal(r.status,'APPLIED');
  assert.match(r.plan?.text??'',/لا توجد|غير متاحة|لم نعثر/);
  assert.equal((r.plan?.text??'').includes('سر خاص بالمجموعة'),false);
 }finally{await f.close();}
});
test('B3 FAQ source/category archive and FAQ archive immediately cease private answers',async()=>{
 const f=await fixture('sqlite');try{
  await f.faq.approve(OWNER,f.privateFAQ.id);
  assert.equal((await f.app().handle(msg(20,'/faq ما شروط المنحة؟'))).status,'APPLIED');
  await f.edu.setCategoryEnabled(OWNER,'scholarships',false);
  const hidden=await f.app().handle(msg(21,'/faq ما شروط المنحة؟'));
  assert.equal((hidden.plan?.text??'').includes('لا ترسل الجواز'),false);
  await f.edu.setCategoryEnabled(OWNER,'scholarships',true);
  await f.faq.archive(OWNER,f.privateFAQ.id);
  const archived=await f.app().handle(msg(22,'/faq ما شروط المنحة؟'));
  assert.equal((archived.plan?.text??'').includes('لا ترسل الجواز'),false);
  assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
 }finally{await f.close();}
});
test('B3 disabled private navigation prevents FAQ lookup but does not disable owner administration',async()=>{
 const f=await fixture();try{
  await f.faq.approve(OWNER,f.privateFAQ.id);
  await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
  const blocked=await f.app().handle(msg(30,'/faq شروط المنحة'));
  assert.equal(blocked.status,'DENIED');
  assert.equal(blocked.plan,undefined);
  const owner=await f.app().handle(msg(31,'🔐 لوحة المالك',100));
  assert.equal(owner.status,'APPLIED');
 }finally{await f.close();}
});
test('B3 ambiguous approved FAQ keys do not choose a random answer or disclose one',async()=>{
 const f=await fixture();try{
  await f.faq.approve(OWNER,f.privateFAQ.id);
  const clash=await f.faq.submit(OWNER,'private',{question:'شروط المنحة!',answer:'other sensitive answer',
   sourceResourceId:f.resourceId});
  await f.faq.approve(OWNER,clash.id);
  const r=await f.app().handle(msg(40,'/faq شروط المنحة'));
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/أكثر من إجابة|متشابهة|متعددة/);
  assert.equal((r.plan?.text??'').includes('other sensitive answer'),false);
  assert.equal((r.plan?.text??'').includes('لا ترسل الجواز'),false);
 }finally{await f.close();}
});
test('B3 invalid FAQ commands and text controls are DENIED, no accidental question parsing',async()=>{
 const f=await fixture();try{
  for(const [i,value] of ['/faq ','/faq '+('x'.repeat(241)),'/faq\rsecret','/faq/anything'].entries()){
   const r=await f.app().handle(msg(50+i,value));
   assert.equal(r.status,'DENIED',value.slice(0,20));assert.equal(r.plan,undefined);
  }
  const ordinary=await f.app().handle(msg(60,'ما شروط المنحة؟'));
  assert.equal(ordinary.status,'IGNORED');assert.equal(ordinary.plan,undefined);
 }finally{await f.close();}
});
test('B3 FAQ commands in authorized groups do not bypass mention/AI or access private answers',async()=>{
 const f=await fixture();try{
  await f.faq.approve(OWNER,f.privateFAQ.id);
  const r=await f.app().handle(msg(70,'/faq ما شروط المنحة؟',STUDENT,true));
  assert.equal(r.plan,undefined);
 }finally{await f.close();}
});
