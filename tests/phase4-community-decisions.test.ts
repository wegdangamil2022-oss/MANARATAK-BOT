import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {validCommunityState} from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen,validPhase4CommunityRoute}
 from '../src/phase4-community-ui.js';

const CHAT='-1003412567',OWNER='100',MEMBER='300';
const input=(text:string,actor=MEMBER,topicId?:number)=>({
 kind:'TEXT' as const,chatId:CHAT,actorId:actor,memberName:'اسم خاص لا يُحفظ',
 groupName:'اسم المجموعة السري',messageText:text,
 ...(topicId!==undefined?{topicId}:{})
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-reason-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 let now=Date.parse('2026-11-04T12:00:00Z');
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,CHAT,['navigation']);
 await policy.setPresence(CHAT,true);
 const service=new Phase4CommunityService(store,policy,clock);
 const apply=async(request:Parameters<typeof service.pending>[1])=>
  service.approve(OWNER,(await service.pending(OWNER,request,CHAT)).id);
 return {dir,file,store,policy,service,clock,apply,set:(t:number)=>{now=t;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('P4 decisions: owner log commands, callback routes and unsafe forms',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/replylog '+CHAT),{kind:'DECISIONS',chatId:CHAT});
 assert.deepEqual(parsePhase4CommunityCommand('/replylogon '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'DECISION_LOG_ON'}});
 assert.deepEqual(parsePhase4CommunityCommand('/replylogoff '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'DECISION_LOG_OFF'}});
 assert.equal(validPhase4CommunityRoute('p4c:1:k:'+CHAT),true);
 for(const bad of ['/replylog 123','/replylogoff 123','/replylogon '+CHAT+' extra'])
  assert.equal(parsePhase4CommunityCommand(bad),null,bad);
 assert.equal(validPhase4CommunityRoute('p4c:1:k:123'),false);
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[],
  decisionLog:[{chatId:CHAT,key:'a'.repeat(64),kind:'TEXT',at:1_000_000,
   configVersion:1,reason:'RAW_STUDENT_TEXT',sample:'hello'}]}),false);
});
for(const engine of ['json','sqlite'] as const){
 test('P4 decisions '+engine+': logging is opt-in and owner-reviewed, disabled clears old history',async()=>{
  const f=await fixture(engine);
  try{
   await f.apply({kind:'REPLY_ADD',match:'WORD',trigger:'منحة',text:'دليل منارتك'});
   await f.service.propose(input('سؤال الطالب السري'), 'b3-webhook:bot-main:500');
   assert.deepEqual(await f.service.recentDecisions(OWNER,CHAT),[]);
   assert.equal((await f.store.snapshot()).phase4Community?.decisionLog,undefined);
   await assert.rejects(f.service.recentDecisions(MEMBER,CHAT),/COMMUNITY_OWNER_DENIED/);
   const draft=await f.service.pending(OWNER,{kind:'DECISION_LOG_ON'},CHAT);
   assert.equal((await f.service.view(OWNER,CHAT)).decisionLogEnabled,undefined);
   assert.match(f.service.preview(draft),/سجل|قرارات/u);
   await f.service.approve(OWNER,draft.id);
   assert.equal((await f.service.view(OWNER,CHAT)).decisionLogEnabled,true);
   await f.service.propose(input('النص الخاص الذي لا يُحفظ'), 'b3-webhook:bot-main:501');
   const events=await f.service.recentDecisions(OWNER,CHAT);
   assert.equal(events.length,1);
   assert.equal(events[0]!.reason,'REPLIES_DISABLED');
   const serialized=JSON.stringify(await f.store.snapshot());
   assert.equal(serialized.includes('النص الخاص الذي لا يُحفظ'),false);
   assert.equal(serialized.includes('اسم خاص لا يُحفظ'),false);
   assert.equal(serialized.includes('اسم المجموعة السري'),false);
   assert.equal(serialized.includes('"actorId":"300"'),false);
   assert.equal(events[0]!.kind,'TEXT');
   assert.ok(events[0]!.key.match(/^[a-f0-9]{64}$/u));
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.decisionLog?.length,1);
   await f.apply({kind:'DECISION_LOG_OFF'});
   assert.equal((await f.service.view(OWNER,CHAT)).decisionLogEnabled,false);
   assert.deepEqual(await f.service.recentDecisions(OWNER,CHAT),[]);
   assert.equal((await f.store.snapshot()).phase4Community?.decisionLog?.length,0);
   await f.service.propose(input('new private question'), 'b3-webhook:bot-main:502');
   assert.equal((await f.store.snapshot()).phase4Community?.decisionLog?.length,0);
  }finally{await f.close();}
 });
 test('P4 decisions '+engine+': records verified reasons, config epoch, no duplicate records and no raw message',async()=>{
  const f=await fixture(engine);
  try{
   await f.apply({kind:'DECISION_LOG_ON'});
   await f.apply({kind:'REPLY_ADD',match:'EXACT',trigger:'منحة',text:'مرحبًا {العضو}'});
   const current=await f.service.view(OWNER,CHAT);
   assert.equal(await f.service.propose(input('منحة'),'b3-webhook:bot-main:501'),null);
   await f.apply({kind:'REPLIES_ON'});
   assert.equal(await f.service.propose(input('not matched'),'b3-webhook:bot-main:502'),null);
   const proposed=await f.service.propose(input('منحة'),'b3-webhook:bot-main:503');
   assert.ok(proposed);
   assert.equal(proposed?.policyVersion,current.version+1);
   const duplicate=await f.service.propose(input('منحة'),'b3-webhook:bot-main:503');
   assert.equal(duplicate,null);
   f.set(f.clock()+9000);
   assert.equal(await f.service.propose(input('منحة'),'b3-webhook:bot-main:504'),null);
   const events=await f.service.recentDecisions(OWNER,CHAT);
   assert.deepEqual(events.map(x=>x.reason),['ACTOR_COOLDOWN','RESERVED','NO_MATCH','REPLIES_DISABLED']);
   assert.equal(events[1]?.configVersion,current.version+1);
   assert.equal(events[1]?.ruleId,(await f.service.view(OWNER,CHAT)).rules[0]?.id);
   assert.equal(new Set(events.map(x=>x.key)).size,events.length);
   assert.equal(JSON.stringify(events).includes('منحة'),false);
   assert.equal(JSON.stringify(events).includes('مرحبًا'),false);
  }finally{await f.close();}
 });
 test('P4 decisions '+engine+': quiet hours, group and topic cooldowns and eight/minute cap are explained',async()=>{
  const f=await fixture(engine);
  try{
   await f.apply({kind:'DECISION_LOG_ON'});
   await f.apply({kind:'REPLY_ADD',match:'EXACT',trigger:'hello',text:'Hi'});
   await f.apply({kind:'REPLIES_ON'});
   const t0=f.clock();
   await f.apply({kind:'TOPIC_COOLDOWN_SET',topicId:777,cooldownMs:1000});
   assert.ok(await f.service.propose(input('hello','301',777),'b3-webhook:bot-main:1'));
   assert.equal(await f.service.propose(input('hello','302',777),'b3-webhook:bot-main:2'),null);
   f.set(t0+1000);
   assert.ok(await f.service.propose(input('hello','303',777),'b3-webhook:bot-main:3'));
   assert.equal(await f.service.propose(input('hello','304'),'b3-webhook:bot-main:4'),null);
   for(let i=3;i<=8;i++){
    f.set(t0+i*1000);
    assert.ok(await f.service.propose(input('hello',String(350+i),777),'b3-webhook:bot-main:'+(i+10)));
   }
   assert.equal(await f.service.propose(input('hello','999',777),'b3-webhook:bot-main:99'),null);
   assert.equal((await f.service.recentDecisions(OWNER,CHAT))[0]?.reason,'GROUP_LIMIT');
   f.set(t0+70_000);
   await f.apply({kind:'QUIET_HOURS_SET',startMinute:0,endMinute:1439});
   assert.equal(await f.service.propose(input('hello','900',777),'b3-webhook:bot-main:100'),null);
   assert.equal((await f.service.recentDecisions(OWNER,CHAT))[0]?.reason,'QUIET_HOURS');
   const reasons:string[]=(await f.service.recentDecisions(OWNER,CHAT)).map(x=>x.reason);
   for(const reason of ['TOPIC_COOLDOWN','GROUP_COOLDOWN','GROUP_LIMIT','QUIET_HOURS','RESERVED'])
    assert.ok(reasons.includes(reason),reason);
  }finally{await f.close();}
 });
 test('P4 decisions '+engine+': bounded 7 day private log, forged/restored state fails closed',async()=>{
  const f=await fixture(engine);
  try{
   await f.apply({kind:'DECISION_LOG_ON'});
   for(let i=0;i<1200;i++){
    f.set(Date.parse('2026-11-04T12:00:00Z')+i*1000);
    await f.service.propose(input('unmatched private '+i),'b3-webhook:bot-main:'+(10_000+i));
   }
   const state=await f.store.snapshot();
   assert.equal(state.phase4Community?.decisionLog?.length,1000);
   assert.equal(validCommunityState(state.phase4Community),true);
   const sample=state.phase4Community!.decisionLog![0]!;
   await assert.rejects(f.store.transaction(s=>{
    s.phase4Community!.decisionLog!.push({...sample,key:'not-a-hash'});
   }),/Unsupported state schema/);
   await assert.rejects(f.store.transaction(s=>{
    s.phase4Community!.decisionLog![0]={...sample,reason:'ALLOWED' as any};
   }),/Unsupported state schema/);
   f.set(f.clock()+8*86_400_000);
   assert.deepEqual(await f.service.recentDecisions(OWNER,CHAT),[]);
   await f.service.propose(input('new question'),'b3-webhook:bot-main:99999');
   assert.equal((await f.store.snapshot()).phase4Community?.decisionLog?.length,1);
  }finally{await f.close();}
 });
 test('P4 decisions '+engine+': diagnosis identifies disabled trigger/topic without persisting sample',async()=>{
  const f=await fixture(engine);
  try{
   await f.apply({kind:'REPLY_ADD',match:'WORD',trigger:'منحة',text:'جواب',topicId:777});
   await f.apply({kind:'REPLIES_ON'});
   const pre=JSON.stringify((await f.store.snapshot()).phase4Community);
   assert.equal((await f.service.diagnose(OWNER,CHAT,'منحة',888)).status,'TOPIC_MISMATCH');
   assert.equal((await f.service.diagnose(OWNER,CHAT,'منحة',777)).status,'MATCH');
   const rid=(await f.service.view(OWNER,CHAT)).rules[0]!.id;
   await f.apply({kind:'REPLY_DISABLE',ruleId:rid});
   assert.equal((await f.service.diagnose(OWNER,CHAT,'منحة',777)).status,'RULE_DISABLED');
   assert.equal((await f.service.diagnose(OWNER,CHAT,'هل يوجد سؤال آخر؟',777)).status,'NO_MATCH');
   assert.equal(JSON.stringify((await f.store.snapshot()).phase4Community).includes('هل يوجد سؤال آخر؟'),false);
   assert.ok(pre.includes('منحة'));
  }finally{await f.close();}
 });
 test('P4 decisions '+engine+': inline UI scopes review, report and undo to owner',async()=>{
  const f=await fixture(engine);
  try{
   const panel=await phase4CommunityScreen(f.service,OWNER,'p4c:1:g:'+CHAT);
   assert.ok(panel?.keyboard.inline_keyboard.flat().some(x=>x.callback_data==='p4c:1:k:'+CHAT));
   const report=await phase4CommunityScreen(f.service,OWNER,'p4c:1:k:'+CHAT);
   assert.match(report?.text??'',/متوقف|غير مفعّل/u);
   const preview=await phase4CommunityScreen(f.service,OWNER,'p4c:1:t:'+CHAT+':d:1');
   assert.match(preview?.text??'',/اعتماد/u);
   assert.equal((await f.service.view(OWNER,CHAT)).decisionLogEnabled,undefined);
   const approve=preview?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith('p4c:1:c:'));
   assert.ok(approve);
   await phase4CommunityScreen(f.service,OWNER,approve!.callback_data);
   assert.equal((await f.service.view(OWNER,CHAT)).decisionLogEnabled,true);
   assert.equal((await f.service.recentDecisions(OWNER,CHAT)).length,0);
   await f.service.propose(input('no rule'),'b3-webhook:bot-main:999');
   const result=await phase4CommunityScreen(f.service,OWNER,'p4c:1:k:'+CHAT);
   assert.match(result?.text??'',/NO_MATCH|REPLIES_DISABLED/u);
   await assert.rejects(phase4CommunityScreen(f.service,MEMBER,'p4c:1:k:'+CHAT),
    /COMMUNITY_OWNER_DENIED/);
   const stop=await phase4CommunityScreen(f.service,OWNER,'/replylogoff '+CHAT);
   assert.ok(stop?.keyboard.inline_keyboard.flat().some(x=>x.text.includes('اعتماد')));
  }finally{await f.close();}
 });
}
