import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {PlatformCatalogPreviewService} from '../src/platform-catalog-preview.js';
import {EducationService} from '../src/education.js';

const OWNER='100',STUDENT='300';
const external=(id='grant-one',revision=1,title='منحة الصين')=>({
 id,revision,scope:'private',publication:'PUBLISHED',title,
 university:'جامعة الصين',cycle:'2027',degree:'Bachelor'
});
const page=(records:unknown[]= [external()])=>({
 schema:'manaratak-readonly-catalog-v1',records,nextCursor:null
});
async function fixture(engine:'json'|'sqlite',get:()=>unknown|Promise<unknown>){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-external-review-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER);
 const service=new PlatformCatalogPreviewService(store,policy,{fetchPage:async()=>get()});
 return {store,policy,service,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': explicit owner stage is durable but never publishes an external scholarship',async()=>{
  const f=await fixture(engine,()=>page());
  try{
   const preview=await f.service.preview(OWNER);
   assert.equal(preview.status,'PREVIEW');
   if(preview.status!=='PREVIEW')return;
   const created=await f.service.stage(OWNER,'grant-one',preview.fingerprint);
   assert.equal(created.status,'STAGED');
   if(created.status!=='STAGED')return;
   assert.equal(created.entry.sourceId,'grant-one');
   assert.equal(created.entry.sourceRevision,1);
   assert.equal(created.entry.status,'UNVERIFIED_EXTERNAL');
   assert.match(created.entry.digest,/^[a-f0-9]{64}$/);
   const s=await f.store.snapshot();
   assert.equal(s.platformReviewQueue?.length,1);
   assert.deepEqual(s.educationResources,[]);
   assert.deepEqual(s.importRuns,[]);
   assert.deepEqual(s.campaigns,[]);
   assert.deepEqual(s.deliveries,[]);
   const again=await f.service.stage(OWNER,'grant-one',preview.fingerprint);
   assert.equal(again.status,'STAGED');
   assert.deepEqual(again,created);
   const reopened=new BotStore(f.store.file,{engine});
   assert.deepEqual((await reopened.snapshot()).platformReviewQueue,s.platformReviewQueue);
   const studentEducation=new EducationService(f.store,f.policy);
   assert.deepEqual(await studentEducation.searchPublishedResources(STUDENT,'منحة'),[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': owner may mark unchanged staged metadata reviewed, still no publication',async()=>{
  const f=await fixture(engine,()=>page());
  try{
   const p=await f.service.preview(OWNER);
   if(p.status!=='PREVIEW')throw Error('missing fixture');
   const staged=await f.service.stage(OWNER,'grant-one',p.fingerprint);
   if(staged.status!=='STAGED')throw Error('missing staged');
   const mark=await f.service.review(OWNER,'grant-one',staged.entry.digest);
   assert.equal(mark.status,'REVIEWED');
   if(mark.status==='REVIEWED'){
    assert.equal(mark.entry.status,'REVIEWED_METADATA_ONLY');
    assert.equal(mark.entry.reviewedBy,OWNER);
   }
   assert.equal((await f.service.review(OWNER,'grant-one',staged.entry.digest)).status,'REVIEWED');
   assert.deepEqual((await f.store.snapshot()).educationResources,[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': source edits invalidate old preview and prevent approving stale saved metadata',async()=>{
  let current=page();
  const f=await fixture(engine,()=>current);
  try{
   const old=await f.service.preview(OWNER);
   if(old.status!=='PREVIEW')throw Error('fixture');
   current=page([external('grant-one',2,'عنوان جديد')]);
   assert.equal((await f.service.stage(OWNER,'grant-one',old.fingerprint)).status,'STALE');
   const now=await f.service.preview(OWNER);
   if(now.status!=='PREVIEW')throw Error('fixture');
   const staged=await f.service.stage(OWNER,'grant-one',now.fingerprint);
   if(staged.status!=='STAGED')throw Error('fixture');
   current=page([external('grant-one',3,'تحرير آخر')]);
   assert.equal((await f.service.review(OWNER,'grant-one',staged.entry.digest)).status,'STALE');
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'UNVERIFIED_EXTERNAL');
   assert.equal((await f.service.stage(OWNER,'grant-one',now.fingerprint)).status,'STALE');
   assert.deepEqual((await f.store.snapshot()).educationResources,[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': inconsistent repeated external source cannot silently overwrite an existing staged record',async()=>{
  let current=page();
  const f=await fixture(engine,()=>current);
  try{
   const first=await f.service.preview(OWNER);
   if(first.status!=='PREVIEW')throw Error('fixture');
   assert.equal((await f.service.stage(OWNER,'grant-one',first.fingerprint)).status,'STAGED');
   current=page([external('grant-one',2,'مصدر معدل')]);
   const changed=await f.service.preview(OWNER);
   if(changed.status!=='PREVIEW')throw Error('fixture');
   assert.equal((await f.service.stage(OWNER,'grant-one',changed.fingerprint)).status,'STALE');
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.sourceRevision,1);
  }finally{await f.close();}
 });
 test('B5 '+engine+': unauthorized student and disabled dashboard never call provider or touch queue',async()=>{
  let calls=0;
  const f=await fixture(engine,()=>{calls++;return page();});
  try{
   const denied=await f.service.stage(STUDENT,'grant-one','0'.repeat(64));
   assert.equal(denied.status,'DENIED');
   assert.equal((await f.service.review(STUDENT,'grant-one','0'.repeat(64))).status,'DENIED');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.service.stage(OWNER,'grant-one','0'.repeat(64))).status,'DENIED');
   assert.equal((await f.service.review(OWNER,'grant-one','0'.repeat(64))).status,'DENIED');
   assert.equal(calls,0);
   assert.deepEqual((await f.store.snapshot()).platformReviewQueue??[],[]);
  }finally{await f.close();}
 });
}
test('B5 stage refuses forged source IDs, stale/invalid fingerprints, malformed provider pages, and missing rows',async()=>{
 const f=await fixture('sqlite',()=>page());
 try{
  const p=await f.service.preview(OWNER);
  if(p.status!=='PREVIEW')throw Error('fixture');
  for(const [id,proof] of [
   ['../../private',p.fingerprint],['none',p.fingerprint],
   ['grant-one','broken'],['grant-one','0'.repeat(64)],
   ['grant-one',p.fingerprint.toUpperCase()]
  ] as const)){
   const result=await f.service.stage(OWNER,id,proof);
   assert.ok(result.status==='STALE'||result.status==='UNAVAILABLE',result.status);
  }
  assert.deepEqual((await f.store.snapshot()).platformReviewQueue??[],[]);
 }finally{await f.close();}
});
test('B5 revoked dashboard while staging/reviewing in-flight rejects after fetch without partial mutation',async()=>{
 let finish!:(value:unknown)=>void,entered!:()=>void;
 const arrived=new Promise<void>(resolve=>entered=resolve);
 const pending=new Promise<unknown>(resolve=>finish=resolve);
 const f=await fixture('json',()=>{entered();return pending;});
 try{
  const operation=f.service.stage(OWNER,'grant-one','0'.repeat(64));
  await arrived;
  await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
  finish(page());
  assert.equal((await operation).status,'DENIED');
  assert.deepEqual((await f.store.snapshot()).platformReviewQueue??[],[]);
 }finally{await f.close();}
});
test('B5 two concurrent stage calls never duplicate a source id',async()=>{
 const f=await fixture('sqlite',()=>page());
 try{
  const p=await f.service.preview(OWNER);
  if(p.status!=='PREVIEW')throw Error('fixture');
  const [a,b]=await Promise.all([
   f.service.stage(OWNER,'grant-one',p.fingerprint),
   f.service.stage(OWNER,'grant-one',p.fingerprint)
  ]);
  assert.equal(a.status,'STAGED');assert.equal(b.status,'STAGED');
  assert.equal((await f.store.snapshot()).platformReviewQueue?.length,1);
 }finally{await f.close();}
});
test('B5 malformed persisted review queue is rejected by both state engines rather than silently trusted',async()=>{
 for(const engine of ['json','sqlite'] as const){
  const f=await fixture(engine,()=>page());
  try{
   await assert.rejects(
    f.store.transaction(s=>{s.platformReviewQueue=[{sourceId:'',status:'REVIEWED_METADATA_ONLY'}] as never;}),
    /Unsupported state schema/
   );
  }finally{await f.close();}
 }
});
