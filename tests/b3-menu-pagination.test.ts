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
import {isValidTelegramReplyKeyboard,parseMenuPageCommand} from '../src/telegram-menu.js';

const text=(id:number,input:string,actor=300)=>({
 update_id:id,message:{chat:{id:actor,type:'private'},from:{id:actor,is_bot:false},text:input}});
const labels=(p:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>p.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-paged-menu-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,'100');
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 for(let i=0;i<13;i++)await education.createCategory('100',{
  id:'grants-'+i.toString().padStart(2,'0'),scope:'private',
  title:'منح معتمدة '+i,order:i
 });
 const createResources=async()=>{
  await store.transaction(s=>{for(let i=0;i<23;i++)s.educationResources.push({
   id:'r-'+i.toString().padStart(2,'0'),scope:'private',categoryId:'grants-00',
   title:'منحة رقم '+i,university:'جامعة معتمدة',cycle:'2026',degree:'Bachelor',
   seats:1,sourceImportId:'imp-'+i,sourceLocator:'row-'+i,
   reviewedBy:'100',status:'PUBLISHED'
  });});
 };
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,store,education,app,createResources,close:()=>rm(dir,{recursive:true,force:true})};
}
test('B3 page UI: first 10 scholarship categories have next; next and previous show all',async()=>{
 const f=await fixture();try{
  const a=await f.app().handle(text(1,'🎓 المنح الدراسية'));
  assert.equal(a.status,'APPLIED');assert.match(a.plan?.text??'',/صفحة 1 من 2/);
  const next=labels(a).find(x=>x.startsWith('➡️ التالي · c:scholarships:'));
  assert.ok(next);assert.equal(labels(a).filter(x=>x.startsWith('📁 ')).length,10);
  const b=await f.app().handle(text(2,next!));
  assert.equal(b.status,'APPLIED');assert.match(b.plan?.text??'',/صفحة 2 من 2/);
  assert.equal(labels(b).filter(x=>x.startsWith('📁 ')).length,3);
  assert.ok(labels(b).some(x=>x.includes('grants-12')));
  const back=labels(b).find(x=>x.startsWith('⬅️ السابق · c:scholarships:'));
  assert.ok(back);
  const c=await f.app().handle(text(3,back!));
  assert.equal(c.status,'APPLIED');assert.ok(labels(c).some(x=>x.includes('grants-00')));
  assert.equal(isValidTelegramReplyKeyboard(b.plan?.replyMarkup),true);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+' resource pages: 23 reviewed entries accessible without revealing other categories',async()=>{
  const f=await fixture(engine);try{
   await f.createResources();
   const section=await f.app().handle(text(4,'🎓 المنح الدراسية'));
   const cat=labels(section).find(x=>x.includes('grants-00'))!;
   const first=await f.app().handle(text(5,cat));
   assert.match(first.plan?.text??'',/صفحة 1 من 3/);
   const second=await f.app().handle(text(6,labels(first).find(x=>x.startsWith('➡️ التالي · r:'))!));
   assert.match(second.plan?.text??'',/صفحة 2 من 3/);
   const third=await f.app().handle(text(7,labels(second).find(x=>x.startsWith('➡️ التالي · r:'))!));
   assert.match(third.plan?.text??'',/صفحة 3 من 3/);
   assert.equal(labels(third).filter(x=>x.startsWith('🔎 ')).length,3);
   const last=labels(third).find(x=>x.includes('r-22'))!;
   const opened=await f.app().handle(text(8,last));
   assert.equal(opened.status,'APPLIED');assert.match(opened.plan?.text??'',/منحة رقم 22/);
  }finally{await f.close();}
 });
}
test('B3 page UI rejects forged pages, invalid section, negative page and future out-of-range pages',async()=>{
 const f=await fixture();try{
  const attempts=[
   '➡️ التالي · c:scholarships:999',
   '⬅️ السابق · c:scholarships:999',
   '➡️ التالي · c:all:3',
   '➡️ التالي · c:admin:1',
   '➡️ التالي · r:grants-00:1',
   '➡️ التالي · c:scholarships:-1',
   '➡️ التالي · c:scholarships:01',
   '⬅️ السابق · c:scholarships:1',
   '➡️ التالي · c:scholarships:0',
   '➡️ التالي · c:scholarships:9999'
  ];
  for(const [i,command] of attempts.entries()){
   const r=await f.app().handle(text(20+i,command));
   assert.equal(r.status,'DENIED',command);assert.equal(r.plan,undefined);
  }
 }finally{await f.close();}
});
test('B3 page UI cannot browse a disabled hidden category after paging',async()=>{
 const f=await fixture();try{
  await f.education.setCategoryEnabled('100','grants-12',false);
  const first=await f.app().handle(text(40,'🎓 المنح الدراسية'));
  const page=await f.app().handle(text(41,labels(first).find(x=>x.startsWith('➡️ التالي · c:'))!));
  assert.equal(page.status,'APPLIED');
  assert.equal(labels(page).some(x=>x.includes('grants-12')),false);
  await f.education.setCategoryEnabled('100','grants-11',false);
  await f.education.setCategoryEnabled('100','grants-10',false);
  const nowInvalid=await f.app().handle(text(42,'➡️ التالي · c:scholarships:1'));
  assert.equal(nowInvalid.status,'DENIED');
 }finally{await f.close();}
});
test('B3 page parser accepts only exact canonical static navigation grammar',()=>{
 for(const x of ['➡️ التالي · c:all:1','⬅️ السابق · r:grants-12:0']){
  assert.ok(parseMenuPageCommand(x));
 }
 for(const x of ['➡️ التالي · c:all:00','➡️ التالي · c:owner:1','➡️ التالي · r:../:2',
  '➡️ التالي · c:all:1000','➡️ التالي · c:all:1\n','️➡️ التالي · c:all:1']){
  assert.equal(parseMenuPageCommand(x),null,x);
 }
});
