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
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
const event=(id:number,data:string,actor=100,group=false)=>({update_id:id,callback_query:{id:'category_'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
const message=(id:number,text:string)=>({update_id:id,message:{message_id:id,date:1700000000,from:{id:100,is_bot:false},chat:{id:100,type:'private'},text}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const select=(r:Result,title:string)=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.text.includes(title));assert.ok(b,'missing '+title);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(count=2){const dir=await mkdtemp(join(tmpdir(),'inline-cats-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=1700000000000;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);
  for(let i=0;i<count;i++)await education.createCategory('100',{id:'cat-'+i,scope:'private',title:'قسم '+i,order:i});
  const app=()=>new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education),faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),clock:()=>now,botId:'category-local',botUsername:'ManaratakBot',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  return {store,policy,education,app,time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('owner category rename and branch/root creation preview then commit once ('+engine+')',async()=>{
  const f=await fixture();try{
   let root=await f.app().handle(event(100,'mi:1:i:10:16')),detail=await f.app().handle(event(101,select(root,'قسم 0')));
   assert.equal((await f.app().handle(event(102,select(detail,'تغيير الاسم')))).status,'APPLIED');
   const preview=await f.app().handle(message(103,'قسم <جديد>'));assert.ok(preview.plan!.text.includes('&lt;جديد&gt;'));assert.equal((await f.store.snapshot()).educationCategories[0]!.title,'قسم 0');
   const confirm=select(preview,'تأكيد الحفظ');const results=await Promise.all([f.app().handle(event(104,confirm)),f.app().handle(event(105,confirm))]);assert.equal(results.filter(r=>r.status==='APPLIED').length,1);
   assert.equal((await f.store.snapshot()).educationCategories[0]!.title,'قسم <جديد>');
   root=await f.app().handle(event(106,'ec:1:h'));detail=await f.app().handle(event(107,select(root,'قسم <جديد>')));
   await f.app().handle(event(108,select(detail,'إضافة فرع')));const childReview=await f.app().handle(message(109,'فرع تعليمي'));assert.equal((await f.app().handle(event(110,select(childReview,'تأكيد الحفظ')))).status,'APPLIED');
   const child=(await f.store.snapshot()).educationCategories.find(c=>c.title==='فرع تعليمي')!;assert.equal(child.parentId,'cat-0');assert.equal(child.scope,'private');
   root=await f.app().handle(event(111,'ec:1:h'));await f.app().handle(event(112,select(root,'قسم رئيسي')));const rootReview=await f.app().handle(message(113,'قسم مستقل'));
   assert.equal((await f.app().handle(event(114,select(rootReview,'تأكيد الحفظ')))).status,'APPLIED');assert.equal((await f.store.snapshot()).educationCategories.find(c=>c.title==='قسم مستقل')!.parentId,null);
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
 test('owner category text confirmation rechecks expiry, dashboard and restored boolean flags ('+engine+')',async()=>{
  const f=await fixture();try{
   let root=await f.app().handle(event(230,'ec:1:h')),detail=await f.app().handle(event(231,select(root,'قسم 0')));await f.app().handle(event(232,select(detail,'تغيير الاسم')));
   let review=await f.app().handle(message(233,'اسم منتهي'));f.time(1700000120000);assert.equal((await f.app().handle(event(234,select(review,'تأكيد الحفظ')))).status,'DENIED');
   root=await f.app().handle(event(235,'ec:1:h'));detail=await f.app().handle(event(236,select(root,'قسم 0')));await f.app().handle(event(237,select(detail,'تغيير الاسم')));review=await f.app().handle(message(238,'اسم محرف'));
   const invalid=select(review,'تأكيد الحفظ');await f.store.transaction(s=>{s.callbacks.find(c=>c.ref==='c_'+invalid.slice(7))!.oneShot='true' as unknown as boolean;});assert.equal((await f.app().handle(event(239,invalid))).status,'DENIED');
   root=await f.app().handle(event(240,'ec:1:h'));detail=await f.app().handle(event(241,select(root,'قسم 0')));await f.app().handle(event(242,select(detail,'تغيير الاسم')));review=await f.app().handle(message(243,'اسم محجوب'));await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.app().handle(event(244,select(review,'تأكيد الحفظ')))).status,'DENIED');assert.equal((await f.store.snapshot()).educationCategories[0]!.title,'قسم 0');
  }finally{await f.close();}
 });
 test('owner category parent change fences both categories and prevents cycles or crossing scopes ('+engine+')',async()=>{
  const f=await fixture();try{
   let root=await f.app().handle(event(200,'ec:1:h')),detail=await f.app().handle(event(201,select(root,'قسم 1')));
   await f.app().handle(event(202,select(detail,'تغيير القسم الأب')));let review=await f.app().handle(message(203,'cat-0'));
   assert.equal((await f.store.snapshot()).educationCategories[1]!.parentId,null);
   await f.store.transaction(s=>{s.educationCategories[0]!.title='أب جديد';});assert.equal((await f.app().handle(event(204,select(review,'تأكيد الحفظ')))).status,'DENIED');
   root=await f.app().handle(event(205,'ec:1:h'));detail=await f.app().handle(event(206,select(root,'قسم 1')));await f.app().handle(event(207,select(detail,'تغيير القسم الأب')));review=await f.app().handle(message(208,'cat-0'));
   assert.equal((await f.app().handle(event(209,select(review,'تأكيد الحفظ')))).status,'APPLIED');assert.equal((await f.store.snapshot()).educationCategories[1]!.parentId,'cat-0');
   root=await f.app().handle(event(210,'ec:1:h'));detail=await f.app().handle(event(211,select(root,'أب جديد')));await f.app().handle(event(212,select(detail,'تغيير القسم الأب')));
   assert.equal((await f.app().handle(message(213,'cat-1'))).status,'DENIED');assert.equal((await f.app().handle(message(214,'cat-0'))).status,'DENIED');
   await f.store.transaction(s=>{s.educationCategories[1]!.scope='-100123';});assert.equal((await f.app().handle(message(215,'cat-1'))).status,'DENIED');assert.equal((await f.store.snapshot()).educationCategories[0]!.parentId,null);
  }finally{await f.close();}
 });
 test('owner category language is reviewed and persisted without translating content or changing scope ('+engine+')',async()=>{
  const f=await fixture();try{
   const root=await f.app().handle(event(160,'ec:1:h')),detail=await f.app().handle(event(161,select(root,'قسم 0')));
   await f.app().handle(event(162,select(detail,'لغة التصنيف')));assert.equal((await f.app().handle(message(163,'<script>'))).status,'DENIED');
   const review=await f.app().handle(message(164,'en'));assert.equal((await f.store.snapshot()).educationCategories[0]!.language,undefined);
   assert.equal((await f.app().handle(event(165,select(review,'تأكيد الحفظ')))).status,'APPLIED');
   const cat=(await f.store.snapshot()).educationCategories[0]!;assert.equal(cat.language,'en');assert.equal(cat.scope,'private');assert.equal(cat.title,'قسم 0');
  }finally{await f.close();}
 });
 test('owner category text edits reject stale metadata, invalid input, expiry and cancel on navigation ('+engine+')',async()=>{
  const f=await fixture();try{
   let root=await f.app().handle(event(130,'ec:1:h')),detail=await f.app().handle(event(131,select(root,'قسم 0')));
   await f.app().handle(event(132,select(detail,'تغيير الاسم')));assert.equal((await f.app().handle(message(133,'أ'.repeat(101)))).status,'DENIED');
   const review=await f.app().handle(message(134,'اسم صالح'));await f.store.transaction(s=>{s.educationCategories[0]!.order++;});assert.equal((await f.app().handle(event(135,select(review,'تأكيد الحفظ')))).status,'DENIED');
   root=await f.app().handle(event(136,'ec:1:h'));detail=await f.app().handle(event(137,select(root,'قسم 0')));await f.app().handle(event(138,select(detail,'تغيير الاسم')));
   await f.app().handle(message(139,'/start'));assert.equal((await f.app().handle(message(140,'لا تحفظ هذا'))).reason!=='CATEGORY_TEXT_PREVIEW',true);
   root=await f.app().handle(event(141,'ec:1:h'));detail=await f.app().handle(event(142,select(root,'قسم 0')));await f.app().handle(event(143,select(detail,'إضافة فرع')));f.time(1700000600000);
   assert.equal((await f.app().handle(message(144,'منتهي'))).status,'DENIED');assert.equal((await f.store.snapshot()).educationCategories.length,2);
  }finally{await f.close();}
 });
 test('owner categories use approved entry, preview and one-shot confirmation ('+engine+')',async()=>{
  const f=await fixture();try{
   const root=await f.app().handle(event(1,'mi:1:i:10:16'));assert.equal(root.status,'APPLIED');assert.equal(root.plan!.editMessageId,55);assert.ok(isValidTelegramInlineKeyboard(root.plan!.inlineMarkup));
   const detail=await f.app().handle(event(2,select(root,'قسم 0')));const review=await f.app().handle(event(3,select(detail,'مراجعة التعطيل')));const route=select(review,'تأكيد التعطيل');
   const results=await Promise.all([f.app().handle(event(4,route)),f.app().handle(event(5,route))]);assert.equal(results.filter(r=>r.status==='APPLIED').length,1);
   assert.equal((await f.store.snapshot()).educationCategories[0]!.enabled,false);assert.equal((await f.store.snapshot()).educationCategories[1]!.enabled,true);assert.equal((await f.store.snapshot()).deliveries.length,0);
   assert.equal((await f.app().handle(event(6,'mi:1:i:10:16',300))).status,'DENIED');assert.equal((await f.app().handle(event(7,'mi:1:i:10:16',100,true))).status,'DENIED');
  }finally{await f.close();}
 });
 test('owner categories preserve list page after review and reorder actual siblings ('+engine+')',async()=>{
  const f=await fixture(12);try{
   const root=await f.app().handle(event(20,'mi:1:i:10:16'));const page=await f.app().handle(event(21,select(root,'التالي')));assert.ok(page.plan!.text.includes('صفحة 2 من 2'));
   const detail=await f.app().handle(event(22,select(page,'قسم 10')));const review=await f.app().handle(event(23,select(detail,'مراجعة الرفع')));const done=await f.app().handle(event(24,select(review,'تأكيد الرفع')));assert.equal(done.status,'APPLIED');
   const cats=(await f.store.snapshot()).educationCategories;assert.ok(cats.find(c=>c.id==='cat-10')!.order<cats.find(c=>c.id==='cat-9')!.order);
   const back=await f.app().handle(event(25,select(done,'إدارة الأقسام')));assert.ok(back.plan!.text.includes('صفحة 2 من 2'));
  }finally{await f.close();}
 });
 test('owner category buttons reject expiry, malformed saved flags, changed metadata and dashboard revocation ('+engine+')',async()=>{
  const f=await fixture();try{
   let root=await f.app().handle(event(40,'mi:1:i:10:16'));const old=select(root,'قسم 0');f.time(1700000120000);assert.equal((await f.app().handle(event(41,old))).status,'DENIED');
   root=await f.app().handle(event(42,'mi:1:i:10:16'));const bad=select(root,'قسم 0');await f.store.transaction(s=>{s.callbacks.find(c=>c.ref==='c_'+bad.slice(7))!.used='false' as unknown as boolean;});assert.equal((await f.app().handle(event(43,bad))).status,'DENIED');
   root=await f.app().handle(event(44,'mi:1:i:10:16'));const detail=await f.app().handle(event(45,select(root,'قسم 0')));const review=await f.app().handle(event(46,select(detail,'مراجعة التعطيل')));const confirm=select(review,'تأكيد التعطيل');
   await f.store.transaction(s=>{s.educationCategories[0]!.title='تغير';});assert.equal((await f.app().handle(event(47,confirm))).status,'DENIED');
   root=await f.app().handle(event(48,'mi:1:i:10:16'));const route=select(root,'تغير');await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});assert.equal((await f.app().handle(event(49,route))).status,'DENIED');assert.equal((await f.store.snapshot()).educationCategories[0]!.enabled,true);
  }finally{await f.close();}
 });
}
