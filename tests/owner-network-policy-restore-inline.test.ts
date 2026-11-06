import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {captureNetworkPolicySnapshot,inspectSavedNetworkPolicy} from '../src/network-policy-snapshots.js';
import {previewNetworkPolicyRestore,applyNetworkPolicyRestore} from '../src/network-policy-restore.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const OWNER='100',NOW=1_700_000_000_000,N='abcdef123456',OTHER='bbbbbb123456',
 A='-100124',B='-100125',OUT='-100199',ID='111111111111';
const rule=(value:string)=>({id:'r1',kind:'WORD' as const,value,enabled:true,action:'WARN' as const});
function click(s:OwnerInlineScreen|null,needle:string):string{
 assert.ok(s,'missing screen for '+needle);
 const b=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(needle));
 assert.ok(b,'missing button '+needle+' in '+s.text);
 assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64);
 return b.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'phase3-network-restore-')),
   filename=join(dir,'state.'+engine),store=new BotStore(filename,{engine});
  let now=NOW;
  const policy=new Policy(store,OWNER,()=>now);
  for(const chat of [A,B,OUT])await policy.approveChat(OWNER,chat,['navigation','moderation','assistant']);
  await store.transaction(s=>{
   s.groupNetworks=[
    {id:N,name:'شبكة الاسترجاع',revision:1,createdBy:OWNER,updatedAt:now,
     members:[A,B].map(chatId=>({chatId,version:1}))},
    {id:OTHER,name:'شبكة أخرى',revision:1,createdBy:OWNER,updatedAt:now,
     members:[{chatId:OUT,version:1}]}];
   s.protectionPolicies=[A,B,OUT].map(chatId=>({
    policy:{chatId,revision:1,mode:'MONITOR' as const,
     rules:[rule('secretalpha')],allowedDomains:['private.example.org'],
     allowedPhrases:['hidden phrase'],exemptMemberIds:['200']},
    chatPolicyVersion:1,updatedBy:OWNER,updatedAt:now-500
   }));
   s.networkInheritance=[{
    id:'222222222222',kind:'POLICY',networkId:N,networkRevision:1,
    sourceChatId:B,sourceChatVersion:1,sourceRevision:1,
    targetChatId:A,targetChatVersion:1,targetRevision:1,
    targetDigest:'a'.repeat(64),createdAt:now-300,lastSyncedAt:now-200,
    status:'ACTIVE'
   }];
   assert.ok(captureNetworkPolicySnapshot(s,policy,OWNER,now,N,A,ID));
   s.protectionPolicies![0]!.policy={
    ...s.protectionPolicies![0]!.policy,revision:2,
    rules:[rule('secretbeta')],allowedDomains:['different.example.org']};
  });
  return {store,policy,editor:new OwnerNetworkEditor(store,policy,()=>now),
   reopen:()=>new OwnerNetworkEditor(new BotStore(filename,{engine}),policy,()=>now),
   advance:(time:number)=>now+=time,clock:()=>now,
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-005 restore selected historical rules with one-shot owner consent, preserve mode, pause dependent follows',async()=>{
  const f=await fixture();try{
   const history=await f.editor.handle(OWNER,'nw:1:hl:'+N+':0');
   const detail=await f.editor.handle(OWNER,click(history,'نسخة'));
   const pre=await f.editor.handle(OWNER,click(detail,'معاينة استرجاع'));
   assert.match(pre?.text??'',/المرجع/u);
   assert.match(pre?.text??'',/قواعد/u);
   assert.doesNotMatch(pre?.text??'',/secretalpha|secretbeta|private\.example\.org|different\.example\.org/u);
   const c=click(pre,'تأكيد استرجاع');
   assert.equal(await f.editor.handle('201',c),null);
   const done=await f.reopen().handle(OWNER,c);
   assert.match(done?.text??'',/استرجاع/u);
   assert.equal(await f.editor.handle(OWNER,c),null);
   const s=await f.store.snapshot(),p=s.protectionPolicies!.find(x=>x.policy.chatId===A)!;
   assert.equal(p.policy.mode,'MONITOR');
   assert.equal(p.policy.rules[0]?.kind,'WORD');
   assert.equal(p.policy.rules[0]&&'value' in p.policy.rules[0]?p.policy.rules[0].value:null,'secretalpha');
   assert.deepEqual(p.policy.allowedDomains,['private.example.org']);
   assert.equal(p.policy.revision,3);
   assert.equal(p.chatPolicyVersion,1);
   assert.equal(s.networkPolicySnapshots?.[0]?.policy.revision,1);
   assert.deepEqual(s.networkInheritance?.map(x=>x.status),['PAUSED']);
   assert.deepEqual(s.networkInheritance?.map(x=>x.pausedReason),['LOCAL_OVERRIDE']);
   assert.equal(s.moderationOperations.length,0);
   assert.equal(s.operations.length,0);
   assert.ok(s.audit.some(x=>x.reason==='OWNER_NETWORK_POLICY_SNAPSHOT_RESTORED'));
   assert.equal(inspectSavedNetworkPolicy(s,f.policy,OWNER,f.clock(),ID)?.equivalent,true);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 restores archived source settings while pausing its local downstream link',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{
    s.networkInheritance=[{
     id:'222222222222',kind:'POLICY',networkId:N,networkRevision:1,
     sourceChatId:A,sourceChatVersion:1,sourceRevision:1,
     targetChatId:B,targetChatVersion:1,targetRevision:1,
     targetDigest:'a'.repeat(64),createdAt:NOW-300,lastSyncedAt:NOW-200,
     status:'ACTIVE'
    }];
   });
   const before=await f.store.snapshot();
   const screen=await f.editor.handle(OWNER,'nw:1:rr:'+ID);
   assert.match(screen?.text??'',/روابط توريث/u);
   assert.ok(await f.editor.handle(OWNER,click(screen,'تأكيد استرجاع')));
   const after=await f.store.snapshot();
   assert.equal(after.networkInheritance?.[0]?.status,'PAUSED');
   assert.equal(after.networkInheritance?.[0]?.pausedReason,'SOURCE_STALE');
   assert.deepEqual(after.protectionPolicies?.find(x=>x.policy.chatId===B),
    before.protectionPolicies?.find(x=>x.policy.chatId===B));
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 restoration never enables OFF monitoring, even if the archived mode was MONITOR',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{s.protectionPolicies![0]!.policy.mode='OFF';});
   const p=await f.editor.handle(OWNER,'nw:1:rr:'+ID);
   assert.match(p?.text??'',/OFF/u);
   const done=await f.editor.handle(OWNER,click(p,'تأكيد استرجاع'));
   assert.match(done?.text??'',/OFF/u);
   const s=await f.store.snapshot();
   assert.equal(s.protectionPolicies![0]!.policy.mode,'OFF');
   assert.equal(s.protectionPolicies![0]!.policy.rules[0]&&
    'value' in s.protectionPolicies![0]!.policy.rules[0]!
    ?s.protectionPolicies![0]!.policy.rules[0]!.value:null,'secretalpha');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 denies any archived ENFORCE or currently ENFORCE policy restoration',async()=>{
  const f=await fixture();try{
   let s=await f.store.snapshot();
   s.networkPolicySnapshots![0]!.policy.mode='ENFORCE';
   assert.equal(previewNetworkPolicyRestore(s,f.policy,OWNER,NOW,ID),null);
   assert.equal(applyNetworkPolicyRestore(s,f.policy,OWNER,NOW,ID),null);
   await f.store.transaction(x=>{x.protectionPolicies![0]!.policy.mode='ENFORCE';});
   assert.equal(await f.editor.handle(OWNER,'nw:1:rr:'+ID),null);
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.mode,'ENFORCE');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 restores only same network and approval epoch, rejects stale, missing and tampered snapshots',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot();
   assert.equal(previewNetworkPolicyRestore(s,f.policy,'201',NOW,ID),null);
   assert.equal(previewNetworkPolicyRestore(s,f.policy,OWNER,NOW,OTHER),null);
   s.networkPolicySnapshots![0]!.digest='f'.repeat(64);
   assert.equal(previewNetworkPolicyRestore(s,f.policy,OWNER,NOW,ID),null);
   s.networkPolicySnapshots!.pop();
   assert.equal(previewNetworkPolicyRestore(s,f.policy,OWNER,NOW,ID),null);
   await f.store.transaction(x=>{x.groupNetworks![0]!.revision++;});
   assert.equal(await f.editor.handle(OWNER,'nw:1:rr:'+ID),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 restore confirmation cancels, expires, rejects replay and concurrent clicks',async()=>{
  const f=await fixture();try{
   const pre=await f.editor.handle(OWNER,'nw:1:rr:'+ID);
   assert.ok(await f.editor.handle(OWNER,click(pre,'إلغاء')));
   assert.equal(await f.editor.handle(OWNER,click(pre,'تأكيد')),null);
   const next=await f.editor.handle(OWNER,'nw:1:rr:'+ID);
   f.advance(121_000);
   assert.equal(await f.editor.handle(OWNER,click(next,'تأكيد')),null);
   const third=await f.editor.handle(OWNER,'nw:1:rr:'+ID);
   const token=click(third,'تأكيد');
   const results=await Promise.all([f.editor.handle(OWNER,token),f.editor.handle(OWNER,token)]);
   assert.equal(results.filter(Boolean).length,1);
   const s=await f.store.snapshot();
   assert.equal(s.protectionPolicies![0]!.policy.revision,3);
   assert.equal(s.audit.filter(x=>x.reason==='OWNER_NETWORK_POLICY_SNAPSHOT_RESTORED').length,1);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 restore proof freezes all policies, dependencies and dashboard authorization',async()=>{
  const f=await fixture();try{
   const pre=await f.editor.handle(OWNER,'nw:1:rr:'+ID);
   await f.store.transaction(s=>{s.protectionPolicies![1]!.policy.revision++;});
   assert.equal(await f.editor.handle(OWNER,click(pre,'تأكيد')),null);
   assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.revision,2);
  }finally{await f.close();}
  const f2=await fixture();try{
   const pre=await f2.editor.handle(OWNER,'nw:1:rr:'+ID);
   await f2.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f2.editor.handle(OWNER,click(pre,'تأكيد')),null);
  }finally{await f2.close();}
  const f3=await fixture();try{
   const pre=await f3.editor.handle(OWNER,'nw:1:rr:'+ID);
   await f3.store.transaction(s=>{
    s.networkEmergencyControls=[{networkId:N,revision:1,status:'STOPPED',changedAt:NOW,changedBy:OWNER}];
   });
   assert.equal(await f3.editor.handle(OWNER,click(pre,'تأكيد')),null);
   assert.equal((await f3.store.snapshot()).protectionPolicies![0]!.policy.revision,2);
  }finally{await f3.close();}
 });
 test(engine+' NETWORK-005 restore UI requires owner and private Telegram route; no restoration with no differences',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:rr:'+ID),true);
   assert.equal(validOwnerNetworkRoute('nw:1:rc:'+'a'.repeat(24)),true);
   assert.equal(validOwnerNetworkRoute('nw:1:rx:'+'a'.repeat(24)),true);
   assert.equal(validOwnerNetworkRoute('nw:1:rr:INVALID'),false);
   assert.equal(await f.editor.handle('201','nw:1:rr:'+ID),null);
   assert.equal(await f.editor.handle(OWNER,'nw:1:rr:'+'f'.repeat(12)),null);
   const s=await f.store.snapshot();
   s.protectionPolicies![0]!.policy={
    ...structuredClone(s.networkPolicySnapshots![0]!.policy),revision:2};
   assert.equal(previewNetworkPolicyRestore(s,f.policy,OWNER,NOW,ID),null);
  }finally{await f.close();}
 });
}
