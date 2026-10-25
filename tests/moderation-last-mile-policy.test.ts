import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';

const OWNER='100',STAFF='200',CHAT='-100123',TARGET='300';
const NOW=1_700_000_000_000,BOT=123456789;
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
type Scenario='CHAT_REVOKED'|'GRANT_REVOKED'|'REASONS_CHANGED';
const member=(status:string,userId:number,rights=false)=>
 new Response(JSON.stringify({ok:true,result:{status,user:{id:userId,is_bot:userId===BOT},
  ...(rights?{can_restrict_members:true}:{})}}),
 {status:200,headers:{'content-type':'application/json'}});
const ok=()=>new Response(JSON.stringify({ok:true,result:true}),
 {status:200,headers:{'content-type':'application/json'}});

async function runScenario(engine:'json'|'sqlite',scenario:Scenario){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-last-mile-'));
 try{
  const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
  const policy=new Policy(store,OWNER,()=>NOW);
  await policy.approveChat(OWNER,CHAT,['moderation']);
  const actor=scenario==='GRANT_REVOKED'?STAFF:OWNER;
  if(actor===STAFF)await policy.grant(OWNER,STAFF,'chat.manage',CHAT,NOW+10_000);
  let changed=false;
  const calls:string[]=[];
  const request=(async(url:string|URL|Request,init?:RequestInit)=>{
   const method=String(url).split('/').at(-1)!;
   const body=JSON.parse(String(init?.body)) as {user_id:number};
   calls.push(method);
   // The remote bot-rights read starts AFTER the local STARTED reservation.
   // Revoke while Telegram is returning preflight data, before the write.
   if(method==='getChatMember'){
    const hasStarted=(await store.snapshot()).moderationOperations.some(o=>o.status==='STARTED');
    if(hasStarted&&!changed){
     changed=true;
     if(scenario==='CHAT_REVOKED')await policy.revokeChat(OWNER,CHAT);
     if(scenario==='GRANT_REVOKED')
      await policy.revokeGrant(OWNER,STAFF,'chat.manage',CHAT);
     if(scenario==='REASONS_CHANGED')
      await store.transaction(s=>{s.moderationReasons[0]!.reference='changed-after-start';});
    }
    return body.user_id===BOT?member('administrator',BOT,true):
     member('member',body.user_id);
   }
   return ok();
  }) as typeof fetch;
  const gateway=new TelegramBotApiModerationGateway(TOKEN,request,async()=>true);
  const service=new ModerationService(store,policy,gateway,()=>NOW);
  const result=await service.addManualReason(actor,CHAT,TARGET,'original','BAN');
  assert.equal(changed,true,'test must revoke while STARTED');
  assert.equal(result.status,'FAILED_CONFIRMED');
  const last=(await store.snapshot()).moderationOperations.at(-1)!;
  assert.equal(last.status,'FAILED_CONFIRMED');
  assert.equal(last.attemptGateway,'TELEGRAM_API');
  assert.equal(calls.filter(x=>x==='banChatMember'||x==='restrictChatMember').length,0,
   'must never submit a sanction after local authority/evidence changes');
 }finally{await rm(dir,{recursive:true,force:true});}
}
for(const engine of ['json','sqlite'] as const){
 for(const scenario of ['CHAT_REVOKED','GRANT_REVOKED','REASONS_CHANGED'] as const){
  test('Telegram dispatch rechecks '+scenario+' after STARTED ('+engine+')',
   async()=>runScenario(engine,scenario));
 }
}
