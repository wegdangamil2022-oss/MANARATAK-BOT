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
import {TelegramBotApiTextSender,TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const OWNER='100',STUDENT='300',GROUP='-100123';
const message=(id:number,actor=300,text='/start',group=false)=>({
 update_id:id,message:{message_id:id,
  chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
  from:{id:actor,is_bot:false},text}
});
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-buttons-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await education.createCategory(OWNER,{id:'scholarships',scope:'private',title:'المنح الدراسية',order:1});
 await education.createCategory(OWNER,{id:'courses',scope:'private',title:'الدورات التعليمية',order:2});
 await education.createCategory(OWNER,{id:'exams',scope:'private',title:'الاختبارات الرسمية',order:3});
 await education.createCategory(OWNER,{id:'files',scope:'private',title:'ملفات ونماذج',order:4});
 await education.createCategory(OWNER,{id:'universities',scope:'private',title:'الجامعات والتخصصات',order:5});
 await store.transaction(s=>{
  s.educationResources.push({id:'grant-1',categoryId:'scholarships',scope:'private',title:'منحة <آمنة> & فرصة',
   university:'University A',cycle:'2026',degree:'Bachelor',seats:null,
   sourceImportId:'import-1',sourceLocator:'row-1',reviewedBy:OWNER,status:'PUBLISHED'});
 });
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,file,store,policy,education,app,close:()=>rm(dir,{force:true,recursive:true})};
}
const labels=(p:{replyMarkup?:{keyboard:readonly (readonly {text:string}[])[]}}|undefined)=>
 p?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
test('B3 keyboard: /start gives student real Telegram reply keyboard, not admin impersonation',async()=>{
 const f=await fixture();try{
  const r=await f.app().handle(message(1));
  assert.equal(r.status,'APPLIED');
  assert.match(r.plan?.text??'',/منارتك/);
  assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
  const texts=labels(r.plan);
  for(const name of ['🎓 المنح الدراسية','📚 الدورات التعليمية','🏛 الجامعات والتخصصات',
   '📝 الاختبارات','📂 التعليم والموارد','📄 الملفات والنماذج',
   '💬 المساعد التعليمي','👥 المجموعات والقنوات','🆘 الدعم والمساعدة'])
   assert.ok(texts.includes(name),name);
  assert.equal(texts.includes('🔐 لوحة المالك'),false);
  assert.equal(r.plan?.replyMarkup?.resize_keyboard,true);
  assert.equal(r.plan?.replyMarkup?.is_persistent,true);
 }finally{await f.close();}
});
test('B3 keyboard: owner only sees and can use sensitive private admin entry',async()=>{
 const f=await fixture();try{
  const r=await f.app().handle(message(2,100));
  assert.ok(labels(r.plan).includes('🔐 لوحة المالك'));
  const p=await f.app().handle(message(3,100,'🔐 لوحة المالك'));
  assert.equal(p.status,'APPLIED');
  assert.match(p.plan?.text??'',/لوحة المالك/);
  assert.ok(labels(p.plan).includes('🏠 الرئيسية'));
  const unauth=await f.app().handle(message(4,300,'🔐 لوحة المالك'));
  assert.equal(unauth.status,'DENIED');assert.equal(unauth.plan,undefined);
 }finally{await f.close();}
});
test('B3 keyboard: scholarships drill-down uses reviewed categories and readable buttons',async()=>{
 const f=await fixture();try{
  const a=await f.app().handle(message(5,300,'🎓 المنح الدراسية'));
  assert.equal(a.status,'APPLIED');
  assert.match(a.plan?.text??'',/المنح الدراسية/);
  const catButton=labels(a.plan).find(s=>s.includes('scholarships'));
  assert.ok(catButton);
  const b=await f.app().handle(message(6,300,catButton!));
  assert.equal(b.status,'APPLIED');
  assert.match(b.plan?.text??'',/منحة &lt;آمنة&gt; &amp; فرصة/);
  const resourceButton=labels(b.plan).find(s=>s.includes('grant-1'));
  assert.ok(resourceButton);
  const c=await f.app().handle(message(7,300,resourceButton!));
  assert.equal(c.status,'APPLIED');
  assert.match(c.plan?.text??'',/منحة &lt;آمنة&gt; &amp; فرصة/);
  assert.ok(labels(c.plan).includes('🏠 الرئيسية'));
 }finally{await f.close();}
});
test('B3 keyboard: all planned section buttons reply honestly using current private library',async()=>{
 const f=await fixture();try{
  for(const [n,title] of [['📚 الدورات التعليمية','الدورات التعليمية'],
   ['🏛 الجامعات والتخصصات','الجامعات والتخصصات'],['📝 الاختبارات','الاختبارات'],
   ['📄 الملفات والنماذج','ملفات ونماذج']] as const){
   const r=await f.app().handle(message(15+n.length,300,n));
   assert.equal(r.status,'APPLIED',n);
   assert.match(r.plan?.text??'',new RegExp(title));
   assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
  }
  for(const [i,name] of ['💬 المساعد التعليمي','👥 المجموعات والقنوات','🆘 الدعم والمساعدة'].entries()){
   const r=await f.app().handle(message(40+i,300,name));
   assert.equal(r.status,'APPLIED',name);
   assert.ok(labels(r.plan).includes('🏠 الرئيسية'));
   assert.equal((r.plan?.text??'').length>25,true);
  }
 }finally{await f.close();}
});
test('B3 keyboard: back and help preserve actual navigable menu',async()=>{
 const f=await fixture();try{
  for(const name of ['/help','🏠 الرئيسية','↩️ رجوع','📂 التعليم والموارد']){
   const r=await f.app().handle(message(60+name.length,300,name));
   assert.equal(r.status,'APPLIED',name);assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
  }
 }finally{await f.close();}
});
test('B3 keyboard: never issue buttons in group conversations (privacy/no unsolicited interface)',async()=>{
 const f=await fixture();try{
  const result=await f.app().handle(message(80,300,'/categories',true));
  assert.equal(result.status,'DENIED');
  const r=await f.app().handle(message(81,300,'/start',true));
  assert.equal(r.plan,undefined);
  assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
 }finally{await f.close();}
});
test('B3 keyboard: malicious category/resource ids and forged rendered labels are denied',async()=>{
 const f=await fixture();try{
  for(const [i,b] of ['📁 مخادع · scholarships','📁 الفئة · ../../../etc/passwd',
   '🔎 مخادع · grant-1','📁 منح · missing','🔎 السجل · not-found'].entries()){
   const r=await f.app().handle(message(100+i,300,b));
   assert.equal(r.status,'DENIED',b);assert.equal(r.plan,undefined);
  }
 }finally{await f.close();}
});
test('B3 keyboard: disabled category and archived resource cannot be opened from stale button',async()=>{
 const f=await fixture();try{
  const a=await f.app().handle(message(115,300,'🎓 المنح الدراسية'));
  const cat=labels(a.plan).find(x=>x.includes('scholarships'))!;
  const b=await f.app().handle(message(116,300,cat));
  const res=labels(b.plan).find(x=>x.includes('grant-1'))!;
  await f.store.transaction(s=>{s.educationResources[0]!.status='ARCHIVED';});
  const archive=await f.app().handle(message(117,300,res));
  assert.equal(archive.status,'DENIED');assert.equal(archive.plan,undefined);
  await f.education.setCategoryEnabled(OWNER,'scholarships',false);
  const disabled=await f.app().handle(message(118,300,cat));
  assert.equal(disabled.status,'DENIED');assert.equal(disabled.plan,undefined);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 keyboard: '+engine+' persisted markup survives application restart and one-shot dispatch',async()=>{
  const f=await fixture(engine);try{
   const r=await f.app().handle(message(125,300));
   assert.equal(r.status,'APPLIED');assert.ok(r.deliveryKey);
   const saved=(await f.store.snapshot()).telegramReplyJobs?.find(x=>x.updateKey===r.deliveryKey);
   assert.equal(isValidTelegramReplyKeyboard(saved?.plan?.replyMarkup),true);
   let calls=0,seen:unknown;
   const dispatcher=new TelegramReplyDispatcher(new BotStore(f.file,{engine}),f.policy,{
    send:async plan=>{calls++;seen=plan.replyMarkup;return {status:'CONFIRMED',messageId:151};}});
   assert.equal((await dispatcher.dispatch(r.deliveryKey!)).status,'CONFIRMED');
   assert.equal(calls,1);assert.equal(isValidTelegramReplyKeyboard(seen),true);
   assert.equal((await dispatcher.dispatch(r.deliveryKey!)).status,'SENT');
   assert.equal(calls,1);
   const end=(await f.store.snapshot()).telegramReplyJobs?.[0];
   assert.equal(end?.status,'SENT');assert.equal(end?.plan,undefined);
  }finally{await f.close();}
 });
}
test('B3 keyboard: Bot API POST includes only Telegram reply_keyboard markup and no callback/chat request powers',async()=>{
 const captured:{body?:Record<string,unknown>}={};
 const sender=new TelegramBotApiTextSender(TOKEN,async(_url,init)=>{
  captured.body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  return new Response(JSON.stringify({ok:true,result:{message_id:5,chat:{id:300}}}),{status:200});
 });
 const f=await fixture();try{
  const menu=await f.app().handle(message(190));
  const result=await sender.send(menu.plan!);
  assert.equal(result.status,'CONFIRMED');
  const markup=captured.body?.reply_markup as Record<string,unknown>;
  assert.ok(markup);
  assert.equal(Array.isArray(markup.keyboard),true);
  assert.equal(markup.request_contact,undefined);
  assert.equal(markup.inline_keyboard,undefined);
  assert.equal(markup.request_location,undefined);
  assert.equal(JSON.stringify(captured.body).includes(TOKEN),false);
 }finally{await f.close();}
});
test('B3 keyboard: malformed markup never reaches Telegram API even if forged at typed boundary',async()=>{
 let called=0;
 const sender=new TelegramBotApiTextSender(TOKEN,async()=>{called++;throw Error('UNEXPECTED_NETWORK');});
 const bad=[
  {keyboard:[[{text:'📚 كتب',request_contact:true}]],resize_keyboard:true,is_persistent:true},
  {keyboard:[[{text:'x',callback_data:'owner'}]],resize_keyboard:true,is_persistent:true},
  {keyboard:[[{text:''}]],resize_keyboard:true,is_persistent:true},
  {keyboard:Array.from({length:30},()=>[{text:'x'}]),resize_keyboard:true,is_persistent:true},
 ];
 for(const replyMarkup of bad){
  const plan={chatId:'300',text:'Invalid',parseMode:'HTML',replyMarkup} as Parameters<typeof sender.send>[0];
  assert.deepEqual(await sender.send(plan),{status:'FAILED_CONFIRMED'});
 }
 assert.equal(called,0);
});
