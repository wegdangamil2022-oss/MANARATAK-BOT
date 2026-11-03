import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramTemporaryGroupSender} from '../src/telegram-temporary-group-sender.js';
const token='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const plan={chatId:'-100123',botUsername:'ManaratakBot',topicId:42};
const receipt=()=>({ok:true,result:{chat:{id:-100123},from:{id:123456789,is_bot:true},message_id:80,message_thread_id:42}});

test('group notice is generic and preserves group and topic with a verified receipt',async()=>{
 let sent:Record<string,unknown>|undefined;
 const request=(async(_url:unknown,init:RequestInit)=>{sent=JSON.parse(String(init.body));return Response.json(receipt());}) as typeof fetch;
 const sender=new TelegramTemporaryGroupSender(token,request);
 assert.deepEqual(await sender.send(plan,async()=>true),{status:'CONFIRMED',messageId:80});
 assert.equal(sent!.chat_id,plan.chatId);assert.equal(sent!.message_thread_id,42);assert.doesNotMatch(String(sent!.text),/300|NOT_MEMBER/u);
 assert.deepEqual(sent!.reply_markup,{inline_keyboard:[[{text:'فتح البوت',url:'https://t.me/ManaratakBot'}]]});
});
test('group notice checks authority and immutable destination before any request',async()=>{
 let calls=0;const request=(async(_url:unknown,init:RequestInit)=>{calls++;assert.equal(JSON.parse(String(init.body)).chat_id,'-100123');return Response.json(receipt());}) as typeof fetch;
 const sender=new TelegramTemporaryGroupSender(token,request),mutable={...plan};
 assert.equal((await sender.send({...plan,botUsername:'x\n'},async()=>true)).status,'NOT_SENT');
 assert.equal((await sender.send(plan,async()=>false)).status,'NOT_SENT');assert.equal(calls,0);
 assert.equal((await sender.send(mutable,async()=>{mutable.chatId='-999';return true;})).status,'CONFIRMED');assert.equal(calls,1);
});
test('group send never certifies mismatched identity, topic, or lost response',async()=>{
 for(const variant of ['chat','sender','topic','id','lost','rejected'] as const){
  const request=(async()=>{if(variant==='lost')throw Error('lost');if(variant==='rejected')return Response.json({ok:false,error_code:403},{status:403});const data=receipt();if(variant==='chat')data.result.chat.id=-999;if(variant==='sender')data.result.from.id=3;if(variant==='topic')data.result.message_thread_id=44;if(variant==='id')data.result.message_id=0;return Response.json(data);}) as typeof fetch;
  assert.equal((await new TelegramTemporaryGroupSender(token,request).send(plan,async()=>true)).status,variant==='rejected'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME');
 }
});
test('group cleanup checks authorization and classifies uncertain outcomes without retrying',async()=>{
 let calls=0;const request=(async(_url:unknown,init:RequestInit)=>{calls++;assert.deepEqual(JSON.parse(String(init.body)),{chat_id:'-100123',message_id:80});return Response.json({ok:true,result:true});}) as typeof fetch;
 const sender=new TelegramTemporaryGroupSender(token,request);assert.equal(await sender.delete(plan.chatId,80,async()=>false),'NOT_SENT');assert.equal(calls,0);assert.equal(await sender.delete(plan.chatId,80,async()=>true),'ACKNOWLEDGED');assert.equal(calls,1);
 const lost=new TelegramTemporaryGroupSender(token,(async()=>{throw Error('lost');}) as typeof fetch);assert.equal(await lost.delete(plan.chatId,80,async()=>true),'UNKNOWN_OUTCOME');
});
