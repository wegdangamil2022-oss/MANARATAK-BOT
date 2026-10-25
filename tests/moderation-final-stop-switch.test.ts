import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
const CHAT='-100123',TARGET='300';
function fakeApi(){
 const calls:string[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  const body=JSON.parse(String(init?.body)) as {user_id:number};
  calls.push(method);
  const result=method==='getChatMember'?
   body.user_id===BOT?
    {status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true}:
    {status:'member',user:{id:Number(body.user_id),is_bot:false}}:
   true;
  return new Response(JSON.stringify({ok:true,result}),{
   status:200,headers:{'content-type':'application/json'}
  });
 }) as typeof fetch;
 return {request,calls,sanctions:()=>calls.filter(x=>
  x==='banChatMember'||x==='restrictChatMember')};
}

for(const kind of ['BAN','MUTE'] as const){
 test('STOP flipped during awaited durable authority callback prevents '+kind+' mutation',async()=>{
  const api=fakeApi();
  let running=true;
  let checks=0;
  const gateway=new TelegramBotApiModerationGateway(TOKEN,api.request,async()=>{
   checks++;return running;
  });
  const result=await gateway.setRestriction(CHAT,TARGET,kind,async()=>{
   // The durable read may await disk while the operator writes STOP.
   await Promise.resolve();
   running=false;
   return true;
  });
  assert.equal(result,'FAILED_CONFIRMED');
  assert.deepEqual(api.sanctions(),[]);
  assert.equal(checks,3,'operator switch must be read after async local authority check');
 });
 test('STOP at final operator check denies '+kind+' without a network mutation',async()=>{
  const api=fakeApi();
  let checks=0;
  const gateway=new TelegramBotApiModerationGateway(TOKEN,api.request,async()=>++checks!==3);
  assert.equal(await gateway.setRestriction(CHAT,TARGET,kind,async()=>true),'FAILED_CONFIRMED');
  assert.deepEqual(api.sanctions(),[]);
  assert.equal(checks,3);
 });
}
test('throwing final STOP check fails closed and never leaks its message',async()=>{
 const api=fakeApi();
 let checks=0;
 const gateway=new TelegramBotApiModerationGateway(TOKEN,api.request,async()=>{
  checks++;
  if(checks===3)throw Error('private operator detail');
  return true;
 });
 assert.equal(await gateway.setRestriction(CHAT,TARGET,'BAN',async()=>true),'FAILED_CONFIRMED');
 assert.deepEqual(api.sanctions(),[]);
 assert.equal(checks,3);
});
test('stable RUN and affirmative current authority still permit exactly one isolated fake-HTTP write',async()=>{
 const api=fakeApi();
 let checks=0,reads=0;
 const gateway=new TelegramBotApiModerationGateway(TOKEN,api.request,async()=>{
  checks++;return true;
 });
 assert.equal(await gateway.setRestriction(CHAT,TARGET,'BAN',async()=>{
  reads++;return true;
 }),'CONFIRMED');
 assert.deepEqual(api.sanctions(),['banChatMember']);
 assert.equal(reads,1);
 assert.equal(checks,3);
});
