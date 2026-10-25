import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {moderationRateFuse,MODERATION_RATE_LIMITS} from '../src/moderation-rate-fuse.js';

const OWNER='100',STAFF='301',GROUP='-100123',OTHER='-100234';
const BASE=1_700_000_000_000;
const record=(i:number,opts:Partial<ModerationOperation>={}):ModerationOperation=>({
 id:'historical-'+i,chatId:GROUP,memberId:String(10_000+i),actorId:STAFF,
 kind:'MUTE',reasonFingerprint:'r'+i,policyVersion:1,status:'CONFIRMED',
 createdAt:BASE-120_000,...opts
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-rate-fuse-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'db.sqlite':'db.json'),{engine});
 let time=BASE;
 const policy=new Policy(store,OWNER,()=>time),gateway=new FakeModerationGateway();
 const service=()=>new ModerationService(store,policy,gateway,()=>time);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 await policy.approveChat(OWNER,OTHER,['moderation']);
 await policy.grant(OWNER,STAFF,'chat.manage',GROUP,BASE+86_400_000);
 await policy.grant(OWNER,STAFF,'chat.manage',OTHER,BASE+86_400_000);
 return {store,policy,gateway,service,now:()=>time,advance:(ms:number)=>{time+=ms},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('rate fuse has explicit conservative bounds and fails closed on invalid clock',()=>{
 assert.deepEqual(MODERATION_RATE_LIMITS,{
  actorChatTenMinutes:5,groupTenMinutes:12,actorAllChatsDay:30,
  tenMinutesMs:600_000,dayMs:86_400_000
 });
 assert.equal(moderationRateFuse({moderationOperations:[]} as never,STAFF,GROUP,-1),'INVALID_CLOCK');
 assert.equal(moderationRateFuse({moderationOperations:[]} as never,STAFF,GROUP,NaN),'INVALID_CLOCK');
});
for(const engine of ['json','sqlite'] as const){
 test('sixth punishment within ten minutes denied without new reason or outbound call ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<5;i++){
    const r=await f.service().addManualReason(STAFF,GROUP,String(400+i),'incident-'+i,'MUTE');
    assert.equal(r.status,'APPLIED');
   }
   const denied=await f.service().addManualReason(STAFF,GROUP,'499','sixth','BAN');
   assert.equal(denied.status,'DENIED');
   assert.equal(denied.reason,'MODERATION_RATE_LIMIT_ACTOR_CHAT');
   assert.equal(f.gateway.calls.length,5);
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations.length,5);
   assert.equal(s.moderationReasons.some(x=>x.memberId==='499'),false);
   // The fuse is a rolling ledger check, not a permanently locked grant.
   f.advance(600_001);
   assert.equal((await f.service().addManualReason(STAFF,GROUP,'499','sixth','BAN')).status,'APPLIED');
   assert.equal(f.gateway.calls.length,6);
  }finally{await f.close();}
 });
 test('group safety ceiling applies across independent authorized actors ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    for(let i=0;i<12;i++)s.moderationOperations.push(record(i,{actorId:String(800+Math.floor(i/4))}));
   });
   assert.equal(moderationRateFuse(await f.store.snapshot(),STAFF,GROUP,f.now()),'GROUP_TEN_MINUTES');
   const denied=await f.service().addManualReason(STAFF,GROUP,'799','pressure','BAN');
   assert.equal(denied.status,'DENIED');
   assert.equal(denied.reason,'MODERATION_RATE_LIMIT_GROUP');
   assert.equal(f.gateway.calls.length,0);
   assert.equal((await f.store.snapshot()).moderationReasons.length,0);
  }finally{await f.close();}
 });
 test('daily actor ceiling spans groups, cannot be bypassed by switching groups ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    for(let i=0;i<30;i++)s.moderationOperations.push(record(i,{
     chatId:'-100'+String(5000+i),createdAt:BASE-3_600_000
    }));
   });
   assert.equal(moderationRateFuse(await f.store.snapshot(),STAFF,GROUP,f.now()),'ACTOR_ALL_CHATS_DAY');
   const r=await f.service().addManualReason(STAFF,GROUP,'799','daily-limit','MUTE');
   assert.equal(r.status,'DENIED');
   assert.equal(r.reason,'MODERATION_RATE_LIMIT_ACTOR_DAY');
   assert.equal(f.gateway.calls.length,0);
   f.advance(86_400_001);
   assert.equal((await f.service().addManualReason(STAFF,GROUP,'799','daily-limit','MUTE')).status,'APPLIED');
  }finally{await f.close();}
 });
 test('pending, failed and unknown count toward safety ceiling; cancelled does not ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    for(let i=0;i<4;i++)s.moderationOperations.push(record(i,{
     status:(['INTENT','STARTED','FAILED_CONFIRMED','UNKNOWN_OUTCOME'] as const)[i]
    }));
    s.moderationOperations.push(record(4,{status:'CANCELLED'}));
   });
   assert.equal(moderationRateFuse(await f.store.snapshot(),STAFF,GROUP,f.now()),null);
   assert.equal((await f.service().addManualReason(STAFF,GROUP,'812','fifth','BAN')).status,'APPLIED');
   assert.equal((await f.service().addManualReason(STAFF,GROUP,'813','sixth','BAN')).status,'DENIED');
   assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 });
 test('concurrent separate targets never reserve more than actor ceiling ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const outcomes=await Promise.all(Array.from({length:9},(_,i)=>
    f.service().addManualReason(STAFF,GROUP,String(900+i),'case-'+i,'MUTE')));
   assert.equal(outcomes.filter(x=>x.status==='APPLIED').length,5);
   assert.equal(outcomes.filter(x=>x.status==='DENIED').length,4);
   assert.equal(f.gateway.calls.length,5);
   const operations=(await f.store.snapshot()).moderationOperations;
   assert.equal(operations.length,5);
   assert.equal(operations.filter(x=>x.status==='CONFIRMED').length,5);
  }finally{await f.close();}
 });
 test('release is not rate-blocked in simulator, while unknown still blocks retry ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.service().addManualReason(STAFF,GROUP,'710','prior','MUTE')).status,'APPLIED');
   await f.store.transaction(s=>{for(let i=0;i<5;i++)
    s.moderationOperations.push(record(i,{id:'saturation-'+i}));});
   assert.equal((await f.service().removeManualReason(STAFF,GROUP,'710','prior')).status,'APPLIED');
   assert.equal(f.gateway.calls.at(-1)?.kind,'NONE');
   assert.equal((await f.store.snapshot()).moderationOperations.at(-1)?.kind,'NONE');
  }finally{await f.close();}
 });
}
