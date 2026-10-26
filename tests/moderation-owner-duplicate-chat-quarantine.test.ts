import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore,type Chat,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationUnknownOwnerReview} from '../src/moderation-unknown-review.js';
import {ModerationPendingOwnerView} from '../src/moderation-pending-owner-view.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',A='-100123',B='-100456',NOW=1_700_000_000_000;
type Engine='json'|'sqlite';
async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-duplicate-chat-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(path,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,A,['moderation']);
 await policy.approveChat(OWNER,B,['moderation']);
 const snap=await store.snapshot();
 const a=snap.chats.find(c=>c.id===A)!,b=snap.chats.find(c=>c.id===B)!;
 const op=(id:string,chatId:string,status:ModerationOperation['status'],memberId:string):ModerationOperation=>({
  id,chatId,memberId,actorId:OWNER,kind:'BAN',reasonFingerprint:'SECRET-'+id,
  policyVersion:chatId===A?a.version:b.version,status,createdAt:NOW-500
 });
 await store.transaction(s=>s.moderationOperations.push(
  op('unknown-A',A,'UNKNOWN_OUTCOME','300'),op('pending-A',A,'STARTED','301'),
  op('unknown-B',B,'UNKNOWN_OUTCOME','400'),op('pending-B',B,'INTENT','401')
 ));
 const owner=()=>new ModerationUnknownOwnerReview(new BotStore(path,{engine}),policy,()=>NOW);
 const pending=()=>new ModerationPendingOwnerView(new BotStore(path,{engine}),policy,()=>NOW);
 const btn=(v:Awaited<ReturnType<ModerationUnknownOwnerReview['handle']>>,prefix:string)=>{
  const x=v?.keyboard.inline_keyboard.flat().find(c=>c.callback_data.startsWith(prefix));
  assert.ok(x,'missing '+prefix);return x.callback_data;
 };
 const ownerList=()=>owner().handle('mr:1:h',OWNER);
 const pendingList=()=>pending().handle('mp:1:h',OWNER);
 const issue=async()=>{
  const all=await ownerList();
  const details=await owner().handle(btn(all,'mr:1:d:'),OWNER);
  return btn(await owner().handle(btn(details,'mr:1:v:'),OWNER),'c_');
 };
 const duplicate=async(chat:Chat)=>{
  await store.transaction(s=>{s.chats.push({...chat,scopes:[...chat.scopes]});});
 };
 const assertUnchanged=async(before:Awaited<ReturnType<typeof store.snapshot>>)=>{
  const after=await store.snapshot();
  assert.deepEqual(after,before);
  assert.equal(after.moderationOperations.filter(x=>x.review).length,0);
 };
 const assertLocked=async()=>{
  const gateway=new FakeModerationGateway();
  const service=new ModerationService(store,policy,gateway,()=>NOW);
  assert.equal((await service.reconcile(OWNER,A,'300')).status,'BLOCKED_UNKNOWN');
  assert.equal(gateway.calls.length,0);
 };
 return {store,a,b,policy,owner,pending,ownerList,pendingList,btn,issue,duplicate,
  assertUnchanged,assertLocked,close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' restored duplicated approved chat cannot mint owner review nonce',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate(f.a);
   const before=await f.store.snapshot(),list=await f.ownerList();
   assert.equal(list?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mr:1:d:')).length,1);
   assert.match(list?.text??'',/مجموعات متعارضة محجوبة: 1/);
   assert.doesNotMatch(list?.text??'',/SECRET-unknown-A|unknown-A|300/);
   await f.assertUnchanged(before);await f.assertLocked();
  }finally{await f.close();}
 });
 for(const [name,clone] of [
  ['revoked second group epoch',(c:Chat):Chat=>({...c,approved:false,version:c.version+1,scopes:[]})],
  ['older second approval epoch',(c:Chat):Chat=>({...c,version:c.version+5})],
  ['restricted second moderation scope',(c:Chat):Chat=>({...c,scopes:['navigation']})]
 ] as const){
  test(engine+' refuses restored ambiguous approval from '+name,async()=>{
   const f=await fixture(engine);try{
    await f.duplicate(clone(f.a));
    const list=await f.ownerList();
    assert.equal(list?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mr:1:d:')).length,1);
    const pending=await f.pendingList();
    assert.equal(pending?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mp:1:d:')).length,1);
    assert.match(list?.text??'',/مجموعات متعارضة محجوبة: 1/);
    assert.match(pending?.text??'',/مجموعات متعارضة محجوبة: 1/);
   }finally{await f.close();}
  });
 }
 test(engine+' revoked first group must not gain review visibility through appended approved duplicate',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    const c=s.chats.find(x=>x.id===A)!;
    c.approved=false;c.scopes=[];
   });
   await f.duplicate(f.a);
   const owner=await f.ownerList(),pending=await f.pendingList();
   assert.equal(owner?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mr:1:d:')).length,1);
   assert.equal(pending?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mp:1:d:')).length,1);
   assert.match(owner?.text??'',/مجموعات متعارضة محجوبة: 1/);
  }finally{await f.close();}
 });
 test(engine+' already displayed UNKNOWN details become invalid after a duplicate chat restore',async()=>{
  const f=await fixture(engine);try{
   const list=await f.ownerList(),detailKey=f.btn(list,'mr:1:d:');
   await f.duplicate(f.a);
   assert.equal(await f.owner().handle(detailKey,OWNER),null);
   assert.equal((await f.store.snapshot()).moderationOperations[0]?.review,undefined);
  }finally{await f.close();}
 });
 test(engine+' already displayed pending details become invalid after duplicate chat restore',async()=>{
  const f=await fixture(engine);try{
   const list=await f.pendingList(),detailKey=f.btn(list,'mp:1:d:');
   await f.duplicate(f.a);
   assert.equal(await f.pending().handle(detailKey,OWNER),null);
  }finally{await f.close();}
 });
 test(engine+' nonce minted before group duplication is rejected atomically without consumption',async()=>{
  const f=await fixture(engine);try{
   const token=await f.issue();
   await f.duplicate(f.a);
   const before=await f.store.snapshot();
   assert.equal(await f.owner().handle(token,OWNER),null);
   const after=await f.store.snapshot();
   assert.deepEqual(after,before);
   assert.equal(after.callbacks.find(c=>c.ref===token)?.used,false);
   assert.equal(after.moderationOperations[0]?.review,undefined);
   await f.assertLocked();
  }finally{await f.close();}
 });
 test(engine+' unrelated approved chat remains reviewable during another group approval collision',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate({...f.a,version:f.a.version+2});
   const list=await f.ownerList(),selector=f.btn(list,'mr:1:d:');
   const details=await f.owner().handle(selector,OWNER);
   const action=f.btn(details,'mr:1:v:');
   const preview=await f.owner().handle(action,OWNER);
   const token=f.btn(preview,'c_');
   assert.ok(await f.owner().handle(token,OWNER));
   const state=await f.store.snapshot();
   assert.equal(state.moderationOperations.find(x=>x.id==='unknown-A')?.review,undefined);
   assert.equal(state.moderationOperations.find(x=>x.id==='unknown-B')?.review?.decision,'ACKNOWLEDGED_UNRESOLVED');
   assert.equal(state.moderationOperations.find(x=>x.id==='unknown-A')?.status,'UNKNOWN_OUTCOME');
  }finally{await f.close();}
 });
 test(engine+' unrelated pending cases remain readable and owner screens do not alter evidence',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate(f.a);
   const before=await f.store.snapshot();
   const owner=await f.ownerList(),p=await f.pendingList();
   const key=f.btn(p,'mp:1:d:');
   const pending=await f.pending().handle(key,OWNER);
   assert.match(pending?.text??'',/INTENT/);
   assert.equal(owner?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mr:1:d:')).length,1);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' unrelated duplicate chat record without moderation attempts does not hide valid cases',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.chats.push({id:'-100999',approved:true,present:false,
    scopes:['moderation'],version:1,groupAI:'OFF'},
    {id:'-100999',approved:false,present:false,scopes:[],version:2,groupAI:'OFF'}));
   const unknown=await f.ownerList(),pending=await f.pendingList();
   assert.equal(unknown?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mr:1:d:')).length,2);
   assert.equal(pending?.keyboard.inline_keyboard.flat().filter(x=>x.callback_data.startsWith('mp:1:d:')).length,2);
   assert.match(unknown?.text??'',/مجموعات متعارضة محجوبة: 0/);
  }finally{await f.close();}
 });
}
