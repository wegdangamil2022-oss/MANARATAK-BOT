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
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const OWNER='100',STUDENT=300,GROUP='-100123';
const message=(id:number,text:string,actor=STUDENT,group=false)=>({
 update_id:id,message:{message_id:id,
  chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
  from:{id:actor,is_bot:false},text}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-faq-alias-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const faq=new ApprovedAnswerService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await education.createCategory(OWNER,{id:'scholarships',scope:'private',title:'المنح الدراسية',order:1});
 await store.transaction(s=>s.educationResources.push({
  id:'source-private',scope:'private',categoryId:'scholarships',
  title:'Public Published Resource',university:'University',cycle:'2026',degree:'Bachelor',
  seats:null,sourceImportId:'imp',sourceLocator:'row',reviewedBy:OWNER,status:'PUBLISHED'
 }));
 const add=async(question:string,aliases:string[],answer:string,createdAt:number,scope='private')=>{
  const id=randomUUID();
  await store.transaction(s=>s.faqEntries.push({
   id,scope,question,aliases,answer,sourceResourceId:'source-private',createdBy:OWNER,
   approvedBy:OWNER,createdAt,status:'APPROVED'
  }));
  return id;
 };
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {store,policy,app,add,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': keyword search discovers approved alias while showing only the public original question',async()=>{
  const f=await fixture(engine);try{
   await f.add('كيف أقدم على المنحة؟',['تسجيل CSCA','مواعيد اختبار CSCA'],'الإجابة المعتمدة & الوحيدة',10);
   const r=await f.app().handle(message(1,'/faqsearch CSCA'));
   assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/كيف أقدم على المنحة؟/);
   assert.equal((r.plan?.text??'').includes('تسجيل CSCA'),false);
   assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
   const button=buttons(r).find(x=>x.startsWith('📖 سؤال '))!;
   assert.ok(button);
   const answer=await f.app().handle(message(2,button));
   assert.equal(answer.status,'APPLIED');assert.match(answer.plan?.text??'',/الإجابة المعتمدة &amp; الوحيدة/);
   assert.equal((answer.plan?.text??'').includes('CSCA'),false);
  }finally{await f.close();}
 });
}
test('B3 search normalizes Unicode NFKC in query and approved alias, preserving exact title matching',async()=>{
 const f=await fixture();try{
  await f.add('Requirements and test', ['ＣＳＣＡ registration 2026'],'Trusted answer',20);
  const a=await f.app().handle(message(10,'/faqsearch csca'));
  assert.equal(a.status,'APPLIED');assert.match(a.plan?.text??'',/Requirements and test/);
  const b=await f.app().handle(message(11,'/faqsearch ＣＳＣＡ'));
  assert.equal(b.status,'APPLIED');assert.match(b.plan?.text??'',/Requirements and test/);
  const title=await f.app().handle(message(12,'/faqsearch Requirements'));
  assert.equal(title.status,'APPLIED');assert.match(title.plan?.text??'',/Requirements and test/);
 }finally{await f.close();}
});
test('B3 alias search retains global authorized FAQ ordinal across title and alias matches',async()=>{
 const f=await fixture();try{
  await f.add('Different first title',['irrelevant'],'Wrong first answer',900);
  await f.add('Actual answer to scholarships',['study china'],'Correct answer',800);
  const r=await f.app().handle(message(20,'/faqsearch china'));
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/2\. Actual answer to scholarships/);
  const button=buttons(r).find(x=>x.startsWith('📖 سؤال 2 · '));
  assert.ok(button);
  const selected=await f.app().handle(message(21,button!));
  assert.equal(selected.status,'APPLIED');assert.match(selected.plan?.text??'',/Correct answer/);
  assert.equal((selected.plan?.text??'').includes('Wrong first answer'),false);
 }finally{await f.close();}
});
test('B3 alias search paginates twelve matching approved FAQ titles with stable numbered safe buttons',async()=>{
 const f=await fixture();try{
  for(let i=0;i<12;i++)await f.add('Course number '+i,['scholarship practical'],'Answer '+i,100+i);
  const first=await f.app().handle(message(40,'/faqsearch practical'));
  assert.equal(first.status,'APPLIED');assert.match(first.plan?.text??'',/صفحة 1 من 2/);
  assert.equal(buttons(first).filter(x=>x.startsWith('📖 سؤال ')).length,10);
  const next=buttons(first).find(x=>x.startsWith('➡️ التالي · fq:'))!;
  const second=await f.app().handle(message(41,next));
  assert.equal(second.status,'APPLIED');assert.match(second.plan?.text??'',/صفحة 2 من 2/);
  assert.equal(buttons(second).filter(x=>x.startsWith('📖 سؤال ')).length,2);
  const choice=buttons(second).find(x=>x.startsWith('📖 سؤال '))!;
  const ans=await f.app().handle(message(42,choice));
  assert.equal(ans.status,'APPLIED');assert.match(ans.plan?.text??'',/Answer/);
  assert.equal(isValidTelegramReplyKeyboard(second.plan?.replyMarkup),true);
 }finally{await f.close();}
});
test('B3 archived source hides FAQ alias match and invalidates previously issued answer button',async()=>{
 const f=await fixture('sqlite');try{
  await f.add('Published <test> & safety',['secret alias keyword'],'Private trusted answer',1);
  const search=await f.app().handle(message(50,'/faqsearch keyword'));
  assert.equal(search.status,'APPLIED');
  const choice=buttons(search).find(x=>x.startsWith('📖 سؤال '))!;
  await f.store.transaction(s=>{s.educationResources.find(r=>r.id==='source-private')!.status='ARCHIVED';});
  const stale=await f.app().handle(message(51,choice));
  assert.equal(stale.status,'DENIED');assert.equal(stale.plan,undefined);
  const again=await f.app().handle(message(52,'/faqsearch keyword'));
  assert.equal(again.status,'APPLIED');assert.match(again.plan?.text??'',/لا توجد/);
  assert.equal((again.plan?.text??'').includes('secret alias keyword'),false);
 }finally{await f.close();}
});
test('B3 unapproved, archived, group-scoped FAQ aliases cannot leak into private student results',async()=>{
 const f=await fixture();try{
  const fake=await f.add('One hidden group FAQ',['target special'],'Private never show',1,GROUP);
  await f.add('An approved but then archived FAQ',['target special'],'Archived answer',2);
  await f.add('Draft item',['target special'],'Draft answer',3);
  await f.store.transaction(s=>{
   s.faqEntries.find(q=>q.question==='An approved but then archived FAQ')!.status='ARCHIVED';
   s.faqEntries.find(q=>q.question==='Draft item')!.status='DRAFT';
  });
  const r=await f.app().handle(message(60,'/faqsearch target'));
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/لا توجد/);
  assert.equal((r.plan?.text??'').includes(fake),false);
 }finally{await f.close();}
});
test('B3 private navigation disabled denies both alias and title matching without persisting search history',async()=>{
 const f=await fixture();try{
  await f.add('Search this title',['keyword alias'],'My answer',100);
  await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
  const before=await f.store.snapshot();
  const r=await f.app().handle(message(70,'/faqsearch keyword'));
  assert.equal(r.status,'DENIED');assert.equal(r.plan,undefined);
  const after=await f.store.snapshot();
  assert.equal(after.faqEntries.length,before.faqEntries.length);
  assert.equal(after.educationResources.length,before.educationResources.length);
 }finally{await f.close();}
});


for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': Arabic private FAQ title search ignores tashkeel and matches Arabic-Indic digits',async()=>{
  const f=await fixture(engine);try{
   await f.add('مِنْحَةُ الصِّينِ ٢٠٢٧',['other'],'Approved 2027 answer',200);
   const r=await f.app().handle(message(80,'/faqsearch منحة الصين 2027'));
   assert.equal(r.status,'APPLIED');
   assert.match(r.plan?.text??'',/مِنْحَةُ الصِّينِ ٢٠٢٧/);
   assert.equal(buttons(r).filter(x=>x.startsWith('📖 سؤال ')).length,1);
   const selected=await f.app().handle(message(81,buttons(r).find(x=>x.startsWith('📖 سؤال '))!));
   assert.match(selected.plan?.text??'',/Approved 2027 answer/);
  }finally{await f.close();}
 });
 test('B3 '+engine+': approved Arabic FAQ aliases match hamza, alef maqsurah and diacritics',async()=>{
  const f=await fixture(engine);try{
   await f.add('كيف أستفيد من المنحة؟',
    ['إِخْتِبارُ القُدرات فى إندونيسيا'],'Answer through reviewed source',200);
   const r=await f.app().handle(message(82,'/faqsearch اختبار القدرات في اندونيسيا'));
   assert.equal(r.status,'APPLIED');
   assert.match(r.plan?.text??'',/كيف أستفيد من المنحة؟/);
   assert.equal((r.plan?.text??'').includes('إِخْتِبارُ'),false);
   assert.ok(isValidTelegramReplyKeyboard(r.plan?.replyMarkup));
  }finally{await f.close();}
 });
}
test('B3 Arabic search folds punctuation, tatweel and repeated spaces but not the original question display',async()=>{
 const f=await fixture();try{
  await f.add('منح — الصــين، 2027',['another alias'],'Reviewed',20);
  const r=await f.app().handle(message(84,'/faqsearch منح الصين 2027'));
  assert.match(r.plan?.text??'',/منح — الصــين، 2027/);
  assert.equal(buttons(r).filter(x=>x.startsWith('📖 سؤال ')).length,1);
 }finally{await f.close();}
});
test('B3 Persian digits match 2027 and locale normalization does not alter reviewed source metadata',async()=>{
 const f=await fixture('sqlite');try{
  const id=await f.add('فرص دراسية ۲۰۲۷',['طلبات ۲۰۲۷'],'Approved',30);
  const before=await f.store.snapshot();
  const r=await f.app().handle(message(85,'/faqsearch 2027'));
  assert.match(r.plan?.text??'',/فرص دراسية ۲۰۲۷/);
  const after=await f.store.snapshot();
  assert.deepEqual(after.faqEntries,before.faqEntries);
  assert.equal((r.plan?.text??'').includes(id),false);
 }finally{await f.close();}
});
test('B3 normalized empty symbols cannot accidentally enumerate all approved FAQ questions',async()=>{
 const f=await fixture();try{
  await f.add('private approved FAQ',['test'],'Secret approved answer',30);
  for(const [id,term] of [[86,'•••'],[87,'ــــ'],[88,'َََ']] as const){
   const result=await f.app().handle(message(id,'/faqsearch '+term));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/لا توجد/);
   assert.equal(buttons(result).some(x=>x.startsWith('📖 سؤال ')),false);
  }
 }finally{await f.close();}
});
test('B3 Arabic keyword search does not relax exact /faq command or private navigation authorization',async()=>{
 const f=await fixture();try{
  await f.add('ما شروط القُبول؟',['جواز السفر'],'Reviewed answer',30);
  const exact=await f.app().handle(message(90,'/faq ما شروط القبول؟'));
  assert.equal(exact.status,'APPLIED');
  assert.match(exact.plan?.text??'',/لم نعثر/);
  await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
  const disabled=await f.app().handle(message(91,'/faqsearch شروط القبول'));
  assert.equal(disabled.status,'DENIED');assert.equal(disabled.plan,undefined);
 }finally{await f.close();}
});
