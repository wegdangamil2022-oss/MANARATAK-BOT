import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4GuidanceService} from '../src/phase4-guidance.js';
import {phase4GuidanceOwnerScreen,parseGuidanceOwnerCommand,
 validPhase4GuidanceOwnerRoute} from '../src/phase4-guidance-owner.js';
import {defaultCommunityConfig,validCommunityConfig,validCommunityState} from '../src/phase4-community-model.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';

const OWNER='100',MEMBER='200',GROUP='-1001234',OTHER='-1005678',NOW=1_800_000_000_000;
const INTRO='هذه مجموعة المنح <الأوروبية> & نصائح القبول';
const TOPICS='المنح الصينية، اختبارات القبول <العالمية>، الدراسة في أوروبا';
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-guidance-custom-'));
 const file=join(dir,'store.'+engine),store=new BotStore(file,{engine});
 let now=NOW;
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 const community=new Phase4CommunityService(store,policy,()=>now);
 const guidance=new Phase4GuidanceService(store,policy,community);
 return {dir,file,store,policy,community,guidance,
  changeTime:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
}
test('GUIDE-007 owner-reviewed intro commands and version-bound callbacks are canonical',()=>{
 assert.deepEqual(parseGuidanceOwnerCommand('/guideset '+GROUP+' '+INTRO),
  {kind:'EDIT',section:'GUIDE',chatId:GROUP,request:{kind:'GUIDE_INTRO_SET',text:INTRO}});
 assert.deepEqual(parseGuidanceOwnerCommand('/guidetopics '+GROUP+' '+TOPICS),
  {kind:'EDIT',section:'GUIDE',chatId:GROUP,request:{kind:'GUIDE_TOPICS_SET',text:TOPICS}});
 assert.deepEqual(parseGuidanceOwnerCommand('/guideclear '+GROUP),
  {kind:'EDIT',section:'GUIDE',chatId:GROUP,request:{kind:'GUIDE_INTRO_CLEAR'}});
 assert.deepEqual(parseGuidanceOwnerCommand('/guidetopicsclear '+GROUP),
  {kind:'EDIT',section:'GUIDE',chatId:GROUP,request:{kind:'GUIDE_TOPICS_CLEAR'}});
 for(const bad of ['/guideset '+GROUP+' ', '/guideset '+GROUP+' '+('x'.repeat(340)),
  '/guideset '+GROUP+' text\ninjected', '/guidetopics 123 topics',
  '/guideclear '+GROUP+' extra','/guideset '+GROUP+' {العضو}']){
  assert.equal(parseGuidanceOwnerCommand(bad),null,bad);
 }
 assert.equal(validPhase4GuidanceOwnerRoute('gd:1:2:c:'+'a'.repeat(24)),true);
 assert.equal(validPhase4GuidanceOwnerRoute('gd:1:2:x:'+'a'.repeat(24)),true);
 assert.equal(validPhase4GuidanceOwnerRoute('gd:1:3:c:'+'a'.repeat(24)),false);
});
for(const engine of ['json','sqlite'] as const){
 test('GUIDE-008 '+engine+' two independent approved guide fields appear escaped, isolate groups, persist',async()=>{
  const f=await setup(engine);
  try{
   const initial=await f.guidance.member(GROUP,'GUIDE');
   assert.ok(initial);assert.doesNotMatch(initial,/المنح الصينية/u);
   assert.equal(validCommunityConfig({...defaultCommunityConfig(GROUP),guideIntro:INTRO}),true);
   const draft=await f.community.pending(OWNER,{kind:'GUIDE_INTRO_SET',text:INTRO},GROUP);
   assert.match(f.community.preview(draft),/&lt;الأوروبية&gt; &amp;/u);
   assert.doesNotMatch((await f.guidance.member(GROUP,'GUIDE'))??'',/الأوروبية/u);
   const saved=await f.community.approve(OWNER,draft.id);
   assert.equal(saved.guideIntro,INTRO);
   await f.community.approve(OWNER,(await f.community.pending(OWNER,
    {kind:'GUIDE_TOPICS_SET',text:TOPICS},GROUP)).id);
   const shown=await f.guidance.member(GROUP,'GUIDE');
   assert.match(shown??'',/&lt;الأوروبية&gt; &amp;/u);
   assert.match(shown??'',/اختبارات القبول &lt;العالمية&gt;/u);
   assert.doesNotMatch(shown??'',/<الأوروبية>/u);
   assert.doesNotMatch((await f.guidance.member(OTHER,'GUIDE'))??'',/الأوروبية/u);
   const state=await new BotStore(f.file,{engine}).snapshot();
   assert.equal(state.phase4Community?.configs.find(c=>c.chatId===GROUP)?.guideTopics,TOPICS);
  }finally{await f.close();}
 });
 test('GUIDE-009 '+engine+' invalid text and nonowner edits fail closed; stale/expired drafts cannot override settings',async()=>{
  const f=await setup(engine);
  try{
   await assert.rejects(f.community.pending(MEMBER,{kind:'GUIDE_INTRO_SET',text:INTRO},GROUP),
    /COMMUNITY_OWNER_DENIED/);
   for(const value of ['  padding','with\nnewline','{العضو}','\u202eltr',
    'z'.repeat(330)])await assert.rejects(
     f.community.pending(OWNER,{kind:'GUIDE_INTRO_SET',text:value},GROUP),
     /COMMUNITY_GUIDE_TEXT_INVALID/);
   for(const value of ['','bad\nnewline','y'.repeat(260)])await assert.rejects(
     f.community.pending(OWNER,{kind:'GUIDE_TOPICS_SET',text:value},GROUP),
     /COMMUNITY_GUIDE_TEXT_INVALID/);
   const d=await f.community.pending(OWNER,{kind:'GUIDE_INTRO_SET',text:INTRO},GROUP);
   await f.community.approve(OWNER,(await f.community.pending(OWNER,
    {kind:'GUIDE_TOPICS_SET',text:TOPICS},GROUP)).id);
   await assert.rejects(f.community.approve(OWNER,d.id),/COMMUNITY_DRAFT_(STALE|NOT_FOUND)/);
   const later=await f.community.pending(OWNER,{kind:'GUIDE_INTRO_SET',text:INTRO},GROUP);
   f.changeTime(NOW+120_001);
   await assert.rejects(f.community.approve(OWNER,later.id),/COMMUNITY_DRAFT_EXPIRED/);
   assert.equal((await f.community.view(OWNER,GROUP)).guideIntro,undefined);
  }finally{await f.close();}
 });
 test('GUIDE-010 '+engine+' separate clear flow is reviewed; restored states reject invalid guide payloads',async()=>{
  const f=await setup(engine);try{
   await f.community.approve(OWNER,(await f.community.pending(OWNER,
    {kind:'GUIDE_INTRO_SET',text:INTRO},GROUP)).id);
   const clear=await f.community.pending(OWNER,{kind:'GUIDE_INTRO_CLEAR'},GROUP);
   assert.equal((await f.community.view(OWNER,GROUP)).guideIntro,INTRO);
   await f.community.approve(OWNER,clear.id);
   assert.equal((await f.community.view(OWNER,GROUP)).guideIntro,undefined);
   const config=defaultCommunityConfig(GROUP);
   assert.equal(validCommunityConfig({...config,guideIntro:'with\nnewline'}),false);
   assert.equal(validCommunityConfig({...config,guideTopics:'z'.repeat(260)}),false);
   const state={configs:[{...config,guideIntro:'with\nnewline'}],drafts:[],receipts:[]};
   assert.equal(validCommunityState(state),false);
   assert.equal(validCommunityState({configs:[],drafts:[{
    id:'a'.repeat(24),actorId:OWNER,chatId:GROUP,chatVersion:1,configVersion:0,
    kind:'GUIDE_INTRO_SET',text:'bad\nnewline',createdAt:NOW,expiresAt:NOW+120000
   }],receipts:[]}),false);
  }finally{await f.close();}
 });
 test('GUIDE-011 '+engine+' owner preview and confirmation share reviewed pipeline, stale callbacks denied',async()=>{
  const f=await setup(engine);
  try{
   const preview=await phase4GuidanceOwnerScreen(f.guidance,OWNER,
    '/guideset '+GROUP+' '+INTRO);
   assert.ok(preview);assert.match(preview.text,/&lt;الأوروبية&gt;/u);
   assert.equal(isValidTelegramInlineKeyboard(preview.keyboard),true);
   const accept=preview.keyboard.inline_keyboard.flat().find(x=>x.text.includes('اعتماد'));
   assert.ok(accept?.callback_data.startsWith('gd:1:2:c:'));
   const adopted=await phase4GuidanceOwnerScreen(f.guidance,OWNER,accept!.callback_data);
   assert.ok(adopted);assert.match(adopted.text,/&lt;الأوروبية&gt;/u);
   assert.equal(await phase4GuidanceOwnerScreen(f.guidance,OWNER,accept!.callback_data),null);
   const clear=await phase4GuidanceOwnerScreen(f.guidance,OWNER,'/guideclear '+GROUP);
   assert.ok(clear);assert.equal((await f.community.view(OWNER,GROUP)).guideIntro,INTRO);
   const reject=clear.keyboard.inline_keyboard.flat().find(x=>x.text.includes('إلغاء'));
   assert.ok(reject);
   assert.ok(await phase4GuidanceOwnerScreen(f.guidance,OWNER,reject.callback_data));
   assert.equal((await f.community.view(OWNER,GROUP)).guideIntro,INTRO);
   assert.equal(await phase4GuidanceOwnerScreen(f.guidance,MEMBER,'/guideset '+GROUP+' '+INTRO),null);
  }finally{await f.close();}
 });
}
