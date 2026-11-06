import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {applyNetworkSelectedServiceDisable} from '../src/network-bulk-service-control.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const OWNER='100',NOW=1_700_000_000_000,N='abcdef123456',OTHER='eeeeee123456',SOURCE='-100123';
const TARGETS=['-100124','-100125','-100126','-100127'];
function button(s:OwnerInlineScreen|null,contains:string):string{
 assert.ok(s,'missing screen '+contains);
 const row=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(contains));
 assert.ok(row,'missing '+contains+' in '+s.text);
 assert.ok(Buffer.byteLength(row.callback_data,'utf8')<=64);
 return row.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'network-service-control-'));
  let now=NOW;
  const store=new BotStore(join(dir,'s.'+engine),{engine}),policy=new Policy(store,OWNER,()=>now);
  for(const id of [SOURCE,...TARGETS])await policy.approveChat(OWNER,id,['moderation','navigation','assistant']);
  await store.transaction(s=>{
   s.groupNetworks=[
    {id:N,name:'شبكة الخدمات',revision:1,createdBy:OWNER,updatedAt:now,
     members:[SOURCE,...TARGETS.slice(0,3)].map(id=>({chatId:id,version:1}))},
    {id:OTHER,name:'شبكة مستقلة',revision:1,createdBy:OWNER,updatedAt:now,
     members:[{chatId:TARGETS[3]!,version:1}]}];
   for(const chat of s.chats)chat.groupAI='ALL_MENTION';
   s.protectionPolicies=TARGETS.map(id=>({policy:{
    chatId:id,revision:1,mode:'MONITOR' as const,rules:[],allowedDomains:[],
    allowedPhrases:[],exemptMemberIds:[]},chatPolicyVersion:1,
    updatedBy:OWNER,updatedAt:now-20}));
   s.networkInheritance=[{
    id:'111111111111',kind:'POLICY',networkId:N,networkRevision:1,
    sourceChatId:SOURCE,sourceChatVersion:1,sourceRevision:1,
    targetChatId:TARGETS[0]!,targetChatVersion:1,targetRevision:1,
    targetDigest:'a'.repeat(64),createdAt:now-300,lastSyncedAt:now-200,status:'ACTIVE'
   },{
    id:'222222222222',kind:'POLICY',networkId:OTHER,networkRevision:1,
    sourceChatId:SOURCE,sourceChatVersion:1,sourceRevision:1,
    targetChatId:TARGETS[3]!,targetChatVersion:1,targetRevision:1,
    targetDigest:'b'.repeat(64),createdAt:now-300,lastSyncedAt:now-200,status:'ACTIVE'
   }];
  });
  return {store,policy,editor:new OwnerNetworkEditor(store,policy,()=>now),
   advance:(delta:number)=>now+=delta,close:()=>rm(dir,{force:true,recursive:true})};
 }
 test(engine+' NETWORK-004 AI OFF: owner selects only two network groups; other network untouched',async()=>{
  const f=await fixture();try{
   const card=await f.editor.handle(OWNER,'nw:1:d:'+N);
   const home=await f.editor.handle(OWNER,button(card,'إيقاف خدمات'));
   assert.match(home?.text??'',/المساعد/u);
   const list=await f.editor.handle(OWNER,button(home,'المساعد'));
   assert.match(list?.text??'',/اختر/u);
   const one=await f.editor.handle(OWNER,button(list,TARGETS[0]!));
   const two=await f.editor.handle(OWNER,button(one,TARGETS[1]!));
   assert.match(two?.text??'',/المختارة: 2/u);
   const preview=await f.editor.handle(OWNER,button(two,'معاينة'));
   assert.match(preview?.text??'',/المساعد/u);
   assert.match(preview?.text??'',/100124/u);
   assert.match(preview?.text??'',/100125/u);
   const c=button(preview,'تأكيد');
   assert.equal(await f.editor.handle('200',c),null);
   assert.ok(await f.editor.handle(OWNER,c));
   assert.equal(await f.editor.handle(OWNER,c),null);
   const s=await f.store.snapshot();
   assert.deepEqual(s.chats.filter(x=>[TARGETS[0],TARGETS[1]].includes(x.id))
    .map(x=>[x.groupAI,x.version]),[['OFF',2],['OFF',2]]);
   assert.equal(s.chats.find(x=>x.id===TARGETS[2])?.groupAI,'ALL_MENTION');
   assert.equal(s.chats.find(x=>x.id===TARGETS[3])?.groupAI,'ALL_MENTION');
   assert.equal(s.networkInheritance?.[0]?.status,'PAUSED');
   assert.equal(s.networkInheritance?.[1]?.status,'ACTIVE');
   assert.equal(s.moderationOperations.length,0);
   assert.equal(s.operations.length,0);
   assert.ok(s.audit.some(a=>a.reason==='OWNER_NETWORK_GROUP_AI_DISABLED'));
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 MONITOR OFF: preserves rules and versions and pauses related inheritance',async()=>{
  const f=await fixture();try{
   const home=await f.editor.handle(OWNER,'nw:1:sh:'+N);
   const list=await f.editor.handle(OWNER,button(home,'المراقبة'));
   const chosen=await f.editor.handle(OWNER,button(list,TARGETS[0]!));
   const preview=await f.editor.handle(OWNER,button(chosen,'معاينة'));
   const result=await f.editor.handle(OWNER,button(preview,'تأكيد'));
   assert.match(result?.text??'',/المراقبة/u);
   const s=await f.store.snapshot();
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===TARGETS[0])?.policy.mode,'OFF');
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===TARGETS[0])?.policy.revision,2);
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===TARGETS[1])?.policy.mode,'MONITOR');
   assert.equal(s.networkInheritance?.[0]?.status,'PAUSED');
   assert.equal(s.networkInheritance?.[0]?.pausedReason,'LOCAL_OVERRIDE');
   assert.equal(s.networkInheritance?.[1]?.status,'ACTIVE');
   assert.equal(s.chats.find(x=>x.id===TARGETS[0])?.groupAI,'ALL_MENTION');
   assert.ok(s.audit.some(a=>a.reason==='OWNER_NETWORK_GROUP_MONITOR_DISABLED'));
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 network service controls have separate paths and strict callbacks',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:sh:'+N),true);
   assert.equal(validOwnerNetworkRoute('nw:1:sl:'+N+':a:0'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:sl:'+N+':m:0'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:sh:INVALID'),false);
   assert.equal(validOwnerNetworkRoute('nw:1:sl:'+N+':b:0'),false);
   const view=await f.editor.handle(OWNER,'nw:1:sh:'+N);
   assert.equal(await f.editor.handle('200',button(view,'المساعد')),null);
   assert.equal(await f.editor.handle(OWNER,'nw:1:sh:'+OTHER),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 snapshot drift invalidates selected control without changes',async()=>{
  const f=await fixture();try{
   const list=await f.editor.handle(OWNER,'nw:1:sl:'+N+':a:0');
   const selected=await f.editor.handle(OWNER,button(list,TARGETS[0]!));
   const preview=await f.editor.handle(OWNER,button(selected,'معاينة'));
   await f.store.transaction(s=>{s.chats.find(x=>x.id===TARGETS[1])!.version++;});
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
   assert.equal((await f.store.snapshot()).chats.find(x=>x.id===TARGETS[0])?.groupAI,'ALL_MENTION');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 cancelled, expired and simultaneous confirmation are one-shot',async()=>{
  const f=await fixture();try{
   const list=await f.editor.handle(OWNER,'nw:1:sl:'+N+':a:0');
   const selected=await f.editor.handle(OWNER,button(list,TARGETS[0]!));
   const preview=await f.editor.handle(OWNER,button(selected,'معاينة'));
   assert.ok(await f.editor.handle(OWNER,button(preview,'إلغاء')));
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await f.close();}
  const g=await fixture();try{
   const s=await g.editor.handle(OWNER,'nw:1:sl:'+N+':a:0');
   const p=await g.editor.handle(OWNER,button(s,TARGETS[0]!));
   const pre=await g.editor.handle(OWNER,button(p,'معاينة'));
   g.advance(121000);
   assert.equal(await g.editor.handle(OWNER,button(pre,'تأكيد')),null);
  }finally{await g.close();}
  const h=await fixture();try{
   const s=await h.editor.handle(OWNER,'nw:1:sl:'+N+':a:0');
   const p=await h.editor.handle(OWNER,button(s,TARGETS[0]!));
   const pre=await h.editor.handle(OWNER,button(p,'معاينة'));
   const c=button(pre,'تأكيد');
   const results=await Promise.all([h.editor.handle(OWNER,c),h.editor.handle(OWNER,c)]);
   assert.equal(results.filter(Boolean).length,1);
   assert.equal((await h.store.snapshot()).chats.find(x=>x.id===TARGETS[0])?.version,2);
  }finally{await h.close();}
 });
 test(engine+' NETWORK-004 owner STOP and dashboard withdrawal reject control preview',async()=>{
  const f=await fixture();try{
   const list=await f.editor.handle(OWNER,'nw:1:sl:'+N+':a:0');
   const picked=await f.editor.handle(OWNER,button(list,TARGETS[0]!));
   const preview=await f.editor.handle(OWNER,button(picked,'معاينة'));
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await f.close();}
  const g=await fixture();try{
   const list=await g.editor.handle(OWNER,'nw:1:sl:'+N+':a:0');
   const picked=await g.editor.handle(OWNER,button(list,TARGETS[0]!));
   const preview=await g.editor.handle(OWNER,button(picked,'معاينة'));
   await g.store.transaction(s=>{
    s.networkEmergencyControls=[{networkId:N,revision:1,status:'STOPPED',changedAt:NOW,changedBy:OWNER}];
    s.networkInheritance![0]!.status='PAUSED';
    s.networkInheritance![0]!.pausedReason='NETWORK_EMERGENCY';
   });
   assert.equal(await g.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await g.close();}
 });
 test(engine+' NETWORK-004 engine rejects mixing groups, duplicates, stale current versions atomically',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot();
   assert.equal(applyNetworkSelectedServiceDisable(s,f.policy,OWNER,NOW,N,'AI_OFF',
    [TARGETS[0]!,TARGETS[3]!]),null);
   assert.equal(applyNetworkSelectedServiceDisable(s,f.policy,OWNER,NOW,N,'AI_OFF',
    [TARGETS[0]!,TARGETS[0]!]),null);
   assert.equal(applyNetworkSelectedServiceDisable(s,f.policy,OWNER,NOW,N,'MONITOR_OFF',
    [TARGETS[0]!,TARGETS[3]!]),null);
   assert.equal(s.chats.find(x=>x.id===TARGETS[0])?.groupAI,'ALL_MENTION');
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===TARGETS[0])?.policy.mode,'MONITOR');
  }finally{await f.close();}
 });
}
