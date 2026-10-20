import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
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
 const observe=async(messageId:number,extra:Partial<Parameters<ReturnType<typeof service>['observe']>[0]>={})=>{
  const m:Parameters<ReturnType<typeof service>['observe']>[0]={
    chatId:GROUP,messageId,sentAt:time-HOUR,observedAt:time,senderKind:'USER',senderId:'300',
    contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false,
    ...extra
  };
  if(m.senderKind==='UNKNOWN')delete m.senderId;
  return service().observe(m);
 };
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
   await f.observe(6,{senderKind:'UNKNOWN'});
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
   const job=await f.service().preview(OWNER,GROUP,{limit:25,...(segment?{beforeMessageId:36}:{})});
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

test('B2-advanced: cannot delete metadata that expires while awaiting bot rights, even if gateway says yes',async()=>{
 const f=await fixture();try{
  await f.observe(1,{sentAt:f.now()-48*HOUR+1000});
  const job=await f.service().preview(OWNER,GROUP,{limit:1});
  await f.service().confirm(OWNER,job.id);
  f.gateway.canDelete=async()=>{f.setNow(f.now()+2000);return true;};
  assert.equal((await f.service().dispatchNext(job.id)).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,0);
  const state=await f.store.snapshot();
  assert.equal(state.purgeJobs[0]!.items[0]!.status,'QUEUED');
  assert.equal(state.purgeJobs[0]!.status,'PAUSED');
  assert.equal(state.rollingMessageMeta.length,0);
 }finally{await f.close()}
});

test('B2-advanced: pinned flags remain protected after a later update tries to unpin',async()=>{
 const f=await fixture();try{
  await f.observe(1,{pinned:true});
  await f.observe(1,{pinned:false});
  assert.equal((await f.store.snapshot()).rollingMessageMeta[0]!.pinned,true);
  await assert.rejects(f.service().preview(OWNER,GROUP,{limit:1}),/NO_ELIGIBLE_OBSERVED_MESSAGES/);
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});

test('B2-advanced: legacy orphaned SENDING job becomes UNKNOWN, cannot be automatically replayed',async()=>{
 const f=await fixture();try{
  await seed(f,2);
  const job=await f.service().preview(OWNER,GROUP,{limit:2});
  await f.service().confirm(OWNER,job.id);
  await f.store.transaction(s=>{const i=s.purgeJobs[0]!.items[0]!;
    i.status='SENDING';i.attemptId='legacy-attempt';delete i.leaseUntil;});
  assert.equal(await f.service().recoverPending(),1);
  assert.equal((await f.service().dispatchNext(job.id)).status,'BLOCKED_UNKNOWN');
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.attemptId,'legacy-attempt');
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});

test('B2-advanced: active leased attempt must not be quarantined by another recovery instance',async()=>{
 const f=await fixture('sqlite');try{
  await seed(f,1);
  const job=await f.service().preview(OWNER,GROUP,{limit:1});
  await f.service().confirm(OWNER,job.id);
  let start!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>start=r),gate=new Promise<void>(r=>release=r);
  f.gateway.canDelete=async()=>{start();await gate;return true;};
  const pending=f.service().dispatchNext(job.id);
  await ready;
  try{
   assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'SENDING');
   assert.equal(await f.service().recoverPending(),0);
  }finally{release();}
  assert.equal((await pending).status,'ACKNOWLEDGED');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.close()}
});

test('B2-advanced: bulk confirmed yesterday cannot break today daily cap on later dispatch',async()=>{
 const f=await fixture();try{
  await seed(f,51);
  const yesterday=await f.service().preview(OWNER,GROUP,{limit:1});
  await f.service().confirm(OWNER,yesterday.id);
  f.setNow(f.now()+DAY);
  const a=await f.service().preview(OWNER,GROUP,{limit:25,beforeMessageId:51});
  await f.service().confirm(OWNER,a.id);
  const b=await f.service().preview(OWNER,GROUP,{limit:25,beforeMessageId:26});
  await f.service().confirm(OWNER,b.id);
  for(let i=0;i<25;i++)assert.equal((await f.service().dispatchNext(a.id)).status,'ACKNOWLEDGED');
  for(let i=0;i<25;i++)assert.equal((await f.service().dispatchNext(b.id)).status,'ACKNOWLEDGED');
  assert.equal((await f.service().dispatchNext(yesterday.id)).status,'BLOCKED_DAILY_LIMIT');
  assert.equal(f.gateway.calls.length,50);
 }finally{await f.close()}
});

test('B2-advanced: a second confirm after cancelling never recreates the same deletion reservation',async()=>{
 const f=await fixture();try{
  await seed(f,3);
  const first=await f.service().preview(OWNER,GROUP,{limit:3});
  await f.service().confirm(OWNER,first.id);
  await f.service().cancel(OWNER,first.id);
  const second=await f.service().preview(OWNER,GROUP,{limit:3});
  await assert.rejects(f.service().confirm(OWNER,second.id),/PURGE_ID_ALREADY_RESERVED/);
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});

test('B2-advanced: revoking approved group after preview prevents confirmation and future deletion',async()=>{
 const f=await fixture();try{
  await seed(f,1);
  const job=await f.service().preview(OWNER,GROUP,{limit:1});
  await f.policy.revokeChat(OWNER,GROUP);
  await assert.rejects(f.service().confirm(OWNER,job.id),/MANAGE_DENIED/);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.status,'PREVIEW');
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});

test('B2-advanced: two independent SQLite workers cannot delete the same observed ID twice',async()=>{
 const f=await fixture('sqlite');try{
  await seed(f,1);
  const job=await f.service().preview(OWNER,GROUP,{limit:1});
  await f.service().confirm(OWNER,job.id);
  const exec=promisify(execFile);
  const file=new URL('./b2-purge-worker.js',import.meta.url).pathname;
  const out=await Promise.all([
   exec(process.execPath,[file,f.file,job.id]),
   exec(process.execPath,[file,f.file,job.id])
  ]);
  const calls=out.map(x=>Number(x.stdout.trim().split(':').at(-1)));
  assert.equal(calls.reduce((a,b)=>a+b,0),1);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'ACKNOWLEDGED');
 }finally{await f.close()}
});

test('B2-advanced: cancellation while canDelete is waiting precludes a late outbound request',async()=>{
 const f=await fixture('sqlite');try{
  await seed(f,2);
  const job=await f.service().preview(OWNER,GROUP,{limit:2});
  await f.service().confirm(OWNER,job.id);
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  f.gateway.canDelete=async()=>{entered();await gate;return true;};
  const sending=f.service().dispatchNext(job.id);
  await waiting;
  try {
   const i=(await f.store.snapshot()).purgeJobs[0]!.items[0]!;
   assert.equal(i.status,'SENDING');
   await f.service().cancel(OWNER,job.id);
  }finally{release();}
  assert.equal((await sending).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,0);
  const jobState=(await f.store.snapshot()).purgeJobs[0]!;
  assert.equal(jobState.status,'CANCELLED');
  assert.equal(jobState.items[0]!.status,'CANCELLED');
  assert.equal(jobState.items[1]!.status,'CANCELLED');
 }finally{await f.close()}
});

for(const engine of ['json','sqlite'] as const){
 test(`B2-advanced ${engine}: confirmed 429 queues exact item with durable cooldown, requires explicit later dispatch`,async()=>{
  const f=await fixture(engine);try{
   await seed(f,2);
   const job=await f.service().preview(OWNER,GROUP,{limit:2});
   await f.service().confirm(OWNER,job.id);
   f.gateway.outcome={status:'RATE_LIMITED',retryAfterMs:2000};
   assert.equal((await f.service().dispatchNext(job.id)).status,'RATE_LIMITED');
   let current=(await f.store.snapshot()).purgeJobs[0]!;
   assert.equal(current.items[0]!.status,'QUEUED');
   assert.equal(current.items[0]!.attemptId,undefined);
   assert.equal(current.rateLimitedUntil,f.now()+2000);
   assert.equal(f.gateway.calls.length,1);
   assert.equal((await f.service().dispatchNext(job.id)).status,'RATE_LIMITED');
   assert.equal(f.gateway.calls.length,1);
   f.setNow(f.now()+2000);
   f.gateway.outcome='ACKNOWLEDGED';
   assert.equal((await f.service().dispatchNext(job.id)).status,'ACKNOWLEDGED');
   current=(await f.store.snapshot()).purgeJobs[0]!;
   assert.equal(current.items[0]!.status,'ACKNOWLEDGED');
   assert.equal(current.items[1]!.status,'QUEUED');
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='PURGE_ATTEMPT_DURABLY_RECORDED').length,2);
   assert.equal(f.gateway.calls.length,2);
  }finally{await f.close()}
 });

 test(`B2-advanced ${engine}: 429 cooldown on one job fences other jobs in the same chat`,async()=>{
  const f=await fixture(engine);try{
   await seed(f,2);
   const a=await f.service().preview(OWNER,GROUP,{limit:1});
   const b=await f.service().preview(OWNER,GROUP,{limit:1,beforeMessageId:2});
   await f.service().confirm(OWNER,a.id);
   await f.service().confirm(OWNER,b.id);
   f.gateway.outcome={status:'RATE_LIMITED',retryAfterMs:3000};
   assert.equal((await f.service().dispatchNext(a.id)).status,'RATE_LIMITED');
   f.gateway.outcome='ACKNOWLEDGED';
   assert.equal((await f.service().dispatchNext(b.id)).status,'RATE_LIMITED');
   assert.equal(f.gateway.calls.length,1);
   f.setNow(f.now()+3000);
   assert.equal((await f.service().dispatchNext(b.id)).status,'ACKNOWLEDGED');
   assert.equal((await f.service().dispatchNext(a.id)).status,'ACKNOWLEDGED');
   assert.equal(f.gateway.calls.length,3);
  }finally{await f.close()}
 });
}

test('B2-advanced: malformed or untrusted 429 payload is quarantined UNKNOWN, never auto-replayed',async()=>{
 const f=await fixture();try{
  await seed(f,2);
  const job=await f.service().preview(OWNER,GROUP,{limit:2});
  await f.service().confirm(OWNER,job.id);
  f.gateway.outcome={status:'RATE_LIMITED',retryAfterMs:-100} as never;
  assert.equal((await f.service().dispatchNext(job.id)).status,'UNKNOWN_OUTCOME');
  assert.equal((await f.service().dispatchNext(job.id)).status,'BLOCKED_UNKNOWN');
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'UNKNOWN_OUTCOME');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.close()}
});

test('B2-advanced: invalid gateway status must not become an accepted deletion receipt',async()=>{
 const f=await fixture();try{
  await seed(f,1);
  const job=await f.service().preview(OWNER,GROUP,{limit:1});
  await f.service().confirm(OWNER,job.id);
  f.gateway.outcome='SENT_BUT_UNTRUSTED' as never;
  assert.equal((await f.service().dispatchNext(job.id)).status,'UNKNOWN_OUTCOME');
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'UNKNOWN_OUTCOME');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.close()}
});

test('B2-advanced: repeated explicit 429 requests count every attempt toward immutable UTC daily quota',async()=>{
 const f=await fixture('sqlite');try{
  await seed(f,1);
  const job=await f.service().preview(OWNER,GROUP,{limit:1});
  await f.service().confirm(OWNER,job.id);
  f.gateway.outcome={status:'RATE_LIMITED',retryAfterMs:1};
  for(let i=0;i<50;i++){
   assert.equal((await f.service().dispatchNext(job.id)).status,'RATE_LIMITED');
   f.setNow(f.now()+1);
  }
  f.gateway.outcome='ACKNOWLEDGED';
  assert.equal((await f.service().dispatchNext(job.id)).status,'BLOCKED_DAILY_LIMIT');
  assert.equal(f.gateway.calls.length,50);
  const s=await f.store.snapshot();
  assert.equal(s.audit.filter(a=>a.reason==='PURGE_ATTEMPT_DURABLY_RECORDED').length,50);
  assert.equal(s.purgeJobs[0]!.items[0]!.status,'QUEUED');
 }finally{await f.close()}
});

test('B2-advanced: paused staff rights and source changes are revalidated after 429 delay',async()=>{
 const f=await fixture('sqlite');try{
  await f.policy.grant(OWNER,STAFF,'chat.manage',GROUP,f.now()+DAY);
  await seed(f,2);
  const a=await f.service().preview(STAFF,GROUP,{limit:1});
  await f.service().confirm(STAFF,a.id);
  f.gateway.outcome={status:'RATE_LIMITED',retryAfterMs:1000};
  await f.service().dispatchNext(a.id);
  await f.policy.revokeGrant(OWNER,STAFF,'chat.manage',GROUP);
  f.setNow(f.now()+1000);
  f.gateway.outcome='ACKNOWLEDGED';
  assert.equal((await f.service().dispatchNext(a.id)).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,1);
  const b=await f.service().preview(OWNER,GROUP,{limit:1,beforeMessageId:2});
  await f.service().confirm(OWNER,b.id);
  await f.observe(1,{pinned:true});
  assert.equal((await f.service().dispatchNext(b.id)).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.close()}
});

test('B2-advanced: 429 cooldown persists after SQLite service restart and canceled plan cannot dispatch',async()=>{
 const f=await fixture('sqlite');try{
  await seed(f,1);
  const job=await f.service().preview(OWNER,GROUP,{limit:1});
  await f.service().confirm(OWNER,job.id);
  f.gateway.outcome={status:'RATE_LIMITED',retryAfterMs:1800};
  assert.equal((await f.service().dispatchNext(job.id)).status,'RATE_LIMITED');
  assert.equal((await f.service().dispatchNext(job.id)).status,'RATE_LIMITED');
  await f.service().cancel(OWNER,job.id);
  f.setNow(f.now()+1800);
  f.gateway.outcome='ACKNOWLEDGED';
  assert.equal((await f.service().dispatchNext(job.id)).status,'CANCELLED');
  assert.equal(f.gateway.calls.length,1);
  assert.equal((await f.store.snapshot()).purgeJobs[0]!.items[0]!.status,'CANCELLED');
 }finally{await f.close()}
});
