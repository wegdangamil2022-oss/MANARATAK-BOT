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
import {validCommunityConfig,validCommunityState,defaultCommunityConfig} from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen} from '../src/phase4-community-ui.js';

const CHAT='-10087654321',OWNER='100',MEMBER='301',OTHER='302';
const deeplink='/start welcome_'+CHAT.slice(1);
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-private-join-')),file=join(dir,engine==='json'?'store.json':'store.sqlite');
 let now=Date.parse('2026-11-05T15:00:00.000Z');
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,CHAT,['navigation']);await policy.setPresence(CHAT,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const education=new EducationService(store,policy,clock);
 let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 const membershipPort=async()=>membership;
 const app=()=>new TelegramUpdateApplication({store,policy,community,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'bot-main',botUsername:'ManaratakEduBot',membership:membershipPort,clock});
 const approve=async(request:Parameters<typeof community.pending>[1])=>
  community.approve(OWNER,(await community.pending(OWNER,request,CHAT)).id);
 const memberJoin=(id:number,actor=Number(MEMBER))=>({update_id:id,message:{
  message_id:id,chat:{id:Number(CHAT),type:'supergroup',title:'منارتك'},
  from:{id:actor,is_bot:false,first_name:'طالب <&>'},
  new_chat_members:[{id:actor,is_bot:false,first_name:'طالب <&>'}]
 }});
 const privateMessage=(id:number,text:string,actor=Number(MEMBER))=>({update_id:id,message:{
  message_id:id,chat:{id:actor,type:'private'},
  from:{id:actor,is_bot:false,first_name:'طالب <&>'},text}});
 return {dir,file,store,policy,community,clock,app,approve,memberJoin,privateMessage,
  move:(ms:number)=>{now+=ms;},setMembership:(v:typeof membership)=>{membership=v;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('P4 WELCOME-002 owner opt-in, private deep link and persisted state validator',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/privatewelcomeon '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'PRIVATE_WELCOME_ON'}});
 assert.deepEqual(parsePhase4CommunityCommand('/privatewelcomeoff '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'PRIVATE_WELCOME_OFF'}});
 assert.equal(parsePhase4CommunityCommand('/privatewelcomeon 301'),null);
 assert.equal(parsePhase4CommunityCommand('/privatewelcomeon '+CHAT+' 301'),null);
 assert.equal(validCommunityConfig(defaultCommunityConfig(CHAT)),true);
 assert.equal(validCommunityConfig({...defaultCommunityConfig(CHAT),privateWelcomeEnabled:true}),true);
 assert.equal(validCommunityConfig({...defaultCommunityConfig(CHAT),privateWelcomeEnabled:'yes'}),false);
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[],privateWelcomes:[{
  joinKey:'a'.repeat(64),chatId:CHAT,actorDigest:'b'.repeat(64),at:1_000_000
 }]}),true);
 for(const invalid of [{joinKey:'not-hash',chatId:CHAT,actorDigest:'b'.repeat(64),at:1_000_000},
  {joinKey:'a'.repeat(64),chatId:CHAT,actorDigest:'b'.repeat(64),at:1_000_000,studentId:'301'}]){
  assert.equal(validCommunityState({configs:[],drafts:[],receipts:[],privateWelcomes:[invalid]}),false);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('P4 WELCOME-002 '+engine+': private opt-in requires owner review and is disabled by default',async()=>{
  const f=await fixture(engine);
  try{
   await assert.rejects(f.community.pending(MEMBER,{kind:'PRIVATE_WELCOME_ON'},CHAT),/COMMUNITY_OWNER_DENIED/);
   const draft=await f.community.pending(OWNER,{kind:'PRIVATE_WELCOME_ON'},CHAT);
   assert.equal((await f.community.view(OWNER,CHAT)).privateWelcomeEnabled,undefined);
   assert.match(f.community.preview(draft),/خاص|خصوصية/u);
   await f.community.approve(OWNER,draft.id);
   assert.equal((await f.community.view(OWNER,CHAT)).privateWelcomeEnabled,true);
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.configs[0]?.privateWelcomeEnabled,true);
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:g:'+CHAT);
   assert.ok(screen?.keyboard.inline_keyboard.flat().some(b=>b.text.includes('خاص')));
   await assert.rejects(phase4CommunityScreen(f.community,MEMBER,'p4c:1:g:'+CHAT),/COMMUNITY_OWNER_DENIED/);
   await f.approve({kind:'PRIVATE_WELCOME_OFF'});
   assert.equal((await f.community.view(OWNER,CHAT)).privateWelcomeEnabled,false);
  }finally{await f.close();}
 });
 test('P4 WELCOME-002 '+engine+': trusted join offers Telegram deep link and only newly joined user opts in',async()=>{
  const f=await fixture(engine);
  try{
   const off=await f.app().handle(f.privateMessage(10,deeplink));
   assert.equal(off.plan,undefined);
   await f.approve({kind:'WELCOME_ON'});
   await f.approve({kind:'PRIVATE_WELCOME_ON'});
   const joined=await f.app().handle(f.memberJoin(11));
   assert.equal(joined.status,'APPLIED');
   assert.match(joined.plan?.text??'',new RegExp('start=welcome_'+CHAT.slice(1)));
   assert.equal((await f.app().handle(f.privateMessage(12,deeplink,Number(OTHER)))).plan,undefined);
   const personalized=await f.app().handle(f.privateMessage(13,deeplink));
   assert.equal(personalized.status,'APPLIED');
   assert.equal(personalized.plan?.chatId,MEMBER);
   assert.match(personalized.plan?.text??'',/طالب &lt;&amp;&gt;/u);
   assert.equal((await f.store.snapshot()).phase4Community?.privateWelcomes?.length,1);
   assert.ok((await f.store.snapshot()).telegramReplyJobs?.some(j=>
    j.updateKey===personalized.deliveryKey&&j.privateReplyKind==='GROUP_SCOPED'));
   const saved=JSON.stringify((await f.store.snapshot()).phase4Community?.privateWelcomes);
   assert.equal(saved.includes('301'),false);assert.equal(saved.includes('طالب'),false);
   assert.equal((await f.app().handle(f.privateMessage(14,deeplink))).plan,undefined);
   let attempts=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,
    {send:async()=>{attempts++;return {status:'CONFIRMED' as const,messageId:923};}},f.clock,undefined,
    undefined,async()=> 'VERIFIED');
   assert.equal((await dispatcher.dispatch(personalized.deliveryKey!)).status,'CONFIRMED');
   assert.equal(attempts,1);
  }finally{await f.close();}
 });
 test('P4 WELCOME-002 '+engine+': membership absent, stale joins and revoked groups fail closed',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'WELCOME_ON'});
   await f.approve({kind:'PRIVATE_WELCOME_ON'});
   await f.app().handle(f.memberJoin(21));
   f.setMembership('NOT_MEMBER');
   assert.equal((await f.app().handle(f.privateMessage(22,deeplink))).plan,undefined);
   f.setMembership('UNKNOWN');
   assert.equal((await f.app().handle(f.privateMessage(23,deeplink))).plan,undefined);
   f.setMembership('VERIFIED');
   f.move(900_001);
   assert.equal((await f.app().handle(f.privateMessage(24,deeplink))).plan,undefined);
   f.move(1);
   await f.app().handle(f.memberJoin(25));
   await f.policy.revokeChat(OWNER,CHAT);
   assert.equal((await f.app().handle(f.privateMessage(26,deeplink))).plan,undefined);
   assert.equal((await f.store.snapshot()).phase4Community?.privateWelcomes?.length??0,0);
  }finally{await f.close();}
 });
 test('P4 WELCOME-002 '+engine+': disabling after private welcome queued prevents Telegram dispatch',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'WELCOME_ON'});await f.approve({kind:'PRIVATE_WELCOME_ON'});
   await f.app().handle(f.memberJoin(31));
   const response=await f.app().handle(f.privateMessage(32,deeplink));
   assert.ok(response.deliveryKey);
   await f.approve({kind:'PRIVATE_WELCOME_OFF'});
   let attempts=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{
    send:async()=>{attempts++;return {status:'CONFIRMED' as const,messageId:33};}
   },f.clock,undefined,undefined,async()=> 'VERIFIED');
   assert.equal((await dispatcher.dispatch(response.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(attempts,0);
  }finally{await f.close();}
 });
 test('P4 WELCOME-002 '+engine+': private offer is optional, group welcome remains usable if private DM unavailable',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'WELCOME_ON'});
   const joined=await f.app().handle(f.memberJoin(41));
   assert.equal(joined.status,'APPLIED');
   assert.ok(joined.plan?.text);
   assert.doesNotMatch(joined.plan.text,/start=welcome_/u);
   assert.equal((await f.app().handle(f.privateMessage(42,deeplink))).plan,undefined);
   await f.approve({kind:'PRIVATE_WELCOME_ON'});
   f.move(9000);
   const joinedAgain=await f.app().handle(f.memberJoin(43,399));
   assert.match(joinedAgain.plan?.text??'',/start=welcome_/u);
   f.setMembership('NOT_MEMBER');
   assert.equal((await f.app().handle(f.privateMessage(44,deeplink,399))).plan,undefined);
   assert.equal((await f.store.snapshot()).phase4Community?.privateWelcomes?.length??0,0);
  }finally{await f.close();}
 });
}
