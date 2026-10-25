import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationReversalPreflight,type RestrictionObserver} from '../src/moderation-reversal-preflight.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';

const OWNER='100',CHAT='-100123',TARGET='300';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-reversal-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER,()=>1700000000000);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 const version=(await store.snapshot()).chats[0]!.version;
 await store.transaction(s=>{s.moderationOperations.push({
  id:'confirmed-ban',chatId:CHAT,memberId:TARGET,actorId:OWNER,kind:'BAN',
  reasonFingerprint:'private-reason',policyVersion:version,status:'CONFIRMED',
  createdAt:1700000000000
 });});
 let calls=0;let observation:'BAN_PRESENT'|'MUTE_PRESENT'|'NO_RESTRICTION'|'PROTECTED'|'NO_RIGHTS'|'UNKNOWN'='BAN_PRESENT';
 let during:undefined|(()=>Promise<void>);
 const observer:RestrictionObserver={observeRestriction:async()=>{
  calls++;if(during)await during();return observation;
 }};
 const service=()=>new ModerationReversalPreflight(store,policy,observer);
 return {store,policy,observer,service,
  calls:()=>calls,set:(v:typeof observation)=>{observation=v;},
  during:(fn:()=>Promise<void>)=>{during=fn;},
  close:()=>rm(dir,{force:true,recursive:true})};
}
test('reversal preflight never offers a release action or mutates evidence',async()=>{
 const f=await fixture('json');try{
  const before=await f.store.snapshot();
  const result=await f.service().assess(OWNER,CHAT,TARGET);
  assert.deepEqual(result,{status:'OBSERVED_NOT_ATTRIBUTABLE',kind:'BAN'});
  assert.equal(f.calls(),1);
  assert.deepEqual(await f.store.snapshot(),before);
  assert.equal('release' in result,false);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('confirmed BAN observed still cannot prove this bot authored the ban ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.deepEqual(await f.service().assess(OWNER,CHAT,TARGET),
    {status:'OBSERVED_NOT_ATTRIBUTABLE',kind:'BAN'});
   assert.equal(f.calls(),1);
  }finally{await f.close();}
 });
 test('owner and moderation scope required before any API request ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.service().assess('301',CHAT,TARGET)).status,'DENIED');
   assert.equal((await f.service().assess(OWNER,CHAT,OWNER)).status,'DENIED');
   assert.equal((await f.service().assess(OWNER,CHAT,'invalid')).status,'DENIED');
   assert.equal((await f.service().assess(OWNER,'-100234',TARGET)).status,'DENIED');
   assert.equal((await f.service().assess(OWNER,CHAT,'0')).status,'DENIED');
   assert.equal(f.calls(),0);
   const v=(await f.store.snapshot()).chats[0]!.version;
   await f.policy.restrictChatScopeAtRevision(OWNER,CHAT,'moderation',v);
   assert.equal((await f.service().assess(OWNER,CHAT,TARGET)).status,'DENIED');
   assert.equal(f.calls(),0);
  }finally{await f.close();}
 });
 test('UNKNOWN or pending states veto preflight and preserve no-retry guard ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.push({
    ...s.moderationOperations[0]!,id:'unresolved',status:'UNKNOWN_OUTCOME'
   }));
   assert.equal((await f.service().assess(OWNER,CHAT,TARGET)).status,'BLOCKED_UNKNOWN');
   await f.store.transaction(s=>s.moderationOperations.at(-1)!.status='STARTED');
   assert.equal((await f.service().assess(OWNER,CHAT,TARGET)).status,'BLOCKED_PENDING');
   await f.store.transaction(s=>s.moderationOperations.at(-1)!.status='CANCELLED');
   assert.equal((await f.service().assess(OWNER,CHAT,TARGET)).status,'BLOCKED_UNPROVEN');
   assert.equal(f.calls(),0);
  }finally{await f.close();}
 });
 test('active reasons or mismatched latest status veto read-only verification ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationReasons.push({
    chatId:CHAT,memberId:TARGET,source:'MANUAL',reference:'a',kind:'BAN',
    createdBy:OWNER,active:true
   }));
   assert.equal((await f.service().assess(OWNER,CHAT,TARGET)).status,'BLOCKED_ACTIVE_REASON');
   await f.store.transaction(s=>s.moderationReasons[0]!.active=false);
   for(const status of ['FAILED_CONFIRMED','CANCELLED','INTENT'] as const){
    await f.store.transaction(s=>s.moderationOperations[0]!.status=status);
    assert.notEqual((await f.service().assess(OWNER,CHAT,TARGET)).status,'OBSERVED_NOT_ATTRIBUTABLE');
   }
   assert.equal(f.calls(),0);
  }finally{await f.close();}
 });
 test('Telegram observation mismatch, protected roles and uncertainty stay blocked ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(const [observed,status] of [
    ['MUTE_PRESENT','BLOCKED_MISMATCH'],['NO_RESTRICTION','BLOCKED_MISMATCH'],
    ['PROTECTED','BLOCKED_MISMATCH'],['NO_RIGHTS','BLOCKED_RIGHTS'],
    ['UNKNOWN','BLOCKED_OBSERVATION_UNKNOWN']
   ] as const){
    f.set(observed);
    assert.equal((await f.service().assess(OWNER,CHAT,TARGET)).status,status,observed);
   }
  }finally{await f.close();}
 });
 test('policy, reasons or operation changing DURING awaited external read invalidates observation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   f.during(async()=>{await f.store.transaction(s=>s.moderationOperations[0]!.reasonFingerprint='changed');});
   assert.equal((await f.service().assess(OWNER,CHAT,TARGET)).status,'BLOCKED_STALE');
  }finally{await f.close();}
 });
 test('local ban confirmed at an old group policy revision is not safe evidence ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['moderation','navigation']);
   assert.equal((await f.service().assess(OWNER,CHAT,TARGET)).status,'BLOCKED_STALE');
   assert.equal(f.calls(),0);
  }finally{await f.close();}
 });
 test('confirmed MUTE requires observed mute and remains non-authoritative ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations[0]!.kind='MUTE');
   f.set('MUTE_PRESENT');
   assert.deepEqual(await f.service().assess(OWNER,CHAT,TARGET),
    {status:'OBSERVED_NOT_ATTRIBUTABLE',kind:'MUTE'});
   assert.equal(f.calls(),1);
  }finally{await f.close();}
 });
}
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
const permissionFields=['can_send_messages','can_send_audios','can_send_documents',
 'can_send_photos','can_send_videos','can_send_video_notes','can_send_voice_notes',
 'can_send_polls','can_send_other_messages','can_add_web_page_previews',
 'can_react_to_messages'];
function api(membership:Record<string,unknown>,botRights=true){
 const calls:string[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;calls.push(method);
  const body=JSON.parse(String(init?.body)) as {user_id:number};
  const result=body.user_id===BOT?
   {status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:botRights}:
   {user:{id:300,is_bot:false},...membership};
  return new Response(JSON.stringify({ok:true,result}),{
   status:200,headers:{'content-type':'application/json'}
  });
 }) as typeof fetch;
 return {gateway:new TelegramBotApiModerationGateway(TOKEN,request),calls};
}
test('Telegram live observer requires bot admin rights and only reads getChatMember',async()=>{
 const denied=api({status:'kicked'},false);
 assert.equal(await denied.gateway.observeRestriction(CHAT,TARGET),'NO_RIGHTS');
 assert.deepEqual(denied.calls,['getChatMember']);
 const banned=api({status:'kicked'});
 assert.equal(await banned.gateway.observeRestriction(CHAT,TARGET),'BAN_PRESENT');
 assert.deepEqual(banned.calls,['getChatMember','getChatMember']);
 const mute=api({status:'restricted',is_member:true,
  ...Object.fromEntries(permissionFields.map(x=>[x,false]))});
 assert.equal(await mute.gateway.observeRestriction(CHAT,TARGET),'MUTE_PRESENT');
 assert.deepEqual(mute.calls,['getChatMember','getChatMember']);
});
test('Telegram observer fails closed for admins, bots, incomplete mute or uncertain states',async()=>{
 for(const [entry,result] of [
  [{status:'administrator'},'PROTECTED'],
  [{status:'creator'},'PROTECTED'],
  [{status:'member',user:{id:300,is_bot:true}},'PROTECTED'],
  [{status:'restricted',is_member:false,can_send_messages:false},'UNKNOWN'],
  [{status:'restricted',is_member:true,can_send_messages:false},'UNKNOWN'],
  [{status:'left'},'UNKNOWN'],[{status:'member'},'NO_RESTRICTION'],
  [{status:'banned'},'UNKNOWN']
 ] as const){
  const f=api(entry as Record<string,unknown>);
  assert.equal(await f.gateway.observeRestriction(CHAT,TARGET),result);
  assert.ok(f.calls.every(s=>s==='getChatMember'));
 }
 const f=api({status:'kicked'});
 assert.equal(await f.gateway.observeRestriction('bad',TARGET),'UNKNOWN');
 assert.deepEqual(f.calls,[]);
});
