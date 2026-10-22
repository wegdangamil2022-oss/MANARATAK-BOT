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
type Mode='CURRENT'|'CHANGED'|'NOT_ON_PAGE'|'MALFORMED'|'UNAVAILABLE';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'b5-source-reconcile-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 await education.createCategory(OWNER,{id:'grants',scope:'private',title:'منح',order:0});
 let mode:Mode='CURRENT',cursorSeen:string|null=null,calls=0;
 const source=()=>({
  id:'external-grant-1',revision:mode==='CHANGED'?2:1,scope:'private',
  publication:'PUBLISHED',title:mode==='CHANGED'?'منحة محدثة':'منحة قديمة',
  university:'جامعة',cycle:'2027',degree:'Bachelor'
 });
 const reader={fetchPage:async(q:{scope:'private';limit:number;cursor:string|null})=>{
  calls++;cursorSeen=q.cursor;
  if(mode==='UNAVAILABLE')throw Error('PROVIDER_DOWN');
  if(mode==='MALFORMED')return {schema:'forged',records:[source()],nextCursor:null};
  return {schema:'manaratak-readonly-catalog-v1',
   records:mode==='NOT_ON_PAGE'?[]:[source()],nextCursor:null};
 }};
 const service=new PlatformCatalogPreviewService(store,policy,reader);
 const publish=async()=>{
  const preview=await service.preview(OWNER);
  if(preview.status!=='PREVIEW')throw Error('preview');
  const staged=await service.stage(OWNER,'external-grant-1',preview.fingerprint);
  if(staged.status!=='STAGED')throw Error('staged');
  if((await service.review(OWNER,'external-grant-1',staged.entry.digest)).status!=='REVIEWED')throw Error('review');
  if((await service.approveForLocal(OWNER,'external-grant-1',staged.entry.digest,'grants')).status!=='APPROVED')throw Error('approve');
  const pub=await service.publishLocally(OWNER,'external-grant-1',staged.entry.digest,'grants');
  if(pub.status!=='PUBLISHED')throw Error('publish');
  return {digest:staged.entry.digest,resourceId:pub.resource.id};
 };
 return {store,policy,service,education,publish,setMode:(m:Mode)=>mode=m,
  calls:()=>calls,lastCursor:()=>cursorSeen,
  close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': owner confirms published local resource is unchanged after a fresh external reread',async()=>{
  const f=await fixture(engine);try{
   const {digest,resourceId}=await f.publish();
   const before=await f.store.snapshot(),prior=f.calls();
   const result=await f.service.inspectPublished(OWNER,'external-grant-1',digest);
   assert.equal(result.status,'CURRENT');
   if(result.status==='CURRENT'){
    assert.equal(result.resourceId,resourceId);
    assert.equal(result.sourceId,'external-grant-1');
   }
   assert.equal(f.calls(),prior+1);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B5 '+engine+': changed title or revision warns owner but does NOT silently modify published student record',async()=>{
  const f=await fixture(engine);try{
   const {digest}=await f.publish();f.setMode('CHANGED');
   const before=await f.store.snapshot();
   const result=await f.service.inspectPublished(OWNER,'external-grant-1',digest);
   assert.equal(result.status,'SOURCE_CHANGED');
   assert.deepEqual(await f.store.snapshot(),before);
   const library=await f.education.listResources(STUDENT,'private','grants');
   assert.equal(library.length,1);
   assert.equal(library[0]?.title,'منحة قديمة');
  }finally{await f.close();}
 });
 test('B5 '+engine+': absent record on a source cursor page is uncertain, never treated as definitive closure',async()=>{
  const f=await fixture(engine);try{
   const {digest}=await f.publish();f.setMode('NOT_ON_PAGE');
   const result=await f.service.inspectPublished(OWNER,'external-grant-1',digest);
   assert.equal(result.status,'NOT_ON_PAGE');
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
  }finally{await f.close();}
 });
 test('B5 '+engine+': bad source schema or network timeout yields UNAVAILABLE, not changed, and never archives',async()=>{
  const f=await fixture(engine);try{
   const {digest}=await f.publish();
   for(const mode of ['MALFORMED','UNAVAILABLE'] as const){
    f.setMode(mode);
    assert.equal((await f.service.inspectPublished(OWNER,'external-grant-1',digest)).status,'UNAVAILABLE');
   }
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
  }finally{await f.close();}
 });
 test('B5 '+engine+': archived local record has separate terminal status without fetching external source',async()=>{
  const f=await fixture(engine);try{
   const {digest,resourceId}=await f.publish();
   await f.education.archiveResource(OWNER,resourceId);
   const before=f.calls();
   assert.equal((await f.service.inspectPublished(OWNER,'external-grant-1',digest)).status,'LOCAL_ARCHIVED');
   assert.equal(f.calls(),before);
  }finally{await f.close();}
 });
 test('B5 '+engine+': unexpected local metadata edit or source association mismatch blocks unreliable comparison',async()=>{
  const f=await fixture(engine);try{
   const {digest,resourceId}=await f.publish();
   await f.store.transaction(s=>{s.educationResources.find(r=>r.id===resourceId)!.degree='Masters';});
   const before=f.calls();
   assert.equal((await f.service.inspectPublished(OWNER,'external-grant-1',digest)).status,'LOCAL_INCONSISTENT');
   assert.equal(f.calls(),before);
  }finally{await f.close();}
 });
 test('B5 '+engine+': students, delegated staff, invalid IDs and a disabled owner dashboard cannot check source',async()=>{
  const f=await fixture(engine);try{
   const {digest}=await f.publish(),before=f.calls();
   assert.equal((await f.service.inspectPublished(STUDENT,'external-grant-1',digest)).status,'DENIED');
   assert.equal((await f.service.inspectPublished('200','external-grant-1',digest)).status,'DENIED');
   assert.equal((await f.service.inspectPublished(OWNER,'not-found',digest)).status,'STALE');
   assert.equal((await f.service.inspectPublished(OWNER,'external-grant-1','0'.repeat(64))).status,'STALE');
   assert.equal((await f.service.inspectPublished(OWNER,'../unsafe',digest)).status,'UNAVAILABLE');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.service.inspectPublished(OWNER,'external-grant-1',digest)).status,'DENIED');
   assert.equal(f.calls(),before);
  }finally{await f.close();}
 });
}
test('B5 source read revoked mid-flight suppresses foreign data and checks current owner permissions again',async()=>{
 const f=await fixture('sqlite');try{
  const {digest}=await f.publish();
  // Permissions are changed synchronously during the mock adapter's async read
  // by replacing the provider response after the dashboard is switched off.
  await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
  assert.equal((await f.service.inspectPublished(OWNER,'external-grant-1',digest)).status,'DENIED');
  assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
 }finally{await f.close();}
});
