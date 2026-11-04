import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4ServiceCleanupDispatcher} from '../src/phase4-service-cleanup.js';
import {validCommunityConfig,validCommunityState,defaultCommunityConfig}
 from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen,validPhase4CommunityRoute}
 from '../src/phase4-community-ui.js';
import {groupMenuEpochDigest} from '../src/telegram-group-access.js';

const GROUP='-10012345678',OWNER='100',NONOWNER='311';
const start=1_800_000_000_000;
const text=(actorId:string,topicId?:number)=>({kind:'TEXT' as const,chatId:GROUP,actorId,
 memberName:'عضو',groupName:'منارتك',messageText:'منحة',
 ...(topicId===undefined?{}:{topicId})});
const joined=(actorId:string)=>({kind:'JOIN' as const,chatId:GROUP,actorId,
 memberName:'عضو',groupName:'منارتك'});
const left=(actorId:string)=>({kind:'LEAVE' as const,chatId:GROUP,actorId,
 memberName:'عضو',groupName:'منارتك'});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-welcome-noise-')),file=join(dir,engine==='json'?'state.json':'state.sqlite');
 let now=start;
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.setPresence(GROUP,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const approve=async(request:Parameters<typeof community.pending>[1])=>
  community.approve(OWNER,(await community.pending(OWNER,request,GROUP)).id);
 const event=(number:number,kind:'TITLE_CHANGED'|'PHOTO_CHANGED'|'PHOTO_REMOVED')=>
  community.recordServiceEvent({chatId:GROUP,actorId:NONOWNER,messageId:number,kind,
   updateKey:'b3-webhook:bot-main:'+number,sentAtMs:clock()});
 return {dir,file,store,policy,community,approve,event,clock,
  set:(value:number)=>{now=value;},advance:(ms:number)=>{now+=ms;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('WELCOME-006: legacy 8 per minute, configurable bounded announcement quota and service-profile opt-out',()=>{
 const base=defaultCommunityConfig(GROUP);
 assert.equal(base.autoMessagesPerMinute,undefined);
 assert.equal(validCommunityConfig(base),true);
 for(const cap of [1,2,4,8])assert.equal(validCommunityConfig({...base,autoMessagesPerMinute:cap}),true);
 for(const cap of [0,9,-1,2.5,'3',Infinity,null])assert.equal(
  validCommunityConfig({...base,autoMessagesPerMinute:cap}),false,String(cap));
 assert.equal(validCommunityConfig({...base,serviceCleanup:{enabled:true,delayMs:120000,profileEnabled:false}}),true);
 assert.equal(validCommunityConfig({...base,serviceCleanup:{enabled:true,delayMs:120000,profileEnabled:'false'}}),false);
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[]}),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:t:'+GROUP+':m:0'),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:t:'+GROUP+':m:1'),true);
});
test('WELCOME-006: strict private management commands for group automatic-message budgets and cleanup opt-out',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/autocap '+GROUP+' 2'),{
  kind:'EDIT',chatId:GROUP,request:{kind:'AUTO_LIMIT_SET',autoMessagesPerMinute:2}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/serviceprofileoff '+GROUP),{
  kind:'EDIT',chatId:GROUP,request:{kind:'SERVICE_PROFILE_OFF'}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/serviceprofileon '+GROUP),{
  kind:'EDIT',chatId:GROUP,request:{kind:'SERVICE_PROFILE_ON'}
 });
 for(const command of ['/autocap '+GROUP+' 0','/autocap '+GROUP+' 9','/autocap '+GROUP+' 01',
  '/autocap '+GROUP+' NaN','/autocap '+GROUP+' -1',
  '/autocap 300 2','/serviceprofileoff 300','/serviceprofileon '+GROUP+' extra'])
  assert.equal(parsePhase4CommunityCommand(command),null,command);
});
for(const engine of ['json','sqlite'] as const){
 test('WELCOME-006 '+engine+': owner reviews a two-per-minute cap, saves it and blocks third mixed announcement',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'WELCOME_ON'});
   await f.approve({kind:'FAREWELL_ON'});
   await f.approve({kind:'REPLY_ADD',match:'WORD',trigger:'منحة',text:'راجع الدليل'});
   await f.approve({kind:'REPLIES_ON'});
   await assert.rejects(f.community.pending(NONOWNER,{kind:'AUTO_LIMIT_SET',autoMessagesPerMinute:2},GROUP),
    /COMMUNITY_OWNER_DENIED/);
   const oldEpoch=groupMenuEpochDigest(await f.store.snapshot(),GROUP);
   const draft=await f.community.pending(OWNER,{kind:'AUTO_LIMIT_SET',autoMessagesPerMinute:2},GROUP);
   assert.match(f.community.preview(draft),/2/);
   assert.equal((await f.community.view(OWNER,GROUP)).autoMessagesPerMinute,undefined);
   await f.community.approve(OWNER,draft.id);
   assert.notEqual(groupMenuEpochDigest(await f.store.snapshot(),GROUP),oldEpoch);
   assert.equal((await f.community.view(OWNER,GROUP)).autoMessagesPerMinute,2);
   const fresh=new Phase4CommunityService(new BotStore(f.file,{engine}),f.policy,f.clock);
   assert.equal((await fresh.view(OWNER,GROUP)).autoMessagesPerMinute,2);
   assert.ok(await f.community.propose(joined('301'),'b3-webhook:bot-main:2001'));
   f.advance(9000);
   assert.ok(await f.community.propose(text('302'),'b3-webhook:bot-main:2002'));
   f.advance(9000);
   assert.equal(await f.community.propose(left('303'),'b3-webhook:bot-main:2003'),null);
   assert.equal((await f.store.snapshot()).phase4Community?.receipts.length,2);
   f.advance(61_000);
   assert.ok(await f.community.propose(left('303'),'b3-webhook:bot-main:2004'));
   const ui=await phase4CommunityScreen(f.community,OWNER,'p4c:1:g:'+GROUP);
   assert.match(ui?.text??'',/2.*دقيقة/u);
  }finally{await f.close();}
 });
 test('WELCOME-006 '+engine+': cap is transactional under simultaneous updates across forum topics and stores',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'AUTO_LIMIT_SET',autoMessagesPerMinute:2});
   await f.approve({kind:'REPLY_ADD',match:'WORD',trigger:'منحة',text:'النص المعتمد'});
   await f.approve({kind:'REPLIES_ON'});
   for(const topicId of [501,502,503])await f.approve({kind:'TOPIC_COOLDOWN_SET',topicId,cooldownMs:1000});
   const second=new Phase4CommunityService(new BotStore(f.file,{engine}),f.policy,f.clock);
   const result=await Promise.all([
    f.community.propose(text('301',501),'b3-webhook:bot-main:2101'),
    second.propose(text('302',502),'b3-webhook:bot-main:2102'),
    f.community.propose(text('303',503),'b3-webhook:bot-main:2103')
   ]);
   assert.equal(result.filter(Boolean).length,2,'group quota cannot be bypassed by topics or parallel workers');
   assert.equal((await f.store.snapshot()).phase4Community?.receipts.length,2);
  }finally{await f.close();}
 });
 test('WELCOME-006 '+engine+': owner can independently disable cleanup of title/photo service events',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'SERVICE_CLEANUP_ON'});
   // Legacy installations keep their earlier behavior until owner changes a setting.
   assert.equal(await f.event(310,'TITLE_CHANGED'),true);
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length,1);
   const oldKey=(await f.store.snapshot()).phase4Community!.cleanupJobs![0]!.key;
   const draft=await f.community.pending(OWNER,{kind:'SERVICE_PROFILE_OFF'},GROUP);
   assert.match(f.community.preview(draft),/صورة|اسم/u);
   await f.community.approve(OWNER,draft.id);
   assert.equal((await f.community.view(OWNER,GROUP)).serviceCleanup?.profileEnabled,false);
   assert.equal(await f.event(311,'PHOTO_CHANGED'),false);
   assert.equal(await f.event(312,'PHOTO_REMOVED'),false);
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length,1);
   let deletions=0;
   const gateway={canDelete:async()=>true,
    deleteMessage:async()=>{deletions++;return 'CONFIRMED' as const;}};
   f.advance(121000);
   const dispatcher=new Phase4ServiceCleanupDispatcher(f.store,f.policy,gateway,f.clock);
   assert.equal(await dispatcher.dispatch(oldKey),'SKIPPED');
   assert.equal(deletions,0);
   await f.approve({kind:'SERVICE_PROFILE_ON'});
   assert.equal(await f.event(313,'PHOTO_CHANGED'),true);
   assert.equal((await f.store.snapshot()).phase4Community?.cleanupJobs?.length,2);
   const restored=new Phase4CommunityService(new BotStore(f.file,{engine}),f.policy,f.clock);
   assert.equal((await restored.view(OWNER,GROUP)).serviceCleanup?.profileEnabled,true);
   const ui=await phase4CommunityScreen(f.community,OWNER,'p4c:1:s:'+GROUP);
   assert.match(ui?.text??'',/اسم|صورة/u);
   assert.ok(ui?.keyboard.inline_keyboard.flat().some(x=>x.callback_data==='p4c:1:t:'+GROUP+':m:0'));
  }finally{await f.close();}
 });
 test('WELCOME-006 '+engine+': owner cannot make malformed drafts or bypass limit validation',async()=>{
  const f=await fixture(engine);
  try{
   for(const invalid of [0,-1,9,1.5,NaN])await assert.rejects(
    f.community.pending(OWNER,{kind:'AUTO_LIMIT_SET',autoMessagesPerMinute:invalid},GROUP),
    /COMMUNITY_AUTO_LIMIT_INVALID/);
   const draft=await f.community.pending(OWNER,{kind:'AUTO_LIMIT_SET',autoMessagesPerMinute:3},GROUP);
   await f.approve({kind:'WELCOME_ON'});
   await assert.rejects(f.community.approve(OWNER,draft.id),/COMMUNITY_DRAFT_STALE/);
  }finally{await f.close();}
 });
}
