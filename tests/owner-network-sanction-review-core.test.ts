import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {validNetworkSanctionReview,validNetworkSanctionReviews,
 validNetworkSanctionReviewReferences,type NetworkSanctionReview} from '../src/network-sanction-review-model.js';
import {prepareNetworkSanctionReview,decideNetworkSanctionReview,
 networkSanctionReviewAccessible} from '../src/network-sanction-review.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',
 SOURCE='-100123',TARGET='-100124',OTHER='-100125',SUBJECT='321654';
const example:NetworkSanctionReview={
 id:'111111111111',caseId:'222222222222',caseRevision:2,
 networkId:NET,networkRevision:1,sourceChatId:SOURCE,sourceChatVersion:1,
 targetChatId:TARGET,targetChatVersion:1,subjectId:SUBJECT,
 kind:'MUTE',revision:1,status:'PENDING',requestedBy:OWNER,requestedAt:NOW
};
const copy=(patch:Record<string,unknown>={})=>({...example,...patch});
test('NETWORK-003 reviewed transfer model has strict schema, transitions and closed status',()=>{
 assert.equal(validNetworkSanctionReview(example),true);
 const reviewed=copy({status:'REVIEWED_ONLY',revision:2,reviewedBy:OWNER,reviewedAt:NOW+1});
 assert.equal(validNetworkSanctionReview(reviewed),true);
 assert.equal(validNetworkSanctionReview(copy({...reviewed,status:'REJECTED'})),true);
 assert.equal(validNetworkSanctionReview(copy({...reviewed,status:'CLOSED',revision:3,
  closedBy:OWNER,closedAt:NOW+2})),true);
 for(const patch of [
  {id:'ABCDEF123456'},{targetChatId:'100124'},{targetChatId:SOURCE},
  {subjectId:'-100'},{caseRevision:3},{sourceChatVersion:0},
  {kind:'WARN'},{status:'APPROVED'},{status:'REVIEWED_ONLY'},
  {status:'PENDING',reviewedAt:NOW},{status:'REVIEWED_ONLY',revision:2,
   reviewedAt:NOW+1},{status:'REVIEWED_ONLY',revision:2,reviewedBy:OWNER,reviewedAt:NOW-1},
  {status:'REVIEWED_ONLY',revision:2,reviewedBy:OWNER,reviewedAt:NOW+1,
   closedAt:NOW+2},{notes:'unsafe'},{reviewedBy:undefined},{revision:1.5}
 ])assert.equal(validNetworkSanctionReview(copy(patch)),false,JSON.stringify(patch));
});
test('NETWORK-003 restored reviews reject duplicate active case-target and forged references',()=>{
 assert.equal(validNetworkSanctionReviews([example]),true);
 assert.equal(validNetworkSanctionReviews([example,copy()]),false);
 assert.equal(validNetworkSanctionReviews([example,copy({id:'333333333333'})]),false);
 const reviewed=copy({status:'REVIEWED_ONLY',revision:2,reviewedBy:OWNER,reviewedAt:NOW+1});
 assert.equal(validNetworkSanctionReviews([reviewed,copy({id:'333333333333'})]),false);
 assert.equal(validNetworkSanctionReviews([example,copy({id:'333333333333',targetChatId:OTHER})]),true);
 const rejected=copy({status:'REJECTED',revision:2,reviewedBy:OWNER,reviewedAt:NOW+1});
 assert.equal(validNetworkSanctionReviews([rejected,copy({id:'333333333333'})]),true);
 assert.equal(validNetworkSanctionReviews(Array.from({length:501},(_,i)=>copy({
  id:i.toString(16).padStart(12,'0'),targetChatId:'-'+String(100000+i)
 }))),false);
 for(const value of [null,undefined,{},42,'[]'])assert.equal(validNetworkSanctionReviews(value),false);
});
test('NETWORK-003 restored human review cannot be later than withdrawn source evidence',()=>{
 const withdrawn={
  id:example.caseId,networkId:NET,networkRevision:1,sourceChatId:SOURCE,
  sourceChatVersion:1,subjectId:SUBJECT,category:'SPAM' as const,
  revision:3,status:'CLEARED' as const,submittedBy:OWNER,submittedAt:NOW-100,
  reviewedBy:OWNER,reviewedAt:NOW-50,clearedBy:OWNER,clearedAt:NOW+50
 };
 const forged=copy({status:'REVIEWED_ONLY',revision:2,reviewedBy:OWNER,reviewedAt:NOW+60});
 assert.equal(validNetworkSanctionReview(forged),true);
 assert.equal(validNetworkSanctionReviewReferences([forged] as NetworkSanctionReview[],
  [withdrawn]),false);
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'network-sanction-review-'));let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 for(const chatId of [SOURCE,TARGET,OTHER])await policy.approveChat(OWNER,chatId,['navigation','moderation']);
 await store.transaction(s=>{
  s.groupNetworks=[{id:NET,name:'شبكة آمنة',revision:1,createdBy:OWNER,
   updatedAt:now,members:s.chats.map(c=>({chatId:c.id,version:c.version}))}];
  s.networkWatchCases=[{id:'222222222222',networkId:NET,networkRevision:1,
   sourceChatId:SOURCE,sourceChatVersion:1,subjectId:SUBJECT,category:'SPAM',
   revision:2,status:'WATCHED',submittedBy:OWNER,submittedAt:now-100,
   reviewedBy:OWNER,reviewedAt:now-50}];
 });
 return {store,policy,now:()=>now,advance:(delta:number)=>{now+=delta;},
  propose:(targetId=TARGET,kind='MUTE' as 'MUTE'|'BAN')=>
   store.transaction(s=>{const row=prepareNetworkSanctionReview(s,policy,OWNER,now,
    '222222222222',targetId,kind);
    if(row){s.networkSanctionReviews??=[];s.networkSanctionReviews.push(row);}
    return row;
   }),
  decide:(id:string,revision:number,decision:'REVIEWED_ONLY'|'REJECTED'|'CLOSED')=>
   store.transaction(s=>decideNetworkSanctionReview(s,policy,OWNER,now,id,revision,decision)),
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('NETWORK-003 transfer review is distinct per target; never creates Telegram sanctions ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const pending=await f.propose();assert.ok(pending);
   assert.equal(pending.targetChatId,TARGET);
   assert.equal(await f.propose(),null);
   assert.ok(await f.propose(OTHER,'BAN'));
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length,2);
   assert.equal(networkSanctionReviewAccessible(await f.store.snapshot(),f.policy,OWNER,
    f.now(),pending.id)?.id,pending.id);
   assert.equal(networkSanctionReviewAccessible(await f.store.snapshot(),f.policy,'200',
    f.now(),pending.id),null);
   assert.equal(await f.decide(pending.id,2,'REVIEWED_ONLY'),false);
   assert.equal(await f.decide(pending.id,1,'CLOSED'),false);
   f.advance(200);
   assert.equal(await f.decide(pending.id,1,'REVIEWED_ONLY'),true);
   assert.equal(await f.decide(pending.id,1,'REVIEWED_ONLY'),false);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.[0]?.status,'REVIEWED_ONLY');
   assert.equal((await f.store.snapshot()).moderationOperations.length,0);
   assert.equal((await f.store.snapshot()).operations.length,0);
   f.advance(200);
   assert.equal(await f.decide(pending.id,2,'CLOSED'),true);
   assert.equal(await f.decide(pending.id,2,'CLOSED'),false);
   const state=await f.store.snapshot();
   assert.equal(state.networkSanctionReviews?.[0]?.status,'CLOSED');
   assert.equal(state.networkSanctionReviews?.[0]?.revision,3);
   assert.equal(state.moderationOperations.length,0);
   assert.ok(await f.propose());
  }finally{await f.close();}
 });
 test('NETWORK-003 target membership and review epochs fail closed ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const pending=(await f.propose())!;
   await f.policy.approveChat(OWNER,TARGET,['navigation','moderation']);
   assert.equal(await f.decide(pending.id,1,'REVIEWED_ONLY'),false);
   assert.equal(await f.propose(),null);
   const s=await f.store.snapshot();
   assert.equal(s.networkSanctionReviews?.[0]?.status,'PENDING');
   assert.equal(s.moderationOperations.length,0);
  }finally{await f.close();}
 });
 test('NETWORK-003 cleared source case cannot approve pending target review ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const p=(await f.propose())!;
   await f.store.transaction(s=>{const c=s.networkWatchCases![0]!;
    c.status='CLEARED';c.revision=3;c.clearedBy=OWNER;c.clearedAt=NOW;});
   assert.equal(await f.decide(p.id,1,'REVIEWED_ONLY'),false);
   assert.equal(await f.propose(OTHER),null);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.[0]?.status,'PENDING');
  }finally{await f.close();}
 });
 test('NETWORK-003 restored transfer referencing nonmatching watch case fails closed ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.propose();
   await assert.rejects(()=>f.store.transaction(s=>{
    s.networkSanctionReviews![0]!.subjectId='1234567';
   }),/schema/i);
   await assert.rejects(()=>f.store.transaction(s=>{
    s.networkSanctionReviews![0]!.caseId='999999999999';
   }),/schema/i);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('NETWORK-003 rollback before human review cannot create future-dated transfer ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{s.groupNetworks![0]!.updatedAt=NOW-200;});
   f.advance(-75);
   assert.equal(await f.propose(),null);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length??0,0);
  }finally{await f.close();}
 });
 test('NETWORK-003 concurrent proposals share one active per-target review ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const [a,b]=await Promise.all([f.propose(),f.propose()]);
   assert.equal([a,b].filter(Boolean).length,1);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length,1);
   assert.equal((await f.store.snapshot()).moderationOperations.length,0);
  }finally{await f.close();}
 });
 test('NETWORK-003 dashboard-off cannot authorize a pending target decision ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const p=(await f.propose())!;
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.decide(p.id,1,'REVIEWED_ONLY'),false);
   assert.equal((await f.store.snapshot()).networkSanctionReviews![0]!.status,'PENDING');
  }finally{await f.close();}
 });
}
