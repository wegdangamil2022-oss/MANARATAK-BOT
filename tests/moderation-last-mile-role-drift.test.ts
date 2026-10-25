import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',BOT=123456789;
const CHAT='-100123',OWNER='100',TARGET='300',NOW=1_700_000_000_000;
type Kind='BAN'|'MUTE';
type RoleChange='TARGET_ADMIN'|'TARGET_CREATOR'|'TARGET_BOT'|
 'BOT_DEMOTED'|'BOT_RESTRICT_REVOKED'|'TARGET_UNKNOWN';
const result=(value:unknown)=>new Response(JSON.stringify({ok:true,result:value}),
 {status:200,headers:{'content-type':'application/json'}});
function rightsHarness(){
 let botRole='administrator',botRestrict=true,targetRole='member',targetBot=false;
 const calls:string[]=[];
 let localChecks=0;
 const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  const body=JSON.parse(String(init?.body)) as {user_id:number;chat_id:string};
  calls.push(method);
  if(method==='getChatMember'){
   return body.user_id===BOT?
    result({status:botRole,user:{id:BOT,is_bot:true},can_restrict_members:botRestrict}):
    result({status:targetRole,user:{id:Number(body.user_id),is_bot:targetBot}});
  }
  return result(true);
 }) as typeof fetch;
 const gw=new TelegramBotApiModerationGateway(TOKEN,fetcher,async()=>true);
 const change=(kind:RoleChange)=>{
  if(kind==='TARGET_ADMIN')targetRole='administrator';
  if(kind==='TARGET_CREATOR')targetRole='creator';
  if(kind==='TARGET_BOT')targetBot=true;
  if(kind==='TARGET_UNKNOWN')targetRole='mystery';
  if(kind==='BOT_DEMOTED')botRole='member';
  if(kind==='BOT_RESTRICT_REVOKED')botRestrict=false;
 };
 const local=async()=>{localChecks++;return true;};
 return {gw,calls,change,local,get localChecks(){return localChecks;}};
}

for(const kind of ['BAN','MUTE'] as const){
 for(const drift of ['TARGET_ADMIN','TARGET_CREATOR','TARGET_BOT',
  'BOT_DEMOTED','BOT_RESTRICT_REVOKED','TARGET_UNKNOWN'] as const){
  test(kind+' does not sanction after '+drift+' during awaited local authority check',async()=>{
   const h=rightsHarness();
   const outcome=await h.gw.setRestriction(CHAT,TARGET,kind,async()=>{
    h.change(drift);
    return h.local();
   });
   assert.equal(outcome,'FAILED_CONFIRMED');
   assert.equal(h.calls.filter(m=>m==='banChatMember'||m==='restrictChatMember').length,0,
    'no sanction when fresh provider evidence no longer proves target safety');
  });
 }
 test(kind+' refuses dispatch when local authorization is revoked during refreshed remote checks',async()=>{
  const h=rightsHarness();
  let reads=0;
  const result=await h.gw.setRestriction(CHAT,TARGET,kind,async()=>{
   reads++;return reads===1;
  });
  assert.equal(result,'FAILED_CONFIRMED');
  assert.equal(reads,2,'local authority must be revalidated AFTER fresh Telegram rights');
  assert.equal(h.calls.some(m=>m==='banChatMember'||m==='restrictChatMember'),false);
 });
}

for(const engine of ['json','sqlite'] as const){
 for(const kind of ['BAN','MUTE'] as const){
  test('durable '+engine+' '+kind+' ledger blocks target promotion after STARTED preflight',async()=>{
   const dir=await mkdtemp(join(tmpdir(),'manaratak-role-drift-'));
   try{
    const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
    const policy=new Policy(store,OWNER,()=>NOW);
    await policy.approveChat(OWNER,CHAT,['moderation']);
    let role='member',switched=false;
    const calls:string[]=[];
    const request=(async(url:string|URL|Request,init?:RequestInit)=>{
     const method=String(url).split('/').at(-1)!;
     const data=JSON.parse(String(init?.body)) as {user_id:number};
     calls.push(method);
     if(method==='getChatMember'){
      if(data.user_id===BOT)return result({
       status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true
      });
      const status=role;
      const started=(await store.snapshot()).moderationOperations.some(o=>o.status==='STARTED');
      // The first target read inside the mutating adapter sees a safe member.
      // Telegram promotes the member immediately AFTER that read. This is
      // later than service's local checks and BEFORE the provider write.
      if(started&&!switched){role='administrator';switched=true;}
      return result({status,user:{id:data.user_id,is_bot:false}});
     }
     return result(true);
    }) as typeof fetch;
    const gw=new TelegramBotApiModerationGateway(TOKEN,request,async()=>true);
    const service=new ModerationService(store,policy,gw,()=>NOW);
    const answer=await service.addManualReason(OWNER,CHAT,TARGET,'role-drift',kind);
    assert.equal(switched,true,'the race must actually happen inside STARTED');
    assert.equal(answer.status,'FAILED_CONFIRMED');
    assert.equal(calls.some(m=>m==='banChatMember'||m==='restrictChatMember'),false);
    const operations=(await store.snapshot()).moderationOperations;
    assert.equal(operations.length,1);
    assert.equal(operations[0]!.status,'FAILED_CONFIRMED');
    assert.equal(operations[0]!.attemptGateway,'TELEGRAM_API');
   }finally{await rm(dir,{recursive:true,force:true});}
  });
 }
}
