import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type Chat} from '../src/store.js';
import {Policy} from '../src/policy.js';

const OWNER='100',GROUP='-100123',OTHER='-100456',CHANNEL='-100789';
const NOW=1_700_000_000_000,ALL=['navigation','assistant','verification','moderation','publishing'];
type Engine='json'|'sqlite';
async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-shared-policy-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,ALL);
 await policy.approveChat(OWNER,OTHER,ALL);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 await policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION');
 const snap=await store.snapshot();
 const original=snap.chats.find(x=>x.id===GROUP)!;
 const duplicate=async(copy:Chat={...original,scopes:[...original.scopes]})=>{
  await store.transaction(s=>{s.chats.push({...copy,scopes:[...copy.scopes]});});
 };
 const seedRequirement=async()=>{
  await store.transaction(s=>s.subscriptionRequirements.push({
   chatId:GROUP,channelIds:[CHANNEL],mode:'ALL',version:1
  }));
 };
 const assertPreserved=async(before:Awaited<ReturnType<typeof store.snapshot>>)=>{
  assert.deepEqual(await store.snapshot(),before,
   'a duplicated approval must never partially mutate a restored database');
 };
 const nonce=async(action:'owner.chat.revoke'|'owner.chat.ai_off'|'owner.subscription.pause')=>{
  const ref='c_0123456789ABCDEFGHijklmn';
  await store.transaction(s=>s.callbacks.push({
   ref,actorId:OWNER,chatId:GROUP,action,
   policyVersion:original.version,expiresAt:NOW+60_000,
   oneShot:true,used:false,revoked:false,
   ...(action==='owner.subscription.pause'?{requirementVersion:1}:{})
  }));
  return ref;
 };
 return {store,policy,original,duplicate,seedRequirement,assertPreserved,nonce,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 for(const [name,copy] of [
  ['identical duplicate',(c:Chat):Chat=>({...c,scopes:[...c.scopes]})],
  ['reversed revoked duplicate',(c:Chat):Chat=>({...c,approved:false,scopes:[],version:c.version+1})],
  ['different authorization epoch',(c:Chat):Chat=>({...c,version:c.version+5})],
  ['different assistant/publishing scopes',(c:Chat):Chat=>({...c,scopes:['moderation']})]
 ] as const){
  test(engine+' shared policy rejects '+name+' for every group service scope',async()=>{
   const f=await fixture(engine);try{
    await f.duplicate(copy(f.original));
    const s=await f.store.snapshot();
    for(const scope of ALL)assert.equal(f.policy.canUseChat(s,GROUP,scope),false,scope);
    assert.equal(f.policy.chatRevision(s,GROUP),0,'never use first matching revision');
    assert.equal(f.policy.mayAskGroup(s,GROUP,'300',true),false);
    assert.equal(f.policy.canUseChat(s,OTHER,'navigation'),true);
    assert.equal(f.policy.chatRevision(s,OTHER),1);
    assert.equal(f.policy.canUseChat(s,CHANNEL,'verification'),true);
   }finally{await f.close();}
  });
 }
 test(engine+' duplicate first revoked and later approved does not authorize private assistant',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    const row=s.chats.find(x=>x.id===GROUP)!;
    row.approved=false;row.scopes=[];row.version++;
   });
   await f.duplicate(f.original);
   const s=await f.store.snapshot();
   assert.equal(f.policy.canUseChat(s,GROUP,'assistant'),false);
   assert.equal(f.policy.mayAskGroup(s,GROUP,OWNER,true),false);
  }finally{await f.close();}
 });
 test(engine+' approval cannot rewrite first copy of duplicated restored group',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate();
   const before=await f.store.snapshot();
   await assert.rejects(f.policy.approveChat(OWNER,GROUP,['navigation']));
   await f.assertPreserved(before);
  }finally{await f.close();}
 });
 test(engine+' ordinary revoke does not mutate one of two conflicting approvals',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate({...f.original,approved:false});
   const before=await f.store.snapshot();
   await assert.rejects(f.policy.revokeChat(OWNER,GROUP));
   await f.assertPreserved(before);
  }finally{await f.close();}
 });
 test(engine+' group AI enablement cannot pick arbitrary restored chat epoch',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate();
   const before=await f.store.snapshot();
   await assert.rejects(f.policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION'));
   await f.assertPreserved(before);
  }finally{await f.close();}
 });
 test(engine+' group presence update does not modify a single ambiguous chat record',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate();
   const before=await f.store.snapshot();
   await assert.rejects(f.policy.setPresence(GROUP,true));
   await f.assertPreserved(before);
  }finally{await f.close();}
 });
 for(const name of ['revokeChatAtRevision','restrictChatScopeAtRevision','disableGroupAIAtRevision'] as const){
  test(engine+' owner restrictive '+name+' refuses conflicting restored group revisions',async()=>{
   const f=await fixture(engine);try{
    await f.duplicate();
    const before=await f.store.snapshot();
    const v=f.original.version;
    const act=()=>name==='revokeChatAtRevision'
     ?f.policy.revokeChatAtRevision(OWNER,GROUP,v)
     :name==='restrictChatScopeAtRevision'
      ?f.policy.restrictChatScopeAtRevision(OWNER,GROUP,'assistant',v)
      :f.policy.disableGroupAIAtRevision(OWNER,GROUP,v);
    await assert.rejects(act());
    await f.assertPreserved(before);
   }finally{await f.close();}
  });
 }
 test(engine+' removing subscription channel cannot use ambiguous verification approval',async()=>{
  const f=await fixture(engine);try{
   await f.seedRequirement();
   await f.duplicate();
   const before=await f.store.snapshot();
   await assert.rejects(f.policy.removeSubscriptionChannelAtRevision(
    OWNER,GROUP,CHANNEL,f.original.version,1));
   await f.assertPreserved(before);
  }finally{await f.close();}
 });
 test(engine+' pausing subscription cannot use ambiguous verification approval',async()=>{
  const f=await fixture(engine);try{
   await f.seedRequirement();
   await f.duplicate();
   const before=await f.store.snapshot();
   await assert.rejects(f.policy.pauseSubscriptionAtRevision(OWNER,GROUP,f.original.version,1));
   await f.assertPreserved(before);
  }finally{await f.close();}
 });
 for(const action of ['owner.chat.revoke','owner.chat.ai_off','owner.subscription.pause'] as const){
  test(engine+' restored duplicate group denies one-shot '+action+' without consuming token',async()=>{
   const f=await fixture(engine);try{
    if(action==='owner.subscription.pause')await f.seedRequirement();
    const token=await f.nonce(action);
    await f.duplicate();
    const before=await f.store.snapshot();
    assert.equal(await f.policy.applyOwnerInlineConfirmation(OWNER,token,NOW),null);
    await f.assertPreserved(before);
    assert.equal((await f.store.snapshot()).callbacks.find(x=>x.ref===token)?.used,false);
   }finally{await f.close();}
  });
 }
 test(engine+' unique group remains configurable alongside a collided group',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate();
   await f.policy.configureGroupAI(OWNER,OTHER,'ALL_MENTION');
   const s=await f.store.snapshot();
   assert.equal(f.policy.canUseChat(s,OTHER,'assistant'),true);
   assert.equal(f.policy.mayAskGroup(s,OTHER,'300',true),true);
   assert.equal(f.policy.chatRevision(s,OTHER),2);
  }finally{await f.close();}
 });
 test(engine+' legacy missing chat returns false/zero without making up revision',async()=>{
  const f=await fixture(engine);try{
   const s=await f.store.snapshot();
   assert.equal(f.policy.canUseChat(s,'-100999','navigation'),false);
   assert.equal(f.policy.chatRevision(s,'-100999'),0);
   assert.equal(f.policy.mayAskGroup(s,'-100999',OWNER,true),false);
  }finally{await f.close();}
 });

 test(engine+' restored group collision invalidates delegated and owner group-scoped capabilities',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.grants.push({
    actor:'200',capability:'chat.manage',chatId:GROUP,
    expiresAt:NOW+60_000,grantedBy:OWNER,revoked:false
   }));
   let s=await f.store.snapshot();
   assert.equal(f.policy.has(s,'200','chat.manage',GROUP,NOW),true);
   assert.equal(f.policy.has(s,OWNER,'chat.manage',GROUP,NOW),true);
   await f.duplicate();
   s=await f.store.snapshot();
   assert.equal(f.policy.has(s,'200','chat.manage',GROUP,NOW),false);
   assert.equal(f.policy.has(s,OWNER,'chat.manage',GROUP,NOW),false);
   assert.equal(f.policy.has(s,OWNER,'chat.manage',OTHER,NOW),true);
  }finally{await f.close();}
 });
 test(engine+' owner cannot add new delegated permissions to ambiguous restored group',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate();
   const before=await f.store.snapshot();
   await assert.rejects(f.policy.grant(OWNER,'200','chat.manage',GROUP,NOW+60_000));
   await f.assertPreserved(before);
  }finally{await f.close();}
 });
}
