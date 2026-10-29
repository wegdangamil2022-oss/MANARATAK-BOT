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
import {ButtonStudioService} from '../src/button-studio.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
const event=(i:number,data:string,actor=100,group=false)=>({update_id:i,callback_query:{id:'studio_'+i,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
const message=(i:number,text:string)=>({update_id:i,message:{message_id:i,date:1700000000,from:{id:100,is_bot:false},chat:{id:100,type:'private'},text}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(r:Result)=>r.plan?.inlineMarkup?.inline_keyboard.flat()??r.plan?.studioMarkup?.inline_keyboard.flat().filter((b):b is {text:string;callback_data:string}=>'callback_data' in b)??[];
const select=(r:Result,prefix:string)=>{const b=buttons(r).find(b=>b.callback_data.startsWith(prefix));assert.ok(b,'missing '+prefix);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'studio-ui-')),store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100'),education=new EducationService(store,policy);const app=()=>new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education),faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),clock:()=>1700000000000,botId:'studio-local',botUsername:'ManaratakBot',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});return {store,policy,app,svc:new ButtonStudioService(store,policy,()=>1700000000000),close:()=>rm(dir,{recursive:true,force:true})};}
 test('studio owner creates, edits, saves and restores through approved inline entry ('+engine+')',async()=>{
  const f=await fixture();try{
   const list=await f.app().handle(event(1,'mi:1:i:07:01'));assert.equal(list.status,'APPLIED');assert.equal(list.plan?.editMessageId,55);
   assert.equal((await f.app().handle(event(2,'mi:1:i:07:01',300))).status,'DENIED');assert.equal((await f.app().handle(event(3,'mi:1:i:07:01',100,true))).status,'DENIED');
   const created=await f.app().handle(event(4,select(list,'st:1:n')));const t=(await f.store.snapshot()).buttonStudio!.templates[0]!;
   const input=await f.app().handle(event(5,'st:1:i:'+t.id+':1:TEXT'));assert.ok(isValidTelegramInlineKeyboard(input.plan?.inlineMarkup));
   const changed=await f.app().handle(message(6,'نص <جديد>'));assert.equal(changed.status,'APPLIED');
   const saved=await f.app().handle(event(7,select(changed,'st:1:s:')));
   const current=(await f.store.snapshot()).buttonStudio!.templates[0]!;assert.equal(current.versions.length,1);
   await f.svc.edit('100',t.id,current.revision,{kind:'TEXT',value:'نسخة لاحقة'});
   const latest=(await f.store.snapshot()).buttonStudio!.templates[0]!;
   const history=await f.app().handle(event(8,'st:1:h:'+t.id+':'+latest.revision));
   const comparison=await f.app().handle(event(90,select(history,'st:1:z:')));
   const review=await f.app().handle(event(9,select(comparison,'st:1:r:')));const token=select(review,'st:1:c:');
   const applied=await Promise.all([f.app().handle(event(10,token)),f.app().handle(event(11,token))]);assert.equal(applied.filter(r=>r.status==='APPLIED').length,1);
   assert.equal((await f.store.snapshot()).buttonStudio!.templates[0]!.draft.text,'نص <جديد>');assert.equal((await f.store.snapshot()).deliveries.length,0);
   assert.ok(isValidTelegramInlineKeyboard(created.plan?.inlineMarkup));assert.ok(isValidTelegramInlineKeyboard(saved.plan?.inlineMarkup));
  }finally{await f.close();}
 });
 test('studio library imports versioned starter templates as independent editable drafts ('+engine+')',async()=>{
  const f=await fixture();try{
   const library=await f.app().handle(event(200,'mi:1:i:07:07'));const route=select(library,'st:1:g:education');
   const first=await f.app().handle(event(201,route));assert.equal(first.status,'APPLIED');assert.equal((await f.app().handle(event(202,route,300))).status,'DENIED');
   await f.app().handle(event(203,route));const templates=(await f.store.snapshot()).buttonStudio!.templates;
   assert.equal(templates.length,2);assert.equal(templates[0]!.draft.buttons.length,5);assert.notEqual(templates[0]!.draft.buttons[0]!.id,templates[1]!.draft.buttons[0]!.id);assert.deepEqual(templates[0]!.versions,[]);
   const preview=await f.app().handle(event(204,select(first,'st:1:v:')));const service=await f.app().handle(event(205,select(preview,'st:1:t:')));assert.equal(service.status,'APPLIED');assert.ok(service.plan?.text.includes('المنح'));
   assert.equal((await f.store.snapshot()).deliveries.length,0);assert.equal((await f.app().handle(event(206,'st:1:g:arbitrary'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('studio cancel button clears pending input and stale input cannot change another revision ('+engine+')',async()=>{
  const f=await fixture();try{
   const t=await f.svc.create('100','قالب');
   const input=await f.app().handle(event(20,'st:1:i:'+t.id+':1:TEXT'));
   await f.app().handle(event(21,select(input,'st:1:d:')));
   assert.equal((await f.store.snapshot()).buttonStudio!.inputs.length,0);
   await f.svc.beginInput('100',t.id,1,'TEXT');await f.svc.edit('100',t.id,1,{kind:'NAME',value:'جديد'});
   assert.equal((await f.app().handle(message(22,'إدخال قديم'))).status,'DENIED');assert.equal((await f.store.snapshot()).buttonStudio!.templates[0]!.draft.text,'رسالة جديدة');
  }finally{await f.close();}
 });
 test('studio preview shows complete escaped message through bounded pages ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','قالب');t=await f.svc.edit('100',t.id,1,{kind:'TEXT',value:'&<ع😀'.repeat(300)});
   let shown=await f.app().handle(event(30,'st:1:v:'+t.id+':'+t.revision)),total=0,i=31;
   for(;;){assert.equal(shown.status,'APPLIED');assert.ok(Buffer.byteLength(shown.plan!.text)<=4096);total+=(shown.plan!.text.match(/&amp;/gu)??[]).length;const next=buttons(shown).find(b=>b.text==='➡️ بقية النص');if(!next)break;shown=await f.app().handle(event(i++,next.callback_data));assert.ok(i<50);}
   assert.equal(total,300);
  }finally{await f.close();}
 });
 test('studio history exposes all versions and comparison content without accepting stale revisions ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','أقدم قالب');
   for(let i=0;i<17;i++){t=await f.svc.edit('100',t.id,t.revision,{kind:'TEXT',value:'النص '+i+' <محفوظ>'});t=await f.svc.save('100',t.id,t.revision);}
   let shown=await f.app().handle(event(100,'st:1:h:'+t.id+':'+t.revision)),count=0,seq=101;
   for(;;){assert.equal(shown.status,'APPLIED');count+=buttons(shown).filter(b=>b.callback_data.startsWith('st:1:z:')).length;const next=buttons(shown).find(b=>b.text==='التالي');if(!next)break;shown=await f.app().handle(event(seq++,next.callback_data));}
   assert.equal(count,17);
   const route=select(shown,'st:1:z:');let comparison=await f.app().handle(event(seq++,route)),text='';
   for(;;){assert.equal(comparison.status,'APPLIED');text+=comparison.plan!.text.match(/<pre>([\s\S]*?)<\/pre>/u)![1];assert.ok(Buffer.byteLength(comparison.plan!.text)<=4096);const next=buttons(comparison).find(b=>b.text==='التالي');if(!next)break;comparison=await f.app().handle(event(seq++,next.callback_data));assert.ok(seq<200);}
   assert.ok(text.includes('النص 0 &lt;محفوظ&gt;'));assert.ok(text.includes('النص 16 &lt;محفوظ&gt;'));
   await f.svc.edit('100',t.id,t.revision,{kind:'NAME',value:'تغيير لاحق'});
   assert.equal((await f.app().handle(event(seq++,route))).status,'DENIED');
  }finally{await f.close();}
 });
}
