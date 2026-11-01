import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramModerationReports} from '../src/telegram-moderation-reports.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const NOW=1700000000000,CHAT='-100123';
const reply=(id=1)=>({message_id:id,chat:{id:Number(CHAT),type:'supergroup'},from:{id:400,is_bot:false},text:'PRIVATE_CONTENT_NEVER_STORE'});
const route=(s:OwnerInlineScreen|null,prefix:string)=>{assert.ok(s&&isValidTelegramInlineKeyboard(s.keyboard));const b=s?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b,prefix);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'reports-')),store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100',CHAT,['moderation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);return {store,policy,ui:new TelegramModerationReports(store,policy,()=>NOW),close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' reports persist only metadata, deduplicate, stay private and require a fresh independent close confirmation',async()=>{
  const f=await fixture();try{
   assert.equal(await f.ui.submit('300',CHAT,10,reply()),'RECORDED');assert.equal(await f.ui.submit('300',CHAT,11,reply()),'DUPLICATE');assert.equal(JSON.stringify(await f.store.snapshot()).includes('PRIVATE_CONTENT_NEVER_STORE'),false);
   const ui=new TelegramModerationReports(f.store,f.policy,()=>NOW),own=await ui.handle('300','rp:1:h:0');assert.ok(own);assert.equal(await ui.handle('302',route(own,'rp:1:d:')),null);
   assert.equal(await ui.handle('302','rp:1:r:0'),null);const inbox=await ui.handle('301','rp:1:r:0'),detail=await ui.handle('301',route(inbox,'rp:1:d:'));assert.match(detail!.text,/400/u);const preview=await ui.handle('301',route(detail,'rp:1:x:'));const confirm=route(preview,'rp:1:c:');
   assert.equal((await f.store.snapshot()).audit.some(a=>a.reason==='MODERATION_REPORT_CLOSED'),false);assert.equal(await ui.handle('100',confirm),null);assert.ok(await ui.handle('301',confirm));assert.equal(await ui.handle('301',confirm),null);
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='MODERATION_REPORT_CLOSED').length,1);
  }finally{await f.close();}
 });
 test(engine+' transport accepts only a direct group report and keeps all review callbacks private',async()=>{
  const f=await fixture();try{
   const education=new EducationService(f.store,f.policy,()=>NOW),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,()=>NOW),faq:new ApprovedAnswerService(f.store,f.policy,()=>NOW),links:new ResourceLinkService(f.store,f.policy,()=>NOW),clock:()=>NOW,botId:'reports',botUsername:'ManaratakBot',ownerMenuMode:'inline',studentMenuMode:'inline',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
   const result=await app.handle({update_id:1,message:{message_id:10,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'/report',reply_to_message:reply()}});assert.equal(result.reason,'MODERATION_REPORT_RECORDED');assert.ok(result.plan);assert.equal(result.plan.text.includes('400'),false);
   const inbox=await app.handle({update_id:2,message:{message_id:11,chat:{id:301,type:'private'},from:{id:301,is_bot:false},text:'/reports'}});assert.ok(inbox.plan?.inlineMarkup);const queue=inbox.plan.inlineMarkup.inline_keyboard.flat().find(b=>b.callback_data==='rp:1:r:0');assert.ok(queue);
   const callback=(id:number,group:boolean)=>({update_id:id,callback_query:{id:'report-'+id,from:{id:301,is_bot:false},data:'rp:1:r:0',message:{message_id:20,from:{id:999,is_bot:true},chat:{id:group?Number(CHAT):301,type:group?'supergroup':'private'}}}});
   assert.equal((await app.handle(callback(3,true))).reason,'PRIVATE_CALLBACK_ONLY');const view=await app.handle(callback(4,false));assert.equal(view.reason,'MODERATION_REPORT_VIEW');assert.ok(view.plan?.inlineMarkup);
  }finally{await f.close();}
 });
 test(engine+' report target validation, per-actor quota and revoked reviewer rights fail closed',async()=>{
  const f=await fixture();try{
   assert.equal(await f.ui.submit('300',CHAT,1,reply()),'INVALID');assert.equal(await f.ui.submit('400',CHAT,10,reply()),'INVALID');assert.equal(await f.ui.submit('300',CHAT,10,{...reply(),forward_origin:{type:'user'}}),'INVALID');assert.equal(await f.ui.submit('300',CHAT,10,{...reply(),sender_chat:{id:-1}}),'INVALID');assert.equal(await f.ui.submit('300','-999',10,reply()),'INVALID');
   for(let i=1;i<=3;i++)assert.equal(await f.ui.submit('300',CHAT,10+i,reply(i)),'RECORDED');assert.equal(await f.ui.submit('300',CHAT,15,reply(4)),'LIMIT');
   const inbox=await f.ui.handle('301','rp:1:r:0'),detail=await f.ui.handle('301',route(inbox,'rp:1:d:')),preview=await f.ui.handle('301',route(detail,'rp:1:x:')),confirm=route(preview,'rp:1:c:');await f.store.transaction(s=>{s.grants=[];});assert.equal(await f.ui.handle('301',confirm),null);assert.equal((await f.store.snapshot()).audit.some(a=>a.reason==='MODERATION_REPORT_CLOSED'),false);
  }finally{await f.close();}
 });
}
