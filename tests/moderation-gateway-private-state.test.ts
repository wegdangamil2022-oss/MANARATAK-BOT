import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const OTHER_TOKEN='987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const BOT=123456789,OWNER='100',GROUP='-100123',TARGET='300';
const status=(status:string,id:number,extra:Record<string,unknown>={})=>
 new Response(JSON.stringify({ok:true,result:{status,
  user:{id,is_bot:id===BOT},...extra}}),
  {status:200,headers:{'content-type':'application/json'}});
const success=()=>new Response(JSON.stringify({ok:true,result:true}),
 {status:200,headers:{'content-type':'application/json'}});
const fail=()=>new Response('unavailable',{status:503});
function readOrFail(method:string,body:{user_id:number}){
 if(method!=='getChatMember')return fail();
 return body.user_id===BOT?
  status('administrator',BOT,{can_restrict_members:true}):
  status('member',body.user_id);
}
function requestFrom(fn:(method:string,body:{user_id:number})=>Response){
 const calls:{method:string;url:string}[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  calls.push({method,url:String(url)});
  return fn(method,JSON.parse(String(init?.body)) as {user_id:number});
 }) as typeof fetch;
 return {request,calls};
}
test('runtime safetyGate shadow cannot arm a constructor-disabled moderation adapter',async()=>{
 const actual=requestFrom(readOrFail);
 const forged=requestFrom((_method,body)=>body.user_id?
  readOrFail('getChatMember',body):success());
 const gateway=new TelegramBotApiModerationGateway(TOKEN,actual.request,async()=>false);
 // Ordinary TS private parameter properties were publicly mutable at runtime.
 Object.assign(gateway,{safetyGate:async()=>true,request:forged.request});
 assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(gateway),true);
 assert.equal(await gateway.setRestriction(GROUP,TARGET,'BAN'),'FAILED_CONFIRMED');
 assert.deepEqual(actual.calls,[]);
 assert.deepEqual(forged.calls,[]);
});
test('runtime transport shadow cannot fabricate a confirmed Telegram mutation',async()=>{
 const actual=requestFrom(readOrFail);
 const forged=requestFrom((method,body)=>method==='getChatMember'?
  readOrFail(method,body):success());
 const gateway=new TelegramBotApiModerationGateway(TOKEN,actual.request,async()=>true);
 Object.assign(gateway,{request:forged.request});
 assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(gateway),true);
 assert.equal(await gateway.setRestriction(GROUP,TARGET,'BAN'),'UNKNOWN_OUTCOME');
 assert.deepEqual(actual.calls.map(x=>x.method),
  ['getChatMember','getChatMember','banChatMember']);
 assert.deepEqual(forged.calls,[]);
});
test('constructor token and bot identity cannot be rebound via public JavaScript properties',async()=>{
 const actual=requestFrom(readOrFail);
 const gateway=new TelegramBotApiModerationGateway(TOKEN,actual.request,async()=>true);
 Object.assign(gateway,{token:OTHER_TOKEN,botId:Number(TARGET)});
 assert.equal(await gateway.canRestrict(GROUP,TARGET),true);
 assert.deepEqual(actual.calls.map(x=>x.method),['getChatMember']);
 assert.equal(actual.calls[0]?.url,
  'https://api.telegram.org/bot'+TOKEN+'/getChatMember');
});
for(const engine of ['json','sqlite'] as const){
 test(engine+' forged mutable transport cannot turn a rejected sanction into CONFIRMED evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-gateway-private-state-'));
  try{
   const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
   const policy=new Policy(store,OWNER,()=>1_700_000_000_000);
   await policy.approveChat(OWNER,GROUP,['moderation']);
   const actual=requestFrom(readOrFail);
   const forged=requestFrom((method,body)=>method==='getChatMember'?
    readOrFail(method,body):success());
   const gateway=new TelegramBotApiModerationGateway(TOKEN,actual.request,async()=>true);
   Object.assign(gateway,{request:forged.request});
   const outcome=await new ModerationService(store,policy,gateway,
    ()=>1_700_000_000_000).addManualReason(OWNER,GROUP,TARGET,'private-transport-shadow','BAN');
   assert.equal(outcome.status,'UNKNOWN_OUTCOME');
   const op=(await store.snapshot()).moderationOperations[0]!;
   assert.equal(op.attemptGateway,'TELEGRAM_API');
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal(forged.calls.length,0);
   assert.ok(actual.calls.some(x=>x.method==='banChatMember'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' forged mutable STOP cannot send ban or mute and is recorded as local no-send',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-gateway-stop-shadow-'));
  try{
   const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
   const policy=new Policy(store,OWNER,()=>1_700_000_000_000);
   await policy.approveChat(OWNER,GROUP,['moderation']);
   const actual=requestFrom((method,body)=>method==='getChatMember'?
    readOrFail(method,body):success());
   const gateway=new TelegramBotApiModerationGateway(TOKEN,actual.request,async()=>false);
   Object.assign(gateway,{safetyGate:async()=>true});
   const outcome=await new ModerationService(store,policy,gateway,
    ()=>1_700_000_000_000).addManualReason(OWNER,GROUP,TARGET,'private-stop-shadow','MUTE');
   assert.equal(outcome.status,'FAILED_CONFIRMED');
   const op=(await store.snapshot()).moderationOperations[0]!;
   assert.equal(op.status,'FAILED_CONFIRMED');
   assert.equal(actual.calls.some(x=>x.method==='restrictChatMember'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
