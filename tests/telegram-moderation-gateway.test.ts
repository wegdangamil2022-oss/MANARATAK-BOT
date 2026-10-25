import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {ModerationService} from '../src/moderation.js';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
const GROUP='-100123',OWNER='100',MEMBER='300',STAFF='301';
const member=(status:string,userId:number,more:Record<string,unknown>={})=>
 new Response(JSON.stringify({ok:true,result:{status,user:{id:userId,is_bot:userId===BOT},...more}}),
  {status:200,headers:{'content-type':'application/json'}});
const acknowledged=()=>new Response(JSON.stringify({ok:true,result:true}),
 {status:200,headers:{'content-type':'application/json'}});
function fake(fn:(method:string,body:Record<string,unknown>,index:number)=>Response|Promise<Response>){
 const calls:{method:string;body:Record<string,unknown>;init:RequestInit}[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  calls.push({method,body,init:init??{}});
  return fn(method,body,calls.length);
 }) as typeof fetch;
 return {request,calls};
}
const granted=(method:string,body:Record<string,unknown>)=>{
 if(method==='getChatMember')return body.user_id===BOT?
  member('administrator',BOT,{can_restrict_members:true}):member('member',Number(body.user_id));
 return acknowledged();
};
test('invalid API tokens and target IDs make zero remote requests',async()=>{
 let calls=0;
 const request=(async()=>{calls++;throw Error('NETWORK_MUST_NOT_HAPPEN');}) as typeof fetch;
 for(const token of ['', '123:abc','123456789:abc/def'])
  assert.throws(()=>new TelegramBotApiModerationGateway(token,request,async()=>true),
   /INVALID_TELEGRAM_TOKEN/);
 const gateway=new TelegramBotApiModerationGateway(TOKEN,request,async()=>true);
 for(const chat of ['0','100','-0','-abc','--100','-9007199254740999','-100/abc','-0100']){
  assert.equal(await gateway.canRestrict(chat,MEMBER),false);
  assert.equal(await gateway.isProtected(chat,MEMBER),true);
  assert.equal(await gateway.setRestriction(chat,MEMBER,'BAN'),'FAILED_CONFIRMED');
 }
 for(const target of ['0','-1','abc','01','9007199254740992',String(BOT)]){
  assert.equal(await gateway.canRestrict(GROUP,target),false);
  assert.equal(await gateway.isProtected(GROUP,target),true);
  assert.equal(await gateway.setRestriction(GROUP,target,'MUTE'),'FAILED_CONFIRMED');
 }
 assert.equal(await gateway.setRestriction(GROUP,MEMBER,'NONE'),'FAILED_CONFIRMED');
 assert.equal(calls,0);
});
test('read-only rights preflight demands fresh bot administrator can_restrict_members',async()=>{
 for(const [status,right,ok] of [
  ['administrator',true,true],['administrator',false,false],
  ['administrator',undefined,false],['creator',undefined,true],
  ['member',true,false],['restricted',true,false],['left',true,false]
 ] as const){
  const f=fake((_method,body)=>member(status,Number(body.user_id),
   right===undefined?{}:{can_restrict_members:right}));
  const gw=new TelegramBotApiModerationGateway(TOKEN,f.request);
  assert.equal(await gw.canRestrict(GROUP,MEMBER),ok,status+' '+right);
  assert.deepEqual(f.calls.map(c=>c.method),['getChatMember']);
  assert.deepEqual(f.calls[0]?.body,{chat_id:GROUP,user_id:BOT});
 }
});
test('target preflight protects chat owners, administrators, bots and unverified statuses',async()=>{
 for(const [status,botFlag,protectedExpected] of [
  ['creator',false,true],['administrator',false,true],['member',true,true],
  ['member',false,false],['restricted',false,true],['left',false,true],
  ['kicked',false,true],['bogus',false,true]
 ] as const){
  const f=fake((_m,body)=>new Response(JSON.stringify({ok:true,result:{
   status,user:{id:body.user_id,is_bot:botFlag},
   ...(status==='restricted'?{is_member:false}:{})
  }}),{status:200,headers:{'content-type':'application/json'}}));
  const gw=new TelegramBotApiModerationGateway(TOKEN,f.request);
  assert.equal(await gw.isProtected(GROUP,MEMBER),protectedExpected,status);
 }
 const allowed=fake(()=>member('restricted',300,{is_member:true}));
 assert.equal(await new TelegramBotApiModerationGateway(TOKEN,allowed.request).isProtected(GROUP,MEMBER),false);
});
test('unarmed gateway never performs a sanction even with valid IDs',async()=>{
 const f=fake(granted);
 const gw=new TelegramBotApiModerationGateway(TOKEN,f.request);
 assert.equal(await gw.setRestriction(GROUP,MEMBER,'BAN'),'FAILED_CONFIRMED');
 assert.equal(f.calls.length,0);
 const rejects=new TelegramBotApiModerationGateway(TOKEN,f.request,async()=>{throw Error('STOP')});
 assert.equal(await rejects.setRestriction(GROUP,MEMBER,'MUTE'),'FAILED_CONFIRMED');
 assert.equal(f.calls.length,0);
});
test('armed gateway checks bot rights and nonprotected target again before ban mutation',async()=>{
 const f=fake(granted);
 const gw=new TelegramBotApiModerationGateway(TOKEN,f.request,async()=>true);
 assert.equal(await gw.canRestrict(GROUP,MEMBER),true);
 assert.equal(await gw.isProtected(GROUP,MEMBER),false);
 assert.equal(await gw.setRestriction(GROUP,MEMBER,'BAN'),'CONFIRMED');
 assert.deepEqual(f.calls.map(c=>c.method),
  ['getChatMember','getChatMember','getChatMember','getChatMember','banChatMember']);
 assert.deepEqual(f.calls.at(-1)?.body,{chat_id:GROUP,user_id:300,revoke_messages:false});
 for(const c of f.calls) {
  assert.equal(c.init.method,'POST');
  assert.equal(c.init.redirect,'error');
  assert.equal(c.init.headers && (c.init.headers as Record<string,string>)['content-type'],'application/json');
  assert.ok(c.init.signal);
 }
});
test('mute sends independently specified all-denied permissions, not admin changes',async()=>{
 const f=fake(granted);
 const gw=new TelegramBotApiModerationGateway(TOKEN,f.request,async()=>true);
 assert.equal(await gw.setRestriction(GROUP,MEMBER,'MUTE'),'CONFIRMED');
 assert.deepEqual(f.calls.map(c=>c.method),['getChatMember','getChatMember','restrictChatMember']);
 const body=f.calls.at(-1)!.body;
 assert.deepEqual(Object.keys(body).sort(),['chat_id','permissions','use_independent_chat_permissions','user_id'].sort());
 assert.equal(body.chat_id,GROUP);assert.equal(body.user_id,300);
 assert.equal(body.use_independent_chat_permissions,true);
 const permissions=body.permissions as Record<string,unknown>;
 assert.equal(permissions.can_send_messages,false);
 assert.equal(permissions.can_send_photos,false);
 assert.equal(permissions.can_send_polls,false);
 assert.equal(permissions.can_send_other_messages,false);
 assert.equal(permissions.can_react_to_messages,false);
 assert.ok(Object.keys(permissions).length>=10);
 assert.ok(Object.values(permissions).every(v=>v===false));
});
test('revoked rights or newly promoted target blocks outgoing ban and mute (without retries)',async()=>{
 for(const kind of ['BAN','MUTE'] as const){
  const rights=fake((method,body)=>method==='getChatMember'?
   body.user_id===BOT?member('administrator',BOT,{can_restrict_members:false}):
     member('member',300):acknowledged());
  const a=new TelegramBotApiModerationGateway(TOKEN,rights.request,async()=>true);
  assert.equal(await a.setRestriction(GROUP,MEMBER,kind),'FAILED_CONFIRMED');
  assert.deepEqual(rights.calls.map(c=>c.method),['getChatMember']);
  const protectedMember=fake((method,body)=>method==='getChatMember'?
   body.user_id===BOT?member('administrator',BOT,{can_restrict_members:true}):
     member('administrator',300):acknowledged());
  const b=new TelegramBotApiModerationGateway(TOKEN,protectedMember.request,async()=>true);
  assert.equal(await b.setRestriction(GROUP,MEMBER,kind),'FAILED_CONFIRMED');
  assert.deepEqual(protectedMember.calls.map(c=>c.method),['getChatMember','getChatMember']);
 }
});
test('STOP applied after preflight prevents a sanction even though the bot held rights',async()=>{
 const f=fake(granted);
 let reads=0;
 const gateway=new TelegramBotApiModerationGateway(TOKEN,f.request,async()=>++reads===1);
 assert.equal(await gateway.setRestriction(GROUP,MEMBER,'BAN'),'FAILED_CONFIRMED');
 assert.deepEqual(f.calls.map(x=>x.method),['getChatMember','getChatMember']);
 assert.equal(reads,2);
});
test('forged bot identity, mismatched target and malformed preflight all fail closed',async()=>{
 const scenarios=[
  fake((method,body)=>method==='getChatMember'&&body.user_id===BOT?
   member('administrator',BOT+1,{can_restrict_members:true}):granted(method,body)),
  fake((method,body)=>method==='getChatMember'&&body.user_id===BOT?
   member('administrator',BOT,{can_restrict_members:true,user:{id:BOT,is_bot:false}}):granted(method,body)),
  fake((method,body)=>method==='getChatMember'&&body.user_id===300?
   member('member',301):granted(method,body)),
  fake((method,body)=>method==='getChatMember'&&body.user_id===300?
   new Response('bad-json',{status:200}):granted(method,body))
 ];
 for(const f of scenarios){
  const gateway=new TelegramBotApiModerationGateway(TOKEN,f.request,async()=>true);
  assert.equal(await gateway.setRestriction(GROUP,MEMBER,'BAN'),'FAILED_CONFIRMED');
  assert.equal(f.calls.some(x=>x.method==='banChatMember'),false);
 }
});
test('ambiguous API results stay UNKNOWN_OUTCOME, explicit 4xx denial stays FAILED_CONFIRMED',async()=>{
 const responses=[
  new Response('not-json',{status:200}),
  new Response(JSON.stringify({ok:true,result:false}),{status:200}),
  new Response(JSON.stringify({ok:true,result:true}),{status:503}),
  new Response(JSON.stringify({ok:false,error_code:500}),{status:503}),
  new Response(JSON.stringify({ok:false,error_code:403,description:'token='+TOKEN}),{status:403,headers:{'content-type':'application/json'}}),
  new Response(JSON.stringify({ok:false,error_code:429}),{status:429,headers:{'content-type':'application/json'}}),
  new Response(JSON.stringify({ok:true,result:true}),{status:200,headers:{'content-type':'text/html'}})
 ];
 for(const [i,r] of responses.entries()){
  const f=fake((method,body)=>method==='getChatMember'?
   granted(method,body):r);
  const gw=new TelegramBotApiModerationGateway(TOKEN,f.request,async()=>true);
  const result=await gw.setRestriction(GROUP,MEMBER,'BAN');
  assert.equal(result,[ 'UNKNOWN_OUTCOME','UNKNOWN_OUTCOME','UNKNOWN_OUTCOME','UNKNOWN_OUTCOME',
   'FAILED_CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME'][i]);
  assert.equal(f.calls.filter(c=>c.method==='banChatMember').length,1);
 }
 const failing=fake((method,body)=>{
  if(method==='banChatMember')throw Error('timeout secret '+TOKEN);
  return granted(method,body);
 });
 const gw=new TelegramBotApiModerationGateway(TOKEN,failing.request,async()=>true);
 assert.equal(await gw.setRestriction(GROUP,MEMBER,'BAN'),'UNKNOWN_OUTCOME');
 assert.equal(failing.calls.filter(c=>c.method==='banChatMember').length,1);
});
for(const engine of ['json','sqlite'] as const){
 test('existing durable ModerationService works with real-shaped gateway and unknown outcome never retries ('+engine+')',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-telegram-moderation-'));
  try{
   const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
   const policy=new Policy(store,OWNER);
   await policy.approveChat(OWNER,GROUP,['moderation']);
   const f=fake(granted);
   const moderation=new ModerationService(store,policy,
    new TelegramBotApiModerationGateway(TOKEN,f.request,async()=>true));
   assert.equal((await moderation.addManualReason(OWNER,GROUP,MEMBER,'case-1','BAN')).status,'APPLIED');
   assert.equal((await store.snapshot()).moderationOperations.at(-1)?.status,'CONFIRMED');
   assert.equal(f.calls.filter(c=>c.method==='banChatMember').length,1);
   const blocked=fake((method,body)=>method==='banChatMember'?
    new Response('server unavailable',{status:503}):granted(method,body));
   const unknown=new ModerationService(store,policy,
    new TelegramBotApiModerationGateway(TOKEN,blocked.request,async()=>true));
   assert.equal((await unknown.addManualReason(OWNER,GROUP,'302','case-2','MUTE')).status,'APPLIED');
   assert.equal((await unknown.addManualReason(OWNER,GROUP,MEMBER,'case-3','BAN')).status,'NO_CHANGE');
   assert.equal((await unknown.addManualReason(OWNER,GROUP,'303','case-4','BAN')).status,'UNKNOWN_OUTCOME');
   assert.equal((await unknown.reconcile(OWNER,GROUP,'303')).status,'BLOCKED_UNKNOWN');
   assert.equal(blocked.calls.filter(c=>c.method==='banChatMember').length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
