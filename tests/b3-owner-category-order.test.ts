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
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {categoryOrderFingerprint,ownerCategoryChoiceToken} from '../src/education-category-policy.js';
import {parseOwnerCategoryAction} from '../src/telegram-owner-categories.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
const OWNER='100',GROUP='-100123';
const msg=(n:number,text:string,actor=100,group=false)=>({update_id:n,message:{
 message_id:n,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-category-sort-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'db.sqlite':'db.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','publishing']);
 await education.createCategory(OWNER,{id:'catA',scope:GROUP,title:'المنح A',order:10});
 await education.createCategory(OWNER,{id:'catB',scope:GROUP,title:'المنح B',order:20});
 await education.createCategory(OWNER,{id:'catC',scope:GROUP,title:'المنح C',order:30});
 await education.createCategory(OWNER,{id:'childA',scope:GROUP,title:'Child 1',parentId:'catA',order:1});
 await education.createCategory(OWNER,{id:'childB',scope:GROUP,title:'Child 2',parentId:'catA',order:2});
 await education.createCategory(OWNER,{id:'privateA',scope:'private',title:'private only',order:1});
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
 botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {store,policy,education,app,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': owner previews and confirms upward category reorder without publishing/deleting or leakage',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   const detail=await f.app().handle(msg(1,'🗂️ القسم · catB'));
   assert.equal(detail.status,'APPLIED');
   const up=buttons(detail).find(x=>x.startsWith('⬆️ مراجعة الرفع · '))!;
   assert.ok(up);assert.equal(isValidTelegramReplyKeyboard(detail.plan?.replyMarkup),true);
   const review=await f.app().handle(msg(2,up));
   assert.equal(review.status,'APPLIED');
   assert.match(review.plan?.text??'',/catA|المنح A/);
   assert.deepEqual((await f.store.snapshot()).educationCategories,before.educationCategories);
   const confirm=buttons(review).find(x=>x.startsWith('✅ تأكيد الرفع · '))!;
   assert.ok(confirm);assert.equal(isValidTelegramReplyKeyboard(review.plan?.replyMarkup),true);
   assert.equal((await f.app().handle(msg(3,confirm))).status,'APPLIED');
   const after=await f.store.snapshot();
   const siblings=after.educationCategories.filter(c=>c.scope===GROUP&&c.parentId===null)
    .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)).map(c=>c.id);
   assert.deepEqual(siblings,['catB','catA','catC']);
   assert.equal(after.educationCategories.find(c=>c.id==='childA')!.order,1);
   assert.equal(after.educationCategories.find(c=>c.id==='privateA')!.order,1);
   assert.equal(after.educationResources.length,0);
   assert.equal(after.deliveries.length,0);
   assert.equal(after.audit.filter(x=>x.reason==='CATEGORY_ORDER_CHANGED').length,1);
   assert.equal((await f.app().handle(msg(4,confirm))).status,'DENIED');
   assert.deepEqual((await f.education.listCategories(OWNER,GROUP)).filter(c=>c.parentId===null).map(c=>c.id),['catB','catA','catC']);
  }finally{await f.close();}
 });
}
test('B3 moving down only reorders same-parent siblings and keeps other group and private untouched',async()=>{
 const f=await fixture();try{
  const detail=await f.app().handle(msg(10,'🗂️ القسم · childA'));
  const down=buttons(detail).find(x=>x.startsWith('⬇️ مراجعة الخفض · '))!;
  const review=await f.app().handle(msg(11,down));
  const confirm=buttons(review).find(x=>x.startsWith('✅ تأكيد الخفض · '))!;
  assert.equal((await f.app().handle(msg(12,confirm))).status,'APPLIED');
  const state=await f.store.snapshot();
  const children=state.educationCategories.filter(c=>c.parentId==='catA')
   .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
  assert.deepEqual(children.map(c=>c.id),['childB','childA']);
  assert.deepEqual(state.educationCategories.filter(c=>c.scope==='private').map(c=>c.order),[1]);
  assert.equal(state.educationCategories.find(c=>c.id==='catA')!.order,10);
 }finally{await f.close();}
});
test('B3 boundary categories display only valid direction buttons and forbid forged move',async()=>{
 const f=await fixture();try{
  const a=buttons(await f.app().handle(msg(20,'🗂️ القسم · catA'));
  const c=buttons(await f.app().handle(msg(21,'🗂️ القسم · catC'));
  assert.equal(a.some(x=>x.startsWith('⬆️ مراجعة الرفع · ')),false);
  assert.ok(a.some(x=>x.startsWith('⬇️ مراجعة الخفض · ')));
  assert.equal(c.some(x=>x.startsWith('⬇️ مراجعة الخفض · ')),false);
  assert.ok(c.some(x=>x.startsWith('⬆️ مراجعة الرفع · ')));
  const state=await f.store.snapshot();
  const cat=state.educationCategories.find(c=>c.id==='catA')!;
  await assert.rejects(f.education.moveCategoryIfCurrent(OWNER,cat.id,'up',
   categoryOrderFingerprint(state,cat),1,0),/CATEGORY_ORDER_(BOUNDARY|STALE)/);
 }finally{await f.close();}
});
test('B3 revised order invalidates all older move confirmations and cannot reorder twice',async()=>{
 const f=await fixture('sqlite');try{
  const detail=await f.app().handle(msg(30,'🗂️ القسم · catB'));
  const review=await f.app().handle(msg(31,buttons(detail).find(x=>x.startsWith('⬆️ مراجعة الرفع · '))!));
  const confirm=buttons(review).find(x=>x.startsWith('✅ تأكيد الرفع · '))!;
  await f.education.setCategoryEnabled(OWNER,'catA',false);
  assert.equal((await f.app().handle(msg(32,confirm))).status,'DENIED');
  const after=await f.store.snapshot();
  assert.equal(after.educationCategories.find(c=>c.id==='catB')!.order,20);
  assert.equal(after.audit.filter(x=>x.reason==='CATEGORY_ORDER_CHANGED').length,0);
 }finally{await f.close();}
});
test('B3 category order button stale after group revoke/reapproval even when scope restored',async()=>{
 const f=await fixture();try{
  const detail=await f.app().handle(msg(40,'🗂️ القسم · catB'));
  const preview=await f.app().handle(msg(41,buttons(detail).find(x=>x.startsWith('⬆️ مراجعة الرفع · '))!));
  const old=buttons(preview).find(x=>x.startsWith('✅ تأكيد الرفع · '))!;
  await f.policy.revokeChat(OWNER,GROUP);
  assert.equal((await f.app().handle(msg(42,old))).status,'DENIED');
  await f.policy.approveChat(OWNER,GROUP,['navigation','publishing']);
  assert.equal((await f.app().handle(msg(43,old))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 moving with equal legacy order values still results in strictly ordered peers, with revised peers',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.educationCategories.find(c=>c.id==='catB')!.order=10;});
  const list=await f.app().handle(msg(50,'🗂️ القسم · catB'));
  const choice=buttons(list).find(x=>x.startsWith('⬆️ مراجعة الرفع · '))!;
  assert.ok(choice);
  const review=await f.app().handle(msg(51,choice));
  assert.equal((await f.app().handle(msg(52,buttons(review).find(x=>x.startsWith('✅ تأكيد الرفع · '))!))).status,'APPLIED');
  const peers=(await f.store.snapshot()).educationCategories.filter(c=>c.scope===GROUP&&c.parentId===null)
   .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
  assert.deepEqual(peers.map(x=>x.id),['catB','catA','catC']);
  assert.equal(new Set(peers.map(x=>x.order)).size,3);
 }finally{await f.close();}
});
test('B3 owner moving disabled category does not accidentally enable it or republish archived content',async()=>{
 const f=await fixture();try{
  await f.education.setCategoryEnabled(OWNER,'catB',false);
  const detail=await f.app().handle(msg(60,'🗂️ القسم · catB'));
  const review=await f.app().handle(msg(61,buttons(detail).find(x=>x.startsWith('⬆️ مراجعة الرفع · '))!));
  assert.equal((await f.app().handle(msg(62,buttons(review).find(x=>x.startsWith('✅ تأكيد الرفع · '))!))).status,'APPLIED');
  assert.equal((await f.store.snapshot()).educationCategories.find(c=>c.id==='catB')!.enabled,false);
 }finally{await f.close();}
});
test('B3 students, staff, group messages cannot trigger category order preview or mutation',async()=>{
 const f=await fixture();try{
  const detail=await f.app().handle(msg(70,'🗂️ القسم · catB'));
  const reviewButton=buttons(detail).find(x=>x.startsWith('⬆️ مراجعة الرفع · '))!;
  const review=await f.app().handle(msg(71,reviewButton));
  const confirm=buttons(review).find(x=>x.startsWith('✅ تأكيد الرفع · '))!;
  for(const [i,label] of [reviewButton,confirm].entries())for(const actor of [200,300]){
   const r=await f.app().handle(msg(80+i*5+actor,label,actor));
   assert.equal(r.status,'DENIED');assert.equal(r.plan,undefined);
  }
  const group=await f.app().handle(msg(130,confirm,100,true));
  assert.equal(group.plan,undefined);
  assert.equal((await f.store.snapshot()).educationCategories.find(c=>c.id==='catB')!.order,20);
 }finally{await f.close();}
});
test('B3 long category token gives short valid buttons, rejects malformed/direction-forged text',async()=>{
 const f=await fixture();try{
  const id='cat'+'x'.repeat(61);
  await f.education.createCategory(OWNER,{id,scope:GROUP,title:'Very long ID',order:999});
  const token=ownerCategoryChoiceToken(id);
  const r=await f.app().handle(msg(140,'🗂️ القسم · '+token));
  assert.equal(r.status,'APPLIED');assert.ok(isValidTelegramReplyKeyboard(r.plan?.replyMarkup));
  assert.ok(buttons(r).some(x=>x.startsWith('⬆️ مراجعة الرفع · ')));
  const proof=categoryOrderFingerprint(await f.store.snapshot(),
   (await f.store.snapshot()).educationCategories.find(x=>x.id===id)!);
  for(const bad of ['✅ تأكيد الرفع · catB:'+proof+':01:0',
   '⬇️ مراجعة الخفض · catB:'+proof+':1:-1',
   '✅ تأكيد الرفع · catB:'+proof+':1:0 extra',
   '✅ تأكيد الرفع · catB:'+proof+':1:0\n'])
   assert.equal(parseOwnerCategoryAction(bad),null);
 }finally{await f.close();}
});
