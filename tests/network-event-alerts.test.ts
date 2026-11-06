import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramNetworkAlertEditor,validNetworkAlertRoute} from '../src/telegram-network-alerts.js';
import {NetworkEventAlertDispatcher,networkAlertEnabled,setNetworkAlertPreference}
 from '../src/network-event-alerts.js';
import type {TelegramReplyPlan} from '../src/telegram-transport.js';
const N='abcdef123456',OTHER='bbbbbb123456',A='-100124',B='-100125',OUT='-100199';
const OWNER='100',ADMIN='301';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nw6-alerts-')),file=join(dir,'s.'+engine);
  const store=new BotStore(file,{engine});let now=1_700_000_000_000;
  const policy=new Policy(store,OWNER,()=>now);
  for(const id of [A,B,OUT])await policy.approveChat(OWNER,id,['moderation']);
  await policy.grant(OWNER,ADMIN,'chat.manage',A,now+600_000);
  await store.transaction(s=>{s.groupNetworks=[
   {id:N,name:'شبكة آمنة',revision:1,createdBy:OWNER,updatedAt:now-50,
    members:[{chatId:A,version:1},{chatId:B,version:1}]},
   {id:OTHER,name:'شبكة أخرى',revision:1,createdBy:OWNER,updatedAt:now-50,
    members:[{chatId:OUT,version:1}]}];});
  let next=0;
  const add=async(chat=A,network=N)=>{
   const id=(100000000000+(++next)).toString();await store.transaction(s=>{
    s.networkWatchCases??=[];s.networkWatchCases.push({id,networkId:network,
     networkRevision:1,sourceChatId:chat,sourceChatVersion:1,subjectId:'999888',
     category:'SPAM',revision:1,status:'PENDING',submittedBy:OWNER,submittedAt:now});
   });return id;
  };
  return {store,policy,ui:new TelegramNetworkAlertEditor(store,policy,()=>now),
   get now(){return now;},advance:(ms:number)=>{now+=ms;},
   add,close:()=>rm(dir,{recursive:true,force:true})};
 }
 const button=(s:{keyboard:{inline_keyboard:{text:string;callback_data:string}[][]}}|null,word:string)=>{
  assert.ok(s);const x=s.keyboard.inline_keyboard.flat().find(v=>v.text.includes(word));assert.ok(x,'button '+word);assert.ok(Buffer.byteLength(x.callback_data,'utf8')<=64);return x.callback_data;
 };
 test(engine+' NETWORK-006 personal alert subscription defaults OFF with per-manager consent and private one-shot confirmation',async()=>{
  const f=await fixture();try{
   let s=await f.store.snapshot();assert.equal(networkAlertEnabled(s,f.policy,ADMIN,N,A,'w',f.now),false);
   const home=await f.ui.handle(ADMIN,'na:1:h:0');assert.ok(home);
   assert.doesNotMatch(JSON.stringify(home),/999888/u);
   const group=await f.ui.handle(ADMIN,button(home,'شبكة آمنة'));
   assert.ok(group);assert.ok(button(group,A));
   assert.equal(group.text.includes(B),false,'other group must never be listed to delegate');
   const setting=await f.ui.handle(ADMIN,button(group,A));
   assert.match(setting?.text??'',/متوقفة/u);
   const preview=await f.ui.handle(ADMIN,button(setting,'البلاغات'));
   assert.match(preview?.text??'',/معاينة/u);
   assert.equal(networkAlertEnabled(await f.store.snapshot(),f.policy,ADMIN,N,A,'w',f.now),false);
   const confirm=button(preview,'تأكيد');
   assert.ok(validNetworkAlertRoute(confirm));
   const applied=await f.ui.handle(ADMIN,confirm);assert.match(applied?.text??'',/مفعّلة/u);
   assert.equal(networkAlertEnabled(await f.store.snapshot(),f.policy,ADMIN,N,A,'w',f.now),true);
   assert.equal(await f.ui.handle(ADMIN,confirm),null,'confirm replay must fail');
   assert.equal(await f.ui.handle('302','na:1:d:'+N+':'+A),null);
   assert.equal(await f.ui.handle(ADMIN,'na:1:p:'+N+':'+B+':w'),null);
   assert.equal(await f.ui.handle(ADMIN,'na:1:p:'+OTHER+':'+OUT+':w'),null);
   assert.equal(await f.ui.handle(ADMIN,'na:1:p:'+N+':'+A+':e'),null,'only scoped kinds supported');
   s=await f.store.snapshot();assert.equal(s.audit.filter(x=>x.reason.startsWith('NETWORK_EVENT_ALERT_PREF:')).length,1);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 enabled scoped event only sends once and never leaks subject, with terminal UNKNOWN outcome',async()=>{
  const f=await fixture();try{
   assert.equal(await f.store.transaction(s=>setNetworkAlertPreference(s,f.policy,ADMIN,N,A,'w',f.now)),true);
   f.advance(1000);await f.add();
   const plans:TelegramReplyPlan[]=[];
   const d=new NetworkEventAlertDispatcher(f.store,f.policy,{send:async plan=>{plans.push(plan);return {status:'UNKNOWN_OUTCOME'};}},()=>f.now,async()=>true);
   assert.equal(await d.drain(),1);assert.equal(await d.drain(),0);
   assert.equal(plans.length,1);assert.equal(plans[0]?.chatId,ADMIN);
   assert.match(plans[0]?.text??'',/بلاغ/u);
   assert.doesNotMatch(JSON.stringify(plans),/999888|100000000001|SECRET/u);
   const s=await f.store.snapshot();assert.equal(s.audit.filter(x=>x.reason==='NETWORK_EVENT_ALERT_UNKNOWN_OUTCOME').length,1);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 does not send past opt-in events, foreign group events, unrelated category, or duplicate bursts',async()=>{
  const f=await fixture();try{
   await f.add();f.advance(500);
   assert.equal(await f.store.transaction(s=>setNetworkAlertPreference(s,f.policy,ADMIN,N,A,'w',f.now)),true);
   const plans:TelegramReplyPlan[]=[];
   const d=new NetworkEventAlertDispatcher(f.store,f.policy,{send:async p=>{plans.push(p);return {status:'CONFIRMED',messageId:17};}},()=>f.now,async()=>true);
   assert.equal(await d.drain(),0,'past event never sent to new subscriber');
   f.advance(1000);await f.add(B);await f.add(OUT,OTHER);
   assert.equal(await d.drain(),0);
   await f.add(A);assert.equal(await d.drain(),1);
   f.advance(1000);await f.add(A);assert.equal(await d.drain(),0,'one minute minimum per recipient');
   f.advance(61_000);await f.add(A);assert.equal(await d.drain(),1);
   assert.equal(plans.length,2);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 revoked manager grant or cancelled opt-in blocks delivery and invalidates old preview',async()=>{
  const f=await fixture();try{
   const preview=await f.ui.handle(ADMIN,'na:1:p:'+N+':'+A+':w');
   assert.ok(preview);const confirm=button(preview,'تأكيد');
   await f.store.transaction(s=>{s.grants=[];});
   assert.equal(await f.ui.handle(ADMIN,confirm),null);
   assert.equal(networkAlertEnabled(await f.store.snapshot(),f.policy,ADMIN,N,A,'w',f.now),false);
   const sends:TelegramReplyPlan[]=[];
   await f.add();const d=new NetworkEventAlertDispatcher(f.store,f.policy,{send:async p=>{sends.push(p);return {status:'CONFIRMED',messageId:5};}},()=>f.now,async()=>true);
   assert.equal(await d.drain(),0);assert.deepEqual(sends,[]);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 permission change during async safety gate yields terminal outcome and no send or retry',async()=>{
  const f=await fixture();try{
   assert.equal(await f.store.transaction(s=>setNetworkAlertPreference(s,f.policy,ADMIN,N,A,'w',f.now)),true);
   f.advance(1000);await f.add();
   let gates=0,sends=0;
   const d=new NetworkEventAlertDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:5};}},()=>f.now,
    async()=>{if(++gates===2)await f.store.transaction(s=>{s.chats.find(c=>c.id===A)!.approved=false;});return true;});
   assert.equal(await d.drain(),0);assert.equal(await d.drain(),0);
   assert.equal(sends,0);
   assert.ok((await f.store.snapshot()).audit.some(x=>x.reason==='NETWORK_EVENT_ALERT_UNKNOWN_OUTCOME'));
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 damaged or duplicate opt-in evidence fails closed',async()=>{
  const f=await fixture();try{
   assert.equal(await f.store.transaction(s=>setNetworkAlertPreference(s,f.policy,ADMIN,N,A,'w',f.now)),true);
   const s=await f.store.snapshot(),pref=s.audit.find(x=>x.reason.startsWith('NETWORK_EVENT_ALERT_PREF:'))!;
   await f.store.transaction(x=>{x.audit.push({...pref});});
   assert.equal(networkAlertEnabled(await f.store.snapshot(),f.policy,ADMIN,N,A,'w',f.now),false);
   f.advance(1000);await f.add();
   let sends=0;const d=new NetworkEventAlertDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:9};}},()=>f.now,async()=>true);
   assert.equal(await d.drain(),0);assert.equal(sends,0);
  }finally{await f.close();}
 });
}
