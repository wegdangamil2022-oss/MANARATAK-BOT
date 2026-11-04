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
import {defaultCommunityConfig,validCommunityConfig,renderCommunityTemplate,
 selectCommunityGreeting} from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen,validPhase4CommunityRoute} from '../src/phase4-community-ui.js';

const CHAT='-10099888777',OWNER='100',STUDENT='201';
const templateInput={kind:'JOIN' as const,chatId:CHAT,actorId:STUDENT,
 memberName:'Laila <&>',groupName:'Manaratak <Group>'};
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-locale-'));const file=join(dir,engine==='json'?'db.json':'db.sqlite');
 let now=1_789_000_000_000;
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,CHAT,['navigation']);await policy.setPresence(CHAT,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const education=new EducationService(store,policy,clock);
 const app=new TelegramUpdateApplication({store,policy,community,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',clock});
 const approval=async(request:Parameters<typeof community.pending>[1])=>{
  const draft=await community.pending(OWNER,request,CHAT);
  return community.approve(OWNER,draft.id);
 };
 const joinUpdate=(id:number,who:number)=>({update_id:id,message:{message_id:id,
  chat:{id:Number(CHAT),type:'supergroup',title:'Manaratak <Group>'},
  from:{id:who,is_bot:false,first_name:'Laila <&>'},
  new_chat_members:[{id:who,is_bot:false,first_name:'Laila <&>'}]}});
 return {dir,file,store,policy,community,app,approval,joinUpdate,clock,
  setNow:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
}

test('P4 locale: default text/time remains backward compatible and 12h Hijri is explicit',()=>{
 const c=defaultCommunityConfig(CHAT);
 assert.equal(renderCommunityTemplate('التاريخ {التاريخ} الساعة {الوقت}',templateInput,
  Date.UTC(2026,10,4,13,5)),'التاريخ 2026-11-04 الساعة 13:05');
 assert.equal(selectCommunityGreeting(c,'welcome'),c.welcome.text);
 assert.equal(selectCommunityGreeting(c,'farewell'),c.farewell.text);
 const english=renderCommunityTemplate('Date {التاريخ} Time {الوقت}',templateInput,
  Date.UTC(2026,10,4,13,5),'',{language:'en',clockFormat:'12',calendar:'gregorian'});
 assert.equal(english,'Date 2026-11-04 Time 01:05 PM');
 const hijri=renderCommunityTemplate('التاريخ {التاريخ} الساعة {الوقت}',templateInput,
  Date.UTC(2026,10,4,13,5),'',{language:'ar',clockFormat:'12',calendar:'hijri'});
 assert.match(hijri,/التاريخ 14\d{2}-\d{2}-\d{2} هـ الساعة 01:05 م/u);
});

test('P4 locale: impossible or injected values are rejected at the model boundary',()=>{
 const config=defaultCommunityConfig(CHAT);
 assert.equal(validCommunityConfig({...config,language:'de'}),false);
 assert.equal(validCommunityConfig({...config,clockFormat:'15'}),false);
 assert.equal(validCommunityConfig({...config,calendar:'fantasy'}),false);
 assert.equal(validCommunityConfig({...config,welcome:{...config.welcome,
  localized:{en:'bad {secret}'}}}),false);
 assert.equal(validCommunityConfig({...config,welcome:{...config.welcome,
  localized:{es:'Hola'}}}),false);
 assert.equal(validCommunityConfig({...config,utcOffsetMinutes:841}),false);
 assert.equal(validCommunityConfig({...config,welcome:{...config.welcome,
  localized:{ar:'أهلًا {العضو}',en:'Welcome {العضو}!'}}}),true);
});

test('P4 locale: owner commands safely parse localization and UTC offset',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/greetinglang '+CHAT+' en'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'GROUP_LANGUAGE',language:'en'}});
 assert.deepEqual(parsePhase4CommunityCommand('/greetingtext '+CHAT+' welcome en Welcome {العضو}'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'WELCOME_LOCALIZED',language:'en',text:'Welcome {العضو}'}});
 assert.deepEqual(parsePhase4CommunityCommand('/greetingtext '+CHAT+' farewell ar مع السلامة'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'FAREWELL_LOCALIZED',language:'ar',text:'مع السلامة'}});
 assert.deepEqual(parsePhase4CommunityCommand('/greetingclock '+CHAT+' +03:30 12 hijri'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'GROUP_CLOCK',utcOffsetMinutes:210,
   clockFormat:'12',calendar:'hijri'}});
 for(const invalid of ['/greetinglang '+CHAT+' fr','/greetingclock '+CHAT+' +14:01 24 gregorian',
  '/greetingclock '+CHAT+' -12:01 24 gregorian','/greetingclock '+CHAT+' +03:70 12 hijri',
  '/greetingclock '+CHAT+' +03:00 13 hijri','/greetingtext '+CHAT+' welcome fr invalid'])
  assert.equal(parsePhase4CommunityCommand(invalid),null,invalid);
 assert.equal(validPhase4CommunityRoute('p4c:1:u:'+CHAT+':en'),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:o:'+CHAT+':12:h'),true);
});

for(const engine of ['json','sqlite'] as const){
 test('P4 '+engine+': localized templates, calendar and clock use owner-reviewed durable revisions',async()=>{
  const f=await setup(engine);
  try{
   const draft=await f.community.pending(OWNER,
    {kind:'WELCOME_LOCALIZED',language:'en',text:'Welcome {العضو} to {اسم_المجموعة}'},CHAT);
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.localized?.en,undefined);
   await assert.rejects(f.community.approve(STUDENT,draft.id),/COMMUNITY_DRAFT_NOT_FOUND/);
   const updated=await f.community.approve(OWNER,draft.id);
   assert.equal(updated.welcome.localized?.en,'Welcome {العضو} to {اسم_المجموعة}');
   const language=await f.community.pending(OWNER,{kind:'GROUP_LANGUAGE',language:'en'},CHAT);
   const competing=await f.community.pending(OWNER,{kind:'GROUP_CLOCK',clockFormat:'12',
    calendar:'hijri',utcOffsetMinutes:210},CHAT);
   await assert.rejects(f.community.approve(OWNER,language.id),/COMMUNITY_DRAFT_NOT_FOUND/);
   const clock=await f.community.approve(OWNER,competing.id);
   assert.equal(clock.utcOffsetMinutes,210);assert.equal(clock.clockFormat,'12');assert.equal(clock.calendar,'hijri');
   await f.approval({kind:'GROUP_LANGUAGE',language:'en'});
   const persisted=await new BotStore(f.file,{engine}).snapshot();
   assert.equal(persisted.phase4Community?.configs[0]?.language,'en');
   assert.equal(selectCommunityGreeting((await f.community.view(OWNER,CHAT)),'welcome'),
    'Welcome {العضو} to {اسم_المجموعة}');
   await f.approval({kind:'WELCOME_ON'});
   const planned=await f.app.handle(f.joinUpdate(921,201));
   assert.equal(planned.status,'APPLIED');
   assert.match(planned.plan?.text??'',/^Welcome Laila &lt;&amp;&gt; to Manaratak/u);
   const welcomeScreen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:g:'+CHAT);
   assert.match(welcomeScreen?.text??'',/en.*hijri|اللغة: en/u);
   const before=await f.app.handle(f.joinUpdate(922,202));
   assert.equal(before.plan,undefined); // group-wide anti-flood applies
   const switchBack=await f.community.pending(OWNER,{kind:'GROUP_LANGUAGE',language:'ar'},CHAT);
   await f.community.approve(OWNER,switchBack.id);
   let sends=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,
    {send:async()=>{sends++;return {status:'CONFIRMED' as const,messageId:932};}},f.clock);
   assert.equal((await dispatcher.dispatch(planned.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(sends,0);
  }finally{await f.close();}
 });
 test('P4 '+engine+': invalid localized drafts fail closed and never change group state',async()=>{
  const f=await setup(engine);
  try{
   await assert.rejects(f.community.pending(STUDENT,{kind:'GROUP_LANGUAGE',language:'ar'},CHAT));
   for(const change of [
    {kind:'GROUP_LANGUAGE' as const,language:'de' as any},
    {kind:'WELCOME_LOCALIZED' as const,language:'en' as const,text:'hello {bad}'},
    {kind:'GROUP_CLOCK' as const,clockFormat:'24' as const,calendar:'gregorian' as const,utcOffsetMinutes:900},
    {kind:'GROUP_CLOCK' as const,clockFormat:'15' as any,calendar:'gregorian' as const,utcOffsetMinutes:0}
   ])await assert.rejects(f.community.pending(OWNER,change,CHAT));
   assert.equal((await f.community.view(OWNER,CHAT)).version,0);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('P4 '+engine+': inline language/calendar controls require preview and cannot replay approval',async()=>{
  const f=await setup(engine);
  try{
   const original=await phase4CommunityScreen(f.community,OWNER,'p4c:1:g:'+CHAT);
   assert.ok(original);
   const languageButton=original.keyboard.inline_keyboard.flat()
    .find(x=>x.callback_data==='p4c:1:u:'+CHAT+':en');
   assert.ok(languageButton);
   const preview=await phase4CommunityScreen(f.community,OWNER,languageButton!.callback_data);
   assert.match(preview?.text??'',/en/u);
   assert.equal((await f.community.view(OWNER,CHAT)).language,undefined);
   const confirm=preview?.keyboard.inline_keyboard.flat()
    .find(x=>x.callback_data.startsWith('p4c:1:c:'));
   assert.ok(confirm);
   assert.ok(await phase4CommunityScreen(f.community,OWNER,confirm!.callback_data));
   assert.equal((await f.community.view(OWNER,CHAT)).language,'en');
   await assert.rejects(phase4CommunityScreen(f.community,OWNER,confirm!.callback_data),
    /COMMUNITY_DRAFT_NOT_FOUND/);
   const calendar=await phase4CommunityScreen(f.community,OWNER,'p4c:1:o:'+CHAT+':12:h');
   assert.ok(calendar);
   const action=calendar.keyboard.inline_keyboard.flat().find(x=>
    x.callback_data.startsWith('p4c:1:c:'));
   assert.ok(action);
   await phase4CommunityScreen(f.community,OWNER,action!.callback_data);
   assert.equal((await f.community.view(OWNER,CHAT)).calendar,'hijri');
   assert.equal((await f.community.view(OWNER,CHAT)).clockFormat,'12');
  }finally{await f.close();}
 });
}
