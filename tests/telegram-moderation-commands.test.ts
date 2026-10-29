import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
const CHAT='-100123',OWNER='100',TARGET='300';
const update=(id:number,text:string,actor=100,reply:unknown={message_id:10,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false}})=>({
 update_id:id,message:{message_id:1000+id,chat:{id:Number(CHAT),type:'supergroup'},from:{id:actor,is_bot:false},text,
 ...(reply===undefined?{}:{reply_to_message:reply})}});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'moderation-command-'));
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>1000),education=new EducationService(store,policy);
 await policy.approveChat(OWNER,CHAT,['moderation']);
 const gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>1000);
 const app=(configured=true,service=moderation)=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'commands-test',botUsername:'ManaratakBot',clock:()=>1000,membership:async()=>{throw Error('unexpected membership request');},
  ...(configured?{moderation:service}:{})});
 return {dir,store,policy,gateway,app,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('reply moderation commands use approved moderation scope and durable dedup ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const msg=update(1,'/ban@ManaratakBot case-A');
   const first=await f.app().handle(msg);
   assert.equal(first.status,'APPLIED');
   assert.equal(first.reason,'MODERATION_APPLIED');
   assert.equal((await f.app().handle(msg)).status,'DUPLICATE');
   assert.deepEqual(f.gateway.calls,[{chatId:CHAT,memberId:TARGET,kind:'BAN'}]);
   assert.equal((await f.store.snapshot()).moderationOperations[0]?.status,'CONFIRMED');
   assert.equal(first.plan,undefined,'no private moderation evidence in group reply');
  }finally{await f.close();}
 });
 test('warnings can be added and revoked only by authorized actors ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.app().handle(update(1,'/warn case-A',200))).status,'DENIED');
   assert.equal((await f.app().handle(update(2,'/warn case-A'))).status,'APPLIED');
   assert.equal((await f.app().handle(update(3,'/unwarn case-A'))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).warnings[0]?.active,false);
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test('missing service, forged reply, other bot and bad syntax cannot mutate ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.app(false).handle(update(1,'/mute case'))).reason,'MODERATION_NOT_CONFIGURED');
   let id=2;
   for(const text of ['/mute','/mute case extra','/warn ../case','/ban\ncase'])
    assert.equal((await f.app().handle(update(id++,text))).status,'DENIED');
   for(const reply of [null,{message_id:10,chat:{id:-99,type:'supergroup'},from:{id:300,is_bot:false}},
    {message_id:10,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:true}},
    {message_id:10,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},sender_chat:{id:-1}}])
    assert.equal((await f.app().handle(update(id++,'/ban case',100,reply))).status,'DENIED');
   assert.notEqual((await f.app().handle(update(id++,'/ban@DifferentBot case'))).status,'APPLIED');
   assert.equal(f.gateway.calls.length,0);
   assert.equal((await f.store.snapshot()).moderationReasons.length,0);
  }finally{await f.close();}
 });
 test('unknown outcomes block a fresh command without sending again ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   f.gateway.outcome='UNKNOWN_OUTCOME';
   assert.equal((await f.app().handle(update(1,'/mute first'))).status,'UNKNOWN');
   assert.equal((await f.app().handle(update(2,'/mute second'))).status,'DENIED');
   assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 });

 test('official Bot API adapter receives only the verified target and records gateway provenance ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const methods:string[]=[];
   let enabled=true;
   const request=(async(url:string|URL|Request,init?:RequestInit)=>{
    const method=String(url).split('/').at(-1)!;
    const body=JSON.parse(String(init?.body));methods.push(method);
    let result:unknown;
    if(method==='getChatMember')result=body.user_id===123456789
     ?{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:true}
     :{status:'member',user:{id:300,is_bot:false}};
    else{
     assert.equal(method,'banChatMember');
     assert.deepEqual(body,{chat_id:CHAT,user_id:300,revoke_messages:false});
     result=true;
    }
    return new Response(JSON.stringify({ok:true,result}),{status:200,headers:{'content-type':'application/json'}});
   }) as typeof fetch;
   const adapter=new TelegramBotApiModerationGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>enabled);
   const service=new ModerationService(f.store,f.policy,adapter,()=>1000);
   const result=await f.app(true,service).handle(update(1,'/ban official'));
   assert.equal(result.status,'APPLIED');
   assert.equal(methods.filter(m=>m==='banChatMember').length,1);
   const op=(await f.store.snapshot()).moderationOperations[0]!;
   assert.equal(op.status,'CONFIRMED');assert.equal(op.attemptGateway,'TELEGRAM_API');
   // STOP still wins for a new target operation even when the adapter is injected.
   enabled=false;
   assert.equal(await adapter.setRestriction(CHAT,'301','BAN'),'FAILED_CONFIRMED');
   assert.equal(methods.filter(m=>m==='banChatMember').length,1);
  }finally{await f.close();}
 });
 test('protected targets and revoked group remain blocked ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   f.gateway.protectedMembers.add(CHAT+':'+TARGET);
   assert.equal((await f.app().handle(update(1,'/ban case'))).status,'DENIED');
   assert.equal((await f.app().handle(update(3,'/warn protected'))).status,'DENIED');
   f.gateway.protectedMembers.clear();
   await f.policy.revokeChat(OWNER,CHAT);
   assert.equal((await f.app().handle(update(2,'/ban case'))).status,'DENIED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
}
