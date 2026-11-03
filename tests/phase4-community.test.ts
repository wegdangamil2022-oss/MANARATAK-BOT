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
import {validCommunityState,normalizeCommunityMatch,matchCommunityRule,renderCommunityTemplate,
 defaultCommunityConfig} from '../src/phase4-community-model.js';
import {phase4CommunityScreen,parsePhase4CommunityCommand,validPhase4CommunityRoute} from '../src/phase4-community-ui.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';

const GROUP='-1001234',OWNER='100',MEMBER='300';
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-p4-community-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 let now=1_000_000;
 const clock=()=>now,store=new BotStore(file,{engine});
 const policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 const community=new Phase4CommunityService(store,policy,clock);
 const education=new EducationService(store,policy,clock);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',
  community,clock});
 return {dir,file,store,policy,community,app,
  setNow:(v:number)=>{now=v;}, now:clock,close:()=>rm(dir,{force:true,recursive:true})};
}
const groupMessage=(id:number,text:string,actor=300,thread?:number)=>({
 update_id:id,message:{message_id:id,chat:{id:Number(GROUP),type:'supergroup',title:'منارتك <المنح>'},
  from:{id:actor,is_bot:false,first_name:'محمد & علي'},text,
  ...(thread?{message_thread_id:thread}:{})}
});
const joinMessage=(id:number,kind:'JOIN'|'LEAVE',who=MEMBER)=>({
 update_id:id,message:{message_id:id,chat:{id:Number(GROUP),type:'supergroup',title:'منارتك <المنح>'},
  from:{id:Number(who),is_bot:false,first_name:'الضيف'},
  ...(kind==='JOIN'?{new_chat_members:[{id:Number(who),is_bot:false,first_name:'فاطمة <&>'}]}:
   {left_chat_member:{id:Number(who),is_bot:false,first_name:'فاطمة <&>'}})}
});
const ownerMessage=(id:number,text:string)=>({
 update_id:id,message:{message_id:id,chat:{id:Number(OWNER),type:'private'},
  from:{id:Number(OWNER),is_bot:false,first_name:'المالك'},text}
});
const ownerCallback=(id:number,data:string)=>({
 update_id:id,callback_query:{id:'Q'+id,data,from:{id:Number(OWNER),is_bot:false},
  message:{message_id:50,chat:{id:Number(OWNER),type:'private'},
   from:{id:900,is_bot:true}}}
});
const enable=async(f:Awaited<ReturnType<typeof fixture>>,kind:'WELCOME'|'FAREWELL'|'REPLIES')=>{
 const draft=await f.community.pending(OWNER,{kind:kind+'_ON'},GROUP);
 return f.community.approve(OWNER,draft.id);
};

test('P4 templates normalize Arabic, obey word boundaries, escape substitution, never evaluate expressions',()=>{
 assert.equal(normalizeCommunityMatch('  مَــنـحة  '),'منحة');
 const config=defaultCommunityConfig(GROUP);
 assert.equal(config.welcome.enabled,false);assert.equal(config.repliesEnabled,false);
 const rule={id:'123456789abc',trigger:'منحة',response:'أهلًا',match:'WORD' as const,
  enabled:true,cooldownMs:60000};
 assert.equal(matchCommunityRule(rule,'متى تفتح المنحة؟'),false);
 assert.equal(matchCommunityRule(rule,'منحة جامعية'),true);
 assert.equal(matchCommunityRule(rule,'منحتي'),false);
 assert.equal(renderCommunityTemplate('مرحبًا {العضو} في {اسم_المجموعة}',{
  kind:'JOIN',chatId:GROUP,actorId:MEMBER,memberName:'فاطمة <&>',groupName:'منارتك <المنح>'
 },1_000_000),'مرحبًا فاطمة &lt;&amp;&gt; في منارتك &lt;المنح&gt;');
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[]}),true);
});

for(const engine of ['json','sqlite'] as const){
 test('P4 '+engine+': owner-reviewed greeting settings persist and stale confirmation cannot overwrite revisions',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.community.pending(MEMBER,{kind:'WELCOME_ON'},GROUP),/COMMUNITY_OWNER_DENIED/);
   const initial=await f.community.view(OWNER,GROUP);assert.equal(initial.welcome.enabled,false);
   const first=await f.community.pending(OWNER,{kind:'WELCOME_TEXT',text:'أهلًا {العضو} في {اسم_المجموعة}'},GROUP);
   assert.equal((await f.community.view(OWNER,GROUP)).welcome.text,initial.welcome.text);
   const second=await f.community.pending(OWNER,{kind:'WELCOME_ON'},GROUP);
   await assert.rejects(f.community.approve(OWNER,first.id),/COMMUNITY_DRAFT_NOT_FOUND/);
   const updated=await f.community.approve(OWNER,second.id);
   assert.equal(updated.welcome.enabled,true);
   assert.equal((await new Phase4CommunityService(new BotStore(f.file,{engine}),f.policy,f.now).view(OWNER,GROUP)).welcome.enabled,true);
   await assert.rejects(f.community.approve(OWNER,second.id),/COMMUNITY_DRAFT_NOT_FOUND/);
   const future=await f.community.pending(OWNER,{kind:'FAREWELL_ON'},GROUP);
   f.setNow(f.now()+120000);
   await assert.rejects(f.community.approve(OWNER,future.id),/COMMUNITY_DRAFT_EXPIRED/);
  }finally{await f.close();}
 });
 test('P4 '+engine+': limits prevent floods and repeated join/reply but do not store raw messages or names',async()=>{
  const f=await fixture(engine);try{
   await enable(f,'WELCOME');
   const base={kind:'JOIN' as const,chatId:GROUP,actorId:MEMBER,memberName:'فاطمة',groupName:'منارتك'};
   const one=await f.community.propose(base,'b3-webhook:bot-main:1');
   assert.match(one?.text??'',/فاطمة/);
   assert.equal(await f.community.propose(base,'b3-webhook:bot-main:1'),null);
   assert.equal(await f.community.propose(base,'b3-webhook:bot-main:2'),null);
   f.setNow(f.now()+600001);
   assert.ok(await f.community.propose(base,'b3-webhook:bot-main:3'));
   const state=await f.store.snapshot(),encoded=JSON.stringify(state.phase4Community?.receipts);
   assert.equal(encoded.includes('فاطمة'),false);
   assert.equal(encoded.includes('البوت'),false);
   assert.equal(state.phase4Community?.receipts.length,2);
  }finally{await f.close();}
 });
 test('P4 '+engine+': reply keywords obey switch, matching, actor quota, precedence and dangerous command exclusion',async()=>{
  const f=await fixture(engine);try{
   const added=await f.community.pending(OWNER,{kind:'REPLY_ADD',match:'WORD',
    trigger:'منحة',text:'اقرأ دليل المنح يا {العضو}'},GROUP);
   await f.community.approve(OWNER,added.id);
   const msg={kind:'TEXT' as const,chatId:GROUP,actorId:MEMBER,
    memberName:'فاطمة',groupName:'منارتك',messageText:'هل توجد منحة؟'};
   assert.equal(await f.community.propose(msg,'b3-webhook:bot-main:10'),null);
   await enable(f,'REPLIES');
   const reply=await f.community.propose(msg,'b3-webhook:bot-main:11');
   assert.equal(reply?.text,'اقرأ دليل المنح يا فاطمة');
   f.setNow(f.now()+9000);
   assert.equal(await f.community.propose(msg,'b3-webhook:bot-main:12'),null);
   f.setNow(f.now()+70000);
   assert.ok(await f.community.propose(msg,'b3-webhook:bot-main:13'));
   f.setNow(f.now()+70000);
   assert.equal(await f.community.propose({...msg,messageText:'/منحة'},'b3-webhook:bot-main:14'),null);
   assert.equal(await f.community.propose({...msg,forwarded:true},'b3-webhook:bot-main:15'),null);
   assert.equal(await f.community.propose({...msg,fromBot:true},'b3-webhook:bot-main:16'),null);
  }finally{await f.close();}
 });
 test('P4 '+engine+': live-planned join, leave and keyword replies go through authorization-fenced outbox',async()=>{
  const f=await fixture(engine);try{
   const off=await f.app().handle(joinMessage(1,'JOIN'));
   assert.equal(off.status,'IGNORED');assert.equal(off.plan,undefined);
   await enable(f,'WELCOME');
   const live=await f.app().handle(joinMessage(2,'JOIN'));
   assert.equal(live.status,'APPLIED');assert.match(live.plan?.text??'',/فاطمة &lt;&amp;&gt;/);
   assert.ok(live.deliveryKey);
   const queued=(await f.store.snapshot()).telegramReplyJobs?.find(j=>j.updateKey===live.deliveryKey);
   assert.equal(queued?.groupReplyKind,'GENERAL');
   assert.ok(queued?.groupMenuAccess);
   let calls=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{calls++;return {status:'CONFIRMED',messageId:99};}},f.now);
   assert.equal((await dispatcher.dispatch(live.deliveryKey!)).status,'CONFIRMED');
   assert.equal(calls,1);
   assert.equal((await dispatcher.dispatch(live.deliveryKey!)).status,'SENT');
   assert.equal(calls,1);
   f.setNow(f.now()+9000);
   const silentLeave=await f.app().handle(joinMessage(3,'LEAVE'));
   assert.equal(silentLeave.status,'IGNORED');
   await enable(f,'FAREWELL');
   const farewell=await f.app().handle(joinMessage(4,'LEAVE'));
   assert.equal(farewell.status,'APPLIED');assert.match(farewell.plan?.text??'',/التوفيق/);
  }finally{await f.close();}
 });
 test('P4 '+engine+': disabling after queuing prevents Telegram send at dispatch',async()=>{
  const f=await fixture(engine);try{
   await enable(f,'WELCOME');
   const first=await f.app().handle(joinMessage(30,'JOIN'));
   assert.ok(first.deliveryKey);
   const draft=await f.community.pending(OWNER,{kind:'WELCOME_OFF'},GROUP);
   await f.community.approve(OWNER,draft.id);
   let attempts=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{attempts++;return {status:'CONFIRMED',messageId:1};}},f.now);
   assert.equal((await dispatcher.dispatch(first.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(attempts,0);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.find(j=>j.updateKey===first.deliveryKey)?.plan,undefined);
  }finally{await f.close();}
 });
 test('P4 '+engine+': owner menu uses reviewed private callbacks, not group messages or forged taps',async()=>{
  const f=await fixture(engine);try{
   const screen=await phase4CommunityScreen(f.community,OWNER,'mi:1:i:09:01');
   assert.ok(screen);assert.equal(isValidTelegramInlineKeyboard(screen!.keyboard),true);
   const root=await f.app().handle(ownerCallback(70,'mi:1:i:09:01'));
   assert.equal(root.status,'APPLIED');
   assert.match(root.plan?.text??'',/الترحيب والردود/);
   const group=await f.app().handle(ownerCallback(71,'p4c:1:g:'+GROUP));
   assert.equal(group.status,'APPLIED');
   assert.equal(validPhase4CommunityRoute('p4c:1:g:'+GROUP),true);
   const preview=await f.app().handle(ownerMessage(72,'/setwelcome '+GROUP+' مرحبًا {العضو}'));
   assert.equal(preview.status,'APPLIED');assert.match(preview.plan?.text??'',/معاينة/);
   assert.equal((await f.community.view(OWNER,GROUP)).welcome.text.includes('مرحبًا'),false);
   const approveBtn=preview.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.text.includes('اعتماد'))?.callback_data;
   assert.ok(approveBtn);
   const saved=await f.app().handle(ownerCallback(73,approveBtn!));
   assert.equal(saved.status,'APPLIED');
   assert.equal((await f.community.view(OWNER,GROUP)).welcome.text,'مرحبًا {العضو}');
   const bad=await f.app().handle({...ownerCallback(74,'p4c:1:g:'+GROUP),
     callback_query:{...ownerCallback(74,'p4c:1:g:'+GROUP).callback_query,from:{id:300,is_bot:false}}});
   assert.equal(bad.status,'DENIED');
  }finally{await f.close();}
 });
 test('P4 '+engine+': corrupt/ambiguous saved config fails closed in both storage engines',async()=>{
  const f=await fixture(engine);try{
   await enable(f,'REPLIES');
   await assert.rejects(f.store.transaction(s=>{
    s.phase4Community!.configs.push({...s.phase4Community!.configs[0]!});
   }),/Unsupported state schema/);
   assert.equal((await f.store.snapshot()).phase4Community?.configs.length,1);
   await f.policy.revokeChat(OWNER,GROUP);
   await assert.rejects(f.community.pending(OWNER,{kind:'WELCOME_ON'},GROUP),/COMMUNITY_GROUP_UNAVAILABLE/);
  }finally{await f.close();}
 });
}
test('P4 command parser rejects malformed editing and callback routes',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/community'),{kind:'HOME'});
 assert.equal(parsePhase4CommunityCommand('/replyadd -100123 WORD x without separator'),null);
 assert.equal(parsePhase4CommunityCommand('/replydel -100123 ../bad'),null);
 for(const bad of ['p4c:1:g:123','p4c:1:c:invalid','p4c:1:t:-100:w:2',
  'p4c:1:l:00','p4c:1:c:'+('f'.repeat(24))+'\n'])
  assert.equal(validPhase4CommunityRoute(bad),false,bad);
});
