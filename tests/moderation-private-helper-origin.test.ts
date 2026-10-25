import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {ModerationService} from '../src/moderation.js';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
const OWNER='100',CHAT='-100123',TARGET='300',NOW=1_700_000_000_000;
const response=(result:unknown)=>new Response(JSON.stringify({ok:true,result}),
 {status:200,headers:{'content-type':'application/json'}});
const fake=(calls:string[]) => (async(url:string|URL|Request,init?:RequestInit)=>{
 const method=String(url).split('/').at(-1)!;
 const body=JSON.parse(String(init?.body)) as {user_id:number};
 calls.push(method);
 return method==='getChatMember'? response(body.user_id===BOT?
  {status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true}:
  {status:'member',user:{id:body.user_id,is_bot:false}}):response(true);
}) as typeof fetch;

test('the unmodified exact Telegram adapter retains the local dispatch-origin hint',()=>{
 const gateway=new TelegramBotApiModerationGateway(TOKEN,fake([]));
 assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(gateway),true);
});
test('an inherited subclass, even without public overrides, is not the exact audited adapter',()=>{
 class Derived extends TelegramBotApiModerationGateway {}
 const gateway=new Derived(TOKEN,fake([]));
 assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(gateway),false);
});
for(const helper of ['call','getMember','allowed'] as const){
 test('replaced internal '+helper+' implementation loses official dispatch-origin classification',()=>{
  const gateway=new TelegramBotApiModerationGateway(TOKEN,fake([]),async()=>true);
  // JavaScript-level prototype/instance mutation can replace TypeScript-private
  // helpers without overriding any of the three public functions.
  (gateway as unknown as Record<string,unknown>)[helper]=async()=>true;
  assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(gateway),false);
 });
}
for(const engine of ['json','sqlite'] as const){
 test('patched internal API helper remains quarantined in durable '+engine+' operation ledger',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-private-helper-origin-'));
  try{
   const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,CHAT,['moderation']);
   const calls:string[]=[];
   const gateway=new TelegramBotApiModerationGateway(TOKEN,fake(calls),async()=>true);
   (gateway as unknown as Record<string,unknown>).getMember=
    async(_chat:string,id:string)=>Number(id)===BOT?
     {status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true}:
     {status:'member',user:{id:Number(id),is_bot:false}};
   assert.equal((await new ModerationService(store,policy,gateway,()=>NOW)
    .addManualReason(OWNER,CHAT,TARGET,'private-helper-overridden','BAN')).status,'APPLIED');
   assert.equal((await store.snapshot()).moderationOperations.at(-1)?.attemptGateway,'UNSPECIFIED');
   assert.deepEqual(calls,['banChatMember']);
  }finally{await rm(dir,{force:true,recursive:true});}
 });
}
