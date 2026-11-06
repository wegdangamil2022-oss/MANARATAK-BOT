import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {prepareNetworkInheritance,pauseNetworkInheritanceByOwner} from '../src/network-inheritance.js';
import {validNetworkInheritanceLinks} from '../src/network-inheritance-model.js';
const NOW=1700000000000,OWNER='100',NETWORK='abcdef123456';
const SOURCE='-100123',A='-100124',B='-100125';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'phase3-network-inheritance-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW;const policy=new Policy(store,OWNER,()=>now);
  const protections=new GroupProtectionPolicyService(store,policy,()=>now);
  for(const chat of [SOURCE,A,B])await policy.approveChat(OWNER,chat,['navigation','moderation']);
  await store.transaction(s=>{s.groupNetworks=[{id:NETWORK,name:'شبكة المراجعة',revision:1,createdBy:OWNER,updatedAt:now,
   members:s.chats.filter(c=>[SOURCE,A,B].includes(c.id)).map(c=>({chatId:c.id,version:c.version}))}];});
  const save=async(chat:string,revision:number,text='rule-'+revision,mode='MONITOR' as 'MONITOR'|'OFF')=>{
   const s=await store.snapshot(),current=s.chats.find(c=>c.id===chat)!;
   return protections.save(OWNER,{chatId:chat,revision,mode,
    rules:[{id:'r1',kind:'PHRASE',value:text,enabled:true,action:'REVIEW'}],
    allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},
    current.version,revision-1);
  };
  const follow=async(chat=A)=>{
   const state=await store.snapshot(),net=state.groupNetworks![0]!,source=state.protectionPolicies!.find(x=>x.policy.chatId===SOURCE)!;
   assert.ok(source);
   const targetPolicy={...structuredClone(source.policy),chatId:chat,revision:1};
   const targetVersion=state.chats.find(x=>x.id===chat)!.version;
   const record={policy:targetPolicy,chatPolicyVersion:targetVersion,updatedBy:OWNER,updatedAt:now};
   await store.transaction(s=>{s.protectionPolicies??=[];s.protectionPolicies.push(record);
    const link=prepareNetworkInheritance(s,policy,OWNER,now,'POLICY',net,SOURCE,chat,source.policy.revision,targetPolicy);
    assert.ok(link);
    s.networkInheritance??=[];s.networkInheritance.push(link);});
  };
  return {store,policy,protections,save,follow,advance:(t:number)=>{now+=t;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' opted-in network monitor policy follows source revision but cannot activate unreviewed enforcement',async()=>{const f=await fixture();try{
  assert.equal((await f.save(SOURCE,1)).status,'SAVED');await f.follow(A);await f.follow(B);
  assert.equal((await f.save(SOURCE,2,'new source phrase')).status,'SAVED');
  const s=await f.store.snapshot();
  assert.equal(s.networkInheritance?.length,2);
  assert.ok(s.networkInheritance?.every(l=>l.kind==='POLICY'&&l.status==='ACTIVE'&&l.targetRevision===2));
  for(const chat of [A,B]){
   const p=s.protectionPolicies?.find(r=>r.policy.chatId===chat)?.policy;
   assert.equal(p?.revision,2);assert.equal(p?.mode,'MONITOR');
   assert.equal((p?.rules[0] as {value?:string})?.value,'new source phrase');
   assert.deepEqual(p?.allowedDomains,[]);
   assert.deepEqual(p?.exemptMemberIds,[]);
  }
  assert.equal(validNetworkInheritanceLinks(s.networkInheritance),true);
 }finally{await f.close();}});
 test(engine+' changing a local target pauses inheritance without silently overwriting local policy',async()=>{const f=await fixture();try{
  await f.save(SOURCE,1);await f.follow(A);await f.follow(B);
  assert.equal((await f.save(A,2,'owner local rule')).status,'SAVED');
  assert.equal((await f.save(SOURCE,2,'global rule')).status,'SAVED');
  const s=await f.store.snapshot();
  assert.equal(s.networkInheritance?.find(v=>v.targetChatId===A)?.status,'PAUSED');
  assert.equal(s.networkInheritance?.find(v=>v.targetChatId===A)?.pausedReason,'LOCAL_OVERRIDE');
  assert.equal((s.protectionPolicies?.find(x=>x.policy.chatId===A)?.policy.rules[0] as {value?:string})?.value,'owner local rule');
  assert.equal((s.protectionPolicies?.find(x=>x.policy.chatId===B)?.policy.rules[0] as {value?:string})?.value,'global rule');
 }finally{await f.close();}});
 test(engine+' network revision drift stops propagation and preserves target',async()=>{const f=await fixture();try{
  await f.save(SOURCE,1);await f.follow();
  await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
  await f.save(SOURCE,2,'changed rule');
  const s=await f.store.snapshot();
  assert.equal(s.networkInheritance?.[0]?.status,'PAUSED');
  assert.equal(s.protectionPolicies?.find(v=>v.policy.chatId===A)?.policy.revision,1);
 }finally{await f.close();}});
 test(engine+' an owner manually pausing one target blocks subsequent source edits',async()=>{const f=await fixture();try{
  await f.save(SOURCE,1);await f.follow();
  await f.store.transaction(s=>assert.equal(pauseNetworkInheritanceByOwner(s,s.networkInheritance![0]!.id),true));
  await f.save(SOURCE,2);
  assert.equal((await f.store.snapshot()).protectionPolicies?.find(v=>v.policy.chatId===A)?.policy.revision,1);
 }finally{await f.close();}});
 test(engine+' invalid restored network follow records never commit',async()=>{const f=await fixture();try{
  await f.save(SOURCE,1);await f.follow();
  await assert.rejects(()=>f.store.transaction(s=>{s.networkInheritance![0]!.status='ACTIVE';s.networkInheritance![0]!.pausedReason='OWNER_PAUSED';}));
  assert.equal((await f.store.snapshot()).networkInheritance?.[0]?.pausedReason,undefined);
 }finally{await f.close();}});
 test(engine+' source loss of approval refuses copy and pauses link',async()=>{const f=await fixture();try{
  await f.save(SOURCE,1);await f.follow();
  await f.policy.revokeChat(OWNER,A);
  await f.save(SOURCE,2);
  const s=await f.store.snapshot();assert.equal(s.networkInheritance?.[0]?.status,'PAUSED');
  assert.equal(s.protectionPolicies?.find(v=>v.policy.chatId===A)?.policy.revision,1);
 }finally{await f.close();}});
}
