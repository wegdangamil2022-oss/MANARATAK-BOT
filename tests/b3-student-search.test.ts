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
