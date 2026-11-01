import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {menuLabels} from '../src/telegram-menu.js';
import {privateFAQBrowseLabel} from '../src/telegram-private-faq.js';
const NOW=1700000000000;
const msg=(id:number,text:string,actor=300)=>({update_id:id,message:{message_id:id,from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text}});
const cb=(id:number,data:string,actor=300,group=false)=>({update_id:id,callback_query:{id:'public-navigation-'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(r:Result)=>r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const choose=(r:Result,label:string)=>{const b=buttons(r).find(b=>b.text===label);assert.ok(b,label);return b.callback_data;};
const prefix=(r:Result,label:string)=>{const b=buttons(r).find(b=>b.text.startsWith(label));assert.ok(b,label);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'public-navigation-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);await education.createCategory('100',{id:'grants',scope:'private',title:'المنح',order:1});
  await store.transaction(s=>{for(let i=0;i<12;i++){const id=randomUUID();s.educationResources.push({id,scope:'private',categoryId:'grants',title:'مورد موثق '+i,university:'جامعة',cycle:'2026',degree:'بكالوريوس',seats:1,sourceImportId:'secret-import',sourceLocator:'secret-locator',reviewedBy:'100',status:'PUBLISHED'});s.faqEntries.push({id:randomUUID(),scope:'private',question:'سؤال معتمد '+i,aliases:[],answer:'جواب <معتمد> '+i,sourceResourceId:id,createdBy:'100',approvedBy:'100',status:'APPROVED',createdAt:NOW});}});
  const app=(inline=true)=>new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),studentMenuMode:inline?'inline':'legacy',ownerMenuMode:'inline',clock:()=>now,botId:'public-navigation',botUsername:'ManaratakBot',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  return {store,policy,app,time:(value:number)=>{now=value;},now:()=>now,close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' inline start preserves every student entry and each click edits the message with a working home return',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(msg(1,'/start'));assert.equal(home.plan!.replyMarkup,undefined);assert.equal(buttons(home).length,10);assert.equal(buttons(home).some(b=>b.text===menuLabels.owner),false);
   let id=2;for(const label of Object.values(menuLabels).filter(x=>![menuLabels.owner,menuLabels.home,menuLabels.back].includes(x as typeof menuLabels.owner))){
    const route=choose(home,label),opened=await f.app().handle(cb(id++,route));assert.equal(opened.status,'APPLIED',label);assert.equal(opened.plan!.replyMarkup,undefined,label);assert.equal(opened.plan!.editMessageId,55,label);assert.ok(buttons(opened).every(b=>Buffer.byteLength(b.callback_data)<=64));
    assert.equal((await f.app().handle(cb(id++,'pn:1:h'))).status,'APPLIED');
   }
   const owner=await f.app().handle(msg(id++,'/start',100));assert.equal(choose(owner,menuLabels.owner),'mi:1:h');assert.equal((await f.app().handle(cb(id++,'mi:1:h',300))).status,'DENIED');
   assert.ok((await f.app(false).handle(msg(id++,'/start'))).plan!.replyMarkup);
  }finally{await f.close();}
 });
 test(engine+' FAQ browsing, its page return and search results use callbacks while preserving source checks',async()=>{
  const f=await fixture();try{
   let id=50,screen=await f.app().handle(msg(id++,'/start'));screen=await f.app().handle(cb(id++,choose(screen,menuLabels.assistant)));screen=await f.app().handle(cb(id++,choose(screen,privateFAQBrowseLabel)));assert.equal(screen.plan!.replyMarkup,undefined);assert.ok(screen.plan!.text.includes('صفحة 1 من 2'));
   screen=await f.app().handle(cb(id++,prefix(screen,'➡️ التالي')));assert.ok(screen.plan!.text.includes('صفحة 2 من 2'));screen=await f.app().handle(cb(id++,prefix(screen,'📖 سؤال ')));assert.ok(screen.plan!.text.includes('جواب &lt;معتمد&gt;'));assert.equal(screen.plan!.editMessageId,55);
   screen=await f.app().handle(cb(id++,prefix(screen,'↩️ صفحة الأسئلة')));assert.ok(screen.plan!.text.includes('صفحة 2 من 2'));
   const results=await f.app().handle(msg(id++,'/search موثق'));assert.equal(results.plan!.replyMarkup,undefined);const opened=await f.app().handle(cb(id++,prefix(results,'🔎 ')));assert.equal(opened.status,'APPLIED');assert.equal(opened.plan!.editMessageId,55);assert.equal(opened.plan!.text.includes('secret-import'),false);
  }finally{await f.close();}
 });
 test(engine+' public selectors reject other users, groups, expiry, duplicates and injected privileged commands',async()=>{
  const f=await fixture();try{
   const home=await f.app().handle(msg(100,'/start')),route=choose(home,menuLabels.help),ref='public-navigation:'+route.slice(5),record=(await f.store.snapshot()).callbacks.find(c=>c.ref===ref)!;
   assert.equal((await f.app().handle(cb(101,route,301))).status,'DENIED');assert.equal((await f.app().handle(cb(102,route,300,true))).status,'DENIED');
   await f.store.transaction(s=>{s.callbacks.push({...record});});assert.equal((await f.app().handle(cb(103,route))).status,'DENIED');
   await f.store.transaction(s=>{s.callbacks=s.callbacks.filter(c=>c.ref!==ref);s.callbacks.push({...record,action:'public.menu:'+JSON.stringify('/approve -100123')});});assert.equal((await f.app().handle(cb(104,route))).status,'DENIED');
   await f.store.transaction(s=>{s.callbacks=s.callbacks.filter(c=>c.ref!==ref);s.callbacks.push({...record});});f.time(NOW+120000);assert.equal((await f.app().handle(cb(105,route))).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' queued FAQ callback answers are withheld when the reviewed answer changes',async()=>{
  const f=await fixture();try{
   let screen=await f.app().handle(msg(120,menuLabels.assistant));screen=await f.app().handle(cb(121,choose(screen,privateFAQBrowseLabel)));const answer=await f.app().handle(cb(122,prefix(screen,'📖 سؤال ')));assert.equal(answer.status,'APPLIED');
   let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},()=>NOW);
   await f.store.transaction(s=>{s.faqEntries[0]!.answer='جواب جديد';});assert.equal((await dispatcher.dispatch(answer.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,0);
  }finally{await f.close();}
 });
 test(engine+' main staff entry follows current scoped grants and queued staff views recheck authorization and data',async()=>{
  const f=await fixture();try{
   await f.policy.approveChat('100','-100123',['moderation']);await f.policy.grant('100','300','chat.manage','-100123',NOW+60000);
   const home=await f.app().handle(msg(150,'/start'));assert.equal(choose(home,'🛡️ لوحة المشرف'),'ms:1:h');
   const staff=await f.app().handle(cb(151,'ms:1:h'));assert.equal(staff.status,'APPLIED');assert.equal(staff.plan!.editMessageId,55);assert.equal(choose(staff,menuLabels.home),'pn:1:h');
   let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},f.now);
   assert.equal((await dispatcher.dispatch(staff.deliveryKey!)).status,'CONFIRMED');
   const pending=await f.app().handle(cb(152,'ms:1:h'));assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===pending.deliveryKey)!.privateReplyKind,'ADMIN_SCOPED');
   await f.store.transaction(s=>{s.warnings.push({chatId:'-100123',memberId:'400',reference:'w1',actorId:'100',at:NOW,active:true});});assert.equal((await dispatcher.dispatch(pending.deliveryKey!)).status,'FAILED_CONFIRMED');
   const revoked=await f.app().handle(cb(153,'ms:1:h'));await f.policy.revokeGrant('100','300','chat.manage','-100123');assert.equal((await dispatcher.dispatch(revoked.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal((await f.app().handle(cb(154,'ms:1:h'))).status,'DENIED');
   assert.equal(buttons(await f.app().handle(msg(155,'/start'))).some(b=>b.text==='🛡️ لوحة المشرف'),false);assert.equal(sent,1);
  }finally{await f.close();}
 });
}
