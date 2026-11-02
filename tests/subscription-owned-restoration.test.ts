import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {privateGroupEpochDigest} from '../src/telegram-group-access.js';
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {renderSubscriptionConfig} from '../src/telegram-inline-subscription-config.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {GROUP_PERMISSION_KEYS} from '../src/group-permission-model.js';
import {recordSubscriptionEnforcementConsent,subscriptionEnforcementConsent} from '../src/subscription-enforcement-policy.js';
const NOW=1700000000000,CHAT='-100123',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'subscription-owned-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,lost=false,rights=true;let target:Record<string,unknown>={status:'member',user:{id:300,is_bot:false}};const writes:string[]=[];let hook:(()=>Promise<void>)|undefined;
  const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));let result:unknown;
   if(method==='getChat')result={id:Number(CHAT),type:'supergroup',permissions:{can_send_messages:true}};
   else if(method==='getChatMember'){if(hook){const h=hook;hook=undefined;await h();}result=body.user_id===123456789?{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:rights}:structuredClone(target);}
   else{assert.equal(method,'restrictChatMember');writes.push(method);const restore=Object.values(body.permissions).every(v=>v===true);target=restore?{status:'member',user:{id:300,is_bot:false}}:{status:'restricted',user:{id:300,is_bot:false},is_member:true,until_date:0,...Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,false]))};if(lost&&restore)throw Error('LOST_ACK');result=true;}
   return Response.json({ok:true,result});}) as typeof fetch;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation','verification','navigation']);await policy.approveChat('100','-200',['verification']);await store.transaction(s=>{s.subscriptionRequirements.push({chatId:CHAT,channelIds:['-200'],mode:'ALL',version:1});});
  const service=new ModerationService(store,policy,new TelegramBotApiModerationGateway(TOKEN,request,async()=>true,()=>now),()=>now);
  const membership=Object.assign(new FakeMembershipGateway(),{joinURL:async()=> 'https://t.me/RequiredChannel'}),gate=new SubscriptionGate(store,policy,membership,service,()=>now);let groupMember=true;const education=new EducationService(store,policy,()=>now),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),subscription:gate,moderation:service,membership:async()=>groupMember?'VERIFIED':'NOT_MEMBER',clock:()=>now,botId:'sub-enforce',botUsername:'ManaratakBot'});let sends=0;const dispatcher=new TelegramReplyDispatcher(store,policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:90+sends};}},()=>now,undefined,gate,async()=>groupMember?'VERIFIED':'NOT_MEMBER');return {store,policy,service,membership,gate,app,dispatcher,sends:()=>sends,leave:()=>{groupMember=false;},writes,now:()=>now,time:(n:number)=>{now=n;},target:()=>target,lost:()=>{lost=true;},hook:(h:()=>Promise<void>)=>{hook=h;},consent:()=>store.transaction(s=>recordSubscriptionEnforcementConsent(s,policy,'100',CHAT,true,now)),close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' official subscription writes require explicit owner consent and release only the matching lone subscription receipt',async()=>{
  const f=await fixture();try{
   assert.equal((await f.service.setSubscriptionReason(CHAT,'300','subscription-gate',true,()=>true)).reason,'SUBSCRIPTION_ENFORCEMENT_NOT_APPROVED');assert.equal(f.writes.length,0);assert.equal(await f.consent(),true);
   assert.equal((await f.service.setSubscriptionReason(CHAT,'300','subscription-gate',true,()=>true)).status,'APPLIED');assert.equal(f.target().status,'restricted');f.time(NOW+1000);
   assert.equal((await f.service.setSubscriptionReason(CHAT,'300','subscription-gate',false,()=>true)).status,'APPLIED');assert.equal(f.target().status,'member');assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,false);assert.equal(f.writes.length,2);
  }finally{await f.close();}
 });
 test(engine+' subscription release keeps the reason active on conflict, stale approval or lost acknowledgement',async()=>{
  for(const reason of ['independent','stale','lost'] as const){const f=await fixture();try{
   await f.consent();assert.equal((await f.service.setSubscriptionReason(CHAT,'300','subscription-gate',true,()=>true)).status,'APPLIED');f.time(NOW+1000);
   if(reason==='independent')await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'MANUAL',reference:'manual',kind:'MUTE',createdBy:'100',active:true});});
   if(reason==='stale')f.hook(async()=>{await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version++;});});
   if(reason==='lost')f.lost();const result=await f.service.setSubscriptionReason(CHAT,'300','subscription-gate',false,()=>true);assert.notEqual(result.status,'APPLIED');assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);assert.equal(f.writes.length,reason==='lost'?2:1);
  }finally{await f.close();}}
 });
 test(engine+' automatic synchronization reports verification separately and releases only after confirmed membership or explicit disable consent',async()=>{
  const f=await fixture();try{
   assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).decision.status,'DENIED');await f.consent();f.membership.set('-200','300','NOT_MEMBER');const applied=await f.gate.synchronizeAutomatic(CHAT,'300');assert.equal(applied.decision.status,'NOT_MEMBER');assert.equal(applied.effect!.status,'APPLIED');assert.equal(f.target().status,'restricted');
   f.time(NOW+1000);f.membership.set('-200','300','MEMBER');const released=await f.gate.synchronizeAutomatic(CHAT,'300');assert.equal(released.decision.status,'MEMBER');assert.equal(released.effect!.status,'APPLIED');assert.equal(f.target().status,'member');
  }finally{await f.close();}
 });
 test(engine+' owner subscription editor requires separate consent and invalidates older enable buttons after disable',async()=>{
  const f=await fixture();try{
   const pick=(view:OwnerInlineScreen|null,text:string)=>{assert.ok(view&&isValidTelegramInlineKeyboard(view.keyboard));const b=view.keyboard.inline_keyboard.flat().find(b=>b.text.includes(text));assert.ok(b,text);return b.callback_data;};
   const open=()=>renderSubscriptionConfig(f.store,f.policy,f.gate,'100','sc:1:h',f.now),tap=(data:string)=>renderSubscriptionConfig(f.store,f.policy,f.gate,'100',data,f.now);
   let root=await open(),edit=await tap(pick(root,CHAT)),review=await tap(pick(edit,'معاينة تفعيل التقييد'));assert.equal(await f.gate.automaticMode(CHAT),'UNAVAILABLE');const confirm=pick(review,'اعتماد التقييد');assert.ok(await tap(confirm));assert.equal(await f.gate.automaticMode(CHAT),'ON');assert.equal(f.writes.length,0);assert.equal(await tap(confirm),null);
   f.time(NOW+1000);root=await open();edit=await tap(pick(root,CHAT));review=await tap(pick(edit,'معاينة إيقاف التقييد'));assert.ok(await tap(pick(review,'تعطيل التقييد والسماح')));assert.equal(await f.gate.automaticMode(CHAT),'OFF');assert.equal(f.writes.length,0);
  }finally{await f.close();}
 });
 test(engine+' incoming enforcement and the private verification flow deliver join buttons to a non-subscriber and release the owned mute after joining',async()=>{
  const f=await fixture();try{
   f.membership.set('-200','300','NOT_MEMBER');await f.consent();const incoming=await f.app.handle({update_id:50,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'a normal group message'}});assert.equal(incoming.reason,'SUBSCRIPTION_VERIFICATION_VIEW');assert.equal(incoming.plan!.chatId,'300');assert.equal(f.target().status,'restricted');assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===incoming.deliveryKey)!.privateReplyKind,'VERIFICATION_SCOPED');assert.ok(incoming.plan!.studioMarkup!.inline_keyboard.flat().some(b=>'url' in b&&b.url==='https://t.me/RequiredChannel'));assert.equal((await f.dispatcher.dispatch(incoming.deliveryKey!)).status,'CONFIRMED');assert.equal(f.sends(),1);
   f.time(NOW+1000);f.membership.set('-200','300','MEMBER');const verify=await f.app.handle({update_id:51,message:{message_id:11,chat:{id:300,type:'private'},from:{id:300,is_bot:false},text:'/verify '+CHAT}});assert.equal(verify.reason,'SUBSCRIPTION_VERIFICATION_VIEW');assert.equal(f.target().status,'member');assert.match(verify.plan!.text,/اكتمل/u);assert.equal((await f.dispatcher.dispatch(verify.deliveryKey!)).status,'CONFIRMED');assert.equal(f.sends(),2);
  }finally{await f.close();}
 });
 test(engine+' queued verification cannot bypass group membership or reuse a resource-access epoch',async()=>{
  for(const reason of ['membership','domain','revision'] as const){const f=await fixture();try{
   f.membership.set('-200','300','NOT_MEMBER');const view=await f.app.handle({update_id:60,message:{message_id:10,chat:{id:300,type:'private'},from:{id:300,is_bot:false},text:'/verify '+CHAT}});assert.ok(view.plan);assert.equal(f.writes.length,0);
   if(reason==='membership')f.leave();if(reason==='domain')await f.store.transaction(s=>{s.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.privateGroupAccess!.epoch=privateGroupEpochDigest(s,CHAT);});if(reason==='revision')await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version++;});assert.equal((await f.dispatcher.dispatch(view.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(f.sends(),0);
  }finally{await f.close();}}
 });
 test(engine+' verification callbacks always operate on their sender and reject a different group message context',async()=>{
  const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect!.status,'APPLIED');f.time(NOW+1000);
   const cb=(id:number,actor:number,chat:number,type='private')=>({update_id:id,callback_query:{id:'verify-'+id,from:{id:actor,is_bot:false},data:'sv:1:'+CHAT+':1',message:{message_id:90,from:{id:999,is_bot:true},chat:{id:chat,type}}}});
   const wrong=await f.app.handle(cb(70,301,-999,'supergroup'));assert.equal(wrong.status,'DENIED');const own=await f.app.handle(cb(71,301,301));assert.equal(own.plan!.chatId,'301');assert.equal((await f.store.snapshot()).moderationReasons.find(r=>r.memberId==='300')!.active,true);assert.equal(f.writes.length,1);
   const prompt=await f.app.handle({update_id:72,message:{message_id:80,chat:{id:Number(CHAT),type:'supergroup'},from:{id:100,is_bot:false},text:'/subscriptionprompt'}});assert.equal(prompt.reason,'SUBSCRIPTION_VERIFICATION_PROMPT');assert.equal((await f.dispatcher.dispatch(prompt.deliveryKey!)).status,'CONFIRMED');
  }finally{await f.close();}
 });
 test(engine+' pausing the condition can separately authorize release of the owned subscription reason without a channel read',async()=>{
  const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect!.status,'APPLIED');f.time(NOW+1000);await f.gate.configure('100',CHAT,[],'ALL');assert.equal(await f.gate.automaticMode(CHAT),'UNAVAILABLE');
   const pick=(view:OwnerInlineScreen|null,text:string)=>{assert.ok(view);const b=view.keyboard.inline_keyboard.flat().find(b=>b.text.includes(text));assert.ok(b,text);return b.callback_data;},tap=(data:string)=>renderSubscriptionConfig(f.store,f.policy,f.gate,'100',data,f.now);
   const root=await tap('sc:1:h'),edit=await tap(pick(root,CHAT)),review=await tap(pick(edit,'معاينة إيقاف التقييد'));assert.ok(await tap(pick(review,'تعطيل التقييد والسماح')));assert.equal(await f.gate.automaticMode(CHAT),'OFF');f.membership.verifiable=false;assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect!.status,'APPLIED');assert.equal(f.target().status,'member');
  }finally{await f.close();}
 });
 test(engine+' periodic checks stay off by default, honor STOP, release only active owned reasons and skip unknown receipts',async()=>{
  const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect!.status,'APPLIED');f.time(NOW+1000);f.membership.set('-200','300','MEMBER');
   assert.equal((await f.gate.tickAutomatic()).status,'DISABLED');assert.equal((await f.gate.tickAutomatic(true,async()=>false)).status,'STOPPED');assert.equal(f.writes.length,1);
   const ran=await f.gate.tickAutomatic(true,async()=>true);assert.equal(ran.checked,1);assert.equal(ran.changed,1);assert.equal(f.target().status,'member');assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,0);
   f.time(NOW+2000);f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect!.status,'APPLIED');f.time(NOW+3000);f.membership.set('-200','300','MEMBER');f.lost();assert.equal((await f.gate.tickAutomatic(true,async()=>true)).unresolved,1);const writes=f.writes.length;
   const blocked=await f.gate.tickAutomatic(true,async()=>true);assert.equal(blocked.checked,0);assert.equal(blocked.unresolved,1);assert.equal(f.writes.length,writes);
  }finally{await f.close();}
 });
 test(engine+' consent is invalid after rule, approval or private-setting revision changes and future receipts cannot authorize',async()=>{
  const f=await fixture();try{await f.consent();assert.ok(subscriptionEnforcementConsent(await f.store.snapshot(),f.policy,CHAT,NOW));assert.equal(subscriptionEnforcementConsent(await f.store.snapshot(),f.policy,CHAT,NOW-1),null);await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version++;});assert.equal(subscriptionEnforcementConsent(await f.store.snapshot(),f.policy,CHAT,NOW),null);}finally{await f.close();}
 });
}
