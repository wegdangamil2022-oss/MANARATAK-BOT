import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramReplyKeyboard,menuLabels} from '../src/telegram-menu.js';

const OWNER='100',STUDENT=300,GROUP='-100333';
const msg=(id:number,text:string,actor=STUDENT,group=false)=>({
 update_id:id,message:{message_id:id,
 chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];

async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-breadcrumb-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await education.createCategory(OWNER,{id:'scholarships',scope:'private',
  title:'🎓 المنح الدراسية',order:1});
 await education.createCategory(OWNER,{id:'courses',scope:'private',
  title:'📚 الدورات التعليمية',order:2});
 await education.createCategory(OWNER,{id:'group-secret',scope:GROUP,
  title:'موارد مجموعة لا تظهر في الخاص',order:1});
 await store.transaction(s=>{
  for(let n=0;n<14;n++)s.educationResources.push({
   id:'grant-'+String(n).padStart(2,'0'),categoryId:'scholarships',
   scope:'private',title:'Scholarship '+String(n).padStart(2,'0'),
   university:'Uni',cycle:'2026',degree:'Bachelor',seats:null,
   sourceImportId:'import',sourceLocator:'row-'+n,reviewedBy:OWNER,status:'PUBLISHED'});
 });
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {store,education,app,close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': student can return from a resource detail to its exact reviewed category',async()=>{
  const f=await fixture(engine);try{
   const categories=await f.app().handle(msg(1,menuLabels.scholarships));
   assert.equal(categories.status,'APPLIED');
   const cat=buttons(categories).find(x=>x.includes('scholarships'));
   assert.ok(cat);
   const resources=await f.app().handle(msg(2,cat!));
   assert.equal(resources.status,'APPLIED');
   const item=buttons(resources).find(x=>x.includes('grant-00'));
   assert.ok(item);
   const opened=await f.app().handle(msg(3,item!));
   assert.equal(opened.status,'APPLIED');
   assert.match(opened.plan?.text??'',/Scholarship 00/);
   assert.equal(isValidTelegramReplyKeyboard(opened.plan?.replyMarkup),true);
   assert.ok(buttons(opened).includes('↩️ موارد القسم · scholarships'));
   const returned=await f.app().handle(msg(4,'↩️ موارد القسم · scholarships'));
   assert.equal(returned.status,'APPLIED');
   assert.match(returned.plan?.text??'',/Scholarship 00/);
   assert.equal(buttons(returned).filter(x=>x.startsWith('🔎 ')).length,10);
   assert.equal((returned.plan?.text??'').includes('موارد مجموعة'),false);
  }finally{await f.close();}
 });
 test('B3 '+engine+': resource listing has an all-categories breadcrumb that actually opens published sections',async()=>{
  const f=await fixture(engine);try{
   const resources=await f.app().handle(msg(10,'↩️ موارد القسم · scholarships'));
   assert.equal(resources.status,'APPLIED');
   assert.ok(buttons(resources).includes('↩️ جميع الأقسام'));
   const listing=await f.app().handle(msg(11,'↩️ جميع الأقسام'));
   assert.equal(listing.status,'APPLIED');
   assert.match(listing.plan?.text??'',/التعليم والموارد/);
   assert.ok(buttons(listing).some(x=>x.includes('scholarships')));
   assert.ok(buttons(listing).some(x=>x.includes('courses')));
   assert.equal((listing.plan?.text??'').includes('موارد مجموعة'),false);
   assert.equal(isValidTelegramReplyKeyboard(listing.plan?.replyMarkup),true);
  }finally{await f.close();}
 });
 test('B3 '+engine+': full ten-item resource page retains both paging and category breadcrumb',async()=>{
  const f=await fixture(engine);try{
   const first=await f.app().handle(msg(20,'↩️ موارد القسم · scholarships'));
   assert.equal(buttons(first).filter(x=>x.startsWith('🔎 ')).length,10);
   assert.ok(buttons(first).includes('➡️ التالي · r:scholarships:1'));
   assert.ok(buttons(first).includes('↩️ جميع الأقسام'));
   assert.equal(isValidTelegramReplyKeyboard(first.plan?.replyMarkup),true);
   const second=await f.app().handle(msg(21,'➡️ التالي · r:scholarships:1'));
   assert.equal(second.status,'APPLIED');
   assert.equal(buttons(second).filter(x=>x.startsWith('🔎 ')).length,4);
   assert.ok(buttons(second).includes('⬅️ السابق · r:scholarships:0'));
   assert.ok(buttons(second).includes('↩️ جميع الأقسام'));
   assert.equal(isValidTelegramReplyKeyboard(second.plan?.replyMarkup),true);
  }finally{await f.close();}
 });
 test('B3 '+engine+': stale category breadcrumbs fail closed after category disable or source withdrawal',async()=>{
  const f=await fixture(engine);try{
   const before=await f.app().handle(msg(30,'↩️ موارد القسم · scholarships'));
   assert.equal(before.status,'APPLIED');
   await f.education.setCategoryEnabled(OWNER,'scholarships',false);
   const old=await f.app().handle(msg(31,'↩️ موارد القسم · scholarships'));
   assert.equal(old.status,'DENIED');
   assert.equal(old.plan,undefined);
   const now=await f.app().handle(msg(32,'↩️ جميع الأقسام'));
   assert.equal(now.status,'APPLIED');
   assert.equal(buttons(now).some(x=>x.includes('scholarships')),false);
   assert.equal((now.plan?.text??'').includes('Scholarship 00'),false);
  }finally{await f.close();}
 });
 test('B3 '+engine+': forged category breadcrumb never exposes group scope or arbitrary identifiers',async()=>{
  const f=await fixture(engine);try{
   for(const [i,text] of [
    '↩️ موارد القسم · group-secret','↩️ موارد القسم · ../secret',
    '↩️ موارد القسم · scholarships\n/admin',
    '↩️ موارد القسم · scholarships ','↩️ موارد القسم · ',
    '↩️ موارد القسم · '+('x'.repeat(300))
   ].entries()){
    const r=await f.app().handle(msg(50+i,text));
    assert.equal(r.status,'DENIED',text);
    assert.equal(r.plan,undefined);
   }
   const inGroup=await f.app().handle(msg(59,'↩️ موارد القسم · scholarships',STUDENT,true));
   assert.equal(inGroup.plan,undefined);
  }finally{await f.close();}
 });
}
