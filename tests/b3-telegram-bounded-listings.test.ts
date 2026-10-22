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
import {menuLabels,categoryButton,resourceButton,isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
import {privateFAQBrowseLabel} from '../src/telegram-private-faq.js';
import {parseSearchResourceSelection} from '../src/telegram-search.js';

const OWNER='100',STUDENT=300,GROUP='-100555';
const message=(updateId:number,text:string,group=false)=>({
 update_id:updateId,message:{message_id:updateId,from:{id:STUDENT,is_bot:false},
  chat:{id:group?Number(GROUP):STUDENT,type:group?'supergroup':'private'},text}
});
const keys=(result:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 result.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
function expectTelegramPlan(result:Awaited<ReturnType<TelegramUpdateApplication['handle']>>){
 assert.equal(result.status,'APPLIED',result.reason);
 assert.ok(result.plan);
 assert.ok(Buffer.byteLength(result.plan!.text,'utf8')<=4096);
 if(result.plan!.replyMarkup)assert.equal(isValidTelegramReplyKeyboard(result.plan!.replyMarkup),true);
 assert.equal(result.plan!.text.includes('<script>'),false);
}
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-safe-listings-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'data.sqlite':'data.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await education.createCategory(OWNER,{id:'scholarships',scope:'private',title:'منح دراسية',order:0});
 await education.createCategory(OWNER,{id:'other',scope:GROUP,title:'منح المجموعة',order:0});
 await store.transaction(s=>{
  for(let i=0;i<10;i++){
   const key=String(i).padStart(2,'0');
   s.educationResources.push({
    id:'grant-'+key,scope:'private',categoryId:'scholarships',
    title:'Grant '+key+' '+('<&>'.repeat(78)),university:'جامعة',cycle:'2027',
    degree:'Bachelor',seats:null,sourceImportId:'import',
    sourceLocator:key,reviewedBy:OWNER,status:'PUBLISHED'
   });
   s.faqEntries.push({
    id:randomUUID(),scope:'private',question:'منحة '+key+' '+('&<>'.repeat(62)),
    aliases:[],answer:'إجابة معتمدة '+key,sourceResourceId:'grant-'+key,
    createdBy:OWNER,approvedBy:OWNER,createdAt:i,status:'APPROVED'
   });
  }
  for(let i=0;i<10;i++){
   const key=String(i).padStart(2,'0');
   s.educationCategories.push({id:'other-'+key,scope:'private',parentId:null,
    title:'منح '+key+' '+('&'.repeat(85)),order:i+1,enabled:true});
  }
 });
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {store,education,app,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': 10 HTML-expanded reviewed FAQ titles fit Telegram and retain answer selection',async()=>{
  const f=await fixture(engine);try{
   const result=await f.app().handle(message(1,privateFAQBrowseLabel));
   expectTelegramPlan(result);
   const choice=keys(result).find(x=>x.startsWith('📖 سؤال '));
   assert.ok(choice);
   const selected=await f.app().handle(message(2,choice!));
   expectTelegramPlan(selected);assert.match(selected.plan!.text,/إجابة معتمدة/);
   assert.equal(result.plan!.text.includes('<&>'),false);
   const search=await f.app().handle(message(3,'/faqsearch منحة'));
   expectTelegramPlan(search);
   assert.equal(keys(search).filter(x=>x.startsWith('📖 سؤال ')).length,10);
  }finally{await f.close();}
 });
 test('B3 '+engine+': published resources with repeated angle brackets fit 10-row search and category views',async()=>{
  const f=await fixture(engine);try{
   const found=await f.app().handle(message(11,'/search Grant'));
   expectTelegramPlan(found);
   assert.equal(keys(found).filter(x=>x.startsWith('🔎 ')).length,10);
   const clicked=await f.app().handle(message(12,keys(found).find(x=>x.startsWith('🔎 '))!));
   expectTelegramPlan(clicked);
   const categories=await f.app().handle(message(13,menuLabels.library));
   expectTelegramPlan(categories);
   const grants=keys(categories).find(x=>x.endsWith(' · scholarships'));
   assert.ok(grants);
   const resourceList=await f.app().handle(message(14,grants!));
   expectTelegramPlan(resourceList);
  }finally{await f.close();}
 });
 test('B3 '+engine+': long HTML-escaped category titles keep keyboard within Telegram bytes and open by exact label',async()=>{
  const f=await fixture(engine);try{
   const r=await f.app().handle(message(21,menuLabels.library));
   expectTelegramPlan(r);
   const next=keys(r).find(x=>x.startsWith('➡️ التالي · c:'));
   assert.ok(next);
   const second=await f.app().handle(message(22,next!));
   expectTelegramPlan(second);
   assert.ok(keys(second).some(x=>x.includes('other-09')));
  }finally{await f.close();}
 });
}
test('B3 category and resource buttons limit bytes AND codepoints for 4-byte emoji and long UTF-8 titles',()=>{
 const sources=[
  {id:'grants',title:'🎓'.repeat(100)},
  {id:'x'.repeat(64),title:'م'.repeat(100)},
  {id:'study',title:'\u202e'.repeat(10)+'\n'+'🎓'.repeat(80)}
 ];
 for(const source of sources)for(const button of [categoryButton(source as Parameters<typeof categoryButton>[0]),resourceButton(source)]){
  assert.ok(Buffer.byteLength(button,'utf8')<=256,button.length.toString());
  assert.ok(Array.from(button).length<=96);
  assert.equal(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(button),false);
 }
});
test('B3 stale/reworded student resource button is never an authority even if title clipping collides',async()=>{
 const f=await fixture('sqlite');try{
  const search=await f.app().handle(message(40,'/search Grant'));
  expectTelegramPlan(search);
  const button=keys(search).find(x=>x.startsWith('🔎 '))!;
  const id=parseSearchResourceSelection(button)?.resourceId??button.split(' · ').at(-1)!;
  await f.store.transaction(s=>{s.educationResources.find(r=>r.id===id)!.title='A different reviewed title';});
  const stale=await f.app().handle(message(41,button));
  assert.equal(stale.status,'DENIED');assert.equal(stale.plan,undefined);
 }finally{await f.close();}
});
