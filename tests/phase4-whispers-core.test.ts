import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4WhisperService} from '../src/phase4-whispers.js';
import {validWhisperState} from '../src/phase4-whisper-model.js';

const OWNER='100',GROUP='-1001234',OTHER='-1001235',USER='200';
const START=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-phase4-whisper-'));
 let now=START;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 const service=new Phase4WhisperService(store,policy,()=>now,
  async()=> 'VERIFIED');
 return {store,policy,service,now:()=>now,advance:(ms:number)=>{now+=ms;},
  close:()=>rm(dir,{force:true,recursive:true})};
}
test('WHISPER-010 strict model refuses forged states and duplicate seats',()=>{
 assert.equal(validWhisperState({messages:[],reservations:[],consents:[]}),true);
 for(const bad of [null,{},[],{messages:[],reservations:[],consents:[],secret:'x'},
  {messages:[],reservations:[],consents:[{chatId:GROUP,memberId:USER,enabled:true}]}
 ])assert.equal(validWhisperState(bad),false);
});
for(const engine of ['json','sqlite'] as const){
 test('WHISPER-016 '+engine+': owner reviews a first-N draft before it opens; no Telegram dispatch',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.service.draft(USER,GROUP,{kind:'FIRST_N',seats:3,
    durationMinutes:10,text:'خاص <&>!'}),/WHISPER_DENIED/);
   const draft=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:3,
    durationMinutes:10,text:'خاص <&>!'});
   assert.equal(draft.status,'DRAFT');
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
   const ready=await f.service.approve(OWNER,draft.id);
   assert.equal(ready.status,'OPEN');
   assert.equal(ready.seats,3);
   await assert.rejects(f.service.approve(OWNER,draft.id),/WHISPER_/);
   const stored=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Whispers;
   assert.equal(stored?.messages[0]?.status,'OPEN');
   assert.equal(stored?.reservations.length,0);
   assert.equal((await f.store.snapshot()).operations.length,0);
  }finally{await f.close();}
 });
 test('WHISPER-010 '+engine+': first N reservations are atomic, idempotent and private',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:3,
    durationMinutes:5,text:'ONLY IN PRIVATE'});
   await f.service.approve(OWNER,d.id);
   const ids=Array.from({length:30},(_,i)=>String(200+i));
   const denied=await f.service.reserve(USER,d.id);
   assert.equal(denied.status,'CONSENT_REQUIRED');
   for(const id of ids)await f.service.consent(id,GROUP,true);
   const results=await Promise.all(ids.map(id=>f.service.reserve(id,d.id)));
   assert.equal(results.filter(x=>x.status==='HELD').length,3);
   assert.equal(results.filter(x=>x.status==='FULL').length,27);
   const repeats=await Promise.all(Array.from({length:10},()=>f.service.reserve(USER,d.id)));
   assert.ok(repeats.every(x=>x.status==='ALREADY_HELD'));
   const s=await f.store.snapshot();
   assert.equal(s.phase4Whispers?.reservations.length,3);
   assert.equal(JSON.stringify(s.phase4Whispers?.reservations).includes('ONLY IN PRIVATE'),false);
   assert.equal((await f.service.publicSummary(OWNER,d.id)).includes('ONLY IN PRIVATE'),false);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('WHISPER-001 '+engine+': direct target has exclusive reservation and refuses other user',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'DIRECT',recipientId:'500',
    durationMinutes:5,text:'one person'});
   await f.service.approve(OWNER,d.id);
   await f.service.consent('500',GROUP,true);
   await f.service.consent('501',GROUP,true);
   assert.equal((await f.service.reserve('501',d.id)).status,'NOT_RECIPIENT');
   assert.equal((await f.service.reserve('500',d.id)).status,'HELD');
   assert.equal((await f.service.reserve('500',d.id)).status,'ALREADY_HELD');
   assert.equal((await f.store.snapshot()).phase4Whispers?.reservations.length,1);
  }finally{await f.close();}
 });
 test('WHISPER-004 '+engine+': consent defaults off; withdrawal prevents new reservations',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:2,
    durationMinutes:5,text:'private'});
   await f.service.approve(OWNER,d.id);
   await f.service.consent(USER,GROUP,true);
   await f.service.consent(USER,GROUP,false);
   assert.equal((await f.service.reserve(USER,d.id)).status,'CONSENT_REQUIRED');
   await f.service.consent(USER,GROUP,true);
   assert.equal((await f.service.reserve(USER,d.id)).status,'HELD');
  }finally{await f.close();}
 });
 test('WHISPER-025 '+engine+': expired and cancelled messages are redacted; old previews cannot reopen',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:2,
    durationMinutes:1,text:'sensitive words'});
   await f.service.approve(OWNER,d.id);
   f.advance(60_001);
   assert.equal((await f.service.reserve(USER,d.id)).status,'EXPIRED');
   await f.service.expire();
   const state=await f.store.snapshot();
   assert.equal(state.phase4Whispers?.messages[0]?.status,'CLOSED');
   assert.equal('text' in (state.phase4Whispers?.messages[0]??{}),false);
   assert.equal(JSON.stringify(state.phase4Whispers).includes('sensitive words'),false);
   await assert.rejects(f.service.approve(OWNER,d.id),/WHISPER_/);
  }finally{await f.close();}
 });
 test('WHISPER-026 '+engine+': owner revocation closes immediately without refunding held seats',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:2,
    durationMinutes:8,text:'private draft'});
   await f.service.approve(OWNER,d.id);
   await f.service.consent(USER,GROUP,true);
   assert.equal((await f.service.reserve(USER,d.id)).status,'HELD');
   await f.service.close(OWNER,d.id);
   assert.equal((await f.service.reserve('201',d.id)).status,'CLOSED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.messages[0]?.text,undefined);
  }finally{await f.close();}
 });
 test('WHISPER-019 '+engine+': failed member verification denies without consuming seats',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:1,
    durationMinutes:10,text:'secret'});
   await f.service.approve(OWNER,d.id);
   await f.service.consent(USER,GROUP,true);
   const unverified=new Phase4WhisperService(f.store,f.policy,f.now,async()=> 'UNKNOWN');
   assert.equal((await unverified.reserve(USER,d.id)).status,'VERIFICATION_REQUIRED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.reservations.length,0);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.service.reserve(USER,d.id)).status,'STALE');
   assert.equal((await f.store.snapshot()).phase4Whispers?.reservations.length,0);
  }finally{await f.close();}
 });
 test('WHISPER-016 '+engine+': restored forged capacity/claims/keys rejected on JSON and SQLite',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:2,
    durationMinutes:5,text:'valid'});
   await f.service.approve(OWNER,d.id);
   await assert.rejects(f.store.transaction(s=>{
    s.phase4Whispers!.messages[0]!.seats=0;
   }),/schema/i);
   await assert.rejects(f.store.transaction(s=>{
    s.phase4Whispers!.messages[0]!.chatVersion=0;
   }),/schema/i);
   await assert.rejects(f.store.transaction(s=>{
    (s.phase4Whispers!.messages[0]! as unknown as Record<string,unknown>).unexpected='x';
   }),/schema/i);
  }finally{await f.close();}
 });
}
