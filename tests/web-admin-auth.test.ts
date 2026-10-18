import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { EducationAdminFacade } from '../src/education-admin.js';
import { TelegramMiniAppAuth, telegramAdminWebListener } from '../src/web-admin-auth.js';

const TOKEN='999999:FAKE_NO_REAL_TELEGRAM_TOKEN_12345678901234567890', NOW=1_800_000_000_000;
const OWNER='100', STUDENT='300', GROUP='-100123';
function signed(userId:number, extras:Record<string,string>={}, timestamp=Math.floor(NOW/1000)) {
  const fields=new URLSearchParams({auth_date:String(timestamp),user:JSON.stringify({id:userId,first_name:'User'}),...extras});
  const data=Array.from(fields.entries()).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('\n');
  const key=createHmac('sha256','WebAppData').update(TOKEN).digest();
  fields.append('hash',createHmac('sha256',key).update(data).digest('hex'));
  return fields.toString();
}
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'manaratak-miniapp-'));
  const store=new BotStore(join(dir,'store.json'));
  const policy=new Policy(store,OWNER,()=>NOW),education=new EducationService(store,policy,()=>NOW);
  const admin=new EducationAdminFacade(store,policy,education,()=>NOW);
  await policy.approveChat(OWNER,GROUP,['navigation']);
  const auth=new TelegramMiniAppAuth(TOKEN,()=>NOW,600);
  return {dir,store,policy,education,admin,auth,close:()=>rm(dir,{recursive:true,force:true})};
}
async function withServer(listener:ReturnType<typeof telegramAdminWebListener>, run:(url:string)=>Promise<void>){
  const server:Server=createServer(listener);server.listen(0,'127.0.0.1');await once(server,'listening');
  try{const addr=server.address();if(!addr||typeof addr==='string')throw Error('missing address');await run(`http://127.0.0.1:${addr.port}`);}
  finally {server.close();await once(server,'close');}
}
async function post(url:string,path:string,initData:string,body:unknown){return fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-telegram-init-data':initData},body:JSON.stringify(body)});}

test('Mini App initData verifies bot-token HMAC and derives actor exclusively from signed data',async()=>{
  const c=await fixture();try{
    const actor=c.auth.verify(signed(100));
    assert.deepEqual(actor,{origin:'ADMIN_WEB',verified:true,actorId:'100',chatId:'100'});
    assert.equal(c.auth.verify(signed(300)).actorId,'300');
  }finally{await c.close();}
});

test('Mini App invalid HMAC, user tampering and missing hash all fail closed',async()=>{
  const c=await fixture();try{
    const good=signed(100);
    assert.throws(()=>c.auth.verify(good.replace('100','300')),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(good.replace(/hash=[a-f0-9]{64}/,'hash='+'0'.repeat(64))),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(good.split('&hash=')[0]!),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify('user='+encodeURIComponent('{"id":100}')+'&auth_date=1800000000'),/INVALID_MINIAPP_AUTH/);
  }finally{await c.close();}
});

test('Mini App rejects expired, future, malformed and duplicate fields, including hash',async()=>{
  const c=await fixture();try{
    assert.throws(()=>c.auth.verify(signed(100,{},Math.floor(NOW/1000)-601)),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(signed(100,{},Math.floor(NOW/1000)+100)),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(signed(100)+'&user=extra'),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(signed(100)+'&hash='+'0'.repeat(64)),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify('a='.repeat(5000)),/INVALID_MINIAPP_AUTH/);
  }finally{await c.close();}
});

test('Mini App refuses bot identities, unsafe integers, invalid user payload and controls',async()=>{
  const c=await fixture();try{
    assert.throws(()=>c.auth.verify(signed(100,{user:'{"id":100,"is_bot":true}'})),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(signed(100,{user:'{"id":9007199254740992}'})),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(signed(100,{user:'bad-json'})),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(signed(100,{evil:'\u0000'})),/INVALID_MINIAPP_AUTH/);
    assert.throws(()=>c.auth.verify(''),/INVALID_MINIAPP_AUTH/);
  }finally{await c.close();}
});

test('Mini App web endpoint accepts authorized owner and never trusts body actor IDs',async()=>{
  const c=await fixture();try{await withServer(telegramAdminWebListener(c.auth,c.admin),async url=>{
    const ok=await post(url,'/admin/panel',signed(Number(OWNER)),{scope:GROUP,actorId:STUDENT});
    assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{ok:true,panel:{canUpload:true,canPublish:true,canReview:true}});
    const denied=await post(url,'/admin/panel',signed(Number(STUDENT)),{scope:GROUP,actorId:OWNER});
    assert.equal(denied.status,200);assert.deepEqual(await denied.json(),{ok:true,panel:{canUpload:false,canPublish:false,canReview:false}});
  });}finally{await c.close();}
});

test('Mini App unauthorized or stale payload cannot mutate import state',async()=>{
  const c=await fixture();try{await withServer(telegramAdminWebListener(c.auth,c.admin),async url=>{
    const body={scope:GROUP,format:'csv',filename:'offers.csv',text:'title,university\nA,B',actorId:OWNER};
    const invalid=await post(url,'/admin/import',signed(Number(OWNER),{},Math.floor(NOW/1000)-700),body);
    assert.equal(invalid.status,401);
    const student=await post(url,'/admin/import',signed(Number(STUDENT)),body);
    assert.equal(student.status,403);
    assert.equal((await c.store.snapshot()).importRuns.length,0);
  });}finally{await c.close();}
});

test('Mini App web admin can import, approve and publish local resource via authenticated endpoint',async()=>{
  const c=await fixture();try{await c.education.createCategory(OWNER,{id:'grants',scope:GROUP,title:'منح',order:1});await withServer(telegramAdminWebListener(c.auth,c.admin),async url=>{
    const auth=signed(Number(OWNER));
    const imported=await post(url,'/admin/import',auth,{scope:GROUP,format:'csv',filename:'x.csv',text:'title,university\nScholarship,University'});
    assert.equal(imported.status,200);
    const data=await imported.json() as {ok:boolean;id:string;report:{opportunities:number}};
    assert.equal(data.report.opportunities,1);
    assert.equal((await c.store.snapshot()).educationResources.length,0);
    assert.equal((await post(url,'/admin/approve',auth,{importId:data.id,index:0,categoryId:'grants'})).status,200);
    const pub=await post(url,'/admin/publish',auth,{importId:data.id,index:0,categoryId:'grants'});
    assert.equal(pub.status,200);assert.equal((await c.store.snapshot()).educationResources.length,1);
  });}finally{await c.close();}
});

test('Mini App rejects malformed methods, content types, oversized body and unknown paths',async()=>{
  const c=await fixture();try{await withServer(telegramAdminWebListener(c.auth,c.admin),async url=>{
    assert.equal((await fetch(url+'/admin/panel')).status,405);
    assert.equal((await post(url,'/other',signed(100),{})).status,404);
    assert.equal((await fetch(url+'/admin/panel',{method:'POST',headers:{'x-telegram-init-data':signed(100),'content-type':'text/plain'},body:'not json'})).status,415);
    assert.equal((await post(url,'/admin/panel',signed(100),{scope:GROUP,pad:'a'.repeat(270_000)})).status,413);
    assert.equal((await fetch(url+'/admin/panel',{method:'POST',headers:{'content-type':'application/json','x-telegram-init-data':signed(100)},body:'{INVALID'})).status,400);
    assert.equal((await c.store.snapshot()).importRuns.length,0);
  });}finally{await c.close();}
});

test('Mini App denies after grant revocation even if signed initData remains valid',async()=>{
  const c=await fixture();try{await c.policy.grant(OWNER,STUDENT,'content.upload',GROUP,NOW+40000);
    await withServer(telegramAdminWebListener(c.auth,c.admin),async url=>{
      const auth=signed(Number(STUDENT));
      const data={scope:GROUP,format:'csv',filename:'x.csv',text:'title,university\nA,B'};
      assert.equal((await post(url,'/admin/import',auth,data)).status,200);
      await c.policy.revokeGrant(OWNER,STUDENT,'content.upload',GROUP);
      assert.equal((await post(url,'/admin/import',auth,{...data,filename:'y.csv',text:'title,university\nC,D'})).status,403);
      assert.equal((await c.store.snapshot()).importRuns.length,1);
    });
  }finally{await c.close();}
});
