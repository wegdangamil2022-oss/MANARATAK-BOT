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
 test('nested menu paging and service returns preserve ancestors without consuming another seat ('+engine+')',async()=>{
  const f=await fixture();try{
   let a=await f.svc.create('100','A'),b=await f.svc.create('100','B'),c=await f.svc.create('100','C');
   c=await f.svc.edit('100',c.id,c.revision,{kind:'TEXT',value:'آخر قائمة'});
   b=await f.svc.edit('100',b.id,b.revision,{kind:'TEXT',value:'ب'.repeat(450)});
   for(const name of ['إلى الثالثة','الخدمة'])b=await f.svc.edit('100',b.id,b.revision,{kind:'ADD_BUTTON',value:name});
   const next=b.draft.buttons[0]!,service=b.draft.buttons[1]!;
   b=await f.svc.edit('100',b.id,b.revision,{kind:'ACTION',buttonId:next.id,action:{kind:'MENU',target:c.id}});
   b=await f.svc.edit('100',b.id,b.revision,{kind:'ACTION',buttonId:service.id,action:{kind:'SERVICE',target:'student:open'}});
   a=await f.svc.edit('100',a.id,a.revision,{kind:'ADD_BUTTON',value:'إلى الثانية'});const enter=a.draft.buttons[0]!;
   a=await f.svc.edit('100',a.id,a.revision,{kind:'ACTION',buttonId:enter.id,action:{kind:'MENU',target:b.id}});
   a=await f.svc.edit('100',a.id,a.revision,{kind:'CONDITION',buttonId:enter.id,condition:{...enter.condition,seats:1}});
   let i=900,screen=await f.app().handle(event(i++,'st:1:v:'+a.id+':'+a.revision));
   screen=await f.app().handle(event(i++,select(screen,'st:1:t:')));assert.equal(screen.status,'APPLIED');
   const route=(text:string)=>{const item=buttons(screen).find(x=>x.text===text);assert.ok(item,text);return item.callback_data;};
   screen=await f.app().handle(event(i++,route('➡️ بقية النص')));assert.ok(screen.plan!.text.includes('النص (2 من 3)'));
   screen=await f.app().handle(event(i++,route('إلى الثالثة')));assert.ok(screen.plan!.text.includes('آخر قائمة'));
   const back=route('↩️ القائمة السابقة');assert.equal((await f.app().handle(event(i++,back,300))).status,'DENIED');assert.equal((await f.app().handle(event(i++,back,100,true))).status,'DENIED');
   screen=await f.app().handle(event(i++,back));assert.ok(screen.plan!.text.includes('النص (2 من 3)'));
   screen=await f.app().handle(event(i++,route('الخدمة')));assert.equal(screen.status,'APPLIED');
   screen=await f.app().handle(event(i++,route('↩️ المعاينة')));assert.ok(screen.plan!.text.includes('النص (2 من 3)'));
   const stale=route('إلى الثالثة');screen=await f.app().handle(event(i++,route('↩️ القائمة السابقة')));assert.equal(screen.status,'APPLIED');
   assert.equal((await f.store.snapshot()).callbacks.filter(x=>x.ref.startsWith('studio-seat:')).length,1);
   a=await f.svc.edit('100',a.id,a.revision,{kind:'NAME',value:'A جديد'});
   assert.equal((await f.app().handle(event(i++,stale))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.filter(x=>x.ref.startsWith('studio-seat:')).length,1);
  }finally{await f.close();}
 });
 test('nested menu references reject expiration, duplicate records and revoked context ('+engine+')',async()=>{
  const f=await fixture();try{
   let a=await f.svc.create('100','A');const b=await f.svc.create('100','B');
   a=await f.svc.edit('100',a.id,a.revision,{kind:'ADD_BUTTON',value:'فتح'});a=await f.svc.edit('100',a.id,a.revision,{kind:'ACTION',buttonId:a.draft.buttons[0]!.id,action:{kind:'MENU',target:b.id}});
   const first=await f.app().handle(event(950,'st:1:v:'+a.id+':'+a.revision)),opened=await f.app().handle(event(951,select(first,'st:1:t:'))),back=select(opened,'st:1:N:');
   const ref='studio-nav:'+back.slice(7),original=(await f.store.snapshot()).callbacks.find(x=>x.ref===ref)!;
   await f.store.transaction(s=>{s.callbacks.push({...original});});assert.equal((await f.app().handle(event(952,back))).status,'DENIED');
   await f.store.transaction(s=>{s.callbacks=s.callbacks.filter(x=>x.ref!==ref);s.callbacks.push({...original,expiresAt:1700000000000});});assert.equal((await f.app().handle(event(953,back))).status,'DENIED');
   await f.store.transaction(s=>{s.callbacks=s.callbacks.filter(x=>x.ref!==ref);s.callbacks.push({...original,revoked:true});});assert.equal((await f.app().handle(event(954,back))).status,'DENIED');
   a=await f.svc.edit('100',a.id,a.revision,{kind:'CONDITION',buttonId:a.draft.buttons[0]!.id,condition:{...a.draft.buttons[0]!.condition,seats:1}});
   const press='st:1:t:'+a.id+':'+a.revision+':'+a.draft.buttons[0]!.id+':0:0',ancestor='st:1:v:'+a.id+':'+a.revision+':0:0';
   await f.store.transaction(s=>{s.callbacks=s.callbacks.filter(x=>x.ref!==ref);s.callbacks.push({...original,action:'studio.navigation:'+JSON.stringify({route:press,trail:Array(8).fill(ancestor)})});});
   assert.equal((await f.app().handle(event(955,back))).status,'DENIED');assert.equal((await f.store.snapshot()).callbacks.filter(x=>x.ref.startsWith('studio-seat:')).length,0);
  }finally{await f.close();}
 });
 test('owner moves a selected button through paged row targets and rejects forged or stale moves ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','الصفوف');for(let i=0;i<12;i++)t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر '+i});
   const button=t.draft.buttons[0]!,before=structuredClone(t.draft);
   const rowEditor=await f.app().handle(event(997,'st:1:e:03:'+t.id+':'+t.revision)),list=await f.app().handle(event(998,select(rowEditor,'st:1:e:01:'))),details=await f.app().handle(event(1000,select(list,'st:1:b:')));
   let picker=await f.app().handle(event(1001,select(details,'st:1:B:')));assert.equal(picker.status,'APPLIED');assert.ok(picker.plan!.text.includes('الصف الحالي: 1'));
   const next=buttons(picker).find(b=>b.text==='التالي')!.callback_data;assert.equal((await f.app().handle(event(1002,next,300))).status,'DENIED');assert.equal((await f.app().handle(event(1003,next,100,true))).status,'DENIED');
   picker=await f.app().handle(event(1004,next));assert.ok(picker.plan!.text.includes('الصفحة 2 من 2'));const move=buttons(picker).find(b=>b.text.startsWith('الصف 10 '))!.callback_data;
   assert.ok(buttons(picker).every(b=>Buffer.byteLength(b.callback_data)<=64));assert.equal((await f.app().handle(event(1005,move,300))).status,'DENIED');
   const moved=await f.app().handle(event(1006,move));assert.equal(moved.status,'APPLIED');t=(await f.svc.list('100'))[0]!;
   assert.deepEqual(t.draft.layout,[1,1,1,1,1,1,1,1,2,1,1]);assert.deepEqual(t.draft.buttons.map(b=>b.id),[...before.buttons.slice(1,10).map(b=>b.id),button.id,...before.buttons.slice(10).map(b=>b.id)]);
   assert.equal((await f.app().handle(event(1007,move))).status,'DENIED');assert.equal((await f.app().handle(event(1008,next))).status,'DENIED');
   const newPicker=await f.app().handle(event(1009,select(moved,'st:1:B:')));assert.equal(newPicker.status,'APPLIED');
   const back=await f.app().handle(event(1010,select(newPicker,'st:1:b:')));assert.equal(back.status,'APPLIED');assert.deepEqual((await f.svc.list('100'))[0]!.draft,t.draft);
   t=await f.svc.edit('100',t.id,t.revision,{kind:'LAYOUT',value:'3-3-3-3'});
   const full=await f.app().handle(event(1011,'st:1:B:'+t.id+':'+t.revision+':'+button.id+':0'));assert.equal(buttons(full).filter(b=>b.callback_data.startsWith('st:1:V:')).length,1);
   const forged='st:1:V:'+t.id+':'+t.revision+':'+button.id+':0';assert.equal((await f.app().handle(event(1012,forged))).status,'DENIED');
   assert.equal((await f.app().handle(event(1013,'st:1:B:'+t.id+':'+t.revision+':'+button.id+':99'))).status,'DENIED');assert.deepEqual((await f.svc.list('100'))[0]!.draft,t.draft);
   const appended=await f.app().handle(event(1014,select(full,'st:1:V:')));assert.equal(appended.status,'APPLIED');assert.deepEqual((await f.svc.list('100'))[0]!.draft.layout,[3,3,3,2,1]);
  }finally{await f.close();}
 });
 test('studio target review shows the actual domain and complete escaped URL in bounded pages ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','قالب');t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'رابط'});const id=t.draft.buttons[0]!.id;
   const target='https://example.org/path?value='+('a'.repeat(700))+'&tail=final';t=await f.svc.edit('100',t.id,t.revision,{kind:'ACTION',buttonId:id,action:{kind:'URL',target}});
   const detail=await f.app().handle(event(600,'st:1:b:'+t.id+':'+t.revision+':'+id));assert.equal(detail.status,'APPLIED');assert.ok(detail.plan!.text.includes('<code>example.org</code>'));assert.ok(detail.plan!.text.includes('…'));
   let page=await f.app().handle(event(601,select(detail,'st:1:T:'))),whole='',i=602,route='';
   for(;;){assert.equal(page.status,'APPLIED');assert.ok(Buffer.byteLength(page.plan!.text)<=4096);assert.ok(page.plan!.text.includes('فحص إعادة التوجيه'));whole+=page.plan!.text.match(/<pre>([\s\S]*?)<\/pre>/u)![1];
    const next=buttons(page).find(b=>b.text==='التالي');if(!next)break;route=next.callback_data;assert.ok(Buffer.byteLength(route)<=64);page=await f.app().handle(event(i++,route));assert.ok(i<615);
   }
   assert.equal(whole.replace(/&amp;/gu,'&'),target);assert.equal((await f.app().handle(event(i++,route,300))).status,'DENIED');
   t=await f.svc.edit('100',t.id,t.revision,{kind:'NAME',value:'تحديث'});assert.equal((await f.app().handle(event(i++,route))).status,'DENIED');
  }finally{await f.close();}
 });
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
 test('studio links menus through paginated targets and returns without bypassing conditions ('+engine+')',async()=>{
  const f=await fixture();try{
   let source=await f.svc.create('100','قائمة رئيسية');source=await f.svc.edit('100',source.id,1,{kind:'ADD_BUTTON',value:'قائمة فرعية'});const button=source.draft.buttons[0]!;
   for(let i=0;i<8;i++)await f.svc.create('100','قائمة '+i);
   let target=await f.svc.create('100','القائمة المطلوبة');target=await f.svc.edit('100',target.id,1,{kind:'TEXT',value:'محتوى الهدف <كامل>'});
   let picker=await f.app().handle(event(300,'st:1:u:'+source.id+':'+source.revision+':'+button.id));assert.equal(picker.status,'APPLIED');
   picker=await f.app().handle(event(301,buttons(picker).find(b=>b.text==='التالي')!.callback_data));
   const link=select(picker,'st:1:L:');assert.equal((await f.app().handle(event(302,link))).status,'APPLIED');
   source=(await f.svc.list('100')).find(t=>t.id===source.id)!;
   const preview=await f.app().handle(event(303,'st:1:v:'+source.id+':'+source.revision));const press=select(preview,'st:1:t:');
   const opened=await f.app().handle(event(304,press));assert.equal(opened.status,'APPLIED');assert.ok(opened.plan!.text.includes('محتوى الهدف &lt;كامل&gt;'));
   const back=buttons(opened).find(b=>b.text==='↩️ القائمة السابقة')!;assert.equal((await f.app().handle(event(305,back.callback_data))).status,'APPLIED');
   assert.equal((await f.app().handle(event(306,press,300))).status,'DENIED');
   await assert.rejects(f.svc.edit('100',source.id,source.revision,{kind:'ACTION',buttonId:button.id,action:{kind:'MENU',target:source.id}}));
   source=await f.svc.edit('100',source.id,source.revision,{kind:'CONDITION',buttonId:button.id,condition:{...button.condition,opensAt:1700000000001}});
   assert.equal((await f.app().handle(event(307,'st:1:t:'+source.id+':'+source.revision+':'+button.id))).status,'DENIED');
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
 test('studio approved settings entry applies bounded controls and rejects stale or unauthorized selection ('+engine+')',async()=>{
  const f=await fixture();try{
   const t=await f.svc.create('100','افتراضي');const config=await f.app().handle(event(500,'mi:1:i:07:16'));assert.equal(config.status,'APPLIED');
   const color=select(config,'st:1:S:1:colorsByFunction:');assert.equal((await f.app().handle(event(501,color))).status,'APPLIED');assert.equal((await f.app().handle(event(502,color))).status,'DENIED');
   assert.equal((await f.app().handle(event(503,'mi:1:i:07:16',300))).status,'DENIED');
   const current=await f.app().handle(event(504,'st:1:C'));const pick=await f.app().handle(event(505,select(current,'st:1:D:')));
   const chosen=await f.app().handle(event(506,select(pick,'st:1:S:2:defaultTemplateId:'+t.id)));assert.equal(chosen.status,'APPLIED');assert.equal((await f.svc.settings('100')).defaultTemplateId,t.id);
   assert.equal((await f.app().handle(event(507,'st:1:S:3:inputSeconds:1'))).status,'DENIED');
   assert.equal((await f.app().handle(event(508,'st:1:S:3:buttonLimit:25'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('studio authored button pages preserve rows, text position, history and reject invalid or stale pages ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','صفحات');
   for(let i=0;i<7;i++)t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر '+i});
   t=await f.svc.edit('100',t.id,t.revision,{kind:'LAYOUT',value:'2-1-3-1'});
   t=await f.svc.edit('100',t.id,t.revision,{kind:'TEXT',value:'أ'.repeat(450)});
   const config=await f.app().handle(event(400,'st:1:e:05:'+t.id+':'+t.revision));assert.equal(config.status,'APPLIED');
   await f.app().handle(event(401,select(config,'st:1:P:').replace(/:1$/u,':2')));t=(await f.svc.list('100'))[0]!;assert.equal(t.draft.rowsPerPage,2);
   const route='st:1:v:'+t.id+':'+t.revision+':1:0';let shown=await f.app().handle(event(402,route));
   assert.deepEqual(shown.plan!.studioMarkup!.inline_keyboard.slice(0,2).map(r=>r.length),[2,1]);
   const next=buttons(shown).find(b=>b.text==='▶️ الأزرار التالية')!;shown=await f.app().handle(event(403,next.callback_data));
   assert.ok(shown.plan!.text.includes('النص (2 من 3)'));assert.deepEqual(shown.plan!.studioMarkup!.inline_keyboard.slice(0,2).map(r=>r.length),[3,1]);
   assert.equal(buttons(shown).some(b=>b.text==='▶️ الأزرار التالية'),false);
   assert.equal((await f.app().handle(event(404,'st:1:v:'+t.id+':'+t.revision+':1:2'))).status,'DENIED');
   await assert.rejects(f.svc.edit('100',t.id,t.revision,{kind:'PAGE_SIZE',rows:0}));await assert.rejects(f.svc.edit('100',t.id,t.revision,{kind:'PAGE_SIZE',rows:9}));
   t=await f.svc.save('100',t.id,t.revision);assert.equal(t.versions.at(-1)!.content.rowsPerPage,2);
   assert.equal((await f.app().handle(event(405,route))).status,'DENIED');
   const bt=t.draft.buttons[4]!;t=await f.svc.edit('100',t.id,t.revision,{kind:'CONDITION',buttonId:bt.id,condition:{...bt.condition,role:'OWNER',seats:1}});
   shown=await f.app().handle(event(406,'st:1:v:'+t.id+':'+t.revision+':1:1'));
   const press=buttons(shown).find(b=>b.text===bt.title)!.callback_data;
   assert.equal((await f.app().handle(event(407,press.replace(/:1:1$/u,':1:99')))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.some(c=>c.action.startsWith('studio.seat:')),false);
   const opened=await f.app().handle(event(408,press));const returned=await f.app().handle(event(409,buttons(opened).find(b=>b.text==='↩️ المعاينة')!.callback_data));
   assert.ok(returned.plan!.text.includes('النص (2 من 3)'));assert.ok(returned.plan!.text.includes('صفحة الأزرار 2 من 2'));
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
 test('studio preview rejects forged buttons from another page and native-only buttons without consuming seats ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','صفحات محمية');
   t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'نسخ مباشر'});
   t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'خدمة مشروطة'});
   const direct=t.draft.buttons[0]!,protectedButton=t.draft.buttons[1]!;
   t=await f.svc.edit('100',t.id,t.revision,{kind:'CONDITION',buttonId:protectedButton.id,condition:{...protectedButton.condition,seats:1}});
   t=await f.svc.edit('100',t.id,t.revision,{kind:'PAGE_SIZE',rows:1});
   const prefix='st:1:t:'+t.id+':'+t.revision+':';
   assert.equal((await f.app().handle(event(700,prefix+protectedButton.id+':0:0'))).status,'DENIED');
   assert.equal((await f.app().handle(event(701,prefix+direct.id+':0:0'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.some(c=>c.action.startsWith('studio.seat:')),false);
   const page=await f.app().handle(event(702,'st:1:v:'+t.id+':'+t.revision+':0:1'));
   const real=buttons(page).find(b=>b.text===protectedButton.title);assert.ok(real);
   assert.equal((await f.app().handle(event(703,real.callback_data))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).callbacks.filter(c=>c.action.startsWith('studio.seat:')).length,1);
  }finally{await f.close();}
 });
 test('studio button editor pages return to the selected button and reject stale or invalid pages ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','قالب كثير الأزرار');
   for(let i=0;i<17;i++)t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'عنصر '+i});
   let page=await f.app().handle(event(710,'st:1:e:01:'+t.id+':'+t.revision));
   assert.equal(buttons(page).filter(b=>b.callback_data.startsWith('st:1:b:')).length,8);
   page=await f.app().handle(event(711,buttons(page).find(b=>b.text==='التالي')!.callback_data));
   assert.equal(buttons(page).filter(b=>b.callback_data.startsWith('st:1:b:')).length,8);
   const target=buttons(page).find(b=>b.text==='عنصر 10');assert.ok(target);
   const detail=await f.app().handle(event(712,target.callback_data));
   const back=buttons(detail).find(b=>b.text==='↩️ قائمة الأزرار');assert.ok(back);
   const returned=await f.app().handle(event(713,back.callback_data));assert.ok(buttons(returned).some(b=>b.text==='عنصر 10'));
   page=await f.app().handle(event(714,buttons(page).find(b=>b.text==='التالي')!.callback_data));
   assert.equal(buttons(page).filter(b=>b.callback_data.startsWith('st:1:b:')).length,1);
   assert.equal((await f.app().handle(event(715,'st:1:E:01:'+t.id+':'+t.revision+':3'))).status,'DENIED');
   assert.equal((await f.app().handle(event(716,back.callback_data,300))).status,'DENIED');
   await f.svc.edit('100',t.id,t.revision,{kind:'NAME',value:'نسخة جديدة'});
   assert.equal((await f.app().handle(event(717,back.callback_data))).status,'DENIED');
  }finally{await f.close();}
 });
 test('studio row editor paginates copying rows and rejects invalid or stale pages ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','صفوف');
   for(let i=0;i<17;i++)t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر '+i});
   let page=await f.app().handle(event(720,'st:1:e:03:'+t.id+':'+t.revision));
   assert.equal(buttons(page).filter(b=>b.callback_data.startsWith('st:1:q:')).length,8);
   page=await f.app().handle(event(721,buttons(page).find(b=>b.text==='التالي')!.callback_data));
   assert.ok(buttons(page).some(b=>b.text==='نسخ الصف 9'));assert.ok(buttons(page).some(b=>b.text==='نسخ الصف 16'));
   const next=buttons(page).find(b=>b.text==='التالي')!;page=await f.app().handle(event(722,next.callback_data));
   assert.deepEqual(buttons(page).filter(b=>b.callback_data.startsWith('st:1:q:')).map(b=>b.text),['نسخ الصف 17']);
   assert.equal((await f.app().handle(event(723,'st:1:R:'+t.id+':'+t.revision+':3'))).status,'DENIED');
   assert.equal((await f.app().handle(event(724,next.callback_data,300))).status,'DENIED');
   const copied=await f.app().handle(event(725,select(page,'st:1:q:')));assert.equal(copied.status,'APPLIED');
   const saved=(await f.svc.list('100'))[0]!;assert.equal(saved.draft.layout.length,18);
   assert.equal((await f.app().handle(event(726,next.callback_data))).status,'DENIED');
  }finally{await f.close();}
 });
 test('studio disabled education service does not consume a preview seat ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','خدمة');t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'المكتبة'});
   const id=t.draft.buttons[0]!.id;
   t=await f.svc.edit('100',t.id,t.revision,{kind:'ACTION',buttonId:id,action:{kind:'SERVICE',target:'student:open'}});
   t=await f.svc.edit('100',t.id,t.revision,{kind:'CONDITION',buttonId:id,condition:{role:'ANY',opensAt:0,closesAt:0,seats:1}});
   const page=await f.app().handle(event(730,'st:1:v:'+t.id+':'+t.revision));const press=select(page,'st:1:t:');
   await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
   assert.equal((await f.app().handle(event(731,press))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.some(c=>c.action.startsWith('studio.seat:')),false);
   await f.store.transaction(s=>{s.privateFeatures['education.navigate']=true;});
   assert.equal((await f.app().handle(event(732,press))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).callbacks.filter(c=>c.action.startsWith('studio.seat:')).length,1);
  }finally{await f.close();}
 });
 test('studio missing menu target does not consume a preview seat ('+engine+')',async()=>{
  const f=await fixture();try{
   let source=await f.svc.create('100','المصدر');const target=await f.svc.create('100','الوجهة');
   source=await f.svc.edit('100',source.id,source.revision,{kind:'ADD_BUTTON',value:'افتح الوجهة'});const id=source.draft.buttons[0]!.id;
   source=await f.svc.edit('100',source.id,source.revision,{kind:'ACTION',buttonId:id,action:{kind:'MENU',target:target.id}});
   source=await f.svc.edit('100',source.id,source.revision,{kind:'CONDITION',buttonId:id,condition:{role:'ANY',opensAt:0,closesAt:0,seats:1}});
   const page=await f.app().handle(event(740,'st:1:v:'+source.id+':'+source.revision));const press=select(page,'st:1:t:');
   await f.store.transaction(s=>{s.buttonStudio!.templates=s.buttonStudio!.templates.filter(x=>x.id!==target.id);});
   assert.equal((await f.app().handle(event(741,press))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.some(c=>c.action.startsWith('studio.seat:')),false);
  }finally{await f.close();}
 });
 test('studio unavailable Mini App preview does not consume a seat ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','تطبيق');t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'التطبيق'});
   const id=t.draft.buttons[0]!.id;
   t=await f.svc.edit('100',t.id,t.revision,{kind:'ACTION',buttonId:id,action:{kind:'MINI_APP',target:'https://example.org/app'}});
   t=await f.svc.edit('100',t.id,t.revision,{kind:'CONDITION',buttonId:id,condition:{role:'ANY',opensAt:0,closesAt:0,seats:1}});
   const page=await f.app().handle(event(750,'st:1:v:'+t.id+':'+t.revision));
   const result=await f.app().handle(event(751,select(page,'st:1:t:')));
   assert.equal(result.status,'APPLIED');assert.match(result.plan!.text,/تحتاج اعتمادًا/);
   assert.equal((await f.store.snapshot()).callbacks.some(c=>c.action.startsWith('studio.seat:')),false);
  }finally{await f.close();}
 });
 test('owner selects actual education destinations without entering route codes ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','خدمات');t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'خدمة'});const id=t.draft.buttons[0]!.id;
   const detail=await f.app().handle(event(760,'st:1:b:'+t.id+':'+t.revision+':'+id));
   const picker=await f.app().handle(event(761,buttons(detail).find(b=>b.text==='🎓 اختيار خدمة تعليمية')!.callback_data));
   for(const title of ['مكتبة الطالب','المنح الدراسية','الجامعات والتخصصات','الدورات التعليمية','الاختبارات','الملفات والنماذج'])assert.ok(buttons(picker).some(b=>b.text.includes(title)),title);
   const route=buttons(picker).find(b=>b.text.includes('المنح الدراسية'))!.callback_data;
   assert.equal((await f.app().handle(event(762,route,300))).status,'DENIED');
   assert.equal((await f.app().handle(event(763,route,100,true))).status,'DENIED');
   const saved=await f.app().handle(event(764,route));assert.equal(saved.status,'APPLIED');
   t=(await f.svc.list('100'))[0]!;assert.deepEqual(t.draft.buttons[0]!.action,{kind:'SERVICE',target:'si:2:s:h'});
   assert.equal((await f.app().handle(event(765,route))).status,'DENIED');
   const preview=await f.app().handle(event(766,'st:1:v:'+t.id+':'+t.revision));
   const opened=await f.app().handle(event(767,select(preview,'st:1:t:')));assert.equal(opened.status,'APPLIED');assert.match(opened.plan!.text,/المنح الدراسية/);
  }finally{await f.close();}
 });
 test('all education choices open the matching local section and honor its feature switch ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','الخدمات');t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'خدمة'});const id=t.draft.buttons[0]!.id;
   const cases=[['مكتبة الطالب','student:open','مكتبة الطالب'],['المنح الدراسية','si:2:s:h','المنح الدراسية'],['الجامعات والتخصصات','si:2:u:h','الجامعات والتخصصات'],['الدورات التعليمية','si:2:c:h','الدورات التعليمية'],['الاختبارات','si:2:e:h','الاختبارات'],['الملفات والنماذج','si:2:f:h','الملفات والنماذج']] as const;
   let seq=800;
   for(const [label,target,title] of cases){
    const picker=await f.app().handle(event(seq++,'st:1:H:'+t.id+':'+t.revision+':'+id));
    const choice=buttons(picker).find(b=>b.text===label);assert.ok(choice);
    assert.equal((await f.app().handle(event(seq++,choice.callback_data))).status,'APPLIED');
    t=(await f.svc.list('100'))[0]!;assert.equal(t.draft.buttons[0]!.action.target,target);
    const page=await f.app().handle(event(seq++,'st:1:v:'+t.id+':'+t.revision));const press=select(page,'st:1:t:');
    const opened=await f.app().handle(event(seq++,press));assert.equal(opened.status,'APPLIED');assert.ok(opened.plan!.text.includes(title));
    await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
    assert.equal((await f.app().handle(event(seq++,press))).status,'DENIED');
    await f.store.transaction(s=>{s.privateFeatures['education.navigate']=true;});
   }
  }finally{await f.close();}
 });
}
