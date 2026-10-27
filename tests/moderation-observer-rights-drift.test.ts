import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {ModerationReversalPreflight} from '../src/moderation-reversal-preflight.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
const OWNER='100',CHAT='-100123',TARGET='300';
const response=(v:unknown)=>new Response(JSON.stringify({ok:true,result:v}),{
 status:200,headers:{'content-type':'application/json'}});
const rights=(allowed:boolean)=>response({status:'administrator',
 user:{id:BOT,is_bot:true},can_restrict_members:allowed});
const target=(status:'kicked'|'member')=>response({status,user:{id:Number(TARGET),is_bot:false}});

function observer(options:{targetStatus?:'kicked'|'member';
  afterTarget?:'REVOKE'|'HTTP_FAILURE'|'THROW'|'STABLE'}={}){
 let observedTarget=false;
 const calls:string[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  calls.push(method);
  assert.equal(method,'getChatMember','observation can never mutate Telegram');
  const data=JSON.parse(String(init?.body)) as {chat_id:string;user_id:number};
  assert.equal(data.chat_id,CHAT);
  if(data.user_id===BOT){
   if(!observedTarget)return rights(true);
   if(options.afterTarget==='THROW')throw Error('transport lost');
   if(options.afterTarget==='HTTP_FAILURE')return new Response('unavailable',{status:503});
   return rights(options.afterTarget!=='REVOKE');
  }
  assert.equal(data.user_id,Number(TARGET));
  observedTarget=true;
  return target(options.targetStatus??'kicked');
 }) as typeof fetch;
 return {gateway:new TelegramBotApiModerationGateway(TOKEN,request),
  calls,hasSeenTarget:()=>observedTarget};
}

for(const [kind,targetStatus] of [['BAN','kicked'],['NONE','member']] as const){
 test('read-only '+kind+' observation blocks if bot rights are revoked during target read',async()=>{
  const h=observer({targetStatus,afterTarget:'REVOKE'});
  const result=await h.gateway.observeRestriction(CHAT,TARGET);
  assert.equal(result,'NO_RIGHTS');
  assert.deepEqual(h.calls,['getChatMember','getChatMember','getChatMember']);
 });
}
for(const fault of ['HTTP_FAILURE','THROW'] as const){
 test('read-only restriction observation fails closed on final rights '+fault,async()=>{
  const h=observer({afterTarget:fault});
  assert.equal(await h.gateway.observeRestriction(CHAT,TARGET),'NO_RIGHTS');
  assert.deepEqual(h.calls,['getChatMember','getChatMember','getChatMember']);
 });
}
test('stable permissions continue to produce advisory BAN_PRESENT with no mutation',async()=>{
 const h=observer({afterTarget:'STABLE'});
 assert.equal(await h.gateway.observeRestriction(CHAT,TARGET),'BAN_PRESENT');
 assert.deepEqual(h.calls,['getChatMember','getChatMember','getChatMember']);
});

for(const engine of ['json','sqlite'] as const){
 test('reversal preflight '+engine+' refuses stale provider rights even with confirmed local evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-reversal-rights-drift-'));
  try{
   const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
   const policy=new Policy(store,OWNER,()=>1700000000000);
   await policy.approveChat(OWNER,CHAT,['moderation']);
   const version=policy.chatRevision(await store.snapshot(),CHAT);
   await store.transaction(s=>s.moderationOperations.push({
    id:'confirmed-original-ban',chatId:CHAT,memberId:TARGET,actorId:OWNER,
    kind:'BAN',status:'CONFIRMED',attemptGateway:'TELEGRAM_API',
    reasonFingerprint:'opaque',policyVersion:version,createdAt:1700000000000
   }));
   const before=await store.snapshot();
   const h=observer({afterTarget:'REVOKE'});
   const result=await new ModerationReversalPreflight(store,policy,h.gateway)
    .assess(OWNER,CHAT,TARGET);
   assert.deepEqual(result,{status:'BLOCKED_RIGHTS'});
   assert.deepEqual(h.calls,['getChatMember','getChatMember','getChatMember']);
   assert.deepEqual(await store.snapshot(),before);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
