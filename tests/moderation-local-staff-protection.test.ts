import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';

const OWNER='100',TARGET='300',CHAT='-100123',NOW=1_700_000_000_000;
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
const json=(result:unknown)=>new Response(JSON.stringify({ok:true,result}),
 {status:200,headers:{'content-type':'application/json'}});

for(const engine of ['json','sqlite'] as const){
 test('locally delegated chat manager is protected from warning and sanction ('+engine+')',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-staff-safe-'));
  try{
   const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,CHAT,['moderation']);
   await policy.grant(OWNER,TARGET,'chat.manage',CHAT,NOW+60_000);
   const fake=new FakeModerationGateway();
   const service=new ModerationService(store,policy,fake,()=>NOW);
   assert.equal((await service.addManualReason(OWNER,CHAT,TARGET,'protect-staff','BAN')).status,'DENIED');
   assert.equal((await service.issueWarning(OWNER,CHAT,TARGET,'protect-warning')).status,'DENIED');
   assert.deepEqual(fake.calls,[]);
   const state=await store.snapshot();
   assert.equal(state.moderationReasons.length,0);
   assert.equal(state.moderationOperations.length,0);
   assert.equal(state.warnings.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('staff promotion between INTENT and STARTED cancels operation ('+engine+')',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-staff-intent-'));
  try{
   const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,CHAT,['moderation']);
   const fake=new FakeModerationGateway();
   const service=new ModerationService(store,policy,fake,()=>NOW);
   service.beforeDispatch=async()=>{
    await policy.grant(OWNER,TARGET,'chat.manage',CHAT,NOW+60_000);
   };
   assert.equal((await service.addManualReason(OWNER,CHAT,TARGET,'staff-promoted','MUTE')).status,'DENIED');
   const operations=(await store.snapshot()).moderationOperations;
   assert.equal(operations.length,1);
   assert.equal(operations[0]!.status,'CANCELLED');
   assert.deepEqual(fake.calls,[]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('staff grant added during STARTED provider preflight prevents sanction ('+engine+')',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-staff-started-'));
  try{
   const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,CHAT,['moderation']);
   let promoted=false;
   const calls:string[]=[];
   const request=(async(url:string|URL|Request,init?:RequestInit)=>{
    const method=String(url).split('/').at(-1)!;
    const body=JSON.parse(String(init?.body)) as {user_id:number};
    calls.push(method);
    if(method==='getChatMember'){
     const started=(await store.snapshot()).moderationOperations.some(o=>o.status==='STARTED');
     if(started&&!promoted){
      promoted=true;
      await policy.grant(OWNER,TARGET,'chat.manage',CHAT,NOW+60_000);
     }
     return body.user_id===BOT?json({status:'administrator',
      user:{id:BOT,is_bot:true},can_restrict_members:true}):
      json({status:'member',user:{id:body.user_id,is_bot:false}});
    }
    return json(true);
   }) as typeof fetch;
   const service=new ModerationService(store,policy,
    new TelegramBotApiModerationGateway(TOKEN,request,async()=>true),()=>NOW);
   assert.equal((await service.addManualReason(OWNER,CHAT,TARGET,'grant-drift','BAN')).status,'FAILED_CONFIRMED');
   assert.equal(promoted,true);
   assert.equal(calls.some(x=>x==='banChatMember'||x==='restrictChatMember'),false);
   assert.equal((await store.snapshot()).moderationOperations.at(-1)?.status,'FAILED_CONFIRMED');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('expired staff permission does not permanently protect non-staff target ('+engine+')',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-staff-expiry-'));
  try{
   let now=NOW;
   const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,CHAT,['moderation']);
   await policy.grant(OWNER,TARGET,'chat.manage',CHAT,NOW+1000);
   now=NOW+1500;
   const fake=new FakeModerationGateway();
   const service=new ModerationService(store,policy,fake,()=>now);
   assert.equal((await service.addManualReason(OWNER,CHAT,TARGET,'staff-expired','BAN')).status,'APPLIED');
   assert.deepEqual(fake.calls.map(x=>x.kind),['BAN']);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
