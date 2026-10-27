import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {inspectIsolatedModerationRightsReadOnly} from '../src/moderation-trial-rights.js';

const OWNER='100',GROUP='-100123',BOT=123456789;
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const validBot=new Response(JSON.stringify({ok:true,result:{
 status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true
}}),{status:200,headers:{'content-type':'application/json'}});

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-rights-trust-'));
 const stateFile=join(dir,'state.sqlite'),backupFile=join(dir,'backup.sqlite');
 const safetyFile=join(dir,'operator-stop.flag');
 const store=new BotStore(stateFile,{engine:'sqlite'});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 await policy.setPresence(GROUP,true);
 await chmod(stateFile,0o600);
 await writeFile(safetyFile,'STOP\n',{mode:0o600});
 await BotStore.backupSqlite(stateFile,backupFile);
 await chmod(backupFile,0o600);
 return {options:()=>({stateFile,backupFile,safetyFile,now:Date.now(),
   staleAfterMs:900_000,trialChatId:GROUP}),stateFile,backupFile,
  close:()=>rm(dir,{recursive:true,force:true})};
}
const blocked={stage:'READ_ONLY_MODERATION_RIGHTS',status:'BLOCKED',
 safety:'STOP',rollback:'MATCH',botRights:'NOT_CHECKED',
 reasons:['BOT_MODERATION_GATEWAY_UNTRUSTED']};

test('a structural fake claiming GRANTED never supplies verified Telegram rights',async()=>{
 const f=await fixture();try{
  let calls=0;
  const fake={attemptGateway:'TELEGRAM_API',
   inspectBotModerationRights:async()=>{calls++;return 'GRANTED' as const;}};
  const before=await readFile(f.stateFile);
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),fake);
  assert.deepEqual(r,blocked);
  assert.equal(calls,0);
  assert.deepEqual(await readFile(f.stateFile),before);
 }finally{await f.close();}
});

test('a subclass overriding the rights method is not a trusted observation source',async()=>{
 const f=await fixture();try{
  let remoteCalls=0,spoofCalls=0;
  class ForgedRights extends TelegramBotApiModerationGateway{
   override async inspectBotModerationRights(_group:string):Promise<'GRANTED'>{
    spoofCalls++;return 'GRANTED';
   }
  }
  const gateway=new ForgedRights(TOKEN,(async()=>{
   remoteCalls++;return validBot;
  }) as typeof fetch);
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),gateway);
  assert.deepEqual(r,blocked);
  assert.equal(remoteCalls,0);
  assert.equal(spoofCalls,0);
 }finally{await f.close();}
});

test('monkey-patched official rights reader cannot yield advisory PASS',async()=>{
 const f=await fixture();try{
  let calls=0;
  const gateway=new TelegramBotApiModerationGateway(TOKEN,(async()=>{
   calls++;return validBot;
  }) as typeof fetch);
  gateway.inspectBotModerationRights=async()=> 'GRANTED';
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),gateway);
  assert.deepEqual(r,blocked);
  assert.equal(calls,0);
 }finally{await f.close();}
});

test('a trusted adapter that changes while the first Telegram read awaits is quarantined before the second',async()=>{
 const f=await fixture();try{
  const methods:string[]=[];
  let gateway:TelegramBotApiModerationGateway;
  const request=(async(url:string|URL|Request,init?:RequestInit)=>{
   const method=String(url).split('/').at(-1)!;
   methods.push(method);
   assert.equal(method,'getChatMember');
   assert.deepEqual(JSON.parse(String(init?.body)),{chat_id:GROUP,user_id:BOT});
   gateway.inspectBotModerationRights=async()=> 'GRANTED';
   return validBot;
  }) as typeof fetch;
  gateway=new TelegramBotApiModerationGateway(TOKEN,request);
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),gateway);
  assert.deepEqual(r,blocked);
  assert.deepEqual(methods,['getChatMember']);
 }finally{await f.close();}
});

test('a normal official read-only gateway remains usable for two isolated rights observations',async()=>{
 const f=await fixture();try{
  const calls:string[]=[];
  const gateway=new TelegramBotApiModerationGateway(TOKEN,(async(url:string|URL|Request)=>{
   calls.push(String(url).split('/').at(-1)!);
   return validBot;
  }) as typeof fetch);
  const r=await inspectIsolatedModerationRightsReadOnly(f.options(),gateway);
  assert.deepEqual(r,{stage:'READ_ONLY_MODERATION_RIGHTS',status:'PASS',
   safety:'STOP',rollback:'MATCH',botRights:'GRANTED',reasons:[]});
  assert.deepEqual(calls,['getChatMember','getChatMember']);
 }finally{await f.close();}
});
