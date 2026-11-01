import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ButtonStudioService} from '../src/button-studio.js';
import {studioContentDifferences,describeStudioContent} from '../src/studio-version-comparison.js';
import type {StudioContent} from '../src/button-studio-model.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
const NOW=1700000000000;
const cb=(id:number,data:string,actor=100,group=false)=>({update_id:id,callback_query:{id:'version-compare-'+id,from:{id:actor,is_bot:false},data,message:{message_id:77,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(r:Result)=>r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const choose=(r:Result,prefix:string)=>{const b=buttons(r).find(b=>b.callback_data.startsWith(prefix));assert.ok(b,'missing '+prefix);return b.callback_data;};
test('Arabic version comparison identifies content, layout, button and condition changes without JSON',()=>{
 const before:StudioContent={name:'قديم',text:'النص القديم',timezone:'Asia/Aden',hour12:false,calendar:'gregory',layout:[2,1],buttons:['a','b','c'].map(x=>({id:x.repeat(12),title:x,style:'default',action:{kind:'COPY',target:x},condition:{role:'ANY',opensAt:0,closesAt:0,seats:0}}))};
 const after=structuredClone(before);after.name='جديد';after.text='النص الجديد';after.timezone='UTC';after.hour12=true;after.calendar='islamic';after.rowsPerPage=1;after.layout=[1,2];
 const a=after.buttons[0]!,b=after.buttons[1]!;a.title='رابط';a.style='danger';a.action={kind:'URL',target:'https://example.org/study'};a.condition={role:'OWNER',opensAt:NOW,closesAt:NOW+60000,seats:5};
 after.buttons=[b,a,{...structuredClone(b),id:'d'.repeat(12),title:'مضاف'}];
 const differences=studioContentDifferences(before,after);assert.equal(differences.length,11);assert.ok(differences.includes('أزرار أُضيفت: 1'));assert.ok(differences.includes('أزرار حُذفت: 1'));assert.ok(differences.includes('أزرار تغيّرت بياناتها أو شروطها: 1'));assert.ok(differences.includes('تغيّر ترتيب الأزرار'));
 const text=describeStudioContent(after);for(const value of ['النص الجديد','صفوف الصفحة: 1','توزيع الصفوف: 1-2','النوع: رابط HTTPS','الهدف: https://example.org/study','النمط: أحمر','الجمهور: المالك','المقاعد: 5',new Date(NOW).toISOString(),new Date(NOW+60000).toISOString()])assert.ok(text.includes(value),value);
 assert.equal(text.includes('"buttons"'),false);
 const same=structuredClone(before);same.rowsPerPage=8;same.buttons[0]!.action={target:'a',kind:'COPY'};assert.deepEqual(studioContentDifferences(before,same),[]);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'studio-comparison-')),store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW),svc=new ButtonStudioService(store,policy,()=>NOW),education=new EducationService(store,policy,()=>NOW);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>NOW),faq:new ApprovedAnswerService(store,policy,()=>NOW),links:new ResourceLinkService(store,policy,()=>NOW),clock:()=>NOW,botId:'studio-comparison',botUsername:'ManaratakBot',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  return {store,svc,app,policy,close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' saved-version picker and Arabic comparison page complete contents and restore either chosen source safely',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','نسخة أولى');t=await f.svc.edit('100',t.id,t.revision,{kind:'TEXT',value:"'".repeat(1000)+' نهاية النص <موثقة>'});t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'مصدر'});
   const target='https://example.org/'+('p'.repeat(800))+'?tail=LAST';t=await f.svc.edit('100',t.id,t.revision,{kind:'ACTION',buttonId:t.draft.buttons[0]!.id,action:{kind:'URL',target}});t=await f.svc.save('100',t.id,t.revision);
   const first=t.versions[0]!;
   for(let n=0;n<9;n++){t=await f.svc.edit('100',t.id,t.revision,{kind:'TEXT',value:'النص المحفوظ '+n});t=await f.svc.save('100',t.id,t.revision);}
   t=await f.svc.edit('100',t.id,t.revision,{kind:'TEXT',value:'مسودة غير محفوظة'});const original=structuredClone(t);let id=1;
   let screen=await f.app.handle(cb(id++,'st:1:z:'+t.id+':'+t.revision+':'+first.revision+':0'));screen=await f.app.handle(cb(id++,choose(screen,'st:1:W:')));
   assert.ok(screen.plan!.text.includes('الصفحة 1 من 2'));assert.equal(buttons(screen).filter(b=>b.callback_data.startsWith('st:1:Q:')).length,8);
   screen=await f.app.handle(cb(id++,buttons(screen).find(b=>b.text==='التالي')!.callback_data));assert.ok(screen.plan!.text.includes('الصفحة 2 من 2'));
   const route=choose(screen,'st:1:Q:');assert.equal((await f.app.handle(cb(id++,route,300))).status,'DENIED');assert.equal((await f.app.handle(cb(id++,route,100,true))).status,'DENIED');
   const comparison=await f.app.handle(cb(id++,route));screen=comparison;let text='';
   for(;;){assert.equal(screen.status,'APPLIED');assert.ok(Buffer.byteLength(screen.plan!.text)<=4096);assert.ok(buttons(screen).every(b=>Buffer.byteLength(b.callback_data)<=64));text+=screen.plan!.text.match(/<pre>([\s\S]*?)<\/pre>/u)![1];const next=buttons(screen).find(b=>b.text==='التالي');if(!next)break;screen=await f.app.handle(cb(id++,next.callback_data));assert.ok(id<100);}
   assert.ok(text.includes('نهاية النص &lt;موثقة&gt;'));assert.ok(text.includes('النص المحفوظ 0'));assert.ok(text.includes(target));assert.equal(text.includes('مسودة غير محفوظة'),false);assert.equal(text.includes('"buttons"'),false);
   const back=await f.app.handle(cb(id++,choose(screen,'st:1:W:')));assert.ok(back.plan!.text.includes('الصفحة 2 من 2'));assert.deepEqual((await f.svc.list('100'))[0],original);
   const restoreButtons=buttons(screen).filter(b=>b.callback_data.startsWith('st:1:r:'));assert.equal(restoreButtons.length,2);
   const cancelled=await f.app.handle(cb(id++,restoreButtons[1]!.callback_data));assert.equal((await f.app.handle(cb(id++,choose(cancelled,'oc:1:k:')))).status,'APPLIED');assert.equal((await f.app.handle(cb(id++,choose(cancelled,'st:1:c:')))).status,'DENIED');
   let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:5};}},()=>NOW);
   assert.equal((await dispatcher.dispatch(comparison.deliveryKey!)).status,'CONFIRMED');const pending=await f.app.handle(cb(id++,route));assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===pending.deliveryKey)!.privateReplyKind,'STUDIO_SCOPED');
   const review=await f.app.handle(cb(id++,restoreButtons[0]!.callback_data));assert.equal((await f.app.handle(cb(id++,choose(review,'st:1:c:')))).status,'APPLIED');
   assert.deepEqual((await f.svc.list('100'))[0]!.draft,first.content);assert.equal((await f.svc.list('100'))[0]!.versions.length,original.versions.length+1);
   assert.equal((await dispatcher.dispatch(pending.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);assert.equal((await f.app.handle(cb(id++,route))).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' comparison rejects missing, identical, invalid-page and outdated selections',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','نسخة');t=await f.svc.save('100',t.id,t.revision);const first=t.versions[0]!;
   const empty=await f.app.handle(cb(1,'st:1:W:'+t.id+':'+t.revision+':'+first.revision+':0'));assert.ok(empty.plan!.text.includes('لا توجد نسخة محفوظة أخرى'));assert.equal(buttons(empty).some(b=>b.callback_data.startsWith('st:1:Q:')),false);
   t=await f.svc.save('100',t.id,t.revision);const second=t.versions[1]!,prefix='st:1:Q:'+t.id+':'+t.revision+':',before=structuredClone(t);
   for(const [i,tail] of [first.revision+':'+first.revision+':0',first.revision+':99999:0',first.revision+':'+second.revision+':99999'].entries())assert.equal((await f.app.handle(cb(i+2,prefix+tail))).status,'DENIED');
   const valid=prefix+first.revision+':'+second.revision+':0',same=await f.app.handle(cb(6,valid));assert.ok(same.plan!.text.includes('لا توجد فروق'));assert.deepEqual((await f.svc.list('100'))[0],before);
   await f.svc.edit('100',t.id,t.revision,{kind:'NAME',value:'تغيير'});assert.equal((await f.app.handle(cb(7,valid))).status,'DENIED');
  }finally{await f.close();}
 });
}
