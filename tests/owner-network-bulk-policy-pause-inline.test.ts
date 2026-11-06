import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {pauseSelectedNetworkPolicyLinks} from '../src/network-bulk-policy-pause.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',OTHER='eeeeee123456';
const SOURCE='-100123';
const targets=['-100124','-100125','-100126'];
function button(s:OwnerInlineScreen|null,part:string):string{
 assert.ok(s,'expected screen '+part);
 const row=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(part));
 assert.ok(row,'missing '+part+' in '+s.text);
 assert.ok(Buffer.byteLength(row.callback_data,'utf8')<=64);
 return row.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(count=3){
  const dir=await mkdtemp(join(tmpdir(),'network-bulk-select-'));
  const store=new BotStore(join(dir,'s.'+engine),{engine});
  let now=NOW;
  const policy=new Policy(store,OWNER,()=>now);
  const ids=Array.from({length:count},(_,i)=>'-100'+String(124+i));
  for(const id of [SOURCE,...ids])await policy.approveChat(OWNER,id,['moderation','navigation']);
  await store.transaction(s=>{
   s.groupNetworks=[{id:NET,name:'شبكة تجريبية',revision:1,createdBy:OWNER,updatedAt:now,
    members:s.chats.map(x=>({chatId:x.id,version:x.version}))},
    {id:OTHER,name:'شبكة أخرى',revision:1,createdBy:OWNER,updatedAt:now,members:[]}];
   s.networkInheritance=ids.map((id,i)=>({
    id:(i+1).toString(16).padStart(12,'0'),kind:'POLICY' as const,
    networkId:NET,networkRevision:1,sourceChatId:SOURCE,sourceChatVersion:1,
    sourceRevision:1,targetChatId:id,targetChatVersion:1,targetRevision:1,
    targetDigest:'a'.repeat(64),createdAt:now-100,lastSyncedAt:now-50,
    status:'ACTIVE' as const
   }));
  });
  const editor=new OwnerNetworkEditor(store,policy,()=>now);
  return {store,policy,editor,ids,
   advance:(delta:number)=>{now+=delta;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-004 choose two distinct groups out of three and pause only those',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:bl:'+NET+':0'),true);
   const page=await f.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   assert.match(page?.text??'',/اختيار المجموعات/u);
   const picked1=await f.editor.handle(OWNER,button(page,targets[0]!));
   const picked2=await f.editor.handle(OWNER,button(picked1,targets[1]!));
   assert.match(picked2?.text??'',/المختارة: 2/u);
   const preview=await f.editor.handle(OWNER,button(picked2,'معاينة'));
   assert.match(preview?.text??'',/معاينة/u);
   assert.match(preview?.text??'',new RegExp(targets[0]!.replace('-','\\-')));
   assert.equal((await f.store.snapshot()).networkInheritance!.filter(x=>x.status==='ACTIVE').length,3);
   const confirm=button(preview,'تأكيد');
   assert.equal(await f.editor.handle('200',confirm),null);
   const result=await f.editor.handle(OWNER,confirm);
   assert.match(result?.text??'',/أُوقف|توقف/u);
   assert.equal(await f.editor.handle(OWNER,confirm),null);
   const s=await f.store.snapshot();
   assert.deepEqual(s.networkInheritance!.map(x=>x.status),['PAUSED','PAUSED','ACTIVE']);
   assert.deepEqual(s.networkInheritance!.slice(0,2).map(x=>x.pausedReason),['OWNER_PAUSED','OWNER_PAUSED']);
   assert.equal(s.moderationOperations.length,0);
   assert.equal(s.moderationReasons.length,0);
   assert.equal(s.operations.length,0);
   assert.ok(s.audit.some(x=>x.reason==='OWNER_NETWORK_SELECTED_POLICY_FOLLOWS_STOPPED'));
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 selection is per-page, exactly one page and never exceeds eight',async()=>{
  const f=await fixture(10);try{
   const page=await f.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   assert.match(page?.text??'',/صفحة 1\/2/u);
   let next=page;
   for(let i=0;i<8;i++)next=await f.editor.handle(OWNER,button(next,'-100'+String(124+i)));
   assert.match(next?.text??'',/المختارة: 8/u);
   const preview=await f.editor.handle(OWNER,button(next,'معاينة'));
   assert.match(preview?.text??'',/8/u);
   assert.ok(await f.editor.handle(OWNER,button(preview,'تأكيد')));
   const s=await f.store.snapshot();
   assert.equal(s.networkInheritance!.filter(x=>x.status==='PAUSED').length,8);
   assert.equal(s.networkInheritance!.filter(x=>x.status==='ACTIVE').length,2);
   const page2=await f.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   assert.match(page2?.text??'',/صفحة 1\/1/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 stale selection cannot target changed groups after editing ledger',async()=>{
  const f=await fixture();try{
   const start=await f.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   const pick=button(start,targets[0]!);
   await f.store.transaction(s=>{s.networkInheritance![0]!.status='PAUSED';
    s.networkInheritance![0]!.pausedReason='OWNER_PAUSED';});
   assert.equal(await f.editor.handle(OWNER,pick),null);
   const fresh=await f.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   const selected=await f.editor.handle(OWNER,button(fresh,targets[1]!));
   const preview=await f.editor.handle(OWNER,button(selected,'معاينة'));
   await f.store.transaction(s=>{s.networkInheritance![1]!.status='PAUSED';
    s.networkInheritance![1]!.pausedReason='OWNER_PAUSED';});
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 private owner dashboard revoked and emergency STOP fail closed',async()=>{
  const f=await fixture();try{
   const start=await f.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   assert.equal(await f.editor.handle('200',button(start,targets[0]!)),null);
   const selected=await f.editor.handle(OWNER,button(start,targets[0]!));
   const preview=await f.editor.handle(OWNER,button(selected,'معاينة'));
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await f.close();}
  const g=await fixture();try{
   const start=await g.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   const selected=await g.editor.handle(OWNER,button(start,targets[0]!));
   const preview=await g.editor.handle(OWNER,button(selected,'معاينة'));
   await g.store.transaction(s=>{
    s.networkEmergencyControls=[{networkId:NET,revision:1,status:'STOPPED',changedAt:NOW,changedBy:OWNER}];
    for(const row of s.networkInheritance!){row.status='PAUSED';row.pausedReason='NETWORK_EMERGENCY';}
   });
   assert.equal(await g.editor.handle(OWNER,button(preview,'تأكيد')),null);
  }finally{await g.close();}
 });
 test(engine+' NETWORK-004 cancel, expiry and concurrent confirm safely guard selected pause',async()=>{
  const f=await fixture();try{
   const start=await f.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   const selected=await f.editor.handle(OWNER,button(start,targets[0]!));
   const preview=await f.editor.handle(OWNER,button(selected,'معاينة'));
   assert.ok(await f.editor.handle(OWNER,button(preview,'إلغاء')));
   assert.equal(await f.editor.handle(OWNER,button(preview,'تأكيد')),null);
   assert.equal((await f.store.snapshot()).networkInheritance!.filter(x=>x.status==='ACTIVE').length,3);
  }finally{await f.close();}
  const g=await fixture();try{
   const s=await g.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   const pick=await g.editor.handle(OWNER,button(s,targets[0]!));
   const pre=await g.editor.handle(OWNER,button(pick,'معاينة'));
   g.advance(121_000);
   assert.equal(await g.editor.handle(OWNER,button(pre,'تأكيد')),null);
  }finally{await g.close();}
  const h=await fixture();try{
   const s=await h.editor.handle(OWNER,'nw:1:bl:'+NET+':0');
   const pick=await h.editor.handle(OWNER,button(s,targets[0]!));
   const pre=await h.editor.handle(OWNER,button(pick,'معاينة'));
   const conf=button(pre,'تأكيد');
   const outcomes=await Promise.all([h.editor.handle(OWNER,conf),h.editor.handle(OWNER,conf)]);
   assert.equal(outcomes.filter(Boolean).length,1);
   assert.equal((await h.store.snapshot()).networkInheritance!.filter(x=>x.status==='PAUSED').length,1);
  }finally{await h.close();}
 });
 test(engine+' NETWORK-004 engine rejects cross-network ids and duplicate selections atomically',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{
    s.groupNetworks![1]!.members=[{chatId:'-100127',version:1}];
    s.networkInheritance!.push({
     id:'bbbbbbbbbbbb',kind:'POLICY',networkId:OTHER,networkRevision:1,
     sourceChatId:SOURCE,sourceChatVersion:1,sourceRevision:1,
     targetChatId:'-100127',targetChatVersion:1,targetRevision:1,
     targetDigest:'b'.repeat(64),createdAt:NOW-100,lastSyncedAt:NOW-50,
     status:'ACTIVE'
    });
   });
   const s=await f.store.snapshot();
   assert.equal(pauseSelectedNetworkPolicyLinks(s,f.policy,OWNER,NOW,NET,
    ['000000000001','bbbbbbbbbbbb']),null);
   assert.equal(pauseSelectedNetworkPolicyLinks(s,f.policy,OWNER,NOW,NET,
    ['000000000001','000000000001']),null);
   assert.equal(s.networkInheritance!.filter(x=>x.status==='ACTIVE').length,4);
  }finally{await f.close();}
 });
}
