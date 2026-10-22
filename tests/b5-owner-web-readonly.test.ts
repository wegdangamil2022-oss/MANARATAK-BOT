import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {PlatformCatalogPreviewService} from '../src/platform-catalog-preview.js';
import {TelegramMiniAppAuth,telegramAdminWebListener} from '../src/web-admin-auth.js';

const OWNER='100',STUDENT='300',NOW=1_800_000_000_000;
const TOKEN='999999:FAKE_NO_REAL_TELEGRAM_TOKEN_12345678901234567890';
const sign=(actor:number,clock=Math.floor(NOW/1000))=>{
 const fields=new URLSearchParams({auth_date:String(clock),
  user:JSON.stringify({id:actor,first_name:'Test'})});
 const sorted=[...fields.entries()].sort(([a],[b])=>a.localeCompare(b))
  .map(([k,v])=>k+'='+v).join('\n');
 const secret=createHmac('sha256','WebAppData').update(TOKEN).digest();
 fields.append('hash',createHmac('sha256',secret).update(sorted).digest('hex'));
 return fields.toString();
};
async function serverRun(listener:ReturnType<typeof telegramAdminWebListener>,
 run:(url:string)=>Promise<void>){
 const server:Server=createServer(listener);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const addr=server.address();
  if(!addr||typeof addr==='string')throw Error('NO_PORT');
  await run('http://127.0.0.1:'+addr.port);
 }finally{server.close();await once(server,'close');}
}
const post=(url:string,path:string,data:unknown,actor=100,auth=sign(actor))=>
 fetch(url+path,{method:'POST',headers:{'content-type':'application/json',
  'x-telegram-init-data':auth},body:JSON.stringify(data)});
type Mode='CURRENT'|'CHANGED'|'MISSING'|'INVALID'|'DOWN';
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'b5-web-source-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 const education=new EducationService(store,policy,()=>NOW);
 const admin=new EducationAdminFacade(store,policy,education,()=>NOW);
 const auth=new TelegramMiniAppAuth(TOKEN,()=>NOW);
 await education.createCategory(OWNER,{id:'grants',scope:'private',title:'منح',order:0});
 let mode:Mode='CURRENT',calls=0,cursorSeen:string|null=null;
 let onFetch:(()=>Promise<void>)|undefined;
 const reader={fetchPage:async(q:{scope:'private';limit:number;cursor:string|null})=>{
  calls++;cursorSeen=q.cursor;
  if(onFetch)await onFetch();
  if(mode==='DOWN')throw Error('SECRET_SOURCE_PROVIDER_INTERNAL_ERROR');
  if(mode==='INVALID')return {schema:'not-the-agreed-schema',records:[],nextCursor:null};
  return {schema:'manaratak-readonly-catalog-v1',
   records:mode==='MISSING'?[]:[{
    id:'china-2027',revision:mode==='CHANGED'?2:1,
    scope:'private',publication:'PUBLISHED',title:mode==='CHANGED'?'Edited grant':'China Grant',
    university:'Wuhan University',cycle:'2027',degree:'Bachelor'
   }],nextCursor:null};
 }};
 const platformCatalog=new PlatformCatalogPreviewService(store,policy,reader);
 const listener=()=>telegramAdminWebListener(auth,admin,{
  store,policy,clock:()=>NOW,platformCatalog
 });
 const stage=async()=>{
  const view=await platformCatalog.preview(OWNER);
  if(view.status!=='PREVIEW')throw Error('NO_PREVIEW');
  const staged=await platformCatalog.stage(OWNER,'china-2027',view.fingerprint);
  if(staged.status!=='STAGED')throw Error('NO_STAGE');
  const reviewed=await platformCatalog.review(OWNER,'china-2027',staged.entry.digest);
  if(reviewed.status!=='REVIEWED')throw Error('NO_REVIEW');
  const approved=await platformCatalog.approveForLocal(OWNER,'china-2027',staged.entry.digest,'grants');
  if(approved.status!=='APPROVED')throw Error('NO_APPROVE');
  const published=await platformCatalog.publishLocally(OWNER,'china-2027',staged.entry.digest,'grants');
  if(published.status!=='PUBLISHED')throw Error('NO_PUBLISH');
  return {digest:staged.entry.digest,resourceId:published.resource.id};
 };
 return {store,policy,education,admin,auth,platformCatalog,listener,stage,
  setMode:(m:Mode)=>mode=m,setFetch:(f:()=>Promise<void>)=>onFetch=f,
  getCalls:()=>calls,getCursor:()=>cursorSeen,
  close:()=>rm(dir,{recursive:true,force:true})};
}

for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': Mini App owner previews unverified private external page without storing or publishing',async()=>{
  const f=await setup(engine);try{
   const before=await f.store.snapshot();
   await serverRun(f.listener(),async url=>{
    const r=await post(url,'/admin/platform/preview',{limit:2,cursor:null});
    assert.equal(r.status,200);
    const data=await r.json() as Record<string,unknown>;
    assert.equal(data.ok,true);assert.equal(data.status,'PREVIEW');
    assert.equal(data.trust,'UNVERIFIED_EXTERNAL');
    assert.equal(Array.isArray(data.records),true);
    assert.match(String(JSON.stringify(data.records)),/China Grant/);
    assert.match(String(data.fingerprint),/^[a-f0-9]{64}$/);
    assert.equal(f.getCursor(),null);
   });
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B5 '+engine+': owner web preview bound to allowed cursor, limit and read-only API',async()=>{
  const f=await setup(engine);try{await serverRun(f.listener(),async url=>{
   const r=await post(url,'/admin/platform/preview',{cursor:'next_2',limit:1});
   assert.equal(r.status,200);assert.equal(f.getCursor(),'next_2');
   const bad=await post(url,'/admin/platform/preview',{cursor:'../secret',limit:1});
   assert.equal(bad.status,422);
   assert.equal(f.getCursor(),'next_2');
  });}finally{await f.close();}
 });
 test('B5 '+engine+': forged student with claimed owner userId in body gets 403 before source fetch',async()=>{
  const f=await setup(engine);try{await serverRun(f.listener(),async url=>{
   const before=f.getCalls();
   const r=await post(url,'/admin/platform/preview',{scope:'private',actorId:OWNER},300);
   assert.equal(r.status,403);assert.deepEqual(await r.json(),{ok:false});
   assert.equal(f.getCalls(),before);
  });}finally{await f.close();}
 });
 test('B5 '+engine+': strict payload rejects unknown fields, duplicate property, unsupported cursor or preview range',async()=>{
  const f=await setup(engine);try{await serverRun(f.listener(),async url=>{
   const bad=[
    {limit:0},{limit:11},{limit:1.5},{cursor:15},{cursor:''},
    {cursor:'-'.repeat(65)},{actorId:OWNER},{scope:'-100123'},
    {limit:2,mode:'PUBLISHED'},{records:[]}
   ];
   for(const payload of bad){
    const r=await post(url,'/admin/platform/preview',payload);
    assert.equal(r.status,422,JSON.stringify(payload));
    assert.deepEqual(await r.json(),{ok:false});
   }
   const duplicate=await fetch(url+'/admin/platform/preview',{
    method:'POST',headers:{'content-type':'application/json',
     'x-telegram-init-data':sign(100)},body:'{"limit":2,"limit":3}'
   });
   assert.equal(duplicate.status,400);
   // JSON escape spellings must not allow the same key twice.
   const escapedDuplicate=await fetch(url+'/admin/platform/preview',{
    method:'POST',headers:{'content-type':'application/json',
     'x-telegram-init-data':sign(100)},body:'{"lim\\u0069t":2,"limit":3}'.replace('\\\\','\\')
   });
   assert.equal(escapedDuplicate.status,400);
   // A JSON string VALUE mentioning a property name is not a duplicate key.
   const legitimate=await post(url,'/admin/platform/preview',{cursor:'next_limit',limit:1});
   assert.equal(legitimate.status,200);
   assert.equal(f.getCalls(),1);
  });}finally{await f.close();}
 });
 test('B5 '+engine+': web route is absent without explicitly injecting platform reader',async()=>{
  const f=await setup(engine);try{await serverRun(telegramAdminWebListener(f.auth,f.admin),async url=>{
   assert.equal((await post(url,'/admin/platform/preview',{})).status,404);
   assert.equal((await post(url,'/admin/platform/integrity',{})).status,404);
  });}finally{await f.close();}
 });
 test('B5 '+engine+': signed owner integrity check reports unchanged resource without changing state',async()=>{
  const f=await setup(engine);try{
   const {digest,resourceId}=await f.stage(),before=await f.store.snapshot();
   await serverRun(f.listener(),async url=>{
    const r=await post(url,'/admin/platform/integrity',{sourceId:'china-2027',expectedDigest:digest});
    assert.equal(r.status,200);const body=await r.json() as Record<string,unknown>;
    assert.equal(body.ok,true);assert.equal(body.status,'CURRENT');
    assert.equal(body.resourceId,resourceId);
    assert.equal(body.sourceId,'china-2027');
   });
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test('B5 '+engine+': drift and cursor absence are advisory statuses, never auto-archive a published item',async()=>{
  const f=await setup(engine);try{
   const {digest}=await f.stage();
   await serverRun(f.listener(),async url=>{
    for(const [mode,status] of [['CHANGED','SOURCE_CHANGED'],['MISSING','NOT_ON_PAGE'],
     ['DOWN','UNAVAILABLE'],['INVALID','UNAVAILABLE']] as const){
     f.setMode(mode);
     const r=await post(url,'/admin/platform/integrity',{sourceId:'china-2027',expectedDigest:digest});
     assert.equal(r.status,status==='UNAVAILABLE'?503:200);
     const body=await r.json() as Record<string,unknown>;
     assert.equal(body.status,status);
     assert.doesNotMatch(JSON.stringify(body),/SECRET_SOURCE_PROVIDER_INTERNAL_ERROR/);
     assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
    }
   });
  }finally{await f.close();}
 });
 test('B5 '+engine+': staff and students are denied integrity before source calls and never receive source fields',async()=>{
  const f=await setup(engine);try{
   const {digest}=await f.stage();
   await serverRun(f.listener(),async url=>{
    const previous=f.getCalls();
    const r=await post(url,'/admin/platform/integrity',
     {sourceId:'china-2027',expectedDigest:digest,actorId:OWNER},300);
    assert.equal(r.status,403);
    assert.deepEqual(await r.json(),{ok:false});
    assert.equal(f.getCalls(),previous);
   });
  }finally{await f.close();}
 });
 test('B5 '+engine+': invalid or forged integrity selector fails before upstream read',async()=>{
  const f=await setup(engine);try{
   const {digest}=await f.stage();
   await serverRun(f.listener(),async url=>{
    const prior=f.getCalls();
    for(const body of [{sourceId:'../other',expectedDigest:digest},
      {sourceId:'china-2027',expectedDigest:'0'.repeat(64)},
      {sourceId:'china-2027',expectedDigest:digest,categoryId:'grants'},
      {sourceId:'china-2027',expectedDigest:'c'},
      {sourceId:'china-2027',expectedDigest:digest.slice(0,24)}]){
     const r=await post(url,'/admin/platform/integrity',body);
     assert.ok([409,422].includes(r.status),JSON.stringify(body)+' '+r.status);
    }
    assert.equal(f.getCalls(),prior);
   });
  }finally{await f.close();}
 });
 test('B5 '+engine+': revoked dashboard denies integrity and preview while Mini App signature remains valid',async()=>{
  const f=await setup(engine);try{
   const {digest}=await f.stage();
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   await serverRun(f.listener(),async url=>{
    const prior=f.getCalls();
    assert.equal((await post(url,'/admin/platform/integrity',
     {sourceId:'china-2027',expectedDigest:digest})).status,403);
    assert.equal((await post(url,'/admin/platform/preview',{})).status,403);
    assert.equal(f.getCalls(),prior);
   });
  }finally{await f.close();}
 });
}
test('B5 web endpoint checks owner dashboard again after awaiting external read',async()=>{
 const f=await setup('sqlite');try{
  let entered!:()=>void,release!:()=>void;
  const paused=new Promise<void>(r=>release=r);
  const started=new Promise<void>(r=>entered=r);
  f.setFetch(async()=>{entered();await paused;});
  await serverRun(f.listener(),async url=>{
   const pending=post(url,'/admin/platform/preview',{});
   await started;
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   release();
   const r=await pending;
   assert.equal(r.status,403);
   assert.deepEqual(await r.json(),{ok:false});
  });
 }finally{await f.close();}
});
test('B5 web owner only routes reject expired Mini App signature, non-POST and wrong content type',async()=>{
 const f=await setup('json');try{await serverRun(f.listener(),async url=>{
  assert.equal((await post(url,'/admin/platform/preview',{},100,sign(100,Math.floor(NOW/1000)-601))).status,401);
  assert.equal((await fetch(url+'/admin/platform/preview')).status,405);
  assert.equal((await fetch(url+'/admin/platform/preview',{method:'POST',
   headers:{'x-telegram-init-data':sign(100),'content-type':'text/plain'},body:'{}'})).status,415);
  assert.equal(f.getCalls(),0);
 });}finally{await f.close();}
});
