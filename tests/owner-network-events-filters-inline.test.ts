import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {networkAdministrativeEvents} from '../src/network-administrative-events.js';
import {captureNetworkPolicySnapshot} from '../src/network-policy-snapshots.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1_700_000_000_000,N='abcdef123456',OTHER='bbbbbb123456';
const A='-100124',B='-100125',OUT='-100199';
const button=(screen:OwnerInlineScreen|null,needle:string):string=>{
 assert.ok(screen,'screen missing '+needle);
 const hit=screen.keyboard.inline_keyboard.flat().find(x=>x.text.includes(needle));
 assert.ok(hit,'button '+needle+' missing from '+screen.text);
 assert.ok(Buffer.byteLength(hit.callback_data,'utf8')<=64);
 return hit.callback_data;
};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'network-six-filter-'));
  const store=new BotStore(join(dir,'state.'+engine),{engine});
  const policy=new Policy(store,OWNER,()=>NOW);
  for(const id of [A,B,OUT])await policy.approveChat(OWNER,id,['moderation']);
  await store.transaction(s=>{
   s.groupNetworks=[
    {id:N,name:'شبكة 6',revision:1,createdBy:OWNER,updatedAt:NOW-300,
     members:[{chatId:A,version:1},{chatId:B,version:1}]},
    {id:OTHER,name:'شبكة خارجية',revision:1,createdBy:OWNER,updatedAt:NOW-300,
     members:[{chatId:OUT,version:1}]}];
   s.networkEmergencyControls=[{networkId:N,revision:1,status:'STOPPED',changedAt:NOW-10,changedBy:OWNER}];
   s.networkWatchCases=[
    {id:'111111111111',networkId:N,networkRevision:1,sourceChatId:A,
     sourceChatVersion:1,subjectId:'998877',category:'SPAM',revision:2,status:'WATCHED',
     submittedBy:OWNER,submittedAt:NOW-250,reviewedBy:OWNER,reviewedAt:NOW-200},
    {id:'222222222222',networkId:OTHER,networkRevision:1,sourceChatId:OUT,
     sourceChatVersion:1,subjectId:'445566',category:'OTHER',revision:1,status:'PENDING',
     submittedBy:OWNER,submittedAt:NOW-170}
   ];
   s.networkSanctionReviews=[{id:'333333333333',caseId:'111111111111',caseRevision:2,
    networkId:N,networkRevision:1,sourceChatId:A,sourceChatVersion:1,
    targetChatId:B,targetChatVersion:1,subjectId:'998877',kind:'MUTE',
    revision:1,status:'PENDING',requestedBy:OWNER,requestedAt:NOW-60}];
   s.protectionPolicies=[{policy:{chatId:A,revision:1,mode:'MONITOR',rules:[],
     allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},
     chatPolicyVersion:1,updatedBy:OWNER,updatedAt:NOW-250}];
   assert.ok(captureNetworkPolicySnapshot(s,policy,OWNER,NOW-90,N,A,'444444444444'));
  });
  return {store,policy,editor:new OwnerNetworkEditor(store,policy,()=>NOW),
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-006 filters type and current approved group before display limit',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot();
   const all=networkAdministrativeEvents(s,f.policy,OWNER,NOW,N);
   assert.equal(all?.length,4);
   assert.deepEqual(new Set(all!.map(x=>x.kind)),
    new Set(['EMERGENCY','WATCH_CASE','SANCTION_REVIEW','SNAPSHOT']));
   assert.deepEqual(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{kind:'WATCH_CASE'})?.map(x=>x.kind),
    ['WATCH_CASE']);
   assert.equal(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{kind:'SNAPSHOT'})?.length,1);
   assert.deepEqual(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{chatId:A})?.map(x=>x.kind),
    ['SNAPSHOT','WATCH_CASE']);
   assert.deepEqual(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{chatId:B})?.map(x=>x.kind),
    ['SANCTION_REVIEW']);
   assert.equal(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{chatId:OUT}),null);
   assert.equal(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{chatId:'-999'}),null);
   assert.equal(networkAdministrativeEvents(s,f.policy,'200',NOW,N,{kind:'WATCH_CASE'}),null);
   assert.equal(networkAdministrativeEvents(s,f.policy,OWNER,NOW,OTHER,{kind:'SNAPSHOT'})?.length,0);
   assert.deepEqual(await f.store.snapshot(),s);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 owner filters preserve type across group navigation',async()=>{
  const f=await fixture();try{
   const before=await f.store.snapshot();
   const start=await f.editor.handle(OWNER,'nw:1:ev:'+N+':0');
   assert.match(start?.text??'',/نسخة سياسة محفوظة/u);
   const onlyCases=await f.editor.handle(OWNER,button(start,'البلاغات'));
   assert.match(onlyCases?.text??'',/بلاغ تمت مراجعته/u);
   assert.doesNotMatch(onlyCases?.text??'',/إيقاف طوارئ|نسخة سياسة محفوظة|مقترح إجراء/u);
   const groupPick=await f.editor.handle(OWNER,button(onlyCases,'حسب المجموعة'));
   assert.match(groupPick?.text??'',/اختيار مجموعة/u);
   assert.doesNotMatch(groupPick?.text??'',/998877/u);
   const groupA=await f.editor.handle(OWNER,button(groupPick,A));
   assert.match(groupA?.text??'',/بلاغ تمت مراجعته/u);
   assert.match(groupA?.text??'',new RegExp(A));
   const noEmergency=await f.editor.handle(OWNER,button(groupA,'الطوارئ'));
   assert.match(noEmergency?.text??'',/لا توجد أحداث/u);
   assert.doesNotMatch(noEmergency?.text??'',/إيقاف طوارئ الشبكة/u);
   const reset=await f.editor.handle(OWNER,button(noEmergency,'كل المجموعات'));
   assert.match(reset?.text??'',/إيقاف طوارئ الشبكة/u);
   assert.equal(await f.editor.handle('200','nw:1:ef:'+N+':0:w:0'),null);
   for(const bad of ['nw:1:ef:'+N+':0:z:0','nw:1:ef:'+N+':0:w:'+OUT,
     'nw:1:eg:'+N+':z:0','nw:1:ef:'+N+':001:w:0','nw:1:ef:'+N+':0:w:INVALID'])
    assert.equal(await f.editor.handle(OWNER,bad),null,'invalid route '+bad);
   assert.deepEqual(await f.store.snapshot(),before);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 scopes every event after revoked membership and owner dashboard',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{s.chats.find(c=>c.id===A)!.approved=false;});
   const s=await f.store.snapshot();
   assert.equal(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{chatId:A}),null);
   assert.equal(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{kind:'SNAPSHOT'})?.length,0);
   assert.equal(networkAdministrativeEvents(s,f.policy,OWNER,NOW,N,{kind:'SANCTION_REVIEW'})?.length,0);
   assert.equal(await f.editor.handle(OWNER,'nw:1:ef:'+N+':0:s:'+A),null);
   await f.store.transaction(v=>{v.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.editor.handle(OWNER,'nw:1:ef:'+N+':0:a:0'),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-006 pagination of filtered results and group selector is bounded',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{
    for(let i=0;i<19;i++)s.networkWatchCases!.push({
     id:(100000000000+i).toString(),networkId:N,networkRevision:1,sourceChatId:A,
     sourceChatVersion:1,subjectId:(200000+i).toString(),category:'OTHER',
     revision:1,status:'PENDING',submittedBy:OWNER,submittedAt:NOW-100+i
    });
   });
   const first=await f.editor.handle(OWNER,'nw:1:ef:'+N+':0:w:0');
   assert.match(first?.text??'',/صفحة 1\/3/u);
   const second=await f.editor.handle(OWNER,button(first,'التالي'));
   assert.match(second?.text??'',/صفحة 2\/3/u);
   const third=await f.editor.handle(OWNER,button(second,'التالي'));
   assert.match(third?.text??'',/صفحة 3\/3/u);
   assert.equal(await f.editor.handle(OWNER,'nw:1:ef:'+N+':3:w:0'),null);
   assert.equal(validOwnerNetworkRoute('nw:1:ef:'+N+':0:w:0'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:eg:'+N+':w:0'),true);
  }finally{await f.close();}
 });
}
