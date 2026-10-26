import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type Grant} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',STAFF='200',GROUP='-100123',OTHER='-100456',NOW=1_700_000_000_000;
const activeUntil=NOW+600_000;
type Engine='json'|'sqlite';
async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-grant-epoch-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['navigation','moderation','assistant']);
 await policy.approveChat(OWNER,OTHER,['navigation','moderation','assistant']);
 const grant=async(chat=GROUP,capability:'chat.manage'|'ai.ask'='chat.manage')=>
  policy.grant(OWNER,STAFF,capability,chat,activeUntil);
 const has=async(chat=GROUP,capability:'chat.manage'|'ai.ask'='chat.manage')=>
  policy.has(await store.snapshot(),STAFF,capability,chat,NOW);
 const revision=async(chat=GROUP)=>policy.chatRevision(await store.snapshot(),chat);
 const original=async()=>{const state=await store.snapshot();return state.grants.find(g=>g.chatId===GROUP)!;};
 const revoke=async()=>policy.revokeChat(OWNER,GROUP);
 const reapprove=async()=>policy.approveChat(OWNER,GROUP,['navigation','moderation','assistant']);
 return {store,policy,grant,has,revision,original,revoke,reapprove,
  close:()=>rm(dir,{recursive:true,force:true})};
}
const epochOf=(g:Grant):unknown=>(g as Grant&{chatPolicyVersion?:unknown}).chatPolicyVersion;
const legacy=(g:Grant)=>{delete (g as Grant&{chatPolicyVersion?:number}).chatPolicyVersion;};

for(const engine of ['json','sqlite'] as const){
 test(engine+' new group delegated grant is bound to durable approval epoch',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   const g=await f.original();
   assert.equal(epochOf(g),await f.revision());
   assert.equal(await f.has(),true);
  }finally{await f.close();}
 });
 for(const [label,change] of [
  ['group revoked then reapproved',async(f:Awaited<ReturnType<typeof fixture>>)=>{
   await f.revoke();await f.reapprove();
  }],
  ['scope changed by reapproval',async(f:Awaited<ReturnType<typeof fixture>>)=>{
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation']);
  }],
  ['owner restrictive group scope change',async(f:Awaited<ReturnType<typeof fixture>>)=>{
   await f.policy.restrictChatScopeAtRevision(OWNER,GROUP,'assistant',await f.revision());
  }],
  ['group AI mode changed',async(f:Awaited<ReturnType<typeof fixture>>)=>{
   await f.policy.configureGroupAI(OWNER,GROUP,'OWNER_MENTION');
  }]
 ] as const){
  test(engine+' stored staff delegation cannot reactivate after '+label,async()=>{
   const f=await fixture(engine);try{
    await f.grant();assert.equal(await f.has(),true);
    const g=structuredClone(await f.original());
    await change(f);
    assert.equal(await f.has(),false);
    assert.deepEqual(await f.original(),g,'historical evidence stays immutable');
   }finally{await f.close();}
  });
 }
 test(engine+' staff role stays inactive immediately after group revocation',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.revoke();
   assert.equal(await f.has(),false);
   assert.equal((await f.store.snapshot()).chats.find(x=>x.id===GROUP)?.approved,false);
  }finally{await f.close();}
 });
 test(engine+' one stale staff grant cannot become active again after restored duplicate removed',async()=>{
  const f=await fixture(engine);try{
   await f.grant();const g=structuredClone(await f.original());
   await f.revoke();await f.reapprove();
   await f.store.transaction(s=>s.chats.push({...s.chats.find(c=>c.id===GROUP)!,scopes:['navigation']}));
   assert.equal(await f.has(),false);
   await f.store.transaction(s=>s.chats.pop());
   assert.equal(await f.has(),false);
   assert.deepEqual(await f.original(),g);
  }finally{await f.close();}
 });
 test(engine+' genuine legacy unbound group grant fails closed without deletion',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.store.transaction(s=>legacy(s.grants[0]!));
   const before=await f.store.snapshot();
   assert.equal(await f.has(),false,'no guess about issuance epoch from current chat');
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' invalid non-safe, string and future stored group epochs never authorize',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   const bad=[0,-1,1.25,'1',null,Number.MAX_SAFE_INTEGER+1];
   for(const epoch of bad){
    await f.store.transaction(s=>{
     (s.grants[0] as unknown as Record<string,unknown>).chatPolicyVersion=epoch;
    });
    assert.equal(await f.has(),false,String(epoch));
   }
  }finally{await f.close();}
 });
 test(engine+' newer owner delegation can supersede stale historical grant without rewriting it',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   const historical=structuredClone(await f.original());
   await f.revoke();await f.reapprove();
   assert.equal(await f.has(),false);
   await f.grant();
   const state=await f.store.snapshot();
   assert.equal(state.grants.length,2);
   assert.deepEqual(state.grants[0],historical);
   assert.equal(epochOf(state.grants[1]!),await f.revision());
   assert.equal(await f.has(),true);
   assert.equal(state.grants[0]!.revoked,false);
  }finally{await f.close();}
 });
 test(engine+' new group grant rejected while active grant already exists for same epoch',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   const before=await f.store.snapshot();
   await assert.rejects(f.grant(),/already exists/i);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' private user-scoped legacy grant retains existing behavior',async()=>{
  const f=await fixture(engine);try{
   await f.policy.grant(OWNER,STAFF,'ai.ask',STAFF,activeUntil);
   const state=await f.store.snapshot();
   assert.equal(epochOf(state.grants.find(x=>x.chatId===STAFF)!),undefined);
   assert.equal(f.policy.has(state,STAFF,'ai.ask',STAFF,NOW),true);
   await f.revoke();await f.reapprove();
   assert.equal(f.policy.has(await f.store.snapshot(),STAFF,'ai.ask',STAFF,NOW),true);
  }finally{await f.close();}
 });
 test(engine+' staff group ban simulation denied after revoke+reapproval until new grant',async()=>{
  const f=await fixture(engine);try{
   await f.grant();await f.revoke();await f.reapprove();
   const gateway=new FakeModerationGateway();
   const svc=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   const res=await svc.addManualReason(STAFF,GROUP,'300','case-stale','BAN');
   assert.equal(res.status,'DENIED');
   assert.equal(gateway.calls.length,0);
   assert.equal((await f.store.snapshot()).moderationReasons.length,0);
   await f.grant();
   assert.equal(await f.has(),true);
   const approved=await svc.addManualReason(STAFF,GROUP,'300','case-new','BAN');
   assert.equal(approved.status,'APPLIED');
   assert.equal(gateway.calls.length,1);
  }finally{await f.close();}
 });
 test(engine+' independent group grant remains active after unrelated group revocation',async()=>{
  const f=await fixture(engine);try{
   await f.grant(GROUP);await f.grant(OTHER);
   await f.revoke();await f.reapprove();
   assert.equal(await f.has(GROUP),false);
   assert.equal(await f.has(OTHER),true);
  }finally{await f.close();}
 });
 test(engine+' stale grant cannot bypass temporary restored duplicate removal to modify warning',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.revoke();await f.reapprove();
   await f.store.transaction(s=>s.chats.push({...s.chats.find(x=>x.id===GROUP)!}));
   await f.store.transaction(s=>s.chats.pop());
   const svc=new ModerationService(f.store,f.policy,new FakeModerationGateway(),()=>NOW);
   const before=await f.store.snapshot();
   const out=await svc.issueWarning(STAFF,GROUP,'300','stale');
   assert.equal(out.status,'DENIED');
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
}
