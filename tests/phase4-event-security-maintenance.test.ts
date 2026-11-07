import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4EventService} from '../src/phase4-events.js';
import {startPhase4EventPrivacyMaintenance} from '../src/phase4-event-maintenance.js';

const OWNER='100',GROUP='-1001234',USER='200',NOW=1_700_000_000_000;
const input=(now:number)=>({
 title:'مراجعة التقديم للجامعات',startsAt:now+3_600_000,
 durationMinutes:30,capacity:5,link:'https://university.example.edu/meeting'});
for(const engine of ['json','sqlite'] as const){
 test('EVENT-008 '+engine+': changed mandatory-channel requirement during membership check rejects registration',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'event-subscription-race-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation','verification']);
   let entered!:()=>void,release!:()=>void;
   const arrived=new Promise<void>(r=>{entered=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const svc=new Phase4EventService(store,policy,()=>NOW,async()=>{
    entered();await gate;return 'VERIFIED';});
   const event=await svc.draft(OWNER,GROUP,input(NOW));await svc.open(OWNER,event.id,1);
   const pending=svc.register(USER,event.id,true);
   await arrived;
   await store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:['-1005678'],mode:'ALL',version:1});});
   release();
   assert.equal((await pending).status,'STALE');
   assert.equal((await store.snapshot()).phase4Events?.registrations.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('EVENT-009 '+engine+': membership promise returning after the registration deadline cannot create a record',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'event-expiry-race-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   let arrived!:()=>void,release!:()=>void;
   const entered=new Promise<void>(r=>{arrived=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const svc=new Phase4EventService(store,policy,()=>now,async()=>{arrived();await gate;return 'VERIFIED';});
   const event=await svc.draft(OWNER,GROUP,input(now));await svc.open(OWNER,event.id,1);
   const pending=svc.register(USER,event.id,false);
   await entered;now+=3_600_001;release();
   assert.equal((await pending).status,'EXPIRED');
   assert.equal((await store.snapshot()).phase4Events?.registrations.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('EVENT-010 '+engine+': event info cannot leak after group revocation during Telegram proof',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'event-info-race-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   let entered!:()=>void,release!:()=>void;
   const arrived=new Promise<void>(r=>{entered=r;});
   const gate=new Promise<void>(r=>{release=r;});
   const svc=new Phase4EventService(store,policy,()=>NOW,async()=>{
    entered();await gate;return 'VERIFIED';});
   const event=await svc.draft(OWNER,GROUP,input(NOW));await svc.open(OWNER,event.id,1);
   const pending=svc.eventInfo(USER,event.id);
   await arrived;
   await policy.revokeChat(OWNER,GROUP);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   release();
   assert.equal(await pending,null);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('EVENT-011 '+engine+': sweep starts immediately, closes expired sessions and scrubs member identities on retention cutoff',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'event-maintenance-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const svc=new Phase4EventService(store,policy,()=>now,async()=> 'VERIFIED');
   const event=await svc.draft(OWNER,GROUP,input(now));await svc.open(OWNER,event.id,1);
   await svc.register(USER,event.id,true);
   now+=5_400_001;
   let stopCount=0,trigger!:()=>void;
   const work=startPhase4EventPrivacyMaintenance(svc,tick=>{
    trigger=tick;return ()=>{stopCount++;};
   });
   await work.stop();
   assert.equal(stopCount,1);
   const finished=(await new BotStore(store.file,{engine}).snapshot()).phase4Events!;
   assert.equal(finished.events[0]?.status,'FINISHED');
   now+=86_400_001;
   const second=startPhase4EventPrivacyMaintenance(svc,()=>()=>{});
   await second.stop();
   const redacted=(await new BotStore(store.file,{engine}).snapshot()).phase4Events!;
   assert.deepEqual(redacted.registrations,[]);
   assert.equal(JSON.stringify(redacted).includes(USER),false);
   trigger();
   assert.deepEqual((await store.snapshot()).phase4Events?.registrations,[]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
test('EVENT-011 maintenance serializes concurrent ticks and stop waits for pending cleanup',async()=>{
 let calls=0,finished=0,stopped=0;
 let tick!:()=>void,release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const worker=startPhase4EventPrivacyMaintenance({
  expire:async()=>{calls++;await gate;finished++;return 1;}
 } as Phase4EventService,next=>{tick=next;return ()=>{stopped++;};});
 tick();tick();assert.equal(calls,1);
 release();await worker.stop();
 assert.equal(finished,1);assert.equal(stopped,1);
 tick();assert.equal(calls,1);
});
