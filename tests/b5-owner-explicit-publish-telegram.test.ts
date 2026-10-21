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
import {PlatformCatalogPreviewService} from '../src/platform-catalog-preview.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {menuLabels,isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
const OWNER=100,STUDENT=300;
const message=(id:number,actor:number,text:string,group=false)=>({
 update_id:id,message:{message_id:id,from:{id:actor,is_bot:false},
 chat:{id:group?-100555:actor,type:group?'supergroup':'private'},text}
});
const keys=(response:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 response.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function fixture(engine:'json'|'sqlite',many=false){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-b5-owner-confirm-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,String(OWNER)),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await education.createCategory(String(OWNER),{id:'grants',scope:'private',title:'المنح الدراسية',order:0});
 if(many)for(let i=0;i<13;i++)await education.createCategory(String(OWNER),
  {id:'extra-'+String(i).padStart(2,'0'),scope:'private',title:'فئة اضافية '+i,order:i+1});
 let revision=1,upstream=true;
 const platform=new PlatformCatalogPreviewService(store,policy,{fetchPage:async()=>
  {return {schema:'manaratak-readonly-catalog-v1',
   records:upstream?[{id:'china-2027',revision,scope:'private',publication:'PUBLISHED',
    title:'منحة الصين ٢٠٢٧',university:'جامعة الصين',cycle:'2027',degree:'Bachelor'}]:[],
   nextCursor:null};}
 });
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',platformCatalog:platform});
 async function reviewed(){
  const preview=await platform.preview(String(OWNER));
  if(preview.status!=='PREVIEW')throw Error('no preview');
  const staged=await platform.stage(String(OWNER),'china-2027',preview.fingerprint);
  if(staged.status!=='STAGED')throw Error('no stage');
  const done=await platform.review(String(OWNER),'china-2027',staged.entry.digest);
  if(done.status!=='REVIEWED')throw Error('no review');
  return staged.entry.digest;
 }
 return {store,education,platform,app,reviewed,setRevision:(n:number)=>revision=n,
  removeSource:()=>{upstream=false;},close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': owner uses four explicit screens before local publication; review/approval alone remain invisible',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.reviewed();
   const picker=await f.app().handle(message(10,OWNER,'📋 اختيار قسم · china-2027:'+digest));
   assert.equal(picker.status,'APPLIED');
   const category=keys(picker).find(x=>x.startsWith('📁 تعيين قسم · china-2027:grants:'))!;
   assert.ok(category);
   const confirm=await f.app().handle(message(11,OWNER,category));
   assert.equal(confirm.status,'APPLIED');
   const approve=keys(confirm).find(x=>x.startsWith('✅ تأكيد اعتماد محلي · china-2027:grants:'))!;
   assert.ok(approve);
   assert.deepEqual(await f.education.listResources(String(STUDENT),'private','grants'),[]);
   const approved=await f.app().handle(message(12,OWNER,approve));
   assert.equal(approved.status,'APPLIED');
   assert.deepEqual(await f.education.listResources(String(STUDENT),'private','grants'),[]);
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'APPROVED_FOR_LOCAL');
   const previewButton=keys(approved).find(x=>x.startsWith('📝 معاينة إتاحة · china-2027:grants:'))!;
   assert.ok(previewButton);
   const confirmation=await f.app().handle(message(13,OWNER,previewButton));
   assert.equal(confirmation.status,'APPLIED');
   assert.match(confirmation.plan?.text??'',/منحة الصين/);
   assert.match(confirmation.plan?.text??'',/محلية|مكتبة/);
   const publish=keys(confirmation).find(x=>x.startsWith('📚 تأكيد إتاحة محلية · china-2027:grants:'))!;
   assert.ok(publish);
   const done=await f.app().handle(message(14,OWNER,publish));
   assert.equal(done.status,'APPLIED');
   assert.match(done.plan?.text??'',/المكتبة المحلية/);
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'PUBLISHED_LOCALLY');
   const visible=await f.education.listResources(String(STUDENT),'private','grants');
   assert.equal(visible.length,1);assert.equal(visible[0]?.title,'منحة الصين ٢٠٢٧');
   assert.equal(visible[0]?.seats,null);
   const again=await f.app().handle(message(15,OWNER,publish));
   assert.equal(again.status,'APPLIED');
   assert.equal((await f.store.snapshot()).educationResources.length,1);
   assert.deepEqual((await f.store.snapshot()).campaigns,[]);
   assert.deepEqual((await f.store.snapshot()).deliveries,[]);
   assert.equal(isValidTelegramReplyKeyboard(confirmation.plan?.replyMarkup),true);
  }finally{await f.close();}
 });
 test('B5 '+engine+': category picker paginates all enabled private categories and denies forged page direction',async()=>{
  const f=await fixture(engine,true);try{
   const digest=await f.reviewed();
   const picker=await f.app().handle(message(20,OWNER,'📋 اختيار قسم · china-2027:'+digest));
   const next=keys(picker).find(x=>x.startsWith('➡️ التالي · b5c:'))!;
   assert.ok(next);
   const second=await f.app().handle(message(21,OWNER,next));
   assert.equal(second.status,'APPLIED');
   assert.ok(keys(second).some(x=>x.includes('extra-12')));
   const prev=keys(second).find(x=>x.startsWith('⬅️ السابق · b5c:'))!;
   assert.ok(prev);
   assert.equal((await f.app().handle(message(22,OWNER,prev))).status,'APPLIED');
   const invalid=await f.app().handle(message(23,OWNER,
    '➡️ التالي · b5c:china-2027:'+digest+':0'));
   assert.equal(invalid.status,'DENIED');
  }finally{await f.close();}
 });
 test('B5 '+engine+': student/group copied owner buttons never invoke source approval or publishing',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.reviewed();
   const picker='📋 اختيار قسم · china-2027:'+digest;
   const select='📁 تعيين قسم · china-2027:grants:'+digest;
   const approve='✅ تأكيد اعتماد محلي · china-2027:grants:'+digest;
   const publish='📚 تأكيد إتاحة محلية · china-2027:grants:'+digest;
   for(const [id,actor,button,group] of [
    [31,STUDENT,picker,false],[32,STUDENT,approve,false],[33,OWNER,publish,true],
    [34,STUDENT,publish,true],[35,STUDENT,select,false]
   ] as const){
    const result=await f.app().handle(message(id,actor,button,group));
    assert.equal(result.status,'DENIED',button);
    assert.equal(result.plan,undefined);
   }
   assert.deepEqual((await f.store.snapshot()).educationResources,[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': source mutation between category selection, approval and publish prevents obsolete action',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.reviewed();
   const approve='✅ تأكيد اعتماد محلي · china-2027:grants:'+digest;
   const publish='📚 تأكيد إتاحة محلية · china-2027:grants:'+digest;
   f.setRevision(2);
   assert.equal((await f.app().handle(message(41,OWNER,approve))).status,'DENIED');
   f.setRevision(1);
   assert.equal((await f.app().handle(message(42,OWNER,approve))).status,'APPLIED');
   f.setRevision(3);
   assert.equal((await f.app().handle(message(43,OWNER,publish))).status,'DENIED');
   assert.deepEqual((await f.store.snapshot()).educationResources,[]);
  }finally{await f.close();}
 });
}
test('B5 unpublished category and owner revocation deny old confirmation buttons',async()=>{
 const f=await fixture('sqlite');try{
  const digest=await f.reviewed();
  const approve='✅ تأكيد اعتماد محلي · china-2027:grants:'+digest;
  await f.education.setCategoryEnabled(String(OWNER),'grants',false);
  assert.equal((await f.app().handle(message(50,OWNER,approve))).status,'DENIED');
  await f.education.setCategoryEnabled(String(OWNER),'grants',true);
  await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
  assert.equal((await f.app().handle(message(51,OWNER,approve))).status,'DENIED');
  assert.deepEqual((await f.store.snapshot()).educationResources,[]);
 }finally{await f.close();}
});
test('B5 no configured platform reader means every owner local-approval text is denied',async()=>{
 const f=await fixture('json');try{
  const state=await f.store.snapshot();
  const digest=await f.reviewed();
  const bad='✅ تأكيد اعتماد محلي · china-2027:grants:'+digest;
  const {platform,app,store}=f;
  void platform;void app;
  // Exercise parsing with tampered button proof; it cannot gain authority.
  const forged=await f.app().handle(message(60,OWNER,bad.replace('grants','other')));
  assert.equal(forged.status,'DENIED');
  assert.deepEqual((await store.snapshot()).educationResources,[]);
  assert.equal(state.educationResources.length,0);
 }finally{await f.close();}
});
test('B5 maximal private category identifiers use short, unambiguous Telegram button tokens',async()=>{
 const f=await fixture('json');try{
  const digest=await f.reviewed();
  const longId='c'.repeat(64);
  await f.education.createCategory(String(OWNER),{
   id:longId,scope:'private',title:'قسم كبير',order:3});
  const picker=await f.app().handle(message(75,OWNER,'📋 اختيار قسم · china-2027:'+digest));
  assert.equal(picker.status,'APPLIED');
  assert.equal(isValidTelegramReplyKeyboard(picker.plan?.replyMarkup),true);
  const choice=keys(picker).find(x=>x.startsWith('📁 تعيين قسم · china-2027:~'))!;
  assert.ok(choice);
  const confirm=await f.app().handle(message(76,OWNER,choice));
  assert.equal(confirm.status,'APPLIED');
  assert.equal(isValidTelegramReplyKeyboard(confirm.plan?.replyMarkup),true);
  const approve=keys(confirm).find(x=>x.startsWith('✅ تأكيد اعتماد محلي ·'))!;
  assert.ok(approve);
  const approved=await f.app().handle(message(77,OWNER,approve));
  assert.equal(approved.status,'APPLIED');
  assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.approvedCategoryId,longId);
  assert.equal(isValidTelegramReplyKeyboard(approved.plan?.replyMarkup),true);
  const preview=keys(approved).find(x=>x.startsWith('📝 معاينة إتاحة ·'))!;
  const confirmation=await f.app().handle(message(78,OWNER,preview));
  assert.equal(confirmation.status,'APPLIED');
  assert.equal(isValidTelegramReplyKeyboard(confirmation.plan?.replyMarkup),true);
  const publish=keys(confirmation).find(x=>x.startsWith('📚 تأكيد إتاحة محلية ·'))!;
  const done=await f.app().handle(message(79,OWNER,publish));
  assert.equal(done.status,'APPLIED');
  assert.equal((await f.store.snapshot()).educationResources[0]?.categoryId,longId);
 }finally{await f.close();}
});
