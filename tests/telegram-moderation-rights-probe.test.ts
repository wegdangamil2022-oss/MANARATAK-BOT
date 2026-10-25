import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
const token='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',id=123456789,chat='-100123';
function query(payload:unknown){
 const methods:string[]=[];
 const request=(async(url:string|URL|Request)=>{
  methods.push(String(url).split('/').at(-1)!);
  return new Response(JSON.stringify({ok:true,result:payload}),{status:200,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 const gw=new TelegramBotApiModerationGateway(token,request);
 const inspect=(gw as unknown as {inspectBotModerationRights:(group:string)=>Promise<string>}).inspectBotModerationRights.bind(gw);
 return {methods,inspect};
}
test('moderation rights probe reads ONLY getChatMember and needs verified rights',async()=>{
 const p=query({status:'administrator',user:{id,is_bot:true},can_restrict_members:true});
 assert.equal(await p.inspect(chat),'GRANTED');
 assert.deepEqual(p.methods,['getChatMember']);
});
test('missing restrict permission is a verified denial',async()=>{
 const p=query({status:'administrator',user:{id,is_bot:true},can_restrict_members:false});
 assert.equal(await p.inspect(chat),'DENIED');
 assert.deepEqual(p.methods,['getChatMember']);
});
test('mismatched identity is UNKNOWN, not GRANTED',async()=>{
 const p=query({status:'administrator',user:{id:111,is_bot:true},can_restrict_members:true});
 assert.equal(await p.inspect(chat),'UNKNOWN');
 assert.deepEqual(p.methods,['getChatMember']);
});
test('invalid group makes zero HTTP requests',async()=>{
 const p=query({status:'creator',user:{id,is_bot:true}});
 assert.equal(await p.inspect('not-a-group'),'UNKNOWN');
 assert.deepEqual(p.methods,[]);
});

test('verified Telegram creator bot rights are GRANTED',async()=>{
 const p=query({status:'creator',user:{id,is_bot:true}});
 assert.equal(await p.inspect(chat),'GRANTED');
 assert.deepEqual(p.methods,['getChatMember']);
});
test('bot demoted to an ordinary group member is DENIED',async()=>{
 const p=query({status:'member',user:{id,is_bot:true}});
 assert.equal(await p.inspect(chat),'DENIED');
 assert.deepEqual(p.methods,['getChatMember']);
});
test('unrecognized provider status must not be treated as administrator authority',async()=>{
 const p=query({status:'synthetic',user:{id,is_bot:true},can_restrict_members:true});
 assert.equal(await p.inspect(chat),'UNKNOWN');
 assert.deepEqual(p.methods,['getChatMember']);
});
test('user.is_bot false cannot impersonate an authorized bot',async()=>{
 const p=query({status:'administrator',user:{id,is_bot:false},can_restrict_members:true});
 assert.equal(await p.inspect(chat),'UNKNOWN');
 assert.deepEqual(p.methods,['getChatMember']);
});
test('invalid grant type remains UNKNOWN, not coerced to true',async()=>{
 const p=query({status:'administrator',user:{id,is_bot:true},can_restrict_members:'true'});
 assert.equal(await p.inspect(chat),'UNKNOWN');
 assert.deepEqual(p.methods,['getChatMember']);
});
test('provider HTTP errors and timeouts cannot grant moderation rights',async()=>{
 const methods:string[]=[];
 const request=(async(url:string|URL|Request)=>{
  methods.push(String(url).split('/').at(-1)!);
  throw Error('isolated network timeout');
 }) as typeof fetch;
 const gw=new TelegramBotApiModerationGateway(token,request);
 const view=(gw as unknown as {inspectBotModerationRights:(c:string)=>Promise<string>}).inspectBotModerationRights.bind(gw);
 assert.equal(await view(chat),'UNKNOWN');
 assert.deepEqual(methods,['getChatMember']);
});
