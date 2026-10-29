import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

for(const engine of ['json','sqlite'] as const){
 test('unauthorized warning requests reveal no member warning count ('+engine+')',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'warning-privacy-'));
  try{
   const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
   const policy=new Policy(store,'100',()=>1000);
   await policy.approveChat('100','-10',['moderation']);
   const service=new ModerationService(store,policy,new FakeModerationGateway(),()=>1000);
   assert.equal((await service.issueWarning('100','-10','300','case')).status,'ADDED');
   assert.deepEqual(await service.issueWarning('200','-10','300','other'),{status:'DENIED',count:null});
   assert.deepEqual(await service.removeWarning('200','-10','300','case'),{status:'DENIED',count:null});
   assert.equal((await store.snapshot()).warnings[0]?.active,true);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
