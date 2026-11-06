import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {networkAdministrativeEvents} from '../src/network-administrative-events.js';

const OWNER='100', NOW=1_700_000_000_000, N='abcdef123456', OTHER='bbbbbb123456';
const A='-100124', B='-100125', X='-100199';
for(const engine of ['json','sqlite'] as const){
 test(engine+' NETWORK-006 read-only network event feed isolates other networks and excludes private subjects',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nw6-'));
  try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   for(const id of [A,B,X])await policy.approveChat(OWNER,id,['moderation']);
   await store.transaction(s=>{
    s.groupNetworks=[
     {id:N,name:'Network',revision:1,createdBy:OWNER,updatedAt:NOW-100,members:[{chatId:A,version:1},{chatId:B,version:1}]},
     {id:OTHER,name:'Other',revision:1,createdBy:OWNER,updatedAt:NOW-100,members:[{chatId:X,version:1}]}];
    s.networkEmergencyControls=[{networkId:N,revision:1,status:'STOPPED',changedAt:NOW-10,changedBy:OWNER}];
    s.networkWatchCases=[
     {id:'111111111111',networkId:N,networkRevision:1,sourceChatId:A,sourceChatVersion:1,subjectId:'998877',category:'SPAM',revision:1,status:'PENDING',submittedBy:OWNER,submittedAt:NOW-30},
     {id:'222222222222',networkId:OTHER,networkRevision:1,sourceChatId:X,sourceChatVersion:1,subjectId:'445566',category:'OTHER',revision:1,status:'PENDING',submittedBy:OWNER,submittedAt:NOW-20}
    ];
   });
   const before=await store.snapshot();
   const events=networkAdministrativeEvents(before,policy,OWNER,NOW,N);
   assert.ok(events);assert.equal(events.length,2);
   assert.ok(events.some(e=>e.kind==='WATCH_CASE'));
   assert.ok(events.some(e=>e.kind==='EMERGENCY'));
   assert.equal(networkAdministrativeEvents(before,policy,'200',NOW,N),null);
   const editor=new OwnerNetworkEditor(store,policy,()=>NOW);
   const card=await editor.handle(OWNER,'nw:1:d:'+N);
   const callback=card?.keyboard.inline_keyboard.flat().find(b=>b.text.includes('الأحداث الإدارية'))?.callback_data;
   assert.ok(callback);assert.ok(validOwnerNetworkRoute(callback));
   const screen=await editor.handle(OWNER,callback);
   assert.match(screen?.text??'',/إيقاف طارئ|طوارئ/u);
   assert.doesNotMatch(screen?.text??'',/998877|445566|222222222222/u);
   assert.deepEqual(await store.snapshot(),before);
   await store.transaction(s=>{s.chats.find(c=>c.id===A)!.approved=false;});
   const filtered=networkAdministrativeEvents(await store.snapshot(),policy,OWNER,NOW,N);
   assert.equal(filtered?.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
