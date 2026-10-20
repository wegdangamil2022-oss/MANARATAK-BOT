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
import {parseOwnerMenuPageCommand} from '../src/telegram-owner-menu.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
const OWNER='100',GROUP='-100123';
const input=(id:number,text:string,actor=100)=>({update_id:id,message:{chat:{id:actor,type:'private'},
 from:{id:actor,is_bot:false},text}});
const keys=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-categories-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy),
  admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','publishing']);
 for(let i=0;i<21;i++)await education.createCategory(OWNER,{
  id:'section-'+i.toString().padStart(2,'0'),scope:GROUP,title:'قسم المنح رقم '+i,order:i
 });
 const ctx={origin:'TELEGRAM_PRIVATE' as const,actorId:OWNER,chatId:OWNER,verified:true};
 const importRows=async(count=1)=>admin.upload(ctx,GROUP,'csv','grants.csv',
  ['title,university,cycle,degree,seats',...Array.from({length:count},(_,i)=>
   'Scholarship-'+i+',University-'+i+',2026,Bachelor,1')].join('\n'));
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,store,policy,education,admin,ctx,app,importRows,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('owner '+engine+': all 21 visible approval categories accessible by next/previous, last can approve and publish locally',async()=>{
  const f=await fixture(engine);try{
   const run=await f.importRows();
   const first=await f.app().handle(input(1,'📑 مرشح · '+run.id+':0'));
   assert.equal(first.status,'APPLIED');
   assert.match(first.plan?.text??'',/صفحة 1 من 3/);
   assert.equal(keys(first).filter(x=>x.startsWith('📂 اعتماد في · ')).length,9);
   const page2=keys(first).find(x=>x==='➡️ التالي · o:k:'+run.id+':0:1')!;
   assert.ok(page2);
   const second=await f.app().handle(input(2,page2));
   assert.match(second.plan?.text??'',/صفحة 2 من 3/);
   assert.equal(keys(second).filter(x=>x.startsWith('📂 اعتماد في · ')).length,9);
   const third=await f.app().handle(input(3,keys(second).find(x=>x.endsWith(':'+run.id+':0:2'))!));
   assert.match(third.plan?.text??'',/صفحة 3 من 3/);
   assert.ok(keys(third).some(x=>x.endsWith(':section-20')));
   assert.equal(keys(third).filter(x=>x.startsWith('📂 اعتماد في · ')).length,3);
   assert.equal(isValidTelegramReplyKeyboard(third.plan?.replyMarkup),true);
   const prev=await f.app().handle(input(4,'⬅️ السابق · o:k:'+run.id+':0:1'));
   assert.match(prev.plan?.text??'',/صفحة 2 من 3/);
   const pick=keys(third).find(x=>x.endsWith(':section-20'))!;
   const confirmation=await f.app().handle(input(5,pick));
   assert.match(confirmation.plan?.text??'',/تأكيد اعتماد/);
   assert.equal((await f.store.snapshot()).importRuns[0]?.candidates[0]?.status,'READY');
   const approved=await f.app().handle(input(6,keys(confirmation).find(x=>x.startsWith('✅ تأكيد الاعتماد'))!));
   assert.equal(approved.status,'APPLIED');
   assert.equal((await f.store.snapshot()).importRuns[0]?.candidates[0]?.categoryId,'section-20');
   assert.equal((await f.store.snapshot()).educationResources.length,0);
   const preview=await f.app().handle(input(7,keys(approved).find(x=>x.startsWith('📝 معاينة النشر'))!));
   assert.match(preview.plan?.text??'',/مكتبة البوت المحلية/);
   const published=await f.app().handle(input(8,keys(preview).find(x=>x.startsWith('📤 تأكيد النشر المحلي'))!));
   assert.equal(published.status,'APPLIED');
   assert.equal((await f.store.snapshot()).educationResources.length,1);
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
}
test('owner category picker pages bind to the reviewed candidate index and never confuse rows',async()=>{
 const f=await fixture();try{
  const run=await f.importRows(13);
  const page='➡️ التالي · o:k:'+run.id+':12:1';
  const r=await f.app().handle(input(20,page));
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/Scholarship-12/);
  const cat=keys(r).find(x=>x.endsWith(':section-11'))!;
  assert.ok(cat);assert.ok(cat.includes(run.id+':12:section-11'));
  const confirm=await f.app().handle(input(21,cat));
  assert.equal(confirm.status,'APPLIED');
  assert.equal((await f.store.snapshot()).importRuns[0]?.candidates[0]?.status,'READY');
 }finally{await f.close();}
});
test('owner category page requests are rejected after category is disabled or source group revoked',async()=>{
 const f=await fixture();try{
  const run=await f.importRows();
  const page='➡️ التالي · o:k:'+run.id+':0:2';
  assert.equal((await f.app().handle(input(30,page))).status,'APPLIED');
  for(let i=10;i<21;i++)await f.education.setCategoryEnabled(OWNER,'section-'+i.toString().padStart(2,'0'),false);
  const denied=await f.app().handle(input(31,page));
  assert.equal(denied.status,'DENIED');assert.equal(denied.plan,undefined);
  await f.policy.revokeChat(OWNER,GROUP);
  const revoked=await f.app().handle(input(32,'➡️ التالي · o:k:'+run.id+':0:1'));
  assert.equal(revoked.status,'DENIED');assert.equal(revoked.plan,undefined);
 }finally{await f.close();}
});
test('owner category page cannot revisit pending approval after candidate becomes approved or rejected',async()=>{
 const f=await fixture();try{
  const run=await f.importRows();
  await f.admin.approve(f.ctx,run.id,0,'section-00');
  const after=await f.app().handle(input(40,'➡️ التالي · o:k:'+run.id+':0:1'));
  assert.equal(after.status,'DENIED');
  await f.store.transaction(s=>{s.importRuns[0]!.candidates[0]!.status='NEEDS_REVIEW';});
  const denied=await f.app().handle(input(41,'➡️ التالي · o:k:'+run.id+':0:1'));
  assert.equal(denied.status,'DENIED');
 }finally{await f.close();}
});
test('owner category pagination denies nonowners, forged page directions, malformed UUIDs and wrong row',async()=>{
 const f=await fixture();try{
  const run=await f.importRows();
  for(const [i,c] of [
   '➡️ التالي · o:k:'+run.id+':0:0',
   '⬅️ السابق · o:k:'+run.id+':0:2',
   '➡️ التالي · o:k:'+run.id+':0:999',
   '➡️ التالي · o:k:'+run.id+':0:02',
   '➡️ التالي · o:k:bad:0:1',
   '➡️ التالي · o:k:'+run.id+':999:1',
   '➡️ التالي · o:k:'+run.id+':-1:1',
   '➡️ التالي · o:k:'+run.id+':0:1\n'
  ].entries()){
   const r=await f.app().handle(input(50+i,c));
   assert.equal(r.status,'DENIED',c);assert.equal(r.plan,undefined);
  }
  const outsider=await f.app().handle(input(70,'➡️ التالي · o:k:'+run.id+':0:1',300));
  assert.equal(outsider.status,'DENIED');assert.equal(outsider.plan,undefined);
 }finally{await f.close();}
});
test('owner page parser checks exact canonical candidate-category token grammar',()=>{
 const id='123e4567-e89b-12d3-a456-426614174000';
 const good=parseOwnerMenuPageCommand('➡️ التالي · o:k:'+id+':12:2');
 assert.deepEqual(good,{type:'categories',runId:id,index:12,page:2,direction:'next'});
 for(const s of ['➡️ التالي · o:k:'+id+':012:2',
  '➡️ التالي · o:k:'+id+':12:02','➡️ التالي · o:k:'+id+':12:1000',
  '⬅️ السابق · o:k:../../:12:2'])
  assert.equal(parseOwnerMenuPageCommand(s),null,s);
});
