import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
const NOW=1700000000000;
const event=(i:number,data:string,actor=100,group=false)=>({update_id:i,callback_query:{id:'faq_'+i,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(r:Result)=>r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const select=(r:Result,prefix:string)=>{const b=buttons(r).find(b=>b.callback_data.startsWith(prefix));assert.ok(b,'missing '+prefix);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'owner-inline-faq-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy),faq=new ApprovedAnswerService(store,policy,()=>now);
  await store.transaction(s=>{s.privateFeatures['content.upload']=true;});
  await education.createCategory('100',{id:'faq',scope:'private',title:'FAQ',order:0});
  const source=randomUUID();
  await store.transaction(s=>s.educationResources.push({id:source,scope:'private',categoryId:'faq',title:'Source',university:'U',cycle:'2026',degree:'B',seats:null,status:'PUBLISHED',sourceImportId:'test',sourceLocator:'test',reviewedBy:'100'}));
  const q=await faq.submit('100','private',{question:'سؤال <اختبار>',answer:'إجابة & موثقة',sourceResourceId:source});
  const app=()=>new TelegramUpdateApplication({store,policy,education,faq,links:new ResourceLinkService(store,policy),admin:new EducationAdminFacade(store,policy,education),botId:'faq-local',botUsername:'ManaratakBot',clock:()=>now,membership:async()=>{throw Error('network forbidden');}});
  return {store,policy,faq,q,source,app,setTime:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('owner FAQ inline list detail preview confirm archive and return use current services ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(event(1,'mi:1:i:10:08'));
   assert.equal(home.status,'APPLIED');assert.equal(home.plan?.editMessageId,55);assert.equal(home.plan?.replyMarkup,undefined);
   const detail=await f.app().handle(event(2,select(home,'of:1:d:')));
   assert.match(detail.plan?.text??'',/&lt;اختبار&gt;/);assert.match(detail.plan?.text??'',/&amp;/);
   const preview=await f.app().handle(event(3,select(detail,'of:1:a:')));
   assert.equal((await f.store.snapshot()).faqEntries[0]!.status,'DRAFT');
   const confirm=select(preview,'of:1:c:');assert.ok(isValidTelegramInlineKeyboard(preview.plan?.inlineMarkup));
   assert.equal((await f.app().handle(event(4,confirm))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).faqEntries[0]!.status,'APPROVED');
   assert.equal((await f.app().handle(event(5,confirm))).status,'DENIED');
   const current=await f.app().handle(event(6,'mi:1:i:10:08'));
   const approved=await f.app().handle(event(7,select(current,'of:1:d:')));
   const archive=await f.app().handle(event(8,select(approved,'of:1:x:')));
   assert.equal((await f.app().handle(event(9,select(archive,'of:1:c:')))).status,'APPLIED');
   const state=await f.store.snapshot();assert.equal(state.faqEntries[0]!.status,'ARCHIVED');
   assert.equal(state.audit.filter(a=>a.reason==='FAQ_OWNER_APPROVED').length,1);
   assert.equal(state.audit.filter(a=>a.reason==='FAQ_OWNER_ARCHIVED').length,1);
   assert.equal(state.deliveries.length,0);
  }finally{await f.close();}
 });
 test('FAQ inline rechecks actor, context, source, expiry and exact review before confirmation ('+engine+')',async()=>{
  const f=await fixture();try{
   assert.equal((await f.app().handle(event(1,'mi:1:i:10:08',300))).status,'DENIED');
   assert.equal((await f.app().handle(event(2,'mi:1:i:10:08',100,true))).status,'DENIED');
   const home=await f.app().handle(event(3,'mi:1:i:10:08')),data=select(home,'of:1:d:');
   const detail=await f.app().handle(event(4,data));
   const preview=await f.app().handle(event(5,select(detail,'of:1:a:'))),confirm=select(preview,'of:1:c:');
   assert.equal((await f.app().handle(event(6,confirm,300))).status,'DENIED');
   await f.store.transaction(s=>{s.educationResources[0]!.status='ARCHIVED';});
   assert.equal((await f.app().handle(event(7,confirm))).status,'DENIED');
   assert.equal((await f.app().handle(event(8,data))).status,'DENIED');
   await f.store.transaction(s=>{s.educationResources[0]!.status='PUBLISHED';});
   const fresh=await f.app().handle(event(9,'mi:1:i:10:08'));
   const again=await f.app().handle(event(10,select(fresh,'of:1:d:')));
   const review=await f.app().handle(event(11,select(again,'of:1:a:')));
   f.setTime(NOW+120000);
   assert.equal((await f.app().handle(event(12,select(review,'of:1:c:')))).status,'DENIED');
   assert.equal((await f.store.snapshot()).faqEntries[0]!.status,'DRAFT');
  }finally{await f.close();}
 });
 test('FAQ inline preserves list pages and shows the complete bounded answer ('+engine+')',async()=>{
  const f=await fixture();try{
   for(let i=0;i<8;i++)await f.faq.submit('100','private',{question:'سؤال '+i,answer:'إجابة',sourceResourceId:f.source});
   const home=await f.app().handle(event(20,'mi:1:i:10:08'));
   assert.equal(buttons(home).filter(b=>b.callback_data.startsWith('of:1:d:')).length,8);
   const second=await f.app().handle(event(21,'of:1:p:1'));
   assert.equal(buttons(second).filter(b=>b.callback_data.startsWith('of:1:d:')).length,1);
   const detail=await f.app().handle(event(22,select(second,'of:1:d:')));
   assert.ok(buttons(detail).some(b=>b.callback_data==='of:1:p:1'));
   const preview=await f.app().handle(event(30,select(detail,'of:1:a:')));
   const saved=await f.app().handle(event(31,select(preview,'of:1:c:')));
   assert.ok(buttons(saved).some(b=>b.callback_data==='of:1:p:1'));
   for(const [i,bad] of ['of:1:p:2','of:1:p:01','of:1:p:0\n','of:2:p:0'].entries())assert.equal((await f.app().handle(event(23+i,bad))).status,'DENIED');
   await f.store.transaction(s=>{s.faqEntries[0]!.question='<'.repeat(240);s.faqEntries[0]!.answer='&'.repeat(1200);s.faqEntries[0]!.createdAt=NOW+1;});
   const fresh=await f.app().handle(event(60,'mi:1:i:10:08'));
   let shown=await f.app().handle(event(61,select(fresh,'of:1:d:'))),total=0;
   for(let i=0;i<6;i++){
    assert.ok(Buffer.byteLength(shown.plan!.text)<=4096);
    total+=(shown.plan!.text.match(/&amp;/gu)??[]).length;
    if(i<5)shown=await f.app().handle(event(62+i,select(shown,'of:1:v:0:1:').replace(/:[0-5]$/u,':'+(i+1))));
   }
   assert.equal(total,1200);
  }finally{await f.close();}
 });
 test('FAQ confirmation is atomic under concurrent presses and rejects later edits or disabled owner UI ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(event(70,'mi:1:i:10:08'));
   const detail=await f.app().handle(event(71,select(home,'of:1:d:')));
   const review=await f.app().handle(event(72,select(detail,'of:1:a:'))),confirm=select(review,'of:1:c:');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.app().handle(event(73,confirm))).status,'DENIED');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=true;s.faqEntries[0]!.answer='تعديل لاحق';});
   assert.equal((await f.app().handle(event(74,confirm))).status,'DENIED');
   const newHome=await f.app().handle(event(75,'mi:1:i:10:08'));
   const newDetail=await f.app().handle(event(76,select(newHome,'of:1:d:')));
   const newReview=await f.app().handle(event(77,select(newDetail,'of:1:a:'))),token=select(newReview,'of:1:c:');
   const results=await Promise.all([f.app().handle(event(78,token)),f.app().handle(event(79,token))]);
   assert.equal(results.filter(r=>r.status==='APPLIED').length,1);
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='FAQ_OWNER_APPROVED').length,1);
  }finally{await f.close();}
 });
 test('group FAQ confirmation cannot survive revoke and reapproval or copied confirmation records ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.policy.approveChat('100','-100123',['navigation']);
   await f.store.transaction(s=>{
    s.educationCategories[0]!.scope='-100123';s.educationResources[0]!.scope='-100123';s.faqEntries[0]!.scope='-100123';
   });
   const home=await f.app().handle(event(80,'mi:1:i:10:08'));
   const detail=await f.app().handle(event(81,select(home,'of:1:d:')));
   const review=await f.app().handle(event(82,select(detail,'of:1:a:'))),token=select(review,'of:1:c:');
   await f.policy.revokeChat('100','-100123');await f.policy.approveChat('100','-100123',['navigation']);
   assert.equal((await f.app().handle(event(83,token))).status,'DENIED');
   const fresh=await f.app().handle(event(84,'mi:1:i:10:08'));
   const newDetail=await f.app().handle(event(85,select(fresh,'of:1:d:')));
   const newReview=await f.app().handle(event(86,select(newDetail,'of:1:a:'))),newToken=select(newReview,'of:1:c:');
   await f.store.transaction(s=>{s.callbacks.push(structuredClone(s.callbacks.at(-1)!));});
   assert.equal((await f.app().handle(event(87,newToken))).status,'DENIED');
   assert.equal((await f.store.snapshot()).faqEntries[0]!.status,'DRAFT');
  }finally{await f.close();}
 });
}
