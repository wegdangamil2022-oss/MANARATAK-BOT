import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {ModerationService} from '../src/moderation.js';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
const CHAT='-100123',TARGET='300',OWNER='100',NOW=1_700_000_000_000;
function port(botHasRights=true){
 const methods:string[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  methods.push(method);
  const body=JSON.parse(String(init?.body)) as {user_id:number};
  if(method!=='getChatMember')throw Error('NO_NETWORK_MUTATIONS');
  const isBot=body.user_id===BOT;
  const status=isBot?(botHasRights?'administrator':'member'):'member';
  return new Response(JSON.stringify({ok:true,result:{
   status,user:{id:body.user_id,is_bot:isBot},
   ...(isBot?{can_restrict_members:botHasRights}:{})
  }}),{status:200,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 return {request,methods};
}
const fakeConfirmed=async()=>({status:'HTTP_OK',value:true});
test('instance shadowing of STOP, remote rights and response decoder cannot send BAN',async()=>{
 const network=port();
 const gateway=new TelegramBotApiModerationGateway(TOKEN,network.request,async()=>false);
 Object.assign(gateway,{
  allowed:async()=>true,
  canRestrict:async()=>true,
  isProtected:async()=>false,
  call:fakeConfirmed
 });
 assert.equal(await gateway.setRestriction(CHAT,TARGET,'BAN'),'FAILED_CONFIRMED');
 assert.deepEqual(network.methods,[]);
});
test('instance rights and transport shadows cannot send MUTE without actual bot restriction permission',async()=>{
 const network=port(false);
 const gateway=new TelegramBotApiModerationGateway(TOKEN,network.request,async()=>true);
 Object.assign(gateway,{
  canRestrict:async()=>true,
  isProtected:async()=>false,
  getMember:async()=>({status:'member',user:{id:Number(TARGET),is_bot:false}}),
  call:fakeConfirmed
 });
 assert.equal(await gateway.setRestriction(CHAT,TARGET,'MUTE'),'FAILED_CONFIRMED');
 assert.deepEqual(network.methods,['getChatMember']);
});
test('read-only bot rights cannot be forged by shadowing internal getMember',async()=>{
 const network=port(false);
 const gateway=new TelegramBotApiModerationGateway(TOKEN,network.request);
 Object.assign(gateway,{getMember:async()=>({
  status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true
 })});
 assert.equal(await gateway.inspectBotModerationRights(CHAT),'DENIED');
 assert.deepEqual(network.methods,['getChatMember']);
});
test('read-only reversal observation cannot be forged through public method shadows',async()=>{
 const network=port(false);
 const gateway=new TelegramBotApiModerationGateway(TOKEN,network.request);
 Object.assign(gateway,{
  canRestrict:async()=>true,
  getMember:async()=>({status:'kicked',user:{id:Number(TARGET),is_bot:false}})
 });
 assert.equal(await gateway.observeRestriction(CHAT,TARGET),'NO_RIGHTS');
 assert.deepEqual(network.methods,['getChatMember']);
});
test('rewriting an official prototype method cannot redefine its trusted origin',()=>{
 const proto=TelegramBotApiModerationGateway.prototype;
 const original=Object.getOwnPropertyDescriptor(proto,'setRestriction')!;
 const gateway=new TelegramBotApiModerationGateway(TOKEN,port().request);
 assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(gateway),true);
 try{
  Object.defineProperty(proto,'setRestriction',{
   ...original,value:async()=> 'CONFIRMED'
  });
  assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(gateway),false,
   'a rewritten prototype must not become its own authentication reference');
 }finally{
  Object.defineProperty(proto,'setRestriction',original);
 }
 assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(gateway),true);
 assert.equal(Object.isFrozen(TelegramBotApiModerationGateway),true,
  'static origin-check methods must not be rebindable');
});
for(const engine of ['json','sqlite'] as const){
 test(engine+' owner sanction with shadowed STOP and fake confirmation cannot produce APPLIED',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-moderation-method-integrity-'));
  try{
   const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,CHAT,['moderation']);
   const network=port();
   const gateway=new TelegramBotApiModerationGateway(TOKEN,network.request,async()=>false);
   Object.assign(gateway,{
    allowed:async()=>true,canRestrict:async()=>true,
    isProtected:async()=>false,call:fakeConfirmed
   });
   const result=await new ModerationService(store,policy,gateway,()=>NOW)
    .addManualReason(OWNER,CHAT,TARGET,'stop-method-shadow','BAN');
   assert.equal(result.status,'FAILED_CONFIRMED');
   assert.deepEqual(network.methods,[]);
   const state=await store.snapshot();
   assert.equal(state.moderationOperations.length,1);
   assert.equal(state.moderationOperations[0]?.status,'FAILED_CONFIRMED');
   assert.equal(state.moderationOperations[0]?.attemptGateway,'UNSPECIFIED');
  }finally{await rm(dir,{force:true,recursive:true});}
 });
}
