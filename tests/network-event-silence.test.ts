import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramNetworkAlertEditor,validNetworkAlertRoute} from '../src/telegram-network-alerts.js';
import {NetworkEventAlertDispatcher,setNetworkAlertPreference} from '../src/network-event-alerts.js';
import {networkAlertSilenceUntil,networkAlertEventSilenced,setNetworkAlertSilence}
 from '../src/network-alert-silence.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import type {TelegramReplyPlan} from '../src/telegram-transport.js';

const N='abcdef123456',A='-100124',B='-100125',OWNER='100',ADMIN='301';
function button(s:OwnerInlineScreen|null,label:string):string{
 assert.ok(s);const b=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(label));
 assert.ok(b,'missing button '+label);assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64);
 return b.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nw6-silence-'));
  const store=new BotStore(join(dir,'s.'+engine),{engine});
  let now=1_700_000_000_000,count=0;
  const policy=new Policy(store,OWNER,()=>now);
  for(const chat of [A,B])await policy.approveChat(OWNER,chat,['moderation']);
  await policy.grant(OWNER,ADMIN,'chat.manage',A,now+20_000_000);
  await store.transaction(s=>{s.groupNetworks=[{id:N,name:'شبكة اختبار',revision:1,
   createdBy:OWNER,updatedAt:now-100,members:[{chatId:A,version:1},{chatId:B,version:1}]}];});
  const add=async()=>{
   const id=(100000000000+(++count)).toString();
   await store.transaction(s=>{s.networkWatchCases??=[];s.networkWatchCases.push({
    id,networkId:N,networkRevision:1,sourceChatId:A,sourceChatVersion:1,
    subjectId:'999888',category:'SPAM',revision:1,status:'PENDING',
    submittedBy:OWNER,submittedAt:now});});
  };
  return {store,policy,ui:new TelegramNetworkAlertEditor(store,policy,()=>now),
   get now(){return now;},advance:(ms:number)=>{now+=ms;},add,
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-006 silence is self-service, private, confirmed and never enables unsubscribed alert types',async()=>{
  const f=await fixture();try{
   const detail=await f.ui.handle(ADMIN,'na:1:d:'+N+':'+A);
   assert.match(detail?.text??'',/غير مفعّل/u);
   const preview=await f.ui.handle(ADMIN,button(detail,'صمت ساعة'));
   assert.match(preview?.text??'',/معاينة الصمت/u);
   assert.equal(networkAlertSilenceUntil(await f.store.snapshot(),f.policy,ADMIN,N,A,f.now),0);
   const confirm=button(preview,'تأكيد');
   assert.equal(validNetworkAlertRoute(confirm),true);
   assert.match((await f.ui.handle(ADMIN,confirm))?.text??'',/مفعّل حتى/u);
   assert.equal(await f.ui.handle(ADMIN,confirm),null,'one-shot silence confirmation cannot replay');
   assert.equal(networkAlertSilenceUntil(await f.store.snapshot(),f.policy,ADMIN,N,A,f.now),f.now+3_600_000);
   assert.equal(await f.ui.handle(ADMIN,'na:1:z:'+N+':'+B+':8'),null);
   assert.equal(await f.ui.handle('302','na:1:z:'+N+':'+A+':8'),null);
   assert.equal(await f.ui.handle(ADMIN,'na:1:z:'+N+':'+A+':2'),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 silenced events do not send during silence or reappear after expiry',async()=>{
  const f=await fixture();try{
   assert.equal(await f.store.transaction(s=>setNetworkAlertPreference(s,f.policy,ADMIN,N,A,'w',f.now)),true);
   f.advance(1000);
   assert.equal(await f.store.transaction(s=>setNetworkAlertSilence(s,f.policy,ADMIN,N,A,1,f.now)),true);
   f.advance(1000);await f.add();
   const plans:TelegramReplyPlan[]=[];
   const worker=new NetworkEventAlertDispatcher(f.store,f.policy,{send:async p=>{
    plans.push(p);return {status:'CONFIRMED',messageId:10};}},()=>f.now,async()=>true);
   assert.equal(await worker.drain(),0);
   f.advance(3_600_000);
   assert.equal(await worker.drain(),0,'old event must never become a delayed alert');
   f.advance(1000);await f.add();
   assert.equal(await worker.drain(),1,'new event after quiet hours is allowed');
   assert.equal(plans.length,1);
   assert.doesNotMatch(JSON.stringify(plans),/999888|100000000001|100000000002/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 manual cancellation suppresses backlog but admits later events',async()=>{
  const f=await fixture();try{
   assert.equal(await f.store.transaction(s=>setNetworkAlertPreference(s,f.policy,ADMIN,N,A,'w',f.now)),true);
   f.advance(1000);
   assert.equal(await f.store.transaction(s=>setNetworkAlertSilence(s,f.policy,ADMIN,N,A,8,f.now)),true);
   f.advance(1000);await f.add();
   f.advance(1000);
   const before=await f.store.snapshot();
   assert.equal(networkAlertEventSilenced(before,f.policy,ADMIN,N,A,f.now,f.now-1000),true);
   const preview=await f.ui.handle(ADMIN,'na:1:z:'+N+':'+A+':0');
   assert.ok(preview);
   assert.match((await f.ui.handle(ADMIN,button(preview,'تأكيد')))?.text??'',/غير مفعّل/u);
   assert.equal(networkAlertSilenceUntil(await f.store.snapshot(),f.policy,ADMIN,N,A,f.now),0);
   assert.equal(networkAlertEventSilenced(await f.store.snapshot(),f.policy,ADMIN,N,A,f.now,f.now-1000),true);
   let sends=0;
   const worker=new NetworkEventAlertDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:12};}},()=>f.now,async()=>true);
   assert.equal(await worker.drain(),0,'cancel must not flush suppressed events');
   f.advance(1000);await f.add();
   assert.equal(await worker.drain(),1);
   assert.equal(sends,1);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 corrupt or duplicate silence audit fails closed and never dispatches',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>setNetworkAlertPreference(s,f.policy,ADMIN,N,A,'w',f.now));
   f.advance(1000);
   await f.store.transaction(s=>setNetworkAlertSilence(s,f.policy,ADMIN,N,A,1,f.now));
   await f.store.transaction(s=>{
    const x=s.audit.find(a=>a.reason.startsWith('NETWORK_EVENT_SILENCE:'))!;
    s.audit.push({...x});
   });
   f.advance(1000);await f.add();
   const state=await f.store.snapshot();
   assert.equal(networkAlertSilenceUntil(state,f.policy,ADMIN,N,A,f.now),null);
   assert.equal(networkAlertEventSilenced(state,f.policy,ADMIN,N,A,f.now,f.now),true);
   let attempts=0;
   const worker=new NetworkEventAlertDispatcher(f.store,f.policy,{send:async()=>{
    attempts++;return {status:'CONFIRMED',messageId:12};}},()=>f.now,async()=>true);
   assert.equal(await worker.drain(),0);assert.equal(attempts,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 expired or revoked preview cannot silently alter recipient silence',async()=>{
  const f=await fixture();try{
   const preview=await f.ui.handle(ADMIN,'na:1:z:'+N+':'+A+':8');
   const confirm=button(preview,'تأكيد');
   f.advance(120_000);
   assert.equal(await f.ui.handle(ADMIN,confirm),null);
   const fresh=await f.ui.handle(ADMIN,'na:1:z:'+N+':'+A+':8');
   const next=button(fresh,'تأكيد');
   await f.store.transaction(s=>{s.grants=[];});
   assert.equal(await f.ui.handle(ADMIN,next),null);
   assert.equal((await f.store.snapshot()).audit.some(x=>x.reason.startsWith('NETWORK_EVENT_SILENCE:')),false);
  }finally{await f.close();}
 });
}
