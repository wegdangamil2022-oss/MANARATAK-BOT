import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {defaultCommunityConfig,validCommunityConfig,validCommunityTimeZone,
 formatCommunityDateTime,inCommunityQuietHours,renderCommunityTemplate} from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen,validPhase4CommunityRoute} from '../src/phase4-community-ui.js';

const CHAT='-1003456789',OWNER='100';
const instant=(iso:string)=>Date.parse(iso);
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-iana-'));
 const file=join(dir,engine==='json'?'bot.json':'bot.sqlite');
 let now=instant('2026-03-08T06:59:00Z');
 const clock=()=>now;
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,CHAT,['navigation']);
 await policy.setPresence(CHAT,true);
 const service=new Phase4CommunityService(store,policy,clock);
 const apply=async(request:Parameters<typeof service.pending>[1])=>{
  const draft=await service.pending(OWNER,request,CHAT);
  return service.approve(OWNER,draft.id);
 };
 return {dir,file,clock,service,apply,setNow:(v:number)=>{now=v;},
  close:()=>rm(dir,{recursive:true,force:true})};
}

test('P4 IANA: allow canonical supported zone names, reject spoofed and invalid zones',()=>{
 assert.equal(validCommunityTimeZone('Asia/Aden'),true);
 assert.equal(validCommunityTimeZone('America/New_York'),true);
 assert.equal(validCommunityTimeZone('UTC'),true);
 for(const invalid of ['','asia/aden','GMT+3','Etc/GMT+3','America/Unknown',
  'America/New_York\n', 'America/New_York?x=1','America/../Paris',
  'America/New_York<script>','Antarctica/Not_A_Zone'])
  assert.equal(validCommunityTimeZone(invalid),false,invalid);
 const old=defaultCommunityConfig(CHAT);
 assert.equal(validCommunityConfig(old),true);
 assert.equal(validCommunityConfig({...old,timeZone:'America/New_York'}),true);
 assert.equal(validCommunityConfig({...old,timeZone:'America/Unknown'}),false);
 assert.equal(validCommunityConfig({...old,timeZone:''}),false);
});

test('P4 IANA: quiet hours and templates respect DST spring-forward and fall-back',()=>{
 const quiet={startMinute:120,endMinute:240};
 assert.equal(inCommunityQuietHours(quiet,instant('2026-03-08T06:59:00Z'),180,'America/New_York'),false);
 assert.equal(inCommunityQuietHours(quiet,instant('2026-03-08T07:00:00Z'),180,'America/New_York'),true);
 assert.equal(inCommunityQuietHours(quiet,instant('2026-03-08T08:00:00Z'),180,'America/New_York'),false);
 const repeated={startMinute:60,endMinute:120};
 assert.equal(inCommunityQuietHours(repeated,instant('2026-11-01T05:30:00Z'),0,'America/New_York'),true);
 assert.equal(inCommunityQuietHours(repeated,instant('2026-11-01T06:30:00Z'),0,'America/New_York'),true);
 assert.deepEqual(formatCommunityDateTime(instant('2026-03-08T06:30:00Z'),
  {timeZone:'America/New_York'}),{date:'2026-03-08',time:'01:30'});
 assert.deepEqual(formatCommunityDateTime(instant('2026-03-08T07:30:00Z'),
  {timeZone:'America/New_York'}),{date:'2026-03-08',time:'03:30'});
 assert.deepEqual(formatCommunityDateTime(instant('2026-03-08T07:30:00Z'),
  {timeZone:'America/New_York',language:'en',clockFormat:'12'}),
  {date:'2026-03-08',time:'03:30 AM'});
 const rendered=renderCommunityTemplate('{التاريخ} {الوقت}',{
  kind:'JOIN',chatId:CHAT,actorId:'201',memberName:'Student',groupName:'Group'},
  instant('2026-03-08T07:30:00Z'),'',{timeZone:'America/New_York'});
 assert.equal(rendered,'2026-03-08 03:30');
 assert.match(formatCommunityDateTime(instant('2026-03-08T07:30:00Z'),
  {timeZone:'America/New_York',calendar:'hijri'}).date,/^14\d{2}-\d{2}-\d{2} هـ$/u);
 assert.equal(formatCommunityDateTime(instant('2026-03-08T07:30:00Z')).time,'07:30');
 assert.throws(()=>formatCommunityDateTime(instant('2026-03-08T07:30:00Z'),
  {timeZone:'Invalid/Zone'}),/COMMUNITY_DATE_FORMAT_INVALID/);
});

test('P4 IANA: private commands and inline routes reject invalid zone input',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/greetingzone '+CHAT+' Asia/Aden'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'GROUP_TIMEZONE',timeZone:'Asia/Aden'}});
 assert.deepEqual(parsePhase4CommunityCommand('/greetingzoneoff '+CHAT),
  {kind:'EDIT',chatId:CHAT,request:{kind:'GROUP_TIMEZONE_CLEAR'}});
 assert.equal(parsePhase4CommunityCommand('/greetingzone '+CHAT+' Asia/NotReal'),null);
 assert.equal(parsePhase4CommunityCommand('/greetingzone '+CHAT+' ../etc/passwd'),null);
 assert.equal(validPhase4CommunityRoute('p4c:1:n:'+CHAT),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:a:'+CHAT),true);
});

for(const engine of ['json','sqlite'] as const){
 test('P4 IANA '+engine+': owner review, durable zone and explicit fallback with stale guard',async()=>{
  const f=await fixture(engine);
  try{
   await assert.rejects(f.service.pending('201',{kind:'GROUP_TIMEZONE',timeZone:'Asia/Aden'},CHAT));
   await assert.rejects(f.service.pending(OWNER,{kind:'GROUP_TIMEZONE',timeZone:'Asia/NotReal'},CHAT),
    /COMMUNITY_TIMEZONE_INVALID/);
   const draft=await f.service.pending(OWNER,{kind:'GROUP_TIMEZONE',timeZone:'America/New_York'},CHAT);
   assert.equal((await f.service.view(OWNER,CHAT)).timeZone,undefined);
   const review=f.service.preview(draft);
   assert.match(review,/America\/New_York/u);
   await f.service.approve(OWNER,draft.id);
   assert.equal((await f.service.view(OWNER,CHAT)).timeZone,'America/New_York');
   const restored=new BotStore(f.file,{engine});
   assert.equal((await restored.snapshot()).phase4Community?.configs[0]?.timeZone,'America/New_York');
   const pending=await f.service.pending(OWNER,{kind:'GROUP_TIMEZONE_CLEAR'},CHAT);
   await f.apply({kind:'GROUP_LANGUAGE',language:'en'});
   await assert.rejects(f.service.approve(OWNER,pending.id),/COMMUNITY_DRAFT_NOT_FOUND|COMMUNITY_DRAFT_STALE/);
   await f.apply({kind:'GROUP_TIMEZONE_CLEAR'});
   assert.equal((await f.service.view(OWNER,CHAT)).timeZone,undefined);
   assert.equal((await f.service.view(OWNER,CHAT)).utcOffsetMinutes,180);
  }finally{await f.close();}
 });
 test('P4 IANA '+engine+': DST controls real quiet-hour diagnoses and inline zone UI',async()=>{
  const f=await fixture(engine);
  try{
   await f.apply({kind:'REPLY_ADD',match:'EXACT',trigger:'hello',text:'{الوقت}'});
   await f.apply({kind:'REPLIES_ON'});
   await f.apply({kind:'QUIET_HOURS_SET',startMinute:120,endMinute:240});
   await f.apply({kind:'GROUP_TIMEZONE',timeZone:'America/New_York'});
   assert.equal((await f.service.diagnose(OWNER,CHAT,'hello')).status,'MATCH');
   const view=await phase4CommunityScreen(f.service,OWNER,'p4c:1:g:'+CHAT);
   assert.match(view?.text??'',/America\/New_York/u);
   assert.ok(view?.keyboard.inline_keyboard.flat().some(x=>x.callback_data==='p4c:1:n:'+CHAT));
   const zone=await phase4CommunityScreen(f.service,OWNER,'p4c:1:n:'+CHAT);
   assert.match(zone?.text??'',/greetingzoneoff/u);
   f.setNow(instant('2026-03-08T07:00:00Z'));
   assert.equal((await f.service.diagnose(OWNER,CHAT,'hello')).status,'QUIET_HOURS');
   const reset=await phase4CommunityScreen(f.service,OWNER,'p4c:1:a:'+CHAT);
   const approve=reset?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith('p4c:1:c:'));
   assert.ok(approve);
   assert.equal((await f.service.view(OWNER,CHAT)).timeZone,'America/New_York');
   await phase4CommunityScreen(f.service,OWNER,approve!.callback_data);
   assert.equal((await f.service.view(OWNER,CHAT)).timeZone,undefined);
  }finally{await f.close();}
 });
}
