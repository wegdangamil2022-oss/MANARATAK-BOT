import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4BadgesService} from '../src/phase4-badges.js';
import {validBadgeState} from '../src/phase4-badge-model.js';
const OWNER='100',GROUP='-1001234',STUDENT='200',NOW=1_700_000_000_000;
for(const engine of ['json','sqlite'] as const){
 test('BADGE-008 '+engine+': policy changes during student consent verification reject old member witness',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'badge-consent-fence-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   let entered!:()=>void,release!:()=>void;
   const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
   const gate=new Promise<void>(resolve=>{release=resolve;});
   const svc=new Phase4BadgesService(store,policy,()=>NOW,async()=>{
    entered();await gate;return 'VERIFIED';});
   const pending=svc.consent(STUDENT,GROUP,true);
   await enteredPromise;
   await store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:['-1005666'],mode:'ALL',version:1});});
   release();
   assert.equal((await pending).status,'STALE');
   const d=(await store.snapshot()).phase4Badges;
   assert.equal(d?.consents.length??0,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('BADGE-009 '+engine+': opt-out during in-flight badge lookup cannot disclose withdrawn awards',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'badge-revoke-fence-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const verified=new Phase4BadgesService(store,policy,()=>NOW,async()=> 'VERIFIED');
   await verified.consent(STUDENT,GROUP,true);
   const badge=await verified.draft(OWNER,GROUP,STUDENT,'COMMUNITY_CARE');
   await verified.approve(OWNER,badge.id,1);
   let entered!:()=>void,release!:()=>void;
   const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
   const gate=new Promise<void>(resolve=>{release=resolve;});
   const delayed=new Phase4BadgesService(store,policy,()=>NOW,async()=>{
    entered();await gate;return 'VERIFIED';});
   const pending=delayed.myBadges(STUDENT,GROUP);
   await enteredPromise;
   assert.equal((await verified.consent(STUDENT,GROUP,false)).status,'DISABLED');
   release();
   assert.equal(await pending,null);
   assert.equal((await store.snapshot()).phase4Badges?.awards.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('BADGE-010 '+engine+': restored invalid badge cross-reference and duplicate awards are rejected',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'badge-integrity-'));try{
   const store=new BotStore(join(dir,'s.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const svc=new Phase4BadgesService(store,policy,()=>NOW,async()=> 'VERIFIED');
   await svc.consent(STUDENT,GROUP,true);
   const badge=await svc.draft(OWNER,GROUP,STUDENT,'HELPFULNESS');
   const saved=(await store.snapshot()).phase4Badges!;
   const forged=structuredClone(saved);
   forged.awards[0]!.chatVersion++;
   assert.equal(validBadgeState(forged),false);
   const duplicate=structuredClone(saved);
   duplicate.awards.push({...badge,id:'f'.repeat(24)});
   assert.equal(validBadgeState(duplicate),false);
   assert.equal(validBadgeState(saved),true);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
