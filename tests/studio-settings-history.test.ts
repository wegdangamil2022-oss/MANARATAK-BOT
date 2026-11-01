import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ButtonStudioService} from '../src/button-studio.js';
import {defaultStudioSettings} from '../src/button-studio-model.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerPreviewCancelData} from '../src/telegram-owner-preview-cancel.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
const NOW=1700000000000;
const cb=(id:number,data:string,actor=100,group=false)=>({update_id:id,callback_query:{id:'settings-history-'+id,from:{id:actor,is_bot:false},data,message:{message_id:77,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const buttons=(r:Result)=>r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const choose=(r:Result,prefix:string)=>{const b=buttons(r).find(b=>b.callback_data.startsWith(prefix));assert.ok(b,'missing '+prefix);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'studio-settings-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=NOW;
  const policy=new Policy(store,'100',()=>now),svc=new ButtonStudioService(store,policy,()=>now),education=new EducationService(store,policy,()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),clock:()=>now,botId:'studio-settings',botUsername:'ManaratakBot',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  return {store,svc,app,policy,reopen:()=>new ButtonStudioService(new BotStore(file,{engine}),policy,()=>now),time:(value:number)=>{now=value;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' settings snapshots survive restart and restore every field once without changing templates',async()=>{
  const f=await fixture();try{
   assert.deepEqual(await f.svc.settingsHistory('100',1),[]);await assert.rejects(f.svc.issueSettingsRestore('100',1,'A'.repeat(24)));
   const template=await f.svc.create('100','افتراضي');let settings=await f.svc.settings('100');
   for(const [field,value] of [['buttonLimit',8],['rowsPerPage',2],['colorsByFunction',true],['inputSeconds',60],['confirmationSeconds',30],['defaultTemplateId',template.id]] as const)settings=await f.svc.configure('100',settings.revision,field,value);
   const reloaded=f.reopen(),history=await reloaded.settingsHistory('100',settings.revision);assert.equal(history.length,6);assert.equal(history[0]!.after.defaultTemplateId,template.id);
   const preview=await reloaded.issueSettingsRestore('100',settings.revision,history.at(-1)!.nonce);assert.deepEqual(preview.next,{...defaultStudioSettings(),revision:8});assert.deepEqual(await f.svc.settings('100'),settings);
   const result=await Promise.all([f.svc.confirmSettingsRestore('100',preview.ref),f.svc.confirmSettingsRestore('100',preview.ref)]);assert.equal(result.filter(Boolean).length,1);
   assert.deepEqual(await f.svc.settings('100'),preview.next);assert.deepEqual(await f.svc.list('100'),[template]);
   const restored=await f.svc.settingsHistory('100',8);assert.equal(restored.length,7);assert.deepEqual(restored[0]!.before,settings);assert.deepEqual(restored[0]!.after,preview.next);
   const undo=await f.svc.issueSettingsRestore('100',8,restored[0]!.nonce);assert.deepEqual(await f.svc.confirmSettingsRestore('100',undo.ref),{...settings,revision:9});
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='STUDIO_SETTINGS_RESTORED').length,2);
  }finally{await f.close();}
 });
 test(engine+' restoring settings rejects incompatible limits, missing defaults and stale previews',async()=>{
  const f=await fixture();try{
   let config=await f.svc.configure('100',1,'buttonLimit',1);config=await f.svc.configure('100',config.revision,'buttonLimit',24);
   const source=(await f.svc.settingsHistory('100',config.revision))[0]!;
   let t=await f.svc.create('100','قالب'),preview=await f.svc.issueSettingsRestore('100',config.revision,source.nonce);
   t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'أول'});
   assert.equal(await f.svc.confirmSettingsRestore('100',preview.ref),null); // template changed even though the limit still fits
   t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'ثان'});await assert.rejects(f.svc.issueSettingsRestore('100',config.revision,source.nonce));
   config=await f.svc.configure('100',config.revision,'defaultTemplateId',t.id);config=await f.svc.configure('100',config.revision,'defaultTemplateId','');
   const defaultSource=(await f.svc.settingsHistory('100',config.revision))[0]!;
   await f.store.transaction(s=>{s.buttonStudio!.templates=[];});await assert.rejects(f.svc.issueSettingsRestore('100',config.revision,defaultSource.nonce));
   const safe=(await f.svc.settingsHistory('100',config.revision)).at(-1)!;preview=await f.svc.issueSettingsRestore('100',config.revision,safe.nonce);
   config=await f.svc.configure('100',config.revision,'rowsPerPage',2);await assert.rejects(f.svc.confirmSettingsRestore('100',preview.ref));assert.deepEqual(await f.svc.settings('100'),config);
   await assert.rejects(f.svc.settingsHistory('100',config.revision-1));await assert.rejects(f.svc.issueSettingsRestore('300',config.revision,safe.nonce));
   const active=await f.svc.issueSettingsRestore('100',config.revision,safe.nonce);await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});await assert.rejects(f.svc.confirmSettingsRestore('100',active.ref));
  }finally{await f.close();}
 });
 test(engine+' history requires unique sealed prior values and audit evidence',async()=>{
  const f=await fixture();try{
   await f.svc.configure('100',1,'rowsPerPage',2);const original=await f.store.snapshot(),source=original.callbacks.find(c=>c.ref.startsWith('studio-settings-history:'))!;
   await f.store.transaction(s=>{s.callbacks.push({...source});});assert.deepEqual(await f.svc.settingsHistory('100',2),[]);
   await f.store.transaction(s=>{s.callbacks=structuredClone(original.callbacks);s.audit.push({...s.audit.find(a=>a.updateKey===source.ref)!});});assert.deepEqual(await f.svc.settingsHistory('100',2),[]);
   await f.store.transaction(s=>{s.audit=structuredClone(original.audit);s.callbacks[0]!.action=s.callbacks[0]!.action.replace('"buttonLimit":24','"buttonLimit":1');});assert.deepEqual(await f.svc.settingsHistory('100',2),[]);
   await f.store.transaction(s=>{s.callbacks=structuredClone(original.callbacks);s.audit.find(a=>a.updateKey===source.ref)!.at=NOW+1;});assert.deepEqual(await f.svc.settingsHistory('100',2),[]);
   await assert.rejects(f.svc.issueSettingsRestore('100',2,source.ref.split(':')[1]!));
  }finally{await f.close();}
 });
 test(engine+' settings history UI paginates, cancels one confirmation and restores with replay protection',async()=>{
  const f=await fixture();try{
   let config=await f.svc.settings('100');for(let i=0;i<10;i++)config=await f.svc.configure('100',config.revision,'rowsPerPage',i%8+1);
   let i=1,screen=await f.app.handle(cb(i++,'st:1:C'));screen=await f.app.handle(cb(i++,choose(screen,'st:1:A:')));assert.ok(screen.plan!.text.includes('الصفحة 1 من 2'));assert.equal(buttons(screen).filter(b=>b.callback_data.startsWith('st:1:K:')).length,8);
   const next=buttons(screen).find(b=>b.text==='التالي')!.callback_data;assert.equal((await f.app.handle(cb(i++,next,300))).status,'DENIED');assert.equal((await f.app.handle(cb(i++,next,100,true))).status,'DENIED');
   screen=await f.app.handle(cb(i++,next));assert.ok(screen.plan!.text.includes('الصفحة 2 من 2'));const pick=choose(screen,'st:1:K:');
   assert.equal((await f.app.handle(cb(i++,pick.replace(/:1$/u,':0')))).status,'DENIED');
   const preview=await f.app.handle(cb(i++,pick)),confirm=choose(preview,'st:1:F:');assert.ok(preview.plan!.text.includes('<b>بعد الاستعادة</b>'));assert.ok(preview.plan!.text.includes('حد الأزرار: 24'));assert.ok(buttons(preview).every(b=>Buffer.byteLength(b.callback_data)<=64));
   const sibling=await f.app.handle(cb(i++,pick));assert.equal((await f.app.handle(cb(i++,choose(preview,'oc:1:k:')))).status,'APPLIED');assert.equal((await f.app.handle(cb(i++,confirm))).status,'DENIED');
   const done=await f.app.handle(cb(i++,choose(sibling,'st:1:F:')));assert.equal(done.status,'APPLIED');assert.ok(done.plan!.text.includes('استُعيدت'));assert.equal((await f.app.handle(cb(i++,choose(sibling,'st:1:F:')))).status,'DENIED');assert.equal((await f.app.handle(cb(i++,next))).status,'DENIED');
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
 test(engine+' confirmation expiry and malformed references cannot restore settings',async()=>{
  const f=await fixture();try{
   await f.svc.configure('100',1,'confirmationSeconds',30);const history=await f.svc.settingsHistory('100',2),preview=await f.svc.issueSettingsRestore('100',2,history[0]!.nonce);
   assert.equal(await f.svc.confirmSettingsRestore('100','invalid'),null);f.time(NOW+30000);assert.equal(await f.svc.confirmSettingsRestore('100',preview.ref),null);assert.equal((await f.svc.settings('100')).revision,2);
   const active=await f.svc.issueSettingsRestore('100',2,history[0]!.nonce);const cancel=await f.app.handle(cb(20,ownerPreviewCancelData(active.ref)));assert.equal(cancel.status,'APPLIED');assert.equal(choose(cancel,'st:1:C'),'st:1:C');assert.equal(await f.svc.confirmSettingsRestore('100',active.ref),null);
  }finally{await f.close();}
 });
 test(engine+' queued settings history and restore previews recheck snapshots before sending',async()=>{
  const f=await fixture();try{
   await f.svc.configure('100',1,'rowsPerPage',2);let sent=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:5};}},()=>NOW);
   const history=await f.app.handle(cb(30,'st:1:A:2:0'));assert.equal((await dispatcher.dispatch(history.deliveryKey!)).status,'CONFIRMED');assert.equal(sent,1);
   const preview=await f.app.handle(cb(31,choose(history,'st:1:K:')));assert.ok(preview.plan);assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===preview.deliveryKey)!.privateReplyKind,'STUDIO_SCOPED');
   await f.store.transaction(s=>{s.callbacks.find(c=>c.ref.startsWith('studio-settings-history:'))!.revoked=true;});assert.equal((await dispatcher.dispatch(preview.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   await f.svc.configure('100',2,'rowsPerPage',3);const next=await f.app.handle(cb(32,'st:1:A:3:0'));
   await f.svc.configure('100',3,'rowsPerPage',4);assert.equal((await dispatcher.dispatch(next.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
  }finally{await f.close();}
 });
}
