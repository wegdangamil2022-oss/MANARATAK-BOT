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
import {ownerMenuLabels,parseOwnerMenuPageCommand,ownerCategoryToken} from '../src/telegram-owner-menu.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const OWNER='100',STUDENT='300',GROUP='-100123';
const msg=(id:number,input:string,actor=100,group=false)=>({
 update_id:id,message:{chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text:input}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-pages-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'s.sqlite':'s.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','publishing']);
 await education.createCategory(OWNER,{id:'grants',scope:GROUP,title:'منح عامة',order:0});
 const ctx={origin:'TELEGRAM_PRIVATE' as const,actorId:OWNER,chatId:OWNER,verified:true};
 const importRows=async(count:number,title='Scholarship')=>{
  const body=['title,university,cycle,degree,seats',
   ...Array.from({length:count},(_,i)=>title+'-'+i+',University-'+i+',2026,Bachelor,2')].join('\n');
  return admin.upload(ctx,GROUP,'csv','fresh.csv',body);
 };
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,store,policy,education,admin,ctx,app,importRows,close:()=>rm(dir,{recursive:true,force:true})};
}
test('owner imports: 14 runs visible across real reply keyboard pages with previous/next',async()=>{
 const f=await fixture();try{
  for(let i=0;i<14;i++)await f.importRows(1,'Scholarship'+i);
  const a=await f.app().handle(msg(1,ownerMenuLabels.imports));
  assert.equal(a.status,'APPLIED');assert.match(a.plan?.text??'',/صفحة 1 من 2/);
  assert.equal(buttons(a).filter(b=>b.startsWith('🗃️ الاستيراد · ')).length,10);
  const next=buttons(a).find(b=>b==='➡️ التالي · o:i:1');assert.ok(next);
  const b=await f.app().handle(msg(2,next!));
  assert.equal(b.status,'APPLIED');assert.match(b.plan?.text??'',/صفحة 2 من 2/);
  assert.equal(buttons(b).filter(x=>x.startsWith('🗃️ الاستيراد · ')).length,4);
  assert.equal(isValidTelegramReplyKeyboard(b.plan?.replyMarkup),true);
  const prev=await f.app().handle(msg(3,'⬅️ السابق · o:i:0'));
  assert.equal(prev.status,'APPLIED');assert.match(prev.plan?.text??'',/صفحة 1 من 2/);
  const all=new Set([...buttons(a),...buttons(b)].filter(b=>b.startsWith('🗃️ الاستيراد · ')));
  assert.equal(all.size,14);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('owner '+engine+': 23 candidate rows navigate and review the final row without reindexing',async()=>{
  const f=await fixture(engine);try{
   const run=await f.importRows(23);
   const first=await f.app().handle(msg(10,'🗃️ الاستيراد · '+run.id));
   assert.match(first.plan?.text??'',/صفحة 1 من 3/);
   assert.equal(buttons(first).filter(b=>b.startsWith('📑 مرشح · ')).length,10);
   const second=await f.app().handle(msg(11,'➡️ التالي · o:c:'+run.id+':1'));
   assert.match(second.plan?.text??'',/صفحة 2 من 3/);
   const third=await f.app().handle(msg(12,'➡️ التالي · o:c:'+run.id+':2'));
   assert.match(third.plan?.text??'',/صفحة 3 من 3/);
   assert.equal(buttons(third).filter(b=>b.startsWith('📑 مرشح · ')).length,3);
   assert.ok(buttons(third).includes('📑 مرشح · '+run.id+':22'));
   const candidate=await f.app().handle(msg(13,'📑 مرشح · '+run.id+':22'));
   assert.match(candidate.plan?.text??'',/Scholarship-22/);
   assert.equal(isValidTelegramReplyKeyboard(third.plan?.replyMarkup),true);
  }finally{await f.close();}
 });
}
test('owner pagination pages cannot be invoked by student or delegated staff even if tokens are known',async()=>{
 const f=await fixture();try{
  const run=await f.importRows(13);
  const commands=['➡️ التالي · o:i:1','➡️ التالي · o:c:'+run.id+':1',
   '⬅️ السابق · o:i:0','⬅️ السابق · o:c:'+run.id+':0'];
  for(const [i,command] of commands.entries())for(const actor of [200,300]){
   const r=await f.app().handle(msg(30+i*3+actor%3,command,actor));
   assert.equal(r.status,'DENIED',command);assert.equal(r.plan,undefined);
  }
 }finally{await f.close();}
});
test('owner paged candidate view is denied after group scope revoked',async()=>{
 const f=await fixture();try{
  const run=await f.importRows(18);
  const page='➡️ التالي · o:c:'+run.id+':1';
  assert.equal((await f.app().handle(msg(50,page))).status,'APPLIED');
  await f.policy.revokeChat(OWNER,GROUP);
  const denied=await f.app().handle(msg(51,page));
  assert.equal(denied.status,'DENIED');assert.equal(denied.plan,undefined);
 }finally{await f.close();}
});
test('owner page markers canonical, bounded, never admit page -1, extra data, unknown scope',()=>{
 const run='123e4567-e89b-12d3-a456-426614174000';
 for(const v of ['➡️ التالي · o:i:1','⬅️ السابق · o:i:0',
  '➡️ التالي · o:c:'+run+':1'])assert.ok(parseOwnerMenuPageCommand(v));
 for(const v of ['➡️ التالي · o:i:00','⬅️ السابق · o:i:01',
  '➡️ التالي · o:c:../../../:1','➡️ التالي · o:x:2',
  '➡️ التالي · o:i:-1','➡️ التالي · o:i:9999',
  '➡️ التالي · o:c:'+run+':1\n']){
  assert.equal(parseOwnerMenuPageCommand(v),null,v);
 }
});
test('out of range and wrong direction owner pages are explicitly denied',async()=>{
 const f=await fixture();try{
  const run=await f.importRows(11);
  for(const [i,c] of ['➡️ التالي · o:c:'+run.id+':999',
   '⬅️ السابق · o:c:'+run.id+':1','➡️ التالي · o:c:'+run.id+':0',
   '➡️ التالي · o:i:1','⬅️ السابق · o:i:0',
   '➡️ التالي · o:c:00000000-0000-0000-0000-000000000000:1'].entries()){
   const r=await f.app().handle(msg(60+i,c));
   assert.equal(r.status,'DENIED',c);assert.equal(r.plan,undefined);
  }
 }finally{await f.close();}
});
test('long canonical category id can be selected and approved via bounded Telegram buttons',async()=>{
 const f=await fixture('sqlite');try{
  const long='long_'+('x'.repeat(59));assert.equal(long.length,64);
  await f.education.createCategory(OWNER,{id:long,scope:GROUP,title:'منح أطول',order:1});
  const run=await f.importRows(1);
  const candidate=await f.app().handle(msg(70,'📑 مرشح · '+run.id+':0'));
  assert.equal(candidate.status,'APPLIED');
  const token=ownerCategoryToken(long);
  assert.match(token,/^~[0-9a-f]{16}$/);
  const select=buttons(candidate).find(x=>x.includes(':'+token));
  assert.ok(select);
  assert.equal(isValidTelegramReplyKeyboard(candidate.plan?.replyMarkup),true);
  const confirmation=await f.app().handle(msg(71,select!));
  assert.equal(confirmation.status,'APPLIED');
  const approve=buttons(confirmation).find(x=>x.startsWith('✅ تأكيد الاعتماد'));
  assert.ok(approve);assert.equal(isValidTelegramReplyKeyboard(confirmation.plan?.replyMarkup),true);
  assert.equal((await f.app().handle(msg(72,approve!))).status,'APPLIED');
  const s=await f.store.snapshot();
  assert.equal(s.importRuns[0]?.candidates[0]?.categoryId,long);
  const preview=await f.app().handle(msg(73,'📝 معاينة النشر · '+run.id+':0:'+token));
  assert.equal(preview.status,'APPLIED');assert.equal(isValidTelegramReplyKeyboard(preview.plan?.replyMarkup),true);
  const publish=buttons(preview).find(x=>x.startsWith('📤 تأكيد النشر المحلي'))!;
  assert.equal((await f.app().handle(msg(74,publish))).status,'APPLIED');
  assert.equal((await f.store.snapshot()).educationResources.length,1);
 }finally{await f.close();}
});
test('owner hashed category aliases fail closed if category is disabled/revoked before confirm',async()=>{
 const f=await fixture();try{
  const long='long_'+('y'.repeat(59));
  await f.education.createCategory(OWNER,{id:long,scope:GROUP,title:'دليل إضافي',order:1});
  const run=await f.importRows(1);
  const token=ownerCategoryToken(long);
  await f.education.setCategoryEnabled(OWNER,long,false);
  const r=await f.app().handle(msg(80,'✅ تأكيد الاعتماد · '+run.id+':0:'+token));
  assert.equal(r.status,'DENIED');assert.equal(r.plan,undefined);
  assert.equal((await f.store.snapshot()).importRuns[0]?.candidates[0]?.status,'READY');
 }finally{await f.close();}
});
test('owner category collisions cannot become arbitrary alternate selectors',async()=>{
 const f=await fixture();try{
  const run=await f.importRows(1);
  for(const [i,c] of ['✅ تأكيد الاعتماد · '+run.id+':0:~aaaaaaaaaaaaaaaa',
   '✅ تأكيد الاعتماد · '+run.id+':0:~00',
   '📤 تأكيد النشر المحلي · '+run.id+':0:long_'+('x'.repeat(59))].entries()){
   const r=await f.app().handle(msg(90+i,c));
   assert.equal(r.status,'DENIED');
  }
  assert.equal((await f.store.snapshot()).educationResources.length,0);
 }finally{await f.close();}
});
