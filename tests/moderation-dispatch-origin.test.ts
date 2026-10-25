import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway,type ModerationGateway} from '../src/moderation.js';
import {ModerationReversalPreflight,inspectLocalReversal} from '../src/moderation-reversal-preflight.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';

const OWNER='100',CHAT='-100123',MEMBER='300',NOW=1_700_000_000_000;
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-dispatch-origin-'));
 const file=join(dir,engine==='sqlite'?'data.sqlite':'data.json');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 return {file,store,policy,close:()=>rm(dir,{force:true,recursive:true})};
}
const observer=()=>{let calls=0;return {
 observeRestriction:async()=>{calls++;return 'BAN_PRESENT' as const;},
 count:()=>calls
};};
for(const engine of ['json','sqlite'] as const){
 test('simulation receipt survives restart but is never evidence to verify or lift Telegram sanction ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const gateway=new FakeModerationGateway();
   const moderation=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   assert.equal((await moderation.addManualReason(OWNER,CHAT,MEMBER,'forged-telegram-claim','BAN')).status,'APPLIED');
   const before=await f.store.snapshot();
   assert.equal(before.moderationOperations[0]!.attemptGateway,'SIMULATION');
   assert.equal(before.moderationOperations[0]!.status,'CONFIRMED');
   await f.store.transaction(s=>{s.moderationReasons[0]!.active=false;});
   const reopened=new BotStore(f.file,{engine}),policy=new Policy(reopened,OWNER,()=>NOW);
   assert.equal(inspectLocalReversal(await reopened.snapshot(),policy,CHAT,MEMBER).status,'BLOCKED_UNPROVEN');
   const probe=observer();
   const answer=await new ModerationReversalPreflight(reopened,policy,probe).assess(OWNER,CHAT,MEMBER);
   assert.equal(answer.status,'BLOCKED_UNPROVEN');
   assert.equal(probe.count(),0);
   assert.equal(gateway.calls.length,1);
  }finally{await f.close();}
 });
 test('unknown implementation cannot self-certify a Telegram response ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const generic:ModerationGateway={
    canRestrict:async()=>true,isProtected:async()=>false,setRestriction:async()=> 'CONFIRMED'
   };
   const moderation=new ModerationService(f.store,f.policy,generic,()=>NOW);
   assert.equal((await moderation.addManualReason(OWNER,CHAT,MEMBER,'opaque-gateway','BAN')).status,'APPLIED');
   assert.equal((await f.store.snapshot()).moderationOperations[0]!.attemptGateway,'UNSPECIFIED');
   await f.store.transaction(s=>{s.moderationReasons[0]!.active=false;});
   const probe=observer();
   assert.equal((await new ModerationReversalPreflight(f.store,f.policy,probe).assess(OWNER,CHAT,MEMBER)).status,'BLOCKED_UNPROVEN');
   assert.equal(probe.count(),0);
  }finally{await f.close();}
 });
 test('locally recorded Telegram API request may be inspected but still cannot authorize release ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   let banned=false;const calls:string[]=[];
   const request=(async(url:string|URL|Request,init?:RequestInit)=>{
    const method=String(url).split('/').at(-1)!;calls.push(method);
    const body=JSON.parse(String(init?.body)) as {user_id:number};
    if(method==='banChatMember'){
     banned=true;
     return new Response(JSON.stringify({ok:true,result:true}),
      {status:200,headers:{'content-type':'application/json'}});
    }
    const member=body.user_id===BOT?
     {status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true}:
     {status:banned?'kicked':'member',user:{id:Number(body.user_id),is_bot:false}};
    return new Response(JSON.stringify({ok:true,result:member}),
     {status:200,headers:{'content-type':'application/json'}});
   }) as typeof fetch;
   const gateway=new TelegramBotApiModerationGateway(TOKEN,request,async()=>true);
   const moderation=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   assert.equal((await moderation.addManualReason(OWNER,CHAT,MEMBER,'local-dispatch','BAN')).status,'APPLIED');
   assert.equal((await f.store.snapshot()).moderationOperations[0]!.attemptGateway,'TELEGRAM_API');
   await f.store.transaction(s=>{s.moderationReasons[0]!.active=false;});
   assert.deepEqual(await new ModerationReversalPreflight(f.store,f.policy,gateway).assess(OWNER,CHAT,MEMBER),
    {status:'OBSERVED_NOT_ATTRIBUTABLE',kind:'BAN'});
   assert.equal(calls.filter(x=>x==='banChatMember').length,1);
   assert.equal(calls.every(x=>x==='getChatMember'||x==='banChatMember'),true);
   assert.equal((await f.store.snapshot()).moderationOperations[0]!.status,'CONFIRMED');
  }finally{await f.close();}
 });
 test('revoked rights before dispatch leave CANCELLED without a source claim ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const gateway=new FakeModerationGateway();
   const moderation=new ModerationService(f.store,f.policy,gateway,()=>NOW);
   moderation.beforeDispatch=async()=>{await f.policy.revokeChat(OWNER,CHAT);};
   assert.equal((await moderation.addManualReason(OWNER,CHAT,MEMBER,'revoked','BAN')).status,'DENIED');
   const op=(await f.store.snapshot()).moderationOperations[0]!;
   assert.equal(op.status,'CANCELLED');
   assert.equal(op.attemptGateway,undefined);
   assert.equal(gateway.calls.length,0);
  }finally{await f.close();}
 });
}
test('historical CONFIRMED operation missing dispatch source is quarantined (never retroactively inferred)',async()=>{
 const f=await fixture('json');try{
  const version=(await f.store.snapshot()).chats[0]!.version;
  await f.store.transaction(s=>s.moderationOperations.push({
   id:'legacy-confirmed',chatId:CHAT,memberId:MEMBER,actorId:OWNER,
   kind:'BAN',reasonFingerprint:'legacy-hash',policyVersion:version,
   status:'CONFIRMED',createdAt:NOW
  }));
  const preflight=observer();
  assert.equal((await new ModerationReversalPreflight(f.store,f.policy,preflight).assess(OWNER,CHAT,MEMBER)).status,'BLOCKED_UNPROVEN');
  assert.equal(preflight.count(),0);
 }finally{await f.close();}
});
