import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {defaultCommunityConfig,validCommunityConfig,validCommunityState,selectCommunityGreeting}
 from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen,validPhase4CommunityRoute}
 from '../src/phase4-community-ui.js';

const CHAT='-100111222333',OWNER='100',MEMBER='301',ADMIN='900';
const setup=async(engine:'json'|'sqlite')=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-farewell-kind-'));
 const file=join(dir,engine==='json'?'bot.json':'bot.sqlite');
 let now=Date.parse('2026-11-05T14:00:00.000Z');
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,CHAT,['navigation']);await policy.setPresence(CHAT,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const education=new EducationService(store,policy);
 const app=new TelegramUpdateApplication({store,policy,community,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'bot-main',botUsername:'ManaratakEduBot',membership:async()=> 'VERIFIED',clock});
 const approve=async(request:Parameters<typeof community.pending>[1])=>{
  const d=await community.pending(OWNER,request,CHAT);
  return community.approve(OWNER,d.id);
 };
 const serviceLeave=(id:number,performer=Number(MEMBER),subject=Number(MEMBER))=>({
  update_id:id,message:{message_id:id,chat:{id:Number(CHAT),type:'supergroup',title:'منارتك <&>'},
   from:{id:performer,is_bot:false,first_name:'مشرف'},
   left_chat_member:{id:subject,is_bot:false,first_name:'عضو <&>'}
  }
 });
 const membershipLeave=(id:number,oldStatus:string,newStatus:string,
  performer=Number(MEMBER),subject=Number(MEMBER),oldMember?:boolean,newMember?:boolean)=>({
  update_id:id,chat_member:{chat:{id:Number(CHAT),type:'supergroup',title:'منارتك <&>'},
   from:{id:performer,is_bot:false},date:Math.floor(now/1000),
   old_chat_member:{status:oldStatus,user:{id:subject,is_bot:false},
    ...(oldMember!==undefined?{is_member:oldMember}:{})},
   new_chat_member:{status:newStatus,user:{id:subject,is_bot:false,first_name:'عضو <&>'},
    ...(newMember!==undefined?{is_member:newMember}:{})}
  }
 });
 return {store,file,dir,clock,policy,community,app,approve,serviceLeave,membershipLeave,
  move:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
};
test('P4 WELCOME-003: exact commands and owner-only farewell menu routes',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/farewellvariant '+CHAT+' SELF بالتوفيق {العضو}'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'FAREWELL_VARIANT_SET',leaveKind:'SELF',text:'بالتوفيق {العضو}'}});
 assert.deepEqual(parsePhase4CommunityCommand('/clearfarewellvariant '+CHAT+' REMOVED'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'FAREWELL_VARIANT_CLEAR',leaveKind:'REMOVED'}});
 assert.deepEqual(parsePhase4CommunityCommand('/farewellremovedon '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'FAREWELL_REMOVED_ON'}});
 assert.deepEqual(parsePhase4CommunityCommand('/farewellremovedoff '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'FAREWELL_REMOVED_OFF'}});
 for(const bad of ['/farewellvariant '+CHAT+' SELF','/farewellvariant '+CHAT+' UNKNOWN نص',
  '/clearfarewellvariant '+CHAT+' AUTO','/farewellremovedon '+CHAT+' true',
  '/farewellvariant 301 SELF hello'])assert.equal(parsePhase4CommunityCommand(bad),null,bad);
 assert.equal(validPhase4CommunityRoute('p4c:1:m:'+CHAT),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:m:'+CHAT+':s'),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:m:'+CHAT+':r'),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:m:'+CHAT+':x'),false);
});
test('P4 WELCOME-003: farewell settings stay optional and validated; fallback to old template',()=>{
 const config=defaultCommunityConfig(CHAT);
 assert.equal(config.farewell.enabled,false);
 assert.equal(config.farewellOnRemoval,undefined);
 assert.equal(validCommunityConfig(config),true);
 assert.equal(selectCommunityGreeting(config,'farewell',undefined,'SELF'),config.farewell.text);
 assert.equal(selectCommunityGreeting(config,'farewell',undefined,'REMOVED'),config.farewell.text);
 const extended={...config,farewellOnRemoval:true,
  farewellByLeave:{SELF:'وداعًا {العضو}',REMOVED:'مع السلامة {العضو}'}};
 assert.equal(validCommunityConfig(extended),true);
 assert.equal(selectCommunityGreeting(extended,'farewell',undefined,'SELF'),'وداعًا {العضو}');
 assert.equal(selectCommunityGreeting(extended,'farewell',undefined,'REMOVED'),'مع السلامة {العضو}');
 for(const wrong of [{REMOVED:'x {secret}'},{SELF:''},{OTHER:'good'},
   {REMOVED:'a'.repeat(801)},['invalid']]){
  assert.equal(validCommunityConfig({...config,farewellByLeave:wrong}),false);
 }
 assert.equal(validCommunityConfig({...config,farewellOnRemoval:'on'}),false);
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[{
  key:'a'.repeat(64),chatId:CHAT,at:1000,kind:'LEAVE',
  actorDigest:'b'.repeat(64),leaveKind:'SELF'
 }]}),true);
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[{
  key:'a'.repeat(64),chatId:CHAT,at:1000,kind:'LEAVE',
  actorDigest:'b'.repeat(64),leaveKind:'UNKNOWN'
 }]}),false);
});
for(const engine of ['json','sqlite'] as const){
 test('P4 WELCOME-003 '+engine+': reviewed farewell variants are persisted and revocable',async()=>{
  const f=await setup(engine);
  try{
   await assert.rejects(f.community.pending(MEMBER,
    {kind:'FAREWELL_VARIANT_SET',leaveKind:'SELF',text:'غير مخول'},CHAT),
    /COMMUNITY_OWNER_DENIED/);
   await assert.rejects(f.community.pending(OWNER,
    {kind:'FAREWELL_VARIANT_SET',leaveKind:'UNKNOWN' as never,text:'bad'},CHAT),
    /COMMUNITY_LEAVE_KIND_INVALID/);
   const draft=await f.community.pending(OWNER,
    {kind:'FAREWELL_VARIANT_SET',leaveKind:'SELF',text:'وداعًا {العضو}'},CHAT);
   assert.equal((await f.community.view(OWNER,CHAT)).farewellByLeave,undefined);
   assert.match(f.community.preview(draft),/SELF/);
   await f.community.approve(OWNER,draft.id);
   assert.equal((await f.community.view(OWNER,CHAT)).farewellByLeave?.SELF,'وداعًا {العضو}');
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.configs[0]?.farewellByLeave?.SELF,'وداعًا {العضو}');
   await f.approve({kind:'FAREWELL_VARIANT_SET',leaveKind:'REMOVED',text:'إزالة {العضو}'});
   const stale=await f.community.pending(OWNER,
    {kind:'FAREWELL_VARIANT_CLEAR',leaveKind:'SELF'},CHAT);
   await f.approve({kind:'FAREWELL_REMOVED_ON'});
   await assert.rejects(f.community.approve(OWNER,stale.id),/COMMUNITY_DRAFT_NOT_FOUND|COMMUNITY_DRAFT_STALE/);
   assert.equal((await f.community.view(OWNER,CHAT)).farewellOnRemoval,true);
   await f.approve({kind:'FAREWELL_VARIANT_CLEAR',leaveKind:'SELF'});
   assert.equal((await f.community.view(OWNER,CHAT)).farewellByLeave?.SELF,undefined);
   await f.approve({kind:'FAREWELL_REMOVED_OFF'});
   assert.equal((await f.community.view(OWNER,CHAT)).farewellOnRemoval,false);
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:m:'+CHAT);
   assert.match(screen?.text??'',/REMOVED/);
   assert.ok(screen?.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='p4c:1:m:'+CHAT+':r'));
   const groupScreen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:g:'+CHAT);
   assert.ok(groupScreen?.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='p4c:1:m:'+CHAT));
   await assert.rejects(phase4CommunityScreen(f.community,MEMBER,'p4c:1:m:'+CHAT),/COMMUNITY_OWNER_DENIED/);
  }finally{await f.close();}
 });
 test('P4 WELCOME-003 '+engine+': service leave distinguishes self from removal without exposing removals by default',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'FAREWELL_VARIANT_SET',leaveKind:'SELF',text:'وداع ذاتي: {العضو}'});
   await f.approve({kind:'FAREWELL_VARIANT_SET',leaveKind:'REMOVED',text:'وداع إداري: {العضو}'});
   await f.approve({kind:'FAREWELL_ON'});
   const self=await f.app.handle(f.serviceLeave(100));
   assert.equal(self.plan?.text,'وداع ذاتي: عضو &lt;&amp;&gt;');
   f.move(9000);
   const removed=await f.app.handle(f.serviceLeave(101,Number(ADMIN),402));
   assert.equal(removed.plan,undefined);
   assert.equal((await f.store.snapshot()).phase4Community?.receipts.length,1);
   await f.approve({kind:'FAREWELL_REMOVED_ON'});
   const optIn=await f.app.handle(f.serviceLeave(102,Number(ADMIN),403));
   assert.equal(optIn.plan?.text,'وداع إداري: عضو &lt;&amp;&gt;');
   const encoded=JSON.stringify((await f.store.snapshot()).phase4Community?.receipts);
   assert.equal(encoded.includes('عضو'),false);
   assert.equal(encoded.includes('"actorId"'),false);
  }finally{await f.close();}
 });
 test('P4 WELCOME-003 '+engine+': chat_member departures require present-to-absent transition only',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'FAREWELL_ON'});
   const left=await f.app.handle(f.membershipLeave(200,'member','left'));
   assert.equal(left.status,'APPLIED');assert.ok(left.deliveryKey);
   f.move(9000);
   const promoted=await f.app.handle(f.membershipLeave(201,'member','administrator'));
   assert.equal(promoted.plan,undefined);
   const stillRestricted=await f.app.handle(f.membershipLeave(202,'restricted','restricted',Number(MEMBER),303,true,true));
   assert.equal(stillRestricted.plan,undefined);
   const oldAbsent=await f.app.handle(f.membershipLeave(203,'left','kicked',Number(ADMIN),304));
   assert.equal(oldAbsent.plan,undefined);
   const removed=await f.app.handle(f.membershipLeave(204,'member','kicked',Number(ADMIN),305));
   assert.equal(removed.plan,undefined);
   await f.approve({kind:'FAREWELL_REMOVED_ON'});
   const force=await f.app.handle(f.membershipLeave(205,'restricted','restricted',Number(ADMIN),306,true,false));
   assert.match(force.plan?.text??'',/التوفيق/);
   const mismatch=f.membershipLeave(206,'member','left',Number(ADMIN),307);
   mismatch.chat_member.new_chat_member.user.id=308;
   assert.equal((await f.app.handle(mismatch)).plan,undefined);
  }finally{await f.close();}
 });
 test('P4 WELCOME-003 '+engine+': same departure cannot cause duplicate send via service and membership notifications',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'FAREWELL_ON'});
   assert.ok((await f.app.handle(f.membershipLeave(300,'member','left'))).deliveryKey);
   f.move(9000);
   assert.equal((await f.app.handle(f.serviceLeave(301))).plan,undefined);
   assert.equal((await f.store.snapshot()).phase4Community?.receipts.length,1);
   f.move(900001);
   const late=f.membershipLeave(302,'member','left',Number(MEMBER),Number(MEMBER));
   late.chat_member.date=Math.floor((f.clock()-1000_000)/1000);
   assert.equal((await f.app.handle(late)).plan,undefined);
   const events=(await f.store.snapshot()).phase4Community?.receipts;
   assert.equal(events?.length,1);
  }finally{await f.close();}
 });
 test('P4 WELCOME-003 '+engine+': changing farewell policy fences queued Telegram dispatch',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'FAREWELL_ON'});
   await f.approve({kind:'FAREWELL_REMOVED_ON'});
   const output=await f.app.handle(f.membershipLeave(400,'member','kicked',Number(ADMIN),Number(MEMBER)));
   assert.ok(output.deliveryKey);
   await f.approve({kind:'FAREWELL_REMOVED_OFF'});
   let called=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{
    send:async()=>{called++;return {status:'CONFIRMED' as const,messageId:72};}
   },f.clock);
   assert.equal((await dispatcher.dispatch(output.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(called,0);
  }finally{await f.close();}
 });
}


test('P4 WELCOME-003: per-event service cleanup switches remain backward-compatible and strictly typed',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/servicejoinoff '+CHAT),{
  kind:'EDIT',chatId:CHAT,request:{kind:'SERVICE_JOIN_OFF'}});
 assert.deepEqual(parsePhase4CommunityCommand('/servicejoinon '+CHAT),{
  kind:'EDIT',chatId:CHAT,request:{kind:'SERVICE_JOIN_ON'}});
 assert.deepEqual(parsePhase4CommunityCommand('/serviceleaveoff '+CHAT),{
  kind:'EDIT',chatId:CHAT,request:{kind:'SERVICE_LEAVE_OFF'}});
 assert.deepEqual(parsePhase4CommunityCommand('/serviceleaveon '+CHAT),{
  kind:'EDIT',chatId:CHAT,request:{kind:'SERVICE_LEAVE_ON'}});
 assert.equal(parsePhase4CommunityCommand('/serviceleaveoff 301'),null);
 assert.equal(validPhase4CommunityRoute('p4c:1:s:'+CHAT),true);
 const base=defaultCommunityConfig(CHAT);
 assert.equal(validCommunityConfig(base),true);
 assert.equal(validCommunityConfig({...base,serviceCleanup:{enabled:true,delayMs:120000}}),true);
 assert.equal(validCommunityConfig({...base,serviceCleanup:{
  enabled:true,delayMs:120000,joinEnabled:false,leaveEnabled:true}}),true);
 assert.equal(validCommunityConfig({...base,serviceCleanup:{
  enabled:true,delayMs:120000,leaveEnabled:'false'}}),false);
});
for(const engine of ['json','sqlite'] as const){
 test('P4 WELCOME-003 '+engine+': service-join and service-leave cleanup can be disabled independently',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'SERVICE_CLEANUP_ON'});
   const base=await f.community.view(OWNER,CHAT);
   assert.equal(base.serviceCleanup?.enabled,true);
   assert.equal(await f.community.recordServiceEvent({chatId:CHAT,actorId:MEMBER,
    kind:'JOIN',messageId:600,updateKey:'b3-webhook:bot-main:600',sentAtMs:f.clock()}),true);
   assert.equal(await f.community.recordServiceEvent({chatId:CHAT,actorId:MEMBER,
    kind:'LEAVE',messageId:601,updateKey:'b3-webhook:bot-main:601',sentAtMs:f.clock()}),true);
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length,2);
   const draft=await f.community.pending(OWNER,{kind:'SERVICE_JOIN_OFF'},CHAT);
   assert.equal((await f.community.view(OWNER,CHAT)).serviceCleanup?.joinEnabled,undefined);
   await f.community.approve(OWNER,draft.id);
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.configs[0]?.serviceCleanup?.joinEnabled,false);
   assert.equal(await f.community.recordServiceEvent({chatId:CHAT,actorId:MEMBER,
    kind:'JOIN',messageId:602,updateKey:'b3-webhook:bot-main:602',sentAtMs:f.clock()}),false);
   assert.equal(await f.community.recordServiceEvent({chatId:CHAT,actorId:MEMBER,
    kind:'LEAVE',messageId:603,updateKey:'b3-webhook:bot-main:603',sentAtMs:f.clock()}),true);
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length,3);
   await f.approve({kind:'SERVICE_LEAVE_OFF'});
   assert.equal(await f.community.recordServiceEvent({chatId:CHAT,actorId:MEMBER,
    kind:'LEAVE',messageId:604,updateKey:'b3-webhook:bot-main:604',sentAtMs:f.clock()}),false);
   await f.approve({kind:'SERVICE_JOIN_ON'});
   assert.equal(await f.community.recordServiceEvent({chatId:CHAT,actorId:MEMBER,
    kind:'JOIN',messageId:605,updateKey:'b3-webhook:bot-main:605',sentAtMs:f.clock()}),true);
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:s:'+CHAT);
   assert.match(screen?.text??'',/الدخول|المغادرة/);
   assert.ok(screen?.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='p4c:1:t:'+CHAT+':s:0'));
   await assert.rejects(f.community.pending(MEMBER,{kind:'SERVICE_LEAVE_ON'},CHAT),
    /COMMUNITY_OWNER_DENIED/);
  }finally{await f.close();}
 });
}
