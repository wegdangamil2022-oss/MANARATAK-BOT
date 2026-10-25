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
const GROUP='-100123',TARGET='300',OWNER='100',NOW=1_700_000_000_000;
const reply=(body:unknown)=>new Response(JSON.stringify({ok:true,result:body}),{
 status:200,headers:{'content-type':'application/json'}
});
const bot=()=>({status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true});
const target=(status:string,details:Record<string,unknown>={})=>
 ({status,user:{id:Number(TARGET),is_bot:false},...details});
function gatewayWithResponses(getTarget:()=>Record<string,unknown>){
 const calls:string[]=[];
 const request=(async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;
  const body=JSON.parse(String(init?.body)) as {user_id:number};
  calls.push(method);
  if(method==='getChatMember')return reply(body.user_id===BOT?bot():getTarget());
  return reply(true);
 }) as typeof fetch;
 return {calls,gateway:new TelegramBotApiModerationGateway(TOKEN,request,async()=>true)};
}

for(const kind of ['BAN','MUTE'] as const){
 for(const [label,detail] of [
  ['active mute',{is_member:true,can_send_messages:false}],
  ['partially restricted member',{is_member:true,can_send_messages:true,can_send_photos:false}],
  ['restricted and not currently present',{is_member:false}],
  ['restricted membership not specified',{}]
 ] as const){
  test('v0.7.83 '+kind+' refuses to overwrite an existing Telegram '+label,async()=>{
   const g=gatewayWithResponses(()=>target('restricted',detail));
   assert.equal(await g.gateway.isProtected(GROUP,TARGET),true);
   assert.equal(await g.gateway.setRestriction(GROUP,TARGET,kind),'FAILED_CONFIRMED');
   assert.deepEqual(g.calls,['getChatMember','getChatMember','getChatMember']);
   assert.equal(g.calls.some(c=>c==='banChatMember'||c==='restrictChatMember'),false);
  });
 }
 test('v0.7.83 '+kind+' refuses member becoming restricted during local authorization await',async()=>{
  let status='member';
  const g=gatewayWithResponses(()=>target(status,status==='restricted'?{is_member:true}:{}));
  const answer=await g.gateway.setRestriction(GROUP,TARGET,kind,async()=>{
   status='restricted';return true;
  });
  assert.equal(answer,'FAILED_CONFIRMED');
  assert.equal(g.calls.filter(c=>c==='getChatMember').length,4);
  assert.equal(g.calls.some(c=>c==='banChatMember'||c==='restrictChatMember'),false);
 });
}
test('v0.7.83 read-only restriction observation still reports a full mute, without claiming its author',async()=>{
 const denied={
  can_send_messages:false,can_send_audios:false,can_send_documents:false,
  can_send_photos:false,can_send_videos:false,can_send_video_notes:false,
  can_send_voice_notes:false,can_send_polls:false,can_send_other_messages:false,
  can_add_web_page_previews:false,can_react_to_messages:false
 };
 const g=gatewayWithResponses(()=>target('restricted',{is_member:true,...denied}));
 assert.equal(await g.gateway.observeRestriction(GROUP,TARGET),'MUTE_PRESENT');
 assert.deepEqual(g.calls,['getChatMember','getChatMember']);
});

for(const engine of ['json','sqlite'] as const){
 for(const kind of ['BAN','MUTE'] as const){
  test('v0.7.83 '+engine+' durable '+kind+' refuses externally applied restriction after STARTED',async()=>{
   const dir=await mkdtemp(join(tmpdir(),'manaratak-existing-restriction-'));
   try{
    const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine});
    const policy=new Policy(store,OWNER,()=>NOW);
    await policy.approveChat(OWNER,GROUP,['moderation']);
    let switchToRestricted=false;
    const calls:string[]=[];
    const request=(async(url:string|URL|Request,init?:RequestInit)=>{
     const method=String(url).split('/').at(-1)!;
     const body=JSON.parse(String(init?.body)) as {user_id:number};
     calls.push(method);
     if(method==='getChatMember'){
      if(body.user_id===BOT)return reply(bot());
      const started=(await store.snapshot()).moderationOperations.some(op=>op.status==='STARTED');
      if(started)switchToRestricted=true;
      return reply(target(switchToRestricted?'restricted':'member',
       switchToRestricted?{is_member:true,can_send_messages:false}:{}));
     }
     return reply(true);
    }) as typeof fetch;
    const service=new ModerationService(store,policy,
     new TelegramBotApiModerationGateway(TOKEN,request,async()=>true),()=>NOW);
    const answer=await service.addManualReason(OWNER,GROUP,TARGET,'new-rule',kind);
    assert.equal(switchToRestricted,true,'preexisting external restriction must be observed after STARTED');
    assert.equal(answer.status,'FAILED_CONFIRMED');
    assert.equal(calls.some(m=>m==='banChatMember'||m==='restrictChatMember'),false);
    const current=await store.snapshot();
    assert.equal(current.moderationOperations.length,1);
    assert.equal(current.moderationOperations[0]!.status,'FAILED_CONFIRMED');
    assert.equal(current.moderationOperations[0]!.attemptGateway,'TELEGRAM_API');
   }finally{await rm(dir,{recursive:true,force:true});}
  });
 }
}
