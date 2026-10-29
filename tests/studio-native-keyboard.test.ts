import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validStudioNativeKeyboard,type StudioNativeKeyboard} from '../src/telegram-studio-rich.js';
import {TelegramBotApiTextSender} from '../src/telegram-replies.js';
const keyboard:StudioNativeKeyboard={inline_keyboard:[[{text:'القناة',url:'https://t.me/ManaratakEduBot',style:'primary'}],[{text:'نسخ',copy_text:{text:'سطر\nثانٍ'},style:'success'},{text:'مشاركة',switch_inline_query:'منارتك'}],[{text:'رجوع',callback_data:'st:1:l:09:0'}]]};
test('studio native keyboard serializes one Bot API action per button and preserves styles',async()=>{
 let calls=0;
 const request:typeof fetch=async(url,options)=>{calls++;assert.ok(String(url).endsWith('/editMessageText'));const body=JSON.parse(String(options?.body));assert.deepEqual(body.reply_markup,keyboard);assert.equal(body.message_id,55);return new Response(JSON.stringify({ok:true,result:{message_id:55,chat:{id:100}}}),{status:200});};
 const sender=new TelegramBotApiTextSender('12345:'+'A'.repeat(30),request);
 assert.equal(validStudioNativeKeyboard(keyboard),true);
 assert.equal((await sender.send({chatId:'100',parseMode:'HTML',text:'معاينة',studioMarkup:keyboard,editMessageId:55})).status,'CONFIRMED');assert.equal(calls,1);
 for(const k of [{inline_keyboard:[[{text:'مزور',url:'https://t.me/',callback_data:'st:1:n'}]]},{inline_keyboard:[[{text:'داخلي',url:'https://127.0.0.1/'}]]},{inline_keyboard:[[{text:'كود',callback_data:'eval:1:process'}]]},{inline_keyboard:[[{text:'نمط',copy_text:{text:'نص'},style:'#ffffff'}]]}])assert.equal(validStudioNativeKeyboard(k),false);
 const bad=await sender.send({chatId:'-100123',parseMode:'HTML',text:'غير مخول',studioMarkup:keyboard});assert.equal(bad.status,'FAILED_CONFIRMED');assert.equal(calls,1);
 const conflict=await sender.send({chatId:'100',parseMode:'HTML',text:'تعارض',studioMarkup:keyboard,inlineMarkup:{inline_keyboard:[[{text:'آخر',callback_data:'mi:1:h'}]]}});assert.equal(conflict.status,'FAILED_CONFIRMED');assert.equal(calls,1);
});
