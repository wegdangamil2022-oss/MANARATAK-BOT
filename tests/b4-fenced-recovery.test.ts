import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {PublicationService,FakePublicationGateway} from '../src/publishing.js';
import {CampaignMultipartService} from '../src/campaign-multipart.js';

const OWNER='100',SOURCE='-100',DEST='-200',EDITOR='201';
const LONG='إعلان منحة معتمد للمراجعة والأرشفة. '.repeat(210);
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-b4-fenced-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json'), store=new BotStore(file,{engine});
 let now=1000;
 const clock=()=>now,policy=new Policy(store,OWNER,clock),education=new EducationService(store,policy,clock);
 const gateway=new FakePublicationGateway();
 const publishing=()=>new PublicationService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),gateway,clock);
 const parts=()=>new CampaignMultipartService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),{
  canPost:dest=>gateway.canPost(dest),sendPart:req=>gateway.send(req.destination,req.part.text,req.attemptId),
  verifyReceipt:r=>gateway.verifyReceipt(r)
 },clock);
 await policy.approveChat(OWNER,SOURCE,['navigation']);await policy.approveChat(OWNER,DEST,['publishing']);
 await education.createCategory(OWNER,{id:'grants',scope:SOURCE,title:'المنح',order:1});
 const batch=await education.submitText(OWNER,SOURCE,'ADMIN_WEB','csv','approved.csv','title,university\nGrant,University');
 await education.approveCandidate(OWNER,batch.id,0,'grants');
 const resource=await education.publishCandidate(OWNER,batch.id,0,'grants');
 return {dir,file,store,policy,education,gateway,publishing,parts,resource,now:()=>now,setNow:(n:number)=>{now=n},
  close:()=>rm(dir,{force:true,recursive:true})};
}
async function setup(f:Awaited<ReturnType<typeof fixture>>,multipart:boolean){
 if(multipart)await f.education.setPublicationText(OWNER,f.resource.id,LONG);
 const campaign=await f.publishing().draft(OWNER,SOURCE,DEST,[f.resource.id]);
 await f.publishing().approve(OWNER,campaign.id);
 return campaign;
}
function gate(){
 let ready!:()=>void,release!:()=>void;
 return {entered:new Promise<void>(r=>ready=r),blocked:new Promise<void>(r=>release=r),
  enter:()=>ready(),release:()=>release()};
}

for(const engine of ['json','sqlite'] as const){
 for(const kind of ['single','multipart'] as const){
  test(`B4 fenced ${engine}/${kind}: another recovery worker never quarantines an active gateway authorization lease`,async()=>{
   const f=await fixture(engine);try{
    const c=await setup(f,kind==='multipart'),hold=gate();
    f.gateway.canPost=async()=>{hold.enter();await hold.blocked;return true;};
    const sending=f.publishing().dispatchNext(c.id);
    await hold.entered;
    try{
      const pending=(await f.store.snapshot()).deliveries[0]!;
      const attempt=kind==='multipart'?pending.multipart!.parts[0]!:pending;
      assert.equal(attempt.status,'SENDING');
      assert.ok(attempt.leaseUntil && attempt.leaseUntil>f.now());
      assert.equal(await f.publishing().recoverPending(),0);
      assert.equal((await f.store.snapshot()).deliveries[0]!.multipart?.parts[0]?.status??(await f.store.snapshot()).deliveries[0]!.status,'SENDING');
    }finally{hold.release();}
    assert.equal((await sending).status,'SENT');
    assert.equal(f.gateway.calls.length,1);
   }finally{await f.close();}
  });

  test(`B4 fenced ${engine}/${kind}: expired attempt becomes UNKNOWN, late worker cannot send after fencing`,async()=>{
   const f=await fixture(engine);try{
    const c=await setup(f,kind==='multipart'),hold=gate();
    f.gateway.canPost=async()=>{hold.enter();await hold.blocked;return true;};
    const sending=f.publishing().dispatchNext(c.id);await hold.entered;
    try{
     const d=(await f.store.snapshot()).deliveries[0]!;
     const inFlight=kind==='multipart'?d.multipart!.parts[0]!:d;
     assert.ok(inFlight.leaseUntil && inFlight.leaseUntil>f.now());
     f.setNow(inFlight.leaseUntil!+1);
     assert.equal(await f.publishing().recoverPending(),1);
     assert.equal((await f.store.snapshot()).deliveries[0]!.multipart?.parts[0]?.status??(await f.store.snapshot()).deliveries[0]!.status,'UNKNOWN_OUTCOME');
    }finally{hold.release();}
    assert.equal((await sending).status,'BLOCKED');
    assert.equal(f.gateway.calls.length,0);
   }finally{await f.close();}
  });
 }
}

test('B4 fenced: expired attempted send must be stopped even if no recovery worker was running',async()=>{
 const f=await fixture();try{
  const c=await setup(f,false),hold=gate();
  f.gateway.canPost=async()=>{hold.enter();await hold.blocked;return true;};
  const sending=f.publishing().dispatchNext(c.id);await hold.entered;
  const d=(await f.store.snapshot()).deliveries[0]!;
  f.setNow(d.leaseUntil!+1);hold.release();
  assert.equal((await sending).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,0);
  assert.equal((await f.store.snapshot()).deliveries[0]!.status,'UNKNOWN_OUTCOME');
 }finally{await f.close();}
});

test('B4 fenced: legacy in-flight delivery with no lease is conservatively quarantined on recovery',async()=>{
 const f=await fixture();try{
  const c=await setup(f,true);
  await f.store.transaction(s=>{
   const part=s.deliveries[0]!.multipart!.parts[0]!;
   part.status='SENDING';part.attemptId='legacy-attempt';delete part.leaseUntil;
  });
  assert.equal(await f.publishing().recoverPending(),1);
  assert.equal((await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status,'UNKNOWN_OUTCOME');
  assert.equal((await f.publishing().dispatchNext(c.id)).status,'BLOCKED');
 }finally{await f.close();}
});

test('B4 auth: destination-only editor cannot retry a failed part without source publication rights',async()=>{
 const f=await fixture();try{
  const c=await setup(f,true);
  f.gateway.outcome='FAILED_CONFIRMED';
  assert.equal((await f.publishing().dispatchNext(c.id)).status,'FAILED_CONFIRMED');
  await f.policy.grant(OWNER,EDITOR,'content.publish',DEST,20_000);
  await assert.rejects(f.parts().retryFailed(EDITOR,c.id,f.resource.id,0),/PUBLISH_DENIED/);
  assert.equal((await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status,'FAILED_CONFIRMED');
  await f.policy.grant(OWNER,EDITOR,'content.publish',SOURCE,20_000);
  await f.parts().retryFailed(EDITOR,c.id,f.resource.id,0);
  assert.equal((await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status,'QUEUED');
 }finally{await f.close();}
});

test('B4 auth: destination-only editor cannot reconcile UNKNOWN part, even with valid gateway receipt',async()=>{
 const f=await fixture();try{
  const c=await setup(f,true);
  f.gateway.throwAfterSend=true;
  assert.equal((await f.publishing().dispatchNext(c.id)).status,'UNKNOWN_OUTCOME');
  const d=(await f.store.snapshot()).deliveries[0]!,part=d.multipart!.parts[0]!;
  const evidence=f.gateway.getReceipt(part.attemptId!)!;
  await f.policy.grant(OWNER,EDITOR,'content.publish',DEST,20_000);
  await assert.rejects(f.parts().reconcileUnknown(EDITOR,c.id,f.resource.id,0,evidence),/PUBLISH_DENIED/);
  assert.equal((await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status,'UNKNOWN_OUTCOME');
  await f.policy.grant(OWNER,EDITOR,'content.publish',SOURCE,20_000);
  assert.equal((await f.parts().reconcileUnknown(EDITOR,c.id,f.resource.id,0,evidence)).status,'SENT');
 }finally{await f.close();}
});

const exec=promisify(execFile);
async function recoverInWorker(file:string,campaignId:string):Promise<number>{
 const path=new URL('./b4-sqlite-worker.js',import.meta.url).pathname;
 const {stdout}=await exec(process.execPath,[path,'recover',file,campaignId]);
 return Number(stdout.trim().replace(/^RECOVERED:/,''));
}

test('B4 fenced sqlite: separate process recovery preserves a send held at the gateway',async()=>{
 const f=await fixture('sqlite');try{
  const c=await setup(f,false),hold=gate();
  f.gateway.canPost=async()=>{hold.enter();await hold.blocked;return true;};
  const sending=f.publishing().dispatchNext(c.id);
  await hold.entered;
  try{
   assert.equal(await recoverInWorker(f.file,c.id),0);
   const active=(await f.store.snapshot()).deliveries[0]!;
   assert.equal(active.status,'SENDING');
   assert.ok(active.leaseUntil && active.leaseUntil>f.now());
  }finally{hold.release();}
  assert.equal((await sending).status,'SENT');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.close();}
});

test('B4 fenced sqlite: expired attempt quarantined by another process fences the delayed sender',async()=>{
 const f=await fixture('sqlite');try{
  const c=await setup(f,true),hold=gate();
  f.gateway.canPost=async()=>{hold.enter();await hold.blocked;return true;};
  const sending=f.publishing().dispatchNext(c.id);await hold.entered;
  try{
   const d=(await f.store.snapshot()).deliveries[0]!;
   f.setNow(d.multipart!.parts[0]!.leaseUntil!+1);
   // Child worker has an independent mock clock at 1000: explicitly persist the expired lease.
   await f.store.transaction(s=>{s.deliveries[0]!.multipart!.parts[0]!.leaseUntil=999;});
   assert.equal(await recoverInWorker(f.file,c.id),1);
   assert.equal((await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status,'UNKNOWN_OUTCOME');
  }finally{hold.release();}
  assert.equal((await sending).status,'BLOCKED');
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close();}
});

test('B4 auth: revoking source publication rights DURING multipart receipt verification prevents reconciliation',async()=>{
 const f=await fixture();try{
  const c=await setup(f,true);
  f.gateway.throwAfterSend=true;
  assert.equal((await f.publishing().dispatchNext(c.id)).status,'UNKNOWN_OUTCOME');
  const part=(await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!;
  const receipt=f.gateway.getReceipt(part.attemptId!)!;
  await f.policy.grant(OWNER,EDITOR,'content.publish',SOURCE,20_000);
  await f.policy.grant(OWNER,EDITOR,'content.publish',DEST,20_000);
  const verify=f.gateway.verifyReceipt.bind(f.gateway);
  f.gateway.verifyReceipt=async r=>{
   await f.policy.revokeGrant(OWNER,EDITOR,'content.publish',SOURCE);
   return verify(r);
  };
  await assert.rejects(f.parts().reconcileUnknown(EDITOR,c.id,f.resource.id,0,receipt),/PUBLISH_DENIED/);
  assert.equal((await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status,'UNKNOWN_OUTCOME');
  assert.equal(f.gateway.calls.length,1);
 }finally{await f.close();}
});
