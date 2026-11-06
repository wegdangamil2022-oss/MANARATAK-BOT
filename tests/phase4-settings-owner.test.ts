import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {phase4SettingsOwnerScreen,validPhase4SettingsRoute,
 parsePhase4SettingsCommand} from '../src/phase4-settings-owner.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
const OWNER='100',OTHER='200',CHAT='-1001234',NOW=1_700_000_000_000;
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-settings-'));
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['navigation']);
 const community=new Phase4CommunityService(store,policy,()=>NOW);
 const education=new EducationService(store,policy,()=>NOW);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy);
 const links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',clock:()=>NOW,
  membership:async()=> 'VERIFIED',ownerMenuMode:'inline',community});
 const cb=(n:number,id:string,data:string)=>({
  update_id:n,callback_query:{id:'ss'+n,data,from:{id:Number(id),is_bot:false},
   message:{message_id:30,chat:{id:Number(id),type:'private'},from:{id:900,is_bot:true}}}
 });
 return {store,policy,community,app,cb,close:()=>rm(dir,{recursive:true,force:true})};
}
test('SETTINGS-001 only canonical commands and bounded callback routes',()=>{
 assert.deepEqual(parsePhase4SettingsCommand('/communitysettings'),{kind:'HOME'});
 assert.deepEqual(parsePhase4SettingsCommand('/communitysettings '+CHAT),{kind:'GROUP',chatId:CHAT});
 for(const v of ['/communitysettings 1001234','/communitysettings '+CHAT+'\n',
  '/communitysettings -9999999999999999'])assert.equal(parsePhase4SettingsCommand(v),null);
 assert.equal(validPhase4SettingsRoute('p4s:1:t:'+CHAT+':0:w:0'),true);
 for(const v of ['p4s:1:t:'+CHAT+':-1:w:0','p4s:1:g:1001234',
  'p4s:1:v:'+CHAT+':z','p4s:1:t:'+CHAT+':1:w:2',
  'p4s:1:h\n','p4s:1:'+('a'.repeat(100))])
  assert.equal(validPhase4SettingsRoute(v),false,v);
});
for(const engine of ['json','sqlite'] as const){
 test('SETTINGS-002 '+engine+' owner dashboard is read-only, scoped to approved group',async()=>{
  const f=await setup(engine);try{
   const before=JSON.stringify(await f.store.snapshot());
   const list=await phase4SettingsOwnerScreen(f.community,OWNER,'mi:1:i:09:16');
   assert.ok(list);
   assert.ok(list.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='p4s:1:g:'+CHAT));
   const view=await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:g:'+CHAT);
   assert.ok(view);assert.match(view.text,/إعدادات القسم/);
   assert.equal(JSON.stringify(await f.store.snapshot()),before);
   assert.equal(await phase4SettingsOwnerScreen(f.community,OTHER,'p4s:1:g:'+CHAT),null);
   assert.equal(await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:g:-1000009'),null);
  }finally{await f.close();}
 });
 test('SETTINGS-003 '+engine+' preview not an approval; stale version and forged expected state rejected',async()=>{
  const f=await setup(engine);try{
   const action='p4s:1:t:'+CHAT+':0:w:0';
   const preview=await phase4SettingsOwnerScreen(f.community,OWNER,action);
   assert.ok(preview);
   const confirm=preview.keyboard.inline_keyboard.flat().find(x=>x.text.includes('اعتماد'));
   assert.match(confirm?.callback_data??'',/^p4c:1:c:[a-f0-9]{24}$/u);
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.enabled,false);
   await f.community.approve(OWNER,confirm!.callback_data.slice(8));
   assert.equal((await f.community.view(OWNER,CHAT)).welcome.enabled,true);
   assert.equal(await phase4SettingsOwnerScreen(f.community,OWNER,action),null);
   assert.equal(await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:t:'+CHAT+':1:w:0'),null);
   const privacy=await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:v:'+CHAT+':p');
   assert.ok(privacy);
   assert.ok(privacy.keyboard.inline_keyboard.flat().some(b=>b.callback_data===
    'p4s:1:t:'+CHAT+':1:d:0'));
  }finally{await f.close();}
 });
 test('SETTINGS-004 '+engine+' Telegram callback uses new private 09:16 route, rejects other actors',async()=>{
  const f=await setup(engine);try{
   const open=await f.app().handle(f.cb(1,OWNER,'mi:1:i:09:16'));
   assert.equal(open.status,'APPLIED');
   assert.equal(open.reason,'PHASE4_SETTINGS_OWNER');
   const forged=await f.app().handle(f.cb(2,OTHER,'mi:1:i:09:16'));
   assert.equal(forged.status,'DENIED');
   await f.policy.revokeChat(OWNER,CHAT);
   assert.equal(await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:g:'+CHAT),null);
  }finally{await f.close();}
 });

 test('SETTINGS-005 '+engine+' deep links include service types, exceptions and module hub without mutating policies',async()=>{
  const f=await setup(engine);try{
   const before=JSON.stringify(await f.store.snapshot());
   const root=await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:g:'+CHAT);
   assert.ok(root);
   for(const tab of ['s','e','m'])assert.ok(root.keyboard.inline_keyboard.flat().some(
    x=>x.callback_data==='p4s:1:v:'+CHAT+':'+tab),tab);
   const modules=await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:v:'+CHAT+':m');
   assert.ok(modules);assert.ok(modules.keyboard.inline_keyboard.flat().some(x=>x.callback_data==='wh:1:h'));
   assert.ok(modules.keyboard.inline_keyboard.flat().some(x=>x.callback_data==='er:1:h'));
   assert.equal(JSON.stringify(await f.store.snapshot()),before);
  }finally{await f.close();}
 });
 test('SETTINGS-006 '+engine+' service event exceptions are reviewed individually with legacy defaults',async()=>{
  const f=await setup(engine);try{
   const service=await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:v:'+CHAT+':s');
   assert.ok(service);
   for(const code of ['j','k','t'])assert.ok(service.keyboard.inline_keyboard.flat().some(
    x=>x.callback_data==='p4s:1:t:'+CHAT+':0:'+code+':1'),code);
   const preview=await phase4SettingsOwnerScreen(f.community,OWNER,
    'p4s:1:t:'+CHAT+':0:j:1');
   assert.ok(preview);
   assert.equal((await f.community.view(OWNER,CHAT)).serviceCleanup?.joinEnabled,undefined);
   const accept=preview.keyboard.inline_keyboard.flat().find(x=>x.text.includes('اعتماد'));
   await f.community.approve(OWNER,accept!.callback_data.slice(8));
   const config=await f.community.view(OWNER,CHAT);
   assert.equal(config.serviceCleanup?.joinEnabled,false);
   assert.equal(config.serviceCleanup?.enabled,false);
   assert.equal(config.serviceCleanup?.leaveEnabled,undefined);
   assert.equal(await phase4SettingsOwnerScreen(f.community,OWNER,
    'p4s:1:t:'+CHAT+':0:j:1'),null);
   const next=await phase4SettingsOwnerScreen(f.community,OWNER,
    'p4s:1:t:'+CHAT+':1:k:1');
   assert.ok(next);
  }finally{await f.close();}
 });
 test('SETTINGS-007 '+engine+' high-impact profile editing and removal notices require separate approval',async()=>{
  const f=await setup(engine);try{
   const tab=await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:v:'+CHAT+':e');
   assert.ok(tab);
   for(const code of ['g','n'])assert.ok(tab.keyboard.inline_keyboard.flat().some(
    x=>x.callback_data==='p4s:1:t:'+CHAT+':0:'+code+':0'),code);
   const editing=await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:t:'+CHAT+':0:g:0');
   assert.ok(editing);
   const editAccept=editing.keyboard.inline_keyboard.flat().find(x=>x.text.includes('اعتماد'));
   await f.community.approve(OWNER,editAccept!.callback_data.slice(8));
   assert.equal((await f.community.view(OWNER,CHAT)).profileEditingEnabled,true);
   const notices=await phase4SettingsOwnerScreen(f.community,OWNER,'p4s:1:t:'+CHAT+':1:n:0');
   assert.ok(notices);
   const noticeAccept=notices.keyboard.inline_keyboard.flat().find(x=>x.text.includes('اعتماد'));
   await f.community.approve(OWNER,noticeAccept!.callback_data.slice(8));
   assert.equal((await f.community.view(OWNER,CHAT)).farewellOnRemoval,true);
  }finally{await f.close();}
 });
}
