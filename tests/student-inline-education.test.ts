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
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {studentInlineRoute} from '../src/telegram-inline-student.js';

const OWNER='100',STUDENT='300';
const msg=(i:number,actor:number,text:string)=>({update_id:i,message:{
 message_id:i,chat:{id:actor,type:'private'},from:{id:actor,is_bot:false},text}});
const cb=(i:number,actor:number,data:string,group=false)=>({update_id:i,callback_query:{
 id:'student_'+i,from:{id:actor,is_bot:false},data,
 message:{message_id:77,chat:{id:group?-100123:actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}
}});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-student-inline-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 const close=()=>rm(dir,{force:true,recursive:true});
 await education.createCategory(OWNER,{id:'scholarships',scope:'private',title:'منح <آمنة> & فرص',order:1});
 await education.createCategory(OWNER,{id:'courses',scope:'private',title:'الدورات',order:2});
 await store.transaction(s=>{
  s.educationResources.push({
   id:'public1',categoryId:'scholarships',scope:'private',title:'منحة <الطب> & الهندسة',
   university:'جامعة A',cycle:'2027',degree:'Bachelor',seats:5,
   sourceImportId:'secret-import',sourceLocator:'secret-row',reviewedBy:'hidden-owner',status:'PUBLISHED'
  });
  s.educationResources.push({
   id:'old1',categoryId:'scholarships',scope:'private',title:'مورد مؤرشف',
   university:'U',cycle:'2020',degree:'X',seats:null,
   sourceImportId:'import',sourceLocator:'row',reviewedBy:OWNER,status:'ARCHIVED'
  });
 });
 return {store,policy,app,education,close};
}
test('student inline router rejects malformed, noncanonical and owner callback selectors',()=>{
 assert.deepEqual(studentInlineRoute('si:1:h'),{kind:'categories',page:0});
 assert.deepEqual(studentInlineRoute('si:1:p:2'),{kind:'categories',page:2});
 assert.deepEqual(studentInlineRoute('si:1:c:0:1:abcdef012345'),
 {kind:'resources',catPage:0,slot:1,categoryDigest:'abcdef012345',page:0});
 assert.deepEqual(studentInlineRoute('si:1:l:0:1:abcdef012345:2'),
 {kind:'resources',catPage:0,slot:1,categoryDigest:'abcdef012345',page:2});
 assert.deepEqual(studentInlineRoute('si:1:r:0:1:abcdef012345:0:1:123456abcdef'),
 {kind:'detail',catPage:0,slot:1,categoryDigest:'abcdef012345',page:0,
 resourceSlot:1,resourceDigest:'123456abcdef'});
 for(const bad of ['si:1:p:00','si:1:p:1000','si:1:c:0:0:abcdef012345',
  'si:1:c:0:9:abcdef012345','si:1:c:0:1:ABCDEF012345',
  'si:1:l:0:1:abcdef012345:01','si:1:r:0:1:abcdef012345:0:0:123456abcdef',
  'si:1:r:0:1:abcdef012345:0:1:123456abcdef\n',
  'si:1:r:0:1:abcdef012345:0:1:123456abcdef:publish',
  'si:1:p:0\n','mi:1:h','ms:1:h','si:2:h','si:1:x'])
  assert.equal(studentInlineRoute(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('student navigates live published private catalogue with actual inline back/home ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(msg(1,300,'/studentinline'));
   assert.equal(home.status,'APPLIED');
   assert.equal(isValidTelegramInlineKeyboard(home.plan?.inlineMarkup),true);
   assert.match(home.plan?.text??'',/التعليم|المكتبة/);
   const items=buttons(home).filter(x=>x.callback_data.startsWith('si:1:c:'));
   assert.equal(items.length,2);
   assert.ok(items.some(x=>x.text.includes('منح')));
   assert.equal(items.some(x=>x.text.includes('لوحة المالك')),false);
   const choose=items.find(x=>x.text.includes('منح'))!;
   const resources=await f.app().handle(cb(2,300,choose.callback_data));
   assert.equal(resources.status,'APPLIED');
   assert.equal(resources.plan?.editMessageId,77);
   assert.match(resources.plan?.text??'',/منح &lt;آمنة&gt; &amp; فرص/);
   const resource=buttons(resources).find(x=>x.callback_data.startsWith('si:1:r:'))!;
   assert.ok(resource);
   assert.equal(buttons(resources).filter(x=>x.callback_data.startsWith('si:1:r:')).length,1);
   const opened=await f.app().handle(cb(3,300,resource.callback_data));
   assert.equal(opened.status,'APPLIED');
   assert.match(opened.plan?.text??'',/منحة &lt;الطب&gt; &amp; الهندسة/);
   assert.match(opened.plan?.text??'',/جامعة A/);
   assert.doesNotMatch(opened.plan?.text??'',/secret-import|secret-row|hidden-owner/);
   assert.equal(isValidTelegramInlineKeyboard(opened.plan?.inlineMarkup),true);
   const back=buttons(opened).find(x=>x.callback_data.startsWith('si:1:l:'))!;
   assert.equal((await f.app().handle(cb(4,300,back.callback_data))).status,'APPLIED');
   assert.equal(buttons(opened).some(x=>x.callback_data==='si:1:h'),true);
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
 test('hidden category or archived resource invalidates old selector without leaking content ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(msg(10,300,'/studentinline'));
   const cat=buttons(home).find(x=>x.text.includes('منح'))!.callback_data;
   const menu=await f.app().handle(cb(11,300,cat));
   const item=buttons(menu).find(x=>x.callback_data.startsWith('si:1:r:'))!.callback_data;
   await f.store.transaction(s=>{s.educationResources.find(r=>r.id==='public1')!.status='ARCHIVED';});
   assert.equal((await f.app().handle(cb(12,300,item))).status,'DENIED');
   await f.education.setCategoryEnabled(OWNER,'scholarships',false);
   assert.equal((await f.app().handle(cb(13,300,cat))).status,'DENIED');
   assert.equal((await f.app().handle(cb(14,300,'si:1:h'))).status,'APPLIED');
   const again=await f.app().handle(cb(15,300,'si:1:h'));
   assert.equal(buttons(again).filter(x=>x.callback_data.startsWith('si:1:c:')).length,1);
  }finally{await f.close();}
 });
 test('private education disable returns DENIED even for previously issued view ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const first=await f.app().handle(msg(20,300,'/studentinline'));
   const token=buttons(first).find(x=>x.callback_data.startsWith('si:1:c:'))!.callback_data;
   await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
   assert.equal((await f.app().handle(cb(21,300,token))).status,'DENIED');
   assert.equal((await f.app().handle(cb(22,300,'si:1:h'))).status,'DENIED');
   assert.equal((await f.app().handle(msg(23,300,'/studentinline'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(24,300,'mi:1:h'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('paginates category catalogue and rejects stale item shifted to another page ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<16;i++)
    await f.education.createCategory(OWNER,{id:'extra'+String(i).padStart(2,'0'),
     scope:'private',title:'المورد '+i,order:3+i});
   const p1=await f.app().handle(cb(30,300,'si:1:p:1'));
   assert.equal(p1.status,'APPLIED');
   assert.equal(buttons(p1).filter(x=>x.callback_data.startsWith('si:1:c:')).length,8);
   const p2=await f.app().handle(cb(31,300,'si:1:p:2'));
   assert.equal(buttons(p2).filter(x=>x.callback_data.startsWith('si:1:c:')).length,2);
   assert.equal((await f.app().handle(cb(32,300,'si:1:p:3'))).status,'DENIED');
   const old=buttons(p1).filter(x=>x.callback_data.startsWith('si:1:c:')).at(-1)!.callback_data;
   await f.education.createCategory(OWNER,{id:'first',scope:'private',title:'أول',order:0});
   assert.equal((await f.app().handle(cb(33,300,old))).status,'DENIED');
  }finally{await f.close();}
 });
 test('forbidden group context, owner impersonation and duplicate update fail closed ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.app().handle(cb(40,300,'si:1:h',true))).status,'DENIED');
   assert.equal((await f.app().handle(cb(41,300,'ms:1:h'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(42,300,'mi:1:h'))).status,'DENIED');
   const data=cb(43,300,'si:1:h');
   const a=await f.app().handle(data),b=await f.app().handle(data);
   assert.equal(a.status,'APPLIED');assert.equal(b.status,'DUPLICATE');
   assert.equal(b.callbackQueryId,'student_43');assert.equal(b.plan,undefined);
  }finally{await f.close();}
 });
 test('empty private catalogue gives truthful page with return to main ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{for(const c of s.educationCategories)c.enabled=false;});
   const home=await f.app().handle(msg(50,300,'/studentinline'));
   assert.equal(home.status,'APPLIED');
   assert.match(home.plan?.text??'',/لا توجد|فارغة/);
   assert.equal(buttons(home).filter(x=>x.callback_data.startsWith('si:1:c:')).length,0);
   assert.equal(isValidTelegramInlineKeyboard(home.plan?.inlineMarkup),true);
  }finally{await f.close();}
 });
}
