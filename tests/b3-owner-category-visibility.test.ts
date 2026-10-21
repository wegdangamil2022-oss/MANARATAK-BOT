import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {categoryVisibilityFingerprint,ownerCategoryChoiceToken} from '../src/education-category-policy.js';
import {parseOwnerCategoryAction,parseOwnerCategoryPage} from '../src/telegram-owner-categories.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const OWNER='100',GROUP='-100123',OTHER='-100444';
const msg=(n:number,text:string,actor=100,group=false)=>({update_id:n,message:{
 message_id:n,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-category-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'db.sqlite':'db.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','publishing']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 await education.createCategory(OWNER,{id:'scholarships',scope:GROUP,title:'المنح <الرسمية> & المميزة',order:1});
 await education.createCategory(OWNER,{id:'subscholarships',scope:GROUP,title:'منح الدراسات العليا',order:2,parentId:'scholarships'});
 await education.createCategory(OWNER,{id:'privatescholarships',scope:'private',title:'فرص خاصة',order:3});
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {store,policy,education,app,close:()=>rm(dir,{recursive:true,force:true})};
}
test('owner dashboard exposes real owner category management with navigable keyboard and safe details',async()=>{
 const f=await fixture();try{
  const root=await f.app().handle(msg(1,'🔐 لوحة المالك'));
  assert.equal(root.status,'APPLIED');assert.ok(buttons(root).includes(ownerMenuLabels.categories));
  const screen=await f.app().handle(msg(2,ownerMenuLabels.categories));
  assert.equal(screen.status,'APPLIED');assert.match(screen.plan?.text??'',/الأقسام/);
  assert.equal(isValidTelegramReplyKeyboard(screen.plan?.replyMarkup),true);
  const choice=buttons(screen).find(x=>x.startsWith('🗂️ القسم · '))!;
  assert.ok(choice);const open=await f.app().handle(msg(3,choice));
  assert.equal(open.status,'APPLIED');
  assert.match(open.plan?.text??'',/القسم/);
  assert.equal((open.plan?.text??'').includes('<الرسمية>'),false);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': owner reviewed disable hides parent and child public resources, audited exactly once',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    for(const categoryId of ['scholarships','subscholarships'])s.educationResources.push({
     id:randomUUID(),categoryId,scope:GROUP,title:'Opportunity '+categoryId,
     university:'Uni',cycle:'2026',degree:'Bachelor',seats:2,
     sourceImportId:randomUUID(),sourceLocator:categoryId,reviewedBy:OWNER,status:'PUBLISHED'
    });
   });
   const list=await f.app().handle(msg(10,ownerMenuLabels.categories));
   const choice=buttons(list).find(x=>x==='🗂️ القسم · scholarships')!;
   const detail=await f.app().handle(msg(11,choice));
   assert.equal(detail.status,'APPLIED');
   assert.match(detail.plan?.text??'',/المنح &lt;الرسمية&gt; &amp; المميزة/);
   const review=buttons(detail).find(x=>x.startsWith('🔴 مراجعة التعطيل · '))!;
   const before=await f.store.snapshot();
   const preview=await f.app().handle(msg(12,review));
   assert.equal(preview.status,'APPLIED');
   assert.deepEqual((await f.store.snapshot()).educationCategories,before.educationCategories);
   const confirm=buttons(preview).find(x=>x.startsWith('⛔ تأكيد التعطيل · '))!;
   const done=await f.app().handle(msg(13,confirm));
   assert.equal(done.status,'APPLIED');
   assert.equal((await f.store.snapshot()).educationCategories.find(c=>c.id==='scholarships')!.enabled,false);
   assert.deepEqual(await f.education.listResources(OWNER,GROUP,'scholarships'),[]);
   assert.deepEqual(await f.education.listCategories(OWNER,GROUP),[]);
   assert.equal((await f.store.snapshot()).educationResources.length,2);
   assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='CATEGORY_VISIBILITY_CHANGED').length,1);
   assert.equal((await f.app().handle(msg(14,confirm))).status,'DENIED');
  }finally{await f.close();}
 });
}
test('owner deliberate reenable after parent disable restores visibility only to still-published local resources',async()=>{
 const f=await fixture();try{
  await f.education.setCategoryEnabled(OWNER,'scholarships',false);
  const list=await f.app().handle(msg(20,ownerMenuLabels.categories));
  const detail=await f.app().handle(msg(21,buttons(list).find(x=>x==='🗂️ القسم · scholarships')!));
  const review=buttons(detail).find(x=>x.startsWith('🟢 مراجعة التفعيل · '))!;
  assert.ok(review);
  const preview=await f.app().handle(msg(22,review));
  assert.match(preview.plan?.text??'',/إظهار|تفعيل/);
  const confirm=buttons(preview).find(x=>x.startsWith('✅ تأكيد التفعيل · '))!;
  assert.equal((await f.app().handle(msg(23,confirm))).status,'APPLIED');
  assert.equal((await f.store.snapshot()).educationCategories.find(c=>c.id==='scholarships')!.enabled,true);
  assert.equal((await f.app().handle(msg(24,confirm))).status,'DENIED');
 }finally{await f.close();}
});
test('category visibility confirmation rejects stale current revision after flip-flop through direct API',async()=>{
 const f=await fixture('sqlite');try{
  const list=await f.app().handle(msg(30,ownerMenuLabels.categories));
  const open=await f.app().handle(msg(31,buttons(list).find(x=>x==='🗂️ القسم · scholarships')!));
  const review=await f.app().handle(msg(32,buttons(open).find(x=>x.startsWith('🔴 مراجعة التعطيل · '))!));
  const confirm=buttons(review).find(x=>x.startsWith('⛔ تأكيد التعطيل · '))!;
  await f.education.setCategoryEnabled(OWNER,'scholarships',false);
  await f.education.setCategoryEnabled(OWNER,'scholarships',true);
  assert.equal((await f.app().handle(msg(33,confirm))).status,'DENIED');
  assert.equal((await f.store.snapshot()).educationCategories.find(c=>c.id==='scholarships')!.enabled,true);
 }finally{await f.close();}
});
test('category enable child with hidden parent fails closed and never bypasses parent visibility',async()=>{
 const f=await fixture();try{
  await f.education.setCategoryEnabled(OWNER,'subscholarships',false);
  await f.education.setCategoryEnabled(OWNER,'scholarships',false);
  const categories=await f.app().handle(msg(40,ownerMenuLabels.categories));
  const child=await f.app().handle(msg(41,'🗂️ القسم · subscholarships'));
  assert.equal(child.status,'APPLIED');
  assert.equal(buttons(child).some(x=>x.startsWith('🟢 مراجعة التفعيل · ')),false);
  const cat=(await f.store.snapshot()).educationCategories.find(c=>c.id==='subscholarships')!;
  const proof=categoryVisibilityFingerprint(cat);
  await assert.rejects(f.education.setCategoryEnabledIfCurrent(OWNER,cat.id,true,
   proof,1,cat.revision??0),/CATEGORY_PARENT_DISABLED/);
  assert.equal((await f.store.snapshot()).educationCategories.find(c=>c.id==='subscholarships')!.enabled,false);
 }finally{await f.close();}
});
test('category review and confirmation revoked on parent group authorization change and denied from unauthorized group',async()=>{
 const f=await fixture();try{
  const open=await f.app().handle(msg(50,'🗂️ القسم · scholarships'));
  const review=await f.app().handle(msg(51,buttons(open).find(x=>x.startsWith('🔴 مراجعة التعطيل · '))!));
  const confirm=buttons(review).find(x=>x.startsWith('⛔ تأكيد التعطيل · '))!;
  await f.policy.revokeChat(OWNER,GROUP);
  assert.equal((await f.app().handle(msg(52,confirm))).status,'DENIED');
  await f.policy.approveChat(OWNER,GROUP,['navigation','publishing']);
  assert.equal((await f.app().handle(msg(53,confirm))).status,'DENIED');
 }finally{await f.close();}
});
test('category management owner pages display 13 categories with stable tokens and deny invalid paging',async()=>{
 const f=await fixture();try{
  for(let i=1;i<=10;i++)await f.education.createCategory(OWNER,{
   id:'additional'+String(i),scope:GROUP,title:'Category '+i,order:i+3
  });
  const list=await f.app().handle(msg(60,ownerMenuLabels.categories));
  assert.match(list.plan?.text??'',/صفحة 1 من 2/);
  assert.equal(buttons(list).filter(x=>x.startsWith('🗂️ القسم · ')).length,10);
  const next=buttons(list).find(x=>x==='➡️ التالي · o:d:1')!;
  assert.ok(next);const page2=await f.app().handle(msg(61,next));
  assert.match(page2.plan?.text??'',/صفحة 2 من 2/);
  assert.equal(buttons(page2).filter(x=>x.startsWith('🗂️ القسم · ')).length,3);
  assert.equal(isValidTelegramReplyKeyboard(page2.plan?.replyMarkup),true);
  assert.equal((await f.app().handle(msg(62,'⬅️ السابق · o:d:0'))).status,'APPLIED');
  for(const [i,p] of ['➡️ التالي · o:d:0','⬅️ السابق · o:d:1',
   '➡️ التالي · o:d:001','➡️ التالي · o:d:999'].entries())
   assert.equal((await f.app().handle(msg(63+i,p))).status,'DENIED');
 }finally{await f.close();}
});
test('long 64-character category IDs map to short canonical keyboard tokens and resolve under authorized state',async()=>{
 const f=await fixture();try{
  const id='c'+'x'.repeat(63);
  await f.education.createCategory(OWNER,{id,scope:GROUP,title:'Long category',order:99});
  const token=ownerCategoryChoiceToken(id);
  assert.ok(token.startsWith('~'));assert.ok(token.length<=24);
  const r=await f.app().handle(msg(75,'🗂️ القسم · '+token));
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/Long category/);
  assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
 }finally{await f.close();}
});
test('category controls deny students, delegated staff and group context even with copied valid buttons',async()=>{
 const f=await fixture();try{
  await f.policy.grant(OWNER,'200','content.publish',GROUP,Date.now()+300000);
  const opened=await f.app().handle(msg(80,'🗂️ القسم · scholarships'));
  const review=buttons(opened).find(x=>x.startsWith('🔴 مراجعة التعطيل · '))!;
  const preview=await f.app().handle(msg(81,review));
  const confirm=buttons(preview).find(x=>x.startsWith('⛔ تأكيد التعطيل · '))!;
  for(const [i,cmd] of [ownerMenuLabels.categories,'🗂️ القسم · scholarships',review,confirm,
   '➡️ التالي · o:d:1'].entries()){
   for(const actor of [200,300]){
    const r=await f.app().handle(msg(100+i*10+actor,cmd,actor));
    assert.equal(r.status,'DENIED',cmd);assert.equal(r.plan,undefined);
   }
  }
  assert.equal((await f.app().handle(msg(210,confirm,100,true))).plan,undefined);
  assert.equal((await f.store.snapshot()).educationCategories.find(c=>c.id==='scholarships')!.enabled,true);
 }finally{await f.close();}
});
test('owner category parser rejects forged, noncanonical, oversized and malformed controls',()=>{
 const id='scholarships',fp='~0123456789abcdef';
 assert.deepEqual(parseOwnerCategoryAction('🗂️ القسم · '+id),{kind:'detail',token:id});
 assert.deepEqual(parseOwnerCategoryAction('⛔ تأكيد التعطيل · '+id+':'+fp+':1:0'),
  {kind:'disableConfirm',token:id,proof:fp,scopeRevision:1,categoryRevision:0});
 assert.deepEqual(parseOwnerCategoryPage('➡️ التالي · o:d:2'),{page:2,direction:'next'});
 for(const cmd of ['🗂️ القسم · ../','⛔ تأكيد التعطيل · '+id+':'+fp+':01:0',
  '✅ تأكيد التفعيل · '+id+':'+fp+':1:00','⛔ تأكيد التعطيل · '+id+':'+fp+':1:0\n',
  '✅ تأكيد التفعيل · '+id+':wrong:1:0']){
  assert.equal(parseOwnerCategoryAction(cmd),null,cmd);
 }
 for(const cmd of ['➡️ التالي · o:d:01','⬅️ السابق · o:d:-1',
  '➡️ التالي · o:d:1000'])assert.equal(parseOwnerCategoryPage(cmd),null,cmd);
});
