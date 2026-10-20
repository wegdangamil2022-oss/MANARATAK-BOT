import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer,type Server,type RequestListener} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {TelegramMiniAppAuth,telegramAdminWebListener} from '../src/web-admin-auth.js';
import {TelegramReplyDispatcher,type TelegramReplySender} from '../src/telegram-replies.js';

const NOW=1_800_000_000_000;
const TOKEN='999999:FAKE_NO_REAL_TELEGRAM_TOKEN_12345678901234567890';
const ID=(n:number)=>'b3-webhook:bot-test:'+n;
function signed(actor=100,at=Math.floor(NOW/1000),token=TOKEN){
 const v=new URLSearchParams({auth_date:String(at),user:JSON.stringify({id:actor,first_name:'Test'})});
 const data=[...v].sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>k+'='+value).join('\n');
 const key=createHmac('sha256','WebAppData').update(token).digest();
 v.append('hash',createHmac('sha256',key).update(data).digest('hex'));
 return v.toString();
}
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-reply-owner-web-'));
 const store=new BotStore(join(dir,'state.'+(engine==='json'?'json':'sqlite')),{engine});
 const policy=new Policy(store,'100',()=>NOW);
 const education=new EducationService(store,policy,()=>NOW);
 const admin=new EducationAdminFacade(store,policy,education,()=>NOW);
 const auth=new TelegramMiniAppAuth(TOKEN,()=>NOW,600);
 await store.transaction(s=>{s.telegramReplyJobs=[
  {updateKey:ID(1),status:'UNKNOWN_OUTCOME',attemptId:'attempt-unknown-1',startedAt:NOW-100_000},
  {updateKey:ID(2),status:'SENDING',attemptId:'attempt-stale-2',startedAt:NOW-2_000_000},
  {updateKey:ID(3),status:'SENDING',attemptId:'attempt-active-3',startedAt:NOW-10_000},
  {updateKey:ID(4),status:'QUEUED',queuedAt:NOW-3_000_000,
   plan:{chatId:'300',parseMode:'HTML',text:'Student private info'}},
 ]});
 return {store,policy,admin,auth,close:()=>rm(dir,{recursive:true,force:true})};
}
async function serve(listener:RequestListener,run:(url:string)=>Promise<void>){
 const server:Server=createServer(listener);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const addr=server.address();if(!addr||typeof addr==='string')throw Error('NO_ADDR');
  await run('http://127.0.0.1:'+addr.port);
 }finally{server.close();await once(server,'close');}
}
async function post(url:string,path:string,actorData:string,body:unknown){
 return fetch(url+path,{method:'POST',headers:{'x-telegram-init-data':actorData,
  'content-type':'application/json'},body:JSON.stringify(body)});
}
function listener(f:Awaited<ReturnType<typeof fixture>>){
 return telegramAdminWebListener(f.auth,f.admin,{store:f.store,policy:f.policy,clock:()=>NOW});
}
for(const engine of ['json','sqlite'] as const){
 test('B3 owner web '+engine+': disabled review routes fail closed without optional review adapter',async()=>{
  const f=await fixture(engine);try{
   await serve(telegramAdminWebListener(f.auth,f.admin),async url=>{
    assert.equal((await post(url,'/admin/replies/summary',signed(),{})).status,404);
    assert.equal((await post(url,'/admin/replies/review',signed(),{
     updateKey:ID(1),attemptId:'attempt-unknown-1',decision:'ESCALATED'})).status,404);
   });
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.manualReview,undefined);
  }finally{await f.close();}
 });
 test('B3 owner web '+engine+': HMAC owner sees aggregate-only summary, never student data',async()=>{
  const f=await fixture(engine);try{
   await serve(listener(f),async url=>{
    const result=await post(url,'/admin/replies/summary',signed(),{});
    assert.equal(result.status,200);
    const json=await result.json() as {ok:boolean;summary:{total:number;unknownOutcome:number;
     manualReviewRequired:number;awaitingFirstReview:number;reviewedUnresolved:number}};
    assert.equal(json.ok,true);
    assert.deepEqual([json.summary.total,json.summary.unknownOutcome,
     json.summary.manualReviewRequired,json.summary.awaitingFirstReview,json.summary.reviewedUnresolved],
     [4,1,2,2,0]);
    const wire=JSON.stringify(json);
    for(const secret of ['Student private info',ID(1),'attempt-unknown-1','300','100'])
     assert.equal(wire.includes(secret),false);
    assert.equal((await post(url,'/admin/replies/summary',signed(300),{actorId:'100'})).status,403);
   });
  }finally{await f.close();}
 });
 test('B3 owner web '+engine+': untrusted student ID, expired/fake token and no signature cannot act',async()=>{
  const f=await fixture(engine);try{
   await serve(listener(f),async url=>{
    const body={updateKey:ID(1),attemptId:'attempt-unknown-1',decision:'ESCALATED',actorId:'100'};
    assert.equal((await post(url,'/admin/replies/review',signed(300),body)).status,403);
    assert.equal((await post(url,'/admin/replies/review',signed(100,Math.floor(NOW/1000)-601),body)).status,401);
    assert.equal((await post(url,'/admin/replies/review',signed(100,Math.floor(NOW/1000),'100001:FAKE_DIFFERENT_SIGNING_TOKEN_1234567890'),body)).status,401);
    assert.equal((await fetch(url+'/admin/replies/review',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
    assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.manualReview,undefined);
   });
  }finally{await f.close();}
 });
 test('B3 owner web '+engine+': authenticated owner review is immutable, idempotent and never sends',async()=>{
  const f=await fixture(engine);try{
   await serve(listener(f),async url=>{
    const body={updateKey:ID(1),attemptId:'attempt-unknown-1',decision:'ESCALATED'};
    let r=await post(url,'/admin/replies/review',signed(),body);
    assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,result:'RECORDED'});
    r=await post(url,'/admin/replies/review',signed(),body);
    assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,result:'ALREADY_RECORDED'});
    r=await post(url,'/admin/replies/review',signed(),{...body,decision:'ACKNOWLEDGED_UNRESOLVED'});
    assert.equal(r.status,409);
    const saved=(await f.store.snapshot()).telegramReplyJobs![0]!;
    assert.equal(saved.manualReview?.reviewedBy,'100');
    assert.equal(saved.manualReview?.reviewedAt,NOW);
    assert.equal(saved.manualReview?.decision,'ESCALATED');
    assert.equal(saved.status,'UNKNOWN_OUTCOME');
    assert.equal(saved.attemptId,'attempt-unknown-1');
    let calls=0;
    const sender:TelegramReplySender={send:async()=>{calls++;return {status:'CONFIRMED',messageId:12};}};
    assert.equal((await new TelegramReplyDispatcher(f.store,f.policy,sender).dispatch(ID(1))).status,'UNKNOWN_OUTCOME');
    assert.equal(calls,0);
   });
  }finally{await f.close();}
 });
 test('B3 owner web '+engine+': stale sending can be acknowledged; fresh sending and QUEUED cannot',async()=>{
  const f=await fixture(engine);try{
   await serve(listener(f),async url=>{
    assert.equal((await post(url,'/admin/replies/review',signed(),{
     updateKey:ID(2),attemptId:'attempt-stale-2',decision:'ACKNOWLEDGED_UNRESOLVED'})).status,200);
    assert.equal((await post(url,'/admin/replies/review',signed(),{
     updateKey:ID(3),attemptId:'attempt-active-3',decision:'ESCALATED'})).status,409);
    assert.equal((await post(url,'/admin/replies/review',signed(),{
     updateKey:ID(4),attemptId:'fake-4',decision:'ESCALATED'})).status,409);
    const reply=(await f.store.snapshot()).telegramReplyJobs!;
    assert.equal(reply[1]?.status,'SENDING');
    assert.equal(reply[2]?.manualReview,undefined);
    assert.equal(reply[3]?.plan?.text,'Student private info');
   });
  }finally{await f.close();}
 });
 test('B3 owner web '+engine+': cannot supply actor/time/threshold, selectors or extra content',async()=>{
  const f=await fixture(engine);try{
   await serve(listener(f),async url=>{
    const body={updateKey:ID(1),attemptId:'attempt-unknown-1',decision:'ESCALATED'};
    for(const invalid of [{...body,actorId:'100'}, {...body,now:NOW+900_000},
     {...body,staleAfterMs:1},{...body,note:'Secret student'},
     {...body,proofUrl:'https://t.me/a'}, {...body,decision:'SENT'},
     {...body,attemptId:'bad/attempt'},{...body,updateKey:'xxx'},{}]){
      assert.equal((await post(url,'/admin/replies/review',signed(),invalid)).status,422);
    }
    assert.equal((await post(url,'/admin/replies/summary',signed(),{now:1})).status,422);
    assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.manualReview,undefined);
   });
  }finally{await f.close();}
 });
 test('B3 owner web '+engine+': exact routes, UTF8 JSON, methods and 2KiB limit are enforced',async()=>{
  const f=await fixture(engine);try{
   await serve(listener(f),async url=>{
    assert.equal((await fetch(url+'/admin/replies/summary')).status,405);
    assert.equal((await post(url,'/admin/replies/summary?x=1',signed(),{})).status,404);
    assert.equal((await post(url,'/admin/replies/hidden',signed(),{})).status,404);
    assert.equal((await fetch(url+'/admin/replies/summary',{method:'POST',
     headers:{'x-telegram-init-data':signed(),'content-type':'text/plain'},body:'{}'})).status,415);
    assert.equal((await fetch(url+'/admin/replies/summary',{method:'POST',
     headers:{'x-telegram-init-data':signed(),'content-type':'application/json'},body:'{not-json'})).status,400);
    assert.equal((await post(url,'/admin/replies/review',signed(),{padding:'x'.repeat(3000)})).status,413);
   });
  }finally{await f.close();}
 });
}
test('B3 owner web: concurrent opposing review requests cannot both commit',async()=>{
 const f=await fixture('sqlite');try{
  await serve(listener(f),async url=>{
   const base={updateKey:ID(1),attemptId:'attempt-unknown-1'};
   const responses=await Promise.all([
    post(url,'/admin/replies/review',signed(),{...base,decision:'ESCALATED'}),
    post(url,'/admin/replies/review',signed(),{...base,decision:'ACKNOWLEDGED_UNRESOLVED'})]);
   assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);
   const saved=(await f.store.snapshot()).telegramReplyJobs?.[0];
   assert.ok(saved?.manualReview?.decision);
   assert.equal(saved?.status,'UNKNOWN_OUTCOME');
  });
 }finally{await f.close();}
});
