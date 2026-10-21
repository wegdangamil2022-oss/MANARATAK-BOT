import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {normalizeStudentSearchText} from '../src/education-search-normalization.js';
import {parseSearchQuery,parseSearchPageCommand,searchPageButton} from '../src/telegram-search.js';

const OWNER='100',GROUP='-100123',STUDENT=300;
const message=(n:number,text:string,actor=STUDENT)=>({
 update_id:n,message:{message_id:n,chat:{id:actor,type:'private'},
 from:{id:actor,is_bot:false},text}});
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-arabic-search-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'db.sqlite':'db.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await education.createCategory(OWNER,{id:'grants',scope:'private',title:'المنح',order:1});
 await education.createCategory(OWNER,{id:'hidden',scope:'private',title:'المحتوى القديم',order:2});
 await education.createCategory(OWNER,{id:'group_only',scope:GROUP,title:'مجموعات',order:3});
 await store.transaction(s=>{
  for(const [i,title,scope,categoryId,status] of [
   ['indonesia','مِنْحَةُ إِنْدُونِيسِيَا لِلطِّبّ','private','grants','PUBLISHED'],
   ['iraq','دِراسَةُ الطِّبِّ فِي العِرَاق','private','grants','PUBLISHED'],
   ['year','المنح للعام ٢٠٢٦','private','grants','PUBLISHED'],
   ['hidden','منحة إندونيسيا الخفية','private','hidden','PUBLISHED'],
   ['archived','منحة إندونيسيا المؤرشفة','private','grants','ARCHIVED'],
   ['group','منحة إندونيسيا المجموعة',''+GROUP,'group_only','PUBLISHED']
  ] as const)s.educationResources.push({
   id:i,categoryId,scope,title,university:'University',cycle:'2026',
   degree:'Bachelor',seats:2,sourceImportId:'job-'+i,sourceLocator:i,
   reviewedBy:OWNER,status
  });
 });
 await education.setCategoryEnabled(OWNER,'hidden',false);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {store,education,app,close:()=>rm(dir,{recursive:true,force:true})};
}
test('Arabic fold normalizes harakat, tatweel, alif/hamza, ya, ta marbuta and both numeral sets deterministically',()=>{
 assert.equal(normalizeStudentSearchText('مِنْحَةٌ إِنْدُونِيسِيَا'),'منحه اندونيسيا');
 assert.equal(normalizeStudentSearchText('جــامِعَة آلعِراق'),'جامعه العراق');
 assert.equal(normalizeStudentSearchText('مُسْتَشْفَى'), 'مستشفي');
 assert.equal(normalizeStudentSearchText('العام ٢٠٢٦ / ۲۰۲۶'), 'العام 2026 / 2026');
 assert.equal(normalizeStudentSearchText('پێشەنگی کوردستان'), 'پێشهنگي كردستان');
 assert.equal(normalizeStudentSearchText('  ABSHEER   CSCA  '),'absheer csca');
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': students find Arabic diacritized scholarships with unaccented ordinary search in Telegram',async()=>{
  const f=await fixture(engine);try{
   const direct=await f.education.searchPublishedResources(String(STUDENT),'منحة اندونيسيا');
   assert.deepEqual(direct.map(r=>r.id),['indonesia']);
   const fromTelegram=await f.app().handle(message(10,'/search منحة اندونيسيا'));
   assert.equal(fromTelegram.status,'APPLIED');
   assert.match(fromTelegram.plan?.text??'',/إِنْدُونِيسِيَا/);
   const body=fromTelegram.plan?.text??'';
   assert.equal(body.includes('الخفية'),false);
   assert.equal(body.includes('المؤرشفة'),false);
   assert.equal(body.includes('المجموعة'),false);
  }finally{await f.close();}
 });
}
test('B3 search treats Arabic-Indic and Eastern Arabic-Indic year digits as equal to ASCII digits',async()=>{
 const f=await fixture();try{
  for(const q of ['٢٠٢٦','۲۰۲۶','2026']){
   const r=await f.education.searchPublishedResources(String(STUDENT),q);
   assert.ok(r.some(x=>x.id==='year'),q);
  }
 }finally{await f.close();}
});
test('B3 Arabic query supports optional Arabic diacritics without permitting control bytes or HTML',()=>{
 assert.equal(parseSearchQuery('/search إِنْدُونِيسِيَا'),'إِنْدُونِيسِيَا');
 const b=searchPageButton('إِنْدُونِيسِيَا',1,'next');
 assert.deepEqual(parseSearchPageCommand(b),{
  query:'إِنْدُونِيسِيَا',page:1,direction:'next'
 });
 for(const invalid of ['/search <script>','/search x\u200bZ','/search a:b',
  '/search x\u202eZ','/search a\nb','/search a  b']){
  assert.equal(parseSearchQuery(invalid),null,invalid);
 }
});
test('B3 Arabic folding does not turn a one-letter-with-marks query into unbounded single-character search',async()=>{
 const f=await fixture();try{
  assert.equal(parseSearchQuery('/search مِ'),'مِ');
  assert.deepEqual(await f.education.searchPublishedResources(String(STUDENT),'مِ'),[]);
 }finally{await f.close();}
});
test('B3 normalized Arabic search still denies archived, disabled categories and group-only source records',async()=>{
 const f=await fixture('sqlite');try{
  const results=await f.education.searchPublishedResources(String(STUDENT),'إِنْدُونِيسِيَا');
  assert.deepEqual(results.map(r=>r.id),['indonesia']);
  await f.education.setCategoryEnabled(OWNER,'grants',false);
  assert.deepEqual(await f.education.searchPublishedResources(String(STUDENT),'منحة اندونيسيا'),[]);
  await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
  assert.deepEqual(await f.education.searchPublishedResources(String(STUDENT),'2026'),[]);
 }finally{await f.close();}
});
test('B3 Unicode fold does not treat an empty/marks-only normalized query as a search match',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.education.searchPublishedResources(String(STUDENT),'ُِ'),[]);
  assert.deepEqual(await f.education.searchPublishedResources(String(STUDENT),' ــ '),[]);
 }finally{await f.close();}
});
