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
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
const NOW=1700000000000;
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'owner-imports-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,id=0;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);
  await education.createCategory('100',{id:'grants',scope:'private',title:'المنح',order:1});
  await store.transaction(s=>{for(let i=0;i<12;i++)s.importRuns.push({id:randomUUID(),scope:'private',uploadedBy:'100',origin:'TELEGRAM_ADMIN',format:'json',filename:'مصدر '+i,digest:'a'.repeat(64),createdAt:NOW+i,report:{sections:1,universities:1,opportunities:1,potentialDuplicates:0,ambiguous:0,explicitSeats:null,partial:false},candidates:[{title:'منحة موثقة '+i,university:'جامعة',cycle:'2026',degree:'بكالوريوس',seats:null,locator:'row1',evidence:'original',status:'READY'}]});});
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),ownerMenuMode:'inline',studentMenuMode:'inline',clock:()=>now,botId:'imports',botUsername:'ManaratakBot',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  const click=(data:string,actor=100,group=false)=>app.handle({update_id:++id,callback_query:{id:'import-'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
  return {store,policy,click,time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 type Result=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['click']>>;
 const choose=(r:Result,label:string)=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.text.startsWith(label));assert.ok(b,label+' '+r.reason);return b.callback_data;};
 test(engine+' imports browse, page, approve, preview and publish locally with single-use callbacks',async()=>{
  const f=await fixture();try{
   let r=await f.click('mi:1:i:13:04');assert.equal(r.plan!.editMessageId,55);assert.equal(r.plan!.replyMarkup,undefined);
   r=await f.click(choose(r,'➡️ التالي'));assert.ok(r.plan!.text.includes('2'));
   r=await f.click(choose(r,'🗃️ الاستيراد'));r=await f.click(choose(r,'📑 مرشح'));r=await f.click(choose(r,'📂 اعتماد في'));
   const confirm=choose(r,'✅ تأكيد الاعتماد');r=await f.click(confirm);assert.ok(r.plan!.text.includes('تم اعتماد'));assert.equal((await f.click(confirm)).status,'DENIED');
   r=await f.click(choose(r,'📝 معاينة النشر'));const publish=choose(r,'📤 تأكيد النشر المحلي');r=await f.click(publish);assert.ok(r.plan!.text.includes('تم النشر'));assert.equal((await f.click(publish)).status,'DENIED');assert.equal((await f.store.snapshot()).educationResources.length,1);
   assert.ok(r.plan!.inlineMarkup!.inline_keyboard.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
  }finally{await f.close();}
 });
 test(engine+' imports reject copied, duplicate, expired, cancelled and changed-source selectors',async()=>{
  const f=await fixture();try{
   let r=await f.click('mi:1:i:13:04'),route=choose(r,'🗃️ الاستيراد');
   assert.equal((await f.click(route,300)).status,'DENIED');assert.equal((await f.click(route,100,true)).status,'DENIED');
   await f.store.transaction(s=>{const c=s.callbacks.find(c=>c.ref==='owner-import-navigation:'+route.slice(5))!;s.callbacks.push({...c});});assert.equal((await f.click(route)).status,'DENIED');
   r=await f.click('mi:1:i:13:04');route=choose(r,'🗃️ الاستيراد');f.time(NOW+120000);assert.equal((await f.click(route)).status,'DENIED');f.time(NOW);
   r=await f.click('mi:1:i:13:04');r=await f.click(choose(r,'🗃️ الاستيراد'));r=await f.click(choose(r,'📑 مرشح'));r=await f.click(choose(r,'📂 اعتماد في'));const confirm=choose(r,'✅ تأكيد الاعتماد');await f.click(choose(r,'↩️ الوارد'));assert.equal((await f.click(confirm)).status,'DENIED');
   r=await f.click('mi:1:i:13:04');route=choose(r,'🗃️ الاستيراد');await f.store.transaction(s=>{s.importRuns[0]!.candidates[0]!.title='تغيير';});assert.equal((await f.click(route)).status,'DENIED');
   r=await f.click('mi:1:i:13:04');route=choose(r,'🗃️ الاستيراد');await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});assert.equal((await f.click(route)).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' queued import screens are withheld when the source changes',async()=>{
  const f=await fixture();try{
   const r=await f.click('mi:1:i:13:04');let sent=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},()=>NOW);
   await f.store.transaction(s=>{s.importRuns[0]!.filename='مصدر معدل';});assert.equal((await dispatcher.dispatch(r.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,0);
  }finally{await f.close();}
 });
}
