import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationPurgeService, FakePurgeGateway} from '../src/moderation-purge.js';

const OWNER='100',STAFF='200',GROUP='-100';
const HOUR=3_600_000,DAY=24*HOUR,now0=30*DAY;
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'b2-purge-')),file=join(dir,engine==='sqlite'?'bot.sqlite':'bot.json');
 let time=now0;
 const clock=()=>time,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock),gateway=new FakePurgeGateway();
 const service=()=>new ModerationPurgeService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),gateway,clock);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 const observe=async(messageId:number,extra:Partial<Parameters<ReturnType<typeof service>['observe']>[0]>={})=>service().observe({
  chatId:GROUP,messageId,sentAt:time-HOUR,observedAt:time,senderKind:'USER',senderId:'300',
  contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false,
  ...extra
 });
 return {dir,file,store,policy,gateway,service,observe,now:()=>time,setNow:(x:number)=>{time=x},close:()=>rm(dir,{force:true,recursive:true})};
}
async function seed(f:Awaited<ReturnType<typeof fixture>>,count:number){
 for(let i=1;i<=count;i++)await f.observe(i);
}
for(const engine of ['json','sqlite'] as const){
 test(`B2-advanced ${engine}: only approved groups acquire metadata; texts never enter the rolling index`,async()=>{
  const f=await fixture(engine);try {
   await f.observe(1);
   await assert.rejects(f.observe(2,{text:'sensitive chat text'} as never),/RAW_MESSAGE_DATA_FORBIDDEN/);
   await assert.rejects(f.observe(3,{chatId:'-999'}),/CHAT_NOT_APPROVED/);
   const s=await f.store.snapshot();
   assert.equal(s.schemaVersion,8);
   assert.equal(s.rollingMessageMeta.length,1);
   assert.deepEqual(s.rollingMessageMeta[0]?.senderId,'300');
   assert.equal(JSON.stringify(s).includes('sensitive chat text'),false);
  }finally{await f.close()}
 });

 test(`B2-advanced ${engine}: preview counts protected/expired/eligible and never deletes on preview`,async()=>{
  const f=await fixture(engine);try{
   await f.observe(1,{pinned:true});
   await f.observe(2,{linkedChannel:true});
   await f.observe(3,{approvedAnnouncement:true});
   await f.observe(4,{adminLog:true});
   await f.observe(5,{sentAt:f.now()-49*HOUR});
   await f.observe(6,{senderKind:'UNKNOWN',senderId:undefined});
   await f.observe(7,{senderId:'300',hasLinks:true});
   const result=await f.service().preview(OWNER,GROUP,{limit:20});
   assert.deepEqual(result.items.map(x=>x.messageId),[7,6]);
   assert.equal(result.excluded.protected,4);
   assert.equal(result.excluded.expired,0); // expired messages are already pruned, not inferred from absent history
   assert.equal(f.gateway.calls.length,0);
   const other=await f.service().preview(OWNER,GROUP,{senderId:'300',linksOnly:true,limit:10});
   assert.deepEqual(other.items.map(x=>x.messageId),[7]);
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close()}
 });

 test(`B2-advanced ${engine}: confirmation requires new review action and recorded immutable IDs`,async()=>{
  const f=await fixture(engine);try {
   await seed(f,3);
   const review=await f.service().preview(OWNER,GROUP,{limit:3});
   assert.equal(review.status,'PREVIEW');
   assert.equal((await f.service().dispatchNext(review.id)).status,'NOT_CONFIRMED');
   await f.service().confirm(OWNER,review.id);
   assert.equal((await f.service().dispatchNext(review.id)).status,'ACKNOWLEDGED');
   assert.equal(f.gateway.calls.length,1);
   const state=await f.store.snapshot();
   assert.equal(state.purgeJobs[0]!.status,'READY');
   assert.equal(state.purgeJobs[0]!.items[0]!.status,'ACKNOWLEDGED');
   assert.ok(state.purgeJobs[0]!.items[0]!.attemptId);
   assert.equal(state.purgeJobs[0]!.items[0]!.messageId,3);
   assert.equal(state.audit.some(a=>a.reason==='PURGE_PREVIEW_CONFIRMED'),true);
  }finally{await f.close()}
 });

 test(`B2-advanced ${engine}: edited or newly protected candidate invalidates approval`,async()=>{
  const f=await fixture(engine);try {
   await seed(f,2);
   const plan=await f.service().preview(OWNER,GROUP,{limit:2});
   await f.observe(2,{hasLinks:true});
   await assert.rejects(f.service().confirm(OWNER,plan.id),/PREVIEW_STALE/);
   assert.equal((await f.store.snapshot()).purgeJobs[0]!.status,'PREVIEW');
   const newer=await f.service().preview(OWNER,GROUP,{limit:2});
   await f.observe(1,{pinned:true});
   await assert.rejects(f.service().confirm(OWNER,newer.id),/PREVIEW_STALE/);
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close()}
 });

 test(`B2-advanced ${engine}: never deletes after grant revocation during async preflight`,async()=>{
  const f=await fixture(engine);try{
   await f.policy.grant(OWNER,STAFF,'chat.manage',GROUP,f.now()+HOUR);
   await seed(f,1);
   const job=await f.service().preview(STAFF,GROUP,{limit:1});
   await f.service().confirm(STAFF,job.id);
   f.gateway.canDelete=async()=>{await f.policy.revokeGrant(OWNER,STAFF,'chat.manage',GROUP);return true;};
   assert.equal((await f.service().dispatchNext(job.id)).status,'BLOCKED');
   assert.equal(f.gateway.calls.length,0);
   const state=await f.store.snapshot();
   assert.equal(state.purgeJobs[0]!.items[0]!.status,'QUEUED');
  }finally{await f.close()}
 });

 test(`B2-advanced ${engine}: UNKNOWN from remote is quarantined after restart; no automatic replay`,async()=>{
  const f=await fixture(engine);try{
   await seed(f,2);
   const job=await f.service().preview(OWNER,GROUP,{limit:2});
   await f.service().confirm(OWNER,job.id);
   f.gateway.throwAfterDelete=true;
   assert.equal((await f.service().dispatchNext(job.id)).status,'UNKNOWN_OUTCOME');
   f.gateway.throwAfterDelete=false;
   assert.equal((await f.service().dispatchNext(job.id)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.gateway.calls.length,1);
   assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[1]!.status,'QUEUED');
  }finally{await f.close()}
 });

 test(`B2-advanced ${engine}: cancel preserves earlier accepted requests and rejects remaining IDs`,async()=>{
  const f=await fixture(engine);try{
   await seed(f,3);
   const job=await f.service().preview(OWNER,GROUP,{limit:3});
   await f.service().confirm(OWNER,job.id);
   await f.service().dispatchNext(job.id);
   await f.service().cancel(OWNER,job.id);
   const state=await f.store.snapshot();
   assert.equal(state.purgeJobs[0]!.status,'CANCELLED');
   assert.equal(state.purgeJobs[0]!.items[0]!.status,'ACKNOWLEDGED');
   assert.deepEqual(state.purgeJobs[0]!.items.slice(1).map(x=>x.status),['CANCELLED','CANCELLED']);
   assert.equal((await f.service().dispatchNext(job.id)).status,'CANCELLED');
   assert.equal(f.gateway.calls.length,1);
   assert.equal(state.audit.filter(x=>x.reason==='PURGE_CANCELLED').length,1);
  }finally{await f.close()}
 });

 test(`B2-advanced ${engine}: same ID cannot be reserved twice across competing preview confirmations`,async()=>{
  const f=await fixture(engine);try{
   await seed(f,2);
   const a=await f.service().preview(OWNER,GROUP,{limit:2});
   const b=await f.service().preview(OWNER,GROUP,{limit:2});
   const results=await Promise.allSettled([f.service().confirm(OWNER,a.id),f.service().confirm(OWNER,b.id)]);
   assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(results.filter(x=>x.status==='rejected').length,1);
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close()}
 });
}

test('B2-advanced: staff cannot self-confirm bulk deletion; owner co-signs with same exact candidate set',async()=>{
 const f=await fixture();try{
  await f.policy.grant(OWNER,STAFF,'chat.manage',GROUP,f.now()+HOUR);
  await seed(f,12);
  const job=await f.service().preview(STAFF,GROUP,{limit:12});
  await assert.rejects(f.service().confirm(STAFF,job.id),/OWNER_APPROVAL_REQUIRED/);
  await f.service().confirm(OWNER,job.id);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.confirmedBy,OWNER);
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});

test('B2-advanced: bulk always requires approval, pinned targets never enter plans, daily 50-attempt cap',async()=>{
 const f=await fixture();try{
  await seed(f,60);
  for(let segment=0;segment<2;segment++){
   const job=await f.service().preview(OWNER,GROUP,{limit:25,beforeMessageId:segment?36:undefined});
   await f.service().confirm(OWNER,job.id);
   for(let i=0;i<25;i++)assert.equal((await f.service().dispatchNext(job.id)).status,'ACKNOWLEDGED');
  }
  const pending=await f.service().preview(OWNER,GROUP,{limit:10,beforeMessageId:11});
  await assert.rejects(f.service().confirm(OWNER,pending.id),/DAILY_PURGE_LIMIT/);
  assert.equal(f.gateway.calls.length,50);
 }finally{await f.close()}
});

test('B2-advanced: explicit schema 7 to 8 migration preserves all B4 receipts/education while adding empty purge state',async()=>{
 const f=await fixture();try{
  const before=await f.store.snapshot();
  await writeFile(f.file,JSON.stringify({...before,schemaVersion:7,rollingMessageMeta:undefined,purgeJobs:undefined}));
  const upgraded=await new BotStore(f.file).snapshot();
  assert.equal(upgraded.schemaVersion,8);
  assert.deepEqual(upgraded.historicalPublications,before.historicalPublications);
  assert.deepEqual(upgraded.deliveries,before.deliveries);
  assert.deepEqual(upgraded.educationResources,before.educationResources);
  assert.deepEqual(upgraded.rollingMessageMeta,[]);
  assert.deepEqual(upgraded.purgeJobs,[]);
 }finally{await f.close()}
});
