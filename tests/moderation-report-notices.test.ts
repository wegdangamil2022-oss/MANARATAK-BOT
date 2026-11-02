import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramModerationReports} from '../src/telegram-moderation-reports.js';
import {ModerationReportNoticeDispatcher,setReportNoticePreference} from '../src/moderation-report-notices.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import type {TelegramReplyPlan} from '../src/telegram-transport.js';

for(const engine of ['json','sqlite'] as const){
 for(const change of ['revoke','disable','close','replace-job','alter-start','duplicate-start','outcome','cancel','invalid-clock'] as const){
 test(engine+' pending report notice rechecks '+change+' after the asynchronous delivery gate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'report-notice-race-'));let now=1700000000000;
  try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now),ui=new TelegramModerationReports(store,policy,()=>now);
   await policy.approveChat('100','-100123',['moderation','navigation']);await policy.grant('100','301','chat.manage','-100123',now+600000);
   assert.equal(await store.transaction(s=>setReportNoticePreference(s,policy,'301','-100123',now)),true);
   now+=1000;assert.equal(await ui.submit('300','-100123',101,{message_id:1,chat:{id:-100123,type:'supergroup'},from:{id:400,is_bot:false}}),'RECORDED');
   let sends=0,checks=0;
   const dispatcher=new ModerationReportNoticeDispatcher(store,policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:7};}},()=>now,async()=>{
    if(++checks===2)await store.transaction(s=>{
     const job=s.audit.find(a=>a.reason.startsWith('REPORT_NOTICE_JOB:'))!,started=s.audit.find(a=>a.updateKey===job.updateKey+':started')!;
     if(change==='revoke')s.grants=[];
     if(change==='disable'){now++;assert.equal(setReportNoticePreference(s,policy,'301','-100123',now),true);}
     if(change==='close'){const report=s.audit.find(a=>a.reason.startsWith('MODERATION_REPORT:'))!;s.audit.push({...report,updateKey:report.updateKey+':closed'});}
     if(change==='replace-job')job.at--;
     if(change==='alter-start')started.actorId='302';
     if(change==='duplicate-start')s.audit.push({...started});
     if(change==='outcome')s.audit.push({...started,updateKey:job.updateKey+':outcome',reason:'REPORT_NOTICE_UNKNOWN_OUTCOME'});
     if(change==='cancel')s.audit.push({...started,updateKey:job.updateKey+':cancelled',reason:'REPORT_NOTICE_CANCELLED'});
     if(change==='invalid-clock')now=Number.NaN;
    });
    return true;
   });
   assert.equal(await dispatcher.drain(),0);assert.equal(sends,0);assert.equal(await dispatcher.drain(),0);assert.equal(sends,0);
   const snapshot=await store.snapshot();assert.equal(snapshot.audit.filter(a=>a.updateKey.endsWith(':outcome')).length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 }
 test(engine+' report notices require opt-in, preserve privacy, and never retry an ambiguous send',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'report-notices-'));let now=1700000000000;
  try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now),ui=new TelegramModerationReports(store,policy,()=>now);
   await policy.approveChat('100','-100123',['moderation','navigation']);await policy.grant('100','301','chat.manage','-100123',now+600000);
   const find=(screen:OwnerInlineScreen|null,prefix:string)=>{assert.ok(screen);const b=screen.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith(prefix));assert.ok(b);return b.callback_data;};
   const report=(message:number)=>ui.submit('300','-100123',message+100,{message_id:message,chat:{id:-100123,type:'supergroup'},from:{id:400,is_bot:false},text:'SECRET_REPORT_CONTENT'});
   assert.equal(await report(1),'RECORDED');assert.equal((await store.snapshot()).audit.some(a=>a.reason.startsWith('REPORT_NOTICE_JOB:')),false);
   const inbox=await ui.handle('301','rp:1:r:0'),settings=await ui.handle('301',find(inbox,'rp:1:t:'));
   assert.equal(await ui.handle('302',find(settings,'rp:1:o:')),null);
   const enabled=await ui.handle('301',find(settings,'rp:1:o:'));assert.ok(enabled);assert.match(enabled.keyboard.inline_keyboard[0]![0]!.text,/مفعّل/u);assert.ok(await ui.handle('301',find(enabled,'rp:1:r:')));
   now+=1000;assert.equal(await report(2),'RECORDED');assert.equal(await report(2),'DUPLICATE');
   let sends=0;const plans:TelegramReplyPlan[]=[];
   const dispatcher=new ModerationReportNoticeDispatcher(store,policy,{send:async p=>{sends++;plans.push(p);return {status:'UNKNOWN_OUTCOME'};}},()=>now,async()=>true);
   assert.equal(await dispatcher.drain(),1);assert.equal(await dispatcher.drain(),0);assert.equal(sends,1);
   assert.equal(plans[0]!.chatId,'301');assert.equal(JSON.stringify(plans).includes('400'),false);assert.equal(JSON.stringify(plans).includes('SECRET_REPORT_CONTENT'),false);
   assert.ok((await store.snapshot()).audit.some(a=>a.reason==='REPORT_NOTICE_UNKNOWN_OUTCOME'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' stopped delivery and revoked rights cannot send queued notifications',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'report-notices-'));let now=1700000000000;
  try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now),ui=new TelegramModerationReports(store,policy,()=>now);
   await policy.approveChat('100','-100123',['moderation','navigation']);await policy.grant('100','301','chat.manage','-100123',now+600000);
   const settings=await ui.handle('301','rp:1:t:0');assert.ok(settings);assert.ok(await ui.handle('301',settings.keyboard.inline_keyboard[0]![0]!.callback_data));
   now+=1000;assert.equal(await ui.submit('300','-100123',101,{message_id:1,chat:{id:-100123,type:'supergroup'},from:{id:400,is_bot:false}}),'RECORDED');
   let sends=0,run=false;const dispatcher=new ModerationReportNoticeDispatcher(store,policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:7};}},()=>now,async()=>run);
   assert.equal(await dispatcher.drain(),0);await store.transaction(s=>{s.grants=[];});run=true;assert.equal(await dispatcher.drain(),0);assert.equal(sends,0);
   assert.ok((await store.snapshot()).audit.some(a=>a.reason==='REPORT_NOTICE_CANCELLED'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' changed attempt evidence is quarantined even when the sender acknowledges',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'report-notices-'));let now=1700000000000;
  try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now),ui=new TelegramModerationReports(store,policy,()=>now);
   await policy.approveChat('100','-100123',['moderation','navigation']);await policy.grant('100','301','chat.manage','-100123',now+600000);
   const settings=await ui.handle('301','rp:1:t:0');assert.ok(settings);assert.ok(await ui.handle('301',settings.keyboard.inline_keyboard[0]![0]!.callback_data));
   now+=1000;assert.equal(await ui.submit('300','-100123',101,{message_id:1,chat:{id:-100123,type:'supergroup'},from:{id:400,is_bot:false}}),'RECORDED');
   let sends=0;const dispatcher=new ModerationReportNoticeDispatcher(store,policy,{send:async()=>{sends++;await store.transaction(s=>{s.audit=s.audit.filter(a=>a.reason!=='REPORT_NOTICE_STARTED');});return {status:'CONFIRMED',messageId:7};}},()=>now,async()=>true);
   assert.equal(await dispatcher.drain(),1);assert.equal(await dispatcher.drain(),0);assert.equal(sends,1);
   assert.ok((await store.snapshot()).audit.some(a=>a.reason==='REPORT_NOTICE_UNKNOWN_OUTCOME'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' acknowledgement is recorded and disabling notices cancels pending work',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'report-notices-'));let now=1700000000000;
  try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now),ui=new TelegramModerationReports(store,policy,()=>now);
   await policy.approveChat('100','-100123',['moderation','navigation']);await policy.grant('100','301','chat.manage','-100123',now+600000);
   let screen=await ui.handle('301','rp:1:t:0');assert.ok(screen);screen=await ui.handle('301',screen.keyboard.inline_keyboard[0]![0]!.callback_data);assert.ok(screen);
   const report=(id:number)=>ui.submit('300','-100123',id+100,{message_id:id,chat:{id:-100123,type:'supergroup'},from:{id:400,is_bot:false}});
   now+=1000;assert.equal(await report(1),'RECORDED');let sends=0;
   const dispatcher=new ModerationReportNoticeDispatcher(store,policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:7};}},()=>now,async()=>true);
   assert.equal(await dispatcher.drain(),1);assert.ok((await store.snapshot()).audit.some(a=>a.reason==='REPORT_NOTICE_CONFIRMED'));
   now+=61000;assert.equal(await report(2),'RECORDED');screen=await ui.handle('301','rp:1:t:0');assert.ok(screen);now+=1;assert.ok(await ui.handle('301',screen.keyboard.inline_keyboard[0]![0]!.callback_data));
   assert.equal(await dispatcher.drain(),0);assert.equal(sends,1);assert.ok((await store.snapshot()).audit.some(a=>a.reason==='REPORT_NOTICE_CANCELLED'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
