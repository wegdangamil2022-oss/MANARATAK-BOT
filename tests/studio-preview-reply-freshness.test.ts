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
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {ButtonStudioService} from '../src/button-studio.js';
const NOW=1700000000000;
const cb=(id:number,data:string)=>({update_id:id,callback_query:{id:'studio_queue_'+id,from:{id:100,is_bot:false},data,message:{message_id:77,from:{id:999,is_bot:true},chat:{id:100,type:'private'}}}});
for(const engine of ['json','sqlite'] as const){
 test(engine+' queued studio previews recheck current templates, library, dashboard and expiry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-queue-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,sent=0;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now),svc=new ButtonStudioService(store,policy,()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),botId:'studio-fence',botUsername:'ManaratakBot',clock:()=>now,membership:async()=>{throw Error('network disabled');}});
  const dispatcher=new TelegramReplyDispatcher(store,policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:5};}},()=>now);
  try{
   let t=await svc.create('100','معاينة');t=await svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'رابط'});
   t=await svc.edit('100',t.id,t.revision,{kind:'ACTION',buttonId:t.draft.buttons[0]!.id,action:{kind:'URL',target:'https://example.org/path'}});
   const route=()=>`st:1:v:${t.id}:${t.revision}`;
   const first=await app.handle(cb(1,route()));assert.equal((await store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===first.deliveryKey)!.privateReplyKind,'STUDIO_SCOPED');assert.equal((await dispatcher.dispatch(first.deliveryKey!)).status,'CONFIRMED');assert.equal(sent,1);
   const stale=await app.handle(cb(2,route()));t=await svc.edit('100',t.id,t.revision,{kind:'TEXT',value:'تغيير'});
   assert.equal((await dispatcher.dispatch(stale.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   t=await svc.edit('100',t.id,t.revision,{kind:'ACTION',buttonId:t.draft.buttons[0]!.id,action:{kind:'SERVICE',target:'student:open'}});
   const library=await app.handle(cb(3,route()));const service=library.plan!.studioMarkup!.inline_keyboard.flat().find(b=>'callback_data' in b&&b.callback_data.startsWith('st:1:t:'));
   assert.ok(service&&'callback_data' in service);const opened=await app.handle(cb(4,service.callback_data));assert.equal(opened.status,'APPLIED');
   await education.createCategory('100',{id:'root',scope:'private',title:'منح',order:1});
   assert.equal((await dispatcher.dispatch(library.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal((await dispatcher.dispatch(opened.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   const revoked=await app.handle(cb(5,route()));await store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await dispatcher.dispatch(revoked.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   await store.transaction(s=>{s.privateFeatures['owner.dashboard']=true;});
   const expired=await app.handle(cb(6,route()));now+=120000;
   assert.equal((await dispatcher.dispatch(expired.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   const denied=(await store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===stale.deliveryKey)!;
   assert.equal(denied.accessDenialCode,'ACCESS_RECHECK_FAILED');assert.equal(denied.plan,undefined);assert.equal(denied.adminUIAccess,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
