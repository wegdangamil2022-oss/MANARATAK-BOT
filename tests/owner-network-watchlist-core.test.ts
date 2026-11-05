import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {validNetworkWatchCase,validNetworkWatchCases,type NetworkWatchCase} from '../src/network-watchlist-model.js';
import {prepareNetworkWatchCase,reviewNetworkWatchCase,networkWatchCaseAccessible} from '../src/network-watchlist.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',SOURCE='-100123',OTHER='-100124',USER='432156';
const pending:NetworkWatchCase={
 id:'111111111111',networkId:NET,networkRevision:1,sourceChatId:SOURCE,sourceChatVersion:1,
 subjectId:USER,category:'SPAM',revision:1,status:'PENDING',submittedBy:OWNER,submittedAt:NOW
};
const copy=(patch:Record<string,unknown>={})=>({...pending,...patch});
test('NETWORK-003 strict watch-case schema permits only reviewed lifecycle states',()=>{
 assert.equal(validNetworkWatchCase(pending),true);
 const reviewed=copy({status:'WATCHED',revision:2,reviewedBy:OWNER,reviewedAt:NOW+1});
 assert.equal(validNetworkWatchCase(reviewed),true);
 assert.equal(validNetworkWatchCase(copy({...reviewed,status:'DISMISSED'})),true);
 assert.equal(validNetworkWatchCase(copy({...reviewed,status:'CLEARED',revision:3,
  clearedBy:OWNER,clearedAt:NOW+2})),true);
 for(const patch of [
  {status:'WATCHED'},{status:'CLEARED'},{status:'DISMISSED'},
  {subjectId:'-100'},{subjectId:'001'},{sourceChatId:'100123'},{category:'CRIMINAL'},
  {networkId:'ABCDEF123456'},{revision:0},{revision:2},{networkRevision:1.5},
  {status:'PENDING',reviewedBy:OWNER},{status:'WATCHED',revision:2,reviewedBy:OWNER,reviewedAt:NOW-1},
  {status:'WATCHED',revision:2,reviewedBy:OWNER,reviewedAt:NOW+1,clearedBy:OWNER},
  {status:'CLEARED',revision:3,reviewedBy:OWNER,reviewedAt:NOW+2,
   clearedBy:OWNER,clearedAt:NOW+1},{privateNote:'danger'},{reviewedBy:undefined}
 ])assert.equal(validNetworkWatchCase(copy(patch)),false,JSON.stringify(patch));
});
test('NETWORK-003 restored watch list rejects active collisions and forged fields',()=>{
 assert.equal(validNetworkWatchCases([pending]),true);
 assert.equal(validNetworkWatchCases([pending,copy()]),false);
 assert.equal(validNetworkWatchCases([pending,copy({id:'222222222222'})]),false);
 assert.equal(validNetworkWatchCases([pending,copy({id:'222222222222',subjectId:'456789'})]),true);
 const dismissed=copy({status:'DISMISSED',revision:2,reviewedBy:OWNER,reviewedAt:NOW+1});
 assert.equal(validNetworkWatchCases([dismissed,copy({id:'222222222222'})]),true);
 assert.equal(validNetworkWatchCases(Array.from({length:401},(_,i)=>copy({
  id:i.toString(16).padStart(12,'0'),subjectId:String(i+10000)
 }))),false);
 for(const x of [undefined,null,{},'[]',42])assert.equal(validNetworkWatchCases(x),false);
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'watch-network-'));let now=NOW;
 const store=new BotStore(join(dir,'bot.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 for(const id of [SOURCE,OTHER])await policy.approveChat(OWNER,id,['navigation','moderation']);
 await store.transaction(s=>{s.groupNetworks=[{id:NET,name:'شبكة آمنة',revision:1,
  createdBy:OWNER,updatedAt:now,members:s.chats.filter(c=>[SOURCE,OTHER].includes(c.id))
   .map(c=>({chatId:c.id,version:c.version}))}];});
 return {store,policy,advance:(n:number)=>now+=n,
  submit:async(subject=USER,category='SPAM' as const)=>store.transaction(s=>{
   const row=prepareNetworkWatchCase(s,policy,OWNER,now,NET,SOURCE,subject,category);
   if(row){s.networkWatchCases??=[];s.networkWatchCases.push(row);}return row;
  }),review:async(id:string,version:number,decision:'WATCHED'|'DISMISSED'|'CLEARED')=>
   store.transaction(s=>reviewNetworkWatchCase(s,policy,OWNER,now,id,version,decision)),
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('NETWORK-003 owner submits local-only pending advisory; no Telegram sanction ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const row=await f.submit();assert.ok(row);
   assert.equal(row.status,'PENDING');
   const s=await f.store.snapshot();
   assert.equal(s.networkWatchCases?.length,1);
   assert.equal(s.moderationOperations.length,0);assert.equal(s.operations.length,0);
   assert.equal(!!networkWatchCaseAccessible(s,f.policy,OWNER,NOW,row.id),true);
   assert.equal(networkWatchCaseAccessible(s,f.policy,'200',NOW,row.id),null);
   assert.equal(await f.submit(),null);
  }finally{await f.close();}
 });
 test('NETWORK-003 human approval and clearing are separate one-way version-fenced acts ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const row=(await f.submit())!;
   assert.equal(await f.review(row.id,2,'WATCHED'),false);
   assert.equal(await f.review(row.id,1,'CLEARED'),false);
   f.advance(1000);assert.equal(await f.review(row.id,1,'WATCHED'),true);
   assert.equal(await f.review(row.id,1,'WATCHED'),false);
   let s=await f.store.snapshot();
   assert.equal(s.networkWatchCases?.[0]?.status,'WATCHED');
   assert.equal(s.moderationOperations.length,0);
   assert.equal(await f.review(row.id,2,'DISMISSED'),false);
   f.advance(1000);assert.equal(await f.review(row.id,2,'CLEARED'),true);
   assert.equal(await f.review(row.id,2,'CLEARED'),false);
   s=await f.store.snapshot();assert.equal(s.networkWatchCases?.[0]?.status,'CLEARED');
   assert.equal(s.networkWatchCases?.[0]?.revision,3);
   assert.ok(await f.submit());
  }finally{await f.close();}
 });
 test('NETWORK-003 declined case remains history and new allegation needs new review ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const row=(await f.submit())!;f.advance(100);
   assert.equal(await f.review(row.id,1,'DISMISSED'),true);
   assert.equal(await f.review(row.id,2,'CLEARED'),false);
   assert.ok(await f.submit());
   const s=await f.store.snapshot();assert.equal(s.networkWatchCases?.length,2);
   assert.equal(s.networkWatchCases?.[0]?.status,'DISMISSED');
   assert.equal(s.networkWatchCases?.[1]?.status,'PENDING');
  }finally{await f.close();}
 });
 test('NETWORK-003 changed network revision and disabled owner feature freeze all reviews ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const row=(await f.submit())!;
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal(await f.review(row.id,1,'WATCHED'),false);
   // A newly submitted report is allowed against the *current* network epoch.
   // Only previously approved/reviewed stale evidence must remain frozen.
   const fresh=await f.submit('9001');
   assert.ok(fresh);
   assert.equal(fresh.networkRevision,2);
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision=1;
    s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.review(row.id,1,'WATCHED'),false);
   assert.equal(await f.submit('9001'),null);
   assert.equal((await f.store.snapshot()).networkWatchCases?.[0]?.status,'PENDING');
  }finally{await f.close();}
 });
 test('NETWORK-003 restore path rejects a forged reviewed case ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.submit();
   await assert.rejects(()=>f.store.transaction(s=>{s.networkWatchCases![0]!.status='WATCHED';}),
    /schema|invalid|Unsupported/i);
  }finally{await f.close();}
 });
}
