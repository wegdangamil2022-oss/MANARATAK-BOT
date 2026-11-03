import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePhase4TelegramEvents} from '../src/phase4-telegram-events.js';
const sender={id:200,is_bot:false,first_name:'إبراهيم'};
const chat={id:-100123456,type:'supergroup',title:'منارتك'};
const msg=(updateId:number,extra:Record<string,unknown>)=>({
 update_id:updateId,message:{message_id:updateId+100,chat,from:sender,...extra}});
test('phase4 events: joined members are distinct identities, not the inviter',()=>{
 const r=parsePhase4TelegramEvents(msg(1,{new_chat_members:[{id:300,is_bot:false,first_name:'أحمد'},
  {id:301,is_bot:false,first_name:'ليلى'}]}),1234);
 assert.equal(r.length,2);assert.deepEqual(r.map(e=>e.actorId),['300','301']);
 assert.deepEqual(r.map(e=>e.updateKey),['p4:1_join_0','p4:1_join_1']);
 assert.equal(r[0]?.verified,false);
 assert.equal(r[0]?.chatApproved,false);
});
test('phase4 events: leaving member is recorded without private messaging assumptions',()=>{
 const r=parsePhase4TelegramEvents(msg(2,{left_chat_member:{id:300,is_bot:false,first_name:'أحمد'}}),1234);
 assert.equal(r[0]?.kind,'LEAVE');assert.equal(r[0]?.actorId,'300');
});
test('phase4 events: normal text and commands are classified without triggering bot commands',()=>{
 const text=parsePhase4TelegramEvents(msg(3,{text:'السلام عليكم'}),1234);
 const command=parsePhase4TelegramEvents(msg(4,{text:'/guide'}),1234);
 assert.equal(text[0]?.kind,'KEYWORD');assert.equal(command[0]?.kind,'COMMAND');
});
test('phase4 events: group identity and forum topic are preserved',()=>{
 const r=parsePhase4TelegramEvents(msg(5,{message_thread_id:17,text:'منحة'}),1234);
 assert.equal(r[0]?.topicId,17);assert.equal(r[0]?.chatId,'-100123456');
});
test('phase4 events: group title/photo events are only audit candidates',()=>{
 assert.equal(parsePhase4TelegramEvents(msg(6,{new_chat_title:'عنوان جديد'}),1234)[0]?.kind,'GROUP_TITLE_CHANGED');
 assert.equal(parsePhase4TelegramEvents(msg(7,{delete_chat_photo:true}),1234)[0]?.kind,'GROUP_PHOTO_CHANGED');
});
test('phase4 events: forwarded, edited, bot senders, invalid groups and malformed updates produce no events',()=>{
 for(const payload of [
  {update_id:8,edited_message:{chat,from:sender,text:'مرحبا'}},
  msg(9,{forward_origin:{type:'user'},text:'منحة'}),
  msg(10,{forward_date:100,text:'منحة'}),
  msg(11,{text:'نص',from:{id:500,is_bot:true}}),
  msg(12,{text:'نص',chat:{id:100123,type:'private'}}),
  msg(13,{text:'نص',message_thread_id:-1}),
  msg(14,{new_chat_members:[{id:400,is_bot:true}]}),
  {update_id:'15',message:{chat,from:sender,text:'نص'}}
 ])assert.equal(parsePhase4TelegramEvents(payload,1234).length,0);
});