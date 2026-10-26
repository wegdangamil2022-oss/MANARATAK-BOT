import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore,type Grant} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',STAFF='200',OTHER_STAFF='201',GROUP='-100123',OTHER='-100456',NOW=1_700_000_000_000;
type Engine='json'|'sqlite';
const gid=(g:Grant):unknown=>(g as Grant&{grantId?:unknown}).grantId;
const setId=(g:Grant,id?:string)=>{
 const record=g as Grant&{grantId?:string};
 if(id===undefined)delete record.grantId;
 else record.grantId=id;
};
async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-grant-ambiguity-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(path,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation','assistant','navigation']);
 await policy.approveChat(OWNER,OTHER,['moderation','assistant','navigation']);
 const grant=async(actor=STAFF,chat=GROUP,expiresAt=NOW+60_000)=>
  policy.grant(OWNER,actor,'chat.manage',chat,expiresAt);
 const has=async(actor=STAFF,chat=GROUP,now=NOW)=>
  policy.has(await store.snapshot(),actor,'chat.manage',chat,now);
 const copy=async(mutator?:(g:Grant)=>void)=>
  store.transaction(s=>{
   const entry=structuredClone(s.grants[0]!);
   mutator?.(entry);
   s.grants.push(entry);
  });
 const before=async()=>store.snapshot();
 const unchanged=async(s:Awaited<ReturnType<typeof store.snapshot>>)=>{
  assert.deepEqual(await store.snapshot(),s,'deny actions must not mutate stored evidence');
 };
 return {store,policy,grant,has,copy,before,unchanged,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' unique group grant receives nonempty identifier and remains authorized',async()=>{
  const f=await fixture(engine);try{
   await f.grant();const snapshot=await f.before(),g=snapshot.grants[0]!;
   assert.match(String(gid(g)??''),/^[0-9a-f]{8}-[0-9a-f-]{27,}$/);
   assert.equal(await f.has(),true);
  }finally{await f.close();}
 });
 test(engine+' cloned active current-epoch grant must not double-authorize restored group',async()=>{
  const f=await fixture(engine);try{
   await f.grant();await f.copy();
   const old=await f.before();
   assert.equal(await f.has(),false);
   await f.unchanged(old);
   const fake=new FakeModerationGateway();
   const result=await new ModerationService(f.store,f.policy,fake,()=>NOW)
     .addManualReason(STAFF,GROUP,'300','collision','BAN');
   assert.equal(result.status,'DENIED');
   assert.equal(fake.calls.length,0);
   assert.equal((await f.before()).moderationReasons.length,0);
  }finally{await f.close();}
 });
 test(engine+' same-id active/revoked fork cannot resurrect revoked grant',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.copy(g=>{g.revoked=true;});
   assert.equal(await f.has(),false);
  }finally{await f.close();}
 });
 test(engine+' conflicting duplicate legacy grants without IDs are not trusted',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.store.transaction(s=>setId(s.grants[0]!));
   await f.copy(g=>{g.revoked=true;});
   assert.equal(await f.has(),false);
  }finally{await f.close();}
 });
 test(engine+' two distinct simultaneously active current-epoch grants are ambiguous',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.copy(g=>setId(g,'a36b6b61-c0b9-45af-921a-f3819da08b7c'));
   assert.equal(await f.has(),false);
  }finally{await f.close();}
 });
 test(engine+' duplicate grant ID across another actor blocks both group grants',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.copy(g=>{g.actor=OTHER_STAFF;});
   assert.equal(await f.has(STAFF),false);
   assert.equal(await f.has(OTHER_STAFF),false);
  }finally{await f.close();}
 });
 test(engine+' duplicate current epoch even if one expires at the boundary fails closed',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.copy(g=>{g.expiresAt=NOW;});
   assert.equal(await f.has(),false);
  }finally{await f.close();}
 });
 test(engine+' malformed cloned grant expiration poisons only the matching tuple',async()=>{
  const f=await fixture(engine);try{
   await f.grant();await f.grant(OTHER_STAFF,OTHER);
   await f.copy(g=>{
    (g as unknown as Record<string,unknown>).expiresAt='never';
   });
   const state=await f.before();
   assert.equal(await f.has(),false);
   assert.equal(f.policy.has(state,OTHER_STAFF,'chat.manage',OTHER,NOW),true);
  }finally{await f.close();}
 });
 test(engine+' malformed restored revoked flag cannot be ignored when another matching record authorizes',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.copy(g=>{(g as unknown as Record<string,unknown>).revoked='yes';});
   assert.equal(await f.has(),false);
  }finally{await f.close();}
 });
 test(engine+' single legacy grant with epoch but no ID remains supported',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.store.transaction(s=>setId(s.grants[0]!));
   assert.equal(await f.has(),true);
  }finally{await f.close();}
 });
 test(engine+' valid explicit owner revocation followed by same-epoch regrant stays usable',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   const old=structuredClone((await f.before()).grants[0]!);
   await f.policy.revokeGrant(OWNER,STAFF,'chat.manage',GROUP);
   assert.equal(await f.has(),false);
   await f.grant();
   const current=await f.before();
   assert.equal(current.grants.length,2);
   assert.equal(current.grants[0]?.revoked,true);
   assert.equal(old.revoked,false);
   assert.equal(current.grants[1]?.revoked,false);
   assert.notEqual(gid(current.grants[0]!),gid(current.grants[1]!));
   assert.equal(await f.has(),true);
  }finally{await f.close();}
 });
 test(engine+' expired grant can be renewed in same group epoch without deleting previous evidence',async()=>{
  const f=await fixture(engine);try{
   await f.grant(STAFF,GROUP,NOW+10);
   assert.equal(await f.has(STAFF,GROUP,NOW+10),false);
   await f.grant(STAFF,GROUP,NOW+60_000);
   const snapshot=await f.before();
   assert.equal(snapshot.grants.length,2);
   assert.equal(snapshot.grants[0]?.expiresAt,NOW+10);
   assert.equal(await f.has(),true);
  }finally{await f.close();}
 });
 test(engine+' expired and current live grants with distinct IDs are not ambiguous',async()=>{
  const f=await fixture(engine);try{
   await f.grant(STAFF,GROUP,NOW+10);
   await f.grant(STAFF,GROUP,NOW+60_000);
   assert.equal(await f.has(STAFF,GROUP,NOW+20),true);
  }finally{await f.close();}
 });
 test(engine+' legacy revoked record followed by explicit ID-bearing current grant is allowed',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.store.transaction(s=>{setId(s.grants[0]!);s.grants[0]!.revoked=true;});
   await f.grant();
   assert.equal(await f.has(),true);
  }finally{await f.close();}
 });
 test(engine+' existing unrevoked current group grant remains nonduplicable',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   const old=await f.before();
   await assert.rejects(f.grant(),/already exists/);
   await f.unchanged(old);
  }finally{await f.close();}
 });
 test(engine+' ambiguous restored group grant does not block unrelated group grant',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.copy();
   await f.grant(STAFF,OTHER);
   assert.equal(await f.has(),false);
   assert.equal(await f.has(STAFF,OTHER),true);
  }finally{await f.close();}
 });
 test(engine+' corrupted group grant ID format fails closed and does not mask a separate legitimate member',async()=>{
  const f=await fixture(engine);try{
   await f.grant();
   await f.grant(OTHER_STAFF);
   await f.store.transaction(s=>setId(s.grants[0]!,'malformed'));
   assert.equal(await f.has(),false);
   assert.equal(await f.has(OTHER_STAFF),true);
  }finally{await f.close();}
 });
 test(engine+' private scoped legacy duplicate grant semantics remain unchanged',async()=>{
  const f=await fixture(engine);try{
   await f.policy.grant(OWNER,STAFF,'ai.ask',STAFF,NOW+30_000);
   const s=await f.before();
   assert.equal(f.policy.has(s,STAFF,'ai.ask',STAFF,NOW),true);
   await f.store.transaction(t=>t.grants.push({...t.grants.at(-1)!}));
   assert.equal(f.policy.has(await f.before(),STAFF,'ai.ask',STAFF,NOW),true);
  }finally{await f.close();}
 });
}
