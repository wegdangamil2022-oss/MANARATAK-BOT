import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createQuizRound,recordQuizAnswer,closeQuizRound,quizPublicView,parseQuizAnswerCallback} from '../src/phase4-quiz-core.js';

const round=()=>createQuizRound({id:'r_1',chatId:'-1001234567890',prompt:'ما عاصمة اليمن؟',
 options:['صنعاء','عدن','تعز'],correctOption:0,opensAt:1_000,closesAt:61_000});

test('phase 4: only scoped group rounds with validated question and timing can be created',()=>{
 const r=round();assert.equal(r.status,'OPEN');assert.equal(r.answers.length,0);
 assert.throws(()=>createQuizRound({id:'invalid!',chatId:'-1001234567890',prompt:'سؤال',options:['أ','ب'],correctOption:0,opensAt:1,closesAt:2}),/INVALID_QUIZ_ID/);
 assert.throws(()=>createQuizRound({id:'a',chatId:'100',prompt:'سؤال',options:['أ','ب'],correctOption:0,opensAt:1,closesAt:2}),/INVALID_QUIZ_CHAT/);
 assert.throws(()=>createQuizRound({id:'a',chatId:'-100',prompt:'?',options:['نعم','نعم'],correctOption:0,opensAt:1,closesAt:2}),/INVALID_QUIZ_OPTIONS/);
 assert.throws(()=>createQuizRound({id:'a',chatId:'-100',prompt:'?',options:['أ','ب'],correctOption:2,opensAt:1,closesAt:2}),/INVALID_QUIZ_ANSWER/);
 assert.throws(()=>createQuizRound({id:'a',chatId:'-100',prompt:'?',options:['أ','ب'],correctOption:0,opensAt:2,closesAt:2}),/INVALID_QUIZ_TIME/);
});

test('phase 4: public question never exposes the answer or explanation and escapes HTML',()=>{
 const r=createQuizRound({id:'round_2',chatId:'-100',prompt:'منحة <b> & تفاصيل',
  options:['آمن <1>','آمن &2'],correctOption:1,explanation:'الإجابة الصحيحة هي الثانية',opensAt:0,closesAt:1000});
 const screen=quizPublicView(r);
 assert.match(screen.text,/&lt;b&gt; &amp;/);
 assert.equal(screen.text.includes('الإجابة الصحيحة'),false);
 assert.equal(screen.text.includes('correctOption'),false);
 assert.deepEqual(screen.buttons.map(b=>b.callbackData),['p4q:1:round_2:0','p4q:1:round_2:1']);
 assert.equal(screen.buttons[0]?.label,'1. آمن <1>');
});

test('phase 4: accepts one vote per Telegram identity, never overwrites or mutates previous round',()=>{
 const before=round();
 const a=recordQuizAnswer(before,'100',1,1_010);
 assert.equal(a.status,'RECORDED');assert.equal(a.round.answers.length,1);
 assert.equal(before.answers.length,0);
 const retry=recordQuizAnswer(a.round,'100',0,2_000);
 assert.equal(retry.status,'DUPLICATE');assert.deepEqual(retry.round,a.round);
 const second=recordQuizAnswer(retry.round,'200',0,2_100);
 assert.equal(second.status,'RECORDED');
 const results=closeQuizRound(second.round,61_000);
 assert.equal(results.status,'CLOSED');
 assert.deepEqual(results.summary,{total:2,correct:1,incorrect:1,correctOption:0});
 assert.equal(results.round.status,'CLOSED');
 const again=closeQuizRound(results.round,62_000);
 assert.deepEqual(again.summary,results.summary);
});

test('phase 4: rejects early, late, invalid and forged votes without state changes',()=>{
 const base=round();
 for(const [id,index,at,status] of [
  ['100',0,999,'NOT_OPEN'],['100',0,61_000,'CLOSED'],
  ['invalid',0,1_100,'DENIED'],['100',99,1_100,'DENIED'],
  ['100',0,Number.NaN,'DENIED']
 ] as const){
  const result=recordQuizAnswer(base,id,index,at);
  assert.equal(result.status,status);
  assert.deepEqual(result.round,base);
 }
 assert.equal(closeQuizRound(base,60_999).status,'NOT_READY');
});

test('phase 4: strictly parses callback labels but never treats one as authorization',()=>{
 assert.deepEqual(parseQuizAnswerCallback('p4q:1:r_1:2'),{roundId:'r_1',optionIndex:2});
 for(const input of ['p4q:1:r_1:02','p4q:1:r_1:-1','p4q:1:bad!:0',
  'p4q:1:r_1:6','p4q:1:r_1:0 extra','p4q:1:r_1:0\n','p4q:2:r_1:0'])
  assert.equal(parseQuizAnswerCallback(input),null,input);
});
