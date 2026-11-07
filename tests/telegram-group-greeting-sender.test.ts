import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramGroupGreetingSender} from '../src/telegram-group-greeting-sender.js';

const token='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const payload={chatId:'-100123',text:'🎓 أهلاً بالجميع في مجموعة منارتك',
 buttons:[[{text:'📚 الدليل',url:'https://study.example.org/guide'}]],topicId:42};
const receipt=()=>({ok:true,result:{message_id:81,chat:{id:-100123},from:{id:123456789,is_bot:true},message_thread_id:42}});
test('greeting sender sends only plain text with owner-approved URL buttons to correct topic',async()=>{
 let sent:Record<string,unknown>|undefined;
 const request=(async(_url:unknown,opts:RequestInit)=>{sent=JSON.parse(String(opts.body));return Response.json(receipt());}) as typeof fetch;
 const sender=new TelegramGroupGreetingSender(token,request);
 assert.deepEqual(await sender.send(payload,async()=>true),{status:'CONFIRMED',messageId:81});
 assert.equal(sent!.chat_id,'-100123');assert.equal(sent!.text,payload.text);
 assert.equal(sent!.message_thread_id,42);
 assert.equal(sent!.parse_mode,undefined);
 assert.equal(sent!.disable_notification,true);
 assert.deepEqual(sent!.reply_markup,{inline_keyboard:payload.buttons});
});
test('greeting sender refuses invalid recipients, clickable links and unauthorized messages before request',async()=>{
 let calls=0;
 const sender=new TelegramGroupGreetingSender(token,(async()=>{calls++;return Response.json(receipt());}) as typeof fetch);
 assert.equal((await sender.send({...payload,chatId:'100'},async()=>true)).status,'NOT_SENT');
 assert.equal((await sender.send({...payload,buttons:[[{text:'X',url:'http://insecure.example.org'}]]},async()=>true)).status,'NOT_SENT');
 assert.equal((await sender.send({...payload,buttons:[[{text:'X',url:'https://localhost/'}]]},async()=>true)).status,'NOT_SENT');
 assert.equal((await sender.send({...payload,text:'x'.repeat(4097)},async()=>true)).status,'NOT_SENT');
 assert.equal((await sender.send(payload,async()=>false)).status,'NOT_SENT');
 assert.equal(calls,0);
});
test('greeting sender copies untrusted object before checking async authority',async()=>{
 let body:Record<string,unknown>|undefined;
 const sender=new TelegramGroupGreetingSender(token,(async(_u,opts)=>{body=JSON.parse(String(opts?.body));return Response.json(receipt());}) as typeof fetch);
 const changed={...payload};
 assert.equal((await sender.send(changed,async()=>{changed.chatId='-100999';return true;})).status,'CONFIRMED');
 assert.equal(body!.chat_id,'-100123');
});
test('greeting sender rejects mismatched Telegram chat, sender, topic and uncertain results',async()=>{
 for(const v of ['chat','from','topic','id','network','rejected'] as const){
  const request=(async()=>{
   if(v==='network')throw Error('network');
   if(v==='rejected')return Response.json({ok:false,error_code:403},{status:403});
   const d=receipt();
   if(v==='chat')d.result.chat.id=-999;
   if(v==='from')d.result.from.id=7;
   if(v==='topic')d.result.message_thread_id=3;
   if(v==='id')d.result.message_id=0;
   return Response.json(d);
  }) as typeof fetch;
  const result=await new TelegramGroupGreetingSender(token,request).send(payload,async()=>true);
  assert.equal(result.status,v==='rejected'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME');
 }
});
test('greeting sender deletes only provided verified own-message ID under a fresh safety guard',async()=>{
 let calls=0;
 const request=(async(url:string,init:RequestInit)=>{
  calls++;assert.match(url,/\/deleteMessage$/u);
  assert.deepEqual(JSON.parse(String(init.body)),{chat_id:'-100123',message_id:81});
  return Response.json({ok:true,result:true});
 }) as typeof fetch;
 const sender=new TelegramGroupGreetingSender(token,request);
 assert.equal(await sender.delete('-100123',81,async()=>false),'NOT_SENT');
 assert.equal(await sender.delete('-100123',81,async()=>true),'ACKNOWLEDGED');
 assert.equal(calls,1);
});
