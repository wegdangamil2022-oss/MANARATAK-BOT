import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',SOURCE='-100123';
function button(page:OwnerInlineScreen|null,needle:string):string{
 assert.ok(page,'missing screen '+needle);
 const b=page.keyboard.inline_keyboard.flat().find(x=>x.text.includes(needle));
 assert.ok(b,'missing '+needle+' on '+page.text);
 assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64);
 return b.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(count=12){
  const dir=await mkdtemp(join(tmpdir(),'network-multipage-stop-'));
  const file=join(dir,'state.'+engine);
  const store=new BotStore(file,{engine});
  let now=NOW;
  const policy=new Policy(store,OWNER,()=>now);
  const ids=Array.from({length:count},(_,i)=>'-100'+String(124+i));
  for(const id of [SOURCE,...ids])
   await policy.approveChat(OWNER,id,['navigation','moderation']);
  await store.transaction(s=>{
   s.groupNetworks=[{id:NET,name:'شبكة متعددة الصفحات',revision:1,createdBy:OWNER,
    updatedAt:now,members:s.chats.map(chat=>({chatId:chat.id,version:chat.version}))}];
   s.networkInheritance=ids.map((chatId,i)=>({
    id:(i+1).toString(16).padStart(12,'0'),kind:'POLICY' as const,
    networkId:NET,networkRevision:1,sourceChatId:SOURCE,sourceChatVersion:1,
    sourceRevision:1,targetChatId:chatId,targetChatVersion:1,targetRevision:1,
    targetDigest:'a'.repeat(64),createdAt:now-100,lastSyncedAt:now-50,
    status:'ACTIVE' as const
   }));
  });
  return {store,policy,editor:new OwnerNetworkEditor(store,policy,()=>now),ids,
   newEditor:()=>new OwnerNetworkEditor(new BotStore(file,{engine}),policy,()=>now),
   advance:(ms:number)=>{now+=ms;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-004 multi-page owner workflow pauses only selected groups across two pages',async()=>{
  const f=await fixture();try{
   const list=await f.editor.handle(OWNER,'nw:1:f:'+NET+':0');
   const startRoute=button(list,'متعددة الصفحات');
   assert.equal(validOwnerNetworkRoute(startRoute),true);
   const first=await f.editor.handle(OWNER,startRoute);
   assert.match(first?.text??'',/صفحة 1\/2/u);
   const chosen1=await f.editor.handle(OWNER,button(first,f.ids[0]!));
   assert.match(chosen1?.text??'',/المختارة: 1/u);
   const second=await f.editor.handle(OWNER,button(chosen1,'التالي'));
   assert.match(second?.text??'',/صفحة 2\/2/u);
   assert.match(second?.text??'',/المختارة: 1/u);
   const chosen2=await f.editor.handle(OWNER,button(second,f.ids[10]!));
   assert.match(chosen2?.text??'',/المختارة: 2/u);
   const back=await f.editor.handle(OWNER,button(chosen2,'السابق'));
   assert.match(back?.text??'',/المختارة: 2/u);
   const preview=await f.editor.handle(OWNER,button(back,'معاينة'));
   assert.match(preview?.text??'',/معاينة/u);
   assert.match(preview?.text??'',new RegExp(f.ids[0]!.replace('-','\\-')));
   assert.match(preview?.text??'',new RegExp(f.ids[10]!.replace('-','\\-')));
   assert.equal((await f.store.snapshot()).networkInheritance?.filter(x=>x.status==='ACTIVE').length,12);
   const confirm=button(preview,'تأكيد');
   assert.equal(await f.editor.handle('200',confirm),null);
   const accepted=await f.editor.handle(OWNER,confirm);
   assert.match(accepted?.text??'',/أُوقفت/u);
   assert.equal(await f.editor.handle(OWNER,confirm),null);
   const state=await f.store.snapshot();
   assert.deepEqual(state.networkInheritance?.filter(x=>x.status==='PAUSED').map(x=>x.targetChatId),
    [f.ids[0],f.ids[10]]);
   assert.equal(state.networkInheritance?.filter(x=>x.status==='ACTIVE').length,10);
   assert.equal(state.moderationOperations.length,0);
   assert.equal(state.moderationReasons.length,0);
   assert.equal(state.operations.length,0);
   const history=await f.editor.handle(OWNER,'nw:1:r:p:0');
   assert.ok(button(history,'إيقاف متابعات مختارة'));
   const detail=await f.editor.handle(OWNER,button(history,'إيقاف متابعات مختارة'));
   assert.match(detail?.text??'',/100134/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 multi-page count never exceeds eight across pages and supports removal',async()=>{
  const f=await fixture();try{
   let page=await f.editor.handle(OWNER,'nw:1:ms:'+NET);
   for(let i=0;i<7;i++)page=await f.editor.handle(OWNER,button(page,f.ids[i]!));
   page=await f.editor.handle(OWNER,button(page,'التالي'));
   page=await f.editor.handle(OWNER,button(page,f.ids[10]!));
   assert.match(page?.text??'',/المختارة: 8/u);
   const ninth=await f.editor.handle(OWNER,button(page,f.ids[11]!));
   assert.match(ninth?.text??'',/8/u);
   assert.equal((await f.store.snapshot()).networkInheritance?.filter(x=>x.status==='ACTIVE').length,12);
   const remove=await f.editor.handle(OWNER,button(ninth,f.ids[10]!));
   assert.match(remove?.text??'',/المختارة: 7/u);
   const add=await f.editor.handle(OWNER,button(remove,f.ids[11]!));
   assert.match(add?.text??'',/المختارة: 8/u);
   const preview=await f.editor.handle(OWNER,button(add,'معاينة'));
   assert.ok(await f.editor.handle(OWNER,button(preview,'تأكيد')));
   const s=await f.store.snapshot();
   assert.equal(s.networkInheritance?.filter(x=>x.status==='PAUSED').length,8);
   assert.equal(s.networkInheritance?.find(x=>x.targetChatId===f.ids[10])?.status,'ACTIVE');
   assert.equal(s.networkInheritance?.find(x=>x.targetChatId===f.ids[11])?.status,'PAUSED');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 multi-page selection persists on disk between owner editor instances',async()=>{
  const f=await fixture();try{
   const first=await f.editor.handle(OWNER,'nw:1:ms:'+NET);
   const picked=await f.editor.handle(OWNER,button(first,f.ids[0]!));
   const second=await f.newEditor().handle(OWNER,button(picked,'التالي'));
   assert.match(second?.text??'',/المختارة: 1/u);
   const further=await f.newEditor().handle(OWNER,button(second,f.ids[9]!));
   assert.match(further?.text??'',/المختارة: 2/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 old owner buttons and concurrent toggles fail closed without duplicate selections',async()=>{
  const f=await fixture();try{
   const first=await f.editor.handle(OWNER,'nw:1:ms:'+NET);
   const choice=button(first,f.ids[0]!);
   assert.equal(await f.editor.handle('200',choice),null);
   const results=await Promise.all([f.editor.handle(OWNER,choice),f.editor.handle(OWNER,choice)]);
   assert.equal(results.filter(Boolean).length,1);
   assert.equal(await f.editor.handle(OWNER,choice),null);
   const updated=results.find(Boolean)!;
   const next=await f.editor.handle(OWNER,button(updated,'التالي'));
   assert.equal(await f.editor.handle(OWNER,button(updated,'معاينة')),null);
   assert.equal(await f.editor.handle(OWNER,button(updated,'التالي')),null);
   assert.match(next?.text??'',/المختارة: 1/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 multi-page consent expires, and preview freezes old selection',async()=>{
  const f=await fixture();try{
   const first=await f.editor.handle(OWNER,'nw:1:ms:'+NET);
   const chosen=await f.editor.handle(OWNER,button(first,f.ids[0]!));
   const preview=await f.editor.handle(OWNER,button(chosen,'معاينة'));
   assert.equal(await f.editor.handle(OWNER,button(chosen,f.ids[1]!)),null);
   assert.ok(await f.editor.handle(OWNER,button(preview,'إلغاء')));
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
   assert.equal((await f.store.snapshot()).networkInheritance?.filter(x=>x.status==='PAUSED').length,0);
  }finally{await f.close();}
  const g=await fixture();try{
   const start=await g.editor.handle(OWNER,'nw:1:ms:'+NET);
   g.advance(601_000);
   assert.equal(await g.editor.handle(OWNER,button(start,g.ids[0]!)),null);
  }finally{await g.close();}
 });
 test(engine+' NETWORK-004 changing rights, group network and emergency STOP invalidates multi-page wizard',async()=>{
  const f=await fixture();try{
   const first=await f.editor.handle(OWNER,'nw:1:ms:'+NET);
   const chosen=await f.editor.handle(OWNER,button(first,f.ids[0]!));
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal(await f.editor.handle(OWNER,button(chosen,'التالي')),null);
   assert.equal((await f.store.snapshot()).networkInheritance?.filter(x=>x.status==='ACTIVE').length,12);
  }finally{await f.close();}
  const g=await fixture();try{
   const first=await g.editor.handle(OWNER,'nw:1:ms:'+NET);
   const chosen=await g.editor.handle(OWNER,button(first,g.ids[0]!));
   const preview=await g.editor.handle(OWNER,button(chosen,'معاينة'));
   await g.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await g.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await g.close();}
  const h=await fixture();try{
   const first=await h.editor.handle(OWNER,'nw:1:ms:'+NET);
   const chosen=await h.editor.handle(OWNER,button(first,h.ids[0]!));
   const preview=await h.editor.handle(OWNER,button(chosen,'معاينة'));
   await h.store.transaction(s=>{
    s.networkEmergencyControls=[{networkId:NET,revision:1,status:'STOPPED',changedAt:NOW,changedBy:OWNER}];
    for(const row of s.networkInheritance!){row.status='PAUSED';row.pausedReason='NETWORK_EMERGENCY';}
   });
   assert.equal(await h.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await h.close();}
 });
 test(engine+' NETWORK-004 multi-page routes are bounded, malformed inputs never mutate state',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:ms:'+NET),true);
   assert.equal(validOwnerNetworkRoute('nw:1:ms:BAD'),false);
   assert.equal(validOwnerNetworkRoute('nw:1:mp:xyz:1:0'),false);
   assert.equal(validOwnerNetworkRoute('nw:1:mt:'+'a'.repeat(24)+':1:9'),false);
   assert.equal(validOwnerNetworkRoute('nw:1:mv:'+'a'.repeat(24)+':1'),true);
   assert.equal(await f.editor.handle(OWNER,'nw:1:mv:'+'a'.repeat(24)+':1'),null);
   const state=await f.store.snapshot();
   assert.equal(state.networkInheritance?.filter(x=>x.status==='ACTIVE').length,12);
  }finally{await f.close();}
 });
}
