import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {PublicationService, FakePublicationGateway} from '../src/publishing.js';
import {CampaignMultipartService} from '../src/campaign-multipart.js';
import {planPublicationPreview} from '../src/publication-preview-plan.js';

const OWNER='100', SOURCE='-100', DEST='-200', LONG='معايير منحة موثوقة ومراجعة. '.repeat(250);
type Engine='json'|'sqlite';
async function fixture(engine:Engine,multipart:boolean){
 const dir=await mkdtemp(join(tmpdir(),'b4-part-integrity-'));
 const file=join(dir,engine==='sqlite'?'db.sqlite':'db.json'),store=new BotStore(file,{engine}),clock=()=>1000;
 const policy=new Policy(store,OWNER,clock),education=new EducationService(store,policy,clock);
 const gateway=new FakePublicationGateway(),publication=new PublicationService(store,policy,gateway,clock);
 const parts=new CampaignMultipartService(store,policy,{
  canPost:dest=>gateway.canPost(dest),
  sendPart:request=>gateway.send(request.destination,request.part.text,request.attemptId),
  verifyReceipt:receipt=>gateway.verifyReceipt(receipt)
 },clock);
 await policy.approveChat(OWNER,SOURCE,['navigation']);await policy.approveChat(OWNER,DEST,['publishing']);
 await education.createCategory(OWNER,{id:'grants',scope:SOURCE,title:'المنح',order:1});
 const i=await education.submitText(OWNER,SOURCE,'ADMIN_WEB','csv','approved.csv','title,university\nGrant,University');
 await education.approveCandidate(OWNER,i.id,0,'grants');
 const resource=await education.publishCandidate(OWNER,i.id,0,'grants');
 if(multipart)await education.setPublicationText(OWNER,resource.id,LONG);
 const c=await publication.draft(OWNER,SOURCE,DEST,[resource.id]);
 await publication.approve(OWNER,c.id);
 return {dir,file,store,policy,education,gateway,publication,parts,resource,c,
  close:()=>rm(dir,{force:true,recursive:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(`B4 ${engine}: old approved campaign with missing preview plan must reject a tampered multipart part`,async()=>{
  const f=await fixture(engine,true);try{
   // Simulate an older already-approved campaign that predates stored canonical render plans.
   await f.store.transaction(s=>{
    const preview=s.campaigns[0]!.previews[0]!;
    delete preview.renderPlan;
    const d=s.deliveries[0]!;
    d.status='QUEUED';delete d.multipart;
   });
   await f.parts.stage(OWNER,f.c.id,f.resource.id,planPublicationPreview({text:LONG}));
   await f.store.transaction(s=>{s.deliveries[0]!.multipart!.parts[0]!.payload.text='FORGED CONTENT';});
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'BLOCKED');
   assert.equal(f.gateway.calls.length,0);
   assert.equal((await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status,'QUEUED');
  }finally{await f.close();}
 });

 test(`B4 ${engine}: forged stable fingerprint cannot justify changed part text`,async()=>{
  const f=await fixture(engine,true);try{
   await f.store.transaction(s=>{
    const preview=s.campaigns[0]!.previews[0]!;
    delete preview.renderPlan;
    const d=s.deliveries[0]!;
    d.status='QUEUED';delete d.multipart;
   });
   const plan=planPublicationPreview({text:LONG});
   await f.parts.stage(OWNER,f.c.id,f.resource.id,plan);
   await f.store.transaction(s=>{
    const d=s.deliveries[0]!;
    d.multipart!.fingerprint=plan.fingerprint;
    d.multipart!.parts[0]!.payload.text='هذه جملة ليست من النص الموافق عليه';
   });
   assert.equal((await f.parts.dispatchNext(f.c.id,f.resource.id)).status,'BLOCKED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
}
for(const multipart of [false,true] as const){
 test(`B4 ${multipart?'multipart':'single'}: fake provider SENT with malformed message id must remain UNKNOWN`,async()=>{
  for(const invalid of ['', ' ', ' leading', 'trailing ', 'line\nfeed', '\u202Ereverse', 'x'.repeat(257)]){
   const f=await fixture('json',multipart);try{
    f.gateway.send=async(dest,text,attempt)=>{
     f.gateway.calls.push({destination:dest,text,attemptId:attempt});
     return {status:'SENT',messageId:invalid};
    };
    assert.equal((await f.publication.dispatchNext(f.c.id)).status,'UNKNOWN_OUTCOME');
    const state=await f.store.snapshot(),delivery=state.deliveries[0]!;
    assert.equal(multipart?delivery.multipart!.parts[0]!.status:delivery.status,'UNKNOWN_OUTCOME');
    assert.equal(state.campaigns[0]!.status,'APPROVED');
    assert.equal(f.gateway.calls.length,1);
   }finally{await f.close();}
  }
 });
 test(`B4 ${multipart?'multipart':'single'}: mock verified malformed provider receipt cannot settle UNKNOWN`,async()=>{
  const f=await fixture('json',multipart);try{
   f.gateway.outcome='UNKNOWN_OUTCOME';
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'UNKNOWN_OUTCOME');
   const d=(await f.store.snapshot()).deliveries[0]!;
   const attemptId=multipart?d.multipart!.parts[0]!.attemptId!:d.attemptId!;
   let verificationCalls=0;
   f.gateway.verifyReceipt=async()=>{verificationCalls++;return true;};
   const malformed={destination:DEST,attemptId,messageId:'fake\u202Ereceipt'};
   if(multipart)
    await assert.rejects(f.parts.reconcileUnknown(OWNER,f.c.id,f.resource.id,0,malformed),/RECEIPT_INVALID/);
   else
    await assert.rejects(f.publication.reconcileUnknown(OWNER,d.id,malformed),/UNVERIFIED_EVIDENCE/);
   assert.equal(verificationCalls,0);
   assert.equal(multipart?(await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status:(await f.store.snapshot()).deliveries[0]!.status,'UNKNOWN_OUTCOME');
  }finally{await f.close();}
 });
}

test('B4: legitimate opaque mock message receipts still confirm a single and multi-part campaign',async()=>{
 for(const multipart of [false,true] as const){
  const f=await fixture('sqlite',multipart);try{
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'SENT');
   const d=(await f.store.snapshot()).deliveries[0]!;
   assert.ok(multipart?d.multipart!.parts[0]!.messageId:d.messageId);
   assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 }
});

for(const multipart of [false,true] as const) {
 test(`B4 ${multipart?'multipart':'single'}: duplicate saved reservation fails closed before fake network delivery`,async()=>{
  const f=await fixture('sqlite',multipart);try{
   await f.store.transaction(s=>{
    s.deliveries.push({...structuredClone(s.deliveries[0]!),id:'duplicate-from-broken-legacy'});
   });
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'BLOCKED');
   assert.equal(f.gateway.calls.length,0);
   const state=await f.store.snapshot();
   assert.equal(state.deliveries.length,2);
   assert.equal(multipart?state.deliveries[0]!.multipart!.parts[0]!.status:state.deliveries[0]!.status,
    multipart?'QUEUED':'QUEUED');
  }finally{await f.close();}
 });

 test(`B4 ${multipart?'multipart':'single'}: historical register collision imported after approval blocks send`,async()=>{
  const f=await fixture('json',multipart);try{
   await f.store.transaction(s=>{
    const d=s.deliveries[0]!;
    s.historicalPublications.push({id:'legacy-evidence-replayed',sourceScope:SOURCE,destination:DEST,
     resourceId:d.resourceId,revision:d.revision,status:'UNVERIFIED',
     diagnostic:'OLD_UNVERIFIED',reviewedBy:OWNER,reviewedAt:1000});
   });
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'BLOCKED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });

 test(`B4 ${multipart?'multipart':'single'}: review reservation arriving DURING async canPost fences old sender`,async()=>{
  const f=await fixture('sqlite',multipart);try{
   f.gateway.canPost=async()=>{
    await f.store.transaction(s=>{
     const d=s.deliveries[0]!;
     s.historicalPublications.push({id:'late-history',sourceScope:SOURCE,destination:DEST,
      resourceId:d.resourceId,revision:d.revision,status:'REVIEW_REQUIRED',
      diagnostic:'NOT_CERTIFIED',reviewedBy:OWNER,reviewedAt:1000});
    });
    return true;
   };
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'BLOCKED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
}

for(const multipart of [false,true] as const) {
 test(`B4 ${multipart?'multipart':'single'}: receipt after an in-flight historical collision is quarantined instead of counted SENT`,async()=>{
  const f=await fixture('sqlite',multipart);try{
   f.gateway.send=async(dest,text,attemptId)=>{
    f.gateway.calls.push({destination:dest,text,attemptId});
    await f.store.transaction(s=>{
     const d=s.deliveries[0]!;
     s.historicalPublications.push({id:'collision-mid-network',sourceScope:SOURCE,destination:DEST,
      resourceId:d.resourceId,revision:d.revision,status:'UNVERIFIED',
      diagnostic:'MIGRATED_WHILE_ATTEMPT_STARTED',reviewedBy:OWNER,reviewedAt:1000});
    });
    return {status:'SENT',messageId:'valid-mock-message-200'};
   };
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'UNKNOWN_OUTCOME');
   const d=(await f.store.snapshot()).deliveries[0]!;
   assert.equal(multipart?d.multipart!.parts[0]!.status:d.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,multipart?'BLOCKED':'EMPTY');
   assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 });

 test(`B4 ${multipart?'multipart':'single'}: a historical conflict blocks an explicit retry of confirmed failure`,async()=>{
  const f=await fixture('json',multipart);try{
   f.gateway.outcome='FAILED_CONFIRMED';
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'FAILED_CONFIRMED');
   await f.store.transaction(s=>{
    const d=s.deliveries[0]!;
    s.historicalPublications.push({id:'historical-before-retry',sourceScope:SOURCE,destination:DEST,
     resourceId:d.resourceId,revision:d.revision,status:'MANUALLY_SKIPPED',
     diagnostic:'REVIEWED_OMISSION',reviewedBy:OWNER,reviewedAt:1000});
   });
   if(multipart)
    await assert.rejects(f.parts.retryFailed(OWNER,f.c.id,f.resource.id,0),/DELIVERY_RESERVATION_CONFLICT/);
   else
    await assert.rejects(f.publication.retryConfirmedFailure(OWNER,f.c.id,f.resource.id),/DELIVERY_RESERVATION_CONFLICT/);
   const d=(await f.store.snapshot()).deliveries[0]!;
   assert.equal(multipart?d.multipart!.parts[0]!.status:d.status,'FAILED_CONFIRMED');
   assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 });

 test(`B4 ${multipart?'multipart':'single'}: a newly-imported historical conflict refuses UNKNOWN reconciliation`,async()=>{
  const f=await fixture('sqlite',multipart);try{
   f.gateway.outcome='UNKNOWN_OUTCOME';
   assert.equal((await f.publication.dispatchNext(f.c.id)).status,'UNKNOWN_OUTCOME');
   const d=(await f.store.snapshot()).deliveries[0]!;
   const attemptId=multipart?d.multipart!.parts[0]!.attemptId!:d.attemptId!;
   await f.store.transaction(s=>{
    const d=s.deliveries[0]!;
    s.historicalPublications.push({id:'history-before-reconcile',sourceScope:SOURCE,destination:DEST,
     resourceId:d.resourceId,revision:d.revision,status:'REVIEW_REQUIRED',
     diagnostic:'CONFLICTING_EVIDENCE',reviewedBy:OWNER,reviewedAt:1000});
   });
   f.gateway.verifyReceipt=async()=>true;
   const proof={destination:DEST,attemptId,messageId:'valid-message-400'};
   if(multipart)
    await assert.rejects(f.parts.reconcileUnknown(OWNER,f.c.id,f.resource.id,0,proof),/RECEIPT_INVALID/);
   else
    await assert.rejects(f.publication.reconcileUnknown(OWNER,d.id,proof),/UNVERIFIED_EVIDENCE/);
   const after=(await f.store.snapshot()).deliveries[0]!;
   assert.equal(multipart?after.multipart!.parts[0]!.status:after.status,'UNKNOWN_OUTCOME');
  }finally{await f.close();}
 });
}
