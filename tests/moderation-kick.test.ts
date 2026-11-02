import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {FakeModerationGateway,ModerationService} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {parseReplyModerationCommand,executeReplyModerationCommand} from '../src/telegram-moderation-commands.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {renderOwnerModerationRateStatus} from '../src/telegram-inline-moderation-rate-status.js';

const NOW=1700000000000,CHAT='-100123';
const reply={message_id:10,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false}};
test('kick grammar requires a canonical case reference and human same-group reply; duration is not a ban alias',()=>{
 assert.equal(parseReplyModerationCommand('/kick case','ManaratakBot',CHAT,20,reply).status,'COMMAND');
 for(const text of ['/kick case 1m','/kick','/kick case\n','/kick case extra'])assert.equal(parseReplyModerationCommand(text,'ManaratakBot',CHAT,20,reply).status,'INVALID');
 assert.equal(parseReplyModerationCommand('/kick@AnotherBot case','ManaratakBot',CHAT,20,reply).status,'NO_MATCH');
 assert.equal(parseReplyModerationCommand('/kick case','ManaratakBot',CHAT,20,{...reply,forward_origin:{type:'user'}}).status,'INVALID');
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(official=false){
  const dir=await mkdtemp(join(tmpdir(),'kick-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,id=100,status='member',rights=true,running=true,lost=false,retain=false;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation']);await policy.grant('100','200','chat.manage',CHAT,NOW+1000000);
  const fake=new FakeModerationGateway(),writes:Record<string,unknown>[]=[];
  const request=(async(url:unknown,init:RequestInit)=>{
   const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));let result:unknown;
   if(method==='getChat')result={id:Number(CHAT),type:'supergroup'};
   else if(method==='getChatMember')result=body.user_id===123456789?{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:rights}:{status,user:{id:300,is_bot:false},is_member:status!=='left'};
   else{assert.equal(method,'unbanChatMember');assert.equal(body.only_if_banned,false);writes.push(body);if(!retain)status='left';if(lost)throw Error('Lost response');result=true;}
   return Response.json({ok:true,result});
  }) as typeof fetch;
  const gateway=official?new TelegramBotApiModerationGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>running,()=>now):fake;
  const service=new ModerationService(store,policy,gateway,()=>now),education=new EducationService(store,policy,()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),moderation:service,clock:()=>now,botId:'kick',botUsername:'ManaratakBot',ownerMenuMode:'inline',membership:async()=>{throw Error('No network');}});
  const command=(text='/kick case',actor=200)=>app.handle({update_id:++id,message:{message_id:1000+id,chat:{id:Number(CHAT),type:'supergroup'},from:{id:actor,is_bot:false},text,reply_to_message:reply}});
  const click=(data:string,actor=200,group=false)=>app.handle({update_id:++id,callback_query:{id:'kick'+id,from:{id:actor,is_bot:false},data,message:{message_id:77,chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'},from:{id:999,is_bot:true}}}});
  return {store,policy,fake,gateway,service,command,click,writes,calls:()=>official?writes.length:fake.calls.length,time:(v:number)=>{now=v;},setStatus:(v:string)=>{status=v;},noRights:()=>{rights=false;},stop:()=>{running=false;},lose:()=>{lost=true;},retain:()=>{retain=true;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 type Result=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['command']>>;
 const choose=(r:Result,prefix='mc:1:c:')=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b,JSON.stringify(r));return b.callback_data;};
 test(engine+' scoped kick requires private confirmation, records one nonpersistent action and cannot replay a case',async()=>{
  const f=await fixture();try{
   const p=await f.command();assert.equal(p.reason,'MODERATION_PREVIEW_ONLY');assert.equal(p.plan!.chatId,'200');assert.match(p.plan!.text,/دون حظر دائم/u);assert.equal(f.calls(),0);
   const confirm=choose(p);assert.equal((await f.click(confirm,201)).status,'DENIED');assert.equal((await f.click(confirm,200,true)).status,'DENIED');assert.equal((await f.click(confirm)).status,'APPLIED');assert.equal(f.calls(),1);
   const state=await f.store.snapshot(),op=state.moderationOperations[0]!;assert.equal(op.kind,'NONE');assert.equal(op.action,'KICK');assert.equal(op.caseReference,'case');assert.equal(op.status,'CONFIRMED');assert.equal(state.moderationReasons.length,0);
   assert.equal((await f.click(confirm)).status,'DENIED');f.time(NOW+1000);const again=await f.command();assert.equal((await f.click(choose(again))).status,'IGNORED');assert.equal(f.calls(),1);
   let cases=await f.click('cs:1:h:b:0');cases=await f.click(choose(cases,'cs:1:g:'));cases=await f.click(choose(cases,'cs:1:d:'));assert.match(cases.plan!.text,/النوع: طرد/u);assert.match(cases.plan!.text,/محاكاة/u);assert.equal(cases.plan!.inlineMarkup!.inline_keyboard.flat().some(b=>b.callback_data.startsWith('cs:1:a:')),false);
  }finally{await f.close();}
 });
 test(engine+' direct execution, independent restrictions and expired/revoked decisions cannot kick',async()=>{
  const f=await fixture();try{
   assert.equal((await executeReplyModerationCommand(f.service,'200',CHAT,{kind:'kick',reference:'case',memberId:'300'})).status,'DENIED');assert.equal(f.calls(),0);
   let p=await f.command();f.time(NOW+120000);assert.equal((await f.click(choose(p))).status,'DENIED');f.time(NOW);
   p=await f.command();await f.store.transaction(s=>{s.grants[0]!.revoked=true;});assert.equal((await f.click(choose(p))).status,'DENIED');assert.equal(f.calls(),0);
  }finally{await f.close();}
  const blocked=await fixture();try{
   await blocked.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'SUBSCRIPTION',kind:'MUTE',reference:'gate',createdBy:'100',active:true});});assert.equal((await blocked.command()).status,'DENIED');assert.equal(blocked.calls(),0);
  }finally{await blocked.close();}
 });
 test(engine+' late independent reasons cancel the kick and unknown delivery never retries',async()=>{
  const f=await fixture();try{
   const p=await f.command();f.service.beforeDispatch=async()=>{await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'SUBSCRIPTION',kind:'MUTE',reference:'late',createdBy:'100',active:true});});};
   assert.equal((await f.click(choose(p))).status,'DENIED');assert.equal(f.calls(),0);assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);
  }finally{await f.close();}
  const unknown=await fixture();try{
   unknown.fake.outcome='UNKNOWN_OUTCOME';const p=await unknown.command();assert.equal((await unknown.click(choose(p))).status,'UNKNOWN');assert.equal(unknown.calls(),1);assert.equal((await unknown.command('/kick another')).status,'DENIED');assert.equal(unknown.calls(),1);
  }finally{await unknown.close();}
 });
 test(engine+' kicks consume the same durable sanction rate budget',async()=>{
  const f=await fixture();try{
   for(let i=0;i<5;i++){f.time(NOW+i*1000);const p=await f.command('/kick case_'+i);assert.equal((await f.click(choose(p))).status,'APPLIED');}
   f.time(NOW+6000);const sixth=await f.command('/kick sixth');assert.equal((await f.click(choose(sixth))).status,'DENIED');assert.equal(f.calls(),5);assert.equal((await f.store.snapshot()).moderationOperations.length,5);
   const report=await renderOwnerModerationRateStatus(f.store,f.policy,'100',NOW+6000);assert.match(report!.text,/آخر 10 دقائق: 5/u);
  }finally{await f.close();}
 });
 test(engine+' official kick removes a current ordinary member with one mutation and verifies left status',async()=>{
  const f=await fixture(true);try{
   const p=await f.command();assert.equal(f.calls(),0);assert.equal((await f.click(choose(p))).status,'APPLIED');assert.equal(f.calls(),1);assert.equal(f.writes[0]!.only_if_banned,false);assert.equal((await f.store.snapshot()).moderationOperations[0]!.attemptGateway,'TELEGRAM_API');assert.equal((await f.store.snapshot()).moderationReasons.length,0);
  }finally{await f.close();}
 });
 test(engine+' official kick refuses existing external restrictions and cannot call a replaced adapter method',async()=>{
  const f=await fixture(true);try{
   for(const status of ['kicked','restricted','administrator','left']){f.setStatus(status);assert.equal((await f.command()).status,'DENIED');assert.equal(f.calls(),0);}
   f.setStatus('member');(f.gateway as TelegramBotApiModerationGateway).kickMember=async()=> 'CONFIRMED';assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(f.gateway),false);assert.equal((await f.command()).status,'DENIED');assert.equal(f.calls(),0);
  }finally{await f.close();}
 });
 test(engine+' official kick lost acknowledgement or unchanged readback stays unknown without retry',async()=>{
  for(const mode of ['lost','retain'] as const){
   const f=await fixture(true);try{
    const p=await f.command();if(mode==='lost')f.lose();else f.retain();assert.equal((await f.click(choose(p))).status,'UNKNOWN');assert.equal(f.calls(),1);assert.equal((await f.store.snapshot()).moderationOperations[0]!.status,'UNKNOWN_OUTCOME');assert.equal((await f.command('/kick another')).status,'DENIED');assert.equal(f.calls(),1);
   }finally{await f.close();}
  }
 });
 test(engine+' changing a reserved kick case cannot change the dispatched action',async()=>{
  const f=await fixture();try{
   const p=await f.command();f.service.beforeDispatch=async()=>{await f.store.transaction(s=>{s.moderationOperations[0]!.caseReference='rewritten';});};
   assert.equal((await f.click(choose(p))).status,'UNKNOWN');assert.equal(f.calls(),0);assert.ok((await f.store.snapshot()).moderationOperations.some(o=>o.status==='UNKNOWN_OUTCOME'&&o.action==='KICK'&&o.caseReference==='case'));
  }finally{await f.close();}
 });
}
test('kick refreshes target protection after the last awaited authority callback',async()=>{
 let status='member',callbacks=0,writes=0;
 const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));let result:unknown;
  if(method==='getChat')result={id:Number(CHAT),type:'supergroup'};
  else if(method==='getChatMember')result=body.user_id===123456789?{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:true}:{status,user:{id:300,is_bot:false}};
  else{writes++;result=true;}return Response.json({ok:true,result});
 }) as typeof fetch;
 const gateway=new TelegramBotApiModerationGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>true);
 assert.equal(await gateway.kickMember(CHAT,'300',async()=>{if(++callbacks===3)status='kicked';return true;}),'FAILED_CONFIRMED');assert.equal(writes,0);
});
