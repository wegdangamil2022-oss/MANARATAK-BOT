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
import {validOwnerLibraryInlineRoute} from '../src/telegram-inline-library.js';
const NOW=1700000000000;
test('library inline grammar rejects ambiguous and oversized callbacks',()=>{
 for(const data of ['ol:1:p:00','ol:1:p:1000','ol:1:p:0\n','ol:1:d:0:9:abcdef123456','ol:1:c:'+'a'.repeat(25),'ol:1:c:'+'a'.repeat(24)+'\n'])assert.equal(validOwnerLibraryInlineRoute(data),false,data);
 for(const data of ['ol:1:p:0','ol:1:d:999:8:abcdef123456','ol:1:c:'+'a'.repeat(24)])assert.equal(validOwnerLibraryInlineRoute(data),true,data);
});
const event=(i:number,data:string,actor=100,group=false)=>({update_id:i,callback_query:{id:'lib_'+i,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(r:Result)=>r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const select=(r:Result,prefix:string)=>{const b=buttons(r).find(b=>b.callback_data.startsWith(prefix));assert.ok(b,'missing '+prefix);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(count=1){
  const dir=await mkdtemp(join(tmpdir(),'owner-inline-library-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);
  await education.createCategory('100',{id:'lib',scope:'private',title:'Library',order:0});
  await store.transaction(s=>{for(let i=0;i<count;i++)s.educationResources.push({id:randomUUID(),scope:'private',categoryId:'lib',title:'Resource '+i+' <review>',university:'U & Co',cycle:'2026',degree:'B',seats:null,status:'PUBLISHED',sourceImportId:'test',sourceLocator:'source-'+i,reviewedBy:'100'});});
  const app=()=>new TelegramUpdateApplication({store,policy,education,faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),admin:new EducationAdminFacade(store,policy,education),botId:'library-local',botUsername:'ManaratakBot',clock:()=>now,membership:async()=>{throw Error('network forbidden');}});
  return {store,policy,education,app,setTime:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('owner library inline archive uses preview and one atomic confirmation ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(event(1,'mi:1:i:10:09'));
   const detail=await f.app().handle(event(2,select(home,'ol:1:d:')));
   assert.equal(detail.plan?.editMessageId,55);assert.equal(detail.plan?.replyMarkup,undefined);
   assert.match(detail.plan!.text,/&lt;review&gt;/);assert.match(detail.plan!.text,/&amp;/);
   const preview=await f.app().handle(event(3,select(detail,'ol:1:a:')));
   assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
   assert.ok(isValidTelegramInlineKeyboard(preview.plan?.inlineMarkup));
   const token=select(preview,'ol:1:c:');
   const results=await Promise.all([f.app().handle(event(4,token)),f.app().handle(event(5,token))]);
   assert.equal(results.filter(r=>r.status==='APPLIED').length,1);
   const state=await f.store.snapshot();assert.equal(state.educationResources[0]!.status,'ARCHIVED');
   assert.equal(state.audit.filter(a=>a.reason==='RESOURCE_ARCHIVED').length,1);assert.equal(state.deliveries.length,0);
   assert.equal((await f.app().handle(event(6,token))).status,'DENIED');
  }finally{await f.close();}
 });
 test('library refuses nonowners, group context, changed copy, disabled dashboard and expired review ('+engine+')',async()=>{
  const f=await fixture();try{
   assert.equal((await f.app().handle(event(10,'mi:1:i:10:09',300))).status,'DENIED');
   assert.equal((await f.app().handle(event(11,'mi:1:i:10:09',100,true))).status,'DENIED');
   const home=await f.app().handle(event(12,'mi:1:i:10:09')),data=select(home,'ol:1:d:');
   const detail=await f.app().handle(event(13,data)),preview=await f.app().handle(event(14,select(detail,'ol:1:a:'))),token=select(preview,'ol:1:c:');
   await f.store.transaction(s=>{s.educationResources[0]!.title='Changed';});
   assert.equal((await f.app().handle(event(15,data))).status,'DENIED');assert.equal((await f.app().handle(event(16,token))).status,'DENIED');
   const fresh=await f.app().handle(event(17,'mi:1:i:10:09'));
   const current=await f.app().handle(event(18,select(fresh,'ol:1:d:')));
   const review=await f.app().handle(event(19,select(current,'ol:1:a:'))),newToken=select(review,'ol:1:c:');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.app().handle(event(20,newToken))).status,'DENIED');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=true;});
   f.setTime(NOW+120000);assert.equal((await f.app().handle(event(21,newToken))).status,'DENIED');
   assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
  }finally{await f.close();}
 });
 test('library returns to a valid list page after archiving its final page item ('+engine+')',async()=>{
  const f=await fixture(9);try{
   const page=await f.app().handle(event(30,'ol:1:p:1'));
   assert.equal(buttons(page).filter(b=>b.callback_data.startsWith('ol:1:d:')).length,1);
   const detail=await f.app().handle(event(31,select(page,'ol:1:d:')));
   assert.ok(buttons(detail).some(b=>b.callback_data==='ol:1:p:1'));
   const review=await f.app().handle(event(32,select(detail,'ol:1:a:')));
   const done=await f.app().handle(event(33,select(review,'ol:1:c:')));
   assert.ok(buttons(done).some(b=>b.callback_data==='ol:1:p:0'));
   const back=await f.app().handle(event(34,'ol:1:p:0'));
   assert.equal(buttons(back).filter(b=>b.callback_data.startsWith('ol:1:d:')).length,8);
   assert.equal((await f.app().handle(event(35,'ol:1:p:1'))).status,'DENIED');
   assert.equal((await f.app().handle(event(36,'ol:1:p:00'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('library blocks duplicate resource identities and clock rollback ('+engine+')',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(event(50,'mi:1:i:10:09'));
   const data=select(home,'ol:1:d:'),detail=await f.app().handle(event(51,data));
   const review=await f.app().handle(event(52,select(detail,'ol:1:a:'))),token=select(review,'ol:1:c:');
   f.setTime(NOW-1);assert.equal((await f.app().handle(event(53,token))).status,'DENIED');f.setTime(NOW);
   await f.store.transaction(s=>{s.educationResources.push(structuredClone(s.educationResources[0]!));});
   assert.equal((await f.app().handle(event(54,data))).status,'DENIED');assert.equal((await f.app().handle(event(55,token))).status,'DENIED');
   const hidden=await f.app().handle(event(56,'mi:1:i:10:09'));assert.equal(buttons(hidden).filter(b=>b.callback_data.startsWith('ol:1:d:')).length,0);
   assert.ok((await f.store.snapshot()).educationResources.every(r=>r.status==='PUBLISHED'));
  }finally{await f.close();}
 });
 test('group library confirmation is invalid after reapproval and copied references ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.policy.approveChat('100','-100123',['navigation']);
   await f.store.transaction(s=>{s.educationResources[0]!.scope='-100123';s.educationCategories[0]!.scope='-100123';});
   const home=await f.app().handle(event(40,'mi:1:i:10:09'));
   const detail=await f.app().handle(event(41,select(home,'ol:1:d:')));
   const review=await f.app().handle(event(42,select(detail,'ol:1:a:'))),token=select(review,'ol:1:c:');
   await f.policy.revokeChat('100','-100123');await f.policy.approveChat('100','-100123',['navigation']);
   assert.equal((await f.app().handle(event(43,token))).status,'DENIED');
   const fresh=await f.app().handle(event(44,'mi:1:i:10:09'));
   const current=await f.app().handle(event(45,select(fresh,'ol:1:d:')));
   const preview=await f.app().handle(event(46,select(current,'ol:1:a:'))),next=select(preview,'ol:1:c:');
   await f.store.transaction(s=>{s.callbacks.push(structuredClone(s.callbacks.at(-1)!));});
   assert.equal((await f.app().handle(event(47,next))).status,'DENIED');
   assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
  }finally{await f.close();}
 });
}
