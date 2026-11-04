import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4GroupProfileDispatcher,TelegramBotApiGroupProfileGateway}
 from '../src/phase4-group-profile.js';
import {validCommunityConfig,validCommunityState,defaultCommunityConfig}
 from '../src/phase4-community-model.js';
import {phase4CommunityScreen,parsePhase4CommunityCommand,validPhase4CommunityRoute}
 from '../src/phase4-community-ui.js';

const GROUP='-1001122334455',OWNER='100',STUDENT='300';
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'p4-profile-')),path=join(dir,engine==='json'?'bot.json':'bot.sqlite');
 let now=1_800_000_000_000;
 const clock=()=>now,store=new BotStore(path,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,GROUP,['navigation']);await policy.setPresence(GROUP,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const approve=async(request:Parameters<typeof community.pending>[1])=>{
  const draft=await community.pending(OWNER,request,GROUP);
  return community.approve(OWNER,draft.id);
 };
 return {dir,path,store,policy,community,clock,approve,
  move:(ms:number)=>{now+=ms;},close:()=>rm(dir,{force:true,recursive:true})};
}
test('WELCOME-005: commands are private-owner reviewed, never raw free-text group changes',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/groupediton '+GROUP),{kind:'EDIT',chatId:GROUP,request:{kind:'GROUP_PROFILE_ON'}});
 assert.deepEqual(parsePhase4CommunityCommand('/groupeditoff '+GROUP),{kind:'EDIT',chatId:GROUP,request:{kind:'GROUP_PROFILE_OFF'}});
 assert.deepEqual(parsePhase4CommunityCommand('/groupname '+GROUP+' منارتك <الدراسة>'),{
  kind:'EDIT',chatId:GROUP,request:{kind:'GROUP_TITLE_SET',text:'منارتك <الدراسة>'}});
 assert.deepEqual(parsePhase4CommunityCommand('/groupclearphoto '+GROUP),{
  kind:'EDIT',chatId:GROUP,request:{kind:'GROUP_PHOTO_REMOVE'}});
 assert.equal(parsePhase4CommunityCommand('/groupname '+GROUP+' '+('A'.repeat(129))),null);
 assert.equal(parsePhase4CommunityCommand('/groupname '+GROUP+'   '),null);
 assert.equal(parsePhase4CommunityCommand('/groupname 301 عنوان'),null);
 assert.equal(parsePhase4CommunityCommand('/groupclearphoto '+GROUP+' extra'),null);
 assert.equal(validPhase4CommunityRoute('p4c:1:p:'+GROUP),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:t:'+GROUP+':v:1'),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:t:'+GROUP+':v:0'),true);
});
test('WELCOME-005: profile operation validation rejects unreviewed changes and poisoned state',()=>{
 const config=defaultCommunityConfig(GROUP);
 assert.equal(config.profileEditingEnabled,undefined);
 assert.equal(validCommunityConfig({...config,profileEditingEnabled:true}),true);
 assert.equal(validCommunityConfig({...config,profileEditingEnabled:'true'}),false);
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[],profileJobs:[{
  key:'a'.repeat(24),chatId:GROUP,chatVersion:1,policyVersion:2,
  kind:'TITLE_SET',status:'QUEUED',createdAt:1000,title:'منارتك',profileEpoch:0
 }]}),true);
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[],profileJobs:[{
  key:'a'.repeat(24),chatId:GROUP,chatVersion:1,policyVersion:2,
  kind:'TITLE_SET',status:'QUEUED',createdAt:1000,title:'\n',profileEpoch:0
 }]}),false);
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[],profileJobs:[{
  key:'a'.repeat(24),chatId:GROUP,chatVersion:1,policyVersion:2,
  kind:'PHOTO_REMOVE',status:'QUEUED',createdAt:1000,title:'unused',profileEpoch:0
 }]}),false);
});
for(const engine of ['json','sqlite'] as const){
 test('WELCOME-005 '+engine+': explicit owner opt-in and second approval produce one durable title operation',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.community.pending(STUDENT,{kind:'GROUP_PROFILE_ON'},GROUP),/COMMUNITY_OWNER_DENIED/);
   await assert.rejects(f.community.pending(OWNER,{kind:'GROUP_TITLE_SET',text:'تغيير'},GROUP),/COMMUNITY_PROFILE_DISABLED/);
   const before=await f.community.pending(OWNER,{kind:'GROUP_PROFILE_ON'},GROUP);
   assert.equal((await f.community.view(OWNER,GROUP)).profileEditingEnabled,undefined);
   await f.community.approve(OWNER,before.id);
   const draft=await f.community.pending(OWNER,{kind:'GROUP_TITLE_SET',text:'منارتك <المميزة>'},GROUP);
   assert.match(f.community.preview(draft),/&lt;المميزة&gt;/);
   assert.equal((await f.store.snapshot()).phase4Community?.profileJobs?.length??0,0);
   const changed=await f.community.approve(OWNER,draft.id);
   assert.equal(changed.profileEditingEnabled,true);
   const jobs=(await f.store.snapshot()).phase4Community?.profileJobs??[];
   assert.equal(jobs.length,1);
   assert.equal(jobs[0]?.title,'منارتك <المميزة>');
   assert.equal(jobs[0]?.policyVersion,changed.version);
   assert.equal(jobs[0]?.status,'QUEUED');
   await assert.rejects(f.community.pending(OWNER,{kind:'GROUP_PHOTO_REMOVE'},GROUP),/COMMUNITY_PROFILE_OPERATION_PENDING/);
   assert.equal((await new BotStore(f.path,{engine}).snapshot()).phase4Community?.profileJobs?.[0]?.status,'QUEUED');
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:p:'+GROUP);
   assert.match(screen?.text??'',/صلاحية|اسم|صورة/u);
   assert.ok(screen?.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='p4c:1:t:'+GROUP+':v:0'));
   await assert.rejects(phase4CommunityScreen(f.community,STUDENT,'p4c:1:p:'+GROUP),/COMMUNITY_OWNER_DENIED/);
  }finally{await f.close();}
 });
 test('WELCOME-005 '+engine+': allowed operation sends once only and redacts approved title after claim',async()=>{
  const f=await fixture(engine);try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_TITLE_SET',text:'اختبار تغيير العنوان'});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   let calls=0,rights=0;
   const dispatcher=new Phase4GroupProfileDispatcher(f.store,f.policy,{
    canChangeInfo:async()=>{rights++;return true;},
    setTitle:async()=>{calls++;return 'CONFIRMED' as const;},
    removePhoto:async()=>{throw Error('UNEXPECTED_DELETE');}
   },f.clock,async()=>true);
   assert.equal(await dispatcher.dispatch(key),'CONFIRMED');
   assert.equal(await dispatcher.dispatch(key),'CONFIRMED');
   assert.equal(calls,1);assert.equal(rights,1);
   const stored=JSON.stringify((await f.store.snapshot()).phase4Community?.profileJobs);
   assert.equal(stored.includes('اختبار تغيير العنوان'),false);
   assert.equal((await f.store.snapshot()).phase4Community?.profileJobs?.[0]?.status,'CONFIRMED');
  }finally{await f.close();}
 });
 test('WELCOME-005 '+engine+': permission denial and emergency STOP block Telegram profile edits',async()=>{
  const f=await fixture(engine);try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_PHOTO_REMOVE'});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   let edits=0;
   const gateway={canChangeInfo:async()=>true,setTitle:async()=>{edits++;return 'CONFIRMED' as const;},
    removePhoto:async()=>{edits++;return 'CONFIRMED' as const;}};
   const stopped=new Phase4GroupProfileDispatcher(f.store,f.policy,gateway,f.clock,async()=>false);
   assert.equal(await stopped.dispatch(key),'PAUSED');assert.equal(edits,0);
   const noRights=new Phase4GroupProfileDispatcher(f.store,f.policy,{
    ...gateway,canChangeInfo:async()=>false
   },f.clock,async()=>true);
   assert.equal(await noRights.dispatch(key),'FAILED_CONFIRMED');assert.equal(edits,0);
  }finally{await f.close();}
 });
 test('WELCOME-005 '+engine+': changing community policy or group approval invalidates a queued profile edit',async()=>{
  const f=await fixture(engine);try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_TITLE_SET',text:'لا ينبغي تطبيقه'});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   await f.approve({kind:'GROUP_PROFILE_OFF'});
   let edits=0;
   const dispatcher=new Phase4GroupProfileDispatcher(f.store,f.policy,{
    canChangeInfo:async()=>true,setTitle:async()=>{edits++;return 'CONFIRMED' as const;},
    removePhoto:async()=>{edits++;return 'CONFIRMED' as const;}
   },f.clock,async()=>true);
   assert.equal(await dispatcher.dispatch(key),'SKIPPED');assert.equal(edits,0);
  }finally{await f.close();}
 });
 test('WELCOME-005 '+engine+': observed Telegram change after owner approval fences stale title operation',async()=>{
  const f=await fixture(engine);try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_TITLE_SET',text:'عنوان لم يعد ملائمًا'});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   assert.equal(await f.community.recordServiceEvent({chatId:GROUP,actorId:STUDENT,messageId:99,
    kind:'TITLE_CHANGED',updateKey:'b3-webhook:bot-main:99',sentAtMs:f.clock()}),true);
   const observations=(await f.store.snapshot()).phase4Community?.profileObservations;
   assert.equal(observations?.length,1);
   assert.equal((await f.community.recentChanges(OWNER,GROUP)).length,0,
    'observing for edit fencing must not enable owner history');
   let edits=0;
   const dispatcher=new Phase4GroupProfileDispatcher(f.store,f.policy,{
    canChangeInfo:async()=>true,setTitle:async()=>{edits++;return 'CONFIRMED' as const;},
    removePhoto:async()=>{edits++;return 'CONFIRMED' as const;}
   },f.clock,async()=>true);
   assert.equal(await dispatcher.dispatch(key),'SKIPPED');
   assert.equal(edits,0);
  }finally{await f.close();}
 });
 test('WELCOME-005 '+engine+': unknown remote result or concurrent run is never retried automatically',async()=>{
  const f=await fixture(engine);try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_TITLE_SET',text:'عنوان لا يتكرر'});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   let calls=0;
   const gateway={canChangeInfo:async()=>true,setTitle:async()=>{
    calls++;await new Promise(r=>setTimeout(r,8));return 'UNKNOWN_OUTCOME' as const;
   },removePhoto:async()=> 'CONFIRMED' as const};
   const one=new Phase4GroupProfileDispatcher(f.store,f.policy,gateway,f.clock,async()=>true);
   const two=new Phase4GroupProfileDispatcher(new BotStore(f.path,{engine}),f.policy,gateway,f.clock,async()=>true);
   const outcomes=await Promise.all([one.dispatch(key),two.dispatch(key)]);
   assert.ok(outcomes.includes('UNKNOWN_OUTCOME'));
   assert.equal(calls,1);
   assert.equal(await one.dispatch(key),'UNKNOWN_OUTCOME');
   assert.equal(calls,1);
   assert.equal((await f.store.snapshot()).phase4Community?.profileJobs?.[0]?.title,undefined);
  }finally{await f.close();}
 });
 test('WELCOME-005 '+engine+': late pending operations expire without contacting Telegram',async()=>{
  const f=await fixture(engine);try{
   await f.approve({kind:'GROUP_PROFILE_ON'});
   await f.approve({kind:'GROUP_PHOTO_REMOVE'});
   const key=(await f.store.snapshot()).phase4Community!.profileJobs![0]!.key;
   f.move(11*60*1000);
   let edits=0;
   const dispatcher=new Phase4GroupProfileDispatcher(f.store,f.policy,{
    canChangeInfo:async()=>true,setTitle:async()=>{edits++;return 'CONFIRMED' as const;},
    removePhoto:async()=>{edits++;return 'CONFIRMED' as const;}
   },f.clock,async()=>true);
   assert.equal(await dispatcher.dispatch(key),'SKIPPED');assert.equal(edits,0);
  }finally{await f.close();}
 });
}
test('WELCOME-005: Telegram group-profile gateway requires fresh can_change_info and fail-closes on 401/500',async()=>{
 const calls:string[]=[];
 const token='123456789:'+('A'.repeat(36));
 const request=async(url:string|URL|Request,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1)!;calls.push(method);
  const body=JSON.parse(String(init?.body));
  const result=method==='getChatMember'?{ok:true,result:{status:'administrator',can_change_info:true}}:
   method==='setChatTitle'?{ok:true,result:true}:{ok:true,result:true};
  assert.equal(body.chat_id,GROUP);
  return new Response(JSON.stringify(result),{status:200});
 };
 const gateway=new TelegramBotApiGroupProfileGateway(token,request as typeof fetch);
 assert.equal(await gateway.canChangeInfo(GROUP),true);
 assert.equal(await gateway.setTitle(GROUP,'منارتك الرسمية'),'CONFIRMED');
 assert.equal(await gateway.removePhoto(GROUP),'CONFIRMED');
 assert.deepEqual(calls,['getChatMember','setChatTitle','deleteChatPhoto']);
 const restricted=new TelegramBotApiGroupProfileGateway(token,async()=>new Response(JSON.stringify({
  ok:true,result:{status:'administrator',can_change_info:false}
 }),{status:200}));
 assert.equal(await restricted.canChangeInfo(GROUP),false);
 const unavailable=new TelegramBotApiGroupProfileGateway(token,async()=>new Response('unavailable',{status:502}));
 assert.equal(await unavailable.setTitle(GROUP,'عنوان جديد'),'UNKNOWN_OUTCOME');
 const invalid=new TelegramBotApiGroupProfileGateway(token,async()=>new Response(JSON.stringify({ok:false,description:'Forbidden'}),{status:403}));
 assert.equal(await invalid.removePhoto(GROUP),'FAILED_CONFIRMED');
});
