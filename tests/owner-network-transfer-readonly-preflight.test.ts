import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {NetworkTransferReadOnlyPreflight,inspectNetworkTransferLocal} from '../src/network-transfer-preflight.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',SOURCE='-100123',
 TARGET='-100124',SUBJECT='45678',REVIEW='333333333333';
const token='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'network-transfer-preflight-'));let now=NOW;
 const store=new BotStore(join(dir,'s.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,SOURCE,['moderation','navigation']);
 await policy.approveChat(OWNER,TARGET,['moderation','navigation']);
 await store.transaction(s=>{
  s.groupNetworks=[{id:NET,name:'شبكة السلامة',revision:1,
   createdBy:OWNER,updatedAt:now,
   members:s.chats.map(c=>({chatId:c.id,version:c.version}))}];
  s.networkWatchCases=[{id:'222222222222',networkId:NET,networkRevision:1,
   sourceChatId:SOURCE,sourceChatVersion:1,subjectId:SUBJECT,
   category:'SPAM',revision:2,status:'WATCHED',submittedBy:OWNER,
   submittedAt:now-200,reviewedBy:OWNER,reviewedAt:now-150}];
  s.networkSanctionReviews=[{id:REVIEW,caseId:'222222222222',caseRevision:2,
   networkId:NET,networkRevision:1,sourceChatId:SOURCE,sourceChatVersion:1,
   targetChatId:TARGET,targetChatVersion:1,subjectId:SUBJECT,kind:'BAN',
   status:'REVIEWED_ONLY',revision:2,requestedBy:OWNER,requestedAt:now-100,
   reviewedBy:OWNER,reviewedAt:now-50}];
 });
 return {store,policy,now:()=>now,advance:(n:number)=>{now+=n;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
type Method='getChat'|'getChatMember';
function gateway(options:{botRight?:boolean;memberStatus?:string;chatType?:string;
 throwOn?:Method;onCall?:(method:Method,index:number)=>Promise<void>|void}={}){
 const calls:string[]=[];let sequence=0;
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const name=String(url).split('/').at(-1)!;
  calls.push(name);
  assert.ok(name==='getChatMember'||name==='getChat','Readonly attempted '+name);
  const method=name as Method;
  sequence++;
  await options.onCall?.(method,sequence);
  if(options.throwOn===method)throw Error('network error');
  const body=JSON.parse(String(init?.body)) as {chat_id:string;user_id?:number};
  assert.equal(body.chat_id,TARGET);
  const result=method==='getChat'?
   {id:Number(TARGET),type:options.chatType??'supergroup'}:
   body.user_id===BOT?
    {status:'administrator',user:{id:BOT,is_bot:true},
     can_restrict_members:options.botRight??true}:
    {status:options.memberStatus??'member',user:{id:Number(SUBJECT),is_bot:false}};
  return new Response(JSON.stringify({ok:true,result}),{status:200,
   headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 return {gw:new TelegramBotApiModerationGateway(token,request),calls};
}
for(const engine of ['json','sqlite'] as const){
 test('NETWORK-003 read-only per-target preflight probes authentic bot + ordinary target without mutation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const {gw,calls}=gateway();
   const report=await new NetworkTransferReadOnlyPreflight(f.store,f.policy,gw,f.now)
    .assess(OWNER,REVIEW);
   assert.deepEqual(report,{status:'OBSERVED_ONLY',reason:'ORDINARY_MEMBER_OBSERVED'});
   assert.deepEqual(calls,['getChat','getChatMember','getChatMember',
    'getChatMember','getChat','getChatMember','getChatMember','getChatMember']);
   const s=await f.store.snapshot();
   assert.equal(s.networkSanctionReviews![0]!.status,'REVIEWED_ONLY');
   assert.equal(s.moderationOperations.length,0);
   assert.equal(s.moderationReasons.length,0);
   assert.equal(s.operations.length,0);
  }finally{await f.close();}
 });
 test('NETWORK-003 does not inspect or arm a PENDING target review ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{const p=s.networkSanctionReviews![0]!;
    p.status='PENDING';p.revision=1;delete p.reviewedAt;delete p.reviewedBy;});
   const {gw,calls}=gateway();
   assert.deepEqual(await new NetworkTransferReadOnlyPreflight(f.store,f.policy,gw,f.now)
    .assess(OWNER,REVIEW),{status:'BLOCKED',reason:'REVIEW_NOT_CURRENT'});
   assert.deepEqual(calls,[]);
  }finally{await f.close();}
 });
 test('NETWORK-003 no remote read for owner target, group staff, unknown sanction or stale chat ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const {gw,calls}=gateway();
   await f.store.transaction(s=>{s.networkSanctionReviews![0]!.subjectId='100';
    s.networkWatchCases![0]!.subjectId='100';});
   assert.deepEqual(inspectNetworkTransferLocal(await f.store.snapshot(),f.policy,OWNER,
    NOW,REVIEW),{status:'BLOCKED',reason:'PROTECTED_LOCAL'});
   assert.equal((await new NetworkTransferReadOnlyPreflight(f.store,f.policy,gw,f.now)
    .assess(OWNER,REVIEW)).status,'BLOCKED');
   assert.deepEqual(calls,[]);
   await f.store.transaction(s=>{s.networkSanctionReviews![0]!.subjectId=SUBJECT;
    s.networkWatchCases![0]!.subjectId=SUBJECT;
    s.groupNetworks![0]!.revision++;});
   assert.deepEqual(inspectNetworkTransferLocal(await f.store.snapshot(),f.policy,OWNER,
    NOW,REVIEW),{status:'BLOCKED',reason:'REVIEW_NOT_CURRENT'});
  }finally{await f.close();}
 });
 test('NETWORK-003 rejects a fake or overwritten probe before any remote access ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const fake={inspectTrialGroupKind:async()=> 'SUPERGROUP',
    observeRestriction:async()=> 'NO_RESTRICTION'};
   assert.deepEqual(await new NetworkTransferReadOnlyPreflight(f.store,f.policy,
    fake as never,f.now).assess(OWNER,REVIEW),
    {status:'BLOCKED',reason:'UNTRUSTED_OBSERVER'});
   const {gw,calls}=gateway();
   (gw as unknown as {observeRestriction:unknown}).observeRestriction=async()=> 'NO_RESTRICTION';
   assert.deepEqual(await new NetworkTransferReadOnlyPreflight(f.store,f.policy,gw,f.now)
    .assess(OWNER,REVIEW),{status:'BLOCKED',reason:'UNTRUSTED_OBSERVER'});
   assert.deepEqual(calls,[]);
  }finally{await f.close();}
 });
 test('NETWORK-003 denied bot rights, restricted target and channel are never observed as eligible ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(const options of [{botRight:false},{memberStatus:'administrator'},
    {memberStatus:'restricted'},{memberStatus:'kicked'},{chatType:'channel'},
    {throwOn:'getChat' as const}]){
    const {gw,calls}=gateway(options);
    const result=await new NetworkTransferReadOnlyPreflight(f.store,f.policy,gw,f.now)
     .assess(OWNER,REVIEW);
    assert.equal(result.status,'BLOCKED',JSON.stringify(options));
    assert.ok(calls.length>0);
    assert.equal(calls.some(name=>name.startsWith('ban')||name.startsWith('restrict')),false);
   }
  }finally{await f.close();}
 });
 test('NETWORK-003 target revocation during awaited getChatMember makes stale not eligible ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   let mutated=false;
   const {gw,calls}=gateway({onCall:async(method,index)=>{
    if(method==='getChatMember'&&index===3&&!mutated){
     mutated=true;
     await f.policy.approveChat(OWNER,TARGET,['navigation','moderation']);
    }
   }});
   const result=await new NetworkTransferReadOnlyPreflight(f.store,f.policy,gw,f.now)
    .assess(OWNER,REVIEW);
   assert.deepEqual(result,{status:'BLOCKED',reason:'LOCAL_CHANGED'});
   assert.equal(mutated,true);
   assert.equal(calls.some(x=>x.startsWith('ban')||x.startsWith('restrict')),false);
  }finally{await f.close();}
 });
 test('NETWORK-003 pending/unknown local operation is not remotely observed ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    s.moderationOperations.push({id:'op-'+engine,chatId:TARGET,memberId:SUBJECT,
     actorId:OWNER,kind:'BAN',reasonFingerprint:'x',policyVersion:1,
     status:'UNKNOWN_OUTCOME',createdAt:NOW-100});
   });
   const {gw,calls}=gateway();
   const result=await new NetworkTransferReadOnlyPreflight(f.store,f.policy,gw,f.now)
    .assess(OWNER,REVIEW);
   assert.deepEqual(result,{status:'BLOCKED',reason:'UNRESOLVED_LOCAL'});
   assert.deepEqual(calls,[]);
  }finally{await f.close();}
 });
}
