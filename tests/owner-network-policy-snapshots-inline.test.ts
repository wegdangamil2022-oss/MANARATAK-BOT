import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {isValidNetworkPolicySnapshots,captureNetworkPolicySnapshot,
  previewNetworkPolicySnapshot,inspectSavedNetworkPolicy}
 from '../src/network-policy-snapshots.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NET='abcdef123456',OTHER='bbbbbb123456',
 NOW=1_700_000_000_000,A='-100124',B='-100125',OUT='-100199';
function press(screen:OwnerInlineScreen|null,label:string):string{
 assert.ok(screen,'expected screen for '+label);
 const button=screen.keyboard.inline_keyboard.flat().find(b=>b.text.includes(label));
 assert.ok(button,'expected button "'+label+'" in '+screen.text);
 assert.ok(Buffer.byteLength(button.callback_data,'utf8')<=64);
 return button.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'network-policy-snapshots-'));
  const path=join(dir,'state.'+engine),store=new BotStore(path,{engine});
  let now=NOW;
  const policy=new Policy(store,OWNER,()=>now);
  for(const id of [A,B,OUT])await policy.approveChat(OWNER,id,['moderation','assistant']);
  await store.transaction(s=>{
   s.groupNetworks=[
    {id:NET,name:'شبكة النسخ',revision:1,createdBy:OWNER,updatedAt:now,
     members:[A,B].map(chatId=>({chatId,version:1}))},
    {id:OTHER,name:'شبكة أخرى',revision:1,createdBy:OWNER,updatedAt:now,
     members:[{chatId:OUT,version:1}]}];
   s.protectionPolicies=[A,B,OUT].map(chatId=>({
    policy:{chatId,revision:1,mode:'MONITOR' as const,
     rules:[{id:'r1',kind:'WORD' as const,value:'sensitivealpha',enabled:true,action:'WARN' as const}],
     allowedDomains:['private.example.org'],allowedPhrases:['secret phrase'],exemptMemberIds:['200']},
    chatPolicyVersion:1,updatedBy:OWNER,updatedAt:now-200
   }));
  });
  return {store,policy,editor:new OwnerNetworkEditor(store,policy,()=>now),
   reopen:()=>new OwnerNetworkEditor(new BotStore(path,{engine}),policy,()=>now),
   clock:()=>now,advance:(ms:number)=>now+=ms,
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-005 snapshot owner preview and one-shot confirm stores exact policy without modifying live settings',async()=>{
  const f=await fixture();try{
   const before=await f.store.snapshot();
   const card=await f.editor.handle(OWNER,'nw:1:d:'+NET);
   const home=await f.editor.handle(OWNER,press(card,'نسخ السياسات'));
   const pick=await f.editor.handle(OWNER,press(home,'حفظ نسخة'));
   const preview=await f.editor.handle(OWNER,press(pick,A));
   assert.match(preview?.text??'',/معاينة/u);
   assert.doesNotMatch(preview?.text??'',/sensitivealpha|private\.example\.org|secret phrase/u);
   const confirm=press(preview,'تأكيد');
   assert.equal(await f.editor.handle('201',confirm),null);
   const done=await f.editor.handle(OWNER,confirm);
   assert.match(done?.text??'',/تم حفظ/u);
   assert.equal(await f.editor.handle(OWNER,confirm),null);
   const after=await f.store.snapshot();
   assert.equal(after.networkPolicySnapshots?.length,1);
   assert.deepEqual(after.protectionPolicies,before.protectionPolicies);
   assert.deepEqual(after.chats,before.chats);
   assert.deepEqual(after.groupNetworks,before.groupNetworks);
   assert.deepEqual(after.networkInheritance,before.networkInheritance);
   assert.equal(after.networkPolicySnapshots![0]!.policy.rules[0]?.kind,'WORD');
   assert.ok(after.audit.some(x=>x.reason==='OWNER_NETWORK_POLICY_SNAPSHOT_CAPTURED'));
   assert.equal(after.moderationOperations.length,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 snapshot history compares current to captured content and detects same-count rule changes privately',async()=>{
  const f=await fixture();try{
   const pick=await f.editor.handle(OWNER,'nw:1:hp:'+NET+':0');
   const pre=await f.editor.handle(OWNER,press(pick,A));
   await f.editor.handle(OWNER,press(pre,'تأكيد'));
   const hist=await f.reopen().handle(OWNER,'nw:1:hl:'+NET+':0');
   assert.match(hist?.text??'',/1/u);
   const detail=await f.reopen().handle(OWNER,press(hist,'نسخة'));
   assert.match(detail?.text??'',/متطابقة/u);
   await f.store.transaction(s=>{
    const row=s.protectionPolicies!.find(x=>x.policy.chatId===A)!;
    row.policy.rules[0]!.value='sensitivebeta';
    row.policy.revision++;
   });
   const changed=await f.reopen().handle(OWNER,press(hist,'نسخة'));
   assert.match(changed?.text??'',/قواعد الحماية/u);
   assert.doesNotMatch(changed?.text??'',/sensitivealpha|sensitivebeta/u);
   const state=await f.store.snapshot();
   assert.equal(state.networkPolicySnapshots?.[0]?.policy.rules[0]?.value,'sensitivealpha');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 snapshot rejects stale chat version and changed config before consent atomically',async()=>{
  const f=await fixture();try{
   const preview=await f.editor.handle(OWNER,'nw:1:hv:'+NET+':'+A);
   const token=press(preview,'تأكيد');
   await f.store.transaction(s=>{s.protectionPolicies![0]!.policy.revision++;});
   assert.equal(await f.editor.handle(OWNER,token),null);
   assert.equal((await f.store.snapshot()).networkPolicySnapshots?.length??0,0);
   const next=await f.editor.handle(OWNER,'nw:1:hv:'+NET+':'+A);
   const token2=press(next,'تأكيد');
   await f.store.transaction(s=>{s.chats.find(x=>x.id===A)!.version++;});
   assert.equal(await f.editor.handle(OWNER,token2),null);
   assert.equal((await f.store.snapshot()).networkPolicySnapshots?.length??0,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 snapshot expiry cancellation replay and simultaneous consent are safe',async()=>{
  const f=await fixture();try{
   const prev=await f.editor.handle(OWNER,'nw:1:hv:'+NET+':'+A);
   assert.ok(await f.editor.handle(OWNER,press(prev,'إلغاء')));
   assert.equal(await f.editor.handle(OWNER,press(prev,'تأكيد')),null);
   const prev2=await f.editor.handle(OWNER,'nw:1:hv:'+NET+':'+A);
   f.advance(121_000);
   assert.equal(await f.editor.handle(OWNER,press(prev2,'تأكيد')),null);
   const prev3=await f.editor.handle(OWNER,'nw:1:hv:'+NET+':'+A);
   const confirm=press(prev3,'تأكيد');
   const results=await Promise.all([f.editor.handle(OWNER,confirm),f.editor.handle(OWNER,confirm)]);
   assert.equal(results.filter(Boolean).length,1);
   assert.equal((await f.store.snapshot()).networkPolicySnapshots?.length,1);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 snapshot owner and private context fail closed across networks and revoked dashboard',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:ha:'+NET),true);
   assert.equal(validOwnerNetworkRoute('nw:1:hv:'+NET+':'+A),true);
   assert.equal(validOwnerNetworkRoute('nw:1:hv:INVALID:'+A),false);
   assert.equal(await f.editor.handle('201','nw:1:hv:'+NET+':'+A),null);
   assert.equal(await f.editor.handle(OWNER,'nw:1:hv:'+OTHER+':'+A),null);
   const preview=await f.editor.handle(OWNER,'nw:1:hv:'+NET+':'+A);
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.editor.handle(OWNER,press(preview,'تأكيد')),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 snapshot library is bounded and rejects duplicates or corrupted digests',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot();
   const first=previewNetworkPolicySnapshot(s,f.policy,OWNER,NOW,NET,A);
   assert.ok(first);
   assert.equal(previewNetworkPolicySnapshot(s,f.policy,'201',NOW,NET,A),null);
   assert.equal(previewNetworkPolicySnapshot(s,f.policy,OWNER,NOW,OTHER,A),null);
   assert.ok(captureNetworkPolicySnapshot(s,f.policy,OWNER,NOW,NET,A,'111111111111'));
   assert.equal(captureNetworkPolicySnapshot(s,f.policy,OWNER,NOW,NET,A,'111111111111'),null);
   assert.equal(isValidNetworkPolicySnapshots(s.networkPolicySnapshots),true);
   s.networkPolicySnapshots![0]!.digest='f'.repeat(64);
   assert.equal(isValidNetworkPolicySnapshots(s.networkPolicySnapshots),false);
   assert.equal(inspectSavedNetworkPolicy(s,f.policy,OWNER,NOW,'111111111111'),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 snapshots remain readable during emergency STOP but never restore policy',async()=>{
  const f=await fixture();try{
   const preview=await f.editor.handle(OWNER,'nw:1:hv:'+NET+':'+A);
   await f.editor.handle(OWNER,press(preview,'تأكيد'));
   await f.store.transaction(s=>{
    s.networkEmergencyControls=[{networkId:NET,revision:1,status:'STOPPED',changedAt:NOW,changedBy:OWNER}];
   });
   const list=await f.editor.handle(OWNER,'nw:1:hl:'+NET+':0');
   const detail=await f.editor.handle(OWNER,press(list,'نسخة'));
   assert.match(detail?.text??'',/طوارئ/u);
   assert.doesNotMatch(detail?.text??'',/استرجاع السياسة الآن/u);
   assert.equal((await f.store.snapshot()).protectionPolicies?.[0]?.policy.mode,'MONITOR');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 rejects corrupt and duplicate policies, no partial archive writes',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot();
   s.protectionPolicies!.push(structuredClone(s.protectionPolicies![0]!));
   assert.equal(previewNetworkPolicySnapshot(s,f.policy,OWNER,NOW,NET,A),null);
   assert.equal(captureNetworkPolicySnapshot(s,f.policy,OWNER,NOW,NET,A,'123456789abc'),null);
   s.protectionPolicies!.pop();
   s.protectionPolicies![0]!.chatPolicyVersion++;
   assert.equal(previewNetworkPolicySnapshot(s,f.policy,OWNER,NOW,NET,A),null);
  }finally{await f.close();}
 });
}
