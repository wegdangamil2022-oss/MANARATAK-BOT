import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {PlatformCatalogPreviewService,type PlatformCatalogReader} from '../src/platform-catalog-preview.js';

const OWNER='100',STUDENT='300';
const record=(id='source-1')=>({
 id,revision:2,scope:'private',publication:'PUBLISHED',
 title:'منحة دراسية منشورة',university:'جامعة معتمدة',
 cycle:'2027',degree:'Bachelor'
});
const page=(records:unknown[]= [record()],nextCursor:string|null=null)=>({
 schema:'manaratak-readonly-catalog-v1',records,nextCursor
});
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-b5-readonly-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER);
 return {store,policy,close:()=>rm(dir,{force:true,recursive:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': owner can inspect 1-page read-only platform candidates without any local publication',async()=>{
  const f=await fixture(engine);try{
   let requests=0;
   const reader:PlatformCatalogReader={fetchPage:async args=>{
    requests++;
    assert.deepEqual(args,{scope:'private',limit:10,cursor:null});
    return page();
   }};
   const service=new PlatformCatalogPreviewService(f.store,f.policy,reader);
   const before=await f.store.snapshot();
   const first=await service.preview(OWNER);
   assert.equal(first.status,'PREVIEW');
   if(first.status==='PREVIEW'){
    assert.equal(first.records.length,1);
    assert.equal(first.records[0]!.id,'source-1');
    assert.equal(first.records[0]!.title,'منحة دراسية منشورة');
    assert.equal(first.records[0]!.reviewState,'UNVERIFIED_EXTERNAL');
    assert.match(first.fingerprint,/^[a-f0-9]{64}$/);
    assert.equal(first.nextCursor,null);
   }
   assert.equal(requests,1);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B5 '+engine+': student, delegate and disabled owner dashboard never call external provider',async()=>{
  const f=await fixture(engine);try{
   let calls=0;
   const service=new PlatformCatalogPreviewService(f.store,f.policy,{
    fetchPage:async()=>{calls++;return page();}
   });
   assert.equal((await service.preview(STUDENT)).status,'DENIED');
   await f.policy.grant(OWNER,'200','content.publish','private',Date.now()+100000);
   assert.equal((await service.preview('200')).status,'DENIED');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await service.preview(OWNER)).status,'DENIED');
   assert.equal(calls,0);
  }finally{await f.close();}
 });
 test('B5 '+engine+': no partial results when provider claims group, archived or duplicate data',async()=>{
  const f=await fixture(engine);try{
   const badPages=[
    page([record('safe'),{...record('group'),scope:'-100234'}]),
    page([record('safe'),{...record('draft'),publication:'DRAFT'}]),
    page([record('same'),record('same')]),
    page([record('safe'),{...record('overflow'),title:'A'.repeat(161)}])
   ];
   for(const bad of badPages){
    const service=new PlatformCatalogPreviewService(f.store,f.policy,{fetchPage:async()=>bad});
    const result=await service.preview(OWNER);
    assert.equal(result.status,'UNAVAILABLE');
    assert.equal('records' in result,false);
   }
  }finally{await f.close();}
 });
}
test('B5 rejects malformed provider schema, nested or unauthorized response fields and overlong batches',async()=>{
 const f=await fixture();try{
  const malformed:unknown[]=[
   null,'published',[],{},page(new Array(11).fill(record())),
   {...page(),schema:'v2'},{...page(),cursor:'untrusted'},
   page([{...record(),token:'SECRET'}]),
   page([{...record(),revision:0}]),
   page([{...record(),title:'Title\u202eBAD'}]),
   page([{...record(),id:'../../secret'}]),
   page([{...record(),university:'\n'}]),
   page([record()],'BAD CURSOR'),
   page([record()],'a'.repeat(65))
  ];
  const state=await f.store.snapshot();
  for(const payload of malformed){
   const service=new PlatformCatalogPreviewService(f.store,f.policy,{fetchPage:async()=>payload});
   const output=await service.preview(OWNER);
   assert.equal(output.status,'UNAVAILABLE',JSON.stringify(payload)?.slice(0,50));
  }
  assert.deepEqual(await f.store.snapshot(),state);
 }finally{await f.close();}
});
test('B5 cursor pagination is explicit, bounded, scoped and cannot self-loop',async()=>{
 const f=await fixture();try{
  const seen:unknown[]=[];
  const service=new PlatformCatalogPreviewService(f.store,f.policy,{fetchPage:async args=>{
   seen.push(args);
   return page([record('b')],'cursor-next');
  }});
  assert.equal((await service.preview(OWNER,{limit:2,cursor:'cursor-now'})).status,'PREVIEW');
  assert.deepEqual(seen,[{scope:'private',limit:2,cursor:'cursor-now'}]);
  assert.equal((await service.preview(OWNER,{limit:2,cursor:'cursor-next'})).status,'UNAVAILABLE');
  assert.equal(seen.length,2);
  for(const request of [
   {limit:0,cursor:null},{limit:11,cursor:null},{limit:1,cursor:'bad;input'},
   {limit:1,cursor:'a'.repeat(65)}
  ])assert.equal((await service.preview(OWNER,request)).status,'UNAVAILABLE');
  assert.equal(seen.length,2);
 }finally{await f.close();}
});
test('B5 provider exception details and credentials never enter the returned review result',async()=>{
 const f=await fixture();try{
  const service=new PlatformCatalogPreviewService(f.store,f.policy,{fetchPage:async()=>{
   throw Error('https://private.invalid?token=PRIVATE_SECRET');
  }});
  const r=await service.preview(OWNER);
  assert.equal(r.status,'UNAVAILABLE');
  assert.equal(JSON.stringify(r).includes('PRIVATE_SECRET'),false);
 }finally{await f.close();}
});
test('B5 owner dashboard revocation during pending external read rejects stale candidates',async()=>{
 const f=await fixture('sqlite');try{
  let entered!:()=>void,respond!:(value:unknown)=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const pending=new Promise<unknown>(resolve=>{respond=resolve;});
  const service=new PlatformCatalogPreviewService(f.store,f.policy,{fetchPage:async()=>{
   entered();return pending;
  }});
  const read=service.preview(OWNER);
  await ready;
  await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
  respond(page());
  const result=await read;
  assert.equal(result.status,'DENIED');
  assert.equal('records' in result,false);
 }finally{await f.close();}
});
test('B5 candidate fingerprints are deterministic but never a publication authorization',async()=>{
 const f=await fixture();try{
  const service=new PlatformCatalogPreviewService(f.store,f.policy,{fetchPage:async()=>page()});
  const a=await service.preview(OWNER),b=await service.preview(OWNER);
  assert.equal(a.status,'PREVIEW');assert.equal(b.status,'PREVIEW');
  if(a.status==='PREVIEW'&&b.status==='PREVIEW')
   assert.equal(a.fingerprint,b.fingerprint);
  assert.deepEqual((await f.store.snapshot()).educationResources,[]);
  assert.deepEqual((await f.store.snapshot()).campaigns,[]);
 }finally{await f.close();}
});
