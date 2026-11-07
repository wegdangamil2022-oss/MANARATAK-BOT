import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4ReactionsService} from '../src/phase4-reactions.js';
import {validReactionState} from '../src/phase4-reaction-model.js';
import {startPhase4ReactionMaintenance} from '../src/phase4-reaction-maintenance.js';

const OWNER='100',GROUP='-1001234',STUDENT='200',NOW=1_700_000_000_000;
const input=(messageId=42)=>({kind:'BOT_POST' as const,messageId,
 description:'دليل تفاعلي عن القبول الجامعي',durationMinutes:60});
for(const engine of ['json','sqlite'] as const){
 test('REACT-008 '+engine+': subscription policy changed mid membership check rejects like atomically',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'reaction-policy-race-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   let arrived!:()=>void,release!:()=>void;
   const verified=new Promise<void>(r=>{arrived=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const service=new Phase4ReactionsService(store,policy,()=>NOW,async()=>{
    arrived();await gate;return 'VERIFIED';});
   const target=await service.draft(OWNER,GROUP,input());await service.open(OWNER,target.id,1);
   const pending=service.like(STUDENT,target.id);
   await verified;
   await store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:['-100555'],mode:'ALL',version:1});});
   release();
   assert.equal((await pending).status,'STALE');
   assert.equal((await store.snapshot()).phase4Reactions?.reactions.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('REACT-009 '+engine+': private member info revoked during Telegram proof fails closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'reaction-epoch-race-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   let arrived!:()=>void,release!:()=>void;
   const entered=new Promise<void>(r=>{arrived=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const service=new Phase4ReactionsService(store,policy,()=>NOW,async()=>{
    arrived();await gate;return 'VERIFIED';});
   const target=await service.draft(OWNER,GROUP,input());await service.open(OWNER,target.id,1);
   const pending=service.memberInfo(STUDENT,target.id);
   await entered;
   await policy.revokeChat(OWNER,GROUP);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   release();
   assert.equal(await pending,null);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('REACT-010 '+engine+': daily spam ceiling and strict corruption validation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'reaction-rate-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const service=new Phase4ReactionsService(store,policy,()=>NOW,async()=> 'VERIFIED');
   for(let i=0;i<13;i++){
    const target=await service.draft(OWNER,GROUP,input(i+1));
    await service.open(OWNER,target.id,1);
    assert.equal((await service.like(STUDENT,target.id)).status,
     i===12?'RATE_LIMIT':'LIKED');
   }
   const saved=(await store.snapshot()).phase4Reactions!;
   assert.equal(saved.reactions.length,12);
   const duplicate=structuredClone(saved);
   duplicate.reactions.push({...duplicate.reactions[0]!,id:'f'.repeat(24)});
   assert.equal(validReactionState(duplicate),false);
   const forged=structuredClone(saved);
   forged.targets[0]!.sourceVerified=true as never;
   assert.equal(validReactionState(forged),false);
   const competition=structuredClone(saved);
   competition.targets[0]!.kind='COMPETITION' as never;
   assert.equal(validReactionState(competition),false);
   assert.equal(validReactionState(saved),true);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('REACT-011 '+engine+': eventual cleanup removes closed post and all related personal data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'reaction-retention-'));try{
   let now=NOW;const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const service=new Phase4ReactionsService(store,policy,()=>now,async()=> 'VERIFIED');
   const target=await service.draft(OWNER,GROUP,input());await service.open(OWNER,target.id,1);
   await service.like(STUDENT,target.id);
   now+=3_600_001;
   const sweeper=startPhase4ReactionMaintenance(service,()=>()=>{});
   await sweeper.stop();
   assert.equal((await store.snapshot()).phase4Reactions?.targets[0]?.status,'CLOSED');
   now+=86_400_001;await service.expire();
   assert.deepEqual((await store.snapshot()).phase4Reactions?.reactions,[]);
   now+=30*86_400_000;await service.expire();
   const restored=(await new BotStore(store.file,{engine}).snapshot()).phase4Reactions!;
   assert.deepEqual(restored,{targets:[],reactions:[]});
   assert.doesNotMatch(JSON.stringify(restored),/200|memberId/);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
test('REACT-012 privacy worker coalesces overlapping ticks and drains on stop',async()=>{
 let calls=0,finished=0,stops=0;
 let tick!:()=>void,release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const work=startPhase4ReactionMaintenance({
  expire:async()=>{calls++;await gate;finished++;return 1;}
 } as Phase4ReactionsService,fn=>{tick=fn;return ()=>{stops++;};});
 tick();tick();assert.equal(calls,1);
 release();await work.stop();
 assert.equal(finished,1);assert.equal(stops,1);
 tick();assert.equal(calls,1);
});
