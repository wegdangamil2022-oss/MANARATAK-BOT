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
import {privateFAQSearchLabel,parsePrivateFAQSearchQuery,parsePrivateFAQSearchPage,privateFAQSearchPageLabel} from '../src/telegram-private-faq-search.js';
const OWNER='100',STUDENT=300,GROUP='-100123';
const msg=(id:number,text:string,actor=STUDENT,group=false)=>({
 update_id:id,message:{message_id:id,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-private-faq-search-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
 await education.createCategory(OWNER,{id:'faqprivate',scope:'private',title:'مصادر معتمدة',order:1});
 await education.createCategory(OWNER,{id:'faqgroup',scope:GROUP,title:'مصادر المجموعة',order:1});
 const source=randomUUID(),groupSource=randomUUID();
 await store.transaction(s=>{
  for(const [id,scope,categoryId] of [[source,'private','faqprivate'],[groupSource,GROUP,'faqgroup']] as const)
   s.educationResources.push({id,categoryId,scope,title:'Source',university:'Uni',
    cycle:'2026',degree:'Bachelor',seats:null,sourceImportId:randomUUID(),
    sourceLocator:'test',reviewedBy:OWNER,status:'PUBLISHED'});
  s.privateFeatures['content.upload']=true;
 });
 const create=async(question:string,answer:string='إجابة معتمدة')=>{
  const q=await faq.submit(OWNER,'private',{question,answer,sourceResourceId:source});
  await faq.approve(OWNER,q.id);return q;
 };
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {dir,store,policy,education,faq,app,source,groupSource,create,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('B3 FAQ keyword search parser is canonical, bounded and round-trips safe Arabic paging tokens',()=>{
 assert.equal(parsePrivateFAQSearchQuery('/faqsearch منحة'),'منحة');
 assert.equal(parsePrivateFAQSearchQuery('/faqsearch   منحة  '),'منحة');
 const button=privateFAQSearchPageLabel('منحة',1,'next');
 assert.deepEqual(parsePrivateFAQSearchPage(button),{query:'منحة',page:1,direction:'next'});
 assert.ok(Array.from(button).length<=96);
 assert.ok(Buffer.byteLength(button,'utf8')<=256);
 for(const text of ['/faqsearch','/faqsearch ','/faqsearch \nممنوع',
  '/faqsearch '+('م'.repeat(60)), '/faqsearch '+('a'.repeat(200)),
  '/faqsearch \u202eunsafe', '/faqsearch \u0000']){
  assert.equal(parsePrivateFAQSearchQuery(text),null,text);
 }
 for(const text of ['➡️ التالي · fq:01:YWJj',
  '➡️ التالي · fq:1000:YWJj','➡️ التالي · fq:0:YWJj',
  '⬅️ السابق · fq:999:YWJj',button+'\n',
  '➡️ التالي · fq:1:==','➡️ التالي · fq:1:YWJj=']){
  assert.equal(parsePrivateFAQSearchPage(text),null,text);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': student can search private approved FAQ questions by bounded keyword and select correct visible answer',async()=>{
  const f=await fixture(engine);try{
   const target=await f.create('أين أجد منحة الصين <2027>؟','هذه إجابة & مراجعة <معتمدة>');
   await f.create('متى يبدأ اختبار CSCA؟','CSCA answer');
   await f.faq.submit(OWNER,'private',{question:'SECRET_DRAFT_منحة',answer:'DRAFT',
    sourceResourceId:f.source});
   const group=await f.faq.submit(OWNER,GROUP,{
    question:'SECRET_GROUP_منحة',answer:'HIDDEN_GROUP',sourceResourceId:f.groupSource});
   await f.faq.approve(OWNER,group.id);
   const guide=await f.app().handle(msg(1,menuLabels.assistant));
   assert.equal(guide.status,'APPLIED');assert.ok(buttons(guide).includes(privateFAQSearchLabel));
   const instructions=await f.app().handle(msg(2,privateFAQSearchLabel));
   assert.equal(instructions.status,'APPLIED');assert.match(instructions.plan?.text??'',/faqsearch/);
   const r=await f.app().handle(msg(3,'/faqsearch منحة'));
   assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/منحة الصين &lt;2027&gt;/);
   assert.equal((r.plan?.text??'').includes('CSCA'),false);
   assert.equal((r.plan?.text??'').includes('SECRET_DRAFT'),false);
   assert.equal((r.plan?.text??'').includes('SECRET_GROUP'),false);
   assert.equal((r.plan?.text??'').includes(target.id),false);
   assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
   const choice=buttons(r).find(x=>x.startsWith('📖 سؤال '))!;
   const clicked=await f.app().handle(msg(4,choice));
   assert.equal(clicked.status,'APPLIED');
   assert.match(clicked.plan?.text??'',/إجابة &amp; مراجعة &lt;معتمدة&gt;/);
   assert.equal((clicked.plan?.text??'').includes(target.id),false);
  }finally{await f.close();}
 });
}
test('B3 private FAQ search uses global visible question ordinal on page two; paginates 12 matches',async()=>{
 const f=await fixture();try{
  for(let i=0;i<12;i++)await f.create('منحة عالمية '+String(i).padStart(2,'0'));
  await f.create('سؤال آخر بلا مطابقة');
  const first=await f.app().handle(msg(10,'/faqsearch منحة'));
  assert.match(first.plan?.text??'',/صفحة 1 من 2/);
  assert.equal(buttons(first).filter(x=>x.startsWith('📖 سؤال ')).length,10);
  const next=buttons(first).find(x=>x.startsWith('➡️ التالي · fq:'))!;
  assert.ok(next);
  const second=await f.app().handle(msg(11,next));
  assert.equal(second.status,'APPLIED');
  assert.match(second.plan?.text??'',/صفحة 2 من 2/);
  assert.equal(buttons(second).filter(x=>x.startsWith('📖 سؤال ')).length,2);
  assert.equal(isValidTelegramReplyKeyboard(second.plan?.replyMarkup),true);
  const choice=buttons(second).find(x=>x.startsWith('📖 سؤال '))!;
  const fullCatalogue=await f.faq.listPrivateReviewedFAQs(String(STUDENT));
  assert.equal(fullCatalogue.status,'OK');
  if(fullCatalogue.status==='OK')
   assert.ok(fullCatalogue.items.some((q,i)=>choice.startsWith('📖 سؤال '+(i+1)+' ')));
  assert.equal((await f.app().handle(msg(12,choice))).status,'APPLIED');
  const back=buttons(second).find(x=>x.startsWith('⬅️ السابق · fq:'))!;
  assert.equal((await f.app().handle(msg(13,back))).status,'APPLIED');
 }finally{await f.close();}
});
test('B3 archived/hidden FAQ source disappears from search and old copied selection is denied',async()=>{
 const f=await fixture('sqlite');try{
  const q=await f.create('منحة دراسية جاهزة','معلومات معتمدة');
  const search=await f.app().handle(msg(20,'/faqsearch منحة'));
  const choice=buttons(search).find(x=>x.startsWith('📖 سؤال '))!;
  await f.education.setCategoryEnabled(OWNER,'faqprivate',false);
  assert.equal((await f.app().handle(msg(21,choice))).status,'DENIED');
  const unavailable=await f.app().handle(msg(22,'/faqsearch منحة'));
  assert.equal(buttons(unavailable).some(x=>x.startsWith('📖 سؤال ')),false);
  await f.education.setCategoryEnabled(OWNER,'faqprivate',true);
  await f.faq.archive(OWNER,q.id);
  assert.equal((await f.app().handle(msg(23,choice))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 FAQ search fails closed for forged/stale paging labels and private education disable',async()=>{
 const f=await fixture();try{
  await f.create('منحة صينية');
  for(const [i,cmd] of ['➡️ التالي · fq:0:YWJj','➡️ التالي · fq:999:YWJj',
   '➡️ التالي · fq:01:YWJj','⬅️ السابق · fq:0:YWJj','/faqsearch \u202eunsafe'].entries()){
   const r=await f.app().handle(msg(30+i,cmd));
   assert.equal(r.status,'DENIED',cmd);assert.equal(r.plan,undefined);
  }
  await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
  assert.equal((await f.app().handle(msg(39,'/faqsearch منحة'))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 keyword search is private-only and unknown messages never invoke FAQ or AI implicitly',async()=>{
 const f=await fixture();try{
  await f.create('منحة معتمدة');
  const group=await f.app().handle(msg(40,'/faqsearch منحة',100,true));
  assert.equal(group.plan,undefined);
  const ordinary=await f.app().handle(msg(41,'منحة'));
  assert.equal(ordinary.plan?.text.includes('منحة معتمدة')??false,false);
  assert.equal((await f.store.snapshot()).privateAI,'OFF');
 }finally{await f.close();}
});
