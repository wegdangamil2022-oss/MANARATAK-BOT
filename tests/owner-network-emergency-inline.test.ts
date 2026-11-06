import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {networkEmergencyStopped,validNetworkEmergencyControls} from '../src/network-emergency-stop.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',SOURCE='-100123',
 TARGET1='-100124',TARGET2='-100125',OTHER='eeeeee123456';
const btn=(s:OwnerInlineScreen|null,label:string):string=>{
 assert.ok(s,'missing screen for '+label);
 const item=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(label));
 assert.ok(item,label+' in '+s.text);
 assert.ok(Buffer.byteLength(item.callback_data,'utf8')<=64);
 return item.callback_data;
};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'network-emergency-'));
  let now=NOW;
  const store=new BotStore(join(dir,'state.'+engine),{engine});
  const policy=new Policy(store,OWNER,()=>now);
  for(const chatId of [SOURCE,TARGET1,TARGET2])
   await policy.approveChat(OWNER,chatId,['moderation','navigation']);
  const owner=new OwnerNetworkEditor(store,policy,()=>now);
  await store.transaction(s=>{
   s.groupNetworks=[{id:NET,name:'شبكة مراقبة',revision:1,createdBy:OWNER,updatedAt:now,
    members:s.chats.map(c=>({chatId:c.id,version:c.version}))},
    {id:OTHER,name:'شبكة أخرى',revision:1,createdBy:OWNER,updatedAt:now,
     members:[]}];
   s.networkInheritance=[TARGET1,TARGET2].map((id,i)=>({
    id:'00000000000'+(i+1),kind:'POLICY' as const,networkId:NET,
    networkRevision:1,sourceChatId:SOURCE,sourceChatVersion:1,sourceRevision:1,
    targetChatId:id,targetChatVersion:1,targetRevision:1,
    targetDigest:'a'.repeat(64),createdAt:now-200,lastSyncedAt:now-150,
    status:'ACTIVE' as const
   }));
  });
  return {store,policy,owner,advance:(delta:number)=>now+=delta,
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-004 stop requires scope preview and one-shot consent; pauses links atomically',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:eh:'+NET),true);
   assert.equal(validOwnerNetworkRoute('nw:1:es:'+NET),true);
   assert.equal(validOwnerNetworkRoute('nw:1:er:'+NET),true);
   assert.equal(validOwnerNetworkRoute('nw:1:eh:INVALID'),false);
   const card=await f.owner.handle(OWNER,'nw:1:d:'+NET);
   const emergency=await f.owner.handle(OWNER,btn(card,'طوارئ الشبكة'));
   const preview=await f.owner.handle(OWNER,btn(emergency,'إيقاف طارئ'));
   assert.match(preview?.text??'',/معاينة/u);
   assert.match(preview?.text??'',/2/u);
   assert.equal((await f.store.snapshot()).networkInheritance?.filter(x=>x.status==='ACTIVE').length,2);
   const confirm=btn(preview,'تأكيد');
   assert.equal(await f.owner.handle('200',confirm),null);
   const outcome=await f.owner.handle(OWNER,confirm);
   assert.match(outcome?.text??'',/أُوقف|الإيقاف/u);
   assert.equal(await f.owner.handle(OWNER,confirm),null);
   const s=await f.store.snapshot();
   assert.equal(s.networkInheritance?.filter(x=>x.status==='ACTIVE').length,0);
   assert.equal(s.networkInheritance?.filter(x=>x.pausedReason==='NETWORK_EMERGENCY').length,2);
   assert.equal(s.networkEmergencyControls?.[0]?.status,'STOPPED');
   assert.equal(networkEmergencyStopped(s,NET),true);
   assert.equal(networkEmergencyStopped(s,OTHER),false);
   assert.equal(s.moderationOperations.length,0);
   assert.equal(s.moderationReasons.length,0);
   assert.equal(s.operations.length,0);
   assert.ok(s.audit.some(x=>x.reason==='OWNER_NETWORK_EMERGENCY_STOPPED'));
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 lifting emergency gate is distinct consent; never auto resumes links',async()=>{
  const f=await fixture();try{
   const preview=await f.owner.handle(OWNER,'nw:1:es:'+NET);
   await f.owner.handle(OWNER,btn(preview,'تأكيد'));
   const screen=await f.owner.handle(OWNER,'nw:1:eh:'+NET);
   assert.match(screen?.text??'',/الإيقاف|متوقفة/u);
   const resume=await f.owner.handle(OWNER,btn(screen,'رفع الإيقاف'));
   assert.match(resume?.text??'',/معاينة/u);
   const approved=await f.owner.handle(OWNER,btn(resume,'تأكيد'));
   assert.match(approved?.text??'',/رُفع|رفع/u);
   const s=await f.store.snapshot();
   assert.equal(s.networkEmergencyControls?.[0]?.status,'RESUMED');
   assert.equal(s.networkEmergencyControls?.[0]?.revision,2);
   assert.equal(networkEmergencyStopped(s,NET),false);
   assert.equal(s.networkInheritance?.filter(x=>x.status==='ACTIVE').length,0);
   assert.ok(s.audit.some(x=>x.reason==='OWNER_NETWORK_EMERGENCY_RESUMED'));
   assert.equal(await f.owner.handle(OWNER,btn(resume,'تأكيد')),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 version drift and revoked dashboard invalidate pending STOP',async()=>{
  const f=await fixture();try{
   const preview=await f.owner.handle(OWNER,'nw:1:es:'+NET);
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal(await f.owner.handle(OWNER,btn(preview,'تأكيد')),null);
   assert.equal((await f.store.snapshot()).networkEmergencyControls?.length??0,0);
  }finally{await f.close();}
  const g=await fixture();try{
   const preview=await g.owner.handle(OWNER,'nw:1:es:'+NET);
   await g.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await g.owner.handle(OWNER,btn(preview,'تأكيد')),null);
   assert.equal((await g.store.snapshot()).networkEmergencyControls?.length??0,0);
  }finally{await g.close();}
 });
 test(engine+' NETWORK-004 expiry and duplicate concurrency are safe',async()=>{
  const f=await fixture();try{
   const preview=await f.owner.handle(OWNER,'nw:1:es:'+NET);
   f.advance(121_000);
   assert.equal(await f.owner.handle(OWNER,btn(preview,'تأكيد')),null);
   assert.equal((await f.store.snapshot()).networkEmergencyControls?.length??0,0);
  }finally{await f.close();}
  const g=await fixture();try{
   const preview=await g.owner.handle(OWNER,'nw:1:es:'+NET);
   const confirm=btn(preview,'تأكيد');
   const answers=await Promise.all([g.owner.handle(OWNER,confirm),g.owner.handle(OWNER,confirm)]);
   assert.equal(answers.filter(Boolean).length,1);
   assert.equal((await g.store.snapshot()).networkEmergencyControls?.length,1);
  }finally{await g.close();}
 });
 test(engine+' NETWORK-004 STOP with zero active links blocks future inheritances',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{s.networkInheritance=[];});
   const preview=await f.owner.handle(OWNER,'nw:1:es:'+NET);
   assert.ok(preview);
   assert.ok(await f.owner.handle(OWNER,btn(preview,'تأكيد')));
   const s=await f.store.snapshot();
   assert.equal(networkEmergencyStopped(s,NET),true);
   assert.equal(s.networkInheritance?.length,0);
   assert.equal(await f.owner.handle(OWNER,'nw:1:es:'+NET),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-004 persisted emergency controls reject corrupted and duplicate snapshots',async()=>{
  const f=await fixture();try{
   assert.equal(validNetworkEmergencyControls([]),true);
   assert.equal(validNetworkEmergencyControls([{networkId:NET,revision:1,
    status:'STOPPED',changedAt:NOW,changedBy:OWNER}]),true);
   assert.equal(validNetworkEmergencyControls([{networkId:NET,revision:1,
    status:'STOPPED',changedAt:NOW,changedBy:OWNER,extra:'x'}]),false);
   const preview=await f.owner.handle(OWNER,'nw:1:es:'+NET);
   await f.owner.handle(OWNER,btn(preview,'تأكيد'));
   const snap=await f.store.snapshot();
   assert.equal(snap.networkEmergencyControls?.[0]?.status,'STOPPED');
   await assert.rejects(()=>f.store.transaction(s=>{
    s.networkEmergencyControls?.push({...s.networkEmergencyControls[0]!});
   }));
   assert.equal((await f.store.snapshot()).networkEmergencyControls?.length,1);
   await assert.rejects(()=>f.store.transaction(s=>{
    s.networkInheritance![0]!.status='ACTIVE';
    delete s.networkInheritance![0]!.pausedReason;
   }));
   assert.equal((await f.store.snapshot()).networkInheritance?.[0]?.status,'PAUSED');
  }finally{await f.close();}
 });
}
