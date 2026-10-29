import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceFloodWindow,isValidFloodPolicy,isValidFloodWindow,type FloodEvent} from '../src/protection-flood.js';
const cfg={enabled:true,limit:3,windowMs:3000,action:'REVIEW' as const};
const key=(n:number)=>'b3-webhook:flood-test:'+n;
test('flood threshold is configured and exceeded only after the selected number of messages',()=>{
 let events:FloodEvent[]=[];
 for(let i=1;i<=4;i++){
  const result=advanceFloodWindow(cfg,events,key(i),1000+i);
  assert.equal(result.status,i===4?'EXCEEDED':'CLEAR');events=result.events;
 }
 assert.equal(advanceFloodWindow(cfg,events,key(5),5000).status,'CLEAR');
 assert.equal(advanceFloodWindow({...cfg,enabled:false},events,key(6),5001).status,'DISABLED');
});
test('flood window excludes the exact lower time boundary and deduplicates update keys',()=>{
 const events=[{key:key(1),at:1000},{key:key(2),at:1001},{key:key(3),at:1002}];
 assert.equal(advanceFloodWindow(cfg,events,key(4),4000).status,'CLEAR');
 const duplicate=advanceFloodWindow(cfg,events,key(2),1100);
 assert.equal(duplicate.status,'DUPLICATE');assert.deepEqual(duplicate.events,events);
 assert.deepEqual(events,[{key:key(1),at:1000},{key:key(2),at:1001},{key:key(3),at:1002}]);
});
test('flood history is bounded and clock rollback or ambiguous restored timestamps fail closed',()=>{
 let events:FloodEvent[]=[];
 for(let i=0;i<200;i++)events=advanceFloodWindow(cfg,events,key(i),1000+i).events;
 assert.equal(events.length,4);assert.equal(advanceFloodWindow(cfg,events,key(201),1200).status,'EXCEEDED');
 for(const invalid of [[{key:key(1),at:2000}], [{key:key(1),at:900},{key:key(1),at:901}],
  [{key:key(1),at:902},{key:key(2),at:901}]])assert.equal(advanceFloodWindow(cfg,invalid,key(3),1000).status,'INVALID');
});
test('flood configuration and durable window validators reject invalid bounds, identities and extra fields',()=>{
 assert.ok(isValidFloodPolicy(cfg));
 for(const invalid of [{...cfg,limit:0},{...cfg,limit:101},{...cfg,windowMs:999},{...cfg,windowMs:60001},
  {...cfg,enabled:'yes'},{...cfg,action:'BAN'},{...cfg,regex:'.*'}])assert.equal(isValidFloodPolicy(invalid),false);
 const record={chatId:'-100',memberId:'300',chatPolicyVersion:1,policyRevision:1,events:[{key:key(1),at:1000}],updatedAt:1000};
 assert.ok(isValidFloodWindow(record));
 for(const invalid of [{...record,chatId:'100'},{...record,memberId:'-300'},{...record,events:[]},
  {...record,updatedAt:999},{...record,rawText:'secret'},{...record,events:[{key:key(1),at:1000,text:'secret'}]}])assert.equal(isValidFloodWindow(invalid),false);
});
