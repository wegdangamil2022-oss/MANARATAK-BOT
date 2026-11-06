import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',OTHER='eeeeee123456';
const SOURCE='-100123',EXTERNAL='-100199';
const TARGETS=Array.from({length:12},(_,i)=>'-100'+String(124+i));
function button(page:OwnerInlineScreen|null,label:string):string{
 assert.ok(page,'missing screen for '+label);
 const entry=page.keyboard.inline_keyboard.flat().find(x=>x.text.includes(label));
 assert.ok(entry,'missing button "'+label+'" in '+page.text);
 assert.ok(Buffer.byteLength(entry.callback_data,'utf8')<=64,'oversize Telegram callback');
 return entry.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'network-services-multipage-'));
  const filename=join(dir,'state.'+engine);
  const store=new BotStore(filename,{engine});
  let now=NOW;
  const policy=new Policy(store,OWNER,()=>now);
  for(const id of [SOURCE,...TARGETS,EXTERNAL])
   await policy.approveChat(OWNER,id,['navigation','moderation','assistant']);
  await store.transaction(s=>{
   s.groupNetworks=[
    {id:NET,name:'شبكة اختيار الخدمات',revision:1,createdBy:OWNER,updatedAt:now,
     members:[SOURCE,...TARGETS].map(id=>({chatId:id,version:1}))},
    {id:OTHER,name:'شبكة أخرى',revision:1,createdBy:OWNER,updatedAt:now,
     members:[{chatId:EXTERNAL,version:1}]}];
   for(const chat of s.chats)
    if(chat.id!==SOURCE)chat.groupAI='ALL_MENTION';
   s.protectionPolicies=[...TARGETS,EXTERNAL].map(id=>({policy:{
    chatId:id,revision:1,mode:'MONITOR' as const,
    rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},
    chatPolicyVersion:1,updatedBy:OWNER,updatedAt:now-20}));
   s.networkInheritance=[{
    id:'111111111111',kind:'POLICY',networkId:NET,networkRevision:1,
    sourceChatId:SOURCE,sourceChatVersion:1,sourceRevision:1,
    targetChatId:TARGETS[0]!,targetChatVersion:1,targetRevision:1,
    targetDigest:'a'.repeat(64),createdAt:now-100,lastSyncedAt:now-50,
    status:'ACTIVE'
   },{
    id:'222222222222',kind:'POLICY',networkId:NET,networkRevision:1,
    sourceChatId:SOURCE,sourceChatVersion:1,sourceRevision:1,
    targetChatId:TARGETS[9]!,targetChatVersion:1,targetRevision:1,
    targetDigest:'b'.repeat(64),createdAt:now-100,lastSyncedAt:now-50,
    status:'ACTIVE'
   },{
    id:'333333333333',kind:'POLICY',networkId:OTHER,networkRevision:1,
    sourceChatId:SOURCE,sourceChatVersion:1,sourceRevision:1,
    targetChatId:EXTERNAL,targetChatVersion:1,targetRevision:1,
    targetDigest:'c'.repeat(64),createdAt:now-100,lastSyncedAt:now-50,
    status:'ACTIVE'
   }];
  });
  return {store,policy,editor:new OwnerNetworkEditor(store,policy,()=>now),filename,
   newEditor:()=>new OwnerNetworkEditor(new BotStore(filename,{engine}),policy,()=>now),
   advance:(ms:number)=>now+=ms,close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-004 multi-page AI off: select across two pages, preview, one-shot apply and history',async()=>{
  const f=await fixture();try{
   const home=await f.editor.handle(OWNER,'nw:1:sh:'+NET);
   const route=button(home,'المساعد');
   assert.equal(validOwnerNetworkRoute(route),true);
   const first=await f.editor.handle(OWNER,route);
   assert.match(first?.text??'',/صفحة 1\/2/u);
   const selected1=await f.editor.handle(OWNER,button(first,TARGETS[0]!));
   assert.match(selected1?.text??'',/المختارة: 1/u);
   const second=await f.editor.handle(OWNER,button(selected1,'التالي'));
   assert.match(second?.text??'',/صفحة 2\/2/u);
   assert.match(second?.text??'',/المختارة: 1/u);
   const selected2=await f.editor.handle(OWNER,button(second,TARGETS[9]!));
   assert.match(selected2?.text??'',/المختارة: 2/u);
   const returned=await f.editor.handle(OWNER,button(selected2,'السابق'));
   assert.match(returned?.text??'',/المختارة: 2/u);
   const preview=await f.editor.handle(OWNER,button(returned,'معاينة'));
   assert.match(preview?.text??'',/المساعد/u);
   assert.match(preview?.text??'',/100124/u);
   assert.match(preview?.text??'',/100133/u);
   assert.match(preview?.text??'',/متابعات/u);
   assert.equal((await f.store.snapshot()).chats.find(x=>x.id===TARGETS[0])?.groupAI,'ALL_MENTION');
   const confirm=button(preview,'تأكيد');
   assert.equal(await f.editor.handle('200',confirm),null);
   const accepted=await f.editor.handle(OWNER,confirm);
   assert.match(accepted?.text??'',/المجموعات المعدلة: 2/u);
   assert.equal(await f.editor.handle(OWNER,confirm),null);
   const s=await f.store.snapshot();
   assert.deepEqual(TARGETS.filter(id=>s.chats.find(x=>x.id===id)?.groupAI==='OFF'),
    [TARGETS[0],TARGETS[9]]);
   assert.equal(s.chats.find(x=>x.id===EXTERNAL)?.groupAI,'ALL_MENTION');
   assert.deepEqual(s.networkInheritance?.map(x=>x.status),['PAUSED','PAUSED','ACTIVE']);
   assert.equal(s.operations.length,0);
   assert.equal(s.moderationOperations.length,0);
   const history=await f.editor.handle(OWNER,'nw:1:sa:'+NET+':0');
   const info=await f.editor.handle(OWNER,button(history,'2 مجموعات'));
   assert.match(info?.text??'',/100124/u);
   assert.match(info?.text??'',/100133/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 multi-page MONITOR off preserves policies and unrelated group across pages',async()=>{
  const f=await fixture();try{
   const home=await f.editor.handle(OWNER,'nw:1:sh:'+NET);
   const first=await f.editor.handle(OWNER,button(home,'المراقبة'));
   const pick1=await f.editor.handle(OWNER,button(first,TARGETS[0]!));
   const second=await f.editor.handle(OWNER,button(pick1,'التالي'));
   const pick2=await f.editor.handle(OWNER,button(second,TARGETS[9]!));
   const preview=await f.editor.handle(OWNER,button(pick2,'معاينة'));
   assert.match(preview?.text??'',/MONITOR/u);
   assert.match(preview?.text??'',/100124/u);
   assert.match(preview?.text??'',/100133/u);
   assert.ok(await f.editor.handle(OWNER,button(preview,'تأكيد')));
   const s=await f.store.snapshot();
   const changed=s.protectionPolicies?.filter(x=>x.policy.mode==='OFF').map(x=>x.policy.chatId);
   assert.deepEqual(changed,[TARGETS[0],TARGETS[9]]);
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===TARGETS[9])?.policy.revision,2);
   assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===EXTERNAL)?.policy.mode,'MONITOR');
   assert.equal(s.chats.find(x=>x.id===TARGETS[0])?.groupAI,'ALL_MENTION');
   assert.equal(s.networkInheritance?.[0]?.pausedReason,'LOCAL_OVERRIDE');
   assert.equal(s.networkInheritance?.[1]?.pausedReason,'LOCAL_OVERRIDE');
   assert.equal(s.networkInheritance?.[2]?.status,'ACTIVE');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 multi-page selection max eight globally with removal and alternative ninth',async()=>{
  const f=await fixture();try{
   let page=await f.editor.handle(OWNER,'nw:1:qx:'+NET+':a');
   for(let i=0;i<7;i++)page=await f.editor.handle(OWNER,button(page,TARGETS[i]!));
   page=await f.editor.handle(OWNER,button(page,'التالي'));
   page=await f.editor.handle(OWNER,button(page,TARGETS[9]!));
   assert.match(page?.text??'',/المختارة: 8/u);
   const rejected=await f.editor.handle(OWNER,button(page,TARGETS[10]!));
   assert.match(rejected?.text??'',/الحد الأقصى/u);
   assert.match(rejected?.text??'',/المختارة: 8/u);
   const deselected=await f.editor.handle(OWNER,button(rejected,TARGETS[9]!));
   assert.match(deselected?.text??'',/المختارة: 7/u);
   const alternative=await f.editor.handle(OWNER,button(deselected,TARGETS[10]!));
   assert.match(alternative?.text??'',/المختارة: 8/u);
   const pre=await f.editor.handle(OWNER,button(alternative,'معاينة'));
   assert.ok(await f.editor.handle(OWNER,button(pre,'تأكيد')));
   const s=await f.store.snapshot();
   assert.equal(TARGETS.filter(id=>s.chats.find(x=>x.id===id)?.groupAI==='OFF').length,8);
   assert.equal(s.chats.find(x=>x.id===TARGETS[9])?.groupAI,'ALL_MENTION');
   assert.equal(s.chats.find(x=>x.id===TARGETS[10])?.groupAI,'OFF');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 multi-page selection persists across BotStore and editor restart',async()=>{
  const f=await fixture();try{
   const begin=await f.editor.handle(OWNER,'nw:1:qx:'+NET+':m');
   const picked=await f.editor.handle(OWNER,button(begin,TARGETS[0]!));
   const second=await f.newEditor().handle(OWNER,button(picked,'التالي'));
   assert.match(second?.text??'',/المختارة: 1/u);
   const picked2=await f.newEditor().handle(OWNER,button(second,TARGETS[9]!));
   assert.match(picked2?.text??'',/المختارة: 2/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 multi-page callbacks owner-only, stale and concurrent toggles blocked',async()=>{
  const f=await fixture();try{
   const first=await f.editor.handle(OWNER,'nw:1:qx:'+NET+':a');
   const choice=button(first,TARGETS[0]!);
   assert.equal(await f.editor.handle('200',choice),null);
   const results=await Promise.all([f.editor.handle(OWNER,choice),f.editor.handle(OWNER,choice)]);
   assert.equal(results.filter(Boolean).length,1);
   const current=results.find(Boolean)!;
   assert.equal(await f.editor.handle(OWNER,choice),null);
   const second=await f.editor.handle(OWNER,button(current,'التالي'));
   assert.match(second?.text??'',/المختارة: 1/u);
   assert.equal(await f.editor.handle(OWNER,button(current,'معاينة')),null);
   assert.equal(await f.editor.handle(OWNER,button(current,'التالي')),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 multi-page session cancel, preview freeze and expiry',async()=>{
  const f=await fixture();try{
   const first=await f.editor.handle(OWNER,'nw:1:qx:'+NET+':a');
   const picked=await f.editor.handle(OWNER,button(first,TARGETS[0]!));
   const preview=await f.editor.handle(OWNER,button(picked,'معاينة'));
   assert.equal(await f.editor.handle(OWNER,button(picked,TARGETS[1]!)),null);
   assert.ok(await f.editor.handle(OWNER,button(preview,'إلغاء')));
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
   assert.equal((await f.store.snapshot()).chats.find(x=>x.id===TARGETS[0])?.groupAI,'ALL_MENTION');
  }finally{await f.close();}
  const g=await fixture();try{
   const first=await g.editor.handle(OWNER,'nw:1:qx:'+NET+':m');
   g.advance(601_000);
   assert.equal(await g.editor.handle(OWNER,button(first,TARGETS[0]!)),null);
  }finally{await g.close();}
  const h=await fixture();try{
   const first=await h.editor.handle(OWNER,'nw:1:qx:'+NET+':m');
   const cancelled=await h.editor.handle(OWNER,button(first,'إلغاء الاختيار'));
   assert.match(cancelled?.text??'',/أُلغي/u);
   assert.equal(await h.editor.handle(OWNER,button(first,TARGETS[0]!)),null);
  }finally{await h.close();}
 });
 test(engine+' NETWORK-004 multi-page changes to membership or service state invalidate pending buttons and receipts',async()=>{
  const f=await fixture();try{
   const first=await f.editor.handle(OWNER,'nw:1:qx:'+NET+':a');
   const picked=await f.editor.handle(OWNER,button(first,TARGETS[0]!));
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal(await f.editor.handle(OWNER,button(picked,'التالي')),null);
   assert.equal((await f.store.snapshot()).chats.find(x=>x.id===TARGETS[0])?.groupAI,'ALL_MENTION');
  }finally{await f.close();}
  const g=await fixture();try{
   const first=await g.editor.handle(OWNER,'nw:1:qx:'+NET+':m');
   const picked=await g.editor.handle(OWNER,button(first,TARGETS[0]!));
   const preview=await g.editor.handle(OWNER,button(picked,'معاينة'));
   await g.store.transaction(s=>{s.protectionPolicies![1]!.policy.revision++;});
   assert.equal(await g.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await g.close();}
 });
 test(engine+' NETWORK-004 multi-page emergency and dashboard revocation disable both operation modes',async()=>{
  const f=await fixture();try{
   const first=await f.editor.handle(OWNER,'nw:1:qx:'+NET+':a');
   const picked=await f.editor.handle(OWNER,button(first,TARGETS[0]!));
   const preview=await f.editor.handle(OWNER,button(picked,'معاينة'));
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await f.close();}
  const g=await fixture();try{
   const first=await g.editor.handle(OWNER,'nw:1:qx:'+NET+':m');
   const picked=await g.editor.handle(OWNER,button(first,TARGETS[0]!));
   const preview=await g.editor.handle(OWNER,button(picked,'معاينة'));
   await g.store.transaction(s=>{
    s.networkEmergencyControls=[{networkId:NET,revision:1,status:'STOPPED',changedAt:NOW,changedBy:OWNER}];
    for(const link of s.networkInheritance??[])
     if(link.networkId===NET){link.status='PAUSED';link.pausedReason='NETWORK_EMERGENCY';}
   });
   assert.equal(await g.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await g.close();}
 });
 test(engine+' NETWORK-004 multi-page new routes reject malformed callbacks without side effects',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:qx:'+NET+':a'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:qx:'+NET+':m'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:qx:INVALID:a'),false);
   assert.equal(validOwnerNetworkRoute('nw:1:qx:'+NET+':z'),false);
   assert.equal(validOwnerNetworkRoute('nw:1:qp:'+'a'.repeat(24)+':1:1'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:qt:'+'a'.repeat(24)+':1:9'),false);
   assert.equal(validOwnerNetworkRoute('nw:1:qv:'+'a'.repeat(24)+':1'),true);
   assert.equal(await f.editor.handle(OWNER,'nw:1:qv:'+'a'.repeat(24)+':1'),null);
   assert.equal((await f.store.snapshot()).chats.find(x=>x.id===TARGETS[0])?.groupAI,'ALL_MENTION');
  }finally{await f.close();}
 });
}
