import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramEphemeralTextSender} from '../src/telegram-ephemeral-sender.js';
import {TelegramBotApiTextSender} from '../src/telegram-replies.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const plan={chatId:'-100123',receiverId:'300',text:'رسالة خاصة داخل المجموعة'};
test('temporary private fallback distinguishes confirmed forbidden from uncertain and unsent requests',async()=>{
 const privatePlan={chatId:'300',parseMode:'HTML' as const,text:'verification'};
 for(const variant of ['forbidden','rate-limit','malformed','unknown','not-authorized'] as const){
  let calls=0;const request=(async()=>{calls++;if(variant==='unknown')throw Error('lost');return Response.json({ok:false,error_code:variant==='malformed'?400:variant==='rate-limit'?429:403},{status:variant==='rate-limit'?429:403});}) as typeof fetch;
  const sender=new TelegramBotApiTextSender(TOKEN,request);
  const result=await sender.sendTemporaryPrivate(privatePlan,async()=>variant!=='not-authorized');
  assert.equal(result.status,variant==='forbidden'?'PRIVATE_UNAVAILABLE':variant==='unknown'||variant==='malformed'?'UNKNOWN_OUTCOME':'FAILED_CONFIRMED');
  assert.equal(calls,variant==='not-authorized'?0:1);
 }
});
const reply=()=>({ok:true,result:{chat:{id:-100123},from:{id:123456789,is_bot:true},receiver_user:{id:300,is_bot:false},ephemeral_message_id:45}});
test('ephemeral message uses the official recipient parameter and requires matching receipt',async()=>{
 const calls:{url:string;body:Record<string,unknown>}[]=[];const request=(async(url:unknown,init:RequestInit)=>{calls.push({url:String(url),body:JSON.parse(String(init.body))});return Response.json(reply());}) as typeof fetch;
 const sender=new TelegramEphemeralTextSender(TOKEN,request,async()=>true);assert.deepEqual(await sender.send(plan,async()=>true),{status:'ACKNOWLEDGED',ephemeralMessageId:45});assert.equal(calls.length,1);assert.match(calls[0]!.url,/\/sendMessage$/u);assert.deepEqual(calls[0]!.body.ephemeral_message_parameters,{receiver_user_id:300});assert.equal(calls[0]!.body.chat_id,'-100123');assert.equal(Object.hasOwn(calls[0]!.body,'receiver_user_id'),false);
});
test('ephemeral delivery requires current authorization and emergency gate immediately before sending',async()=>{
 let calls=0,checks=0;const request=(async()=>{calls++;return Response.json(reply());}) as typeof fetch;const sender=new TelegramEphemeralTextSender(TOKEN,request,async()=>++checks===1);
 assert.equal((await sender.send(plan,async()=>true)).status,'FAILED_CONFIRMED');assert.equal(calls,0);
 const denied=new TelegramEphemeralTextSender(TOKEN,request,async()=>true);assert.equal((await denied.send(plan,async()=>false)).status,'FAILED_CONFIRMED');assert.equal((await denied.send({...plan,receiverId:'300\n'},async()=>true)).status,'FAILED_CONFIRMED');assert.equal(calls,0);
});
test('the validated recipient and text cannot change during the awaited authority check',async()=>{
 const input={...plan},bodies:Record<string,unknown>[]=[];const request=(async(_url:unknown,init:RequestInit)=>{bodies.push(JSON.parse(String(init.body)));return Response.json(reply());}) as typeof fetch;
 const sender=new TelegramEphemeralTextSender(TOKEN,request,async()=>true);assert.equal((await sender.send(input,async()=>{input.chatId='-999';input.receiverId='301';input.text='changed';return true;})).status,'ACKNOWLEDGED');assert.equal(bodies[0]!.chat_id,'-100123');assert.deepEqual(bodies[0]!.ephemeral_message_parameters,{receiver_user_id:300});assert.equal(bodies[0]!.text,plan.text);
});
test('ephemeral receipt must match the selected group topic',async()=>{
 const request=(async(_url:unknown,init:RequestInit)=>{const body=JSON.parse(String(init.body));assert.equal(body.message_thread_id,31);return Response.json({...reply(),result:{...reply().result,message_thread_id:32}});}) as typeof fetch;
 assert.equal((await new TelegramEphemeralTextSender(TOKEN,request,async()=>true).send({...plan,topicId:31},async()=>true)).status,'UNKNOWN_OUTCOME');
});
test('ephemeral delivery never treats mismatched receipts or lost responses as success or safe fallback',async()=>{
 for(const variant of ['wrong-chat','wrong-recipient','wrong-sender','missing-id','timeout','denied','bad-denial'] as const){
  const request=(async()=>{if(variant==='timeout')throw Error('timeout');if(variant==='denied')return Response.json({ok:false,error_code:400},{status:400});if(variant==='bad-denial')return Response.json({ok:false,error_code:401},{status:400});const data=reply();if(variant==='wrong-chat')data.result.chat.id=-999;if(variant==='wrong-recipient')data.result.receiver_user.id=301;if(variant==='wrong-sender')data.result.from.id=999;if(variant==='missing-id')data.result.ephemeral_message_id=0;return Response.json(data);}) as typeof fetch;
  const result=await new TelegramEphemeralTextSender(TOKEN,request,async()=>true).send(plan,async()=>true);assert.equal(result.status,variant==='denied'?'PROVIDER_REJECTED':'UNKNOWN_OUTCOME');
 }
});
test('rate limiting and forbidden access do not become an unsupported-message rejection',async()=>{
 for(const status of [403,429]){const request=(async()=>Response.json({ok:false,error_code:status},{status})) as typeof fetch;const result=await new TelegramEphemeralTextSender(TOKEN,request,async()=>true).send(plan,async()=>true);assert.equal(result.status,'FAILED_CONFIRMED');}
});
