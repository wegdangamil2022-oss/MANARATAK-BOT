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
const NOW=1700000000000;
const message=(id:number,text:string)=>({update_id:id,message:{message_id:id,from:{id:300,is_bot:false},chat:{id:300,type:'private'},text}});
const cb=(id:number,data:string)=>({update_id:id,callback_query:{id:'lib_'+id,from:{id:300,is_bot:false},data,message:{message_id:77,from:{id:999,is_bot:true},chat:{id:300,type:'private'}}}});
for(const engine of ['json','sqlite'] as const){
 test(engine+' queued private inline library is rechecked against source, feature and expiry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'library-queue-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,sent=0;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),botId:'lib-fence',botUsername:'ManaratakBot',clock:()=>now,studentMenuMode:'inline',membership:async()=>{throw Error('network disabled');}});
  const dispatcher=new TelegramReplyDispatcher(store,policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:5};}},()=>now);
  try{
   await education.createCategory('100',{id:'root',scope:'private',title:'منح',order:1});
   const first=await app.handle(message(1,'/studentinline'));assert.equal(first.status,'APPLIED');
   const firstJob=(await store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===first.deliveryKey)!;assert.equal(firstJob.privateReplyKind,'LIBRARY_SCOPED');assert.ok(firstJob.privateLibraryAccess);
   assert.equal((await dispatcher.dispatch(first.deliveryKey!)).status,'CONFIRMED');assert.equal(sent,1);
   const second=await app.handle(cb(2,'si:1:h'));await education.setCategoryEnabled('100','root',false);
   assert.equal((await dispatcher.dispatch(second.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   await education.setCategoryEnabled('100','root',true);
   const third=await app.handle(message(3,'🎓 المنح الدراسية'));
   await store.transaction(s=>{s.privateFeatures['education.navigate']=false;});
   assert.equal((await dispatcher.dispatch(third.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   await store.transaction(s=>{s.privateFeatures['education.navigate']=true;});
   const fourth=await app.handle(cb(4,'si:1:h'));now+=120000;
   assert.equal((await dispatcher.dispatch(fourth.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   const fifth=await app.handle(cb(5,'si:1:h'));
   await store.transaction(s=>{s.educationResources.push({id:'new',categoryId:'root',scope:'private',title:'مورد',university:'جامعة',cycle:'2026',degree:'بكالوريوس',seats:null,sourceImportId:'local',sourceLocator:'row',reviewedBy:'100',status:'PUBLISHED'});});
   assert.equal((await dispatcher.dispatch(fifth.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   const sixth=await app.handle(cb(6,'si:1:h'));
   await store.transaction(s=>{s.privateFeatures['education.navigate']=false;s.privateSettingsRevision=(s.privateSettingsRevision??0)+1;});
   await store.transaction(s=>{s.privateFeatures['education.navigate']=true;s.privateSettingsRevision=(s.privateSettingsRevision??0)+1;});
   assert.equal((await dispatcher.dispatch(sixth.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,1);
   const denied=(await store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===second.deliveryKey)!;
   assert.equal(denied.accessDenialCode,'ACCESS_RECHECK_FAILED');assert.equal(denied.plan,undefined);assert.equal(denied.privateLibraryAccess,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
