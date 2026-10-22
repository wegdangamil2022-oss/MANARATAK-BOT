import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseB6ExplicitMention as parse} from '../src/b6-telegram-mention.js';

const bot='ManaratakBot';
const ask='@ManaratakBot ما شروط المنحة؟';
const target={type:'mention',offset:0,length:13};

test('B6 S12-01 parser only accepts the real prefix entity and extracts a question',()=>{
 assert.deepEqual(parse(ask,[target],bot),{status:'MATCH',question:'ما شروط المنحة؟'});
 assert.deepEqual(parse('@MANARATAKBOT   ما شروط المنحة؟',[target],bot),
  {status:'MATCH',question:'ما شروط المنحة؟'});
});
test('B6 S12-01 parser rejects plain text, text_mention, other bot and quote offsets',()=>{
 assert.deepEqual(parse(ask,undefined,bot),{status:'NO_MATCH'});
 assert.deepEqual(parse(ask,[],bot),{status:'NO_MATCH'});
 assert.deepEqual(parse(ask,[{...target,type:'text_mention',user:{id:1}}],bot),{status:'NO_MATCH'});
 assert.deepEqual(parse('@OtherBot سؤال',[{type:'mention',offset:0,length:9}],bot),{status:'NO_MATCH'});
 const quote='quote @ManaratakBot ما شروط المنحة؟';
 assert.deepEqual(parse(quote,[{...target,offset:6}],bot),{status:'NO_MATCH'});
});
test('B6 S12-01 parser validates both UTF-16 entity boundaries and array shape',()=>{
 const prefix='😀 @ManaratakBot '+ 'ما شروط المنحة؟';
 assert.deepEqual(parse(prefix,[{...target,offset:3}],bot),{status:'NO_MATCH'});
 for(const entries of [
  null,{},'mention',[null],[{...target,offset:1}], [{...target,length:12}],
  [{...target,length:500}], [{...target,offset:0.5}], [{...target,length:0}],
  [{...target},{...target}]
 ]){
  assert.deepEqual(parse(ask,entries,bot),{status:'INVALID'});
 }
});
test('B6 S12-01 parser does not accept an empty, giant or glued question',()=>{
 for(const text of ['@ManaratakBot','@ManaratakBot'+ 'x',
  '@ManaratakBot '+ 'a'.repeat(241)]){
  assert.deepEqual(parse(text,[target],bot),{status:'INVALID'});
 }
});
test('B6 S12-01 parser counts other Telegram entities in UTF-16 code units',()=>{
 const text='@ManaratakBot '+ '😀 ما شروط المنحة؟';
 const otherOffset=text.indexOf('😀');
 assert.deepEqual(parse(text,[target,{type:'custom_emoji',offset:otherOffset,length:2,
  custom_emoji_id:'any'}],bot),{status:'MATCH',question:'😀 ما شروط المنحة؟'});
 assert.deepEqual(parse(text,[target,{type:'custom_emoji',offset:otherOffset+1,length:1}],
  bot),{status:'INVALID'});
});
