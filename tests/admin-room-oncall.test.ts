import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {AdminRoomLinks} from '../src/admin-room-links.js';
import {AdminRoomOncallDispatcher,oncallSetting} from '../src/admin-room-oncall.js';
import {TelegramModerationReports} from '../src/telegram-moderation-reports.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import type {TelegramReplySender} from '../src/telegram-replies.js';
import {TelegramBotApiTextSender} from '../src/telegram-replies.js';
type TelegramSendPlan=Parameters<TelegramReplySender['send']>[0];
const NOW=1700000000000;
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const button=(r:Result,prefix:string)=>{assert.equal(r.status,'APPLIED');assert.ok(isValidTelegramInlineKeyboard(r.plan?.inlineMarkup));const b=r.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b,prefix);return b.callback_data;};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'room-oncall-')),path=join(dir,'state.'+engine);let now=NOW,update=0;
 const store=new BotStore(path,{engine}),policy=new Policy(store,'100',()=>now);for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);for(const a of ['301','302'])await policy.grant('100',a,'chat.manage','-100',NOW+86400000);
 const links=new AdminRoomLinks(store,policy,()=>now),id=await links.propose('100','-100','-200','NOTIFICATIONS');assert.ok(id);await links.approve('100',id,'GROUP');await links.approve('100',id,'ROOM');
 const app=()=>{const education=new EducationService(store,policy,()=>now);return new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),membership:async()=> 'VERIFIED',clock:()=>now,botId:'oncall-test',botUsername:'ManaratakBot'});};
 const tap=(data:string,actor=100)=>{const n=++update;return app().handle({update_id:n,callback_query:{id:'oncall'+n,from:{id:actor,is_bot:false},data,message:{message_id:1,chat:{id:actor,type:'private'},from:{id:999,is_bot:true}}}});};
 const command=(text:string,actor=100)=>{const n=++update;return app().handle({update_id:n,message:{message_id:n,chat:{id:actor,type:'private'},from:{id:actor,is_bot:false},text}});};
 const configure=async()=>{const preview=await command('/oncall -100 301 302 60');assert.equal((await tap(button(preview,'oc:1:c:'))).status,'APPLIED');now++;};
 const report=async()=>{assert.equal(await new TelegramModerationReports(store,policy,()=>now).submit('400','-100',101,{message_id:1,chat:{id:-100,type:'supergroup'},from:{id:500,is_bot:false},text:'PRIVATE_STUDENT_MESSAGE'}),'RECORDED');};
 const sent:TelegramSendPlan[]=[];const sender:TelegramReplySender={send:async plan=>{sent.push(plan);return {status:'CONFIRMED',messageId:sent.length};}};
 const worker=(port=sender,safe=async()=>true,source=store)=>new AdminRoomOncallDispatcher(source,policy,port,()=>now,safe);
 return {store,policy,links,id,path,command,tap,configure,report,sent,sender,worker,now:()=>now,advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' concurrent oncall workers reserve one send and simultaneous acknowledgements record one receipt',async()=>{
  const f=await fixture(engine);try{
   await f.configure();await f.report();const counts=await Promise.all([f.worker().drain(),f.worker().drain()]);assert.equal(counts.reduce((a,b)=>a+b,0),1);assert.equal(f.sent.length,1);
   const ack=f.sent[0]!.inlineMarkup!.inline_keyboard[0]![0]!.callback_data;const results=await Promise.all([f.tap(ack,301),f.tap(ack,301)]);assert.deepEqual(results.map(r=>r.status).sort(),['APPLIED','DENIED']);
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('ADMIN_ROOM_ONCALL_ACK:')).length,1);f.advance(60000);assert.equal(await f.worker().drain(),0);
  }finally{await f.close();}
 });
 for(const variant of ['revoke','stop','close','grant'] as const)test(engine+' '+variant+' during the final oncall safety wait prevents outgoing delivery',async()=>{
  const f=await fixture(engine);try{
   await f.configure();await f.report();let checks=0;const safety=async()=>{if(++checks===2){
    if(variant==='stop')return false;
    if(variant==='revoke')await f.links.revoke('100',f.id);
    if(variant==='grant')await f.store.transaction(s=>{s.grants.find(g=>g.actor==='301')!.revoked=true;});
    if(variant==='close')await f.store.transaction(s=>{const report=s.audit.find(a=>a.reason.startsWith('MODERATION_REPORT:'))!;s.audit.push({updateKey:report.updateKey+':closed',actorId:'100',decision:'ALLOW',reason:'MODERATION_REPORT_CLOSED',policyVersion:report.policyVersion,at:f.now()});});
   }return true;};assert.equal(await f.worker(f.sender,safety).drain(),0);assert.equal(f.sent.length,0);assert.equal(await f.worker().drain(),0);
  }finally{await f.close();}
 });
 test(engine+' oncall primary acknowledgement prevents escalation and never closes or sanctions a report',async()=>{
  const f=await fixture(engine);try{
   const detail=await f.tap('al:1:d:'+f.id),entry=button(detail,'oc:1:g:');const settings=await f.tap(entry);assert.match(settings.plan!.text,/غير مهيأة/u);assert.equal((await f.tap(button(settings,'al:1:d:'))).status,'APPLIED');
   await f.configure();await f.report();assert.equal(await f.worker().drain(),1);assert.equal(f.sent[0]!.chatId,'301');const ack=f.sent[0]!.inlineMarkup!.inline_keyboard[0]![0]!.callback_data;
   assert.equal((await f.tap(ack,302)).status,'DENIED');assert.equal((await f.tap(ack,301)).status,'APPLIED');assert.equal((await f.tap(ack,301)).status,'DENIED');f.advance(60000);assert.equal(await f.worker().drain(),0);
   const state=await f.store.snapshot();assert.equal(state.moderationOperations.length,0);assert.equal(state.warnings.length,0);assert.equal(state.audit.some(a=>a.updateKey.endsWith(':closed')),false);assert.equal(JSON.stringify(f.sent).includes('PRIVATE_STUDENT_MESSAGE'),false);assert.equal(f.sent[0]!.text.includes('500'),false);assert.ok(isValidTelegramInlineKeyboard(f.sent[0]!.inlineMarkup));
  }finally{await f.close();}
 });
 test(engine+' unknown primary send is not repeated and fallback receives exactly one escalation after the deadline',async()=>{
  const f=await fixture(engine);try{
   await f.configure();await f.report();let attempts=0;const unknown:TelegramReplySender={send:async()=>{attempts++;return {status:'UNKNOWN_OUTCOME'};}};assert.equal(await f.worker(unknown).drain(),1);assert.equal(await f.worker(unknown).drain(),0);assert.equal(attempts,1);
   f.advance(59999);assert.equal(await f.worker().drain(),0);f.advance(1);assert.equal(await f.worker().drain(),1);assert.equal(f.sent[0]!.chatId,'302');assert.match(f.sent[0]!.text,/تصعيد/u);
   const restored=new BotStore(f.path,{engine});assert.equal(await f.worker(f.sender,async()=>true,restored).drain(),0);const ack=f.sent[0]!.inlineMarkup!.inline_keyboard[0]![0]!.callback_data;assert.equal((await f.tap(ack,301)).status,'DENIED');assert.equal((await f.tap(ack,302)).status,'APPLIED');
  }finally{await f.close();}
 });
 test(engine+' oncall settings need a current authorized preview and back cancels it',async()=>{
  const f=await fixture(engine);try{
   for(const text of ['/oncall -100 301 301 60','/oncall -100 301 999 60','/oncall -100 301 302 59'])assert.equal((await f.command(text)).status,'DENIED');assert.equal((await f.command('/oncall -100 301 302 60',999)).status,'DENIED');
   const preview=await f.command('/oncall -100 301 302 60'),confirm=button(preview,'oc:1:c:');await f.tap(button(preview,'al:1:d:'));assert.equal((await f.tap(confirm)).status,'DENIED');assert.equal(oncallSetting(await f.store.snapshot(),f.policy,'-100',f.now()),undefined);
   const stale=button(await f.command('/oncall -100 301 302 60'),'oc:1:c:');await f.store.transaction(s=>{s.grants.find(g=>g.actor==='301')!.revoked=true;});assert.equal((await f.tap(stale)).status,'DENIED');
  }finally{await f.close();}
 });
 for(const variant of ['revoked','quiet-resume','closed','stopped','late','grant'] as const)test(engine+' oncall '+variant+' blocks stale delivery and escalation',async()=>{
  const f=await fixture(engine);try{
   await f.configure();await f.report();
   if(variant==='revoked')await f.links.revoke('100',f.id);
   if(variant==='quiet-resume'){await f.links.setQuiet('100',f.id,'0',true);const row=(await f.links.visible('100')).find(r=>r.id===f.id)!;await f.links.setQuiet('100',f.id,row.quietWitness!,false);}
   if(variant==='closed')await f.store.transaction(s=>{const report=s.audit.find(a=>a.reason.startsWith('MODERATION_REPORT:'))!;s.audit.push({updateKey:report.updateKey+':closed',actorId:'100',decision:'ALLOW',reason:'MODERATION_REPORT_CLOSED',policyVersion:report.policyVersion,at:f.now()});});
   if(variant==='late')f.advance(60*1000+120000);
   if(variant==='grant')await f.store.transaction(s=>{s.grants.find(g=>g.actor==='301')!.revoked=true;});
   assert.equal(await f.worker(f.sender,async()=>variant!=='stopped').drain(),0);assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test(engine+' disabling invalidated oncall settings is possible with a fresh confirmation',async()=>{
  const f=await fixture(engine);try{
   await f.configure();await f.store.transaction(s=>{s.grants.find(g=>g.actor==='301')!.revoked=true;});assert.equal(oncallSetting(await f.store.snapshot(),f.policy,'-100',f.now()),null);
   const off=await f.command('/oncall -100 off');assert.equal((await f.tap(button(off,'oc:1:c:'))).status,'APPLIED');assert.equal(oncallSetting(await f.store.snapshot(),f.policy,'-100',f.now())?.enabled,false);
  }finally{await f.close();}
 });
 test(engine+' stop button works while the room is quiet and an expired preview cannot apply',async()=>{
  const f=await fixture(engine);try{
   await f.configure();await f.links.setQuiet('100',f.id,'0',true);const settings=await f.command('/oncall -100'),preview=await f.tap(button(settings,'oc:1:o:')),confirm=button(preview,'oc:1:c:');f.advance(120000);assert.equal((await f.tap(confirm)).status,'DENIED');
   const fresh=await f.tap(button(await f.command('/oncall -100'),'oc:1:o:'));assert.equal((await f.tap(button(fresh,'oc:1:c:'))).status,'APPLIED');assert.equal(oncallSetting(await f.store.snapshot(),f.policy,'-100',f.now())?.enabled,false);
  }finally{await f.close();}
 });
 test(engine+' reports older than the configuration are not replayed even at the same millisecond',async()=>{
  const f=await fixture(engine);try{await f.report();await f.configure();assert.equal(await f.worker().drain(),0);assert.equal(f.sent.length,0);}finally{await f.close();}
 });
 test(engine+' tampering with the started receipt during the safety wait prevents the send',async()=>{
  const f=await fixture(engine);try{
   await f.configure();await f.report();let checks=0;const safe=async()=>{if(++checks===2)await f.store.transaction(s=>{s.audit.find(a=>a.reason.startsWith('ADMIN_ROOM_ONCALL_STARTED:'))!.actorId='999';});return true;};assert.equal(await f.worker(f.sender,safe).drain(),0);assert.equal(f.sent.length,0);assert.equal(await f.worker().drain(),0);
  }finally{await f.close();}
 });
 test(engine+' real-shaped text sender accepts the acknowledgement keyboard without exposing report contents',async()=>{
  const f=await fixture(engine);try{
   await f.configure();await f.report();let calls=0;const request=(async(url:unknown,init:RequestInit)=>{calls++;assert.ok(String(url).endsWith('/sendMessage'));const body=JSON.parse(String(init.body));assert.equal(body.chat_id,'301');assert.ok(isValidTelegramInlineKeyboard(body.reply_markup));return Response.json({ok:true,result:{message_id:1,chat:{id:301}}});}) as typeof fetch;
   assert.equal(await f.worker(new TelegramBotApiTextSender('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request)).drain(),1);assert.equal(calls,1);
  }finally{await f.close();}
 });
}
