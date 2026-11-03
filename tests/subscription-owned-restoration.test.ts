import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher,TelegramBotApiTextSender} from '../src/telegram-replies.js';
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
import {recordSubscriptionGracePolicy,subscriptionGracePolicy} from '../src/subscription-leave-grace.js';
import {TelegramEphemeralTextSender} from '../src/telegram-ephemeral-sender.js';
import {TelegramTemporaryGroupSender} from '../src/telegram-temporary-group-sender.js';
import {summarizeSubscriptionActivity} from '../src/subscription-activity-summary.js';
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
  const membership=Object.assign(new FakeMembershipGateway(),{joinURL:async()=> 'https://t.me/RequiredChannel'});membership.set(CHAT,'300','MEMBER');const gate=new SubscriptionGate(store,policy,membership,service,()=>now);let groupMember=true;const education=new EducationService(store,policy,()=>now),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),subscription:gate,moderation:service,membership:async()=>groupMember?'VERIFIED':'NOT_MEMBER',clock:()=>now,botId:'sub-enforce',botUsername:'ManaratakBot'});let sends=0;const dispatcher=new TelegramReplyDispatcher(store,policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:90+sends};}},()=>now,undefined,gate,async()=>groupMember?'VERIFIED':'NOT_MEMBER');return {store,policy,service,membership,gate,app,dispatcher,sends:()=>sends,leave:()=>{groupMember=false;},writes,now:()=>now,time:(n:number)=>{now=n;},target:()=>target,lost:()=>{lost=true;},hook:(h:()=>Promise<void>)=>{hook=h;},consent:()=>store.transaction(s=>recordSubscriptionEnforcementConsent(s,policy,'100',CHAT,true,now)),close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' previously unverified observed members enter bounded periodic checks without inventing membership',async()=>{
  for(const status of ['MEMBER','NOT_MEMBER','UNKNOWN'] as const){const f=await fixture();try{
   await f.consent();assert.equal(await f.gate.observeMember(CHAT,'300',NOW),'OBSERVED');
   assert.equal((await f.store.snapshot()).subscriptionGraceMembers?.length??0,0);
   assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,0);
   f.membership.set('-200','300',status);f.time(NOW+1800000);
   const result=await f.gate.tickAutomatic(true,async()=>true);assert.equal(result.checked,1);
   assert.equal(f.writes.length,status==='NOT_MEMBER'?1:0);
   const row=(await f.store.snapshot()).subscriptionObservedMembers![0]!;
   assert.equal(row.nextCheckAt,NOW+1800000+(status==='MEMBER'?6*3600000:1800000));
   if(status!=='NOT_MEMBER')assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,0);
  }finally{await f.close();}}
 });
 test(engine+' observed membership checks reject stale events, STOP, withdrawn consent and departed groups',async()=>{
  for(const variant of ['stale','stop','consent','departed'] as const){const f=await fixture();try{
   await f.consent();assert.equal(await f.gate.observeMember(CHAT,'100',NOW),'IGNORED');
   assert.equal(await f.gate.observeMember(CHAT,'300',variant==='stale'?NOW-30001:NOW),variant==='stale'?'IGNORED':'OBSERVED');
   if(variant==='consent')await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version++;});
   if(variant==='departed')f.membership.set(CHAT,'300','NOT_MEMBER');
   f.membership.set('-200','300','NOT_MEMBER');f.time(NOW+1800000);
   const result=await f.gate.tickAutomatic(true,async()=>variant!=='stop');assert.equal(f.writes.length,0);
   if(variant==='departed')assert.equal((await f.store.snapshot()).subscriptionObservedMembers!.length,0);
   else assert.equal(result.checked,0);
  }finally{await f.close();}}
 });
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
   const state=await f.store.snapshot(),activity=summarizeSubscriptionActivity(state,f.now());assert.equal(activity.member,1);assert.equal(activity.notMember,1);assert.equal(activity.unavailable,0);assert.equal(activity.deliveryConfirmed,2);assert.ok(state.audit.filter(a=>a.updateKey.endsWith(':subscription-metric')||a.updateKey.endsWith(':subscription-delivered')).every(a=>a.actorId===undefined&&(a.updateKey.endsWith(':subscription-metric')?/^SUBSCRIPTION_METRIC_(MEMBER|NOT_MEMBER|UNAVAILABLE|NOT_REQUIRED|DENIED)$/u.test(a.reason):/^SUBSCRIPTION_DELIVERY_(MESSAGE|EPHEMERAL):[a-f0-9]{64}$/u.test(a.reason))));
   const forged=structuredClone(state),proof=forged.audit.find(a=>a.updateKey===verify.deliveryKey+':subscription-delivered')!;forged.audit.push({...proof});assert.equal(summarizeSubscriptionActivity(forged,f.now()).deliveryConfirmed,1);
   const tampered=structuredClone(state);tampered.telegramReplyJobs!.find(j=>j.updateKey===verify.deliveryKey)!.messageId=999;assert.equal(summarizeSubscriptionActivity(tampered,f.now()).deliveryConfirmed,1);
   const replay=await f.app.handle({update_id:51,message:{message_id:11,chat:{id:300,type:'private'},from:{id:300,is_bot:false},text:'/verify '+CHAT}});assert.equal(replay.status,'DUPLICATE');assert.equal(summarizeSubscriptionActivity(await f.store.snapshot(),f.now()).member,1);
  }finally{await f.close();}
 });
 test(engine+' group verification uses a one-shot ephemeral outbox with a private bot link',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'ephemeral-flow',botUsername:'ManaratakBot'});
  const view=await app.handle({update_id:301,message:{message_id:10,message_thread_id:31,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});assert.ok(view.deliveryKey);assert.match(view.plan!.text,/\/verify -100123/u);assert.ok(view.plan!.studioMarkup!.inline_keyboard.flat().some(b=>'url' in b&&b.url==='https://t.me/ManaratakBot'));assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.verificationEphemeral,true);
  let calls=0,privateCalls=0;const request=(async(_url:unknown,init:RequestInit)=>{calls++;const body=JSON.parse(String(init.body));assert.equal(body.chat_id,CHAT);assert.equal(body.message_thread_id,31);assert.equal(body.ephemeral_message_parameters.receiver_user_id,300);return Response.json({ok:true,result:{chat:{id:Number(CHAT)},message_thread_id:31,from:{id:123456789,is_bot:true},receiver_user:{id:300,is_bot:false},ephemeral_message_id:45}});}) as typeof fetch;
  const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{privateCalls++;return {status:'CONFIRMED',messageId:1};}},f.now,async()=>true,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,request,async()=>true));
  assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'CONFIRMED');assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'SENT');assert.equal(calls,1);assert.equal(privateCalls,0);
  const snapshot=await f.store.snapshot(),job=snapshot.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!;assert.equal(job.status,'SENT');assert.equal(job.messageId,undefined);assert.equal(job.verificationEphemeral,undefined);assert.equal(job.verificationEphemeralTopicId,undefined);assert.equal(job.plan,undefined);assert.equal(summarizeSubscriptionActivity(snapshot,f.now()).deliveryConfirmed,1);
 }finally{await f.close();}});
 test(engine+' ephemeral outbox never falls back on unknown delivery or lost membership',async()=>{
  for(const scenario of ['unknown','membership','revoked','expiry','unconfigured'] as const){const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'ephemeral-fail',botUsername:'ManaratakBot'});
   const view=await app.handle({update_id:302,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let calls=0,privateCalls=0,membershipReads=0;const request=(async()=>{calls++;throw Error('timeout');}) as typeof fetch;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{privateCalls++;return {status:'CONFIRMED',messageId:1};}},f.now,async()=>true,f.gate,async()=>{membershipReads++;if(membershipReads===2&&scenario==='revoked')await f.store.transaction(s=>{s.chats.find(c=>c.id===CHAT)!.approved=false;});if(membershipReads===2&&scenario==='expiry')f.time(NOW+120000);return membershipReads===1||scenario!=='membership'?'VERIFIED':'NOT_MEMBER';},scenario==='unconfigured'?undefined:new TelegramEphemeralTextSender(TOKEN,request,async()=>true));
   const first=await dispatcher.dispatch(view.deliveryKey!);assert.equal(first.status,scenario==='unknown'?'UNKNOWN_OUTCOME':scenario==='unconfigured'?'PAUSED':'FAILED_CONFIRMED');assert.equal(privateCalls,0);assert.equal(calls,scenario==='unknown'?1:0);
   const counts=summarizeSubscriptionActivity(await f.store.snapshot(),f.now());assert.equal(counts.deliveryConfirmed,0);assert.equal(counts.deliveryUnresolved,1);
   if(scenario==='unknown'){assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'UNKNOWN_OUTCOME');const reopened=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{privateCalls++;return {status:'CONFIRMED',messageId:1};}},f.now,async()=>true,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,request,async()=>true));assert.equal((await reopened.dispatch(view.deliveryKey!)).status,'UNKNOWN_OUTCOME');assert.equal(calls,1);assert.equal(privateCalls,0);}
  }finally{await f.close();}}
 });
 test(engine+' confirmed ephemeral rejection sends a temporary private fallback and cleans it after the deadline',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'fallback-flow',botUsername:'ManaratakBot'});
  const view=await app.handle({update_id:303,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let ephemeralCalls=0,privateCalls=0,deletes=0,running=true;
  const ephemeralRequest=(async()=>{ephemeralCalls++;return Response.json({ok:false,error_code:400},{status:400});}) as typeof fetch;
  const privateRequest=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1),body=JSON.parse(String(init.body));assert.equal(body.chat_id,'300');if(method==='deleteMessage'){deletes++;assert.equal(body.message_id,88);return Response.json({ok:true,result:true});}privateCalls++;assert.ok(body.reply_markup.inline_keyboard.flat().some((b:{callback_data?:string})=>b.callback_data==='sv:1:'+CHAT+':1'));return Response.json({ok:true,result:{message_id:88,chat:{id:300},from:{id:123456789,is_bot:true}}});}) as typeof fetch;
  const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,new TelegramBotApiTextSender(TOKEN,privateRequest),f.now,async()=>running,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,ephemeralRequest,async()=>running),true);
  assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'CONFIRMED');assert.equal(ephemeralCalls,1);assert.equal(privateCalls,1);let job=(await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!;assert.equal(job.verificationCleanup?.status,'WAITING');assert.equal(job.verificationCleanup?.messageId,88);assert.equal((await dispatcher.cleanupVerificationFallbacks()).checked,0);
  f.time(NOW+60000);running=false;assert.equal((await dispatcher.cleanupVerificationFallbacks()).status,'STOPPED');assert.equal(deletes,0);running=true;assert.equal((await dispatcher.cleanupVerificationFallbacks()).acknowledged,1);assert.equal((await dispatcher.cleanupVerificationFallbacks()).checked,0);assert.equal(deletes,1);
  const after=await f.store.snapshot();job=after.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!;assert.equal(job.verificationCleanup?.status,'ACKNOWLEDGED');assert.equal(summarizeSubscriptionActivity(after,f.now()).deliveryConfirmed,1);assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'SENT');assert.equal(privateCalls,1);
 }finally{await f.close();}});
 test(engine+' verification button sends a fresh result and schedules early deletion of its temporary notice',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'fallback-verified',botUsername:'ManaratakBot'});
  const view=await app.handle({update_id:306,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let deleted=0;const request=(async()=>Response.json({ok:false,error_code:400},{status:400})) as typeof fetch;
  const sender={send:async()=>({status:'CONFIRMED' as const,messageId:89}),sendTemporaryPrivate:async(_plan:unknown,verify:()=>Promise<boolean>)=>await verify()?{status:'CONFIRMED' as const,messageId:88}:{status:'FAILED_CONFIRMED' as const},deleteOwnPrivate:async(_chat:string,_message:number,verify:()=>Promise<boolean>)=>{if(!await verify())return 'NOT_SENT' as const;deleted++;return 'ACKNOWLEDGED' as const;}};
  const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,sender,f.now,async()=>true,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,request,async()=>true),true);assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'CONFIRMED');
  f.time(NOW+1000);f.membership.set('-200','300','MEMBER');const verified=await app.handle({update_id:307,callback_query:{id:'fallback-verify',from:{id:300,is_bot:false},message:{message_id:88,from:{id:123456789,is_bot:true},chat:{id:300,type:'private'}},data:'sv:1:'+CHAT+':1'}});assert.equal(verified.reason,'SUBSCRIPTION_VERIFICATION_VIEW');assert.equal(verified.plan?.editMessageId,undefined);assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.verificationCleanup?.verifiedAt,NOW+1000);assert.equal((await dispatcher.cleanupVerificationFallbacks()).acknowledged,1);assert.equal(deleted,1);assert.equal((await dispatcher.dispatch(verified.deliveryKey!)).status,'CONFIRMED');
 }finally{await f.close();}});
 test(engine+' pending fallback resumes after STOP without repeating the rejected ephemeral call',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'fallback-resume',botUsername:'ManaratakBot'});
  const view=await app.handle({update_id:308,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let running=true,ephemeralCalls=0,privateCalls=0;const request=(async()=>{ephemeralCalls++;running=false;return Response.json({ok:false,error_code:400},{status:400});}) as typeof fetch;
  const sender={send:async()=>({status:'FAILED_CONFIRMED' as const}),sendTemporaryPrivate:async(_plan:unknown,verify:()=>Promise<boolean>)=>{if(!await verify())return {status:'FAILED_CONFIRMED' as const};privateCalls++;return {status:'CONFIRMED' as const,messageId:88};},deleteOwnPrivate:async()=> 'ACKNOWLEDGED' as const};
  const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,sender,f.now,async()=>running,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,request,async()=>running),true);assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'PAUSED');assert.equal((await dispatcher.drainVerificationFallbacks()).status,'STOPPED');running=true;assert.equal((await dispatcher.drainVerificationFallbacks()).checked,1);assert.equal((await dispatcher.drainVerificationFallbacks()).checked,0);assert.equal(ephemeralCalls,1);assert.equal(privateCalls,1);
 }finally{await f.close();}});
 test(engine+' fallback requires cleanup timers and a still-authorized source',async()=>{
  for(const variant of ['timers-off','revoked'] as const){const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'fallback-gate',botUsername:'ManaratakBot'});
   const view=await app.handle({update_id:304,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let sent=0;const request=(async()=>{if(variant==='revoked')await f.store.transaction(s=>{s.chats.find(c=>c.id===CHAT)!.approved=false;});return Response.json({ok:false,error_code:400},{status:400});}) as typeof fetch;
   const sender={send:async()=>{sent++;return {status:'CONFIRMED' as const,messageId:88};},sendTemporaryPrivate:async()=>{sent++;return {status:'CONFIRMED' as const,messageId:88};},deleteOwnPrivate:async()=> 'ACKNOWLEDGED' as const};
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,sender,f.now,async()=>true,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,request,async()=>true),variant!=='timers-off');assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,0);assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.verificationCleanup,undefined);
  }finally{await f.close();}}
 });
 test(engine+' temporary cleanup rejects duplicate receipts and never retries an uncertain delete',async()=>{
  for(const variant of ['unknown','not-sent','duplicate','forged-verification'] as const){const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'fallback-cleanup',botUsername:'ManaratakBot'});
   const view=await app.handle({update_id:305,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let deletes=0,running=true;const request=(async()=>Response.json({ok:false,error_code:400},{status:400})) as typeof fetch;
   const sender={send:async()=>({status:'FAILED_CONFIRMED' as const}),sendTemporaryPrivate:async(_plan:unknown,verify:()=>Promise<boolean>)=>await verify()?{status:'CONFIRMED' as const,messageId:88}:{status:'FAILED_CONFIRMED' as const},deleteOwnPrivate:async(_chat:string,_message:number,verify:()=>Promise<boolean>)=>{if(variant==='not-sent'&&deletes===0){deletes++;running=false;assert.equal(await verify(),false);return 'NOT_SENT' as const;}if(!await verify())return 'NOT_SENT' as const;deletes++;if(variant==='unknown')throw Error('lost response');return 'ACKNOWLEDGED' as const;}};
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,sender,f.now,async()=>running,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,request,async()=>running),true);assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'CONFIRMED');
   if(variant==='duplicate')await f.store.transaction(s=>{const job=s.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!;s.telegramReplyJobs!.push({...structuredClone(job),updateKey:'b3-webhook:fallback-other:999'});});
   if(variant==='forged-verification'){f.time(NOW+1000);await f.store.transaction(s=>{s.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.verificationCleanup!.verifiedAt=NOW+1000;});assert.equal((await dispatcher.cleanupVerificationFallbacks()).checked,0);assert.equal(deletes,0);}
   f.time(NOW+60000);const first=await dispatcher.cleanupVerificationFallbacks();if(variant==='unknown'){assert.equal(first.unresolved,1);assert.equal((await dispatcher.cleanupVerificationFallbacks()).checked,0);assert.equal(deletes,1);}else if(variant==='duplicate'){assert.equal(first.checked,0);assert.equal(deletes,0);}else if(variant==='forged-verification'){assert.equal(first.acknowledged,1);assert.equal(deletes,1);}else{assert.equal(first.checked,1);running=true;assert.equal((await dispatcher.cleanupVerificationFallbacks()).acknowledged,1);assert.equal(deletes,2);}
  }finally{await f.close();}}
 });
 test(engine+' invalid cleanup receipts cannot starve a valid due notice',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'fallback-starvation',botUsername:'ManaratakBot'});
  const view=await app.handle({update_id:309,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let deletes=0;const request=(async()=>Response.json({ok:false,error_code:400},{status:400})) as typeof fetch;
  const sender={send:async()=>({status:'FAILED_CONFIRMED' as const}),sendTemporaryPrivate:async(_plan:unknown,verify:()=>Promise<boolean>)=>await verify()?{status:'CONFIRMED' as const,messageId:88}:{status:'FAILED_CONFIRMED' as const},deleteOwnPrivate:async(_chat:string,_message:number,verify:()=>Promise<boolean>)=>{if(!await verify())return 'NOT_SENT' as const;deletes++;return 'ACKNOWLEDGED' as const;}};
  const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,sender,f.now,async()=>true,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,request,async()=>true),true);assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'CONFIRMED');
  await f.store.transaction(s=>{const original=s.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!;for(let i=0;i<5;i++){const forged=structuredClone(original);forged.updateKey='b3-webhook:forged:'+i;forged.messageId=100+i;forged.verificationCleanup!.messageId=100+i;forged.verificationCleanup!.chatId=String(400+i);forged.verificationCleanup!.createdAt-=1000;forged.verificationCleanup!.deleteAfter-=1000;s.telegramReplyJobs!.push(forged);}});
  f.time(NOW+60000);assert.equal((await dispatcher.cleanupVerificationFallbacks()).acknowledged,1);assert.equal(deletes,1);assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.verificationCleanup!.status,'ACKNOWLEDGED');
 }finally{await f.close();}});
 test(engine+' confirmed private rejection sends and cleans the group fallback in the original topic',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'public-fallback',botUsername:'ManaratakBot'});
  const view=await app.handle({update_id:310,message:{message_id:10,message_thread_id:42,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let sent=0,deleted=0;
  const ephemeral=(async()=>Response.json({ok:false,error_code:400},{status:400})) as typeof fetch;
  const privateRequest=(async()=>Response.json({ok:false,error_code:403},{status:403})) as typeof fetch;
  const groupRequest=(async(url:unknown,init:RequestInit)=>{const body=JSON.parse(String(init.body));assert.equal(body.chat_id,CHAT);if(String(url).endsWith('/deleteMessage')){deleted++;assert.equal(body.message_id,90);return Response.json({ok:true,result:true});}sent++;assert.equal(body.message_thread_id,42);return Response.json({ok:true,result:{chat:{id:Number(CHAT)},from:{id:123456789,is_bot:true},message_id:90,message_thread_id:42}});}) as typeof fetch;
  const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,new TelegramBotApiTextSender(TOKEN,privateRequest),f.now,async()=>true,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,ephemeral,async()=>true),true,{sender:new TelegramTemporaryGroupSender(TOKEN,groupRequest),botUsername:'ManaratakBot'});
  assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'CONFIRMED');assert.equal(sent,1);assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'SENT');
  f.time(NOW+60000);assert.equal((await dispatcher.cleanupVerificationFallbacks()).acknowledged,1);assert.equal(deleted,1);assert.equal((await dispatcher.cleanupVerificationFallbacks()).checked,0);
 }finally{await f.close();}});
 test(engine+' group fallback stops on uncertain private send and never retries uncertain group delivery',async()=>{
  for(const variant of ['private-unknown','group-unknown','stopped'] as const){const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'public-fallback-edge',botUsername:'ManaratakBot'});
   const view=await app.handle({update_id:311,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let groupCalls=0,privateCalls=0,ephemeralCalls=0,running=true;
   const ephemeral=(async()=>{ephemeralCalls++;return Response.json({ok:false,error_code:400},{status:400});}) as typeof fetch;
   const privateRequest=(async()=>{privateCalls++;if(variant==='private-unknown')throw Error('lost');if(variant==='stopped')running=false;return Response.json({ok:false,error_code:403},{status:403});}) as typeof fetch;
   const groupRequest=(async()=>{groupCalls++;throw Error('lost');}) as typeof fetch;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,new TelegramBotApiTextSender(TOKEN,privateRequest),f.now,async()=>running,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,ephemeral,async()=>running),true,{sender:new TelegramTemporaryGroupSender(TOKEN,groupRequest),botUsername:'ManaratakBot'});
   assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,variant==='stopped'?'PAUSED':'UNKNOWN_OUTCOME');assert.equal(groupCalls,variant==='group-unknown'?1:0);
   running=true;if(variant==='stopped'){const reopened=new BotStore(f.store.file,{engine}),resumed=new TelegramReplyDispatcher(reopened,f.policy,new TelegramBotApiTextSender(TOKEN,privateRequest),f.now,async()=>running,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,ephemeral,async()=>running),true,{sender:new TelegramTemporaryGroupSender(TOKEN,groupRequest),botUsername:'ManaratakBot'});assert.equal((await resumed.drainVerificationFallbacks()).checked,1);assert.equal(groupCalls,1);assert.equal(ephemeralCalls,1);assert.equal(privateCalls,1);}
   await dispatcher.dispatch(view.deliveryKey!);assert.equal(groupCalls,variant==='private-unknown'?0:1);
  }finally{await f.close();}}
 });
 test(engine+' queued group fallback rejects forged evidence, changed policy, missing membership and expired scope',async()=>{
  for(const variant of ['evidence','topic','policy','membership','expired'] as const){const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'public-recheck',botUsername:'ManaratakBot'});
   const view=await app.handle({update_id:314,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let running=true,member=true,groupCalls=0;const ephemeral=(async()=>Response.json({ok:false,error_code:400},{status:400})) as typeof fetch,privateRequest=(async()=>{running=false;return Response.json({ok:false,error_code:403},{status:403});}) as typeof fetch,groupRequest=(async()=>{groupCalls++;throw Error('unexpected');}) as typeof fetch;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,new TelegramBotApiTextSender(TOKEN,privateRequest),f.now,async()=>running,f.gate,async()=>member?'VERIFIED':'NOT_MEMBER',new TelegramEphemeralTextSender(TOKEN,ephemeral,async()=>running),true,{sender:new TelegramTemporaryGroupSender(TOKEN,groupRequest),botUsername:'ManaratakBot'});assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'PAUSED');
   if(variant==='evidence')await f.store.transaction(s=>{s.audit.find(a=>a.updateKey===view.deliveryKey+':private-rejected')!.reason='FORGED';});if(variant==='topic')await f.store.transaction(s=>{s.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.verificationFallbackTopicId=7;});if(variant==='policy')await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version++;});if(variant==='membership')member=false;if(variant==='expired')f.time(NOW+120000);running=true;
   assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,variant==='evidence'||variant==='topic'?'UNKNOWN_OUTCOME':'FAILED_CONFIRMED');assert.equal(groupCalls,0);if(variant==='evidence'||variant==='topic'){const job=(await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!;assert.equal(job.status,'UNKNOWN_OUTCOME');assert.equal(job.plan,undefined);assert.equal((await dispatcher.drainVerificationFallbacks()).checked,0);}
  }finally{await f.close();}}
 });
 test(engine+' forged public fallback queue rows cannot starve a valid notice',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'public-drain',botUsername:'ManaratakBot'});
  const view=await app.handle({update_id:315,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let running=true,groupCalls=0;const ephemeral=(async()=>Response.json({ok:false,error_code:400},{status:400})) as typeof fetch,privateRequest=(async()=>{running=false;return Response.json({ok:false,error_code:403},{status:403});}) as typeof fetch,groupRequest=(async()=>{groupCalls++;return Response.json({ok:true,result:{chat:{id:Number(CHAT)},from:{id:123456789,is_bot:true},message_id:90}});}) as typeof fetch;
  const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,new TelegramBotApiTextSender(TOKEN,privateRequest),f.now,async()=>running,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,ephemeral,async()=>running),true,{sender:new TelegramTemporaryGroupSender(TOKEN,groupRequest),botUsername:'ManaratakBot'});assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'PAUSED');
  await f.store.transaction(s=>{const original=s.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!;for(let i=0;i<5;i++){const forged=structuredClone(original);forged.updateKey='b3-webhook:forged-public:'+i;forged.queuedAt=NOW-1;s.telegramReplyJobs!.push(forged);}const duplicate=structuredClone(original);duplicate.updateKey='b3-webhook:duplicated-public:1';duplicate.queuedAt=NOW-1;s.telegramReplyJobs!.push(duplicate,structuredClone(duplicate));});running=true;
  f.time(Number.NaN);assert.deepEqual(await dispatcher.drainVerificationFallbacks(),{status:'INVALID',checked:0});assert.equal(groupCalls,0);assert.equal((await f.store.snapshot()).telegramReplyJobs!.filter(j=>j.updateKey.startsWith('b3-webhook:forged-public:')&&j.status==='QUEUED').length,5);f.time(NOW);
  assert.equal((await dispatcher.drainVerificationFallbacks()).checked,1);assert.equal(groupCalls,1);const snapshot=await f.store.snapshot();assert.equal(snapshot.telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.status,'SENT');assert.equal(snapshot.telegramReplyJobs!.filter(j=>j.updateKey.startsWith('b3-webhook:forged-public:')&&j.status==='UNKNOWN_OUTCOME'&&j.plan===undefined).length,5);
 }finally{await f.close();}});
 test(engine+' group notice can be cleaned after member verifies and remains pending when group adapter is absent',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',subscription:f.gate,moderation:f.service,ephemeralVerification:true,clock:f.now,botId:'public-verify',botUsername:'ManaratakBot'});
  const view=await app.handle({update_id:312,message:{message_id:10,date:NOW/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});let deletes=0;const ephemeral=(async()=>Response.json({ok:false,error_code:400},{status:400})) as typeof fetch,privateRequest=(async()=>Response.json({ok:false,error_code:403},{status:403})) as typeof fetch;
  const request=(async(url:unknown)=>{if(String(url).endsWith('/deleteMessage')){deletes++;return Response.json({ok:true,result:true});}return Response.json({ok:true,result:{chat:{id:Number(CHAT)},from:{id:123456789,is_bot:true},message_id:90}});}) as typeof fetch;
  const sender=new TelegramBotApiTextSender(TOKEN,privateRequest),groupSender=new TelegramTemporaryGroupSender(TOKEN,request),dispatcher=new TelegramReplyDispatcher(f.store,f.policy,sender,f.now,async()=>true,f.gate,async()=> 'VERIFIED',new TelegramEphemeralTextSender(TOKEN,ephemeral,async()=>true),true,{sender:groupSender,botUsername:'ManaratakBot'});
  assert.equal((await dispatcher.dispatch(view.deliveryKey!)).status,'CONFIRMED');f.time(NOW+1000);f.membership.set('-200','300','MEMBER');const verified=await app.handle({update_id:313,message:{message_id:30,chat:{id:300,type:'private'},from:{id:300,is_bot:false},text:'/verify '+CHAT}});assert.equal(verified.reason,'SUBSCRIPTION_VERIFICATION_VIEW');
  const absent=new TelegramReplyDispatcher(f.store,f.policy,sender,f.now,async()=>true,f.gate,async()=> 'VERIFIED',undefined,true);assert.equal((await absent.cleanupVerificationFallbacks()).checked,0);assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===view.deliveryKey)!.verificationCleanup!.status,'WAITING');
  const reopened=new TelegramReplyDispatcher(f.store,f.policy,sender,f.now,async()=>true,f.gate,async()=> 'VERIFIED',undefined,true,{sender:groupSender,botUsername:'ManaratakBot'});assert.equal((await reopened.cleanupVerificationFallbacks()).acknowledged,1);assert.equal(deletes,1);
 }finally{await f.close();}});
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
 test(engine+' periodic cursor covers every target across missed time slots and restart',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>{for(let index=0;index<10;index++)s.moderationReasons.push({chatId:CHAT,memberId:String(300+index),source:'SUBSCRIPTION',reference:'subscription-gate',kind:'MUTE',createdBy:'SYSTEM_SUBSCRIPTION',active:true});});
  const visited:string[]=[];f.gate.synchronizeAutomatic=async(_chat,member)=>{visited.push(member);return {decision:{status:'UNAVAILABLE',channels:[]}};};
  assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,5);f.time(NOW+30000);
  const reopened=new SubscriptionGate(f.store,f.policy,f.membership,f.service,f.now);reopened.synchronizeAutomatic=async(_chat,member)=>{visited.push(member);return {decision:{status:'UNAVAILABLE',channels:[]}};};
  assert.equal((await reopened.tickAutomatic(true,async()=>true)).checked,5);assert.equal(new Set(visited).size,10);assert.equal(f.writes.length,0);
  await f.store.transaction(s=>{s.subscriptionSweepCursor={chatId:'invalid',memberId:'300'};});assert.equal((await reopened.tickAutomatic(true,async()=>true)).status,'INVALID');
 }finally{await f.close();}});
 test(engine+' leave grace is separately reviewed, can be cancelled and binds the current rule',async()=>{const f=await fixture();try{
  const pick=(view:OwnerInlineScreen|null,text:string)=>{assert.ok(view&&isValidTelegramInlineKeyboard(view.keyboard));const button=view.keyboard.inline_keyboard.flat().find(b=>b.text.includes(text));assert.ok(button,text);return button.callback_data;},tap=(data:string)=>renderSubscriptionConfig(f.store,f.policy,f.gate,'100',data,f.now);
  let root=await tap('sc:1:h'),edit=await tap(pick(root,CHAT)),review=await tap(pick(edit,'⏱ ساعة'));assert.match(review!.text,/ساعة/u);const stale=pick(review,'اعتماد المهلة');await tap(pick(review,'رجوع دون تغيير'));assert.equal(await tap(stale),null);assert.equal(subscriptionGracePolicy(await f.store.snapshot(),f.policy,CHAT,NOW)!.seconds,0);
  root=await tap('sc:1:h');edit=await tap(pick(root,CHAT));review=await tap(pick(edit,'⏱ ساعة'));const confirm=pick(review,'اعتماد المهلة');assert.ok(await tap(confirm));assert.equal(subscriptionGracePolicy(await f.store.snapshot(),f.policy,CHAT,NOW)!.seconds,3600);assert.equal(await tap(stale),null);
  await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version++;});assert.equal(subscriptionGracePolicy(await f.store.snapshot(),f.policy,CHAT,NOW),null);assert.equal(f.writes.length,0);
 }finally{await f.close();}});
 test(engine+' confirmed leaver gets grace, unknown never punishes and a fresh check after the deadline decides',async()=>{const f=await fixture();try{
  await f.consent();assert.equal(await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW)),true);
  f.membership.set('-200','300','MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).decision.status,'MEMBER');f.time(NOW+1000);f.membership.set('-200','300','NOT_MEMBER');
  const waiting=await f.gate.synchronizeAutomatic(CHAT,'300');assert.equal(waiting.effect?.status,'NO_CHANGE');assert.equal('reason' in waiting.effect!?waiting.effect.reason:'','SUBSCRIPTION_LEAVE_GRACE');assert.equal(f.writes.length,0);
  const reopened=new SubscriptionGate(f.store,f.policy,f.membership,f.service,f.now);f.time(NOW+3600000);assert.equal((await reopened.tickAutomatic(true,async()=>true)).checked,0);f.time(NOW+3601000);f.membership.set('-200','300','UNKNOWN');assert.equal((await reopened.tickAutomatic(true,async()=>true)).checked,1);assert.equal(f.writes.length,0);
  f.membership.set('-200','300','NOT_MEMBER');assert.equal((await reopened.tickAutomatic(true,async()=>true)).checked,0);f.time(NOW+5401000);assert.equal((await reopened.tickAutomatic(true,async()=>true)).checked,1);assert.equal(f.writes.length,1);assert.equal(f.target().status,'restricted');
 }finally{await f.close();}});
 test(engine+' first-time nonmember has no leave grace and rejoining clears a pending deadline',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect?.status,'APPLIED');
  f.time(NOW+1000);f.membership.set('-200','300','MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect?.status,'APPLIED');f.time(NOW+2000);f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect?.status,'NO_CHANGE');
  f.time(NOW+3000);f.membership.set('-200','300','MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');const record=(await f.store.snapshot()).subscriptionGraceMembers![0]!;assert.equal(record.missingSince,undefined);assert.equal(f.writes.length,2);
 }finally{await f.close();}});
 test(engine+' periodic monitoring detects a previously verified leaver without a new message',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');
  f.membership.set('-200','300','NOT_MEMBER');f.time(NOW+6*3600000-1);assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,0);f.time(NOW+6*3600000);
  assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,1);assert.equal(f.writes.length,0);assert.equal((await f.store.snapshot()).subscriptionGraceMembers![0]!.missingSince,NOW+6*3600000);
  f.time(NOW+7*3600000);assert.equal((await f.gate.tickAutomatic(true,async()=>true)).changed,1);assert.equal(f.target().status,'restricted');
 }finally{await f.close();}});
 test(engine+' monitoring checks group membership before channel membership and backs off on uncertainty',async()=>{
  for(const groupStatus of ['NOT_MEMBER','UNKNOWN'] as const){const f=await fixture();try{
   await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');f.time(NOW+6*3600000);f.membership.set(CHAT,'300',groupStatus);
   const queried:string[]=[],original=f.membership.getMember.bind(f.membership);f.membership.getMember=async(chat,member)=>{queried.push(chat);return original(chat,member);};
   assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,1);assert.deepEqual(queried,[CHAT]);assert.equal(f.writes.length,0);
   const records=(await f.store.snapshot()).subscriptionGraceMembers!;if(groupStatus==='NOT_MEMBER')assert.equal(records.length,0);else{assert.equal(records[0]!.nextCheckAt,NOW+6*3600000+1800000);assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,0);}
  }finally{await f.close();}}
 });
 test(engine+' changed policy during proactive group verification prevents channel reads and sanctions',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');f.time(NOW+6*3600000);
  const queried:string[]=[],original=f.membership.getMember.bind(f.membership);f.membership.getMember=async(chat,member)=>{queried.push(chat);if(chat===CHAT)await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version++;});return original(chat,member);};
  await f.gate.tickAutomatic(true,async()=>true);assert.deepEqual(queried,[CHAT]);assert.equal(f.writes.length,0);
 }finally{await f.close();}});
 test(engine+' slow group verification does not read the channel or reuse an expired proof',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');f.time(NOW+6*3600000);
  const verify=f.membership.canVerifyChannel.bind(f.membership),getMember=f.membership.getMember.bind(f.membership),queried:string[]=[];f.membership.canVerifyChannel=async(chat)=>{if(chat===CHAT)f.time(NOW+6*3600000+5000);return verify(chat);};f.membership.getMember=async(chat,member)=>{queried.push(chat);return getMember(chat,member);};
  assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,1);assert.deepEqual(queried,[]);assert.equal(f.writes.length,0);assert.equal((await f.gate.tickAutomatic(true,async()=>true)).checked,0);
 }finally{await f.close();}});
 test(engine+' grace policy changed during membership read invalidates the old decision',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','NOT_MEMBER');const getMember=f.membership.getMember.bind(f.membership);
  f.membership.getMember=async(channel,member)=>{f.time(NOW+1000);await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,86400,NOW+1000));return getMember(channel,member);};
  const result=await f.gate.synchronizeAutomatic(CHAT,'300');assert.equal(result.effect?.status,'DENIED');assert.equal(f.writes.length,0);assert.equal((await f.store.snapshot()).subscriptionGraceMembers?.length??0,0);
 }finally{await f.close();}});
 test(engine+' newer membership evidence during the rights check prevents an old grace-expiry restriction',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');
  f.time(NOW+1000);f.membership.set('-200','300','NOT_MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');f.time(NOW+3601000);
  f.hook(async()=>{await f.store.transaction(s=>{const row=s.subscriptionGraceMembers![0]!;row.verifiedAt=NOW+3601000;delete row.missingSince;});});
  const result=await f.gate.synchronizeAutomatic(CHAT,'300');assert.notEqual(result.effect?.status,'APPLIED');assert.equal(f.writes.length,0);assert.equal(f.target().status,'member');
 }finally{await f.close();}});
 test(engine+' STOP prevents pending grace checks and the private message explains the grace',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');
  f.time(NOW+1000);f.membership.set('-200','300','NOT_MEMBER');const update=await f.app.handle({update_id:810,message:{message_id:10,date:(NOW+1000)/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false},text:'hello'}});assert.match(update.plan!.text,/مهلة السماح/u);assert.equal(f.writes.length,0);
  f.time(NOW+3601000);assert.equal((await f.gate.tickAutomatic(true,async()=>false)).status,'STOPPED');assert.equal(f.writes.length,0);
 }finally{await f.close();}});
 test(engine+' stale grace policy cannot stop an explicitly disabled rule from releasing its owned restriction',async()=>{const f=await fixture();try{
  await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect?.status,'APPLIED');
  f.time(NOW+1000);await f.gate.configure('100',CHAT,[],'ALL');await f.store.transaction(s=>recordSubscriptionEnforcementConsent(s,f.policy,'100',CHAT,false,NOW+1000));assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect?.status,'APPLIED');assert.equal(f.target().status,'member');
 }finally{await f.close();}});
 test(engine+' clock rollback and a full grace index cannot produce a new restriction',async()=>{
  for(const variant of ['clock','capacity'] as const){const f=await fixture();try{
   await f.consent();await f.store.transaction(s=>recordSubscriptionGracePolicy(s,f.policy,'100',CHAT,3600,NOW));
   if(variant==='clock'){f.time(NOW+1000);f.membership.set('-200','300','MEMBER');await f.gate.synchronizeAutomatic(CHAT,'300');f.time(NOW);}
   else await f.store.transaction(s=>{s.subscriptionGraceMembers=Array.from({length:1000},(_,index)=>({chatId:CHAT,memberId:String(index+1000),stamp:'a'.repeat(64),verifiedAt:NOW}));});
   f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect?.status,'DENIED');assert.equal(f.writes.length,0);
   if(variant==='clock')assert.equal((await f.store.snapshot()).subscriptionGraceMembers![0]!.verifiedAt,NOW+1000);
  }finally{await f.close();}}
 });
 test(engine+' duplicate subscription reasons cannot authorize a restriction or release, even when introduced during a rights read',async()=>{
  for(const change of ['duplicate-active','duplicate-inactive','during-read'] as const){const f=await fixture();try{
   await f.consent();f.membership.set('-200','300','NOT_MEMBER');assert.equal((await f.gate.synchronizeAutomatic(CHAT,'300')).effect!.status,'APPLIED');f.time(NOW+1000);f.membership.set('-200','300','MEMBER');
   const duplicate=async()=>{await f.store.transaction(s=>{const original=s.moderationReasons.find(r=>r.source==='SUBSCRIPTION')!;s.moderationReasons.push({...original,active:change!=='duplicate-inactive'});});};
   if(change==='during-read')f.hook(duplicate);else await duplicate();const before=f.writes.length;const result=await f.gate.synchronizeAutomatic(CHAT,'300');assert.notEqual(result.effect!.status,'APPLIED');assert.equal(f.writes.length,before);assert.equal(f.target().status,'restricted');
   const state=await f.store.snapshot();assert.equal(state.moderationReasons.filter(r=>r.source==='SUBSCRIPTION').length,2);assert.equal(state.moderationReasons[0]!.active,true);
  }finally{await f.close();}}
 });
 test(engine+' duplicate inactive subscription reasons cannot create a new mute',async()=>{const f=await fixture();try{
  await f.consent();f.membership.set('-200','300','NOT_MEMBER');await f.store.transaction(s=>{const reason={chatId:CHAT,memberId:'300',source:'SUBSCRIPTION' as const,reference:'subscription-gate',kind:'MUTE' as const,createdBy:'SYSTEM_SUBSCRIPTION',active:false};s.moderationReasons.push({...reason},{...reason});});
  const result=await f.gate.synchronizeAutomatic(CHAT,'300');assert.equal(result.effect?.status,'DENIED');assert.equal(f.writes.length,0);assert.equal((await f.store.snapshot()).moderationReasons.every(r=>!r.active),true);
 }finally{await f.close();}});
 test(engine+' consent is invalid after rule, approval or private-setting revision changes and future receipts cannot authorize',async()=>{
  const f=await fixture();try{await f.consent();assert.ok(subscriptionEnforcementConsent(await f.store.snapshot(),f.policy,CHAT,NOW));assert.equal(subscriptionEnforcementConsent(await f.store.snapshot(),f.policy,CHAT,NOW-1),null);await f.store.transaction(s=>{s.subscriptionRequirements[0]!.version++;});assert.equal(subscriptionEnforcementConsent(await f.store.snapshot(),f.policy,CHAT,NOW),null);}finally{await f.close();}
 });
}
