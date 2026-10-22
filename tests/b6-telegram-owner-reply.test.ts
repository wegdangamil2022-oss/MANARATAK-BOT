import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseB6OwnerReplyTarget as parse} from '../src/b6-telegram-owner-reply.js';
const GROUP='-100555',ACTOR='100';
const question='ما شروط المنحة؟';
const parent=(text=question)=>({
 message_id:40,chat:{id:Number(GROUP),type:'supergroup'},
 from:{id:300,is_bot:false},text
});
test('B6 S12-02 only the direct Telegram replied-to message text is accepted',()=>{
 assert.deepEqual(parse(parent(),GROUP,41,ACTOR),{status:'QUESTION',question});
});
test('B6 S12-02 missing replied message never falls back to arbitrary history',()=>{
 assert.deepEqual(parse(undefined,GROUP,41,ACTOR),{status:'MISSING_REPLY'});
});
test('B6 S12-02 rejects nested replies, forwarded content and a bot as question author',()=>{
 for(const value of [
  {...parent(),reply_to_message:parent()},
  {...parent(),forward_date:3},
  {...parent(),sender_chat:{id:555}},
  {...parent(),from:{id:300,is_bot:true}},
  {...parent(),from:{id:100,is_bot:false}},
  {...parent(),chat:{id:-100333,type:'supergroup'}}
 ])assert.deepEqual(parse(value,GROUP,41,ACTOR),{status:'INVALID'});
});
test('B6 S12-02 rejects invalid bytes, future message IDs and unsupported payloads',()=>{
 for(const value of [
  null,[],{...parent(),text:question+'\u202e'},
  {...parent(),text:'x'.repeat(241)},
  {...parent(),message_id:41},
  {...parent(),text:' \t'},
  {...parent(),text:question,caption:'shadow'}
 ])assert.deepEqual(parse(value,GROUP,41,ACTOR),{status:'INVALID'});
});
