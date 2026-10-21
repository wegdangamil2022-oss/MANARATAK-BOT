import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {menuLabels,isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {PlatformCatalogPreviewService,type PlatformCatalogReader} from '../src/platform-catalog-preview.js';

const OWNER=100,STUDENT=300;
const msg=(updateId:number,actor:number,text:string,group=false)=>({
 update_id:updateId,message:{message_id:updateId,
  from:{id:actor,is_bot:false},
  chat:{id:group?-100555:actor,type:group?'supergroup':'private'},text}
});
const buttons=(output:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 output.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
const record=(id:string,title='منحة مدعومة')=>({
 id,revision:2,scope:'private',publication:'PUBLISHED',
 title,university:'جامعة منارتك',cycle:'2027',degree:'Bachelor'
});
const externalPage=(ids:readonly string[],cursor:string|null=null,title='منحة مدعومة')=>({
 schema:'manaratak-readonly-catalog-v1',
 records:ids.map(id=>record(id,title)),nextCursor:cursor
});
async function fixture(engine:'json'|'sqlite',reader?:PlatformCatalogReader){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-platform-ui-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'data.sqlite':'data.json'),{engine});
 const policy=new Policy(store,String(OWNER)),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const service=reader?new PlatformCatalogPreviewService(store,policy,reader):undefined;
 const app=()=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,botId:'bot',botUsername:'ManaratakBot',
  membership:async()=> 'UNKNOWN',...(service?{platformCatalog:service}:{})
 });
 return {store,app,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': optional owner platform preview button is hidden when no reader exists',async()=>{
  const f=await fixture(engine);try{
   const panel=await f.app().handle(msg(1,OWNER,menuLabels.owner));
   assert.equal(panel.status,'APPLIED');
   assert.equal(buttons(panel).includes(ownerMenuLabels.platformCatalog),false);
   const forged=await f.app().handle(msg(2,OWNER,ownerMenuLabels.platformCatalog));
   assert.equal(forged.status,'DENIED');assert.equal(forged.plan,undefined);
   const forgedPage=await f.app().handle(msg(3,OWNER,'➡️ التالي · b5:cursor-2'));
   assert.equal(forgedPage.status,'DENIED');assert.equal(forgedPage.plan,undefined);
  }finally{await f.close();}
 });
 test('B5 '+engine+': owner can preview safely, advance via opaque cursor and never publish imported platform data',async()=>{
  const called:unknown[]=[];
  const f=await fixture(engine,{fetchPage:async request=>{
   called.push(request);
   return request.cursor===null?externalPage(['program-1'],'cursor-next'):
    externalPage(['program-2'],null);
  }});
  try{
   const baseline=await f.store.snapshot();
   const panel=await f.app().handle(msg(10,OWNER,menuLabels.owner));
   assert.ok(buttons(panel).includes(ownerMenuLabels.platformCatalog));
   assert.equal(isValidTelegramReplyKeyboard(panel.plan?.replyMarkup),true);
   const first=await f.app().handle(msg(11,OWNER,ownerMenuLabels.platformCatalog));
   assert.equal(first.status,'APPLIED');
   assert.match(first.plan?.text??'',/program-1/);
   assert.match(first.plan?.text??'',/غير متحقق|غير متحقَّق|غير موثوق/);
   assert.ok(buttons(first).includes('➡️ التالي · b5:cursor-next'));
   const second=await f.app().handle(msg(12,OWNER,'➡️ التالي · b5:cursor-next'));
   assert.equal(second.status,'APPLIED');
   assert.match(second.plan?.text??'',/program-2/);
   assert.ok(!buttons(second).some(x=>x.startsWith('➡️ التالي · b5:')));
   assert.deepEqual(called,[
    {scope:'private',limit:10,cursor:null},
    {scope:'private',limit:10,cursor:'cursor-next'}
   ]);
   const after=await f.store.snapshot();
   // The Telegram adapter legitimately audits each incoming update and plans
   // its reply; external preview must never change *published content*.
   for(const field of ['educationResources','importRuns','campaigns','deliveries'] as const)
    assert.deepEqual(after[field],baseline[field],field);
  }finally{await f.close();}
 });
 test('B5 '+engine+': student and group cannot invoke read-only owner preview or guessed cursor',async()=>{
  let called=0;
  const f=await fixture(engine,{fetchPage:async()=>{called++;return externalPage(['safe']);}});
  try{
   for(const [i,actor,text,group] of [
    [20,STUDENT,ownerMenuLabels.platformCatalog,false],
    [21,STUDENT,'➡️ التالي · b5:cursor-next',false],
    [22,OWNER,ownerMenuLabels.platformCatalog,true],
    [23,STUDENT,menuLabels.owner,false]
   ] as const){
    const outcome=await f.app().handle(msg(i,actor,text,group));
    assert.equal(outcome.status,'DENIED');
    assert.equal(outcome.plan,undefined);
   }
   assert.equal(called,0);
  }finally{await f.close();}
 });
 test('B5 '+engine+': HTML-expanded external titles fit Telegram and never create actionable import buttons',async()=>{
  const f=await fixture(engine,{fetchPage:async()=>
   externalPage(Array.from({length:10},(_,i)=>'row-'+i),null,'&<>'.repeat(50))
  });try{
   const r=await f.app().handle(msg(30,OWNER,ownerMenuLabels.platformCatalog));
   assert.equal(r.status,'APPLIED');
   assert.ok(Buffer.byteLength(r.plan?.text??'','utf8')<=4096);
   assert.equal((r.plan?.text??'').includes('<>'),false);
   assert.ok((r.plan?.text??'').includes('&amp;&lt;&gt;'));
   assert.equal(buttons(r).some(x=>/اعتماد|نشر|استيراد/.test(x)),false);
  }finally{await f.close();}
 });
}
test('B5 forged pagination and unknown external fields fail closed without exposing remote secrets',async()=>{
 let called=0;
 const f=await fixture('json',{fetchPage:async()=>{
  called++;throw Error('token=MY_PRIVATE_PLATFORM_TOKEN');
 }});
 try{
  for(const [i,text] of [
   '➡️ التالي · b5:bad cursor','➡️ التالي · b5:../etc/passwd',
   '➡️ التالي · b5:','➡️ التالي · b5:'+('a'.repeat(65)),
   '⬅️ السابق · b5:cursor-next'
  ].entries()){
   const bad=await f.app().handle(msg(40+i,OWNER,text));
   assert.equal(bad.status,'DENIED');
   assert.equal(bad.plan,undefined);
  }
  assert.equal(called,0);
  const result=await f.app().handle(msg(50,OWNER,ownerMenuLabels.platformCatalog));
  assert.equal(result.status,'APPLIED');
  assert.match(result.plan?.text??'',/غير متاح|تعذر/);
  assert.equal(JSON.stringify(result).includes('MY_PRIVATE_PLATFORM_TOKEN'),false);
 }finally{await f.close();}
});
test('B5 owner dashboard disabled during external read denies UI and strips preview body',async()=>{
 let entered!:()=>void,finish!:(data:unknown)=>void;
 const ready=new Promise<void>(resolve=>entered=resolve);
 const pending=new Promise<unknown>(resolve=>finish=resolve);
 const f=await fixture('sqlite',{fetchPage:async()=>{entered();return pending;}});
 try{
  const response=f.app().handle(msg(60,OWNER,ownerMenuLabels.platformCatalog));
  await ready;
  await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
  finish(externalPage(['protected']));
  const result=await response;
  assert.equal(result.status,'DENIED');
  assert.equal(result.plan,undefined);
 }finally{await f.close();}
});
