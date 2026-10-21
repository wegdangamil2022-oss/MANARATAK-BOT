import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {PlatformCatalogPreviewService} from '../src/platform-catalog-preview.js';

const OWNER='100',STUDENT='300';
const candidate=(revision=1)=>({
 id:'china-grant',revision,scope:'private',publication:'PUBLISHED',
 title:'منحة جامعة الصين',university:'جامعة الصين',cycle:'2027',degree:'Bachelor'
});
const page=(revision=1)=>({
 schema:'manaratak-readonly-catalog-v1',records:[candidate(revision)],nextCursor:null
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-b5-local-publish-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 await education.createCategory(OWNER,{id:'grants',scope:'private',title:'المنح الدراسية',order:0});
 await education.createCategory(OWNER,{id:'archived-cat',scope:'private',title:'أرشيف',order:1});
 await education.createCategory(OWNER,{id:'child',scope:'private',title:'فرعي',order:2,parentId:'grants'});
 let revision=1,calls=0,onRead:(()=>Promise<void>)|undefined;
 const service=new PlatformCatalogPreviewService(store,policy,{fetchPage:async()=>{
  calls++;if(onRead)await onRead();return page(revision);
 }});
 const staged=async()=>{
  const preview=await service.preview(OWNER);
  if(preview.status!=='PREVIEW')throw Error('TEST_PREVIEW_UNAVAILABLE');
  const first=await service.stage(OWNER,'china-grant',preview.fingerprint);
  if(first.status!=='STAGED')throw Error('TEST_STAGE_UNAVAILABLE');
  const second=await service.review(OWNER,'china-grant',first.entry.digest);
  if(second.status!=='REVIEWED')throw Error('TEST_REVIEW_UNAVAILABLE');
  return first.entry.digest;
 };
 return {store,policy,education,service,staged,setRevision:(n:number)=>{revision=n;},
  setRead:(fn:()=>Promise<void>)=>{onRead=fn;},calls:()=>calls,
  close:()=>rm(dir,{force:true,recursive:true})};
}

for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': reviewing alone exposes nothing; explicit category approval still exposes nothing; separate publish makes one local private resource',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.staged();
   assert.deepEqual(await f.education.listResources(STUDENT,'private','grants'),[]);
   const approval=await f.service.approveForLocal(OWNER,'china-grant',digest,'grants');
   assert.equal(approval.status,'APPROVED');
   assert.deepEqual(await f.education.listResources(STUDENT,'private','grants'),[]);
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'APPROVED_FOR_LOCAL');
   const publication=await f.service.publishLocally(OWNER,'china-grant',digest,'grants');
   assert.equal(publication.status,'PUBLISHED');
   if(publication.status!=='PUBLISHED')throw Error('EXPECTED_PUBLICATION');
   assert.equal(publication.resource.title,'منحة جامعة الصين');
   assert.equal(publication.resource.seats,null);
   assert.equal(publication.resource.scope,'private');
   assert.equal(publication.resource.categoryId,'grants');
   assert.equal(publication.resource.reviewedBy,OWNER);
   const visible=await f.education.listResources(STUDENT,'private','grants');
   assert.equal(visible.length,1);
   assert.equal(visible[0]?.id,publication.resource.id);
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'PUBLISHED_LOCALLY');
   const again=await f.service.publishLocally(OWNER,'china-grant',digest,'grants');
   assert.equal(again.status,'PUBLISHED');
   assert.equal((await f.store.snapshot()).educationResources.length,1);
   assert.deepEqual((await f.store.snapshot()).campaigns,[]);
   assert.deepEqual((await f.store.snapshot()).deliveries,[]);
   assert.deepEqual((await f.store.snapshot()).importRuns,[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': unreviewed external metadata cannot be approved or published even with a valid digest',async()=>{
  const f=await fixture(engine);try{
   const view=await f.service.preview(OWNER);
   if(view.status!=='PREVIEW')throw Error('TEST');
   const saved=await f.service.stage(OWNER,'china-grant',view.fingerprint);
   if(saved.status!=='STAGED')throw Error('TEST');
   assert.equal((await f.service.approveForLocal(OWNER,'china-grant',saved.entry.digest,'grants')).status,'STALE');
   assert.equal((await f.service.publishLocally(OWNER,'china-grant',saved.entry.digest,'grants')).status,'STALE');
   assert.deepEqual((await f.store.snapshot()).educationResources,[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': edited or removed external source invalidates prior approval AND deferred publish',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.staged();
   f.setRevision(2);
   assert.equal((await f.service.approveForLocal(OWNER,'china-grant',digest,'grants')).status,'STALE');
   f.setRevision(1);
   assert.equal((await f.service.approveForLocal(OWNER,'china-grant',digest,'grants')).status,'APPROVED');
   f.setRevision(3);
   assert.equal((await f.service.publishLocally(OWNER,'china-grant',digest,'grants')).status,'STALE');
   assert.deepEqual((await f.store.snapshot()).educationResources,[]);
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'APPROVED_FOR_LOCAL');
  }finally{await f.close();}
 });
 test('B5 '+engine+': old, invalid, disabled or cross-group category cannot be approved or published',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.staged();
   await f.education.setCategoryEnabled(OWNER,'archived-cat',false);
   for(const id of ['absent','archived-cat','-100987']){
    assert.notEqual((await f.service.approveForLocal(OWNER,'china-grant',digest,id)).status,'APPROVED');
   }
   assert.equal((await f.service.approveForLocal(OWNER,'china-grant',digest,'child')).status,'APPROVED');
   assert.equal((await f.service.publishLocally(OWNER,'china-grant',digest,'grants')).status,'STALE');
   await f.education.setCategoryEnabled(OWNER,'grants',false);
   assert.equal((await f.service.publishLocally(OWNER,'china-grant',digest,'child')).status,'STALE');
   assert.deepEqual((await f.store.snapshot()).educationResources,[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': student, granted delegate and switched-off dashboard cannot approve/publish',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.staged(),before=f.calls();
   assert.equal((await f.service.approveForLocal(STUDENT,'china-grant',digest,'grants')).status,'DENIED');
   assert.equal((await f.service.publishLocally(STUDENT,'china-grant',digest,'grants')).status,'DENIED');
   await f.policy.grant(OWNER,'200','content.publish','private',Date.now()+60000);
   assert.equal((await f.service.approveForLocal('200','china-grant',digest,'grants')).status,'DENIED');
   assert.equal(f.calls(),before);
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.service.approveForLocal(OWNER,'china-grant',digest,'grants')).status,'DENIED');
   assert.equal((await f.service.publishLocally(OWNER,'china-grant',digest,'grants')).status,'DENIED');
   assert.equal(f.calls(),before);
  }finally{await f.close();}
 });
 test('B5 '+engine+': two concurrent explicit publish calls cannot duplicate resources',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.staged();
   assert.equal((await f.service.approveForLocal(OWNER,'china-grant',digest,'grants')).status,'APPROVED');
   const results=await Promise.all([
    f.service.publishLocally(OWNER,'china-grant',digest,'grants'),
    f.service.publishLocally(OWNER,'china-grant',digest,'grants')]);
   assert.deepEqual(results.map(r=>r.status),['PUBLISHED','PUBLISHED']);
   assert.equal((await f.store.snapshot()).educationResources.length,1);
  }finally{await f.close();}
 });
 test('B5 '+engine+': archived resource is never resurrected even when external source remains unchanged',async()=>{
  const f=await fixture(engine);try{
   const digest=await f.staged();
   await f.service.approveForLocal(OWNER,'china-grant',digest,'grants');
   const result=await f.service.publishLocally(OWNER,'china-grant',digest,'grants');
   if(result.status!=='PUBLISHED')throw Error('TEST');
   await f.education.archiveResource(OWNER,result.resource.id);
   assert.equal((await f.service.publishLocally(OWNER,'china-grant',digest,'grants')).status,'STALE');
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'ARCHIVED');
   assert.deepEqual(await f.education.listResources(STUDENT,'private','grants'),[]);
  }finally{await f.close();}
 });
}
test('B5 owner dashboard revoked during external read rejects approval without changing queue',async()=>{
 const f=await fixture('sqlite');try{
  const digest=await f.staged();
  let ready!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>ready=resolve);
  const paused=new Promise<void>(resolve=>release=resolve);
  f.setRead(async()=>{ready();await paused;});
  const pending=f.service.approveForLocal(OWNER,'china-grant',digest,'grants');
  await entered;
  await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
  release();
  assert.equal((await pending).status,'DENIED');
  assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'REVIEWED_METADATA_ONLY');
 }finally{await f.close();}
});
test('B5 persisted malformed approved/published queue states are rejected before any JSON or SQLite commit',async()=>{
 for(const engine of ['json','sqlite'] as const){
  const f=await fixture(engine);try{
   await assert.rejects(f.store.transaction(s=>{
    s.platformReviewQueue=[{sourceId:'fake',sourceRevision:1,title:'a',university:'b',
     cycle:'2027',degree:'Bachelor',digest:'f'.repeat(64),status:'PUBLISHED_LOCALLY',
     stagedBy:OWNER,stagedAt:1}] as never;
   }),/Unsupported state schema/);
  }finally{await f.close();}
 }
});
