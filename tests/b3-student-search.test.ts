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
import {menuLabels,isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
import {parseSearchQuery,parseSearchPageCommand,searchPageButton} from '../src/telegram-search.js';

const OWNER='100',STUDENT=300,GROUP='-100123';
const msg=(id:number,text:string,actor=STUDENT,group=false)=>({
 update_id:id,message:{message_id:id,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-search-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await education.createCategory(OWNER,{id:'grants',scope:'private',title:'منح جامعية',order:0});
 await education.createCategory(OWNER,{id:'hidden',scope:'private',title:'منح قديمة',order:1});
 await education.createCategory(OWNER,{id:'group',scope:GROUP,title:'منح المجموعات',order:0});
 await store.transaction(s=>{
  for(let i=0;i<23;i++)s.educationResources.push({
   id:'resource-'+String(i).padStart(2,'0'),categoryId:'grants',scope:'private',
   title:'Grant Scholarship '+String(i).padStart(2,'0'),
   university:'University College',cycle:'2026',degree:'Bachelor',seats:2,
   sourceImportId:'job-private-id',sourceLocator:String(i),reviewedBy:OWNER,
   status:'PUBLISHED'
  });
  s.educationResources.push({
   id:'archived',categoryId:'grants',scope:'private',title:'Grant Archived Secret',
   university:'Archive University',cycle:'2025',degree:'Master',seats:null,
   sourceImportId:'archive-run-secret',sourceLocator:'archive',reviewedBy:OWNER,status:'ARCHIVED'
  });
  s.educationResources.push({
   id:'hidden-resource',categoryId:'hidden',scope:'private',title:'Grant Hidden Data',
   university:'Hidden University',cycle:'2025',degree:'Bachelor',seats:null,
   sourceImportId:'hidden-secret',sourceLocator:'hidden',reviewedBy:OWNER,status:'PUBLISHED'
  });
  s.educationResources.push({
   id:'group-resource',categoryId:'group',scope:GROUP,title:'Grant Group Source',
   university:'Group University',cycle:'2026',degree:'Master',seats:null,
   sourceImportId:'group-secret',sourceLocator:'group',reviewedBy:OWNER,status:'PUBLISHED'
  });
 });
 await education.setCategoryEnabled(OWNER,'hidden',false);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {dir,store,policy,education,app,close:()=>rm(dir,{force:true,recursive:true})};
}
test('B3 search: students have real search button in main Telegram keyboard; owner retains admin entry',async()=>{
 const f=await fixture();try{
  const student=await f.app().handle(msg(1,'/start'));
  assert.ok(buttons(student).includes(menuLabels.search));
  assert.equal(buttons(student).includes(menuLabels.owner),false);
  assert.equal(isValidTelegramReplyKeyboard(student.plan?.replyMarkup),true);
  const owner=await f.app().handle(msg(2,'/start',100));
  assert.ok(buttons(owner).includes(menuLabels.search));
  assert.ok(buttons(owner).includes(menuLabels.owner));
  assert.equal(isValidTelegramReplyKeyboard(owner.plan?.replyMarkup),true);
  const hint=await f.app().handle(msg(3,menuLabels.search));
  assert.equal(hint.status,'APPLIED');
  assert.match(hint.plan?.text??'',/\/search/);
  assert.ok(buttons(hint).includes(menuLabels.back));
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': published private resources searchable with true Next/Previous, last-page selection authorized',async()=>{
  const f=await fixture(engine);try{
   const first=await f.app().handle(msg(10,'/search Grant'));
   assert.equal(first.status,'APPLIED');assert.match(first.plan?.text??'',/صفحة 1 من 3/);
   assert.equal(buttons(first).filter(x=>x.startsWith('🔎 ')).length,10);
   assert.ok(buttons(first).includes('➡️ التالي · s:Grant:1'));
   const second=await f.app().handle(msg(11,'➡️ التالي · s:Grant:1'));
   assert.match(second.plan?.text??'',/صفحة 2 من 3/);
   assert.equal(buttons(second).filter(x=>x.startsWith('🔎 ')).length,10);
   const third=await f.app().handle(msg(12,'➡️ التالي · s:Grant:2'));
   assert.match(third.plan?.text??'',/صفحة 3 من 3/);
   assert.equal(buttons(third).filter(x=>x.startsWith('🔎 ')).length,3);
   assert.ok(buttons(third).includes('⬅️ السابق · s:Grant:1'));
   assert.equal(isValidTelegramReplyKeyboard(third.plan?.replyMarkup),true);
   const button=buttons(third).find(x=>x.includes('Scholarship 22'))!;
   assert.ok(button);
   const opened=await f.app().handle(msg(13,button));
   assert.equal(opened.status,'APPLIED');
   assert.match(opened.plan?.text??'',/Scholarship 22/);
   assert.equal((opened.plan?.text??'').includes('job-private-id'),false);
  }finally{await f.close();}
 });
}
test('B3 search: archived, disabled-category and group-only resources never enter private result list',async()=>{
 const f=await fixture();try{
  const before=await f.app().handle(msg(20,'/search Secret'));
  assert.match(before.plan?.text??'',/لا توجد|لم نعثر/);
  const grant=await f.app().handle(msg(21,'/search Grant'));
  const body=(grant.plan?.text??'')+' '+buttons(grant).join(' ');
  assert.equal(body.includes('Archived Secret'),false);
  assert.equal(body.includes('Hidden Data'),false);
  assert.equal(body.includes('Group Source'),false);
  assert.equal(body.includes('group-secret'),false);
  const forged=await f.app().handle(msg(22,'🔎 Grant Archived Secret · archived'));
  assert.equal(forged.status,'DENIED');
  const outsider=await f.app().handle(msg(23,'🔎 Grant Group Source · group-resource'));
  assert.equal(outsider.status,'DENIED');
 }finally{await f.close();}
});
test('B3 search: results are re-checked after category disable or resource archival, stale pages fail closed',async()=>{
 const f=await fixture();try{
  const first=await f.app().handle(msg(30,'/search Grant'));
  const old=buttons(first).find(x=>x.includes('Scholarship 00'))!;
  await f.education.archiveResource(OWNER,'resource-00');
  const archived=await f.app().handle(msg(31,old));
  assert.equal(archived.status,'DENIED');
  await f.education.setCategoryEnabled(OWNER,'grants',false);
  const now=await f.app().handle(msg(32,'/search Grant'));
  assert.match(now.plan?.text??'',/لا توجد|لم نعثر/);
  const stale=await f.app().handle(msg(33,'➡️ التالي · s:Grant:1'));
  assert.equal(stale.status,'DENIED');
  assert.equal(stale.plan,undefined);
 }finally{await f.close();}
});
test('B3 search: disabling private education navigation removes access to live search and raw selection',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
  const denied=await f.app().handle(msg(40,'/search Grant'));
  assert.equal(denied.status,'DENIED');
  assert.equal(denied.plan,undefined);
  const forged=await f.app().handle(msg(41,'🔎 Grant Scholarship 00 · resource-00'));
  assert.equal(forged.status,'DENIED');
 }finally{await f.close();}
});
test('B3 search: HTML dangerous resource title is escaped in results and detail',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   s.educationResources[0]!.title='Grant <script>alert("bad")</script> & text';
  });
  const search=await f.app().handle(msg(50,'/search Grant'));
  assert.equal(search.status,'APPLIED');
  assert.equal((search.plan?.text??'').includes('<script>'),false);
  assert.match(search.plan?.text??'',/&lt;script&gt;/);
  const key=buttons(search).find(x=>x.includes('script'))!;
  const detail=await f.app().handle(msg(51,key));
  assert.equal(detail.status,'APPLIED');
  assert.equal((detail.plan?.text??'').includes('<script>'),false);
 }finally{await f.close();}
});
test('B3 search: canonical Arabic and Latin query grammar prevents forged pages, control bytes and huge payloads',()=>{
 assert.equal(parseSearchQuery('/search منحة الصين'),'منحة الصين');
 assert.equal(parseSearchQuery('/search CSCA'),'CSCA');
 assert.deepEqual(parseSearchPageCommand('➡️ التالي · s:منحة الصين:1'),{
  query:'منحة الصين',page:1,direction:'next'
 });
 assert.equal(searchPageButton('منحة الصين',1,'next'),'➡️ التالي · s:منحة الصين:1');
 for(const bad of [
  '/search a','/search '+('A'.repeat(33)),'/search hello\nadmin',
  '/search <script>', '/search   spaced  out', '/search a:b',
  '/search hello\u202e','/search x\tz','/search \u0000x',
 ]){
  assert.equal(parseSearchQuery(bad),null,bad);
 }
 for(const bad of [
  '➡️ التالي · s:Grant:01','➡️ التالي · s:Grant:-1',
  '➡️ التالي · s:Grant:1000','➡️ التالي · s:Grant:1\n',
  '➡️ التالي · s:<bad>:1','⬅️ السابق · s:Grant:1:2',
  '➡️ التالي · s:Grant:1\u202e'
 ])assert.equal(parseSearchPageCommand(bad),null,bad);
});
test('B3 search: malformed, out-of-range, direction-forged private search requests deny, group search never leaks private resources',async()=>{
 const f=await fixture();try{
  for(const [i,input] of ['/search a','/search <script>',
   '➡️ التالي · s:Grant:0','⬅️ السابق · s:Grant:2',
   '➡️ التالي · s:Grant:999','➡️ التالي · s:Grant:01'].entries()){
   const r=await f.app().handle(msg(70+i,input));
   assert.equal(r.status,'DENIED',input);
   assert.equal(r.plan,undefined);
  }
  const group=await f.app().handle(msg(80,'/search Grant',STUDENT,true));
  assert.equal(group.plan,undefined);
 }finally{await f.close();}
});


for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': Arabic student grant title matches diacritics and Arabic-Indic years',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    s.educationResources.find(r=>r.id==='resource-00')!.title='مِنْحَةُ الصِّينِ ٢٠٢٧';
   });
   const res=await f.app().handle(msg(100,'/search منحة الصين 2027'));
   assert.equal(res.status,'APPLIED');assert.match(res.plan?.text??'',/مِنْحَةُ الصِّينِ ٢٠٢٧/);
   const key=buttons(res).find(x=>x.includes('resource-00'))!;
   assert.ok(key);
   const opened=await f.app().handle(msg(101,key));
   assert.equal(opened.status,'APPLIED');
   assert.match(opened.plan?.text??'',/مِنْحَةُ الصِّينِ ٢٠٢٧/);
  }finally{await f.close();}
 });
 test('B3 '+engine+': university spelling with hamza/tatweel and Persian digits is discoverable',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    const grant=s.educationResources.find(r=>r.id==='resource-00')!;
    grant.title='فرص ۲۰۲۷';grant.university='جَامِعَة إندونيسيا الصــينية';
   });
   for(const [i,term] of ['2027','جامعة اندونيسيا الصينية'].entries()){
    const res=await f.app().handle(msg(102+i,'/search '+term));
    assert.equal(res.status,'APPLIED',term);
    assert.ok(buttons(res).some(x=>x.includes('resource-00')),term);
   }
  }finally{await f.close();}
 });
 test('B3 '+engine+': search separator normalization does not list hidden, archived or group scholarship sources',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    s.educationResources.find(r=>r.id==='archived')!.title='CSCA—2027 hidden archive';
    s.educationResources.find(r=>r.id==='hidden-resource')!.title='CSCA_2027 category';
    s.educationResources.find(r=>r.id==='group-resource')!.title='CSCA-2027 group private';
    s.educationResources.find(r=>r.id==='resource-00')!.title='CSCA—2027 public';
   });
   const result=await f.app().handle(msg(104,'/search CSCA 2027'));
   assert.equal(result.status,'APPLIED');
   assert.ok(buttons(result).some(x=>x.includes('resource-00')));
   const text=(result.plan?.text??'')+buttons(result).join('');
   for(const hidden of ['archived','hidden-resource','group-resource','hidden archive','category','group private'])
    assert.equal(text.includes(hidden),false,hidden);
  }finally{await f.close();}
 });
}
test('B3 resource search accepts legitimate Arabic vowel marks in explicit bounded commands and page labels',()=>{
 assert.equal(parseSearchQuery('/search مِـنحَة'),'مِـنحَة');
 assert.deepEqual(parseSearchPageCommand(searchPageButton('مِـنحَة',1,'next')),
  {query:'مِـنحَة',page:1,direction:'next'});
 for(const input of ['/search \u064e\u064e','/search \u202eمنحة','/search '+'أ'.repeat(33)])
  assert.equal(parseSearchQuery(input),null);
});
test('B3 search-only non-meaningful kashida never causes all approved grants to be returned',async()=>{
 const f=await fixture('sqlite');try{
  const result=await f.app().handle(msg(120,'/search ــ'));
  assert.equal(result.status,'APPLIED');
  assert.match(result.plan?.text??'',/لم نعثر/);
  assert.equal(buttons(result).some(x=>x.startsWith('🔎 ')),false);
 }finally{await f.close();}
});


for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': search result selection preserves an actionable return to the same search results',async()=>{
  const f=await fixture(engine);try{
   const result=await f.app().handle(msg(220,'/search Grant'));
   const token=buttons(result).find(b=>b.includes('resource-00'))!;
   assert.match(token,/ · s:Grant:0$/u);
   const opened=await f.app().handle(msg(221,token));
   assert.equal(opened.status,'APPLIED');
   assert.match(opened.plan?.text??'',/Scholarship 00/);
   assert.ok(buttons(opened).includes('↩️ نتائج البحث · s:Grant:0'));
   assert.ok(buttons(opened).includes('↩️ موارد القسم · grants'));
   assert.equal(isValidTelegramReplyKeyboard(opened.plan?.replyMarkup),true);
   const returned=await f.app().handle(msg(222,'↩️ نتائج البحث · s:Grant:0'));
   assert.equal(returned.status,'APPLIED');
   assert.match(returned.plan?.text??'',/صفحة 1 من 3/);
   assert.ok(buttons(returned).some(b=>b.includes('resource-00')));
  }finally{await f.close();}
 });
 test('B3 '+engine+': selecting third-page result returns exactly to current third page',async()=>{
  const f=await fixture(engine);try{
   const third=await f.app().handle(msg(230,'➡️ التالي · s:Grant:2'));
   assert.equal(third.status,'APPLIED');
   const token=buttons(third).find(b=>b.includes('resource-22'))!;
   assert.match(token,/ · s:Grant:2$/u);
   const opened=await f.app().handle(msg(231,token));
   assert.equal(opened.status,'APPLIED');
   assert.ok(buttons(opened).includes('↩️ نتائج البحث · s:Grant:2'));
   const returned=await f.app().handle(msg(232,'↩️ نتائج البحث · s:Grant:2'));
   assert.equal(returned.status,'APPLIED');
   assert.match(returned.plan?.text??'',/صفحة 3 من 3/);
   assert.equal(buttons(returned).filter(b=>b.startsWith('🔎 ')).length,3);
   assert.ok(buttons(returned).includes('⬅️ السابق · s:Grant:1'));
  }finally{await f.close();}
 });
 test('B3 '+engine+': archived, unpublished, or renamed matches invalidate old search-result selections',async()=>{
  const f=await fixture(engine);try{
   const listing=await f.app().handle(msg(240,'/search Grant'));
   const token=buttons(listing).find(b=>b.includes('resource-00'))!;
   await f.education.archiveResource(OWNER,'resource-00');
   const denied=await f.app().handle(msg(241,token));
   assert.equal(denied.status,'DENIED');assert.equal(denied.plan,undefined);
   const next=await f.app().handle(msg(242,'/search Grant'));
   const other=buttons(next).find(b=>b.includes('resource-01'))!;
   await f.store.transaction(s=>{s.educationResources.find(r=>r.id==='resource-01')!.title='Other available title';});
   const stale=await f.app().handle(msg(243,other));
   assert.equal(stale.status,'DENIED');assert.equal(stale.plan,undefined);
  }finally{await f.close();}
 });
 test('B3 '+engine+': forged query or wrong page cannot rebind a resource selection to an unrelated result',async()=>{
  const f=await fixture(engine);try{
   const listing=await f.app().handle(msg(250,'/search Grant'));
   const original=buttons(listing).find(b=>b.includes('resource-00'))!;
   const changedQuery=original.replace(' · s:Grant:0',' · s:China:0');
   const changedPage=original.replace(' · s:Grant:0',' · s:Grant:2');
   for(const [i,text] of [changedQuery,changedPage].entries()){
    const r=await f.app().handle(msg(251+i,text));
    assert.equal(r.status,'DENIED',text);
    assert.equal(r.plan,undefined);
   }
   assert.equal((await f.app().handle(msg(253,original))).status,'APPLIED');
  }finally{await f.close();}
 });
 test('B3 '+engine+': invalid search return labels and malformed selection contexts do not enter a result list',async()=>{
  const f=await fixture(engine);try{
   const invalid=[
    '↩️ نتائج البحث · s:Grant:01',
    '↩️ نتائج البحث · s:Grant:-1',
    '↩️ نتائج البحث · s:Grant:1000',
    '↩️ نتائج البحث · s:<bad>:0',
    '↩️ نتائج البحث · s:Grant:0\n/admin',
    '↩️ نتائج البحث · s:Grant:999',
    '🔎 Scholarship 00 · resource-00 · s:Grant:01',
    '🔎 Scholarship 00 · resource-00 · s:Grant:999',
    '🔎 Scholarship 00 · resource-00 · s:<bad>:0'
   ];
   for(const [i,text] of invalid.entries()){
    const r=await f.app().handle(msg(260+i,text));
    assert.equal(r.status,'DENIED',text);
    assert.equal(r.plan,undefined);
   }
  }finally{await f.close();}
 });
 test('B3 '+engine+': search-origin resources and breadcrumbs are revoked with private navigation',async()=>{
  const f=await fixture(engine);try{
   const listing=await f.app().handle(msg(275,'/search Grant'));
   const token=buttons(listing).find(b=>b.includes('resource-00'))!;
   await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
   for(const [i,label] of [token,'↩️ نتائج البحث · s:Grant:0'].entries()){
    const r=await f.app().handle(msg(276+i,label));
    assert.equal(r.status,'DENIED');
    assert.equal(r.plan,undefined);
   }
  }finally{await f.close();}
 });
 test('B3 '+engine+': Arabic search origin is retained on selection and not stored as student browsing history',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.educationResources.find(r=>r.id==='resource-00')!.title='منحة الصين ٢٠٢٧';});
   const result=await f.app().handle(msg(280,'/search منحة الصين'));
   const token=buttons(result).find(b=>b.includes('resource-00'))!;
   assert.match(token,/ · s:منحة الصين:0$/u);
   const opened=await f.app().handle(msg(281,token));
   assert.equal(opened.status,'APPLIED');
   assert.ok(buttons(opened).includes('↩️ نتائج البحث · s:منحة الصين:0'));
   const returned=await f.app().handle(msg(282,'↩️ نتائج البحث · s:منحة الصين:0'));
   assert.equal(returned.status,'APPLIED');
   assert.match(returned.plan?.text??'',/منحة الصين/);
   const state=await f.store.snapshot();
   assert.equal('studentSearchSessions' in state,false);
   assert.equal(isValidTelegramReplyKeyboard(opened.plan?.replyMarkup),true);
  }finally{await f.close();}
 });
 test('B3 '+engine+': max-sized ids or long Arabic query fall back to standard bounded resource buttons',async()=>{
  const f=await fixture(engine);try{
   const longId='r'.repeat(64),longQuery='منحة'.repeat(6)+'ين';
   await f.store.transaction(s=>{
    s.educationResources.push({
     id:longId,categoryId:'grants',scope:'private',title:longQuery,
     university:'University',cycle:'2027',degree:'Bachelor',seats:null,
     sourceImportId:'import',sourceLocator:'long',reviewedBy:OWNER,status:'PUBLISHED'
    });
   });
   const listing=await f.app().handle(msg(290,'/search '+longQuery));
   assert.equal(listing.status,'APPLIED');
   assert.equal(isValidTelegramReplyKeyboard(listing.plan?.replyMarkup),true);
   const token=buttons(listing).find(b=>b.includes(longId));
   assert.ok(token);
   assert.equal(token!.includes(' · s:'),false);
   const opened=await f.app().handle(msg(291,token!));
   assert.equal(opened.status,'APPLIED');
   assert.ok(buttons(opened).includes('↩️ موارد القسم · grants'));
  }finally{await f.close();}
 });
}
