import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore,type Chat} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,type ModerationGateway,FakeModerationGateway} from '../src/moderation.js';
import {ambiguousModerationChatIds} from '../src/moderation-review-integrity.js';

const OWNER='100',GROUP='-100123',OTHER='-100456',TARGET='300',NOW=1_700_000_000_000;
type Engine='json'|'sqlite';

async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-dispatch-duplicate-chat-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 await policy.approveChat(OWNER,OTHER,['moderation']);
 const group=(await store.snapshot()).chats.find(x=>x.id===GROUP)!;
 let read=0,sends=0;
 let onRights:(()=>Promise<void>)|undefined;
 let onProtect:(()=>Promise<void>)|undefined;
 let onSend:((verify?:()=>Promise<boolean>)=>Promise<'CONFIRMED'|'FAILED_CONFIRMED'>)|undefined;
 const gateway:ModerationGateway={
  canRestrict:async()=>{read++;if(onRights)await onRights();return true;},
  isProtected:async()=>{read++;if(onProtect)await onProtect();return false;},
  setRestriction:async(_chat,_member,_kind,verify)=>{sends++;
   return onSend?onSend(verify):'CONFIRMED';
  }
 };
 const service=()=>new ModerationService(store,policy,gateway,()=>NOW);
 const duplicate=async(c:Chat=group)=>store.transaction(s=>{s.chats.push({...c,scopes:[...c.scopes]});});
 const seedReason=async()=>store.transaction(s=>s.moderationReasons.push({
  chatId:GROUP,memberId:TARGET,source:'MANUAL',reference:'existing',
  kind:'BAN',createdBy:OWNER,active:true
 }));
 const protectState=async(before:Awaited<ReturnType<typeof store.snapshot>>)=>{
  const after=await store.snapshot();
  assert.deepEqual(after.moderationReasons,before.moderationReasons);
  assert.deepEqual(after.moderationOperations,before.moderationOperations);
  assert.deepEqual(after.warnings,before.warnings);
  assert.equal(sends,0);
 };
 return {store,policy,gateway,group,service,duplicate,seedReason,
  reads:()=>read,sends:()=>sends,
  setRights:(f:()=>Promise<void>)=>{onRights=f;},
  setProtect:(f:()=>Promise<void>)=>{onProtect=f;},
  setSend:(f:(verify?:()=>Promise<boolean>)=>Promise<'CONFIRMED'|'FAILED_CONFIRMED'>)=>{onSend=f;},
  protectState,close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 for(const [label,mutation] of [
  ['identical duplicate',(c:Chat)=>({...c,scopes:[...c.scopes]})],
  ['later revoked duplicate',(c:Chat)=>({...c,approved:false,version:c.version+1,scopes:[]})],
  ['later version duplicate',(c:Chat)=>({...c,version:c.version+2})],
  ['later reduced scope',(c:Chat)=>({...c,scopes:['navigation']})]
 ] as const){
  test(engine+' rejects preexisting '+label+' before any moderation remote read or reason mutation',async()=>{
   const f=await fixture(engine);try{
    await f.duplicate(mutation(f.group));
    const state=await f.store.snapshot();
    assert.equal(ambiguousModerationChatIds(state).has(GROUP),true);
    const res=await f.service().addManualReason(OWNER,GROUP,TARGET,'case','BAN');
    assert.equal(res.status,'DENIED');
    assert.equal(f.reads(),0);
    await f.protectState(state);
   }finally{await f.close();}
  });
 }
 test(engine+' revoked first restored approval cannot be reopened by second matching approved row',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{const c=s.chats.find(x=>x.id===GROUP)!;c.approved=false;});
   await f.duplicate(f.group);
   const old=await f.store.snapshot();
   const ans=await f.service().addManualReason(OWNER,GROUP,TARGET,'case','BAN');
   assert.equal(ans.status,'DENIED');
   assert.equal(f.reads(),0);
   await f.protectState(old);
  }finally{await f.close();}
 });
 test(engine+' duplicate group introduced while reading remote bot rights blocks manual reason commit',async()=>{
  const f=await fixture(engine);try{
   let injected=false;
   f.setRights(async()=>{if(!injected){injected=true;await f.duplicate();}});
   const res=await f.service().addManualReason(OWNER,GROUP,TARGET,'case','MUTE');
   assert.equal(injected,true);
   assert.equal(res.status,'DENIED');
   const s=await f.store.snapshot();
   assert.equal(s.moderationReasons.length,0);
   assert.equal(s.moderationOperations.length,0);
   assert.equal(f.sends(),0);
  }finally{await f.close();}
 });
 test(engine+' duplicate group introduced while checking target protections blocks local reason',async()=>{
  const f=await fixture(engine);try{
   let once=false;
   f.setProtect(async()=>{if(!once){once=true;await f.duplicate();}});
   const ans=await f.service().addManualReason(OWNER,GROUP,TARGET,'case','BAN');
   assert.equal(once,true);
   assert.equal(ans.status,'DENIED');
   assert.equal((await f.store.snapshot()).moderationReasons.length,0);
   assert.equal(f.sends(),0);
  }finally{await f.close();}
 });
 test(engine+' duplicate group introduced after durable INTENT prevents STARTED/send',async()=>{
  const f=await fixture(engine);try{
   await f.seedReason();
   let hit=false;
   const service=f.service();
   service.beforeDispatch=async()=>{if(!hit){hit=true;await f.duplicate();}};
   const ans=await service.reconcile(OWNER,GROUP,TARGET);
   assert.equal(hit,true);
   assert.equal(ans.status,'DENIED');
   assert.equal(f.sends(),0);
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations.length,1);
   assert.equal(s.moderationOperations[0]?.status,'CANCELLED');
   assert.equal(s.moderationOperations.some(x=>x.status==='STARTED'),false);
  }finally{await f.close();}
 });
 test(engine+' duplicate group during awaited dispatch authority callback prevents remote sanction',async()=>{
  const f=await fixture(engine);try{
   await f.seedReason();
   let verifyObserved:boolean|undefined;
   f.setSend(async verify=>{
    await f.duplicate();
    verifyObserved=await verify?.();
    return verifyObserved?'CONFIRMED':'FAILED_CONFIRMED';
   });
   const ans=await f.service().reconcile(OWNER,GROUP,TARGET);
   assert.equal(f.sends(),1,'STARTED was reserved before the gateway callback');
   assert.equal(verifyObserved,false,'gateway cannot rely on pre-restore approval');
   assert.equal(ans.status,'BLOCKED_UNKNOWN','conflicted authority cannot imply confirmed outcome');
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
   assert.equal(s.moderationOperations[0]?.memberId,TARGET);
   assert.equal(s.moderationOperations.length,1);
   assert.equal((await f.service().reconcile(OWNER,GROUP,TARGET)).status,'DENIED');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
 test(engine+' duplicate group appearing while provider returns success cannot create trusted CONFIRMED receipt',async()=>{
  const f=await fixture(engine);try{
   await f.seedReason();
   f.setSend(async()=>{await f.duplicate();return 'CONFIRMED';});
   const result=await f.service().reconcile(OWNER,GROUP,TARGET);
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
   assert.equal(f.sends(),1,'a late change cannot unsend; must preserve uncertainty');
  }finally{await f.close();}
 });
 test(engine+' warnings cannot be added or removed with duplicated restored approval rows',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.service().issueWarning(OWNER,GROUP,TARGET,'warning')).status,'ADDED');
   await f.duplicate();
   const before=await f.store.snapshot();
   assert.equal((await f.service().issueWarning(OWNER,GROUP,TARGET,'next')).status,'DENIED');
   assert.equal((await f.service().removeWarning(OWNER,GROUP,TARGET,'warning')).status,'DENIED');
   assert.deepEqual((await f.store.snapshot()).warnings,before.warnings);
  }finally{await f.close();}
 });
 test(engine+' duplicate restored approvals block removal of active manual reasons',async()=>{
  const f=await fixture(engine);try{
   await f.seedReason();await f.duplicate();
   const before=await f.store.snapshot();
   const result=await f.service().removeManualReason(OWNER,GROUP,TARGET,'existing');
   assert.equal(result.status,'DENIED');
   assert.equal(f.reads(),0);
   await f.protectState(before);
  }finally{await f.close();}
 });
 test(engine+' trusted subscription rule cannot change while group approval is duplicated',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate();
   const before=await f.store.snapshot();
   const result=await f.service().setSubscriptionReason(GROUP,TARGET,'must-subscribe',true);
   assert.equal(result.status,'DENIED');
   assert.equal(f.reads(),0);
   await f.protectState(before);
  }finally{await f.close();}
 });
 test(engine+' unrelated duplicated group cannot suppress a different uniquely approved group',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    const b=s.chats.find(x=>x.id===OTHER)!;
    s.chats.push({...b,scopes:[...b.scopes]});
   });
   const res=await f.service().addManualReason(OWNER,GROUP,TARGET,'legitimate','MUTE');
   assert.equal(res.status,'APPLIED');
   assert.equal(f.sends(),1);
   const snap=await f.store.snapshot();
   assert.equal(snap.moderationOperations[0]?.status,'CONFIRMED');
  }finally{await f.close();}
 });
 test(engine+' unique approved group remains safe for manual BAN and never retries UNKNOWN outcome',async()=>{
  const f=await fixture(engine);try{
   const res=await f.service().addManualReason(OWNER,GROUP,TARGET,'legitimate','BAN');
   assert.equal(res.status,'APPLIED');
   assert.equal(f.sends(),1);
   const op=(await f.store.snapshot()).moderationOperations[0]!;
   assert.equal(op.status,'CONFIRMED');
   await f.store.transaction(s=>{s.moderationOperations[0]!.status='UNKNOWN_OUTCOME';});
   const denied=await f.service().reconcile(OWNER,GROUP,TARGET);
   assert.equal(denied.status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
}
