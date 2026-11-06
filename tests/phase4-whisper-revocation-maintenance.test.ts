import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4WhisperService} from '../src/phase4-whispers.js';
import {startPhase4WhisperPrivacyMaintenance} from '../src/phase4-whisper-maintenance.js';

const OWNER='100',GROUP='-1001234',OTHER='-1005678',USER='200';
const START=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-whisper-revocation-'));
 let now=START;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 const service=new Phase4WhisperService(store,policy,()=>now,async()=> 'VERIFIED');
 return {store,service,clock:()=>now,advance:(ms:number)=>{now+=ms;},
  close:()=>rm(dir,{force:true,recursive:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('WHISPER-004 '+engine+': opting out releases held local seats only for that member and group',async()=>{
  const f=await fixture(engine);try{
   const a=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:2,
    durationMinutes:20,text:'private A'});
   const b=await f.service.draft(OWNER,OTHER,{kind:'FIRST_N',seats:2,
    durationMinutes:20,text:'private B'});
   await f.service.approve(OWNER,a.id);await f.service.approve(OWNER,b.id);
   await f.service.consent(USER,GROUP,true);
   await f.service.consent(USER,OTHER,true);
   await f.service.consent('201',GROUP,true);
   assert.equal((await f.service.reserve(USER,a.id)).status,'HELD');
   assert.equal((await f.service.reserve(USER,b.id)).status,'HELD');
   assert.equal((await f.service.reserve('201',a.id)).status,'HELD');
   assert.equal(await f.service.consent(USER,GROUP,false),true);
   const state=(await f.store.snapshot()).phase4Whispers!;
   assert.deepEqual(state.reservations.map(x=>x.messageId+':'+x.memberId).sort(),
    [a.id+':201',b.id+':'+USER].sort());
   assert.equal(state.consents.find(x=>x.chatId===GROUP&&x.memberId===USER)?.enabled,false);
   assert.equal((await f.service.reserve(USER,a.id)).status,'CONSENT_REQUIRED');
   assert.equal(JSON.stringify(state.reservations).includes('private'),false);
  }finally{await f.close();}
 });
 test('WHISPER-004 '+engine+': revocation survives restart and re-opt-in never revives an old seat',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:1,
    durationMinutes:10,text:'private'});
   await f.service.approve(OWNER,d.id);
   await f.service.consent(USER,GROUP,true);
   assert.equal((await f.service.reserve(USER,d.id)).status,'HELD');
   assert.equal(await f.service.consent(USER,GROUP,false),true);
   const reopened=new BotStore(f.store.file,{engine});
   assert.deepEqual((await reopened.snapshot()).phase4Whispers?.reservations,[]);
   assert.equal(await f.service.consent(USER,GROUP,true),true);
   assert.equal((await f.service.reserve(USER,d.id)).status,'HELD');
   assert.equal((await f.service.reserve(USER,d.id)).status,'ALREADY_HELD');
  }finally{await f.close();}
 });
 test('WHISPER-006 '+engine+': autonomous maintenance scrubs expired secrets without owner interaction',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:1,
    durationMinutes:1,text:'SECRET MUST BE SCRUBBED'});
   await f.service.approve(OWNER,d.id);
   f.advance(60_001);
   let cancelled=0,scheduled:()=>void=()=>{};
   const runner=startPhase4WhisperPrivacyMaintenance(f.service,tick=>{
    scheduled=tick;return ()=>{cancelled++;};
   });
   // Even if no owner opens a menu, the initial scheduled sweep is started.
   await runner.stop();
   assert.equal(cancelled,1);
   const persisted=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Whispers!;
   assert.equal(persisted.messages[0]?.status,'CLOSED');
   assert.equal(persisted.messages[0]?.text,undefined);
   assert.doesNotMatch(JSON.stringify(persisted),/SECRET MUST BE SCRUBBED/);
   scheduled(); // A cancelled timer cannot restart cleanup.
   assert.equal(cancelled,1);
  }finally{await f.close();}
 });
}
test('WHISPER-006 periodic privacy sweeper coalesces concurrent ticks and drains on stop',async()=>{
 let calls=0,finished=0,cancelled=0;
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 let scheduled!:()=>void;
 const runner=startPhase4WhisperPrivacyMaintenance({
  expire:async()=>{calls++;await gate;finished++ ;return 1;}
 } as Phase4WhisperService,tick=>{scheduled=tick;return ()=>{cancelled++;};});
 scheduled();scheduled();
 assert.equal(calls,1);
 release();await runner.stop();
 assert.equal(finished,1);
 assert.equal(cancelled,1);
 scheduled();assert.equal(calls,1);
});
