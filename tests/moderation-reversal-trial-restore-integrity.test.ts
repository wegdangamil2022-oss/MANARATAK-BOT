import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationReversalPreflight,inspectLocalReversal,
 type RestrictionObserver} from '../src/moderation-reversal-preflight.js';
import {localModerationTrialBlockers} from '../src/moderation-trial-scope.js';

const OWNER='100',CHAT='-100123',OTHER='-100987',TARGET='300',T=1_700_000_000_000;
type Engine='json'|'sqlite';
async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-reversal-restore-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(path,{engine});
 const policy=new Policy(store,OWNER,()=>T);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 await policy.setPresence(CHAT,true);
 const version=policy.chatRevision(await store.snapshot(),CHAT);
 const op=(id:string,status:ModerationOperation['status'],createdAt:number=T)=>
  ({id,chatId:CHAT,memberId:TARGET,actorId:OWNER,kind:'BAN' as const,
   reasonFingerprint:'sealed:'+id,policyVersion:version,createdAt,status,
   attemptGateway:'TELEGRAM_API' as const});
 await store.transaction(s=>s.moderationOperations.push(op('confirmed','CONFIRMED')));
 let reads=0;
 let during:(()=>Promise<void>)|undefined;
 const observer:RestrictionObserver={observeRestriction:async()=>{
  reads++;if(during)await during();return 'BAN_PRESENT';
 }};
 const inspect=()=>new ModerationReversalPreflight(
  new BotStore(path,{engine}),policy,observer).assess(OWNER,CHAT,TARGET);
 const add=(...operations:ModerationOperation[])=>store.transaction(s=>{
  s.moderationOperations.push(...operations);
 });
 const local=async()=>inspectLocalReversal(await store.snapshot(),policy,CHAT,TARGET);
 return {store,policy,op,add,inspect,local,reads:()=>reads,
  during:(f:()=>Promise<void>)=>{during=f;},
  close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' reversed restore order: newer failed sanction vetoes older appended confirmed result',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.unshift(
    f.op('newer-failed','FAILED_CONFIRMED',T+500)));
   assert.equal((await f.local()).status,'BLOCKED_UNPROVEN');
   assert.equal((await f.inspect()).status,'BLOCKED_UNPROVEN');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' reversed restore order: newer cancelled sanction vetoes older confirmed result',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.unshift(
    f.op('newer-cancelled','CANCELLED',T+1)));
   assert.equal((await f.inspect()).status,'BLOCKED_UNPROVEN');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' older failure appended after recent confirmed does not masquerade as latest',async()=>{
  const f=await fixture(engine);try{
   await f.add(f.op('older-failed','FAILED_CONFIRMED',T-100));
   assert.deepEqual(await f.inspect(),{status:'OBSERVED_NOT_ATTRIBUTABLE',kind:'BAN'});
   assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
 test(engine+' ambiguous equal timestamps with conflicting outcomes never enable remote observation',async()=>{
  const f=await fixture(engine);try{
   await f.add(f.op('tie-failed','FAILED_CONFIRMED',T));
   assert.equal((await f.local()).status,'BLOCKED_UNPROVEN');
   assert.equal((await f.inspect()).status,'BLOCKED_UNPROVEN');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' ambiguous equal timestamps even for two confirmed sanctions never enable observation',async()=>{
  const f=await fixture(engine);try{
   await f.add(f.op('tie-confirmed','CONFIRMED',T));
   assert.equal((await f.inspect()).status,'BLOCKED_UNPROVEN');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' duplicate operation ID from different member blocks reversal inspection without remote call',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.push(
    {...f.op('confirmed','CONFIRMED',T-50),memberId:'301',chatId:OTHER}));
   assert.equal((await f.local()).status,'BLOCKED_UNPROVEN');
   assert.equal((await f.inspect()).status,'BLOCKED_UNPROVEN');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' malformed restored record from other group blocks unsafe global reversal inspection',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.push(
    {...f.op('other-corrupt','CONFIRMED',T-50),chatId:OTHER,status:'NOT_REAL' as ModerationOperation['status']}));
   assert.equal((await f.inspect()).status,'BLOCKED_UNPROVEN');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' UNKNOWN_OUTCOME still vetoes before checking confirmed chronology',async()=>{
  const f=await fixture(engine);try{
   await f.add(f.op('unknown','UNKNOWN_OUTCOME',T-500));
   assert.equal((await f.inspect()).status,'BLOCKED_UNKNOWN');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' pending STARTED still vetoes before checking confirmed chronology',async()=>{
  const f=await fixture(engine);try{
   await f.add(f.op('started','STARTED',T+100));
   assert.equal((await f.inspect()).status,'BLOCKED_PENDING');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' changed operation chronology during observer call rejects stale remote result',async()=>{
  const f=await fixture(engine);try{
   f.during(async()=>{await f.add(f.op('new-cancel','CANCELLED',T+10));});
   assert.equal((await f.inspect()).status,'BLOCKED_STALE');
   assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
 test(engine+' legacy fake gateway result remains unproven despite latest timestamp',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.moderationOperations[0]!.attemptGateway='SIMULATION';});
   assert.equal((await f.inspect()).status,'BLOCKED_UNPROVEN');
   assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 for(const [label,mutate] of [
  ['identical trial approval', (s:Awaited<ReturnType<typeof fixture>>)=>s.store.transaction(t=>{
    const chat=t.chats.find(c=>c.id===CHAT)!;t.chats.push({...chat,scopes:[...chat.scopes]});
   })],
  ['revoked trial approval', (s:Awaited<ReturnType<typeof fixture>>)=>s.store.transaction(t=>{
    const chat=t.chats.find(c=>c.id===CHAT)!;t.chats.push({...chat,approved:false,scopes:[],version:chat.version+1});
   })],
  ['older trial approval revision', (s:Awaited<ReturnType<typeof fixture>>)=>s.store.transaction(t=>{
    const chat=t.chats.find(c=>c.id===CHAT)!;t.chats.push({...chat,version:chat.version+100});
   })],
  ['missing trial moderation scope', (s:Awaited<ReturnType<typeof fixture>>)=>s.store.transaction(t=>{
    const chat=t.chats.find(c=>c.id===CHAT)!;t.chats.push({...chat,scopes:['navigation']});
   })]
 ] as const){
  test(engine+' offline trial readiness must block restored '+label,async()=>{
   const f=await fixture(engine);try{
    await f.store.transaction(t=>t.moderationOperations=[]);
    await mutate(f);
    const before=await f.store.snapshot();
    const reasons=localModerationTrialBlockers(before,CHAT);
    assert.ok(reasons.map(String).includes('TRIAL_GROUP_APPROVAL_AMBIGUOUS'),
      'duplicated restored trial group must never PASS');
    assert.deepEqual(await f.store.snapshot(),before);
   }finally{await f.close();}
  });
 }
 test(engine+' trial readiness blocks duplicated historical other chat approvals even when revoked',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(t=>{
    t.moderationOperations=[];
    const c=t.chats.find(x=>x.id===OTHER)!;
    c.approved=false;
    t.chats.push({...c,scopes:[...c.scopes]});
   });
   const s=await f.store.snapshot();
   assert.ok(localModerationTrialBlockers(s,CHAT).map(String)
    .includes('OTHER_CHAT_APPROVAL_AMBIGUOUS'));
  }finally{await f.close();}
 });
 test(engine+' trial readiness preserves clean group without introducing false approval ambiguity',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(t=>{t.moderationOperations=[];});
   const reasons=localModerationTrialBlockers(await f.store.snapshot(),CHAT);
   assert.equal(reasons.map(String).includes('TRIAL_GROUP_APPROVAL_AMBIGUOUS'),false);
   assert.equal(reasons.map(String).includes('OTHER_CHAT_APPROVAL_AMBIGUOUS'),false);
  }finally{await f.close();}
 });
}
