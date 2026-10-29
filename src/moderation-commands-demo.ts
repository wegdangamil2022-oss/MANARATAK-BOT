import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {EducationService} from './education.js';
import {EducationAdminFacade} from './education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from './education-interactions.js';
import {ModerationService} from './moderation.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';
import {TelegramUpdateApplication} from './telegram-transport.js';

/** Local rehearsal only. All Bot API requests terminate in this function;
 * no credentials, real groups, environment values or network are consulted. */
async function main():Promise<void>{
 const directory=await mkdtemp(join(tmpdir(),'manaratak-moderation-demo-'));
 try{
  const store=new BotStore(join(directory,'state.sqlite'),{engine:'sqlite'});
  const policy=new Policy(store,'100',()=>1000),education=new EducationService(store,policy);
  await policy.approveChat('100','-100123',['moderation']);
  let armed=true,mutations=0;
  const request=(async(_url:string|URL|Request,init?:RequestInit)=>{
   const method=String(_url).split('/').at(-1)!;
   const body=JSON.parse(String(init?.body));
   let result:unknown;
   if(method==='getChatMember')result=body.user_id===123456789
    ?{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:true}
    :{status:'member',user:{id:body.user_id,is_bot:false}};
   else{
    assert.ok(method==='banChatMember'||method==='restrictChatMember');
    mutations++;
    if(body.user_id===303)throw Error('SIMULATED_AMBIGUOUS_PROVIDER_TIMEOUT');
    result=true;
   }
   return new Response(JSON.stringify({ok:true,result}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const gateway=new TelegramBotApiModerationGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>armed);
  const moderation=new ModerationService(store,policy,gateway,()=>1000);
  const app=new TelegramUpdateApplication({store,policy,education,moderation,
   admin:new EducationAdminFacade(store,policy,education),faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
   botId:'offline-moderation-rehearsal',botUsername:'ManaratakBot',clock:()=>1000,
   membership:async()=>{throw Error('MEMBERSHIP_NOT_USED_IN_REHEARSAL');}});
  const event=(id:number,text:string,target:number)=>({update_id:id,message:{
   message_id:1000+id,chat:{id:-100123,type:'supergroup'},from:{id:100,is_bot:false},text,
   reply_to_message:{message_id:10,chat:{id:-100123,type:'supergroup'},from:{id:target,is_bot:false}}}});
  const ban=event(1,'/ban trial-ban',300);
  assert.equal((await app.handle(ban)).status,'APPLIED');
  assert.equal((await app.handle(ban)).status,'DUPLICATE');
  assert.equal((await app.handle(event(2,'/mute trial-mute',301))).status,'APPLIED');
  assert.equal((await app.handle(event(3,'/warn trial-warning',302))).status,'APPLIED');
  assert.equal((await app.handle(event(4,'/unwarn trial-warning',302))).status,'APPLIED');
  assert.equal((await app.handle(event(5,'/ban trial-unknown',303))).status,'UNKNOWN');
  assert.equal((await app.handle(event(6,'/ban retry-forbidden',303))).status,'DENIED');
  armed=false;
  assert.equal((await app.handle(event(7,'/ban stopped',304))).status,'DENIED');
  assert.equal(mutations,3); // Includes one ambiguous attempted request, never retried.
  const state=await store.snapshot();
  assert.equal(state.warnings[0]?.active,false);
  assert.equal(state.moderationOperations.filter(o=>o.status==='CONFIRMED').length,2);
  assert.equal(state.moderationOperations.filter(o=>o.status==='UNKNOWN_OUTCOME').length,1);
  console.log(JSON.stringify({offlineOnly:true,telegramNetworkCalls:0,simulatedAcceptedSanctions:2,
   warningAddedAndRevoked:true,replayBlocked:true,unknownOutcomeQuarantined:true,stopBlockedMutation:true},null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
}
void main().catch(()=>{console.error('OFFLINE_MODERATION_REHEARSAL_FAILED');process.exitCode=1;});
