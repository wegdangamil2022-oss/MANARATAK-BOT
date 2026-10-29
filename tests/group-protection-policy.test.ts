import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import type {ProtectionPolicy} from '../src/protection-rules.js';
const OWNER='100',CHAT='-100';
const config=(revision=1):ProtectionPolicy=>({chatId:CHAT,revision,mode:'MONITOR',rules:[{id:'spam',kind:'WORD',value:'spam',enabled:true,action:'DELETE'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'protection-policy-')),file=join(dir,'state.'+engine);
  let now=1000;
  const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>now);
  await policy.approveChat(OWNER,CHAT,['moderation']);
  const service=()=>new GroupProtectionPolicyService(new BotStore(file,{engine}),policy,()=>now);
  return {store,policy,service,setTime:(time:number)=>{now=time;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('monitor policy persists, survives reopening and previews without storing student samples ('+engine+')',async()=>{
  const f=await fixture();try{
   const epoch=f.policy.chatRevision(await f.store.snapshot(),CHAT);
   assert.equal((await f.service().save(OWNER,config(),epoch,0)).status,'SAVED');
   const inspected=await f.service().inspect(OWNER,CHAT);
   assert.equal(inspected.status,'CONFIGURED');
   const before=await f.store.snapshot();
   const result=await f.service().preview(OWNER,CHAT,{chatId:CHAT,memberId:'300',type:'TEXT',text:'spam PRIVATE_STUDENT_SAMPLE'});
   assert.equal(result.status,'EVALUATED');
   if(result.status==='EVALUATED')assert.equal(result.result.proposedAction,'DELETE');
   assert.deepEqual(await f.store.snapshot(),before);
   assert.equal(JSON.stringify(before).includes('PRIVATE_STUDENT_SAMPLE'),false);
  }finally{await f.close();}
 });
 test('unauthorized and stale writers cannot replace a policy ('+engine+')',async()=>{
  const f=await fixture();try{
   const epoch=f.policy.chatRevision(await f.store.snapshot(),CHAT);
   assert.equal((await f.service().save('200',config(),epoch,0)).status,'DENIED');
   const results=await Promise.all([f.service().save(OWNER,config(),epoch,0),f.service().save(OWNER,config(),epoch,0)]);
   assert.deepEqual(results.map(r=>r.status).sort(),['SAVED','STALE']);
   assert.equal((await f.store.snapshot()).protectionPolicies?.length,1);
  }finally{await f.close();}
 });
 test('revocation or reapproval cannot silently reactivate an old group policy ('+engine+')',async()=>{
  const f=await fixture();try{
   const epoch=f.policy.chatRevision(await f.store.snapshot(),CHAT);
   await f.service().save(OWNER,config(),epoch,0);
   await f.policy.revokeChat(OWNER,CHAT);
   assert.equal((await f.service().inspect(OWNER,CHAT)).status,'DENIED');
   await f.policy.approveChat(OWNER,CHAT,['moderation']);
   assert.equal((await f.service().inspect(OWNER,CHAT)).status,'STALE');
   assert.equal((await f.service().save(OWNER,config(2),f.policy.chatRevision(await f.store.snapshot(),CHAT),1)).status,'STALE');
  }finally{await f.close();}
 });
 test('invalid or duplicate restored policy records roll back without modifying existing state ('+engine+')',async()=>{
  const f=await fixture();try{
   const epoch=f.policy.chatRevision(await f.store.snapshot(),CHAT);
   await f.service().save(OWNER,config(),epoch,0);
   const before=await f.store.snapshot();
   await assert.rejects(f.store.transaction(s=>{s.protectionPolicies!.push(structuredClone(s.protectionPolicies![0]!));}),/Unsupported state schema/);
   assert.deepEqual(await f.store.snapshot(),before);
   await assert.rejects(f.store.transaction(s=>{s.protectionPolicies![0]!.updatedAt=Number.NaN;}),/Unsupported state schema/);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('clock rollback cannot rewrite a policy or show it as current ('+engine+')',async()=>{
  const f=await fixture();try{
   const epoch=f.policy.chatRevision(await f.store.snapshot(),CHAT);
   await f.service().save(OWNER,config(),epoch,0);
   const before=await f.store.snapshot();f.setTime(999);
   assert.equal((await f.service().inspect(OWNER,CHAT)).status,'STALE');
   assert.equal((await f.service().save(OWNER,config(2),epoch,1)).status,'STALE');
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('unconnected enforcement and malformed policies cannot be saved ('+engine+')',async()=>{
  const f=await fixture();try{
   const epoch=f.policy.chatRevision(await f.store.snapshot(),CHAT);
   assert.equal((await f.service().save(OWNER,{...config(),mode:'ENFORCE'},epoch,0)).status,'ENFORCEMENT_NOT_CONNECTED');
   assert.equal((await f.service().save(OWNER,{...config(),mode:'RUN'},epoch,0)).status,'INVALID');
   assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
  }finally{await f.close();}
 });
}
