import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationPurgeService,FakePurgeGateway} from '../src/moderation-purge.js';

const OWNER='100',STAFF='200',CHAT='-100',DAY=86_400_000,START=60*DAY;
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-retention-review-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 let now=START;
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock),gateway=new FakePurgeGateway();
 const service=()=>new ModerationPurgeService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),gateway,clock);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 async function observe(id:number,extra:Record<string,unknown>={}){
  await service().observe({chatId:CHAT,messageId:id,observedAt:now,sentAt:now-60_000,
   senderKind:'USER',senderId:'300',contentType:'TEXT',hasLinks:true,pinned:false,
   linkedChannel:false,adminLog:false,approvedAnnouncement:false,...extra} as never);
 }
 return {dir,file,store,policy,gateway,service,observe,now:()=>now,advance:(ms:number)=>{now+=ms},close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(`retention watch ${engine}: absent watcher is disabled, never deletes or indexes by itself`,async()=>{
  const f=await fixture(engine);try{
   await f.observe(1);
   const original=await f.store.snapshot();
   assert.equal((await f.service().tickRetentionReview()).status,'DISABLED');
   assert.equal(await f.service().getRetentionReview(OWNER),null);
   assert.deepEqual(await f.store.snapshot(),original);
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close()}
 });

 test(`retention watch ${engine}: only owner configures or reads, cadence bounds and fields are strict`,async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.service().configureRetentionReview(STAFF,{enabled:true,cadenceMs:DAY}),/OWNER_ONLY/);
   await assert.rejects(f.service().getRetentionReview(STAFF),/OWNER_ONLY/);
   for(const config of [
    {enabled:true,cadenceMs:0},{enabled:true,cadenceMs:DAY-1},
    {enabled:true,cadenceMs:30*DAY+1},{enabled:true,cadenceMs:DAY+0.5},
    {enabled:true,cadenceMs:Number.POSITIVE_INFINITY},
    {enabled:true,cadenceMs:DAY,leak:'private note'}
   ]){
    await assert.rejects(f.service().configureRetentionReview(OWNER,config as never),/INVALID_RETENTION_SCHEDULE/);
   }
   const current=await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
   assert.equal(current.nextCheckAt,f.now()+DAY);
   assert.equal(current.enabled,true);
   assert.equal(current.version,1);
   const visible=await f.service().getRetentionReview(OWNER);
   assert.equal(visible?.nextCheckAt,current.nextCheckAt);
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close()}
 });

 test(`retention watch ${engine}: due tick emits only aggregate dry-run and never executes compaction`,async()=>{
  const f=await fixture(engine);try{
   await f.observe(1);
   await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
   assert.equal((await f.service().tickRetentionReview()).status,'NOT_DUE');
   f.advance(DAY);
   const result=await f.service().tickRetentionReview();
   assert.equal(result.status,'READY');
   assert.equal(result.notice?.expiredObserved,0);
   assert.equal(result.notice?.eligibleJobs,0);
   assert.match(result.notice!.digest,/^[0-9a-f]{64}$/);
   assert.equal(JSON.stringify(result).includes('"senderId"'),false);
   const snapshot=await f.store.snapshot();
   assert.equal(snapshot.rollingMessageMeta.length,1); // no automatic removal
   assert.equal(snapshot.purgeJobs.length,0);
   assert.equal(snapshot.audit.filter(a=>a.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
   assert.equal(f.gateway.calls.length,0);
   const again=await f.service().tickRetentionReview();
   assert.equal(again.status,'NOT_DUE');
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
  }finally{await f.close()}
 });

 test(`retention watch ${engine}: stale metadata reported after 48h but not automatically pruned`,async()=>{
  const f=await fixture(engine);try{
   await f.observe(1);
   await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:3*DAY});
   f.advance(3*DAY);
   const result=await f.service().tickRetentionReview();
   assert.equal(result.status,'READY');
   assert.equal(result.notice?.expiredObserved,1);
   assert.equal((await f.store.snapshot()).rollingMessageMeta.length,1);
   const stored=await f.service().getRetentionReview(OWNER);
   assert.equal(stored?.lastNotice?.expiredObserved,1);
   assert.equal((await f.service().compactRetention(OWNER,result.notice!)).expiredObserved,1);
   assert.equal((await f.store.snapshot()).rollingMessageMeta.length,0);
  }finally{await f.close()}
 });

 test(`retention watch ${engine}: enabled schedule survives restart and long outages catch up once`,async()=>{
  const f=await fixture(engine);try{
   await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
   f.advance(9*DAY);
   assert.equal((await f.service().tickRetentionReview()).status,'READY');
   const fromDisk=await f.service().getRetentionReview(OWNER);
   assert.equal(fromDisk?.nextCheckAt,f.now()+DAY);
   assert.equal(fromDisk?.lastCheckedAt,f.now());
   assert.equal((await f.service().tickRetentionReview()).status,'NOT_DUE');
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
  }finally{await f.close()}
 });

 test(`retention watch ${engine}: owner disable clears stale notice and blocks any due scan`,async()=>{
  const f=await fixture(engine);try{
   await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
   f.advance(DAY);
   await f.service().tickRetentionReview();
   const next=await f.service().configureRetentionReview(OWNER,{enabled:false,cadenceMs:DAY});
   assert.equal(next.enabled,false);
   assert.equal(next.lastNotice,undefined);
   assert.equal(next.version,2);
   f.advance(40*DAY);
   assert.equal((await f.service().tickRetentionReview()).status,'DISABLED');
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
  }finally{await f.close()}
 });

 test(`retention watch ${engine}: a backwards clock cannot cause extra scans or rewind next due time`,async()=>{
  const f=await fixture(engine);try{
   await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
   f.advance(DAY);
   const first=await f.service().tickRetentionReview();
   assert.equal(first.status,'READY');
   const next=(await f.service().getRetentionReview(OWNER))!.nextCheckAt;
   f.advance(-2*DAY);
   assert.equal((await f.service().tickRetentionReview()).status,'CLOCK_ROLLBACK');
   assert.equal((await f.service().getRetentionReview(OWNER))!.nextCheckAt,next);
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
  }finally{await f.close()}
 });

 test(`retention watch ${engine}: two racing service instances produce one notice at each due interval`,async()=>{
  const f=await fixture(engine);try{
   await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
   f.advance(DAY);
   const [a,b]=await Promise.all([f.service().tickRetentionReview(),f.service().tickRetentionReview()]);
   assert.deepEqual([a.status,b.status].sort(),['NOT_DUE','READY']);
   assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='PURGE_RETENTION_REVIEW_DUE').length,1);
  }finally{await f.close()}
 });
}

test('retention watch: notice expires after 10 minutes and never becomes a background deletion authorization',async()=>{
 const f=await fixture('sqlite');try{
  await f.observe(1);
  await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:3*DAY});
  f.advance(3*DAY);
  assert.equal((await f.service().tickRetentionReview()).status,'READY');
  const old=(await f.service().getRetentionReview(OWNER))!.lastNotice!;
  f.advance(11*60_000);
  await assert.rejects(f.service().compactRetention(OWNER,old),/RETENTION_PREVIEW_EXPIRED/);
  assert.equal((await f.store.snapshot()).rollingMessageMeta.length,1);
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});

test('retention watch: corruption in stored control policy fails closed without write or gateway call',async()=>{
 const f=await fixture('sqlite');try{
  await f.service().configureRetentionReview(OWNER,{enabled:true,cadenceMs:DAY});
  await f.store.transaction(s=>{
   s.purgeRetentionReview!.cadenceMs=0;
  });
  const before=await f.store.snapshot();
  f.advance(DAY);
  await assert.rejects(f.service().tickRetentionReview(),/INVALID_RETENTION_SCHEDULE/);
  assert.deepEqual(await f.store.snapshot(),before);
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});
